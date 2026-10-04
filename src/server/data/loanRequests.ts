import 'server-only'
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm'
import { assertAdmin, assertStaffSelf, DataError, SYSTEM_CALLER, type Caller, type Ctx } from '@/server/context'
import { toIso, withTx, type Db } from '@/server/db/client'
import { newId } from '@/server/db/ids'
import { LOAN_REQUEST_STATUSES, loanRequestLines, loanRequests, products, staff } from '@/server/db/schema'
import { writeAudit } from '@/server/data/audit'
import { addDaysToDateStr, appCalendarDay, genRequestRef } from '@/lib/utils'
import {
  ACTIVE_STATUSES,
  ALL_TIME_FROM,
  OPEN_ENDED_TO,
  effectiveToDate,
  isExpired,
  isNoShowCandidate,
  tightestLendingCap,
  type CartCheck,
  type CartLine,
  type CounterInput,
  type ListRequestsOptions,
  type RequestSnapshotLine,
  type ReservationHolder,
  type ReservationInterval,
  type SubmitLoanRequestInput,
} from '@/lib/loanRequestRules'
import type { LoanRequest, LoanRequestLine, LoanRequestStatus } from '@/types/database'

// Loan requests on PostgreSQL. Every status change is one database transaction: the request row, any line edits and the
// request's `update` audit entry (the full snapshot every transition has always written) commit together or not at all.
//
// Locking, so two people acting on one request (or on the same stock) at once can't both win:
//   - a transition locks the request row FOR NO KEY UPDATE, reads its status under that lock, then writes with
//     `UPDATE ... WHERE id = $1 AND status = <the status it read>`; losing a race is a 409 (or, for the automatic
//     expiry / no-show pass, simply "already done");
//   - a transition that checks stock (approve, counter) and a submission then lock the products it touches, in id order,
//     and count the other requests' reservations only after that, so two requests for the last unit queue instead of both
//     passing the check.
// Lock order across the app is OUT transaction row, loan request, then products by id (see stock.ts). All locks are
// FOR NO KEY UPDATE, never FOR UPDATE: it would conflict with the FOR KEY SHARE lock a foreign-key check takes on the
// parent row (a request's lines pointing at a product, a transaction pointing at its request) and can deadlock.

const CHANGED = 'This request has already changed — reload to see its current state.'
const NOT_FOUND = 'Loan request not found.'
const NOT_FOUND_PRODUCT = 'Product not found.'
const NOT_FOUND_STAFF = 'Staff record not found.'
const NOT_YOURS = 'You can only do this for your own staff record.'
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/**
 * Who an automatic expiry / no-show is recorded as: no user id, and the same name the audit log has always shown for it.
 * It is not the person whose page happened to run the pass, who did nothing.
 */
const SYSTEM_ACTOR: Caller = { ...SYSTEM_CALLER, name: 'System (automatic)' }

export type RequestRow = typeof loanRequests.$inferSelect
type LineRow = typeof loanRequestLines.$inferSelect

/** A request, or just its id (the pages hold whole requests, the Dashboard only has `{ id }`). */
export type RequestRef = string | { id: string }
const idOf = (ref: RequestRef): string => (typeof ref === 'string' ? ref : ref?.id)

/** Run `fn` in a transaction on the caller's connection (a savepoint when `ctx.db` is already a transaction). */
function inTx<T>(ctx: Ctx, fn: (txCtx: Ctx) => Promise<T>): Promise<T> {
  // One clock reading for the whole save, so the status change, its updated_at and its audit entry carry the same instant.
  const at = ctx.now()
  return withTx(ctx.db as Db, (tx) => fn({ ...ctx, db: tx, now: () => at }))
}

// --- Row mapping and checks --------------------------------------------------

export function toLoanRequest(row: RequestRow): LoanRequest {
  return {
    id: row.id,
    // Requests that pre-date references have none: the field is absent, as on the old documents.
    ...(row.reference_no ? { reference_no: row.reference_no } : {}),
    staff_id: row.staff_id,
    staff_name: row.staff_name,
    status: row.status,
    message: row.message,
    admin_message: row.admin_message,
    from_date: row.from_date,
    to_date: row.to_date,
    original_from_date: row.original_from_date,
    original_to_date: row.original_to_date,
    created_at: toIso(row.created_at) as string,
    updated_at: toIso(row.updated_at) as string,
    fulfilled_txn_id: row.fulfilled_txn_id,
  }
}

function toLoanRequestLine(row: LineRow): LoanRequestLine {
  return {
    id: row.id,
    request_id: row.request_id,
    product_id: row.product_id,
    product_name: row.product_name,
    requested_quantity: row.requested_quantity,
    offered_quantity: row.offered_quantity,
    created_at: toIso(row.created_at) as string,
  }
}

const toSnapshotLine = (l: Pick<LineRow, 'product_id' | 'product_name' | 'requested_quantity' | 'offered_quantity'>): RequestSnapshotLine => ({
  product_id: l.product_id,
  product_name: l.product_name,
  requested_quantity: l.requested_quantity,
  offered_quantity: l.offered_quantity,
})

function isRealDate(value: string): boolean {
  const d = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value
}

/** A YYYY-MM-DD string that is a real calendar date, or a 400. */
function checkDate(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value) || !isRealDate(value)) {
    throw new DataError(400, `${label} must be a date (YYYY-MM-DD).`)
  }
  return value
}

function dateOrNull(value: unknown, label: string): string | null {
  return value === undefined || value === null || value === '' ? null : checkDate(value, label)
}

const isAdminOrSystem = (c: Ctx) => c.caller.role === 'admin' || c.caller.role === 'system'

/** Staff see only their own requests; someone else's is a 404, as if it did not exist. */
function assertCanSee(c: Ctx, row: RequestRow): void {
  if (isAdminOrSystem(c) || (c.caller.staffId !== null && c.caller.staffId === row.staff_id)) return
  throw new DataError(404, NOT_FOUND)
}

async function findRequest(c: Ctx, id: string): Promise<RequestRow> {
  const [row] = await c.db.select().from(loanRequests).where(eq(loanRequests.id, id)).limit(1)
  if (!row) throw new DataError(404, NOT_FOUND)
  return row
}

async function lockRequest(c: Ctx, id: string): Promise<RequestRow> {
  const [row] = await c.db.select().from(loanRequests).where(eq(loanRequests.id, id)).for('no key update')
  if (!row) throw new DataError(404, NOT_FOUND)
  return row
}

function assertStatus(row: RequestRow, allowed: LoanRequestStatus[]): void {
  if (!allowed.includes(row.status)) throw new DataError(409, CHANGED)
}

/** The status change itself, guarded on the status the caller read (under the row lock), so it can never apply twice. */
async function setRequest(c: Ctx, row: RequestRow, set: Partial<typeof loanRequests.$inferInsert>): Promise<RequestRow> {
  const [updated] = await c.db
    .update(loanRequests)
    .set({ ...set, updated_at: c.now() })
    .where(and(eq(loanRequests.id, row.id), eq(loanRequests.status, row.status)))
    .returning()
  if (!updated) throw new DataError(409, CHANGED)
  return updated
}

async function linesOf(c: Ctx, requestId: string): Promise<LineRow[]> {
  return c.db
    .select()
    .from(loanRequestLines)
    .where(eq(loanRequestLines.request_id, requestId))
    .orderBy(asc(loanRequestLines.line_no), asc(loanRequestLines.id))
}

// --- Audit snapshot ----------------------------------------------------------

/**
 * The shape every loan_request audit entry carries, whatever the transition.
 *
 * Every entry is a complete snapshot of the request at that moment — reference, staff, dates, messages and the full item
 * list — differing only in `status` and whatever that transition genuinely changed, so each row stands on its own in a
 * CSV export and before/after still diff cleanly on screen (the unchanged fields are identical on both sides).
 *
 * `overrides` sets what this particular transition changes (status, new dates, an admin message, the fulfilling
 * transaction and its `fulfilled_txn_ref`); everything else comes from the request as it stands. Lines are read when not
 * supplied; callers that already hold them, or that need the pre-change versions, pass them in.
 */
export async function requestAuditSnapshot(
  c: Ctx,
  req: RequestRow,
  overrides: Record<string, unknown> = {},
  lines?: RequestSnapshotLine[],
): Promise<Record<string, unknown>> {
  const snapshotLines = lines ?? (await linesOf(c, req.id)).map(toSnapshotLine)
  return {
    reference_no: req.reference_no ?? null,
    staff_id: req.staff_id,
    staff_name: req.staff_name,
    status: req.status,
    from_date: req.from_date,
    to_date: req.to_date,
    original_from_date: req.original_from_date,
    original_to_date: req.original_to_date,
    message: req.message ?? null,
    admin_message: req.admin_message ?? null,
    fulfilled_txn_id: req.fulfilled_txn_id ?? null,
    lines: snapshotLines,
    line_count: snapshotLines.length,
    // The agreed quantity — what would actually be handed over. A counter can reduce offered_quantity below what was requested.
    total_qty: snapshotLines.reduce((sum, l) => sum + (l.offered_quantity ?? 0), 0),
    ...overrides,
  }
}

// --- Reads -------------------------------------------------------------------

/** The line items belonging to a request (staff: their own request's only). */
export async function getRequestLines(ctx: Ctx, requestId: string): Promise<LoanRequestLine[]> {
  assertCanSee(ctx, await findRequest(ctx, requestId))
  return (await linesOf(ctx, requestId)).map(toLoanRequestLine)
}

/** One request with its lines (staff: their own only; anyone else's is a 404). */
export async function getRequest(ctx: Ctx, requestId: string): Promise<{ request: LoanRequest; lines: LoanRequestLine[] }> {
  const row = await findRequest(ctx, requestId)
  assertCanSee(ctx, row)
  return { request: toLoanRequest(row), lines: (await linesOf(ctx, requestId)).map(toLoanRequestLine) }
}

/**
 * Requests, oldest first, optionally of one staff member and/or in the given statuses. A staff caller only ever gets
 * their own (naming anyone else's staff id is a 403); admins get everyone's. Rows are returned as stored: expiry and
 * no-show are applied by expireIfNeeded, as the pages have always done.
 */
export async function listRequests(ctx: Ctx, opts: ListRequestsOptions = {}): Promise<LoanRequest[]> {
  let staffId = opts.staffId
  if (!isAdminOrSystem(ctx)) {
    if (staffId !== undefined) assertStaffSelf(ctx, staffId)
    staffId = ctx.caller.staffId ?? undefined
    if (staffId === undefined) return []
  }
  const statuses = opts.statuses
  if (statuses !== undefined) {
    if (!Array.isArray(statuses) || statuses.some((s) => !(LOAN_REQUEST_STATUSES as readonly string[]).includes(s))) {
      throw new DataError(400, 'Unknown status.')
    }
    if (statuses.length === 0) return []
  }
  const rows = await ctx.db
    .select()
    .from(loanRequests)
    .where(and(staffId === undefined ? undefined : eq(loanRequests.staff_id, staffId), statuses ? inArray(loanRequests.status, statuses) : undefined))
    .orderBy(asc(loanRequests.created_at), asc(loanRequests.id))
  return rows.map(toLoanRequest)
}

// --- Reservation ledger ------------------------------------------------------
// Availability for a candidate range is always computed live by scanning active requests and checking date-range overlap —
// never a stored "units reserved" counter on the product (a stored counter can drift, a live query can't).

/** Two date ranges overlap when each starts on or before the other ends; a request with no To date never ends. */
const overlaps = (fromDate: string, toDate: string) =>
  sql`${fromDate}::date <= coalesce(${loanRequests.to_date}, ${OPEN_ENDED_TO}::date) and ${toDate}::date >= ${loanRequests.from_date}`

async function holdersOf(
  c: Ctx,
  productId: string,
  fromDate: string,
  toDate: string,
  statuses: LoanRequestStatus[],
): Promise<ReservationHolder[]> {
  if (statuses.length === 0) return []
  return c.db
    .select({
      requestId: loanRequests.id,
      staffId: loanRequests.staff_id,
      staffName: loanRequests.staff_name,
      quantity: loanRequestLines.offered_quantity,
      fromDate: loanRequests.from_date,
      toDate: loanRequests.to_date,
      status: loanRequests.status,
    })
    .from(loanRequestLines)
    .innerJoin(loanRequests, eq(loanRequests.id, loanRequestLines.request_id))
    .where(
      and(
        eq(loanRequestLines.product_id, productId),
        inArray(loanRequests.status, statuses),
        sql`${loanRequestLines.offered_quantity} > 0`,
        overlaps(fromDate, toDate),
      ),
    )
    .orderBy(asc(loanRequests.created_at), asc(loanRequests.id), asc(loanRequestLines.line_no), asc(loanRequestLines.id))
}

async function reservedQuantity(c: Ctx, productId: string, fromDate: string, toDate: string, excludeRequestId?: string): Promise<number> {
  const [row] = await c.db
    .select({ total: sql<number>`coalesce(sum(${loanRequestLines.offered_quantity}), 0)::int` })
    .from(loanRequestLines)
    .innerJoin(loanRequests, eq(loanRequests.id, loanRequestLines.request_id))
    .where(
      and(
        eq(loanRequestLines.product_id, productId),
        inArray(loanRequests.status, ACTIVE_STATUSES),
        excludeRequestId ? ne(loanRequests.id, excludeRequestId) : undefined,
        overlaps(fromDate, toDate),
      ),
    )
  return row?.total ?? 0
}

/**
 * Holder-level breakdown of active reservations for a product/date window: whose, and in what state. Admin only (it
 * names other staff). All three active statuses block identically; `statuses` narrows.
 */
export async function getReservationHolders(
  ctx: Ctx,
  productId: string,
  fromDate: string,
  toDate: string,
  statuses: LoanRequestStatus[] = ACTIVE_STATUSES,
): Promise<ReservationHolder[]> {
  assertAdmin(ctx)
  return holdersOf(ctx, productId, checkDate(fromDate, 'From date'), checkDate(toDate, 'To date'), statuses)
}

/** Units of a product promised to active requests overlapping [fromDate, toDate], leaving out one request. Any signed-in caller. */
export async function getReservedQuantity(
  ctx: Ctx,
  productId: string,
  fromDate: string,
  toDate: string,
  excludeRequestId?: string,
): Promise<number> {
  return reservedQuantity(ctx, productId, checkDate(fromDate, 'From date'), checkDate(toDate, 'To date'), excludeRequestId)
}

/**
 * The active reservation windows for a set of products in one query, as plain intervals the cart's calendar can check
 * in memory (see reservedQuantityInRange). Any signed-in caller: it carries dates and quantities, never names.
 */
export async function getReservationIntervals(ctx: Ctx, productIds: string[]): Promise<Record<string, ReservationInterval[]>> {
  const result: Record<string, ReservationInterval[]> = {}
  productIds.forEach((id) => (result[id] = []))
  if (productIds.length === 0) return result
  const rows = await ctx.db
    .select({
      productId: loanRequestLines.product_id,
      fromDate: loanRequests.from_date,
      toDate: loanRequests.to_date,
      quantity: loanRequestLines.offered_quantity,
    })
    .from(loanRequestLines)
    .innerJoin(loanRequests, eq(loanRequests.id, loanRequestLines.request_id))
    .where(
      and(
        inArray(loanRequestLines.product_id, productIds),
        inArray(loanRequests.status, ACTIVE_STATUSES),
        sql`${loanRequestLines.offered_quantity} > 0`,
      ),
    )
    .orderBy(asc(loanRequests.created_at), asc(loanRequests.id), asc(loanRequestLines.line_no), asc(loanRequestLines.id))
  for (const r of rows) {
    result[r.productId].push({ fromDate: r.fromDate, toDate: effectiveToDate(r.toDate), quantity: r.quantity })
  }
  return result
}

/**
 * Which active reservations a new Qty On Hand would break (Products page, a stocktake correction). There is no date
 * window of its own, so every active reservation on the product (any status, any date) is re-checked against its OWN
 * window with the same per-request availability rule approval uses: two requests for different, non-overlapping weeks
 * don't both count against the same unit just because both are active today. Admin only.
 */
export async function findQuantityReductionConflicts(ctx: Ctx, productId: string, newQuantity: number): Promise<ReservationHolder[]> {
  assertAdmin(ctx)
  if (!Number.isInteger(newQuantity) || newQuantity < 0) throw new DataError(400, 'Quantity must be a whole number, zero or more.')
  const holders = await holdersOf(ctx, productId, ALL_TIME_FROM, OPEN_ENDED_TO, ACTIVE_STATUSES)
  const offenders: ReservationHolder[] = []
  for (const holder of holders) {
    const reservedForWindow = await reservedQuantity(ctx, productId, holder.fromDate, effectiveToDate(holder.toDate), holder.requestId)
    if (reservedForWindow + holder.quantity > newQuantity) offenders.push(holder)
  }
  return offenders
}

// --- Cart validation ---------------------------------------------------------

type ProductRow = typeof products.$inferSelect
interface CartItem {
  product: ProductRow
  quantity: number
}

/** The cart as a list of distinct products with whole, positive quantities (the same product twice adds up). */
function cleanCart(cart: CartLine[] | undefined): CartLine[] {
  if (!Array.isArray(cart) || cart.length === 0) throw new DataError(400, 'Add at least one item.')
  const merged = new Map<string, number>()
  for (const raw of cart) {
    const productId = typeof raw?.productId === 'string' ? raw.productId : ''
    if (!productId) throw new DataError(400, 'Every item needs a product.')
    const quantity = Number(raw.quantity)
    if (!Number.isInteger(quantity) || quantity <= 0) throw new DataError(400, 'Quantity must be a whole number above zero.')
    merged.set(productId, (merged.get(productId) ?? 0) + quantity)
  }
  return [...merged].map(([productId, quantity]) => ({ productId, quantity }))
}

/** The cart's products, in cart order. With `lock`, locked FOR NO KEY UPDATE in id order first (404 when any is missing). */
async function loadCart(c: Ctx, cart: CartLine[], lock: boolean): Promise<CartItem[]> {
  const ids = cart.map((i) => i.productId)
  const query = c.db.select().from(products).where(inArray(products.id, ids)).orderBy(asc(products.id))
  const rows = lock ? await query.for('no key update') : await query
  const byId = new Map(rows.map((r) => [r.id, r]))
  return cart.map((i) => {
    const product = byId.get(i.productId)
    if (!product) throw new DataError(404, NOT_FOUND_PRODUCT)
    return { product, quantity: i.quantity }
  })
}

/**
 * Each product's own lend window, its own lending interval and live availability, collecting every failing product's
 * message at once so the cart can show every problem, not just the first. `toDate` is '' for an open-ended request.
 */
async function checkCart(c: Ctx, items: CartItem[], fromDate: string, toDate: string): Promise<CartCheck> {
  const errors: string[] = []

  if (!fromDate) {
    return { valid: false, errors: ['Select a From date.'] }
  }

  const tightestCap = tightestLendingCap(items.map(({ product }) => ({ product: { lending_interval: product.lending_interval ?? undefined } })))

  if (!toDate) {
    if (tightestCap) {
      errors.push('Select a To date — one or more items in your cart have a limited lending interval.')
    }
    // else: every item is Indefinitely — an open-ended request with no return date is fine, the same convenience Stock
    // Out's own blank "Lend To" already offers for a walk-in issue.
  } else {
    if (toDate < fromDate) errors.push("To date can't be before the From date.")
    if (tightestCap && toDate > addDaysToDateStr(fromDate, tightestCap.days)) {
      errors.push(`Loan window cannot exceed ${tightestCap.label} for the items in your cart.`)
    }
  }

  const effectiveTo = effectiveToDate(toDate)

  for (const { product, quantity } of items) {
    // lend_to is optional — unset means the product is lendable indefinitely (no end date decided yet), not "not
    // lendable". Only lend_from (the window has actually opened) is required.
    if (!product.lend_from) {
      errors.push(`${product.name} isn't set up for portal lending.`)
      continue
    }
    if (product.lend_to && !toDate) {
      // This item has its own defined cutoff, so an open-ended request (however Indefinitely its own lending interval is)
      // can't be promised past it — a real To date is required for this one.
      errors.push(`${product.name} must be returned by ${product.lend_to} — pick a To date within its lendable window.`)
      continue
    }
    if (fromDate < product.lend_from || (product.lend_to && toDate && toDate > product.lend_to)) {
      const windowLabel = product.lend_to ? `${product.lend_from} – ${product.lend_to}` : `from ${product.lend_from}`
      errors.push(`${product.name} is only lendable ${windowLabel} — outside your selected range.`)
      continue
    }
    const reserved = await reservedQuantity(c, product.id, fromDate, effectiveTo)
    const available = Math.max(0, product.quantity_on_hand - reserved)
    if (quantity > available) {
      errors.push(`${product.name}: only ${available} unit(s) available for these dates, you requested ${quantity}.`)
    }
  }

  return { valid: errors.length === 0, errors }
}

/** The cart's dates and availability, with the same wording the portal has always shown. Any signed-in caller; nothing is written. */
export async function validateCartDates(ctx: Ctx, cart: CartLine[], fromDate: string, toDate: string | null | undefined): Promise<CartCheck> {
  const clean = cleanCart(cart)
  const from = dateOrNull(fromDate, 'From date') ?? ''
  const to = dateOrNull(toDate, 'To date') ?? ''
  return checkCart(ctx, await loadCart(ctx, clean, false), from, to)
}

// --- Submission --------------------------------------------------------------

/**
 * Submit a cart as a pending request: the request, its lines and the `create` audit entry in one transaction. The
 * products are locked and the cart re-checked on them, so two submissions for the last unit can't both be accepted.
 * Staff may only submit for their own staff record. Resolves to the new request's id; a failed check is a 400 with the
 * first message.
 */
export async function submitLoanRequest(ctx: Ctx, input: SubmitLoanRequestInput): Promise<string> {
  const staffId = input?.staffId ?? ctx.caller.staffId
  if (!staffId) throw new DataError(ctx.caller.role === 'admin' ? 400 : 403, ctx.caller.role === 'admin' ? 'Choose a staff member.' : NOT_YOURS)
  assertStaffSelf(ctx, staffId)
  const cart = cleanCart(input.cart)
  if (!input.fromDate) throw new DataError(400, 'Select a From date.')
  const fromDate = checkDate(input.fromDate, 'From date')
  const toDate = dateOrNull(input.toDate, 'To date')
  const message = typeof input.message === 'string' ? input.message.trim() || null : null

  return inTx(ctx, async (c) => {
    const [holder] = await c.db.select().from(staff).where(eq(staff.id, staffId)).limit(1)
    if (!holder) throw new DataError(404, NOT_FOUND_STAFF)

    const items = await loadCart(c, cart, true)
    const check = await checkCart(c, items, fromDate, toDate ?? '')
    if (!check.valid) throw new DataError(400, check.errors[0])

    const at = c.now()
    const requestId = newId()
    const [row] = await c.db
      .insert(loanRequests)
      .values({
        id: requestId,
        // Human-readable reference, the counterpart to a transaction's TXN-...; written once, never changed.
        reference_no: genRequestRef(),
        staff_id: holder.id,
        staff_name: holder.full_name,
        status: 'pending',
        message,
        admin_message: null,
        from_date: fromDate,
        to_date: toDate,
        original_from_date: fromDate,
        original_to_date: toDate,
        created_at: at,
        updated_at: at,
        fulfilled_txn_id: null,
      })
      .returning()
    // line_no is the line's place in the cart: lines read back in the order they were added, which is how the request,
    // its emails and its audit snapshots list them.
    await c.db.insert(loanRequestLines).values(
      items.map((item, i) => ({
        id: newId(),
        request_id: requestId,
        product_id: item.product.id,
        product_name: item.product.name,
        requested_quantity: item.quantity,
        offered_quantity: item.quantity,
        line_no: i,
        created_at: at,
      })),
    )
    // The cart IS the line set at submission: requested and offered are equal until the admin counters.
    const submitted: RequestSnapshotLine[] = items.map((item) => ({
      product_id: item.product.id,
      product_name: item.product.name,
      requested_quantity: item.quantity,
      offered_quantity: item.quantity,
    }))
    await writeAudit(c, {
      action: 'create',
      entityType: 'loan_request',
      entityId: requestId,
      before: null,
      after: await requestAuditSnapshot(c, row, {}, submitted),
    })
    return requestId
  })
}

// --- Admin decisions ---------------------------------------------------------

/**
 * Re-runs the reservation ledger against the (possibly edited) offered lines and dates before the write commits —
 * availability may have changed since the request was submitted. Locks the products first (in id order), so a competing
 * approval of the same stock waits here and then sees this one's reservation.
 */
async function assertStillAvailable(
  c: Ctx,
  requestId: string,
  lines: { product_id: string; offered_quantity: number }[],
  fromDate: string,
  toDate: string | null,
): Promise<void> {
  const wanted = lines.filter((l) => l.offered_quantity > 0)
  if (wanted.length === 0) return
  const rows = await c.db
    .select()
    .from(products)
    .where(inArray(products.id, [...new Set(wanted.map((l) => l.product_id))]))
    .orderBy(asc(products.id))
    .for('no key update')
  const onHandOf = new Map(rows.map((r) => [r.id, r.quantity_on_hand]))
  const effectiveTo = effectiveToDate(toDate)
  for (const line of wanted) {
    // The reservation total leaves out this request's own current reservation, so the full offered quantity is what is
    // checked against what remains, not just the change.
    const reserved = await reservedQuantity(c, line.product_id, fromDate, effectiveTo, requestId)
    if (reserved + line.offered_quantity > (onHandOf.get(line.product_id) ?? 0)) {
      throw new DataError(409, 'Availability changed since this request was submitted — not enough stock remains for one of the lines.')
    }
  }
}

/**
 * Run a decision on a locked request. The work returns `null` when it found the request past its expiry date and
 * settled it as expired instead (see settleIfDue): that status change is committed together with this transaction (it
 * is not thrown away by an error), and only then is the caller told, with the same 409 as any other lost race. So an
 * expired request is expired for good, whoever got to it first.
 */
async function transitionTx(ctx: Ctx, work: (c: Ctx) => Promise<LoanRequest | null>): Promise<LoanRequest> {
  const result = await inTx(ctx, work)
  if (!result) throw new DataError(409, CHANGED)
  return result
}

/** Approve a pending request exactly as asked. Admin. */
export async function approveAsIs(ctx: Ctx, ref: RequestRef): Promise<LoanRequest> {
  assertAdmin(ctx)
  return transitionTx(ctx, async (c) => {
    const req = await lockRequest(c, idOf(ref))
    assertStatus(req, ['pending'])
    if (await settleIfDue(c, req)) return null
    const lines = await linesOf(c, req.id)
    await assertStillAvailable(c, req.id, lines, req.from_date, req.to_date)
    const updated = await setRequest(c, req, { status: 'accepted' })
    const snapshotLines = lines.map(toSnapshotLine)
    await writeAudit(c, {
      action: 'update',
      entityType: 'loan_request',
      entityId: req.id,
      before: await requestAuditSnapshot(c, req, {}, snapshotLines),
      after: await requestAuditSnapshot(c, req, { status: 'accepted' }, snapshotLines),
    })
    return toLoanRequest(updated)
  })
}

/**
 * Counter a pending request: change the offered quantities (down to 0 to drop a line, never above what was requested)
 * and/or the dates, with an optional message to the staff member. The lines, the dates and the status change commit
 * together. Admin.
 */
export async function sendCounter(ctx: Ctx, ref: RequestRef, input: CounterInput): Promise<LoanRequest> {
  assertAdmin(ctx)
  const edits = Array.isArray(input?.lines) ? input.lines : []
  const newFrom = input?.fromDate === undefined ? undefined : checkDate(input.fromDate, 'From date')
  const newTo = input?.toDate === undefined ? undefined : dateOrNull(input.toDate, 'To date')
  const adminMessage = typeof input?.message === 'string' ? input.message.trim() || null : null

  return transitionTx(ctx, async (c) => {
    const req = await lockRequest(c, idOf(ref))
    assertStatus(req, ['pending'])
    if (await settleIfDue(c, req)) return null
    const fromDate = newFrom ?? req.from_date
    const toDate = newTo !== undefined ? newTo : req.to_date
    if (toDate && toDate < fromDate) throw new DataError(400, "To date can't be before the From date.")

    const linesBefore = await linesOf(c, req.id)
    const editedById = new Map<string, number>()
    for (const edit of edits) {
      const line = linesBefore.find((l) => l.id === edit?.lineId)
      if (!line) throw new DataError(400, 'One of the items is not part of this request.')
      const offered = Number(edit.offered_quantity)
      if (!Number.isInteger(offered) || offered < 0 || offered > line.requested_quantity) {
        throw new DataError(400, 'Offered quantity must be a whole number from 0 up to the requested quantity.')
      }
      editedById.set(line.id, offered)
    }
    const linesAfter = linesBefore.map((l) => ({ ...l, offered_quantity: editedById.get(l.id) ?? l.offered_quantity }))

    await assertStillAvailable(c, req.id, linesAfter, fromDate, toDate)

    const updated = await setRequest(c, req, { status: 'countered', from_date: fromDate, to_date: toDate, admin_message: adminMessage })
    for (const [lineId, offered] of editedById) {
      await c.db.update(loanRequestLines).set({ offered_quantity: offered }).where(eq(loanRequestLines.id, lineId))
    }
    // The counter only moves offered_quantity; everything else on a line is unchanged.
    await writeAudit(c, {
      action: 'update',
      entityType: 'loan_request',
      entityId: req.id,
      before: await requestAuditSnapshot(c, req, {}, linesBefore.map(toSnapshotLine)),
      after: await requestAuditSnapshot(
        c,
        req,
        { status: 'countered', from_date: fromDate, to_date: toDate, admin_message: adminMessage },
        linesAfter.map(toSnapshotLine),
      ),
    })
    return toLoanRequest(updated)
  })
}

/** Decline a pending (or countered) request, with an optional message to the staff member. Admin. */
export async function declineRequest(ctx: Ctx, ref: RequestRef, message?: string | null): Promise<LoanRequest> {
  assertAdmin(ctx)
  const adminMessage = typeof message === 'string' ? message.trim() || null : null
  return inTx(ctx, async (c) => {
    const req = await lockRequest(c, idOf(ref))
    assertStatus(req, ['pending', 'countered'])
    const lines = await linesOf(c, req.id)
    const updated = await setRequest(c, req, { status: 'declined', admin_message: adminMessage })

    // Declining an already-countered request throws away the whole counter offer: the staff member's original message,
    // what was offered instead (and any items removed) and the counter message all vanish from the live request the
    // instant its status flips. Freeze all of it into this one audit entry so it is still reviewable later. Declining a
    // still-pending request has nothing to freeze (nothing was countered yet).
    const wasCountered = req.status === 'countered'
    const snapshotLines = lines.map(toSnapshotLine)
    await writeAudit(c, {
      action: 'update',
      entityType: 'loan_request',
      entityId: req.id,
      before: await requestAuditSnapshot(c, req, {}, snapshotLines),
      after: await requestAuditSnapshot(
        c,
        req,
        {
          status: 'declined',
          admin_message: adminMessage,
          ...(wasCountered
            ? {
                staff_message: req.message ?? null,
                counter_message: req.admin_message ?? null,
                countered_lines: lines.map((l) => ({
                  product_name: l.product_name,
                  requested_quantity: l.requested_quantity,
                  offered_quantity: l.offered_quantity,
                })),
              }
            : {}),
        },
        snapshotLines,
      ),
    })
    return toLoanRequest(updated)
  })
}

// --- Staff responses ---------------------------------------------------------

/** Only the request's own staff member answers a counter (an admin who is not that person is told so; other staff get a 404). */
function assertOwner(c: Ctx, row: RequestRow): void {
  if (c.caller.staffId !== null && c.caller.staffId === row.staff_id) return
  if (c.caller.role === 'admin') throw new DataError(403, NOT_YOURS)
  throw new DataError(404, NOT_FOUND)
}

async function answerCounter(ctx: Ctx, ref: RequestRef, next: 'accepted' | 'declined'): Promise<LoanRequest> {
  return transitionTx(ctx, async (c) => {
    const req = await lockRequest(c, idOf(ref))
    assertOwner(c, req)
    assertStatus(req, ['countered'])
    if (await settleIfDue(c, req)) return null
    const updated = await setRequest(c, req, { status: next })
    const lines = (await linesOf(c, req.id)).map(toSnapshotLine)
    await writeAudit(c, {
      action: 'update',
      entityType: 'loan_request',
      entityId: req.id,
      before: await requestAuditSnapshot(c, req, {}, lines),
      after: await requestAuditSnapshot(c, req, { status: next }, lines),
    })
    return toLoanRequest(updated)
  })
}

/** The staff member accepts the admin's counter: the request becomes an approved pickup. Only from `countered`. */
export function acceptCounter(ctx: Ctx, ref: RequestRef): Promise<LoanRequest> {
  return answerCounter(ctx, ref, 'accepted')
}

/** The staff member turns the counter down. Only from `countered`. */
export function declineCounter(ctx: Ctx, ref: RequestRef): Promise<LoanRequest> {
  return answerCounter(ctx, ref, 'declined')
}

/**
 * Withdraw a pending, countered or accepted request: the staff member's own, or any request when an admin cancels the
 * pickup. `reason` is an admin's note (the Dashboard's Cancel pickup dialog) and goes on the audit entry as
 * `cancel_reason`; a staff member withdrawing their own request doesn't give one.
 */
export async function withdrawRequest(ctx: Ctx, ref: RequestRef, reason?: string | null): Promise<LoanRequest> {
  const cancelReason = typeof reason === 'string' ? reason.trim() : ''
  return inTx(ctx, async (c) => {
    const req = await lockRequest(c, idOf(ref))
    assertCanSee(c, req)
    assertStatus(req, ACTIVE_STATUSES)
    const updated = await setRequest(c, req, { status: 'withdrawn' })
    const lines = (await linesOf(c, req.id)).map(toSnapshotLine)
    await writeAudit(c, {
      action: 'update',
      entityType: 'loan_request',
      entityId: req.id,
      before: await requestAuditSnapshot(c, req, {}, lines),
      after: await requestAuditSnapshot(c, req, { status: 'withdrawn', ...(cancelReason ? { cancel_reason: cancelReason } : {}) }, lines),
    })
    return toLoanRequest(updated)
  })
}

// --- Automatic expiry and no-show --------------------------------------------

function nextExpiryStatus(row: RequestRow, today: string): 'expired' | 'no_show' | null {
  const request = toLoanRequest(row)
  if (isExpired(request, today)) return 'expired'
  if (isNoShowCandidate(request, today)) return 'no_show'
  return null
}

/**
 * The expiry / no-show change for a request already locked by `c`, if it is due on the server's clock: writes the
 * status and its audit entry, recorded as the system (never as whoever's page or action got here: `c`'s caller is
 * swapped for SYSTEM_ACTOR for the audit write only). Resolves to the new status, or null when nothing was due.
 * "Today" is the calendar day in APP_TIME_ZONE (Africa/Johannesburg) of ctx.now(), whatever zone the server runs in.
 */
async function settleLocked(c: Ctx, locked: RequestRow): Promise<'expired' | 'no_show' | null> {
  const next = nextExpiryStatus(locked, appCalendarDay(c.now()))
  if (!next) return null
  await setRequest(c, locked, { status: next })
  // Everything except the line items is already on the row; the lines are one extra read. Freezing it all (rather than
  // joining at display time) keeps the entry standing on its own in a CSV export. fulfilled_txn_id is null here by
  // definition (a no-show needs nothing issued, an expiry is never accepted), so stock never moved.
  const lines = (await linesOf(c, locked.id)).map(toSnapshotLine)
  await writeAudit({ ...c, caller: SYSTEM_ACTOR }, {
    action: 'update',
    entityType: 'loan_request',
    entityId: locked.id,
    before: await requestAuditSnapshot(c, locked, {}, lines),
    after: await requestAuditSnapshot(c, locked, { status: next }, lines),
  })
  return next
}

/**
 * A decision on a pending / countered request (approve, counter, accept or decline a counter) re-checks expiry under
 * the request lock: one past its expiry date is settled as expired right here and the decision must not go ahead.
 * True when it was settled.
 */
async function settleIfDue(c: Ctx, locked: RequestRow): Promise<boolean> {
  return (await settleLocked(c, locked)) !== null
}

/**
 * The lazy expiry / no-show pass for one request, on the server's clock (ctx.now()). Both transitions need to be real
 * status values the reservation ledger and the lists can rely on, not just a display label, so the first read after
 * the date passes writes them.
 *
 * Two callers racing on the same request: the request row is locked and re-read under the lock, so the second one finds
 * the first one's change and does nothing: exactly one status change and one audit entry.
 */
async function settleExpiry(ctx: Ctx, row: RequestRow): Promise<LoanRequestStatus> {
  if (!nextExpiryStatus(row, appCalendarDay(ctx.now()))) return row.status
  return inTx(ctx, async (c) => {
    const locked = await lockRequest(c, row.id)
    return (await settleLocked(c, locked)) ?? locked.status
  })
}

/** Persist the expiry / no-show transition if the request is due for it. Resolves to the request's status afterwards. */
export async function expireIfNeeded(ctx: Ctx, ref: RequestRef): Promise<LoanRequestStatus> {
  const row = await findRequest(ctx, idOf(ref))
  assertCanSee(ctx, row)
  return settleExpiry(ctx, row)
}

/**
 * The accepted (not yet picked up) requests as they stand after the lazy no-show pass: soonest pickup first. The
 * Dashboard's Incoming Pickups and its Sidebar badge both start from here, so a request whose whole pickup window has
 * passed is settled (status change plus audit entry, as the system, once even when several callers race) before it is
 * shown or counted, and then no longer appears. Admin.
 */
export async function listAcceptedPickups(ctx: Ctx): Promise<LoanRequest[]> {
  assertAdmin(ctx)
  const today = appCalendarDay(ctx.now())
  const rows = await ctx.db
    .select()
    .from(loanRequests)
    .where(eq(loanRequests.status, 'accepted'))
    .orderBy(asc(loanRequests.from_date), asc(loanRequests.created_at), asc(loanRequests.id))
  const stillAccepted: LoanRequest[] = []
  for (const row of rows) {
    const request = toLoanRequest(row)
    // Only a no-show can be due for an accepted request, so the others need no second read.
    if (!isNoShowCandidate(request, today) || (await settleExpiry(ctx, row)) === 'accepted') stillAccepted.push(request)
  }
  return stillAccepted
}

// --- Sidebar alert counts ----------------------------------------------------

async function activeRows(c: Ctx, staffId?: string): Promise<RequestRow[]> {
  return c.db
    .select()
    .from(loanRequests)
    .where(and(inArray(loanRequests.status, ACTIVE_STATUSES), staffId === undefined ? undefined : eq(loanRequests.staff_id, staffId)))
    .orderBy(asc(loanRequests.created_at), asc(loanRequests.id))
}

/**
 * Counts-only companion to the Loan Requests page, for the Sidebar badge: the combined total of its two tabs (Needs
 * Review: pending, Sent Counters: countered). History is excluded on purpose. Accepted requests are deliberately NOT
 * counted even though they're active: once accepted they become an Incoming Pickup, tracked on the Dashboard, so
 * counting them here would double-count them in both sidebar badges. Applies expiry first, so a request that just
 * expired doesn't count. Admin.
 */
export async function loadLoanRequestsAlertCount(ctx: Ctx): Promise<number> {
  assertAdmin(ctx)
  let count = 0
  for (const row of await activeRows(ctx)) {
    const status = await settleExpiry(ctx, row)
    if (status === 'pending' || status === 'countered') count++
  }
  return count
}

/**
 * The portal counterpart: the caller's own combined total across My Requests' three actionable tabs (Needs your
 * response, Awaiting Selouna, Upcoming). Unlike the admin badge, accepted IS counted: the portal has no separate Incoming
 * Pickups view to double-count against. History is excluded.
 */
export async function loadMyRequestsAlertCount(ctx: Ctx): Promise<number> {
  const staffId = ctx.caller.staffId
  if (!staffId) return 0
  let count = 0
  for (const row of await activeRows(ctx, staffId)) {
    const status = await settleExpiry(ctx, row)
    if ((ACTIVE_STATUSES as string[]).includes(status)) count++
  }
  return count
}

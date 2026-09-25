import { db } from './config'
import { collection, doc, getDoc, getDocs, addDoc, updateDoc, query, where } from 'firebase/firestore'
import { logAudit } from './audit'
import { todayDateStr, addDaysToDateStr, isoToLocalDateStr, genRequestRef } from '@/lib/utils'
import type { Product, LoanRequest, LoanRequestLine, LoanRequestStatus, LendingInterval } from '@/types/database'

export const ACTIVE_STATUSES: LoanRequestStatus[] = ['pending', 'countered', 'accepted']
const MAX_LOAN_DAYS = 30

// Stand-in upper/lower bounds for "any time, ever" when a check has no
// meaningful date window of its own (see findQuantityReductionConflicts
// below). Dates compare lexicographically as YYYY-MM-DD strings throughout
// this app, so these sentinels behave as -infinity/+infinity without
// special-casing the comparison itself. OPEN_ENDED_TO also matches Stock
// Out's own sentinel for an open-ended (no Lend To) walk-in issue.
export const OPEN_ENDED_TO = '9999-12-31'
const ALL_TIME_FROM = '0001-01-01'

// A product saved before the Lending Interval field existed has no
// lending_interval at all — treated as this, which preserves the flat
// 7-day cap every product used to have (the old MAX_LOAN_DAYS constant
// above, kept only for computeExpiryDate's unrelated SLA now).
const DEFAULT_LENDING_INTERVAL: LendingInterval = 'week_1'

export const LENDING_INTERVALS: { value: LendingInterval; label: string; days: number | null }[] = [
  { value: 'week_1', label: '1 Week', days: 7 },
  { value: 'week_2', label: '2 Weeks', days: 14 },
  { value: 'week_3', label: '3 Weeks', days: 21 },
  { value: 'month_1', label: '1 Month', days: 30 },
  { value: 'indefinite', label: 'Indefinitely', days: null },
]

function lendingIntervalInfo(interval: LendingInterval | null | undefined) {
  return LENDING_INTERVALS.find((i) => i.value === interval) ?? LENDING_INTERVALS.find((i) => i.value === DEFAULT_LENDING_INTERVAL)!
}

// Max loan duration in days for a product's lending interval, or null for
// Indefinitely (no cap at all).
export function lendingIntervalDays(interval: LendingInterval | null | undefined): number | null {
  return lendingIntervalInfo(interval).days
}

export function lendingIntervalLabel(interval: LendingInterval | null | undefined): string {
  return lendingIntervalInfo(interval).label
}

// A candidate or stored date range's "to" side, resolved to a real,
// comparable string — null/blank (an indefinite loan, or a walk-in issue
// with no Lend To) behaves as "overlaps everything from its from-date
// onward" via the OPEN_ENDED_TO sentinel, without special-casing every
// comparison that touches it.
export function effectiveToDate(to: string | null | undefined): string {
  return to || OPEN_ENDED_TO
}

interface CartLike {
  product: Product
  quantity: number
}

interface ActorInfo {
  userId?: string | null
  userName?: string | null
}

// Holder-level breakdown of active reservations (pending, countered, or
// accepted) for a product/date window — getReservedQuantity above answers
// "how many units", this answers "whose, and in what state", so Stock Out's
// hard block can name exactly which request(s) a walk-in issue would
// encroach on and point Selouna at the specific one to resolve.
//
// Originally (2026-09-20) this only looked at ACCEPTED reservations — an
// approved, incoming pickup Selouna had already committed to — because a
// pending/countered proposal wasn't a promise yet, so encroaching on it was
// only a soft warning she could click past. Per 2026-09-20 follow-up: that
// let a walk-in silently eat into a pending request's stock, and the only
// sign of trouble surfaced later on the Loan Requests page (the "Offering"
// stepper auto-clamping down to 0 with no way back up). So all three active
// statuses now block identically — `statuses` defaults to all of them, but
// callers that specifically need only-accepted (or only-pending) can narrow.
export interface ReservationHolder {
  requestId: string
  staffId: string
  staffName: string
  quantity: number
  fromDate: string
  toDate: string | null   // null = indefinite loan, no return date
  status: LoanRequestStatus
}

export async function getReservationHolders(
  productId: string,
  fromDate: string,
  toDate: string,
  statuses: LoanRequestStatus[] = ACTIVE_STATUSES,
): Promise<ReservationHolder[]> {
  const activeSnap = await getDocs(
    query(collection(db, 'loan_requests'), where('status', 'in', statuses)),
  )
  const activeById = new Map<string, LoanRequest>()
  activeSnap.forEach((d) => activeById.set(d.id, { id: d.id, ...d.data() } as LoanRequest))
  if (activeById.size === 0) return []

  const linesSnap = await getDocs(
    query(collection(db, 'loan_request_lines'), where('product_id', '==', productId)),
  )
  const holders: ReservationHolder[] = []
  linesSnap.forEach((d) => {
    const line = d.data() as LoanRequestLine
    const req = activeById.get(line.request_id)
    if (!req || line.offered_quantity <= 0) return
    if (fromDate <= effectiveToDate(req.to_date) && toDate >= req.from_date) {
      holders.push({
        requestId: req.id,
        staffId: req.staff_id,
        staffName: req.staff_name,
        quantity: line.offered_quantity,
        fromDate: req.from_date,
        toDate: req.to_date,
        status: req.status,
      })
    }
  })
  return holders
}

// Human-readable label for a ReservationHolder's status — used anywhere a
// blocking/FYI conflict alert needs to say at a glance whether it's looking
// at an unapproved proposal or an already-committed pickup (Stock Out,
// and the Products page quantity-reduction check below).
export function reservationStatusLabel(status: LoanRequestStatus): string {
  switch (status) {
    case 'accepted': return 'approved pickup'
    case 'countered': return 'countered offer'
    default: return 'pending request'
  }
}

// Where to send Selouna to actually clear a blocking reservation — an
// approved pickup can only be cancelled from the Dashboard's Incoming
// Pickups tab (that Cancel button doesn't live on the Loan Requests page —
// see the 2026-09-20 "Incoming Pickups consolidated onto the Dashboard"
// change), while a pending/countered proposal is resolved on the Loan
// Requests page itself. Mixed sets of holders name both, since one sentence
// pointing at the wrong page for half the holders would send her on a wild
// goose chase.
export function resolutionInstruction(holders: ReservationHolder[]): string {
  const hasAccepted = holders.some((h) => h.status === 'accepted')
  const hasPending = holders.some((h) => h.status === 'pending' || h.status === 'countered')
  const fragments: string[] = []
  if (hasAccepted) fragments.push('cancel the approved pickup(s) on the Dashboard')
  if (hasPending) fragments.push('approve, counter, or decline the pending request(s) on the Loan Requests page')
  return fragments.join(', and ')
}

// A product-quantity edit (Products page — a stocktake correction, writing
// off damaged/lost units) has no date window of its own, unlike Stock Out
// or a portal submission, which each apply to one specific range. So rather
// than checking one range's reserved total, this walks every currently
// active reservation on the product (any status, any date — hence the
// all-time sentinels) and re-runs the same per-request "is my own window
// still satisfiable" check assertStillAvailable/refreshAvailability already
// use elsewhere, against the proposed new quantity. That catches exactly
// the requests a reduction would break, without over-counting reservations
// that don't actually overlap each other in time — two requests for
// different, non-overlapping weeks shouldn't both count against the same
// unit just because they're both "active" today.
export async function findQuantityReductionConflicts(
  productId: string,
  newQuantity: number,
): Promise<ReservationHolder[]> {
  const holders = await getReservationHolders(productId, ALL_TIME_FROM, OPEN_ENDED_TO)
  const offenders: ReservationHolder[] = []
  for (const holder of holders) {
    const reservedForWindow = await getReservedQuantity(
      productId, holder.fromDate, effectiveToDate(holder.toDate), holder.requestId,
    )
    if (reservedForWindow + holder.quantity > newQuantity) offenders.push(holder)
  }
  return offenders
}

// 3.1 — Reservation ledger. Availability for a candidate range is always
// computed live by scanning active requests and checking date-range
// overlap — never a denormalized "units reserved" counter on Product (see
// LENDING_PORTAL_SPEC.md decision #6: a stored counter can drift, a live
// query can't).
export async function getReservedQuantity(
  productId: string,
  fromDate: string,
  toDate: string,
  excludeRequestId?: string,
): Promise<number> {
  const activeSnap = await getDocs(
    query(collection(db, 'loan_requests'), where('status', 'in', ACTIVE_STATUSES)),
  )
  const activeById = new Map<string, LoanRequest>()
  activeSnap.forEach((d) => {
    if (d.id === excludeRequestId) return
    activeById.set(d.id, { id: d.id, ...d.data() } as LoanRequest)
  })
  if (activeById.size === 0) return 0

  const linesSnap = await getDocs(
    query(collection(db, 'loan_request_lines'), where('product_id', '==', productId)),
  )
  let sum = 0
  linesSnap.forEach((d) => {
    const line = d.data() as LoanRequestLine
    const req = activeById.get(line.request_id)
    if (!req) return
    if (fromDate <= effectiveToDate(req.to_date) && toDate >= req.from_date) sum += line.offered_quantity
  })
  return sum
}

// 3.2 — Cart validation. Checks each product's own lend window, its own
// lending interval, and live availability. Collects every failing
// product's error at once so the UI can show every problem, not just the
// first.
// Each product now carries its own lending interval (Products page,
// 2026-09-20) instead of one flat app-wide MAX_LOAN_DAYS. The cart shares a
// single From/To pair across every item in it, so the binding rule for the
// whole cart is the TIGHTEST cap among its items — a mixed cart of a
// "1 Week" item and an "Indefinitely" item behaves like its most
// restrictive member, not its most lenient one. Returns null only when
// EVERY item in the cart is Indefinitely, meaning a To date isn't required
// at all. Shared between validateCartDates below and the cart page itself
// (which needs the same number to cap the To-date picker's `max` live, as
// the cart's contents change, before ever calling validateCartDates).
export function tightestLendingCap(
  cartItems: { product: Pick<Product, 'lending_interval'> }[],
): { value: LendingInterval; label: string; days: number } | null {
  const finiteCaps = cartItems
    .map(({ product }) => lendingIntervalInfo(product.lending_interval))
    .filter((info) => info.days !== null) as { value: LendingInterval; label: string; days: number }[]
  return finiteCaps.length > 0
    ? finiteCaps.reduce((min, c) => (c.days < min.days ? c : min))
    : null
}

export async function validateCartDates(
  cartItems: CartLike[],
  fromDate: string,
  toDate: string,
): Promise<{ valid: boolean; errors: string[] }> {
  const errors: string[] = []

  if (!fromDate) {
    return { valid: false, errors: ['Select a From date.'] }
  }

  const tightestCap = tightestLendingCap(cartItems)

  if (!toDate) {
    if (tightestCap) {
      errors.push('Select a To date — one or more items in your cart have a limited lending interval.')
    }
    // else: every item is Indefinitely — an open-ended request with no
    // return date is fine, the same convenience Stock Out's own blank
    // "Lend To" already offers for a walk-in issue.
  } else {
    if (toDate < fromDate) errors.push("To date can't be before the From date.")
    if (tightestCap && toDate > addDaysToDateStr(fromDate, tightestCap.days)) {
      errors.push(`Loan window cannot exceed ${tightestCap.label} for the items in your cart.`)
    }
  }

  const effectiveTo = effectiveToDate(toDate)

  for (const { product, quantity } of cartItems) {
    // lend_to is optional — unset means the product is lendable
    // indefinitely (no end date decided yet), not "not lendable". Only
    // lend_from (the window has actually opened) is required. See
    // formatLendWindow() in utils.ts for the matching display logic.
    if (!product.lend_from) {
      errors.push(`${product.name} isn't set up for portal lending.`)
      continue
    }
    if (product.lend_to && !toDate) {
      // This item has its own defined cutoff, so an open-ended request
      // (however Indefinitely its own lending interval is) can't be
      // promised past it — a real To date is required for this one.
      errors.push(`${product.name} must be returned by ${product.lend_to} — pick a To date within its lendable window.`)
      continue
    }
    if (fromDate < product.lend_from || (product.lend_to && toDate && toDate > product.lend_to)) {
      const windowLabel = product.lend_to ? `${product.lend_from} – ${product.lend_to}` : `from ${product.lend_from}`
      errors.push(
        `${product.name} is only lendable ${windowLabel} — outside your selected range.`,
      )
      continue
    }
    const reserved = await getReservedQuantity(product.id.toString(), fromDate, effectiveTo)
    const available = Math.max(0, product.quantity_on_hand - reserved)
    if (quantity > available) {
      errors.push(`${product.name}: only ${available} unit(s) available for these dates, you requested ${quantity}.`)
    }
  }

  return { valid: errors.length === 0, errors }
}

// 3.3 — Expiry: min(updated_at + 30 days, from_date). See decision #5 for
// why a flat SLA that resets on every state change is wrong — capping at
// from_date keeps a near-term request from outliving its own pickup date.
// Widened from 7 to 30 days (2026-09-20) — a week was too tight a window
// for Selouna to respond to a pending/countered request before it silently
// expired on the staff member.
export function computeExpiryDate(request: LoanRequest): string | null {
  if (request.status !== 'pending' && request.status !== 'countered') return null
  const oneMonthOut = addDaysToDateStr(isoToLocalDateStr(request.updated_at), MAX_LOAN_DAYS)
  return oneMonthOut < request.from_date ? oneMonthOut : request.from_date
}

export function isExpired(request: LoanRequest): boolean {
  const expiry = computeExpiryDate(request)
  return expiry !== null && todayDateStr() > expiry
}

// 3.4 — No-show: accepted, the WHOLE approved window has passed, nothing
// issued against it. Deliberately keyed on the window's end (effectively
// "To", or "never" if the item's Indefinite — see effectiveToDate above),
// not "From" + 1 day: the reservation ledger already holds these units for
// the staff member across the entire From-To range (getReservedQuantity
// treats an accepted request as occupying that whole window, not just its
// first day), so flagging no-show the day after From — before anyone else
// could even have taken the stock — used to bump a staff member who was
// simply running a few days into a multi-day or Indefinite pickup window.
// An Indefinite request (to_date null) never auto-flags at all, same as it
// never auto-expires for a return — that's consistent with "no forced
// return date" also meaning no forced pickup deadline; an admin can still
// manually Cancel it from the Dashboard at any time regardless.
export function isNoShowCandidate(request: LoanRequest): boolean {
  return request.status === 'accepted' && !request.fulfilled_txn_id && todayDateStr() > effectiveToDate(request.to_date)
}

// Lazily persists the expiry/no-show transition on next read (see decision
// #5/§3.4 — both need to be real status values the reservation ledger and
// list queries can exclude/include on, not just a live display label).
/**
 * The shape every loan_request audit entry carries, whatever the
 * transition.
 *
 * Previously each transition logged only what changed — usually just
 * { status } — so a request's history read as fragments: the create entry
 * held the items and dates, every entry after it held almost nothing. In
 * a CSV export that is unusable, because each row has to stand on its
 * own; you cannot scroll up to the create row to find out what an
 * "accepted" row was about.
 *
 * Every entry is now a complete snapshot of the request at that moment —
 * reference, staff, dates, messages and the full item list — differing
 * only in `status` and whatever that transition genuinely changed. Rows
 * line up column-for-column in the export, and before/after still diff
 * cleanly on screen, because the unchanged fields are identical on both
 * sides and FieldDiff filters them out.
 */
export type RequestSnapshotLine = {
  product_id: string
  product_name: string
  requested_quantity: number
  offered_quantity: number
}

function toSnapshotLines(lines: LoanRequestLine[]): RequestSnapshotLine[] {
  return lines.map((l) => ({
    product_id: l.product_id,
    product_name: l.product_name,
    requested_quantity: l.requested_quantity,
    offered_quantity: l.offered_quantity,
  }))
}

/**
 * Build that snapshot. `overrides` sets what this particular transition
 * changes (status, new dates, an admin message, the fulfilling
 * transaction); everything else comes from the request as it stands.
 * Lines are fetched when not supplied — callers that already hold them,
 * or that need the pre-change versions, pass them in.
 */
export async function requestAuditSnapshot(
  request: LoanRequest,
  overrides: Record<string, unknown> = {},
  lines?: RequestSnapshotLine[],
): Promise<Record<string, unknown>> {
  let snapshotLines = lines
  if (!snapshotLines) {
    try {
      snapshotLines = toSnapshotLines(await getRequestLines(request.id))
    } catch {
      // An audit entry missing its item list beats no audit entry at all,
      // so a failed read must never block the transition itself.
      snapshotLines = []
    }
  }
  return {
    reference_no: request.reference_no ?? null,
    staff_id: request.staff_id,
    staff_name: request.staff_name,
    status: request.status,
    from_date: request.from_date,
    to_date: request.to_date,
    original_from_date: request.original_from_date,
    original_to_date: request.original_to_date,
    message: request.message ?? null,
    admin_message: request.admin_message ?? null,
    fulfilled_txn_id: request.fulfilled_txn_id ?? null,
    lines: snapshotLines,
    line_count: snapshotLines.length,
    // The agreed quantity — what would actually be handed over. A counter
    // can reduce offered_quantity below what was requested.
    total_qty: snapshotLines.reduce((sum, l) => sum + (l.offered_quantity ?? 0), 0),
    ...overrides,
  }
}

// The line items belonging to a request. The same query is currently
// inlined in stock-out/page.tsx and audit-log/page.tsx; this is the
// shared version, added for expireIfNeeded's audit snapshot.
export async function getRequestLines(requestId: string): Promise<LoanRequestLine[]> {
  const snap = await getDocs(
    query(collection(db, 'loan_request_lines'), where('request_id', '==', requestId)),
  )
  return snap.docs.map((d) => ({ id: d.id, ...d.data() })) as unknown as LoanRequestLine[]
}

// No ActorInfo parameter, deliberately: this transition has no actor. It
// is driven by a date passing, and fires on whichever page runs the lazy
// pass first. Accepting an actor here and ignoring it would invite a
// caller to believe it was being recorded.
export async function expireIfNeeded(request: LoanRequest): Promise<LoanRequestStatus> {
  let next: LoanRequestStatus | null = null
  if (isExpired(request)) next = 'expired'
  else if (isNoShowCandidate(request)) next = 'no_show'
  if (!next) return request.status

  const now = new Date().toISOString()
  await updateDoc(doc(db, 'loan_requests', request.id), { status: next, updated_at: now })

  /*
   * These two transitions used to log nothing but { status }, which made
   * them impossible to follow in the audit log: you could see a request
   * became "Not Picked Up" but not who was meant to collect it, what was
   * in it, or when it was due. Everything except the line items is
   * already in `request`, so it costs nothing to record it; the lines are
   * one extra read, the same trade declineRequest() already makes to
   * freeze its counter offer.
   *
   * Freezing rather than joining at display time is deliberate. The audit
   * entry has to stand on its own in a CSV export, and stay truthful even
   * if the request or its lines are edited or removed afterwards.
   */
  logAudit({
    // NOT `actor`. This is an automatic transition triggered by a date
    // passing, not a decision anyone made. It fires on whichever page
    // happens to run the lazy pass first — including the borrower's own
    // portal — so attributing it to that person would put their name on
    // an action they did not take.
    userId: null,
    userName: 'System (automatic)',
    action: 'update', entityType: 'loan_request', entityId: request.id,
    before: await requestAuditSnapshot(request),
    // fulfilled_txn_id is null here by definition: isNoShowCandidate()
    // requires it, so a no-show or expiry means nothing was ever issued
    // and stock never moved. The snapshot records that explicitly rather
    // than omitting it, since an absent field reads as missing data.
    after: await requestAuditSnapshot(request, { status: next }),
  })
  return next
}

// 3.5 — Cart submission.
export async function submitLoanRequest(
  staffId: string,
  staffName: string,
  cart: CartLike[],
  fromDate: string,
  toDate: string,
  message: string | null,
  actor: ActorInfo = {},
): Promise<string> {
  const check = await validateCartDates(cart, fromDate, toDate)
  if (!check.valid) throw new Error(check.errors[0])

  const now = new Date().toISOString()
  const reqPayload = {
    // Human-readable reference, the counterpart to a transaction's
    // TXN-... — see genRequestRef. Written once at submission and never
    // changed, so it stays quotable for the life of the request.
    reference_no: genRequestRef(),
    staff_id: staffId,
    staff_name: staffName,
    status: 'pending' as const,
    message,
    admin_message: null,
    from_date: fromDate,
    to_date: toDate || null,
    original_from_date: fromDate,
    original_to_date: toDate || null,
    created_at: now,
    updated_at: now,
    fulfilled_txn_id: null,
  }
  const reqRef = await addDoc(collection(db, 'loan_requests'), reqPayload)
  // line_count/total_qty aren't real fields on the loan_requests doc —
  // they're computed here purely so the Audit Log's create entry can show
  // an item summary the same way a transaction's create entry does (see
  // audit-log/page.tsx's LoanRequestSummary/TransactionSummary). The actual
  // product/quantity rows are fetched separately from loan_request_lines.
  // The cart IS the line set at submission — requested and offered are
  // equal until Selouna counters — so no read is needed here.
  const submittedLines: RequestSnapshotLine[] = cart.map((item) => ({
    product_id: item.product.id.toString(),
    product_name: item.product.name,
    requested_quantity: item.quantity,
    offered_quantity: item.quantity,
  }))
  logAudit({
    userId: actor.userId, userName: actor.userName,
    action: 'create', entityType: 'loan_request', entityId: reqRef.id,
    before: null,
    after: await requestAuditSnapshot(
      { ...reqPayload, id: reqRef.id } as unknown as LoanRequest,
      {},
      submittedLines,
    ),
  })

  for (const item of cart) {
    await addDoc(collection(db, 'loan_request_lines'), {
      request_id: reqRef.id,
      product_id: item.product.id.toString(),
      product_name: item.product.name,
      requested_quantity: item.quantity,
      offered_quantity: item.quantity,
      created_at: now,
    })
  }

  return reqRef.id
}

// Re-runs the reservation ledger against the (possibly edited) offered
// lines/dates before Selouna's write commits, per decision #7 — availability
// may have changed since the request was submitted.
async function assertStillAvailable(
  requestId: string,
  lines: { product_id: string; offered_quantity: number }[],
  fromDate: string,
  toDate: string | null,
): Promise<void> {
  const effectiveTo = effectiveToDate(toDate)
  for (const line of lines) {
    if (line.offered_quantity <= 0) continue
    const reserved = await getReservedQuantity(line.product_id, fromDate, effectiveTo, requestId)
    // NOTE: reserved already excludes this request's own current reservation
    // (via excludeRequestId), so the full offered_quantity is the amount to
    // check against remaining stock, not just the delta.
    const productSnap = await getDoc(doc(db, 'products', line.product_id))
    const onHand = (productSnap.data() as { quantity_on_hand?: number } | undefined)?.quantity_on_hand ?? 0
    if (reserved + line.offered_quantity > onHand) {
      throw new Error(`Availability changed since this request was submitted — not enough stock remains for one of the lines.`)
    }
  }
}

// 3.6 — Selouna's counter / approve / decline.
export async function approveAsIs(request: LoanRequest, lines: LoanRequestLine[], actor: ActorInfo = {}): Promise<void> {
  await assertStillAvailable(
    request.id,
    lines.map((l) => ({ product_id: l.product_id, offered_quantity: l.offered_quantity })),
    request.from_date, request.to_date,
  )
  const now = new Date().toISOString()
  await updateDoc(doc(db, 'loan_requests', request.id), { status: 'accepted', updated_at: now })
  const approvedLines = toSnapshotLines(lines)
  logAudit({
    userId: actor.userId, userName: actor.userName,
    action: 'update', entityType: 'loan_request', entityId: request.id,
    before: await requestAuditSnapshot(request, {}, approvedLines),
    after: await requestAuditSnapshot(request, { status: 'accepted' }, approvedLines),
  })
}

export async function sendCounter(
  request: LoanRequest,
  editedLines: { lineId: string; product_id: string; offered_quantity: number }[],
  newFromDate: string | undefined,
  newToDate: string | null | undefined,
  message: string | null | undefined,
  actor: ActorInfo = {},
): Promise<void> {
  const fromDate = newFromDate ?? request.from_date
  const toDate = newToDate !== undefined ? newToDate : request.to_date
  const adminMessage = message?.trim() || null
  await assertStillAvailable(request.id, editedLines, fromDate, toDate)

  // Read the lines BEFORE overwriting their offered quantities, so the
  // `before` snapshot records what was on offer previously rather than
  // what we are about to replace it with.
  const linesBefore = toSnapshotLines(await getRequestLines(request.id))

  const now = new Date().toISOString()
  await updateDoc(doc(db, 'loan_requests', request.id), {
    status: 'countered', updated_at: now, from_date: fromDate, to_date: toDate, admin_message: adminMessage,
  })
  for (const line of editedLines) {
    await updateDoc(doc(db, 'loan_request_lines', line.lineId), { offered_quantity: line.offered_quantity })
  }
  // The counter only moves offered_quantity; everything else on a line is
  // unchanged, so apply the edits onto the pre-read lines by product.
  const editedByProduct = new Map(editedLines.map((l) => [l.product_id, l.offered_quantity]))
  const linesAfter: RequestSnapshotLine[] = linesBefore.map((l) => ({
    ...l,
    offered_quantity: editedByProduct.get(l.product_id) ?? l.offered_quantity,
  }))
  logAudit({
    userId: actor.userId, userName: actor.userName,
    action: 'update', entityType: 'loan_request', entityId: request.id,
    before: await requestAuditSnapshot(request, {}, linesBefore),
    after: await requestAuditSnapshot(request, {
      status: 'countered', from_date: fromDate, to_date: toDate,
      admin_message: adminMessage,
    }, linesAfter),
  })
}

export async function declineRequest(
  request: LoanRequest,
  message: string | null | undefined,
  lines: LoanRequestLine[] | undefined,
  actor: ActorInfo = {},
): Promise<void> {
  const now = new Date().toISOString()
  const adminMessage = message?.trim() || null
  await updateDoc(doc(db, 'loan_requests', request.id), { status: 'declined', updated_at: now, admin_message: adminMessage })

  // Declining an already-countered request throws away the whole counter
  // offer — the staff's original message, what Selouna offered instead
  // (and any items she removed), and her own counter message all vanish
  // from the live document the instant status flips to 'declined'. Freeze
  // a snapshot of all of it into this one audit entry now, so it's still
  // reviewable later even though nothing on the loan_request or
  // loan_request_lines documents themselves shows it anymore. Declining a
  // still-*pending* request has nothing to freeze here (nothing was
  // countered yet), so this extra context is only added when relevant.
  const wasCountered = request.status === 'countered'
  const declinedLines = lines ? toSnapshotLines(lines) : undefined
  logAudit({
    userId: actor.userId, userName: actor.userName,
    action: 'update', entityType: 'loan_request', entityId: request.id,
    before: await requestAuditSnapshot(request, {}, declinedLines),
    after: await requestAuditSnapshot(request, {
      status: 'declined',
      admin_message: adminMessage,
      ...(wasCountered ? {
        staff_message: request.message ?? null,
        counter_message: request.admin_message ?? null,
        countered_lines: (lines ?? []).map((l) => ({
          product_name: l.product_name,
          requested_quantity: l.requested_quantity,
          offered_quantity: l.offered_quantity,
        })),
      } : {}),
    }, declinedLines),
  })
}

// 3.7 — Staff response to a counter.
async function transitionStatus(request: LoanRequest, next: LoanRequestStatus, actor: ActorInfo): Promise<void> {
  const now = new Date().toISOString()
  await updateDoc(doc(db, 'loan_requests', request.id), { status: next, updated_at: now })
  logAudit({
    userId: actor.userId, userName: actor.userName,
    action: 'update', entityType: 'loan_request', entityId: request.id,
    before: await requestAuditSnapshot(request),
    after: await requestAuditSnapshot(request, { status: next }),
  })
}

export async function acceptCounter(request: LoanRequest, actor: ActorInfo = {}): Promise<void> {
  await transitionStatus(request, 'accepted', actor)
}

export async function declineCounter(request: LoanRequest, actor: ActorInfo = {}): Promise<void> {
  await transitionStatus(request, 'declined', actor)
}

// `reason` is admin-only in practice (the portal's own "Withdraw" button
// never passes one — a staff member withdrawing their own request doesn't
// need to explain it) — the Dashboard's Incoming Pickups "Cancel pickup"
// confirmation collects it and logs it on the audit entry alongside the
// status transition, same spirit as a return waiver's own optional reason.
export async function withdrawRequest(
  request: LoanRequest,
  actor: ActorInfo = {},
  reason?: string | null,
): Promise<void> {
  const now = new Date().toISOString()
  await updateDoc(doc(db, 'loan_requests', request.id), { status: 'withdrawn', updated_at: now })
  logAudit({
    userId: actor.userId, userName: actor.userName,
    action: 'update', entityType: 'loan_request', entityId: request.id,
    before: await requestAuditSnapshot(request),
    after: await requestAuditSnapshot(request, {
      status: 'withdrawn',
      ...(reason ? { cancel_reason: reason } : {}),
    }),
  })
}

// Lean, counts-only companion to loan-requests/page.tsx's own load(), used
// by the Sidebar to badge the "Loan Requests" nav item with the combined
// total of the two tabs that page actually has (Needs Review, Sent
// Counters) — History is excluded on purpose, it's a record of what
// already happened, not something waiting on anyone. Accepted requests are
// deliberately NOT counted here even though they're an "active" status —
// once accepted they become an Incoming Pickup, which is tracked and
// actioned on the Dashboard (see dashboardAlerts.ts), not on this page, so
// counting them here would double-count the same request in both sidebar
// badges. Kept in sync with loan-requests/page.tsx's own pending/countered
// filters: if those change, mirror the change here too.
export async function loadLoanRequestsAlertCount(): Promise<number> {
  const reqSnap = await getDocs(collection(db, 'loan_requests'))
  const reqs = reqSnap.docs.map(d => ({ id: d.id, ...d.data() })) as LoanRequest[]
  const resolved = await Promise.all(reqs.map(async (r) => {
    if (r.status !== 'pending' && r.status !== 'countered' && r.status !== 'accepted') return r.status
    return expireIfNeeded(r)
  }))
  return resolved.filter(status => status === 'pending' || status === 'countered').length
}

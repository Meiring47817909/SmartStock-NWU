import 'server-only'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { assertAdmin, DataError, type Ctx } from '@/server/context'
import { toIso, withTx, type Db } from '@/server/db/client'
import { newId } from '@/server/db/ids'
import {
  loanRequestLines,
  loanRequests,
  productBarcodes,
  products,
  returnWaivers,
  staff,
  transactionLines,
  transactions,
} from '@/server/db/schema'
import { writeAudit } from '@/server/data/audit'
import { genRef } from '@/lib/utils'
import {
  productBalance,
  type AdjustInput,
  type CreateReturnWaiverInput,
  type OutstandingForStaff,
  type OutstandingLine,
  type ReturnInput,
  type StockInInput,
  type StockItemInput,
  type StockMovementResult,
  type StockOutInput,
  type UnscannableLine,
  type WaivedByTxn,
} from '@/lib/stockRules'
import type { ReturnWaiver, TxnType } from '@/types/database'

// Every save here is one database transaction: the transaction row, its lines, the quantity changes and the audit entry
// (plus, for a Stock Out against a loan request, the request's own status change and audit entry) commit together or not
// at all. Transactions, lines, waivers and audit entries are append-only; nothing here updates or deletes them.
//
// Locking, so two people working at once can't over-issue or over-return:
//   - products being changed are locked FOR UPDATE in id order, and the stock check is made on the locked rows;
//   - a Return or a waiver locks the OUT transaction row it settles before working out what is still outstanding;
//   - a Stock Out against a loan request locks the request row.
// Lock order is always: OUT transaction row, then products (by id), then the loan request.

const NOT_FOUND_STAFF = 'Staff record not found.'
const NOTHING_TO_RESOLVE = 'Nothing outstanding to resolve for this item.'
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/** Run `fn` in a transaction on the caller's connection (a savepoint when `ctx.db` is already a transaction). */
function inTx<T>(ctx: Ctx, fn: (txCtx: Ctx) => Promise<T>): Promise<T> {
  // One clock reading for the whole save, so the transaction, its lines and its audit entries carry the same instant.
  const at = ctx.now()
  return withTx(ctx.db as Db, (tx) => fn({ ...ctx, db: tx, now: () => at }))
}

// --- Input checks -------------------------------------------------------------

interface CleanItem {
  productId: string
  quantity: number
  barcodes: string[] | null
  issuedBarcode: string | null
  unitCost: number
}

function cleanItems(items: StockItemInput[] | undefined): CleanItem[] {
  if (!Array.isArray(items) || items.length === 0) throw new DataError(400, 'Add at least one item.')
  return items.map((raw) => {
    const productId = typeof raw?.productId === 'string' ? raw.productId : ''
    if (!productId) throw new DataError(400, 'Every item needs a product.')
    const quantity = Number(raw.quantity)
    if (!Number.isInteger(quantity) || quantity <= 0) throw new DataError(400, 'Quantity must be a whole number above zero.')
    let barcodes: string[] | null = null
    if (raw.barcodes !== undefined && raw.barcodes !== null) {
      if (!Array.isArray(raw.barcodes)) throw new DataError(400, 'Barcodes must be a list.')
      barcodes = [...new Set(raw.barcodes.map((b) => (typeof b === 'string' ? b.trim() : '')))]
      if (barcodes.length === 0 || barcodes.some((b) => !b)) throw new DataError(400, 'Barcodes must not be blank.')
    }
    const issuedBarcode = typeof raw.issuedBarcode === 'string' && raw.issuedBarcode.trim() ? raw.issuedBarcode.trim() : null
    const unitCost = raw.unitCost === undefined || raw.unitCost === null ? 0 : Number(raw.unitCost)
    if (!Number.isFinite(unitCost) || unitCost < 0) throw new DataError(400, 'Unit cost must be zero or more.')
    return { productId, quantity, barcodes, issuedBarcode, unitCost }
  })
}

function dateOrNull(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || !DATE_PATTERN.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new DataError(400, `${label} must be a date (YYYY-MM-DD).`)
  }
  return value
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

// --- Shared pieces ------------------------------------------------------------

type ProductRow = typeof products.$inferSelect

/** The products an item list touches, locked FOR UPDATE in id order. 404 when any is missing. */
async function lockProducts(c: Ctx, items: CleanItem[]): Promise<Map<string, ProductRow>> {
  const ids = [...new Set(items.map((i) => i.productId))]
  const rows = await c.db.select().from(products).where(inArray(products.id, ids)).orderBy(asc(products.id)).for('update')
  if (rows.length !== ids.length) throw new DataError(404, 'Product not found.')
  return new Map(rows.map((r) => [r.id, r]))
}

async function registeredBarcodes(c: Ctx, productIds: string[]): Promise<Map<string, string[]>> {
  const rows = await c.db
    .select({ product_id: productBarcodes.product_id, barcode: productBarcodes.barcode })
    .from(productBarcodes)
    .where(inArray(productBarcodes.product_id, productIds))
    .orderBy(asc(productBarcodes.position))
  const map = new Map<string, string[]>()
  for (const r of rows) map.set(r.product_id, [...(map.get(r.product_id) ?? []), r.barcode])
  return map
}

/** `quantity` units over `codes` (the first ones take the remainder), at least one unit per barcode used. */
function spread(codes: string[], quantity: number): { barcode: string; quantity: number }[] {
  const n = Math.min(codes.length, quantity)
  const base = Math.floor(quantity / n)
  const extra = quantity - base * n
  return codes.slice(0, n).map((barcode, i) => ({ barcode, quantity: base + (i < extra ? 1 : 0) }))
}

/** One transaction_lines row to write (one per product and barcode). */
interface LineSpec {
  productId: string
  productName: string
  barcode: string | null
  issuedBarcode: string | null
  quantity: number
  unitCost: number
}

function notRegistered(code: string, productName: string): DataError {
  return new DataError(400, `Barcode "${code}" is not registered to ${productName}.`)
}

/** Lines for a Stock In / Stock Out: the barcodes given (each registered to the product) or the product's own. */
function scanLines(item: CleanItem, product: ProductRow, registered: string[]): LineSpec[] {
  const base = { productId: product.id, productName: product.name, issuedBarcode: null, unitCost: item.unitCost }
  if (item.barcodes) {
    for (const code of item.barcodes) if (!registered.includes(code)) throw notRegistered(code, product.name)
    return spread(item.barcodes, item.quantity).map((s) => ({ ...base, barcode: s.barcode, quantity: s.quantity }))
  }
  if (registered.length === 0) return [{ ...base, barcode: null, quantity: item.quantity }]
  return spread(registered, item.quantity).map((s) => ({ ...base, barcode: s.barcode, quantity: s.quantity }))
}

/** Net change per product, in the order products first appear. */
function deltasOf(lines: LineSpec[], direction: 1 | -1): Map<string, number> {
  const deltas = new Map<string, number>()
  for (const l of lines) deltas.set(l.productId, (deltas.get(l.productId) ?? 0) + direction * l.quantity)
  return deltas
}

/** The frozen `after.lines` shape: one entry per product with every distinct barcode and units per barcode. */
function auditLines(lines: LineSpec[], opts: { relabelled?: boolean } = {}) {
  const groups = new Map<
    string,
    {
      product_id: string
      product_name: string
      quantity: number
      barcodes: string[]
      barcode_quantities: { barcode: string; quantity: number }[]
      relabelled: { from: string; to: string; quantity: number }[]
    }
  >()
  for (const l of lines) {
    const g = groups.get(l.productId) ?? {
      product_id: l.productId,
      product_name: l.productName,
      quantity: 0,
      barcodes: [],
      barcode_quantities: [],
      relabelled: [],
    }
    groups.set(l.productId, g)
    g.quantity += l.quantity
    if (l.barcode) {
      if (!g.barcodes.includes(l.barcode)) g.barcodes.push(l.barcode)
      const bq = g.barcode_quantities.find((b) => b.barcode === l.barcode)
      if (bq) bq.quantity += l.quantity
      else g.barcode_quantities.push({ barcode: l.barcode, quantity: l.quantity })
      if (l.issuedBarcode) g.relabelled.push({ from: l.issuedBarcode, to: l.barcode, quantity: l.quantity })
    }
  }
  return [...groups.values()].map(({ relabelled, ...g }) =>
    // Only present when a unit lost its barcode: from = the one it was issued under, to = the replacement now on it.
    opts.relabelled && relabelled.length > 0 ? { ...g, relabelled } : g,
  )
}

interface MovementArgs {
  type: TxnType
  /** The columns of the transaction row beyond id, type, reference, operator, notes and created_at. */
  columns: Partial<typeof transactions.$inferInsert>
  /** The audit `after` payload up to (not including) line_count / total_qty / lines. */
  header: (base: { id: string; reference_no: string; created_at: string }) => Record<string, unknown>
  notes: string | null
  lines: LineSpec[]
  /** Net quantity change per product (already checked against the locked rows). */
  deltas: Map<string, number>
  relabelled?: boolean
}

/** Insert the transaction, its lines and the quantity changes, then the `create` audit entry. */
async function writeMovement(c: Ctx, m: MovementArgs): Promise<StockMovementResult> {
  const id = newId()
  const reference_no = genRef()
  const now = c.now()
  await c.db.insert(transactions).values({
    ...m.columns,
    id,
    transaction_type: m.type,
    reference_no,
    user_id: c.caller.uid,
    operator_name: c.caller.name,
    notes: m.notes,
    created_at: now,
  })
  await c.db.insert(transactionLines).values(
    m.lines.map((l, i) => ({
      id: newId(),
      transaction_id: id,
      product_id: l.productId,
      product_name: l.productName,
      barcode: l.barcode,
      issued_barcode: l.issuedBarcode,
      quantity: l.quantity,
      unit_cost: l.unitCost,
      // A millisecond apart, in the order the lines were scanned, so "issue order" (the first barcode issued, the
      // first unit still out) is well defined when lines are read back ordered by created_at.
      created_at: new Date(now.getTime() + i),
    })),
  )
  for (const [productId, delta] of m.deltas) {
    await c.db
      .update(products)
      .set({ quantity_on_hand: sql`${products.quantity_on_hand} + ${delta}`, updated_at: now })
      .where(eq(products.id, productId))
  }
  await writeAudit(c, {
    action: 'create',
    entityType: 'transaction',
    entityId: id,
    before: null,
    after: {
      ...m.header({ id, reference_no, created_at: now.toISOString() }),
      line_count: new Set(m.lines.map((l) => l.productId)).size,
      total_qty: m.lines.reduce((s, l) => s + l.quantity, 0),
      lines: auditLines(m.lines, { relabelled: m.relabelled }),
    },
  })
  return { id, reference_no }
}

/** Refuse when any locked product would go below zero (the check works on the locked rows, so it can't race). */
function assertEnoughStock(rows: Map<string, ProductRow>, deltas: Map<string, number>): void {
  for (const [productId, delta] of deltas) {
    const row = rows.get(productId) as ProductRow
    if (row.quantity_on_hand + delta < 0) throw new DataError(409, `Not enough stock for ${row.name}.`)
  }
}

// --- Stock In / Adjust --------------------------------------------------------

/** Receive stock: adds each product's quantity and writes an IN transaction. */
export async function recordStockIn(ctx: Ctx, input: StockInInput): Promise<StockMovementResult> {
  assertAdmin(ctx)
  const items = cleanItems(input?.items)
  const notes = textOrNull(input?.notes)
  return inTx(ctx, async (c) => {
    const rows = await lockProducts(c, items)
    const registered = await registeredBarcodes(c, [...rows.keys()])
    const lines = items.flatMap((i) => scanLines(i, rows.get(i.productId) as ProductRow, registered.get(i.productId) ?? []))
    return writeMovement(c, {
      type: 'IN',
      columns: { linked_request_id: null, linked_request_ref: null },
      header: ({ reference_no, created_at }) => ({
        transaction_type: 'IN',
        reference_no,
        user_id: c.caller.uid,
        operator_name: c.caller.name,
        // Stock arriving on the shelf is never against a loan request; written explicitly so the field always exists.
        linked_request_id: null,
        linked_request_ref: null,
        notes,
        created_at,
      }),
      notes,
      lines,
      deltas: deltasOf(lines, 1),
    })
  })
}

/** A manual count correction: adds (direction 1) or removes (-1) the quantities. Lines carry no barcode. */
export async function recordAdjust(ctx: Ctx, input: AdjustInput): Promise<StockMovementResult> {
  assertAdmin(ctx)
  const direction = input?.direction
  if (direction !== 1 && direction !== -1) throw new DataError(400, 'Direction must be 1 or -1.')
  const items = cleanItems(input?.items)
  const notes = textOrNull(input?.notes)
  return inTx(ctx, async (c) => {
    const rows = await lockProducts(c, items)
    const lines: LineSpec[] = items.map((i) => ({
      productId: i.productId,
      productName: (rows.get(i.productId) as ProductRow).name,
      barcode: null,
      issuedBarcode: null,
      quantity: i.quantity,
      unitCost: 0,
    }))
    const deltas = deltasOf(lines, direction)
    assertEnoughStock(rows, deltas)
    return writeMovement(c, {
      type: 'ADJUST',
      columns: { linked_request_id: null, linked_request_ref: null },
      header: ({ reference_no, created_at }) => ({
        transaction_type: 'ADJUST',
        reference_no,
        user_id: c.caller.uid,
        operator_name: c.caller.name,
        linked_request_id: null,
        linked_request_ref: null,
        notes,
        // The lines are always positive; this is what says which way the stock moved.
        direction,
        created_at,
      }),
      notes,
      lines,
      deltas,
    })
  })
}

// --- Stock Out ----------------------------------------------------------------

type RequestRow = typeof loanRequests.$inferSelect

/**
 * The full loan-request snapshot every request transition writes into the audit log (same fields as the old
 * requestAuditSnapshot): the request as it stands, its lines, and `overrides` for what this transition changes.
 */
async function requestSnapshot(c: Ctx, req: RequestRow, overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const lines = await c.db
    .select({
      product_id: loanRequestLines.product_id,
      product_name: loanRequestLines.product_name,
      requested_quantity: loanRequestLines.requested_quantity,
      offered_quantity: loanRequestLines.offered_quantity,
    })
    .from(loanRequestLines)
    .where(eq(loanRequestLines.request_id, req.id))
    .orderBy(asc(loanRequestLines.created_at), asc(loanRequestLines.id))
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
    lines,
    line_count: lines.length,
    // The agreed quantity: what would actually be handed over.
    total_qty: lines.reduce((sum, l) => sum + l.offered_quantity, 0),
    ...overrides,
  }
}

/**
 * Issue stock to a staff member: lowers each product's quantity and writes an OUT transaction. 409 "Not enough stock for
 * <product>." when any product would go below zero. With `linkedRequestId` the (accepted, not yet fulfilled) loan request
 * is marked fulfilled and its `update` audit entry written in the same transaction.
 */
export async function recordStockOut(ctx: Ctx, input: StockOutInput): Promise<StockMovementResult> {
  assertAdmin(ctx)
  const items = cleanItems(input?.items)
  const staffId = typeof input?.staffId === 'string' ? input.staffId : ''
  if (!staffId) throw new DataError(400, 'Choose a staff member.')
  const lendFrom = dateOrNull(input.lendFrom, 'From date')
  const lendTo = dateOrNull(input.lendTo, 'Return (To) date')
  if (lendFrom && lendTo && lendTo < lendFrom) throw new DataError(400, "Return (To) date can't be before the From date.")
  const notes = textOrNull(input.notes)
  const manualOverride = input.manualOverride === true
  const linkedRequestId = input.linkedRequestId || null

  return inTx(ctx, async (c) => {
    const [holder] = await c.db.select().from(staff).where(eq(staff.id, staffId)).limit(1)
    if (!holder) throw new DataError(404, NOT_FOUND_STAFF)

    const rows = await lockProducts(c, items)
    const registered = await registeredBarcodes(c, [...rows.keys()])
    const lines = items.flatMap((i) => scanLines(i, rows.get(i.productId) as ProductRow, registered.get(i.productId) ?? []))
    const deltas = deltasOf(lines, -1)
    assertEnoughStock(rows, deltas)

    let request: RequestRow | null = null
    if (linkedRequestId) {
      const [found] = await c.db.select().from(loanRequests).where(eq(loanRequests.id, linkedRequestId)).for('update')
      request = found ?? null
      if (!request) throw new DataError(404, 'Loan request not found.')
      if (request.staff_id !== staffId) throw new DataError(400, 'This loan request belongs to a different staff member.')
      if (request.status !== 'accepted' || request.fulfilled_txn_id !== null) {
        throw new DataError(409, 'This loan request can no longer be fulfilled.')
      }
    }
    const linkedRequestRef = request?.reference_no ?? null

    const result = await writeMovement(c, {
      type: 'OUT',
      columns: {
        staff_id: staffId,
        staff_name: holder.full_name,
        manual_override: manualOverride,
        lend_from: lendFrom,
        lend_to: lendTo,
        linked_request_id: linkedRequestId,
        linked_request_ref: linkedRequestRef,
      },
      header: ({ reference_no, created_at }) => ({
        transaction_type: 'OUT',
        reference_no,
        staff_id: staffId,
        staff_name: holder.full_name,
        user_id: c.caller.uid,
        operator_name: c.caller.name,
        manual_override: manualOverride,
        notes,
        lend_from: lendFrom,
        lend_to: lendTo,
        linked_request_id: linkedRequestId,
        linked_request_ref: linkedRequestRef,
        created_at,
      }),
      notes,
      lines,
      deltas,
    })

    if (request) {
      const before = await requestSnapshot(c, request)
      await c.db
        .update(loanRequests)
        .set({ status: 'fulfilled', fulfilled_txn_id: result.id, updated_at: c.now() })
        .where(eq(loanRequests.id, request.id))
      await writeAudit(c, {
        action: 'update',
        entityType: 'loan_request',
        entityId: request.id,
        before,
        // The transaction's own reference too: fulfilled_txn_id is not something anyone can look up by eye.
        after: await requestSnapshot(c, request, {
          status: 'fulfilled',
          fulfilled_txn_id: result.id,
          fulfilled_txn_ref: result.reference_no,
        }),
      })
    }
    return result
  })
}

// --- Returns ------------------------------------------------------------------

/**
 * Take units back against one OUT transaction. Only barcodes that were issued on it are accepted, never more than is
 * still out under each (waivers are ignored: a written-off item can still turn up and be returned). A unit that lost
 * its label is returned with `issuedBarcode` (the one it left with) and `barcodes: [replacement]`. Items without
 * barcodes take the first units still out, in issue order. The OUT row is locked first, so two returns of the last unit
 * can't both succeed.
 */
export async function recordReturn(ctx: Ctx, input: ReturnInput): Promise<StockMovementResult> {
  assertAdmin(ctx)
  const items = cleanItems(input?.items)
  const staffId = typeof input?.staffId === 'string' ? input.staffId : ''
  const linkedTxnId = typeof input?.linkedTxnId === 'string' ? input.linkedTxnId : ''
  if (!staffId) throw new DataError(400, 'Choose a staff member.')
  const returnDate = dateOrNull(input.returnDate, 'Return date')
  const notes = textOrNull(input.notes)
  const manualOverride = input.manualOverride === true

  return inTx(ctx, async (c) => {
    const [found] = await c.db.select().from(transactions).where(eq(transactions.id, linkedTxnId)).for('update')
    const out = found ?? null
    if (!out || out.transaction_type !== 'OUT') throw new DataError(404, 'Stock Out not found.')
    if (out.staff_id !== staffId) throw new DataError(400, 'That Stock Out was not issued to this staff member.')
    const [holder] = await c.db.select().from(staff).where(eq(staff.id, staffId)).limit(1)
    if (!holder) throw new DataError(404, NOT_FOUND_STAFF)

    const rows = await lockProducts(c, items)
    const registered = await registeredBarcodes(c, [...rows.keys()])
    const productIds = [...rows.keys()]

    // Where each product stands on this OUT, counted after the lock so earlier returns are all visible.
    const outLines = await c.db
      .select()
      .from(transactionLines)
      .where(and(eq(transactionLines.transaction_id, out.id), inArray(transactionLines.product_id, productIds)))
      .orderBy(asc(transactionLines.created_at), asc(transactionLines.id))
    const returnLines = await c.db
      .select({
        product_id: transactionLines.product_id,
        barcode: transactionLines.barcode,
        issued_barcode: transactionLines.issued_barcode,
        quantity: transactionLines.quantity,
      })
      .from(transactionLines)
      .innerJoin(transactions, eq(transactions.id, transactionLines.transaction_id))
      .where(
        and(
          eq(transactions.transaction_type, 'RETURN'),
          eq(transactions.linked_txn_id, out.id),
          inArray(transactionLines.product_id, productIds),
        ),
      )
    const open = new Map<string, Map<string, number>>() // product -> barcode -> units still out
    for (const productId of productIds) {
      const balance = productBalance(
        outLines.filter((l) => l.product_id === productId),
        returnLines.filter((l) => l.product_id === productId),
      )
      open.set(productId, new Map(balance.barcodes.map((b) => [b.barcode, b.open])))
    }

    const lines: LineSpec[] = []
    for (const item of items) {
      const product = rows.get(item.productId) as ProductRow
      const remaining = open.get(item.productId) as Map<string, number>
      if (remaining.size === 0) throw new DataError(400, `${product.name} was not issued on this Stock Out.`)

      // What this item turns into: [barcode scanned back, barcode it left with, units].
      let entries: { scanned: string; issued: string; quantity: number }[]
      if (item.issuedBarcode) {
        if (!item.barcodes || item.barcodes.length !== 1) throw new DataError(400, 'Give the one replacement barcode for a unit that lost its label.')
        const replacement = item.barcodes[0]
        if (!(registered.get(item.productId) ?? []).includes(replacement)) {
          throw new DataError(400, `Barcode "${replacement}" is no longer registered to ${product.name}. Remove that unit and enter a registered barcode.`)
        }
        entries = [{ scanned: replacement, issued: item.issuedBarcode, quantity: item.quantity }]
      } else if (item.barcodes) {
        entries = spread(item.barcodes, item.quantity).map((s) => ({ scanned: s.barcode, issued: s.barcode, quantity: s.quantity }))
      } else {
        entries = []
        let need = item.quantity
        for (const [barcode, units] of remaining) {
          const take = Math.min(need, units)
          if (take > 0) entries.push({ scanned: barcode, issued: barcode, quantity: take })
          need -= take
          if (need === 0) break
        }
        if (need > 0) throw new DataError(400, `Returning ${item.quantity} of ${product.name} is more than is still out.`)
      }

      for (const e of entries) {
        const left = remaining.get(e.issued)
        if (left === undefined) throw new DataError(400, `Barcode "${e.issued}" was not issued on this Stock Out.`)
        if (e.quantity > left) throw new DataError(400, `Returning ${e.quantity} of "${e.issued}" is more than is still out.`)
        remaining.set(e.issued, left - e.quantity)
        lines.push({
          productId: item.productId,
          productName: product.name,
          barcode: e.scanned,
          issuedBarcode: e.issued === e.scanned ? null : e.issued,
          quantity: e.quantity,
          unitCost: 0,
        })
      }
    }

    return writeMovement(c, {
      type: 'RETURN',
      columns: {
        staff_id: staffId,
        staff_name: holder.full_name,
        linked_txn_id: out.id,
        // Inherited from the Stock Out being returned against, so a return reaches its loan request directly.
        linked_request_id: out.linked_request_id,
        linked_request_ref: out.linked_request_ref,
        manual_override: manualOverride,
        return_date: returnDate,
      },
      header: ({ reference_no, created_at }) => ({
        transaction_type: 'RETURN',
        reference_no,
        staff_id: staffId,
        staff_name: holder.full_name,
        user_id: c.caller.uid,
        operator_name: c.caller.name,
        linked_txn_id: out.id,
        linked_request_id: out.linked_request_id,
        linked_request_ref: out.linked_request_ref,
        manual_override: manualOverride,
        notes,
        ...(returnDate ? { return_date: returnDate } : {}),
        created_at,
      }),
      notes,
      lines,
      deltas: deltasOf(lines, 1),
      relabelled: true,
    })
  })
}

// --- Waivers ------------------------------------------------------------------

/**
 * Record that an item a staff member holds does not need to come back. Stock levels are not changed: the item left the
 * shelf when it was issued. Logged as `resolve` against the originating transaction. The OUT row is locked before the
 * outstanding quantity (issued - returned - already written off) is worked out, so concurrent waivers or returns for
 * the last unit can't both succeed. 409 when nothing (or less than `quantity`) is outstanding. `staffId`, when given,
 * must be the transaction's staff member (the Staff page's Resolve passes it).
 */
export async function createReturnWaiver(ctx: Ctx, input: CreateReturnWaiverInput): Promise<string> {
  assertAdmin(ctx)
  const quantity = Number(input?.quantity)
  if (!Number.isInteger(quantity) || quantity <= 0) throw new DataError(400, 'Quantity must be a whole number above zero.')
  const transactionId = String(input?.transactionId ?? '')
  const productId = String(input?.productId ?? '')
  const reason = typeof input?.reason === 'string' && input.reason.trim() ? input.reason.trim() : null
  const staffId = input?.staffId === undefined ? null : String(input.staffId)

  return inTx(ctx, async (c) => {
    let holderName: string | null = null
    if (staffId !== null) {
      const [holder] = await c.db.select({ full_name: staff.full_name }).from(staff).where(eq(staff.id, staffId)).limit(1)
      if (!holder) throw new DataError(404, NOT_FOUND_STAFF)
      holderName = holder.full_name
    }
    const [found] = await c.db.select().from(transactions).where(eq(transactions.id, transactionId)).for('update')
    const out = found ?? null
    if (!out || out.transaction_type !== 'OUT' || (staffId !== null && out.staff_id !== staffId)) {
      throw new DataError(409, NOTHING_TO_RESOLVE)
    }

    const issued = await c.db
      .select({
        name: sql<string>`(array_agg(${transactionLines.product_name} order by ${transactionLines.created_at}, ${transactionLines.id}))[1]`,
        total: sql<number>`sum(${transactionLines.quantity})::int`,
      })
      .from(transactionLines)
      .where(and(eq(transactionLines.transaction_id, out.id), eq(transactionLines.product_id, productId)))
    const [returned] = await c.db
      .select({ total: sql<number>`coalesce(sum(${transactionLines.quantity}), 0)::int` })
      .from(transactionLines)
      .innerJoin(transactions, eq(transactions.id, transactionLines.transaction_id))
      .where(
        and(
          eq(transactions.transaction_type, 'RETURN'),
          eq(transactions.linked_txn_id, out.id),
          eq(transactionLines.product_id, productId),
        ),
      )
    const [waived] = await c.db
      .select({ total: sql<number>`coalesce(sum(${returnWaivers.quantity}), 0)::int` })
      .from(returnWaivers)
      .where(and(eq(returnWaivers.transaction_id, out.id), eq(returnWaivers.product_id, productId)))
    const issuedQty = issued[0]?.total ?? 0
    if (issuedQty - returned.total - waived.total < quantity) throw new DataError(409, NOTHING_TO_RESOLVE)

    if (holderName === null && out.staff_id) {
      const [holder] = await c.db.select({ full_name: staff.full_name }).from(staff).where(eq(staff.id, out.staff_id)).limit(1)
      holderName = holder?.full_name ?? null
    }
    const id = newId()
    const now = c.now()
    const payload = {
      transaction_id: out.id,
      product_id: productId,
      product_name: issued[0].name ?? 'Unknown',
      staff_id: out.staff_id,
      staff_name: out.staff_name ?? holderName,
      quantity,
      reason,
      created_at: now.toISOString(),
      resolved_by_uid: c.caller.uid,
      resolved_by_name: c.caller.name,
    }
    await c.db.insert(returnWaivers).values({ ...payload, id, created_at: now })
    await writeAudit(c, { action: 'resolve', entityType: 'transaction', entityId: out.id, before: null, after: payload })
    return id
  })
}

/** Written-off quantity per [OUT transaction id][product id]. */
export async function loadWaivedByTxn(ctx: Ctx): Promise<WaivedByTxn> {
  assertAdmin(ctx)
  const rows = await ctx.db
    .select({
      transaction_id: returnWaivers.transaction_id,
      product_id: returnWaivers.product_id,
      total: sql<number>`sum(${returnWaivers.quantity})::int`,
    })
    .from(returnWaivers)
    .groupBy(returnWaivers.transaction_id, returnWaivers.product_id)
  const map: WaivedByTxn = {}
  for (const r of rows) (map[r.transaction_id] ??= {})[r.product_id] = r.total
  return map
}

// `ReturnWaiver.staff_id` is typed `number` in src/types/database.ts but ids are strings (the same cast the Firestore
// code made); the server side says so honestly, and the browser client hands pages the `ReturnWaiver` type.
export type ReturnWaiverOut = Omit<ReturnWaiver, 'staff_id'> & { staff_id: string | null }

/** Every waiver, oldest first (the Staff page's expanded rows show who kept what). */
export async function loadWaivers(ctx: Ctx): Promise<ReturnWaiverOut[]> {
  assertAdmin(ctx)
  const rows = await ctx.db.select().from(returnWaivers).orderBy(asc(returnWaivers.created_at), asc(returnWaivers.id))
  return rows.map((r) => ({
    id: r.id,
    transaction_id: r.transaction_id,
    product_id: r.product_id,
    product_name: r.product_name,
    staff_id: r.staff_id,
    staff_name: r.staff_name,
    quantity: r.quantity,
    reason: r.reason,
    created_at: toIso(r.created_at) as string,
    resolved_by_uid: r.resolved_by_uid,
    resolved_by_name: r.resolved_by_name,
  }))
}

// --- What a staff member still has out (Returns page) -------------------------

/**
 * Per Stock Out, product and barcode: what is still to come back, oldest Stock Out first. Waivers are not subtracted
 * (a written-off item can still turn up and must stay returnable). Units issued without a barcode (legacy Stock Outs)
 * can't be matched against a scan, so they are listed apart as `unscannable`.
 */
export async function listOutstandingForStaff(ctx: Ctx, staffId: string): Promise<OutstandingForStaff> {
  assertAdmin(ctx)
  const outs = await ctx.db
    .select()
    .from(transactions)
    .where(and(eq(transactions.staff_id, staffId), eq(transactions.transaction_type, 'OUT')))
    .orderBy(asc(transactions.created_at), asc(transactions.id))
  if (outs.length === 0) return { lines: [], unscannable: [] }
  const outIds = outs.map((t) => t.id)

  const outLines = await ctx.db
    .select()
    .from(transactionLines)
    .where(inArray(transactionLines.transaction_id, outIds))
    .orderBy(asc(transactionLines.created_at), asc(transactionLines.id))
  const returnLines = await ctx.db
    .select({
      out_id: sql<string>`${transactions.linked_txn_id}`,
      product_id: transactionLines.product_id,
      barcode: transactionLines.barcode,
      issued_barcode: transactionLines.issued_barcode,
      quantity: transactionLines.quantity,
    })
    .from(transactionLines)
    .innerJoin(transactions, eq(transactions.id, transactionLines.transaction_id))
    .where(and(eq(transactions.transaction_type, 'RETURN'), inArray(transactions.linked_txn_id, outIds)))

  const lines: OutstandingLine[] = []
  const unscannable: UnscannableLine[] = []
  for (const out of outs) {
    // This transaction's lines collapsed to product -> its lines, in first-seen order.
    const byProduct = new Map<string, typeof outLines>()
    for (const l of outLines) {
      if (l.transaction_id !== out.id) continue
      byProduct.set(l.product_id, [...(byProduct.get(l.product_id) ?? []), l])
    }
    for (const [productId, productLines] of byProduct) {
      const name = productLines[0].product_name ?? 'Unknown'
      const balance = productBalance(
        productLines,
        returnLines.filter((r) => r.out_id === out.id && r.product_id === productId),
      )
      if (balance.legacyOpen > 0) unscannable.push({ txn_ref: out.reference_no, product_name: name, quantity: balance.legacyOpen })
      for (const b of balance.barcodes) {
        if (b.open <= 0) continue
        lines.push({
          txn_id: out.id,
          txn_ref: out.reference_no,
          txn_date: toIso(out.created_at) as string,
          line_id: `${out.id}|${productId}|${b.barcode}`,
          product_id: productId,
          product_name: name,
          barcode: b.barcode,
          issued_qty: b.issued,
          already_returned: b.returned,
          returnable: b.open,
          expected_date: out.lend_to ?? null,
          linked_request_id: out.linked_request_id,
          linked_request_ref: out.linked_request_ref,
        })
      }
    }
  }
  return { lines, unscannable }
}

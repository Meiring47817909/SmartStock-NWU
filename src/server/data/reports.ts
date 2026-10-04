import 'server-only'
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { assertAdmin, DataError, type Ctx } from '@/server/context'
import { toIso } from '@/server/db/client'
import { products, staff, transactionLines, transactions } from '@/server/db/schema'
import { listOutstandingTxnProducts } from '@/server/data/outstandingStock'
import { appDayBetween, parseDay } from '@/server/data/dayRange'
import { collapseLinesByProduct, openBarcodeQuantities } from '@/lib/transactionLines'
import {
  REPORT_KINDS,
  type IssuedPerStaffReport,
  type IssuedStaffRow,
  type IssuedTxn,
  type LowStockReportRow,
  type OutstandingReturnLine,
  type ReportKind,
  type ReportLine,
  type ReportParams,
  type ReportResults,
  type ReturnRow,
  type ReturnsReport,
  type StockLevelRow,
} from '@/lib/reportRules'

// The Reports page's four tabs, computed here instead of in the browser (admin only). Each returns the rows the tab
// renders; sorting by column, searching, the category and status pickers and paging stay in the browser, so they answer
// instantly and the CSV/PDF exports keep building from the rows on screen.
//
// Calendar-day filters (Issued per Staff "Issued from") read a timestamp as its Johannesburg day (dayRange.ts); the
// `date` columns (lend_to) compare as plain YYYY-MM-DD strings. Quantities still owed are the one shared rule in
// outstandingStock.ts (issued - returned - written off); the page's own grouping of a product's several barcode lines
// is collapseLinesByProduct.

type Reader = Ctx['db']

const CHUNK = 5000

/** `inArray` over a long id list, a chunk at a time (Postgres allows about 65 000 parameters per statement). */
async function inChunks<T>(ids: string[], read: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = []
  for (let i = 0; i < ids.length; i += CHUNK) out.push(...(await read(ids.slice(i, i + CHUNK))))
  return out
}

type LineRow = { transaction_id: string } & ReportLine

/** The lines of the given transactions, grouped by transaction, each in scan order (line_no, id). */
async function linesOf(db: Reader, txnIds: string[]): Promise<Map<string, ReportLine[]>> {
  const rows = await inChunks<LineRow>(txnIds, (chunk) =>
    db
      .select({
        transaction_id: transactionLines.transaction_id,
        id: transactionLines.id,
        product_id: transactionLines.product_id,
        product_name: transactionLines.product_name,
        barcode: transactionLines.barcode,
        issued_barcode: transactionLines.issued_barcode,
        quantity: transactionLines.quantity,
      })
      .from(transactionLines)
      .where(inArray(transactionLines.transaction_id, chunk))
      .orderBy(asc(transactionLines.transaction_id), asc(transactionLines.line_no), asc(transactionLines.id)),
  )
  const byTxn = new Map<string, ReportLine[]>()
  for (const { transaction_id, ...line } of rows) {
    const list = byTxn.get(transaction_id)
    if (list) list.push(line)
    else byTxn.set(transaction_id, [line])
  }
  return byTxn
}

// --- Current Stock Levels ------------------------------------------------------

async function stockLevels(ctx: Ctx): Promise<StockLevelRow[]> {
  const rows = await ctx.db
    .select({
      id: products.id,
      name: products.name,
      category_id: products.category_id,
      category_name: products.category_name,
      quantity_on_hand: products.quantity_on_hand,
      reorder_threshold: products.reorder_threshold,
    })
    .from(products)
  return rows
    .map((p): StockLevelRow => ({
      id: p.id,
      name: p.name,
      category_id: p.category_id,
      category_name: p.category_name,
      qty: p.quantity_on_hand,
      threshold: p.reorder_threshold,
      status: p.quantity_on_hand === 0 ? 'OUT OF STOCK' : p.quantity_on_hand <= p.reorder_threshold ? 'LOW STOCK' : 'IN STOCK',
    }))
    // By name the way the page always sorted (localeCompare), whatever collation the database was created with.
    .sort((a, b) => a.name.localeCompare(b.name, 'en') || a.id.localeCompare(b.id))
}

// --- Low Stock Items -----------------------------------------------------------

async function lowStock(ctx: Ctx): Promise<LowStockReportRow[]> {
  return ctx.db
    .select({
      id: products.id,
      name: products.name,
      category_id: products.category_id,
      category_name: products.category_name,
      quantity_on_hand: products.quantity_on_hand,
      reorder_threshold: products.reorder_threshold,
    })
    .from(products)
    .where(sql`${products.quantity_on_hand} <= ${products.reorder_threshold}`)
    .orderBy(asc(products.quantity_on_hand), asc(products.id))
}

// --- Issued per Staff ----------------------------------------------------------

/**
 * Every active staff member with their Stock Outs. "Issued from" opens the window on the day the Stock Out was recorded;
 * "Expected back by" closes it on the Stock Out's Lend To, and a Stock Out with no Lend To passes it only when
 * `includeUndated`. With either end set, a staff member with nothing in range is left out; unfiltered, every active staff
 * member is listed, zeroes included.
 */
async function issuedPerStaff(ctx: Ctx, from: string | undefined, to: string | undefined, includeUndated: boolean): Promise<IssuedPerStaffReport> {
  const found = await ctx.db
    .select({ id: staff.id, name: staff.name, surname: staff.surname, full_name: staff.full_name, department: staff.department })
    .from(staff)
    .where(eq(staff.is_active, true))
    .orderBy(asc(staff.id))
  // By name the way Stock Levels is, whatever collation the database was created with.
  const people = found.sort((a, b) => a.full_name.localeCompare(b.full_name, 'en') || a.id.localeCompare(b.id))

  const outs = await ctx.db
    .select({
      id: transactions.id,
      staff_id: transactions.staff_id,
      reference_no: transactions.reference_no,
      created_at: transactions.created_at,
      lend_from: transactions.lend_from,
      lend_to: transactions.lend_to,
    })
    .from(transactions)
    .innerJoin(staff, and(eq(staff.id, transactions.staff_id), eq(staff.is_active, true)))
    .where(and(eq(transactions.transaction_type, 'OUT'), appDayBetween(transactions.created_at, from, undefined)))
    .orderBy(desc(transactions.created_at), desc(transactions.id))

  // The undated count is taken before "Expected back by" is applied: it is the size of the decision that end offers.
  const undatedCount = outs.filter((t) => !t.lend_to).length
  const kept = outs.filter((t) => !to || (t.lend_to ? t.lend_to <= to : includeUndated))
  const lines = await linesOf(ctx.db, kept.map((t) => t.id))

  const byStaff = new Map<string, IssuedTxn[]>()
  for (const t of kept) {
    const txn: IssuedTxn = {
      id: t.id,
      reference_no: t.reference_no,
      created_at: toIso(t.created_at) as string,
      lend_from: t.lend_from,
      lend_to: t.lend_to,
      transaction_lines: lines.get(t.id) ?? [],
    }
    const list = byStaff.get(t.staff_id as string)
    if (list) list.push(txn)
    else byStaff.set(t.staff_id as string, [txn])
  }

  const rows: IssuedStaffRow[] = people.map((p) => {
    const txns = byStaff.get(p.id) ?? []
    const totalQty = txns.reduce((sum, t) => sum + t.transaction_lines.reduce((s, l) => s + l.quantity, 0), 0)
    return { ...p, txns, totalQty }
  })
  return { staff: rows.filter((s) => (!from && !to) || s.txns.length > 0), undatedCount }
}

// --- Returns -------------------------------------------------------------------

/**
 * Every RETURN, newest first, with the Stock Out it settles (reference and Lend To) and what is still owed on that Stock
 * Out. The balance is live across every return and write-off on record, so a Partial row stays true even when the return
 * that settled the rest of it is outside the date window. The date window bounds each return's expected date (the Lend
 * To of its Stock Out): a plain YYYY-MM-DD compare; a return with no expected date passes only when `includeUndated`.
 */
async function returns(ctx: Ctx, from: string | undefined, to: string | undefined, includeUndated: boolean): Promise<ReturnsReport> {
  const rets = await ctx.db
    .select({
      id: transactions.id,
      reference_no: transactions.reference_no,
      staff_id: transactions.staff_id,
      staff_name: transactions.staff_name,
      linked_txn_id: transactions.linked_txn_id,
      created_at: transactions.created_at,
    })
    .from(transactions)
    .where(eq(transactions.transaction_type, 'RETURN'))
    .orderBy(desc(transactions.created_at), desc(transactions.id))

  const returnLines = await linesOf(ctx.db, rets.map((r) => r.id))

  // Every RETURN's lines grouped by the Stock Out they settle.
  const returnLinesByOut = new Map<string, ReportLine[]>()
  for (const r of rets) {
    if (!r.linked_txn_id) continue
    const list = returnLinesByOut.get(r.linked_txn_id)
    const mine = returnLines.get(r.id) ?? []
    if (list) list.push(...mine)
    else returnLinesByOut.set(r.linked_txn_id, [...mine])
  }

  const linkedIds = [...new Set(rets.map((r) => r.linked_txn_id).filter((id): id is string => !!id))]
  const outs = await inChunks(linkedIds, (chunk) =>
    ctx.db
      .select({ id: transactions.id, reference_no: transactions.reference_no, lend_to: transactions.lend_to })
      .from(transactions)
      .where(inArray(transactions.id, chunk)),
  )
  const outById = new Map(outs.map((o) => [o.id, o]))
  const outLines = await linesOf(ctx.db, outs.map((o) => o.id))

  // What is still owed: the shared issued - returned - written off rule, then which barcodes it is still out under.
  const owed = new Map<string, { outstanding: number; waived: number }>()
  for (const o of await listOutstandingTxnProducts(ctx.db)) owed.set(`${o.txnId}|${o.productId}`, { outstanding: o.outstanding, waived: o.waived })

  function outstandingOn(outId: string): OutstandingReturnLine[] {
    const lines = outLines.get(outId) ?? []
    const result: OutstandingReturnLine[] = []
    for (const l of collapseLinesByProduct(lines)) {
      const row = owed.get(`${outId}|${l.product_id}`)
      if (!row) continue
      result.push({
        product_name: l.product_name ?? 'Unknown',
        outstanding: row.outstanding,
        barcodeQuantities: openBarcodeQuantities(
          lines.filter((x) => x.product_id === l.product_id),
          (returnLinesByOut.get(outId) ?? []).filter((x) => x.product_id === l.product_id),
          row.waived,
        ),
      })
    }
    return result
  }

  const all: ReturnRow[] = rets.map((r) => {
    const out = r.linked_txn_id ? outById.get(r.linked_txn_id) : undefined
    const outstandingLines = out ? outstandingOn(out.id) : []
    return {
      id: r.id,
      reference_no: r.reference_no,
      staff_id: r.staff_id,
      staff_name: r.staff_name,
      linked_txn_id: r.linked_txn_id,
      created_at: toIso(r.created_at) as string,
      linked_txn_ref: out?.reference_no ?? null,
      expected_date: out?.lend_to ?? null,
      outstandingLines,
      partial: outstandingLines.length > 0,
      transaction_lines: returnLines.get(r.id) ?? [],
    }
  })

  const undatedCount = all.filter((r) => !r.expected_date).length
  const inRange = (r: ReturnRow) => {
    if (!from && !to) return true
    if (!r.expected_date) return includeUndated
    if (from && r.expected_date < from) return false
    if (to && r.expected_date > to) return false
    return true
  }
  return { returns: all.filter(inRange), undatedCount }
}

// --- Entry point ---------------------------------------------------------------

export async function loadReport<K extends ReportKind>(ctx: Ctx, opts: { report: K } & ReportParams): Promise<ReportResults[K]>
export async function loadReport(ctx: Ctx, opts: { report: string } & ReportParams): Promise<ReportResults[ReportKind]> {
  assertAdmin(ctx)
  const report = opts.report as ReportKind
  if (!REPORT_KINDS.includes(report)) throw new DataError(400, 'Unknown report.')
  const from = parseDay(opts.from, 'From')
  const to = parseDay(opts.to, 'To')
  const includeUndated = opts.includeUndated !== false
  switch (report) {
    case 'stock-levels':
      return stockLevels(ctx)
    case 'low-stock':
      return lowStock(ctx)
    case 'issued-per-staff':
      return issuedPerStaff(ctx, from, to, includeUndated)
    case 'returns':
      return returns(ctx, from, to, includeUndated)
  }
}

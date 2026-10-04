import 'server-only'
import { asc, count, eq, gte, inArray, sql } from 'drizzle-orm'
import { assertAdmin, type Ctx } from '@/server/context'
import { loanRequestLines, products, staff, transactions } from '@/server/db/schema'
import { getReservedQuantity, listAcceptedPickups } from '@/server/data/loanRequests'
import { listOutstandingTxnProducts } from '@/server/data/outstandingStock'
import { appDayStart } from '@/server/data/dayRange'
import { appCalendarDay } from '@/lib/utils'
import { effectiveToDate, isNoShowCandidate } from '@/lib/loanRequestRules'
import {
  outstandingStatusOf,
  type DashboardAlertCounts,
  type DashboardData,
  type IncomingPickupRow,
  type LowStockRow,
  type OutstandingReturnRow,
  type PickupLine,
} from '@/lib/dashboardRules'

// The Dashboard's three "needs attention" tabs and the Sidebar badge, computed here instead of in the browser. Every
// badge that depends on "today" (overdue, due today, not picked up) uses the calendar day in APP_TIME_ZONE of ctx.now(),
// never the machine's or the database session's zone: production runs in UTC.
//
// Outstanding quantities are the shared issued - returned - waived rule (outstandingStock.ts). Incoming Pickups starts
// from the loan-request module's lazy no-show pass (listAcceptedPickups), so a request whose pickup window has passed is
// settled before it is shown or counted. Admin only.

const isLowStock = sql`${products.quantity_on_hand} <= ${products.reorder_threshold}`

// --- Outstanding Returns ------------------------------------------------------

async function outstandingReturns(ctx: Ctx, today: string): Promise<OutstandingReturnRow[]> {
  const lines = await listOutstandingTxnProducts(ctx.db)
  return lines.map((l) => ({
    id: `${l.txnId}_${l.productId}`,
    txn_id: l.txnId,
    product_id: l.productId,
    product_name: l.productName || 'Unknown',
    staff_id: l.staffId,
    staff_name: l.staffName ?? '—',
    qty: l.outstanding,
    expected_date: l.lendTo,
    txn_ref: l.referenceNo,
    status: outstandingStatusOf(l.lendTo, today),
  }))
}

/**
 * Overdue returns grouped by product: the likely cause shown when an Incoming Pickup comes up short. Deliberately overdue
 * only, not everything outstanding: a return that isn't due yet is expected to still be out.
 */
function overdueByProduct(rows: OutstandingReturnRow[]): DashboardData['overdueByProduct'] {
  const result: DashboardData['overdueByProduct'] = {}
  for (const o of rows) {
    if (o.status !== 'overdue' || !o.expected_date) continue
    ;(result[o.product_id] ??= []).push({ id: o.id, staff_name: o.staff_name, qty: o.qty, expected_date: o.expected_date, txn_ref: o.txn_ref })
  }
  return result
}

// --- Low Stock Alerts ---------------------------------------------------------

async function lowStockRows(ctx: Ctx): Promise<LowStockRow[]> {
  const rows = await ctx.db
    .select({
      id: products.id,
      name: products.name,
      quantity_on_hand: products.quantity_on_hand,
      reorder_threshold: products.reorder_threshold,
    })
    .from(products)
    .where(isLowStock)
    .orderBy(asc(products.quantity_on_hand), asc(products.name), asc(products.id))
  return rows.map((p) => ({ ...p, status: p.quantity_on_hand === 0 ? 'out_of_stock' : 'low_stock' }))
}

// --- Incoming Pickups ---------------------------------------------------------

async function incomingPickups(ctx: Ctx, today: string): Promise<{ rows: IncomingPickupRow[]; lines: Record<string, PickupLine[]> }> {
  const requests = await listAcceptedPickups(ctx)
  const lines: Record<string, PickupLine[]> = {}
  if (requests.length === 0) return { rows: [], lines }

  const lineRows = await ctx.db
    .select()
    .from(loanRequestLines)
    .where(inArray(loanRequestLines.request_id, requests.map((r) => r.id)))
    .orderBy(asc(loanRequestLines.request_id), asc(loanRequestLines.line_no), asc(loanRequestLines.id))
  const productIds = [...new Set(lineRows.map((l) => l.product_id))]
  const onHandRows = productIds.length
    ? await ctx.db.select({ id: products.id, quantity_on_hand: products.quantity_on_hand }).from(products).where(inArray(products.id, productIds))
    : []
  const onHand = new Map(onHandRows.map((p) => [p.id, p.quantity_on_hand]))

  // Does current stock still cover what each accepted request was promised, once other active requests' holds on the
  // same product and window are netted out? An offer is only ever checked against live stock at approval time, so an
  // overdue return can leave the promise short of what is on the shelf with nothing else noticing. The request's own hold
  // is left out so it isn't counted against itself.
  const rows: IncomingPickupRow[] = []
  for (const r of requests) {
    const own = lineRows.filter((l) => l.request_id === r.id)
    const available = new Map<string, number>()
    for (const pid of new Set(own.map((l) => l.product_id))) {
      const reserved = await getReservedQuantity(ctx, pid, r.from_date, effectiveToDate(r.to_date), r.id)
      available.set(pid, Math.max(0, (onHand.get(pid) ?? 0) - reserved))
    }
    lines[r.id] = own.map((l) => {
      const free = available.get(l.product_id) ?? 0
      return {
        id: l.id,
        product_id: l.product_id,
        product_name: l.product_name || 'Unknown',
        offered_quantity: l.offered_quantity,
        available: free,
        shortBy: Math.max(0, l.offered_quantity - free),
      }
    })
    rows.push({
      id: r.id,
      reference_no: r.reference_no ?? null,
      staff_name: r.staff_name,
      item_count: own.length,
      from_date: r.from_date,
      to_date: r.to_date,
      noShow: isNoShowCandidate(r, today),
      insufficient: lines[r.id].some((l) => l.shortBy > 0),
    })
  }
  return { rows, lines }
}

// --- Public -------------------------------------------------------------------

/** Everything the Dashboard page shows. Admin. */
export async function loadDashboard(ctx: Ctx): Promise<DashboardData> {
  assertAdmin(ctx)
  const now = ctx.now()
  const today = appCalendarDay(now)

  // The no-show pass writes, so it goes first; the reads after it see its result.
  const pickups = await incomingPickups(ctx, today)
  const [outstanding, low, [totals], [txnToday], [activeStaff]] = await Promise.all([
    outstandingReturns(ctx, today),
    lowStockRows(ctx),
    ctx.db
      .select({ products: count(), stock: sql<number>`coalesce(sum(${products.quantity_on_hand}), 0)::int` })
      .from(products),
    // From the start of today's Johannesburg day (the shared APP_TIME_ZONE rule; no fixed UTC offset).
    ctx.db.select({ n: count() }).from(transactions).where(gte(transactions.created_at, appDayStart(today))),
    ctx.db.select({ n: count() }).from(staff).where(eq(staff.is_active, true)),
  ])

  return {
    stats: {
      total_products: totals.products,
      total_stock: totals.stock,
      low_stock: low.length,
      today_transactions: txnToday.n,
      total_staff: activeStaff.n,
    },
    outstandingReturns: outstanding,
    overdueByProduct: overdueByProduct(outstanding),
    incomingPickups: pickups.rows,
    pickupLines: pickups.lines,
    lowStock: low,
  }
}

/**
 * The Sidebar's Dashboard badge: the size of each tab, nothing else. Pending and countered loan requests are not counted
 * (the Loan Requests page has its own badge); only accepted ones, as Incoming Pickups. Admin.
 */
export async function loadDashboardAlertCounts(ctx: Ctx): Promise<DashboardAlertCounts> {
  assertAdmin(ctx)
  const [outstanding, pickups, [low]] = await Promise.all([
    listOutstandingTxnProducts(ctx.db),
    listAcceptedPickups(ctx),
    ctx.db.select({ n: count() }).from(products).where(isLowStock),
  ])
  return {
    outstandingReturns: outstanding.length,
    lowStock: low.n,
    incomingPickups: pickups.length,
    total: outstanding.length + low.n + pickups.length,
  }
}

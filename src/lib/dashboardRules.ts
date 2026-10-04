// Shapes and pure rules shared by the server (src/server/data/dashboard.ts) and the browser client (src/lib/api/dashboard.ts).
// No Firebase, no database.

/** Where an outstanding return stands against its Lend To date, by the calendar day in APP_TIME_ZONE. */
export type OutstandingStatus = 'overdue' | 'due_today' | 'not_due_yet' | 'no_return_date'

/**
 * `today` and `expectedDate` are YYYY-MM-DD strings. An issue with no Lend To is a deliberate "no return date agreed",
 * not missing data.
 */
export function outstandingStatusOf(expectedDate: string | null, today: string): OutstandingStatus {
  if (!expectedDate) return 'no_return_date'
  if (today > expectedDate) return 'overdue'
  if (today === expectedDate) return 'due_today'
  return 'not_due_yet'
}

/** One product of one Stock Out that still has units to come back (one Outstanding Returns row). */
export interface OutstandingReturnRow {
  /** `${txn_id}_${product_id}` */
  id: string
  txn_id: string
  product_id: string
  product_name: string
  staff_id: string | null
  /** '—' when the Stock Out has no staff name. */
  staff_name: string
  /** issued - returned - waived, above zero. */
  qty: number
  expected_date: string | null
  txn_ref: string
  status: OutstandingStatus
}

/** One accepted loan request waiting to be collected (one Incoming Pickups row). */
export interface IncomingPickupRow {
  id: string
  reference_no: string | null
  staff_name: string
  item_count: number
  from_date: string
  to_date: string | null
  /** The whole pickup window has passed with nothing issued. */
  noShow: boolean
  /** At least one line is promised more units than are currently free. */
  insufficient: boolean
}

export interface PickupLine {
  id: string
  product_id: string
  product_name: string
  offered_quantity: number
  /** On hand now, less what other active requests hold over the same window (never below zero). */
  available: number
  shortBy: number
}

export type LowStockStatus = 'out_of_stock' | 'low_stock'

export interface LowStockRow {
  id: string
  name: string
  quantity_on_hand: number
  reorder_threshold: number
  status: LowStockStatus
}

export interface OverdueHolding {
  /** The Outstanding Returns row id. */
  id: string
  staff_name: string
  qty: number
  expected_date: string
  txn_ref: string
}

export interface DashboardStats {
  total_products: number
  total_stock: number
  low_stock: number
  /** Transactions recorded since midnight (APP_TIME_ZONE). */
  today_transactions: number
  total_staff: number
}

export interface DashboardData {
  stats: DashboardStats
  /** Most urgent first: soonest due at the top, undated at the end. */
  outstandingReturns: OutstandingReturnRow[]
  /** The overdue rows above grouped by product: the likely cause when an incoming pickup comes up short. */
  overdueByProduct: Record<string, OverdueHolding[]>
  /** Soonest pickup first. */
  incomingPickups: IncomingPickupRow[]
  /** Items of each incoming pickup, by request id. */
  pickupLines: Record<string, PickupLine[]>
  /** Lowest quantity first. */
  lowStock: LowStockRow[]
}

export interface DashboardAlertCounts {
  outstandingReturns: number
  lowStock: number
  incomingPickups: number
  total: number
}

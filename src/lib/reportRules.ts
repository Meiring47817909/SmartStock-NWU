// Row shapes of the Reports page's four tabs and of the Audit Log, shared by the server (src/server/data/reports.ts,
// auditLog.ts) and the browser client (src/lib/api/reports.ts, auditLog.ts). No Firebase, no database.
//
// The rows carry the fields the table, CSV and PDF code reads. The server decides the dates (calendar days in
// Africa/Johannesburg), the outstanding balances and the status of each row.
import { appCalendarDay } from '@/lib/utils'
import type { AuditLogEntry, LoanRequestLine, TransactionLine } from '@/types/database'

export type ReportKind = 'stock-levels' | 'low-stock' | 'issued-per-staff' | 'returns'

export const REPORT_KINDS: readonly ReportKind[] = ['stock-levels', 'low-stock', 'issued-per-staff', 'returns']

export type StockLevelStatus = 'OUT OF STOCK' | 'LOW STOCK' | 'IN STOCK'

/** Current Stock Levels: every product, by name. */
export interface StockLevelRow {
  id: string
  name: string
  category_id: string | null
  category_name: string | null
  qty: number
  threshold: number
  status: StockLevelStatus
}

/** Low Stock Items: products at or below their reorder threshold, lowest quantity first. */
export interface LowStockReportRow {
  id: string
  name: string
  category_id: string | null
  category_name: string | null
  quantity_on_hand: number
  reorder_threshold: number
}

/** One line of a transaction, as stored (one per product and barcode). */
export interface ReportLine {
  id: string
  product_id: string
  product_name: string
  barcode: string | null
  issued_barcode: string | null
  quantity: number
}

export interface IssuedTxn {
  id: string
  reference_no: string
  /** ISO timestamp of the Stock Out. */
  created_at: string
  /** YYYY-MM-DD, or null when no return date was agreed. */
  lend_from: string | null
  lend_to: string | null
  /** In scan order. */
  transaction_lines: ReportLine[]
}

export interface IssuedStaffRow {
  id: string
  name: string
  surname: string
  full_name: string
  department: string | null
  /** The Stock Outs that clear the date filters, newest first. */
  txns: IssuedTxn[]
  /** Units on those Stock Outs. */
  totalQty: number
}

export interface IssuedPerStaffReport {
  /** Active staff, by name. With a date set, only those with at least one Stock Out in range. */
  staff: IssuedStaffRow[]
  /**
   * Stock Outs with no return date that clear "Issued from" (whatever "Expected back by" is set to): what the
   * "include items with no return date" switch decides about.
   */
  undatedCount: number
}

export interface OutstandingReturnLine {
  product_name: string
  outstanding: number
  barcodeQuantities: { barcode: string; quantity: number }[]
}

export interface ReturnRow {
  id: string
  reference_no: string
  staff_id: string | null
  staff_name: string | null
  linked_txn_id: string | null
  /** ISO timestamp of the return. */
  created_at: string
  /** The reference of the Stock Out this return settles. */
  linked_txn_ref: string | null
  /** That Stock Out's Lend To (YYYY-MM-DD), null when unknown. */
  expected_date: string | null
  /** What is still owed on that Stock Out, per product (issued - returned by every return - written off). */
  outstandingLines: OutstandingReturnLine[]
  /** Something is still owed on the Stock Out. */
  partial: boolean
  transaction_lines: ReportLine[]
}

export type ReturnStatus = 'Partial' | 'Late' | 'On time' | 'Early'

/**
 * The status of a completed return, or null when there is nothing to judge it against. Partial takes priority (the
 * originating Stock Out still has a balance owed, possibly across more than one return visit); otherwise Early / On time /
 * Late compares the calendar day in Africa/Johannesburg the return was made against the Stock Out's Lend To date: a
 * historical judgement, not a live "today" one. A return at 23:30 UTC on the day before the due date was made at 01:30 on
 * the due date in Johannesburg: On time.
 */
export function returnStatusOf(r: { partial: boolean; expected_date: string | null; created_at: string | null }): ReturnStatus | null {
  if (r.partial) return 'Partial'
  if (!r.expected_date) return null
  const returnedOn = r.created_at ? appCalendarDay(r.created_at) : ''
  if (returnedOn < r.expected_date) return 'Early'
  if (returnedOn === r.expected_date) return 'On time'
  return 'Late'
}

export interface ReturnsReport {
  /** Newest first. With a date set, those whose Stock Out was expected back in range. */
  returns: ReturnRow[]
  /** Returns whose expected date is unknown, over the whole set (what the "include returns with no due date" switch decides about). */
  undatedCount: number
}

export interface ReportResults {
  'stock-levels': StockLevelRow[]
  'low-stock': LowStockReportRow[]
  'issued-per-staff': IssuedPerStaffReport
  returns: ReturnsReport
}

export interface ReportParams {
  /** YYYY-MM-DD calendar days in Africa/Johannesburg (Issued per Staff: "Issued from"; Returns: "Expected from"). */
  from?: string
  /** Issued per Staff: "Expected back by" (a Lend To date); Returns: "Expected to". */
  to?: string
  /** Whether rows with no expected date pass the "to" end (Issued per Staff) or the whole range (Returns). Default true. */
  includeUndated?: boolean
}

export interface AuditLogParams {
  /** YYYY-MM-DD calendar days in Africa/Johannesburg, both ends inclusive. */
  from?: string
  to?: string
  /** One or several entity types. */
  entityType?: string | string[]
  /** One or several raw actions (the log's `action` field, not the Activity the page derives). */
  action?: string | string[]
  userId?: string
  /** The previous page's `nextCursor`: the page that follows it. */
  cursor?: string
}

export interface AuditLogResult {
  /** Newest first. */
  entries: AuditLogEntry[]
  /**
   * The product lines (scan order) of each listed transaction entry that did not freeze them into its payload, by
   * transaction id; an empty list when the transaction has none. Entries that need no lookup have no key.
   */
  transactionLines: Record<string, TransactionLine[]>
  /** The same for the 'create' entry of a loan request, by request id. */
  loanRequestLines: Record<string, LoanRequestLine[]>
}

/** One page of the log, as the API answers it: up to AUDIT_PAGE_SIZE entries and the lookups for those entries only. */
export interface AuditLogPage extends AuditLogResult {
  /** Pass as `cursor` for the next (older) page; null on the last page. */
  nextCursor: string | null
}

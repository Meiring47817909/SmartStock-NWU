// Browser client for the Reports API (admin). The tabs' rows are computed on the server.
//   GET /api/reports?report=…[&from=…][&to=…][&includeUndated=false]
import { api } from '@/lib/api/client'
import type { ReportKind, ReportParams, ReportResults } from '@/lib/reportRules'

export type {
  IssuedPerStaffReport,
  IssuedStaffRow,
  IssuedTxn,
  LowStockReportRow,
  OutstandingReturnLine,
  ReportKind,
  ReportLine,
  ReportParams,
  ReportResults,
  ReturnRow,
  ReturnsReport,
  StockLevelRow,
  StockLevelStatus,
} from '@/lib/reportRules'

/**
 * One report tab's rows. `from` / `to` are YYYY-MM-DD calendar days (Issued per Staff: Issued from / Expected back by;
 * Returns: Expected from / Expected to); `includeUndated` (default true) says whether rows with no expected date pass.
 */
export function loadReport<K extends ReportKind>(report: K, params: ReportParams = {}): Promise<ReportResults[K]> {
  return api<ReportResults[K]>('GET', '/api/reports', {
    report,
    from: params.from || undefined,
    to: params.to || undefined,
    includeUndated: params.includeUndated === false ? 'false' : undefined,
  })
}

import { route } from '@/server/http'
import { loadReport } from '@/server/data/reports'
import type { ReportKind } from '@/lib/reportRules'

// The Reports page's tabs, computed on the server (admin only).
//   GET /api/reports?report=stock-levels|low-stock|issued-per-staff|returns[&from=YYYY-MM-DD][&to=YYYY-MM-DD][&includeUndated=false]
// from/to are calendar days in Africa/Johannesburg (see src/server/data/reports.ts for what each tab bounds).
type Query = { report?: string; from?: string; to?: string; includeUndated?: string }

export const GET = route<Query>('admin', async (ctx, q) =>
  // loadReport answers an unknown (or missing) report with a 400.
  loadReport(ctx, { report: (q.report ?? '') as ReportKind, from: q.from, to: q.to, includeUndated: q.includeUndated !== 'false' }),
)

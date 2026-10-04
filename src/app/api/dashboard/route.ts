import { route } from '@/server/http'
import { DataError } from '@/server/context'
import { loadDashboard, loadDashboardAlertCounts } from '@/server/data/dashboard'

// The Dashboard, computed on the server (admin).
//   GET /api/dashboard                 → DashboardData (stats, outstanding returns, incoming pickups, low stock)
//   GET /api/dashboard?kind=alertCounts → DashboardAlertCounts (the Sidebar badge)
// Accepted loan requests whose pickup window has passed are settled (no-show) before either is answered.
export const GET = route<{ kind?: string }>('admin', async (ctx, query) => {
  switch (query.kind) {
    case undefined:
    case '':
      return loadDashboard(ctx)
    case 'alertCounts':
      return loadDashboardAlertCounts(ctx)
    default:
      throw new DataError(400, 'Unknown request.')
  }
})

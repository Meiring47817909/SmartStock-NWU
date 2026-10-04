// Browser client for the Dashboard API (admin). The rows and badge states are computed on the server.
//   GET /api/dashboard                  loadDashboard
//   GET /api/dashboard?kind=alertCounts loadDashboardAlertCounts (the Sidebar badge)
import { api } from '@/lib/api/client'
import type { DashboardAlertCounts, DashboardData } from '@/lib/dashboardRules'

export { outstandingStatusOf } from '@/lib/dashboardRules'
export type {
  DashboardAlertCounts,
  DashboardData,
  DashboardStats,
  IncomingPickupRow,
  LowStockRow,
  LowStockStatus,
  OutstandingReturnRow,
  OutstandingStatus,
  OverdueHolding,
  PickupLine,
} from '@/lib/dashboardRules'

export function loadDashboard(): Promise<DashboardData> {
  return api<DashboardData>('GET', '/api/dashboard')
}

export function loadDashboardAlertCounts(): Promise<DashboardAlertCounts> {
  return api<DashboardAlertCounts>('GET', '/api/dashboard', { kind: 'alertCounts' })
}

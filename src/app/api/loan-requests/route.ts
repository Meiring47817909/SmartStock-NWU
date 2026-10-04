import { route } from '@/server/http'
import { DataError } from '@/server/context'
import {
  findQuantityReductionConflicts,
  getReservationHolders,
  getReservationIntervals,
  getReservedQuantity,
  listRequests,
  loadLoanRequestsAlertCount,
  loadMyRequestsAlertCount,
  submitLoanRequest,
  validateCartDates,
} from '@/server/data/loanRequests'
import type { CartLine, SubmitLoanRequestInput } from '@/lib/loanRequestRules'
import type { LoanRequestStatus } from '@/types/database'

// Loan requests. Every route is `signed-in`; the data functions decide who may do what (staff only ever see and act on
// their own requests, an admin-only read is a 403 for staff).
//   GET  /api/loan-requests[?staffId=&statuses=a,b]                    → LoanRequest[]            (staff: own only)
//   GET  /api/loan-requests?kind=holders&productId=&fromDate=&toDate=[&statuses=a,b]
//                                                                      → ReservationHolder[]      (admin)
//   GET  /api/loan-requests?kind=reserved&productId=&fromDate=&toDate=[&excludeRequestId=]
//                                                                      → { quantity }
//   GET  /api/loan-requests?kind=intervals&productIds=a,b              → { [productId]: ReservationInterval[] }
//   GET  /api/loan-requests?kind=quantityConflicts&productId=&quantity=→ ReservationHolder[]      (admin)
//   GET  /api/loan-requests?kind=alertCount                            → { count }                (admin)
//   GET  /api/loan-requests?kind=myAlertCount                          → { count }                (the caller's own)
//   POST /api/loan-requests { action: 'validate', cart, fromDate, toDate } → { valid, errors }
//   POST /api/loan-requests { action: 'submit', ...SubmitLoanRequestInput } → { id }
type Query = {
  kind?: string
  staffId?: string
  statuses?: string
  productId?: string
  productIds?: string
  fromDate?: string
  toDate?: string
  excludeRequestId?: string
  quantity?: string
}

const list = (value: string | undefined): string[] => (value ? value.split(',').filter(Boolean) : [])

export const GET = route<Query>('signed-in', async (ctx, q) => {
  const statuses = q.statuses === undefined ? undefined : (list(q.statuses) as LoanRequestStatus[])
  switch (q.kind) {
    case undefined:
    case '':
      return listRequests(ctx, { staffId: q.staffId, statuses })
    case 'holders':
      return getReservationHolders(ctx, q.productId ?? '', q.fromDate ?? '', q.toDate ?? '', statuses)
    case 'reserved':
      return { quantity: await getReservedQuantity(ctx, q.productId ?? '', q.fromDate ?? '', q.toDate ?? '', q.excludeRequestId || undefined) }
    case 'intervals':
      return getReservationIntervals(ctx, list(q.productIds))
    case 'quantityConflicts':
      return findQuantityReductionConflicts(ctx, q.productId ?? '', q.quantity !== undefined && /^\d+$/.test(q.quantity) ? Number(q.quantity) : NaN)
    case 'alertCount':
      return { count: await loadLoanRequestsAlertCount(ctx) }
    case 'myAlertCount':
      return { count: await loadMyRequestsAlertCount(ctx) }
    default:
      throw new DataError(400, 'Unknown request.')
  }
})

type Body = { action?: string; cart?: CartLine[]; fromDate?: string; toDate?: string | null } & Partial<SubmitLoanRequestInput>

export const POST = route<Body>('signed-in', async (ctx, body) => {
  switch (body.action) {
    case 'validate':
      return validateCartDates(ctx, body.cart as CartLine[], body.fromDate as string, body.toDate)
    case 'submit':
      return { id: await submitLoanRequest(ctx, body as SubmitLoanRequestInput) }
    default:
      throw new DataError(400, 'Unknown action.')
  }
})

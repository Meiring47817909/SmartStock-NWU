// Browser client for the loan-request API. Same function names as the old Firestore helpers
// (src/lib/firebase/loanRequests.ts, removed), minus the server-side `ctx`; the pure helpers come from src/lib/loanRequestRules.ts.
// What changed for callers: the actor (user id / name) is no longer passed, the server uses the signed-in caller; the
// transitions take the request (or just its id) and the server reads the lines and statuses itself; the cart is
// `{ product: { id }, quantity }` as before, but the server looks the product up (nothing about the product is trusted).
//
// Routes (JSON; the Firebase ID token is attached by api()):
//   GET  /api/loan-requests[?staffId=&statuses=]            listRequests / getAcceptedPickups
//   GET  /api/loan-requests?kind=holders|reserved|intervals|quantityConflicts|alertCount|myAlertCount
//   POST /api/loan-requests { action: 'validate' | 'submit' }   validateCartDates / submitLoanRequest
//   GET  /api/loan-requests/<id>                            getLoanRequest (request + lines) / getRequestLines
//   POST /api/loan-requests/<id>/transition { action }      approveAsIs / sendCounter / declineRequest / acceptCounter /
//                                                           declineCounter / withdrawRequest / expireIfNeeded
// The emails after a change (POST /api/notifications/loan-request) are separate calls, made by the pages as today.
import { api, ClientApiError } from '@/lib/api/client'
import { ACTIVE_STATUSES, isExpired, isNoShowCandidate, type CartCheck, type CounterInput, type ListRequestsOptions, type ReservationHolder, type ReservationInterval } from '@/lib/loanRequestRules'
import type { LoanRequest, LoanRequestLine, LoanRequestStatus } from '@/types/database'

export {
  ACTIVE_STATUSES,
  ALL_TIME_FROM,
  LENDING_INTERVALS,
  OPEN_ENDED_TO,
  computeExpiryDate,
  effectiveToDate,
  isExpired,
  isNoShowCandidate,
  lendingIntervalDays,
  lendingIntervalLabel,
  reservationStatusLabel,
  reservedQuantityInRange,
  resolutionInstruction,
  tightestLendingCap,
} from '@/lib/loanRequestRules'
export type {
  CartCheck,
  CartLine,
  CounterInput,
  ListRequestsOptions,
  RequestSnapshotLine,
  ReservationHolder,
  ReservationInterval,
  SubmitLoanRequestInput,
} from '@/lib/loanRequestRules'

/** A request, or just its id: the Dashboard only holds `{ id }` for an incoming pickup. */
export type RequestRef = string | { id: string }
const idOf = (ref: RequestRef): string => (typeof ref === 'string' ? ref : ref.id)
const transition = <T = LoanRequest>(ref: RequestRef, body: Record<string, unknown>) =>
  api<T>('POST', `/api/loan-requests/${encodeURIComponent(idOf(ref))}/transition`, body)

interface CartLike {
  product: { id: string | number }
  quantity: number
}

// --- Reads ---------------------------------------------------------------------------------------------------------

/** Requests, oldest first (a staff member's own only; an admin may filter by `staffId` and/or `statuses`). */
export function listRequests(opts: ListRequestsOptions = {}): Promise<LoanRequest[]> {
  return api<LoanRequest[]>('GET', '/api/loan-requests', {
    staffId: opts.staffId,
    statuses: opts.statuses?.join(','),
  })
}

/** Accepted, not-yet-fulfilled requests of one staff member: Stock Out's pending pickups. */
export async function getAcceptedPickups(staffId: string): Promise<LoanRequest[]> {
  const accepted = await listRequests({ staffId, statuses: ['accepted'] })
  return accepted.filter((r) => r.fulfilled_txn_id === null)
}

export function getLoanRequest(requestId: string): Promise<{ request: LoanRequest; lines: LoanRequestLine[] }> {
  return api('GET', `/api/loan-requests/${encodeURIComponent(requestId)}`)
}

export async function getRequestLines(requestId: string): Promise<LoanRequestLine[]> {
  return (await getLoanRequest(requestId)).lines
}

/** Whose active reservations a product/date window would run into (admin). `statuses` defaults to all active ones. */
export function getReservationHolders(
  productId: string,
  fromDate: string,
  toDate: string,
  statuses: LoanRequestStatus[] = ACTIVE_STATUSES,
): Promise<ReservationHolder[]> {
  return api<ReservationHolder[]>('GET', '/api/loan-requests', { kind: 'holders', productId, fromDate, toDate, statuses: statuses.join(',') })
}

/** Units of a product promised to active requests overlapping the range, leaving out one request. */
export async function getReservedQuantity(productId: string, fromDate: string, toDate: string, excludeRequestId?: string): Promise<number> {
  const res = await api<{ quantity: number }>('GET', '/api/loan-requests', { kind: 'reserved', productId, fromDate, toDate, excludeRequestId })
  return res.quantity
}

/** Active reservation windows per product, for the cart's calendar (see reservedQuantityInRange). */
export async function getReservationIntervals(productIds: string[]): Promise<Map<string, ReservationInterval[]>> {
  const result = new Map<string, ReservationInterval[]>()
  productIds.forEach((id) => result.set(id, []))
  if (productIds.length === 0) return result
  const res = await api<Record<string, ReservationInterval[]>>('GET', '/api/loan-requests', { kind: 'intervals', productIds: productIds.join(',') })
  Object.entries(res).forEach(([id, intervals]) => result.set(id, intervals))
  return result
}

/** Active reservations a new Qty On Hand would break (Products page quantity-reduction guard; admin). */
export function findQuantityReductionConflicts(productId: string, newQuantity: number): Promise<ReservationHolder[]> {
  return api<ReservationHolder[]>('GET', '/api/loan-requests', { kind: 'quantityConflicts', productId, quantity: newQuantity })
}

export function validateCartDates(cartItems: CartLike[], fromDate: string, toDate: string): Promise<CartCheck> {
  return api<CartCheck>('POST', '/api/loan-requests', {
    action: 'validate',
    cart: cartItems.map((i) => ({ productId: String(i.product.id), quantity: i.quantity })),
    fromDate,
    toDate,
  })
}

/** Sidebar badge for admins: Needs Review + Sent Counters. */
export async function loadLoanRequestsAlertCount(): Promise<number> {
  return (await api<{ count: number }>('GET', '/api/loan-requests', { kind: 'alertCount' })).count
}

/** Header badge for the signed-in staff member: their own pending + countered + accepted requests. */
export async function loadMyRequestsAlertCount(): Promise<number> {
  return (await api<{ count: number }>('GET', '/api/loan-requests', { kind: 'myAlertCount' })).count
}

// --- Writes --------------------------------------------------------------------------------------------------------

/**
 * Submit the cart as a pending request. `staffId` defaults to the signed-in staff member (a staff caller may only name
 * themselves). Resolves to the new request's id; rejects with the first problem found (400).
 */
export async function submitLoanRequest(
  cart: CartLike[],
  fromDate: string,
  toDate: string,
  message: string | null,
  staffId?: string,
): Promise<string> {
  const res = await api<{ id: string }>('POST', '/api/loan-requests', {
    action: 'submit',
    staffId,
    cart: cart.map((i) => ({ productId: String(i.product.id), quantity: i.quantity })),
    fromDate,
    toDate: toDate || null,
    message,
  })
  return res.id
}

export const approveAsIs = (request: RequestRef): Promise<LoanRequest> => transition(request, { action: 'approve' })

export const sendCounter = (request: RequestRef, input: CounterInput): Promise<LoanRequest> =>
  transition(request, { action: 'counter', ...input })

export const declineRequest = (request: RequestRef, message?: string | null): Promise<LoanRequest> =>
  transition(request, { action: 'decline', message })

export const acceptCounter = (request: RequestRef): Promise<LoanRequest> => transition(request, { action: 'acceptCounter' })

export const declineCounter = (request: RequestRef): Promise<LoanRequest> => transition(request, { action: 'declineCounter' })

/** The staff member's own withdrawal, or an admin cancelling an approved pickup (`reason` goes on the audit entry). */
export const withdrawRequest = (request: RequestRef, reason?: string | null): Promise<LoanRequest> =>
  transition(request, { action: 'withdraw', reason })

/** Persist the expiry / no-show transition if the request is due; resolves to its status afterwards. */
export async function expireIfNeeded(request: RequestRef): Promise<LoanRequestStatus> {
  return (await transition<{ status: LoanRequestStatus }>(request, { action: 'expire' })).status
}

/**
 * Same as expireIfNeeded for a request the page already holds, but only calls the server when the request looks due
 * (same date rules as the server, which decides for real): a list of requests costs one call per due row, not per row.
 */
export async function expireIfDue(request: LoanRequest): Promise<LoanRequestStatus> {
  if (!isExpired(request) && !isNoShowCandidate(request)) return request.status
  return expireIfNeeded(request)
}

/** True for the server's 409 on an action whose request changed meanwhile: the page shows the message and reloads. */
export function isStaleRequestError(err: unknown): boolean {
  return err instanceof ClientApiError && err.status === 409 && err.message.startsWith('This request has already changed')
}

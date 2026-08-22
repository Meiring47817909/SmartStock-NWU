import { db } from './config'
import { collection, doc, getDoc, getDocs, addDoc, updateDoc, query, where } from 'firebase/firestore'
import { logAudit } from './audit'
import { todayDateStr, addDaysToDateStr, isoToLocalDateStr } from '@/lib/utils'
import type { Product, LoanRequest, LoanRequestLine, LoanRequestStatus } from '@/types/database'

const ACTIVE_STATUSES: LoanRequestStatus[] = ['pending', 'countered', 'accepted']
const MAX_LOAN_DAYS = 7

interface CartLike {
  product: Product
  quantity: number
}

interface ActorInfo {
  userId?: string | null
  userName?: string | null
}

// 3.1 — Reservation ledger. Availability for a candidate range is always
// computed live by scanning active requests and checking date-range
// overlap — never a denormalized "units reserved" counter on Product (see
// LENDING_PORTAL_SPEC.md decision #6: a stored counter can drift, a live
// query can't).
export async function getReservedQuantity(
  productId: string,
  fromDate: string,
  toDate: string,
  excludeRequestId?: string,
): Promise<number> {
  const activeSnap = await getDocs(
    query(collection(db, 'loan_requests'), where('status', 'in', ACTIVE_STATUSES)),
  )
  const activeById = new Map<string, LoanRequest>()
  activeSnap.forEach((d) => {
    if (d.id === excludeRequestId) return
    activeById.set(d.id, { id: d.id, ...d.data() } as LoanRequest)
  })
  if (activeById.size === 0) return 0

  const linesSnap = await getDocs(
    query(collection(db, 'loan_request_lines'), where('product_id', '==', productId)),
  )
  let sum = 0
  linesSnap.forEach((d) => {
    const line = d.data() as LoanRequestLine
    const req = activeById.get(line.request_id)
    if (!req) return
    if (fromDate <= req.to_date && toDate >= req.from_date) sum += line.offered_quantity
  })
  return sum
}

// 3.2 — Cart validation. Checks each product's own lend window, the 1-week
// max, and live availability. Collects every failing product's error at
// once so the UI can show every problem, not just the first.
export async function validateCartDates(
  cartItems: CartLike[],
  fromDate: string,
  toDate: string,
): Promise<{ valid: boolean; errors: string[] }> {
  const errors: string[] = []

  if (!fromDate || !toDate) {
    return { valid: false, errors: ['Select both a From and To date.'] }
  }
  if (toDate < fromDate) errors.push("To date can't be before the From date.")
  if (toDate > addDaysToDateStr(fromDate, MAX_LOAN_DAYS)) {
    errors.push(`Loan window cannot exceed ${MAX_LOAN_DAYS} days.`)
  }

  for (const { product, quantity } of cartItems) {
    if (!product.lend_from || !product.lend_to) {
      errors.push(`${product.name} isn't set up for portal lending.`)
      continue
    }
    if (fromDate < product.lend_from || toDate > product.lend_to) {
      errors.push(
        `${product.name} is only lendable ${product.lend_from} – ${product.lend_to} — outside your selected range.`,
      )
      continue
    }
    const reserved = await getReservedQuantity(product.id.toString(), fromDate, toDate)
    const available = Math.max(0, product.quantity_on_hand - reserved)
    if (quantity > available) {
      errors.push(`${product.name}: only ${available} unit(s) available for these dates, you requested ${quantity}.`)
    }
  }

  return { valid: errors.length === 0, errors }
}

// 3.3 — Expiry: min(updated_at + 7 days, from_date). See decision #5 for why
// a flat 7-day SLA that resets on every state change is wrong — capping at
// from_date keeps a near-term request from outliving its own pickup date.
export function computeExpiryDate(request: LoanRequest): string | null {
  if (request.status !== 'pending' && request.status !== 'countered') return null
  const sevenDaysOut = addDaysToDateStr(isoToLocalDateStr(request.updated_at), MAX_LOAN_DAYS)
  return sevenDaysOut < request.from_date ? sevenDaysOut : request.from_date
}

export function isExpired(request: LoanRequest): boolean {
  const expiry = computeExpiryDate(request)
  return expiry !== null && todayDateStr() > expiry
}

// 3.4 — No-show: accepted, pickup date passed, nothing issued against it.
export function isNoShowCandidate(request: LoanRequest): boolean {
  return request.status === 'accepted' && !request.fulfilled_txn_id && todayDateStr() > request.from_date
}

// Lazily persists the expiry/no-show transition on next read (see decision
// #5/§3.4 — both need to be real status values the reservation ledger and
// list queries can exclude/include on, not just a live display label).
export async function expireIfNeeded(request: LoanRequest, actor: ActorInfo = {}): Promise<LoanRequestStatus> {
  let next: LoanRequestStatus | null = null
  if (isExpired(request)) next = 'expired'
  else if (isNoShowCandidate(request)) next = 'no_show'
  if (!next) return request.status

  const now = new Date().toISOString()
  await updateDoc(doc(db, 'loan_requests', request.id), { status: next, updated_at: now })
  logAudit({
    userId: actor.userId, userName: actor.userName,
    action: 'update', entityType: 'loan_request', entityId: request.id,
    before: { status: request.status }, after: { status: next },
  })
  return next
}

// 3.5 — Cart submission.
export async function submitLoanRequest(
  staffId: string,
  staffName: string,
  cart: CartLike[],
  fromDate: string,
  toDate: string,
  message: string | null,
  actor: ActorInfo = {},
): Promise<string> {
  const check = await validateCartDates(cart, fromDate, toDate)
  if (!check.valid) throw new Error(check.errors[0])

  const now = new Date().toISOString()
  const reqPayload = {
    staff_id: staffId,
    staff_name: staffName,
    status: 'pending' as const,
    message,
    from_date: fromDate,
    to_date: toDate,
    original_from_date: fromDate,
    original_to_date: toDate,
    created_at: now,
    updated_at: now,
    fulfilled_txn_id: null,
  }
  const reqRef = await addDoc(collection(db, 'loan_requests'), reqPayload)
  logAudit({
    userId: actor.userId, userName: actor.userName,
    action: 'create', entityType: 'loan_request', entityId: reqRef.id,
    before: null, after: reqPayload,
  })

  for (const item of cart) {
    await addDoc(collection(db, 'loan_request_lines'), {
      request_id: reqRef.id,
      product_id: item.product.id.toString(),
      product_name: item.product.name,
      requested_quantity: item.quantity,
      offered_quantity: item.quantity,
      created_at: now,
    })
  }

  return reqRef.id
}

// Re-runs the reservation ledger against the (possibly edited) offered
// lines/dates before Selouna's write commits, per decision #7 — availability
// may have changed since the request was submitted.
async function assertStillAvailable(
  requestId: string,
  lines: { product_id: string; offered_quantity: number }[],
  fromDate: string,
  toDate: string,
): Promise<void> {
  for (const line of lines) {
    if (line.offered_quantity <= 0) continue
    const reserved = await getReservedQuantity(line.product_id, fromDate, toDate, requestId)
    // NOTE: reserved already excludes this request's own current reservation
    // (via excludeRequestId), so the full offered_quantity is the amount to
    // check against remaining stock, not just the delta.
    const productSnap = await getDoc(doc(db, 'products', line.product_id))
    const onHand = (productSnap.data() as { quantity_on_hand?: number } | undefined)?.quantity_on_hand ?? 0
    if (reserved + line.offered_quantity > onHand) {
      throw new Error(`Availability changed since this request was submitted — not enough stock remains for one of the lines.`)
    }
  }
}

// 3.6 — Selouna's counter / approve / decline.
export async function approveAsIs(request: LoanRequest, lines: LoanRequestLine[], actor: ActorInfo = {}): Promise<void> {
  await assertStillAvailable(
    request.id,
    lines.map((l) => ({ product_id: l.product_id, offered_quantity: l.offered_quantity })),
    request.from_date, request.to_date,
  )
  const now = new Date().toISOString()
  await updateDoc(doc(db, 'loan_requests', request.id), { status: 'accepted', updated_at: now })
  logAudit({
    userId: actor.userId, userName: actor.userName,
    action: 'update', entityType: 'loan_request', entityId: request.id,
    before: { status: request.status }, after: { status: 'accepted' },
  })
}

export async function sendCounter(
  request: LoanRequest,
  editedLines: { lineId: string; product_id: string; offered_quantity: number }[],
  newFromDate: string | undefined,
  newToDate: string | undefined,
  actor: ActorInfo = {},
): Promise<void> {
  const fromDate = newFromDate ?? request.from_date
  const toDate = newToDate ?? request.to_date
  await assertStillAvailable(request.id, editedLines, fromDate, toDate)

  const now = new Date().toISOString()
  await updateDoc(doc(db, 'loan_requests', request.id), {
    status: 'countered', updated_at: now, from_date: fromDate, to_date: toDate,
  })
  for (const line of editedLines) {
    await updateDoc(doc(db, 'loan_request_lines', line.lineId), { offered_quantity: line.offered_quantity })
  }
  logAudit({
    userId: actor.userId, userName: actor.userName,
    action: 'update', entityType: 'loan_request', entityId: request.id,
    before: { status: request.status, from_date: request.from_date, to_date: request.to_date },
    after: { status: 'countered', from_date: fromDate, to_date: toDate },
  })
}

export async function declineRequest(request: LoanRequest, actor: ActorInfo = {}): Promise<void> {
  const now = new Date().toISOString()
  await updateDoc(doc(db, 'loan_requests', request.id), { status: 'declined', updated_at: now })
  logAudit({
    userId: actor.userId, userName: actor.userName,
    action: 'update', entityType: 'loan_request', entityId: request.id,
    before: { status: request.status }, after: { status: 'declined' },
  })
}

// 3.7 — Staff response to a counter.
async function transitionStatus(request: LoanRequest, next: LoanRequestStatus, actor: ActorInfo): Promise<void> {
  const now = new Date().toISOString()
  await updateDoc(doc(db, 'loan_requests', request.id), { status: next, updated_at: now })
  logAudit({
    userId: actor.userId, userName: actor.userName,
    action: 'update', entityType: 'loan_request', entityId: request.id,
    before: { status: request.status }, after: { status: next },
  })
}

export async function acceptCounter(request: LoanRequest, actor: ActorInfo = {}): Promise<void> {
  await transitionStatus(request, 'accepted', actor)
}

export async function declineCounter(request: LoanRequest, actor: ActorInfo = {}): Promise<void> {
  await transitionStatus(request, 'declined', actor)
}

export async function withdrawRequest(request: LoanRequest, actor: ActorInfo = {}): Promise<void> {
  await transitionStatus(request, 'withdrawn', actor)
}

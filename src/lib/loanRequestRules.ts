// Pure loan-request helpers and shapes shared by the server data layer (src/server/data/loanRequests.ts), the browser
// client (src/lib/api/loanRequests.ts) and the pages that only need a pure helper. No Firebase, no database. Expiry and no-show decide by calendar day in
// APP_TIME_ZONE (Africa/Johannesburg), not the machine's zone, and isExpired / isNoShowCandidate take an optional
// `today` so the server can decide from its own clock (ctx.now()).
import { appCalendarDay, addDaysToDateStr } from '@/lib/utils'
import type { Product, LoanRequest, LoanRequestStatus, LendingInterval } from '@/types/database'

export const ACTIVE_STATUSES: LoanRequestStatus[] = ['pending', 'countered', 'accepted']

const STATUS_LABELS: Record<LoanRequestStatus, string> = {
  pending: 'Pending',
  countered: 'Countered',
  accepted: 'Accepted',
  fulfilled: 'Fulfilled',
  declined: 'Declined',
  expired: 'Expired',
  withdrawn: 'Withdrawn',
  no_show: 'Not picked up',
}

/** The label every screen shows for a loan request status (no_show reads "Not picked up" everywhere). */
export function loanRequestStatusLabel(status: LoanRequestStatus): string {
  return STATUS_LABELS[status] ?? status
}
const MAX_LOAN_DAYS = 30

// Stand-in upper/lower bounds for "any time, ever" when a check has no
// meaningful date window of its own (see findQuantityReductionConflicts).
// Dates compare lexicographically as YYYY-MM-DD strings throughout
// this app, so these sentinels behave as -infinity/+infinity without
// special-casing the comparison itself. OPEN_ENDED_TO also matches Stock
// Out's own sentinel for an open-ended (no Lend To) walk-in issue.
export const OPEN_ENDED_TO = '9999-12-31'
// Exported for the Products page's delete guard (getProductDeleteBlockers)
// — it needs the same "any time, ever" sentinel to ask
// getReservationHolders for every active reservation on a product,
// regardless of date window, before allowing a delete.
export const ALL_TIME_FROM = '0001-01-01'

// A product saved before the Lending Interval field existed has no
// lending_interval at all — treated as this, which preserves the flat
// 7-day cap every product used to have (the old MAX_LOAN_DAYS constant
// above, kept only for computeExpiryDate's unrelated SLA now).
const DEFAULT_LENDING_INTERVAL: LendingInterval = 'week_1'

export const LENDING_INTERVALS: { value: LendingInterval; label: string; days: number | null }[] = [
  { value: 'week_1', label: '1 Week', days: 7 },
  { value: 'week_2', label: '2 Weeks', days: 14 },
  { value: 'week_3', label: '3 Weeks', days: 21 },
  { value: 'month_1', label: '1 Month', days: 30 },
  { value: 'indefinite', label: 'Indefinitely', days: null },
]

function lendingIntervalInfo(interval: LendingInterval | null | undefined) {
  return LENDING_INTERVALS.find((i) => i.value === interval) ?? LENDING_INTERVALS.find((i) => i.value === DEFAULT_LENDING_INTERVAL)!
}

// Max loan duration in days for a product's lending interval, or null for
// Indefinitely (no cap at all).
export function lendingIntervalDays(interval: LendingInterval | null | undefined): number | null {
  return lendingIntervalInfo(interval).days
}

export function lendingIntervalLabel(interval: LendingInterval | null | undefined): string {
  return lendingIntervalInfo(interval).label
}

// A candidate or stored date range's "to" side, resolved to a real,
// comparable string — null/blank (an indefinite loan, or a walk-in issue
// with no Lend To) behaves as "overlaps everything from its from-date
// onward" via the OPEN_ENDED_TO sentinel, without special-casing every
// comparison that touches it.
export function effectiveToDate(to: string | null | undefined): string {
  return to || OPEN_ENDED_TO
}

// Holder-level breakdown of one active reservation (pending, countered, or
// accepted) on a product/date window: whose, and in what state. Stock Out's
// hard block names exactly which request(s) a walk-in issue would encroach on.
export interface ReservationHolder {
  requestId: string
  staffId: string
  staffName: string
  quantity: number
  fromDate: string
  toDate: string | null   // null = indefinite loan, no return date
  status: LoanRequestStatus
}

// Human-readable label for a ReservationHolder's status — used anywhere a
// blocking/FYI conflict alert needs to say at a glance whether it's looking
// at an unapproved proposal or an already-committed pickup (Stock Out,
// and the Products page quantity-reduction check).
export function reservationStatusLabel(status: LoanRequestStatus): string {
  switch (status) {
    case 'accepted': return 'approved pickup'
    case 'countered': return 'countered offer'
    default: return 'pending request'
  }
}

// Where to send Selouna to actually clear a blocking reservation — an
// approved pickup can only be cancelled from the Dashboard's Incoming
// Pickups tab (that Cancel button doesn't live on the Loan Requests page —
// see the 2026-09-20 "Incoming Pickups consolidated onto the Dashboard"
// change), while a pending/countered proposal is resolved on the Loan
// Requests page itself. Mixed sets of holders name both, since one sentence
// pointing at the wrong page for half the holders would send her on a wild
// goose chase.
export function resolutionInstruction(holders: ReservationHolder[]): string {
  const hasAccepted = holders.some((h) => h.status === 'accepted')
  const hasPending = holders.some((h) => h.status === 'pending' || h.status === 'countered')
  const fragments: string[] = []
  if (hasAccepted) fragments.push('cancel the approved pickup(s) on the Dashboard')
  if (hasPending) fragments.push('approve, counter, or decline the pending request(s) on the Loan Requests page')
  return fragments.join(', and ')
}

// Per-product reservation window, stripped down to just what a calendar-day
// availability check needs (date range + quantity) — fetched once for every
// product in the cart (getReservationIntervals), then reused for every
// candidate day the From/To calendars ask about.
export interface ReservationInterval {
  fromDate: string
  toDate: string
  quantity: number
}

// Sum of reserved quantity across a product's fetched intervals that
// overlaps [fromDate, toDate] — the same overlap rule getReservedQuantity
// uses, just against the already-fetched list, so it's cheap enough to call
// once per calendar day.
export function reservedQuantityInRange(
  intervals: ReservationInterval[],
  fromDate: string,
  toDate: string,
): number {
  return intervals.reduce(
    (sum, iv) => (fromDate <= iv.toDate && toDate >= iv.fromDate ? sum + iv.quantity : sum),
    0,
  )
}

// Each product carries its own lending interval (Products page,
// 2026-09-20) instead of one flat app-wide MAX_LOAN_DAYS. The cart shares a
// single From/To pair across every item in it, so the binding rule for the
// whole cart is the TIGHTEST cap among its items — a mixed cart of a
// "1 Week" item and an "Indefinitely" item behaves like its most
// restrictive member, not its most lenient one. Returns null only when
// EVERY item in the cart is Indefinitely, meaning a To date isn't required
// at all. Shared between cart validation and the cart page itself
// (which needs the same number to cap the To-date picker's `max` live, as
// the cart's contents change, before ever calling validateCartDates).
export function tightestLendingCap(
  cartItems: { product: Pick<Product, 'lending_interval'> }[],
): { value: LendingInterval; label: string; days: number } | null {
  const finiteCaps = cartItems
    .map(({ product }) => lendingIntervalInfo(product.lending_interval))
    .filter((info) => info.days !== null) as { value: LendingInterval; label: string; days: number }[]
  return finiteCaps.length > 0
    ? finiteCaps.reduce((min, c) => (c.days < min.days ? c : min))
    : null
}

// Expiry: min(updated_at + 30 days, from_date). See decision #5 for
// why a flat SLA that resets on every state change is wrong — capping at
// from_date keeps a near-term request from outliving its own pickup date.
// Widened from 7 to 30 days (2026-09-20) — a week was too tight a window
// for Selouna to respond to a pending/countered request before it silently
// expired on the staff member.
export function computeExpiryDate(request: LoanRequest): string | null {
  if (request.status !== 'pending' && request.status !== 'countered') return null
  const oneMonthOut = addDaysToDateStr(appCalendarDay(request.updated_at), MAX_LOAN_DAYS)
  return oneMonthOut < request.from_date ? oneMonthOut : request.from_date
}

/** `today` is a YYYY-MM-DD calendar day in APP_TIME_ZONE (default: now), so the browser and the server agree on the day. */
export function isExpired(request: LoanRequest, today: string = appCalendarDay()): boolean {
  const expiry = computeExpiryDate(request)
  return expiry !== null && today > expiry
}

// No-show: accepted, the WHOLE approved window has passed, nothing
// issued against it. Deliberately keyed on the window's end (effectively
// "To", or "never" if the item's Indefinite — see effectiveToDate above),
// not "From" + 1 day: the reservation ledger already holds these units for
// the staff member across the entire From-To range (an accepted request
// occupies that whole window, not just its first day), so flagging no-show
// the day after From — before anyone else could even have taken the stock —
// used to bump a staff member who was simply running a few days into a
// multi-day or Indefinite pickup window. An Indefinite request (to_date
// null) never auto-flags at all, same as it never auto-expires for a
// return — that's consistent with "no forced return date" also meaning no
// forced pickup deadline; an admin can still manually Cancel it from the
// Dashboard at any time regardless.
export function isNoShowCandidate(request: LoanRequest, today: string = appCalendarDay()): boolean {
  return request.status === 'accepted' && !request.fulfilled_txn_id && today > effectiveToDate(request.to_date)
}

/**
 * One item line inside a loan-request audit snapshot (see requestAuditSnapshot in src/server/data/loanRequests.ts):
 * every audit entry for a request is a complete, self-standing snapshot of it at that moment.
 */
export type RequestSnapshotLine = {
  product_id: string
  product_name: string
  requested_quantity: number
  offered_quantity: number
}

// --- Shapes sent to and from the loan-request API --------------------------------------------------------------------

/** One cart item on the wire: the server looks the product up itself. */
export interface CartLine {
  productId: string
  quantity: number
}

export interface CartCheck {
  valid: boolean
  errors: string[]
}

export interface SubmitLoanRequestInput {
  /** Defaults to the caller's own staff record; a staff caller may only name their own. */
  staffId?: string
  cart: CartLine[]
  /** YYYY-MM-DD. */
  fromDate: string
  /** YYYY-MM-DD; blank means an open-ended loan (every item Indefinitely). */
  toDate?: string | null
  message?: string | null
}

export interface CounterInput {
  lines: { lineId: string; product_id: string; offered_quantity: number }[]
  /** Left out: the request's current From date stays. */
  fromDate?: string
  /** Left out: the current To date stays; null: open-ended. */
  toDate?: string | null
  message?: string | null
}

export interface ListRequestsOptions {
  staffId?: string
  statuses?: LoanRequestStatus[]
}

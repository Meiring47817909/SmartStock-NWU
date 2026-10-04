import 'server-only'
import { NextRequest, NextResponse } from 'next/server'
import { asc, eq } from 'drizzle-orm'
import { requireAdmin, requireSignedIn, ApiError } from '@/lib/server/staffAdmin'
import { getRouteDb } from '@/server/context'
import { toIso } from '@/server/db/client'
import { loanRequestLines, loanRequests, staff } from '@/server/db/schema'
import { isMailEnabled, MailUnreachableError, MailConfigError } from '@/lib/server/mailer'
import {
  deliver, appBaseUrl, adminInboxEmail, type DeliveryResult,
} from '@/lib/server/notificationDelivery'
import {
  loanRequestApprovedEmail, loanRequestCounteredEmail, loanRequestDeclinedEmail, pickupCancelledEmail,
  counterAcceptedEmail, counterDeclinedEmail, requestWithdrawnEmail, newLoanRequestEmail,
  incomingPickupConfirmedEmail, type RenderedEmail, type RequestEmailBase, type RequestEmailLine,
} from '@/lib/server/emailTemplates'
import { LOAN_REQUEST_EVENTS, type LoanRequestEvent } from '@/lib/notificationCatalog'
import type { LoanRequestStatus, NotificationSettingKey } from '@/types/database'

const MAX_REASON_LENGTH = 500

// The fields of the loan_requests row this route reads (timestamps as ISO strings).
interface LoanRequestDoc {
  staff_id: string
  staff_name: string
  status: string
  reference_no: string | null
  message: string | null
  admin_message: string | null
  from_date: string
  to_date: string | null
  original_from_date: string
  original_to_date: string | null
  updated_at: string
}

interface Ctx {
  request: LoanRequestDoc
  reason: string | null
  lines: RequestEmailLine[]
  staff: RequestEmailBase // staff-facing fields, button -> My Requests
  adminUrl: (path: string) => string
}

interface EmailPlan {
  toggle: NotificationSettingKey
  to: 'staff' | 'admin'
  render: (c: Ctx) => RenderedEmail
}

const confirmedForAdmin = (viaCounter: boolean): EmailPlan => ({
  toggle: 'incoming_pickup_confirmed',
  to: 'admin',
  render: (c) =>
    incomingPickupConfirmedEmail({
      staffName: c.staff.staffName, reference: c.staff.reference, fromDate: c.staff.fromDate, toDate: c.staff.toDate,
      lines: c.lines, viaCounter, buttonUrl: c.adminUrl('/dashboard'),
    }),
})

// Who may trigger each event, the status the request must be in, and the
// emails it sends. Approve-as-is vs counter-accepted both end `accepted`, and
// admin decline vs counter-declined both end `declined`, so the caller's role
// is part of the event.
const EVENTS: Record<LoanRequestEvent, { caller: 'admin' | 'borrower'; status: LoanRequestStatus; emails: EmailPlan[] }> = {
  new_loan_request: {
    caller: 'borrower', status: 'pending',
    emails: [{
      toggle: 'new_loan_request', to: 'admin',
      render: (c) => newLoanRequestEmail({
        staffName: c.staff.staffName, reference: c.staff.reference, fromDate: c.staff.fromDate, toDate: c.staff.toDate,
        lines: c.lines, message: c.request.message || null, buttonUrl: c.adminUrl('/loan-requests'),
      }),
    }],
  },
  loan_request_approved: {
    caller: 'admin', status: 'accepted',
    emails: [{ toggle: 'loan_request_approved', to: 'staff', render: (c) => loanRequestApprovedEmail(c.staff) }, confirmedForAdmin(false)],
  },
  loan_request_countered: {
    caller: 'admin', status: 'countered',
    emails: [{
      toggle: 'loan_request_countered', to: 'staff',
      render: (c) => loanRequestCounteredEmail({
        ...c.staff, originalFromDate: c.request.original_from_date ?? c.staff.fromDate,
        originalToDate: c.request.original_to_date ?? null, adminMessage: c.request.admin_message || null,
      }),
    }],
  },
  loan_request_declined: {
    caller: 'admin', status: 'declined',
    emails: [{
      toggle: 'loan_request_declined', to: 'staff',
      render: (c) => loanRequestDeclinedEmail({ ...c.staff, adminMessage: c.request.admin_message || null }),
    }],
  },
  approved_pickup_cancelled: {
    caller: 'admin', status: 'withdrawn',
    emails: [{
      toggle: 'approved_pickup_cancelled', to: 'staff',
      render: (c) => pickupCancelledEmail({ ...c.staff, reason: c.reason }),
    }],
  },
  loan_request_counter_accepted: {
    caller: 'borrower', status: 'accepted',
    emails: [{ toggle: 'loan_request_counter_accepted', to: 'staff', render: (c) => counterAcceptedEmail(c.staff) }, confirmedForAdmin(true)],
  },
  loan_request_counter_declined: {
    caller: 'borrower', status: 'declined',
    emails: [{ toggle: 'loan_request_counter_declined', to: 'staff', render: (c) => counterDeclinedEmail(c.staff) }],
  },
  loan_request_withdrawn: {
    caller: 'borrower', status: 'withdrawn',
    emails: [{ toggle: 'loan_request_withdrawn', to: 'staff', render: (c) => requestWithdrawnEmail(c.staff) }],
  },
}

/**
 * Emails about a loan-request transition. Called in the background by the
 * page that just made the transition; the transition itself never depends on
 * this succeeding, and the request is only read, never written.
 *
 * Body: { event: LoanRequestEvent, requestId: string, reason?: string }
 * Response: { results: { toggle, sent, reason? }[] } -- one entry per email the
 * event can send. Skips (toggle off, no address, duplicate, mail disabled) are
 * normal 200 results.
 */
export async function POST(request: NextRequest) {
  try {
    const { uid } = await requireSignedIn(request)

    const body = await request.json().catch(() => null)
    const event = body?.event as LoanRequestEvent
    const requestId = typeof body?.requestId === 'string' ? body.requestId : ''
    if (!LOAN_REQUEST_EVENTS.includes(event) || !requestId) {
      throw new ApiError(400, 'Missing or unknown event, or missing requestId.')
    }
    const plan = EVENTS[event]

    // Cheapest check first: with the mailer off (production) nothing is read.
    if (!isMailEnabled()) {
      return NextResponse.json({ results: [{ toggle: plan.emails[0].toggle, sent: false, reason: 'mail_disabled' }] })
    }

    // The request is only read here, never written: the page calls this after its change has committed.
    const db = getRouteDb()
    const [row] = await db.select().from(loanRequests).where(eq(loanRequests.id, requestId)).limit(1)
    if (!row) throw new ApiError(404, 'Loan request not found.')
    const req: LoanRequestDoc = { ...row, updated_at: toIso(row.updated_at) as string }

    // The staff member the request belongs to: owner check for borrower events, address for the staff emails.
    const [owner] = await db.select({ uid: staff.uid, email: staff.email }).from(staff).where(eq(staff.id, req.staff_id)).limit(1)
    if (plan.caller === 'admin') {
      await requireAdmin(request)
    } else if (owner?.uid !== uid) {
      throw new ApiError(403, 'Only the staff member who owns this request can do that.')
    }
    if (req.status !== plan.status) throw new ApiError(409, 'The request is not in the state this event expects.')

    // In cart order.
    const lineRows = await db
      .select({
        product_name: loanRequestLines.product_name,
        requested_quantity: loanRequestLines.requested_quantity,
        offered_quantity: loanRequestLines.offered_quantity,
      })
      .from(loanRequestLines)
      .where(eq(loanRequestLines.request_id, requestId))
      .orderBy(asc(loanRequestLines.line_no), asc(loanRequestLines.id))
    const lines: RequestEmailLine[] = lineRows.map((l) => ({
      productName: l.product_name ?? 'Item',
      requested: Number(l.requested_quantity ?? 0),
      offered: Number(l.offered_quantity ?? l.requested_quantity ?? 0),
    }))

    const base = appBaseUrl()
    const reason = typeof body?.reason === 'string' ? body.reason.trim().slice(0, MAX_REASON_LENGTH) || null : null
    const ctx: Ctx = {
      request: req, reason, lines,
      staff: {
        staffName: req.staff_name || 'there', reference: req.reference_no ?? null, fromDate: req.from_date,
        toDate: req.to_date ?? null, lines, buttonUrl: `${base}/lend/requests`,
      },
      adminUrl: (path) => `${base}${path}`,
    }

    // Each email is checked, deduped and sent on its own: one failing does not
    // stop the other, and the first failure is reported after all were tried.
    const results: DeliveryResult[] = []
    let firstError: unknown = null
    for (const email of plan.emails) {
      try {
        results.push(await deliver({
          toggle: email.toggle,
          dedupeKey: `${email.toggle}__${requestId}__${req.updated_at}`,
          recipient: async () => (email.to === 'staff' ? (owner?.email ?? '').trim() : adminInboxEmail()),
          render: async () => email.render(ctx),
        }))
      } catch (err) {
        firstError ??= err
      }
    }
    if (firstError) throw firstError
    return NextResponse.json({ results })
  } catch (err) {
    if (err instanceof ApiError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    if (err instanceof MailUnreachableError) {
      return NextResponse.json(
        { error: 'Mail server not reachable. Is Mailpit running? (npm run mailpit)' },
        { status: 502 },
      )
    }
    if (err instanceof MailConfigError) {
      return NextResponse.json({ error: err.message }, { status: 500 })
    }
    console.error('loan-request notification failed:', err)
    return NextResponse.json({ error: 'Failed to send the notification email.' }, { status: 500 })
  }
}

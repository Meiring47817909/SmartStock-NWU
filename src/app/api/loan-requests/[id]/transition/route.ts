import { route } from '@/server/http'
import { DataError } from '@/server/context'
import {
  acceptCounter,
  approveAsIs,
  declineCounter,
  declineRequest,
  expireIfNeeded,
  sendCounter,
  withdrawRequest,
} from '@/server/data/loanRequests'
import type { CounterInput } from '@/lib/loanRequestRules'

// One status change of one request, one database transaction each (the request, any line edits and its audit entry).
// The data functions enforce who may do what and from which status (409 "This request has already changed — reload to
// see its current state." when it is no longer in the status the action needs).
//   POST { action: 'approve' }                       → LoanRequest   (admin; from pending)
//   POST { action: 'counter', ...CounterInput }      → LoanRequest   (admin; from pending)
//   POST { action: 'decline', message? }             → LoanRequest   (admin; from pending or countered)
//   POST { action: 'acceptCounter' }                 → LoanRequest   (the request's own staff member; from countered)
//   POST { action: 'declineCounter' }                → LoanRequest   (the request's own staff member; from countered)
//   POST { action: 'withdraw', reason? }             → LoanRequest   (own staff member, or an admin cancelling a pickup; pending/countered/accepted)
//   POST { action: 'expire' }                        → { status }    (the lazy expiry / no-show pass; recorded as the system)
// The emails for these (POST /api/notifications/loan-request) are separate calls the pages make after the change commits.
type Body = { action?: string; message?: string | null; reason?: string | null } & Partial<CounterInput>

export const POST = route<Body>('signed-in', async (ctx, body, _req, params) => {
  const id = params.id
  switch (body.action) {
    case 'approve':
      return approveAsIs(ctx, id)
    case 'counter':
      return sendCounter(ctx, id, body as CounterInput)
    case 'decline':
      return declineRequest(ctx, id, body.message)
    case 'acceptCounter':
      return acceptCounter(ctx, id)
    case 'declineCounter':
      return declineCounter(ctx, id)
    case 'withdraw':
      return withdrawRequest(ctx, id, body.reason)
    case 'expire':
      return { status: await expireIfNeeded(ctx, id) }
    default:
      throw new DataError(400, 'Unknown action.')
  }
})

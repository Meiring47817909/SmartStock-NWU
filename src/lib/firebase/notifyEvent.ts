import type { User } from 'firebase/auth'
import { toast } from 'sonner'
import { postStaffAdmin } from '@/lib/firebase/staff'
import type { LoanRequestEvent } from '@/lib/notificationCatalog'

/**
 * Asks the server to send the emails for a loan-request transition that just
 * succeeded (see api/notifications/loan-request). Fire and forget: it never
 * throws, the caller must not await anything, and the transition is already
 * saved whatever happens here. Only a real failure (for example Mailpit not
 * running) shows a toast; skips such as a toggle being off are silent.
 *
 * `reason` is only used by 'approved_pickup_cancelled' (the Dashboard's
 * optional cancel reason, which is not stored on the request itself).
 */
export function notifyLoanRequestEvent(
  user: User | null | undefined,
  event: LoanRequestEvent,
  requestId: string,
  extra?: { reason?: string | null },
): void {
  if (!user) return
  const reason = extra?.reason?.trim()
  void Promise.resolve()
    .then(() => postStaffAdmin('/api/notifications/loan-request', user, { event, requestId, ...(reason ? { reason } : {}) }))
    .catch(() => {
      toast.error("Saved, but the email couldn't be sent.")
    })
}

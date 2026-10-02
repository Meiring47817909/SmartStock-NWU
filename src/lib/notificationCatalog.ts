import type { NotificationSettingKey } from '@/types/database'

// Pure and client-safe (no Firebase, no server-only): shared by the Settings
// page, the client notify helper and the server routes.

// The loan-request transitions that can send email. The event name, plus who
// called, decides which emails go out (see api/notifications/loan-request).
export type LoanRequestEvent =
  | 'new_loan_request'
  | 'loan_request_approved'
  | 'loan_request_countered'
  | 'loan_request_declined'
  | 'approved_pickup_cancelled'
  | 'loan_request_counter_accepted'
  | 'loan_request_counter_declined'
  | 'loan_request_withdrawn'

export const LOAN_REQUEST_EVENTS: readonly LoanRequestEvent[] = [
  'new_loan_request',
  'loan_request_approved',
  'loan_request_countered',
  'loan_request_declined',
  'approved_pickup_cancelled',
  'loan_request_counter_accepted',
  'loan_request_counter_declined',
  'loan_request_withdrawn',
]

// These three need a timer (expiry sweep, overdue scan, stock re-check) that
// does not exist yet. They are always off: the Settings page refuses to turn
// them on and the server never sends them, whatever Firestore holds.
export const UNIMPLEMENTED_NOTIFICATIONS: ReadonlySet<NotificationSettingKey> = new Set<NotificationSettingKey>([
  'loan_request_expired',
  'overdue_return_alert',
  'insufficient_pickup_alert',
])

export function isNotificationImplemented(key: NotificationSettingKey): boolean {
  return !UNIMPLEMENTED_NOTIFICATIONS.has(key)
}

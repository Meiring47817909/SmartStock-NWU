import type { NotificationSettingKey } from '@/types/database'
import { isNotificationImplemented } from '@/lib/notificationCatalog'

// Pure and client-safe (no database, no Firebase, no server-only): the
// definitions, defaults and validation shared by the Settings page and the
// server. The stored values live in the PostgreSQL `settings` table (see
// src/server/data/settings.ts); the browser reaches them through
// src/lib/api/settings.ts.

// Singleton row -- one operational inbox (Selouna's) and one lending-portal
// audience to notify, not one set of preferences per admin. This is the
// `settings.key` the values are stored under, and the audit entity id.
export const NOTIFICATION_SETTINGS_KEY = 'notifications'

export interface NotificationEmailDefinition {
  key: NotificationSettingKey
  label: string
  recipient: 'Staff member' | 'Administrators'
  description: string
  // false for emails that need a timer that doesn't exist yet -- the Settings
  // page shows "Not implemented yet" and refuses to turn them on.
  implemented?: boolean
  // For the emails that are not built: what is still missing, shown under the
  // description on the Settings page.
  requirement?: string
}

// One row per email the app can eventually send -- mirrors the "Full
// catalog" table worked out in the email-notifications review, grouped
// here by who receives it so the Settings page can render two sections.
//
// The Send/Resend Login Email password-reset message is deliberately NOT
// listed here: it already goes out through Firebase Auth's own built-in
// email flow (see api/staff/send-reset-email/route.ts), not through this
// app's own notification pipeline, so there's nothing here for a toggle
// to gate.
const DEFINITIONS: NotificationEmailDefinition[] = [
  {
    key: 'stock_out_confirmation',
    label: 'Stock Out confirmation',
    recipient: 'Staff member',
    description:
      "Email the staff member every time they're issued equipment at Stock Out — walk-in or loan-linked. Lists what they took, how many, and the return date, so they have a record in their inbox alongside the paper trail here.",
  },
  {
    key: 'loan_request_approved',
    label: 'Loan request approved',
    recipient: 'Staff member',
    description:
      'Email a staff member the moment an administrator approves their loan request exactly as they submitted it — items, quantities, and the confirmed pickup window.',
  },
  {
    key: 'loan_request_countered',
    label: 'Loan request countered',
    recipient: 'Staff member',
    description:
      "Email a staff member when an administrator adjusts their request instead of approving it outright — what changed, item by item, plus their optional note — so they know to check the portal and accept or decline.",
  },
  {
    key: 'loan_request_declined',
    label: 'Loan request declined',
    recipient: 'Staff member',
    description:
      'Email a staff member when an administrator declines their loan request, including their optional reason if one was left.',
  },
  {
    key: 'approved_pickup_cancelled',
    label: 'Approved pickup cancelled',
    recipient: 'Staff member',
    description:
      "Email a staff member if an administrator cancels a pickup they already approved. If the administrator leaves a reason when cancelling, it is included so the staff member knows why.",
  },
  {
    key: 'loan_request_expired',
    label: 'Loan request expired',
    recipient: 'Staff member',
    description:
      "Email a staff member when their loan request times out unanswered — nobody approved, countered or declined it in time. This is already recorded in the Audit Log regardless of whether this email is on.",
    requirement:
      "Needs a scheduled job before it can be turned on. A request is only marked expired when someone opens the app, so a separate scheduled service (a cron job) has to check for expired requests every day and send this email.",
  },
  {
    key: 'loan_request_counter_accepted',
    label: 'Counter offer accepted',
    recipient: 'Staff member',
    description:
      'Email a staff member a confirmation right after they accept a counter-offer, so they have a record in their inbox of exactly what they agreed to — items, quantities, and the confirmed pickup window.',
  },
  {
    key: 'loan_request_counter_declined',
    label: 'Counter offer declined',
    recipient: 'Staff member',
    description:
      "Email a staff member a confirmation right after they decline a counter-offer, so they have a record that the request is now closed rather than wondering if the click went through.",
  },
  {
    key: 'loan_request_withdrawn',
    label: 'Loan request withdrawn',
    recipient: 'Staff member',
    description:
      "Email a staff member a confirmation right after they withdraw one of their own requests, so they have a record that it's cancelled and the reservation released.",
  },
  {
    key: 'new_loan_request',
    label: 'New loan request',
    recipient: 'Administrators',
    description:
      'Email Administrators whenever a staff member submits a new loan request, so they can review it without needing to check the portal on a schedule.',
  },
  {
    key: 'incoming_pickup_confirmed',
    label: 'Incoming pickup confirmed',
    recipient: 'Administrators',
    description:
      'Email Administrators whenever a request is newly confirmed as a pickup — whether they approved it as-is or a staff member accepted their counter-offer.',
  },
  {
    key: 'overdue_return_alert',
    label: 'Overdue return alert',
    recipient: 'Administrators',
    description:
      'Email Administrators the first time an issued item passes its return date without being returned. Sent once per item, right when it first turns overdue — not repeated daily while it stays that way.',
    requirement:
      'Needs a scheduled job before it can be turned on. Nothing in the app runs when nobody is signed in, so a separate scheduled service (a cron job) has to check every day for items past their return date and send this email once per item.',
  },
  {
    key: 'low_stock_alert',
    label: 'Low stock / out of stock alert',
    recipient: 'Administrators',
    description:
      "Email Administrators whenever a product's stock drops to or below its reorder threshold, or runs out completely. Several products crossing at once (e.g. from one Stock Out) are listed together in a single email.",
  },
  {
    key: 'insufficient_pickup_alert',
    label: 'Incoming pickup insufficient stock',
    recipient: 'Administrators',
    description:
      'Email Administrators when an already-approved pickup no longer has enough stock to fulfil — most often because a same-product return is overdue. Names the shortfall and the likely cause.',
    requirement:
      'Needs a scheduled job before it can be turned on. A separate scheduled service (a cron job) has to check every day whether approved pickups still have enough stock and send this email when one falls short.',
  },
]

export const NOTIFICATION_EMAIL_DEFINITIONS: NotificationEmailDefinition[] = DEFINITIONS.map((d) => ({
  ...d,
  implemented: isNotificationImplemented(d.key),
}))

// Every email that has a trigger defaults to on. The three that still need a
// timer (see notificationCatalog.ts) default to off and cannot be turned on.
export const DEFAULT_NOTIFICATION_SETTINGS: Record<NotificationSettingKey, boolean> = Object.fromEntries(
  NOTIFICATION_EMAIL_DEFINITIONS.map((d) => [d.key, isNotificationImplemented(d.key)]),
) as Record<NotificationSettingKey, boolean>

// The toggles as stored (`data` is the stored settings object, if any): a
// missing or non-boolean value falls back to the default, and an unbuilt email
// is always off even if a leftover `true` is stored from before it was
// switched off.
export function resolveNotificationSettings(data: Record<string, unknown> | null | undefined): Record<NotificationSettingKey, boolean> {
  const result = { ...DEFAULT_NOTIFICATION_SETTINGS }
  if (!data) return result
  for (const key of Object.keys(DEFAULT_NOTIFICATION_SETTINGS) as NotificationSettingKey[]) {
    if (typeof data[key] === 'boolean') result[key] = data[key] as boolean
  }
  // A leftover `true` from before these were switched off must not show as on.
  for (const key of Object.keys(result) as NotificationSettingKey[]) {
    if (!isNotificationImplemented(key)) result[key] = false
  }
  return result
}

// A simple RFC-5322-ish check -- good enough to catch a typo, not a full
// validator (Firebase's own APIs, once wired up, will reject anything this
// misses anyway).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export type AddressField = 'admin_notification_email' | 'system_from_email'

// The audit label of each address field.
export const ADDRESS_LABELS: Record<AddressField, string> = {
  admin_notification_email: 'Admin notification email',
  system_from_email: 'System sending email',
}

// An address field as stored: a string, or '' when nothing is saved.
export function storedAddress(data: Record<string, unknown> | null | undefined, field: AddressField): string {
  const value = data?.[field]
  return typeof value === 'string' ? value : ''
}

export const INVALID_ADDRESS_MESSAGE = 'Enter a valid email address.'

// The trimmed address to save ('' clears it), or null when it is not a valid
// address -- the caller refuses with INVALID_ADDRESS_MESSAGE so the Settings
// page's form shows it inline.
export function validatedAddress(email: string): string | null {
  const trimmed = email.trim()
  return trimmed && !EMAIL_RE.test(trimmed) ? null : trimmed
}

// The label shown in the audit entry for one toggle.
export function notificationLabel(key: NotificationSettingKey): string {
  return NOTIFICATION_EMAIL_DEFINITIONS.find((d) => d.key === key)?.label ?? key
}

export function isNotificationKey(key: unknown): key is NotificationSettingKey {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(DEFAULT_NOTIFICATION_SETTINGS, key)
}

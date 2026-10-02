import { db } from './config'
import { doc, getDoc, setDoc } from 'firebase/firestore'
import { logAudit } from './audit'
import type { NotificationSettingKey } from '@/types/database'
import { isNotificationImplemented } from '@/lib/notificationCatalog'

// Singleton doc -- one operational inbox (Selouna's) and one lending-portal
// audience to notify, not one set of preferences per admin.
export const NOTIFICATION_SETTINGS_DOC_ID = 'notifications'

export interface NotificationEmailDefinition {
  key: NotificationSettingKey
  label: string
  recipient: 'Staff member' | 'Administrators'
  description: string
  // false for emails that need a timer that doesn't exist yet -- the Settings
  // page shows "Not implemented yet" and refuses to turn them on.
  implemented?: boolean
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

export async function loadNotificationSettings(): Promise<Record<NotificationSettingKey, boolean>> {
  const snap = await getDoc(doc(db, 'settings', NOTIFICATION_SETTINGS_DOC_ID))
  const result = { ...DEFAULT_NOTIFICATION_SETTINGS }
  if (!snap.exists()) return result
  const data = snap.data()
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

export async function loadAdminNotificationEmail(): Promise<string> {
  const snap = await getDoc(doc(db, 'settings', NOTIFICATION_SETTINGS_DOC_ID))
  if (!snap.exists()) return ''
  const data = snap.data()
  return typeof data.admin_notification_email === 'string' ? data.admin_notification_email : ''
}

// Resolves the open question flagged in the email-notifications review --
// "who actually receives Selouna's emails" -- with the simpler of the two
// options discussed there: one fixed, admin-editable address rather than a
// query over every profiles doc with role admin. Throws (rather than
// silently rejecting) on an invalid address so the Settings page's form can
// show the same message inline instead of swallowing it.
export async function saveAdminNotificationEmail(
  email: string,
  previousEmail: string,
  actor: { uid?: string | null; name?: string | null },
): Promise<void> {
  const trimmed = email.trim()
  if (trimmed && !EMAIL_RE.test(trimmed)) {
    throw new Error('Enter a valid email address.')
  }
  const now = new Date().toISOString()
  await setDoc(
    doc(db, 'settings', NOTIFICATION_SETTINGS_DOC_ID),
    {
      admin_notification_email: trimmed || null,
      updated_at: now,
      updated_by_uid: actor.uid ?? null,
      updated_by_name: actor.name ?? null,
    },
    { merge: true },
  )
  logAudit({
    userId: actor.uid,
    userName: actor.name,
    action: 'update',
    entityType: 'settings',
    entityId: NOTIFICATION_SETTINGS_DOC_ID,
    before: { admin_notification_email: previousEmail || null, label: 'Admin notification email' },
    after: { admin_notification_email: trimmed || null, label: 'Admin notification email' },
  })
}

// Flips exactly one toggle, merged into whatever's already stored (so
// flipping one setting never clobbers a concurrent change to another), and
// audits it against the same singleton entity id every time —
// 'settings'/'notifications' — so every change to this doc shows up
// together in the Audit Log (filter to Settings, or expand any entry).
export async function setNotificationSetting(
  key: NotificationSettingKey,
  value: boolean,
  previousValue: boolean,
  actor: { uid?: string | null; name?: string | null },
): Promise<void> {
  const now = new Date().toISOString()
  await setDoc(
    doc(db, 'settings', NOTIFICATION_SETTINGS_DOC_ID),
    { [key]: value, updated_at: now, updated_by_uid: actor.uid ?? null, updated_by_name: actor.name ?? null },
    { merge: true },
  )
  const label = NOTIFICATION_EMAIL_DEFINITIONS.find((d) => d.key === key)?.label ?? key
  logAudit({
    userId: actor.uid,
    userName: actor.name,
    action: 'update',
    entityType: 'settings',
    entityId: NOTIFICATION_SETTINGS_DOC_ID,
    before: { [key]: previousValue, label },
    after: { [key]: value, label },
  })
}

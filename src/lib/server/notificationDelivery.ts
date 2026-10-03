import 'server-only'
import { adminDb } from '@/lib/firebase/admin'
import { sendMail } from '@/lib/server/mailer'
import type { RenderedEmail } from '@/lib/server/emailTemplates'
import { isNotificationImplemented } from '@/lib/notificationCatalog'
import type { NotificationSettingKey } from '@/types/database'

// Shared by the notification routes: decides whether ONE email goes out
// (toggle, recipient, duplicate) and sends it. A skip is a normal result, never
// an error; only a failed render or send throws.

export type SkipReason = 'mail_disabled' | 'toggle_off' | 'no_email' | 'duplicate' | 'not_implemented'

export interface DeliveryResult {
  toggle: NotificationSettingKey
  sent: boolean
  reason?: SkipReason
}

const DEFAULT_APP_BASE_URL = 'http://localhost:3000'

// Where email buttons point. Trailing slashes are stripped so callers can
// append '/lend/requests' directly.
export function appBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.APP_BASE_URL ?? '').trim()
  return (raw || DEFAULT_APP_BASE_URL).replace(/\/+$/, '')
}

export async function staffEmailFor(staffId: string): Promise<string> {
  const snap = await adminDb.collection('staff').doc(staffId).get()
  const email = snap.data()?.email
  return typeof email === 'string' ? email.trim() : ''
}

export async function adminInboxEmail(): Promise<string> {
  const snap = await adminDb.collection('settings').doc('notifications').get()
  const email = snap.data()?.admin_notification_email
  return typeof email === 'string' ? email.trim() : ''
}

// The saved system sending address becomes the From header of every email, shown as
// "SmartStock NWU <address>". Anything that is not a plain address (angle
// brackets, quotes, whitespace, commas) is ignored so it can never break or
// inject into the header; the mailer then falls back to MAIL_FROM.
const SAFE_ADDRESS = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/

// The trimmed address when it is a plain, safe email address; otherwise undefined.
export function safeAddress(address: unknown): string | undefined {
  const trimmed = typeof address === 'string' ? address.trim() : ''
  return SAFE_ADDRESS.test(trimmed) ? trimmed : undefined
}

export function fromHeaderFor(address: unknown): string | undefined {
  const safe = safeAddress(address)
  return safe ? `SmartStock NWU <${safe}>` : undefined
}

// Read from its own field, never from the administrator inbox address.
export async function systemFromAddress(): Promise<string | undefined> {
  const snap = await adminDb.collection('settings').doc('notifications').get()
  return fromHeaderFor(snap.data()?.system_from_email)
}

function isAlreadyExists(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown }
  return e?.code === 6 || e?.code === 'already-exists' || /ALREADY_EXISTS/.test(String(e?.message ?? ''))
}

// Order: unbuilt toggle, toggle off, recipient, duplicate marker, render, send.
// The marker is written BEFORE sending so two simultaneous calls cannot both
// send; if rendering or sending then fails it is removed so a retry can send.
export async function deliver(opts: {
  toggle: NotificationSettingKey
  dedupeKey: string
  recipient: () => Promise<string>
  render: () => Promise<RenderedEmail>
}): Promise<DeliveryResult> {
  const { toggle, dedupeKey } = opts
  const skip = (reason: SkipReason): DeliveryResult => ({ toggle, sent: false, reason })

  if (!isNotificationImplemented(toggle)) return skip('not_implemented')

  // Missing or any non-false value means on, matching DEFAULT_NOTIFICATION_SETTINGS.
  const settingsSnap = await adminDb.collection('settings').doc('notifications').get()
  if (settingsSnap.data()?.[toggle] === false) return skip('toggle_off')

  const to = (await opts.recipient()).trim()
  if (!to) return skip('no_email')

  const marker = adminDb.collection('sent_notifications').doc(dedupeKey)
  try {
    await marker.create({
      toggle,
      entity_id: dedupeKey.slice(dedupeKey.indexOf('__') + 2),
      created_at: new Date().toISOString(),
    })
  } catch (err) {
    if (isAlreadyExists(err)) return skip('duplicate')
    throw err
  }

  const release = () =>
    marker.delete().catch((e: unknown) => console.error('could not remove notification marker', dedupeKey, e))

  try {
    const { subject, html, text } = await opts.render()
    if (!(await sendMail({ to, subject, html, text, from: fromHeaderFor(settingsSnap.data()?.system_from_email) }))) {
      await release()
      return skip('mail_disabled')
    }
  } catch (err) {
    await release()
    throw err
  }
  return { toggle, sent: true }
}

import 'server-only'
import { eq } from 'drizzle-orm'
import { getRouteDb } from '@/server/context'
import type { Db, Tx } from '@/server/db/client'
import { sentNotifications } from '@/server/db/schema'
import { getSettingsRow } from '@/server/data/settings'
import { NOTIFICATION_SETTINGS_KEY } from '@/lib/notificationSettingsRules'
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

// The Admin notification address, trimmed ('' when none is saved).
export async function adminInboxEmail(db: Db | Tx = getRouteDb()): Promise<string> {
  const email = (await getSettingsRow(db, NOTIFICATION_SETTINGS_KEY))?.admin_notification_email
  return typeof email === 'string' ? email.trim() : ''
}

// The saved system sending address becomes the From header of every email, shown as
// "SmartStock <address>". Anything that is not a plain address (angle
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
  return safe ? `SmartStock <${safe}>` : undefined
}

// Read from its own field, never from the administrator inbox address.
export async function systemFromAddress(db: Db | Tx = getRouteDb()): Promise<string | undefined> {
  return fromHeaderFor((await getSettingsRow(db, NOTIFICATION_SETTINGS_KEY))?.system_from_email)
}

// The sent_notifications marker: "this email was already sent (or is being sent)". Claiming is one INSERT ... ON
// CONFLICT DO NOTHING that commits on its own BEFORE the send, so two simultaneous calls cannot both send: only the
// one that inserted the row (returns true) goes on. `key` is `<toggle>__<entity>`; the entity part is stored as well.
export async function claimNotificationMarker(db: Db | Tx, key: string, toggle: string): Promise<boolean> {
  const inserted = await db
    .insert(sentNotifications)
    .values({ key, toggle, entity_id: key.slice(key.indexOf('__') + 2) })
    .onConflictDoNothing()
    .returning({ key: sentNotifications.key })
  return inserted.length > 0
}

// Removes a marker so a retry can send. Never throws: it only runs while another error is already being reported.
export async function releaseNotificationMarker(db: Db | Tx, key: string): Promise<void> {
  try {
    await db.delete(sentNotifications).where(eq(sentNotifications.key, key))
  } catch (e) {
    console.error('could not remove notification marker', key, e)
  }
}

// Order: unbuilt toggle, toggle off, recipient, duplicate marker, render, send.
// The marker is committed BEFORE sending so two simultaneous calls cannot both
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

  const db = getRouteDb()
  const settingsRow = await getSettingsRow(db, NOTIFICATION_SETTINGS_KEY)
  // Missing or any non-false value means on, matching DEFAULT_NOTIFICATION_SETTINGS.
  if (settingsRow?.[toggle] === false) return skip('toggle_off')

  const to = (await opts.recipient()).trim()
  if (!to) return skip('no_email')

  if (!(await claimNotificationMarker(db, dedupeKey, toggle))) return skip('duplicate')

  try {
    const { subject, html, text } = await opts.render()
    if (!(await sendMail({ to, subject, html, text, from: fromHeaderFor(settingsRow?.system_from_email) }))) {
      await releaseNotificationMarker(db, dedupeKey)
      return skip('mail_disabled')
    }
  } catch (err) {
    await releaseNotificationMarker(db, dedupeKey)
    throw err
  }
  return { toggle, sent: true }
}

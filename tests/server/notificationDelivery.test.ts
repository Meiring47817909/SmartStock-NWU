// deliver() and its helpers (src/lib/server/notificationDelivery.ts). Port of the scratch harness check-delivery.mts: the
// settings row and the sent_notifications markers are in the test PostgreSQL database, mail goes to a local SMTP sink.
import { sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { setDbForTests } from '@/server/context'
import type { Db } from '@/server/db/client'
import { sentNotifications } from '@/server/db/schema'
import { MailUnreachableError } from '@/lib/server/mailer'
import {
  adminInboxEmail,
  appBaseUrl,
  claimNotificationMarker,
  deliver,
  fromHeaderFor,
  releaseNotificationMarker,
  systemFromAddress,
} from '@/lib/server/notificationDelivery'
import { closeTestDb, resetTestDb } from '../helpers/db'
import { markerKeys, putNotificationSettings } from '../helpers/settings'
import { deadPort, fakeEnv, saveMailEnv, setMailEnv, startMailSink, type MailSink } from '../helpers/smtp'

let db: Db
let sink: MailSink
let dead: number
let restoreEnv: () => void
const sent = () => sink.sent

const mail = { subject: 'Subject', html: '<p>x</p>', text: 'x' }
const KEY = 'loan_request_approved__r1__2026-10-07T10:00:00.000Z'
let called = 0
const opts = (over: Record<string, unknown> = {}) => ({
  toggle: 'loan_request_approved' as const,
  dedupeKey: KEY,
  recipient: async () => {
    called++
    return 'jessica@example.com'
  },
  render: async () => mail,
  ...over,
})

beforeAll(async () => {
  restoreEnv = saveMailEnv()
  db = await resetTestDb()
  setDbForTests(db)
  sink = await startMailSink()
  dead = await deadPort()
})
afterAll(async () => {
  await sink.close()
  setDbForTests(null)
  restoreEnv()
  await closeTestDb()
})
beforeEach(async () => {
  called = 0
  sink.sent.length = 0
  await db.delete(sentNotifications)
  await putNotificationSettings(db, null)
  setMailEnv({ MAIL_TRANSPORT: 'smtp', SMTP_PORT: String(sink.port) })
})
afterEach(() => setDbForTests(db))

describe('appBaseUrl', () => {
  it('default and trailing slash stripped', () => {
    expect(appBaseUrl(fakeEnv())).toBe('http://localhost:3000')
    expect(appBaseUrl(fakeEnv({ APP_BASE_URL: 'https://x.test/' }))).toBe('https://x.test')
    expect(appBaseUrl(fakeEnv({ APP_BASE_URL: '  ' }))).toBe('http://localhost:3000')
  })
})

describe('deliver', () => {
  it('unbuilt toggle with true in the settings -> not_implemented, no marker, recipient never looked up', async () => {
    await putNotificationSettings(db, { loan_request_expired: true })
    const r = await deliver(opts({ toggle: 'loan_request_expired' }))
    expect(r).toEqual({ toggle: 'loan_request_expired', sent: false, reason: 'not_implemented' })
    expect(await markerKeys(db)).toEqual([])
    expect(called).toBe(0)
    expect(sent()).toHaveLength(0)
  })

  it('toggle explicitly false -> toggle_off, nothing created or sent', async () => {
    await putNotificationSettings(db, { loan_request_approved: false })
    const r = await deliver(opts())
    expect(r).toEqual({ toggle: 'loan_request_approved', sent: false, reason: 'toggle_off' })
    expect(await markerKeys(db)).toEqual([])
    expect(sent()).toHaveLength(0)
  })

  it('blank recipient -> no_email, no marker', async () => {
    const r = await deliver(opts({ recipient: async () => '' }))
    expect(r).toEqual({ toggle: 'loan_request_approved', sent: false, reason: 'no_email' })
    expect(await markerKeys(db)).toEqual([])
  })

  it('happy path (toggle missing counts as on): one email, one marker with the key', async () => {
    const r = await deliver(opts())
    expect(r).toEqual({ toggle: 'loan_request_approved', sent: true })
    expect(sent()).toHaveLength(1)
    expect((sent()[0].to as { value: { address: string }[] }).value[0].address).toBe('jessica@example.com')
    expect(sent()[0].subject).toBe('Subject')
    const [marker] = await db.select().from(sentNotifications)
    expect(marker.key).toBe(KEY)
    expect(marker.toggle).toBe('loan_request_approved')
    expect(marker.entity_id).toBe('r1__2026-10-07T10:00:00.000Z')
    expect(marker.created_at).toBeInstanceOf(Date)
  })

  it('the marker is already committed (visible from another connection) while the email is being rendered and sent', async () => {
    let seenDuringRender: string[] = []
    await deliver(
      opts({
        render: async () => {
          seenDuringRender = await markerKeys(db)
          return mail
        },
      }),
    )
    expect(seenDuringRender).toEqual([KEY])
  })

  it('same dedupeKey twice -> second is duplicate, still one email', async () => {
    await deliver(opts())
    const r = await deliver(opts())
    expect(r).toEqual({ toggle: 'loan_request_approved', sent: false, reason: 'duplicate' })
    expect(sent()).toHaveLength(1)
  })

  it('two simultaneous calls for the same transition -> exactly one email, the other is duplicate', async () => {
    const [a, b] = await Promise.all([deliver(opts()), deliver(opts())])
    expect([a.sent, b.sent].sort()).toEqual([false, true])
    expect([a, b].find((r) => !r.sent)?.reason).toBe('duplicate')
    expect(sent()).toHaveLength(1)
  })

  it('many simultaneous calls -> still exactly one email', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => deliver(opts())))
    expect(results.filter((r) => r.sent)).toHaveLength(1)
    expect(results.filter((r) => r.reason === 'duplicate')).toHaveLength(7)
    expect(sent()).toHaveLength(1)
  })

  it('a different updated_at is a new transition and sends again', async () => {
    await deliver(opts())
    const r = await deliver(opts({ dedupeKey: 'loan_request_approved__r1__2026-10-08T10:00:00.000Z' }))
    expect(r.sent).toBe(true)
    expect(sent()).toHaveLength(2)
  })

  it('send failure -> rejects with MailUnreachableError, marker removed, retry then sends', async () => {
    setMailEnv({ MAIL_TRANSPORT: 'smtp', SMTP_PORT: String(dead) })
    await expect(deliver(opts())).rejects.toBeInstanceOf(MailUnreachableError)
    expect(await markerKeys(db), 'marker must be removed').toEqual([])
    process.env.SMTP_PORT = String(sink.port)
    const r = await deliver(opts())
    expect(r.sent).toBe(true)
    expect(sent()).toHaveLength(1)
  })

  it('render throws -> marker removed and the error rethrown', async () => {
    await expect(
      deliver(
        opts({
          render: async () => {
            throw new Error('boom')
          },
        }),
      ),
    ).rejects.toThrow('boom')
    expect(await markerKeys(db)).toEqual([])
  })

  it('mail disabled -> mail_disabled and the marker is released, so it sends once the mailer is on', async () => {
    setMailEnv({})
    expect(await deliver(opts())).toEqual({ toggle: 'loan_request_approved', sent: false, reason: 'mail_disabled' })
    expect(await markerKeys(db)).toEqual([])
    setMailEnv({ MAIL_TRANSPORT: 'smtp', SMTP_PORT: String(sink.port) })
    expect((await deliver(opts())).sent).toBe(true)
  })

  it('marker delete failing does not mask the original send error', async () => {
    setMailEnv({ MAIL_TRANSPORT: 'smtp', SMTP_PORT: String(dead) })
    await db.execute(sql`create function fail_marker_delete() returns trigger language plpgsql as $$ begin raise exception 'delete refused'; end $$`)
    await db.execute(sql`create trigger fail_marker_delete before delete on sent_notifications for each row execute function fail_marker_delete()`)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(deliver(opts())).rejects.toBeInstanceOf(MailUnreachableError)
      // The failed release is logged, not thrown.
      expect(consoleError).toHaveBeenCalledWith('could not remove notification marker', expect.any(String), expect.anything())
    } finally {
      consoleError.mockRestore()
      await db.execute(sql`drop trigger fail_marker_delete on sent_notifications`)
      await db.execute(sql`drop function fail_marker_delete()`)
    }
  })
})

describe('markers', () => {
  it('claimNotificationMarker: first claim wins, the second gets false; release lets it be claimed again', async () => {
    expect(await claimNotificationMarker(db, 'password_reset__abc__1', 'password_reset')).toBe(true)
    expect(await claimNotificationMarker(db, 'password_reset__abc__1', 'password_reset')).toBe(false)
    const [row] = await db.select().from(sentNotifications)
    expect(row).toMatchObject({ key: 'password_reset__abc__1', toggle: 'password_reset', entity_id: 'abc__1' })
    await releaseNotificationMarker(db, 'password_reset__abc__1')
    expect(await claimNotificationMarker(db, 'password_reset__abc__1', 'password_reset')).toBe(true)
  })
})

describe('settings-backed helpers', () => {
  it('adminInboxEmail trims; unset -> empty string', async () => {
    await putNotificationSettings(db, { admin_notification_email: '  selouna@nwu.test ' })
    expect(await adminInboxEmail()).toBe('selouna@nwu.test')
    await putNotificationSettings(db, {})
    expect(await adminInboxEmail()).toBe('')
    await putNotificationSettings(db, null)
    expect(await adminInboxEmail()).toBe('')
    await putNotificationSettings(db, { admin_notification_email: null })
    expect(await adminInboxEmail()).toBe('')
  })

  it('fromHeaderFor: a valid address becomes "SmartStock <address>"; anything unsafe or missing -> undefined', () => {
    expect(fromHeaderFor('selouna@nwu.test')).toBe('SmartStock <selouna@nwu.test>')
    expect(fromHeaderFor('  selouna@nwu.test  ')).toBe('SmartStock <selouna@nwu.test>')
    for (const bad of ['', '   ', undefined, null, 5, 'not an email', 'a<b@c.test', 'a b@c.test', 'x@y', 'a@b.test>\r\nBcc: z@z.test', '"x"@c.test']) {
      expect(fromHeaderFor(bad), String(bad)).toBeUndefined()
    }
  })

  it('systemFromAddress reads the saved system address (not the admin inbox); unset -> undefined', async () => {
    await putNotificationSettings(db, { system_from_email: ' system@nwu.test ', admin_notification_email: 'selouna@nwu.test' })
    expect(await systemFromAddress()).toBe('SmartStock <system@nwu.test>')
    await putNotificationSettings(db, { admin_notification_email: 'selouna@nwu.test' })
    expect(await systemFromAddress()).toBeUndefined()
    await putNotificationSettings(db, null)
    expect(await systemFromAddress()).toBeUndefined()
  })

  it('deliver sends From the system address, never the admin inbox; blank or invalid -> MAIL_FROM default', async () => {
    await putNotificationSettings(db, { system_from_email: 'system@nwu.test', admin_notification_email: 'selouna@nwu.test' })
    await deliver(opts())
    expect((sent()[0].to as { value: { address: string }[] }).value[0].address).toBe('jessica@example.com')
    expect(sent()[0].from).toMatchObject({ value: [{ address: 'system@nwu.test', name: 'SmartStock' }] })

    sink.sent.length = 0
    await putNotificationSettings(db, { admin_notification_email: 'selouna@nwu.test' })
    await deliver(opts({ dedupeKey: 'k2__r1__x' }))
    expect(sent()[0].from).toMatchObject({ value: [{ address: 'no-reply@smartstock.local' }] })

    sink.sent.length = 0
    await putNotificationSettings(db, { system_from_email: 'a<b@c.test', admin_notification_email: 'selouna@nwu.test' })
    await deliver(opts({ dedupeKey: 'k3__r1__x' }))
    expect(sent()[0].from).toMatchObject({ value: [{ address: 'no-reply@smartstock.local' }] })
  })
})

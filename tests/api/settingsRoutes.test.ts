// Route tests for /api/settings/notifications: admin only (401 signed out, 403 for staff), loads, saves with their audit
// entries, the inline "valid email" message and the refusal to turn on an email that is not built yet.
import { NextRequest } from 'next/server'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { GET, POST } from '@/app/api/settings/notifications/route'
import { auditLog, profiles } from '@/server/db/schema'
import type { Db } from '@/server/db/client'
import { DEFAULT_NOTIFICATION_SETTINGS } from '@/lib/notificationSettingsRules'
import { installFakeAuth, tokenFor } from '../helpers/auth'
import { closeTestDb, resetTestDb } from '../helpers/db'
import { putNotificationSettings } from '../helpers/settings'

let db: Db
let restore: () => void

const headers = (uid?: string): Record<string, string> => (uid ? { authorization: `Bearer ${tokenFor(uid)}` } : {})
const get = (query: string, uid?: string) =>
  GET(new NextRequest(`http://localhost/api/settings/notifications${query}`, { method: 'GET', headers: headers(uid) })).then(
    async (res) => ({ status: res.status, body: await res.json() }),
  )
const post = (body: unknown, uid?: string) =>
  POST(
    new NextRequest('http://localhost/api/settings/notifications', {
      method: 'POST',
      headers: { ...headers(uid), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  ).then(async (res) => ({ status: res.status, body: await res.json() }))

beforeAll(async () => {
  db = await resetTestDb()
  restore = installFakeAuth(db)
})
afterAll(async () => {
  restore()
  await closeTestDb()
})
beforeEach(async () => {
  await db.delete(auditLog)
  await db.delete(profiles)
  await putNotificationSettings(db, null)
  await db.insert(profiles).values([
    { uid: 'admin-uid', full_name: 'Ada Admin', role: 'admin' },
    { uid: 'sam-uid', full_name: 'Sam Staff', role: 'staff' },
  ])
})

describe('/api/settings/notifications', () => {
  it('signed out is a 401, staff a 403, for reads and writes', async () => {
    const signedOut = { status: 401, body: { error: 'Missing Authorization header.' } }
    expect(await get('')).toEqual(signedOut)
    expect(await post({ action: 'toggle', key: 'low_stock_alert', value: false })).toEqual(signedOut)
    expect((await get('', 'sam-uid')).status).toBe(403)
    expect((await get('?kind=admin_notification_email', 'sam-uid')).status).toBe(403)
    expect((await post({ action: 'toggle', key: 'low_stock_alert', value: false }, 'sam-uid')).status).toBe(403)
    expect((await post({ action: 'address', field: 'admin_notification_email', value: 'a@nwu.test' }, 'sam-uid')).status).toBe(403)
    expect(await db.select().from(auditLog)).toHaveLength(0)
  })

  it('loads the toggles (defaults filled in) and each saved address', async () => {
    expect(await get('', 'admin-uid')).toEqual({ status: 200, body: DEFAULT_NOTIFICATION_SETTINGS })
    expect((await get('?kind=admin_notification_email', 'admin-uid')).body).toEqual({ value: '' })
    await putNotificationSettings(db, { admin_notification_email: 'a@nwu.test', system_from_email: 's@nwu.test', low_stock_alert: false })
    expect((await get('', 'admin-uid')).body).toEqual({ ...DEFAULT_NOTIFICATION_SETTINGS, low_stock_alert: false })
    expect((await get('?kind=admin_notification_email', 'admin-uid')).body).toEqual({ value: 'a@nwu.test' })
    expect((await get('?kind=system_from_email', 'admin-uid')).body).toEqual({ value: 's@nwu.test' })
    expect((await get('?kind=updated_by_uid', 'admin-uid')).status).toBe(400)
  })

  it('a toggle save is stored and audited as the signed-in admin', async () => {
    const r = await post({ action: 'toggle', key: 'new_loan_request', value: false }, 'admin-uid')
    expect(r).toEqual({ status: 200, body: { key: 'new_loan_request', value: false } })
    expect((await get('', 'admin-uid')).body.new_loan_request).toBe(false)
    const [entry] = await db.select().from(auditLog)
    expect(entry).toMatchObject({
      user_id: 'admin-uid',
      user_name: 'Ada Admin',
      entity_type: 'settings',
      entity_id: 'notifications',
      before: { new_loan_request: true, label: 'New loan request' },
      after: { new_loan_request: false, label: 'New loan request' },
    })
  })

  it('an address save is stored trimmed; an invalid one is a 400 with the inline message', async () => {
    expect(await post({ action: 'address', field: 'system_from_email', value: ' system@nwu.test ' }, 'admin-uid')).toEqual({
      status: 200,
      body: { value: 'system@nwu.test' },
    })
    expect((await get('?kind=system_from_email', 'admin-uid')).body).toEqual({ value: 'system@nwu.test' })
    expect(await post({ action: 'address', field: 'admin_notification_email', value: 'not an email' }, 'admin-uid')).toEqual({
      status: 400,
      body: { error: 'Enter a valid email address.' },
    })
    expect(await db.select().from(auditLog)).toHaveLength(1)
  })

  it("refusing to turn on an email that is not built yet keeps today's message", async () => {
    expect(await post({ action: 'toggle', key: 'overdue_return_alert', value: true }, 'admin-uid')).toEqual({
      status: 400,
      body: { error: "Overdue return alert isn't implemented yet, so it can't be turned on." },
    })
    expect((await get('', 'admin-uid')).body.overdue_return_alert).toBe(false)
    expect(await db.select().from(auditLog)).toHaveLength(0)
  })

  it('unknown action, field or key -> 400', async () => {
    expect((await post({ action: 'nope' }, 'admin-uid')).status).toBe(400)
    expect((await post({ action: 'address', field: 'updated_by_uid', value: 'a@b.co' }, 'admin-uid')).status).toBe(400)
    expect((await post({ action: 'toggle', key: 'nope', value: true }, 'admin-uid')).status).toBe(400)
  })
})

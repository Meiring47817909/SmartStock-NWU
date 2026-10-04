// The public contact address: GET /api/contact (reads the saved Admin notification address server-side) and the
// browser helper fetchContactEmail. Port of the scratch harness check-contact.mts.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { GET } from '@/app/api/contact/route'
import { setDbForTests, type Caller, type Ctx } from '@/server/context'
import type { Db } from '@/server/db/client'
import { saveAddress } from '@/server/data/settings'
import { FALLBACK_CONTACT_EMAIL, fetchContactEmail } from '@/lib/contactEmail'
import { closeTestDb, resetTestDb } from '../helpers/db'
import { putNotificationSettings } from '../helpers/settings'

let db: Db
const admin: Caller = { uid: 'admin-uid', name: 'Ada Admin', role: 'admin', staffId: null }

beforeAll(async () => {
  db = await resetTestDb()
  setDbForTests(db)
})
afterAll(async () => {
  setDbForTests(null)
  await closeTestDb()
})
beforeEach(() => putNotificationSettings(db, null))
afterEach(() => {
  setDbForTests(db)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const call = async () => {
  const res = await GET()
  return { status: res.status, body: await res.json(), headers: res.headers }
}
const setup = (notifications?: Record<string, unknown>) => putNotificationSettings(db, notifications ?? null)

describe('GET /api/contact (the public route)', () => {
  it('returns the saved Admin notification address, trimmed, with no sign-in needed', async () => {
    await setup({ admin_notification_email: '  jon.p@nwu.test ', system_from_email: 'noreply@x.test', low_stock_alert: true })
    const r = await call()
    expect(r.status).toBe(200)
    expect(r.body, 'only the address, nothing else from the settings').toEqual({ email: 'jon.p@nwu.test' })
  })

  it('returns the address an admin just saved on the Settings page', async () => {
    await saveAddress({ db, caller: admin, now: () => new Date() } satisfies Ctx, 'admin_notification_email', ' selouna@nwu.test ')
    expect((await call()).body).toEqual({ email: 'selouna@nwu.test' })
  })

  it('no settings saved, or no address saved -> empty string', async () => {
    await setup()
    expect((await call()).body).toEqual({ email: '' })
    await setup({ low_stock_alert: true })
    expect((await call()).body).toEqual({ email: '' })
    await setup({ admin_notification_email: null })
    expect((await call()).body).toEqual({ email: '' })
  })

  it('something that is not a plain email address is never returned', async () => {
    for (const bad of ['not an email', 'a b@c.test', 'x@y', '<script>@x.test', 'a@b.test>\r\nBcc: z@z.test', 5]) {
      await setup({ admin_notification_email: bad })
      expect((await call()).body, String(bad)).toEqual({ email: '' })
    }
  })

  it('a database failure -> 500 with a plain error, never throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    setDbForTests({
      select() {
        throw new Error('db down')
      },
    } as unknown as Db)
    const r = await call()
    expect(r.status).toBe(500)
    expect(r.body).toEqual({ error: 'Could not load the contact email.' })
  })

  it('the answer is never cached, so a change in Settings shows on the next load', async () => {
    await setup({ admin_notification_email: 'a@nwu.test' })
    const first = await call()
    await setup({ admin_notification_email: 'b@nwu.test' })
    const second = await call()
    expect(first.body.email).toBe('a@nwu.test')
    expect(second.body.email).toBe('b@nwu.test')
    expect(String(first.headers.get('Cache-Control'))).toMatch(/no-store/)
  })
})

describe('fetchContactEmail (the browser helper)', () => {
  const stubFetch = (impl: (url: string, init?: unknown) => unknown) => vi.stubGlobal('fetch', vi.fn(impl))

  it('returns the address from /api/contact (trimmed)', async () => {
    let url = ''
    stubFetch(async (u) => {
      url = u
      return { ok: true, json: async () => ({ email: ' a@nwu.test ' }) }
    })
    expect(await fetchContactEmail()).toBe('a@nwu.test')
    expect(url).toBe('/api/contact')
  })

  it('empty / missing / non-string address -> the fallback', async () => {
    for (const body of [{ email: '' }, { email: '   ' }, {}, { email: 5 }, null]) {
      stubFetch(async () => ({ ok: true, json: async () => body }))
      expect(await fetchContactEmail(), JSON.stringify(body)).toBe(FALLBACK_CONTACT_EMAIL)
    }
  })

  it('non-OK response, network failure or bad JSON -> the fallback, never throws', async () => {
    stubFetch(async () => ({ ok: false, json: async () => ({ email: 'a@nwu.test' }) }))
    expect(await fetchContactEmail()).toBe(FALLBACK_CONTACT_EMAIL)
    stubFetch(async () => {
      throw new Error('offline')
    })
    expect(await fetchContactEmail()).toBe(FALLBACK_CONTACT_EMAIL)
    stubFetch(async () => ({
      ok: true,
      json: async () => {
        throw new Error('bad json')
      },
    }))
    expect(await fetchContactEmail()).toBe(FALLBACK_CONTACT_EMAIL)
  })

  it('fallback is the address the screens showed before this change', () => {
    expect(FALLBACK_CONTACT_EMAIL).toBe('jonathan.pritchard@nwu.ac.za')
  })
})

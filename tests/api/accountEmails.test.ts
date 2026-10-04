// Account emails (sign-in security): forgot-password, change-email, the staff "send login email" link and the links'
// shape. Port of the scratch harness check-account-emails.mts. Firebase Admin and the client SDK are replaced; profiles,
// staff, the system sender and the 60-second cooldown markers are in the test PostgreSQL database; mail goes to a local
// SMTP sink.
import { NextRequest } from 'next/server'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const fb = vi.hoisted(() => ({
  users: [] as { uid: string; email: string }[],
  links: [] as string[][],
}))
const coded = (code: string) => Object.assign(new Error(code), { code })

vi.mock('@/lib/firebase/admin', () => ({
  adminAuth: {
    async getUser(uid: string) {
      const u = fb.users.find((x) => x.uid === uid)
      if (!u) throw coded('auth/user-not-found')
      return u
    },
    async getUserByEmail(email: string) {
      const u = fb.users.find((x) => x.email === email)
      if (!u) throw coded('auth/user-not-found')
      return u
    },
    async generatePasswordResetLink(email: string) {
      fb.links.push(['reset', email])
      if (!fb.users.some((x) => x.email === email)) throw coded('auth/email-not-found')
      return `http://127.0.0.1:9099/emulator/action?mode=resetPassword&oobCode=RESET-${encodeURIComponent(email)}&apiKey=k`
    },
    async generateVerifyAndChangeEmailLink(email: string, newEmail: string) {
      fb.links.push(['change', email, newEmail])
      if (!fb.users.some((x) => x.email === email)) throw coded('auth/email-not-found')
      return `http://127.0.0.1:9099/emulator/action?mode=verifyAndChangeEmail&oobCode=CHANGE-${encodeURIComponent(newEmail)}&apiKey=k`
    },
  },
}))
vi.mock('@/lib/firebase/config', () => ({ auth: { name: 'client-auth' } }))
vi.mock('firebase/auth', () => ({ sendPasswordResetEmail: async () => {} }))

import { POST as forgotPOST } from '@/app/api/auth/forgot-password/route'
import { POST as changePOST } from '@/app/api/auth/change-email/route'
import { POST as sendLoginPOST } from '@/app/api/staff/send-reset-email/route'
import { setDbForTests, setTokenVerifier } from '@/server/context'
import type { Db } from '@/server/db/client'
import { profiles, sentNotifications, staff } from '@/server/db/schema'
import { appActionLink } from '@/lib/server/accountEmail'
import { changeEmailEmail, passwordResetEmail } from '@/lib/server/emailTemplates'
import { closeTestDb, resetTestDb } from '../helpers/db'
import { markerKeys, putNotificationSettings } from '../helpers/settings'
import { deadPort, fakeEnv, saveMailEnv, setMailEnv, startMailSink, type MailSink } from '../helpers/smtp'

const ADMIN = 'jonathan.pritchard@nwu.ac.za'
const SYSTEM = 'noreply@smartstock-nwu.com'

let db: Db
let sink: MailSink
let dead: number
let restoreEnv: () => void
const sent = () => sink.sent
const addr = (v: unknown) => (v as { value: { address: string }[] }).value[0].address

beforeAll(async () => {
  restoreEnv = saveMailEnv()
  db = await resetTestDb()
  setDbForTests(db)
  // Tokens: tok-admin / tok-borrower / tok-stale (the admin who signed in ten minutes ago); anything else is rejected.
  const tokens: Record<string, string> = { 'tok-admin': 'admin1', 'tok-borrower': 'borrower1', 'tok-stale': 'admin1' }
  setTokenVerifier(async (token) => {
    const uid = tokens[token]
    if (!uid) throw new Error('invalid token')
    return { uid, auth_time: token === 'tok-stale' ? Math.floor(Date.now() / 1000) - 600 : Math.floor(Date.now() / 1000) }
  })
  sink = await startMailSink()
  dead = await deadPort()
})
afterAll(async () => {
  await sink.close()
  setTokenVerifier(null)
  setDbForTests(null)
  restoreEnv()
  await closeTestDb()
})

async function setup(env: Record<string, string | undefined> = {}) {
  await db.delete(sentNotifications)
  await db.delete(staff)
  await db.delete(profiles)
  await db.insert(profiles).values([
    { uid: 'admin1', full_name: 'Jonathan Pritchard', role: 'admin' },
    { uid: 'borrower1', full_name: 'Jessica Moore', role: 'staff' },
  ])
  await putNotificationSettings(db, { system_from_email: SYSTEM })
  fb.users = [
    { uid: 'admin1', email: ADMIN },
    { uid: 'borrower1', email: 'jessica@example.com' },
    { uid: 'other1', email: 'taken@example.com' },
  ]
  fb.links = []
  sink.sent.length = 0
  setMailEnv({ MAIL_TRANSPORT: 'smtp', SMTP_HOST: '127.0.0.1', SMTP_PORT: String(sink.port), ...env })
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]
}
beforeEach(() => setup())

const post = (path: string, body: unknown, token?: string | null) =>
  new NextRequest(`http://localhost${path}`, {
    method: 'POST',
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
const answer = async (res: Response) => ({ status: res.status, body: await res.json() })
const callForgot = (body: unknown) => forgotPOST(post('/api/auth/forgot-password', body)).then(answer)
const callChange = (body: unknown, token: string | null = 'tok-admin') => changePOST(post('/api/auth/change-email', body, token)).then(answer)

describe('templates', () => {
  it('passwordResetEmail: subject, button, plain text carries the link, no name needed', () => {
    const link = 'http://127.0.0.1:9099/emulator/action?mode=resetPassword&oobCode=abc'
    const e = passwordResetEmail({ link })
    expect(e.subject).toBe('Reset your SmartStock NWU password')
    expect(e.html).toContain('Reset password')
    expect(e.html).toContain(link.replace(/&/g, '&amp;'))
    expect(e.text).toContain(link)
    expect(e.text).not.toMatch(/undefined|null|there/)
  })

  it('changeEmailEmail: names the new address, escapes it, carries the link', () => {
    const link = 'http://127.0.0.1:9099/emulator/action?mode=verifyAndChangeEmail&oobCode=x'
    const e = changeEmailEmail({ newEmail: 'a<b>@x.com', link })
    expect(e.subject).toBe('Confirm your new SmartStock NWU email')
    expect(e.text).toContain('a<b>@x.com')
    expect(e.text).toContain(link)
    expect(e.html).toContain('a&lt;b&gt;@x.com')
    expect(e.html).not.toContain('a<b>@x.com')
  })
})

describe('forgot-password', () => {
  it('bad bodies / addresses -> 400, nothing sent', async () => {
    for (const body of [null, {}, { email: 5 }, { email: '' }, { email: 'not-an-email' }, { email: 'a b@c.com' }, { email: 'a@b.com,c@d.com' }]) {
      expect((await callForgot(body)).status, JSON.stringify(body)).toBe(400)
    }
    expect(sent()).toHaveLength(0)
  })

  it('mail disabled -> mail_disabled, no link, no marker', async () => {
    await setup({ MAIL_TRANSPORT: undefined })
    const r = await callForgot({ email: 'jessica@example.com' })
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ sent: false, reason: 'mail_disabled' })
    expect(fb.links).toHaveLength(0)
    expect(await markerKeys(db)).toHaveLength(0)
    expect(sent()).toHaveLength(0)
  })

  it('known account -> one reset email to that address from the system address', async () => {
    const r = await callForgot({ email: 'jessica@example.com' })
    expect(r.body).toEqual({ sent: true })
    expect(sent()).toHaveLength(1)
    const m = sent()[0]
    expect(addr(m.to)).toBe('jessica@example.com')
    expect(addr(m.from)).toBe(SYSTEM)
    expect(m.subject).toBe('Reset your SmartStock NWU password')
    expect(m.text).toContain('http://localhost:3000/auth/action?mode=resetPassword&oobCode=RESET-jessica%40example.com')
    expect(m.text, 'link must point at the app, not the emulator').not.toContain(':9099')
  })

  it('address is trimmed and lower-cased before lookup and delivery', async () => {
    expect((await callForgot({ email: '  Jessica@Example.COM ' })).body).toEqual({ sent: true })
    expect(sent()).toHaveLength(1)
    expect(addr(sent()[0].to)).toBe('jessica@example.com')
  })

  it('unknown account -> identical { sent: true } answer, nothing sent', async () => {
    const known = await callForgot({ email: 'jessica@example.com' })
    const unknown = await callForgot({ email: 'nobody@example.com' })
    expect(unknown).toEqual(known)
    expect(sent()).toHaveLength(1)
  })

  it('second request for the same address inside the cooldown sends nothing more; another address still sends', async () => {
    await callForgot({ email: 'jessica@example.com' })
    expect((await callForgot({ email: 'jessica@example.com' })).body).toEqual({ sent: true })
    expect(sent()).toHaveLength(1)
    await callForgot({ email: ADMIN })
    expect(sent()).toHaveLength(2)
  })

  it('the cooldown marker is a sent_notifications row keyed password_reset__<hash>__<minute> (hash only, never the address)', async () => {
    await callForgot({ email: 'jessica@example.com' })
    const [row] = await db.select().from(sentNotifications)
    expect(row.key).toMatch(/^password_reset__[0-9a-f]{32}__\d+$/)
    expect(row.toggle).toBe('password_reset')
    expect(row.entity_id).toBe(row.key.slice('password_reset__'.length))
    expect(row.key).not.toContain('jessica')
  })

  it('simultaneous requests for one address send exactly one email', async () => {
    const results = await Promise.all([1, 2, 3, 4].map(() => callForgot({ email: 'jessica@example.com' })))
    expect(results.every((r) => r.body.sent === true)).toBe(true)
    expect(sent()).toHaveLength(1)
  })

  it('Mailpit down -> 502 naming Mailpit, and the retry afterwards still sends', async () => {
    await setup({ SMTP_PORT: String(dead) })
    const r = await callForgot({ email: 'jessica@example.com' })
    expect(r.status).toBe(502)
    expect(r.body.error).toMatch(/Mailpit/)
    expect(await markerKeys(db), 'marker released').toHaveLength(0)
    process.env.SMTP_PORT = String(sink.port)
    expect((await callForgot({ email: 'jessica@example.com' })).body).toEqual({ sent: true })
    expect(sent()).toHaveLength(1)
  })
})

describe('change-email', () => {
  it('no / invalid Authorization -> 401, nothing sent', async () => {
    expect((await callChange({ newEmail: 'new@x.com' }, null)).status).toBe(401)
    expect((await callChange({ newEmail: 'new@x.com' }, 'bogus')).status).toBe(401)
    expect(sent()).toHaveLength(0)
  })

  it('portal borrower (role staff) -> 403, nothing sent', async () => {
    expect((await callChange({ newEmail: 'new@x.com' }, 'tok-borrower')).status).toBe(403)
    expect(sent()).toHaveLength(0)
    expect(fb.links).toHaveLength(0)
  })

  it('sign-in older than 5 minutes -> 401 asking for the password again, nothing sent', async () => {
    const r = await callChange({ newEmail: 'new@x.com' }, 'tok-stale')
    expect(r.status).toBe(401)
    expect(r.body.error).toMatch(/password/i)
    expect(sent()).toHaveLength(0)
  })

  it('bad bodies -> 400', async () => {
    for (const body of [null, {}, { newEmail: 5 }, { newEmail: '' }, { newEmail: 'nope' }, { newEmail: 'a b@c.com' }]) {
      expect((await callChange(body)).status, JSON.stringify(body)).toBe(400)
    }
    expect(sent()).toHaveLength(0)
  })

  it('new address equal to the current one (any case) -> 400', async () => {
    expect((await callChange({ newEmail: ADMIN.toUpperCase() })).status).toBe(400)
    expect(sent()).toHaveLength(0)
  })

  it('address already used by another account -> 409, nothing sent', async () => {
    const r = await callChange({ newEmail: 'Taken@example.com' })
    expect(r.status).toBe(409)
    expect(r.body.error).toMatch(/already used/)
    expect(sent()).toHaveLength(0)
  })

  it('mail disabled -> mail_disabled, no link generated', async () => {
    await setup({ MAIL_TRANSPORT: undefined })
    const r = await callChange({ newEmail: 'new@x.com' })
    expect(r.body).toEqual({ sent: false, reason: 'mail_disabled' })
    expect(fb.links).toHaveLength(0)
    expect(sent()).toHaveLength(0)
  })

  it('success -> one confirmation email to the NEW address only, link built from the real current email', async () => {
    const r = await callChange({ newEmail: '  New.Address@X.com ' })
    expect(r.body).toEqual({ sent: true })
    expect(fb.links).toEqual([['change', ADMIN, 'new.address@x.com']])
    expect(sent()).toHaveLength(1)
    const m = sent()[0]
    expect((m.to as { value: unknown[] }).value).toHaveLength(1)
    expect(addr(m.to)).toBe('new.address@x.com')
    expect(addr(m.from)).toBe(SYSTEM)
    expect(m.subject).toBe('Confirm your new SmartStock NWU email')
    expect(m.text).toContain('new.address@x.com')
    expect(m.text).toContain('http://localhost:3000/auth/action?mode=verifyAndChangeEmail&oobCode=CHANGE-new.address%40x.com')
    expect(m.text, 'link must point at the app, not the emulator').not.toContain(':9099')
  })

  it('Mailpit down -> 502 naming Mailpit', async () => {
    await setup({ SMTP_PORT: String(dead) })
    const r = await callChange({ newEmail: 'new@x.com' })
    expect(r.status).toBe(502)
    expect(r.body.error).toMatch(/Mailpit/)
  })
})

describe("links point at the app's own /auth/action page", () => {
  it('appActionLink: keeps only mode and oobCode, on APP_BASE_URL (trailing slash dropped)', () => {
    const fbLink = 'http://127.0.0.1:9099/emulator/action?mode=resetPassword&lang=en&oobCode=a%2Bb&apiKey=fake&continueUrl=http%3A%2F%2Fx'
    expect(appActionLink(fbLink, fakeEnv({ APP_BASE_URL: 'https://stock.nwu.ac.za/' }))).toBe(
      'https://stock.nwu.ac.za/auth/action?mode=resetPassword&oobCode=a%2Bb',
    )
    expect(appActionLink(fbLink, fakeEnv())).toBe('http://localhost:3000/auth/action?mode=resetPassword&oobCode=a%2Bb')
    const live = 'https://demo.firebaseapp.com/__/auth/action?mode=verifyAndChangeEmail&oobCode=XYZ&apiKey=k&lang=en'
    expect(appActionLink(live, fakeEnv())).toBe('http://localhost:3000/auth/action?mode=verifyAndChangeEmail&oobCode=XYZ')
  })

  it('appActionLink: a link without mode or oobCode (or not a URL) is left unchanged', () => {
    for (const l of ['http://127.0.0.1:9099/emulator/action?mode=resetPassword', 'http://x/?oobCode=1', 'not a url']) {
      expect(appActionLink(l, fakeEnv())).toBe(l)
    }
  })

  it('Send Login Email: the "set your password" link also points at the app page', async () => {
    await db.insert(staff).values({ id: 's1', uid: 'borrower1', name: 'Jessica', surname: 'Moore', full_name: 'Jessica Moore', email: 'jessica@example.com' })
    const r = await sendLoginPOST(post('/api/staff/send-reset-email', { staffId: 's1' }, 'tok-admin'))
    expect(r.status, JSON.stringify(await r.clone().json())).toBe(200)
    expect(sent()).toHaveLength(1)
    expect(sent()[0].text).toContain('http://localhost:3000/auth/action?mode=resetPassword&oobCode=RESET-jessica%40example.com')
    expect(addr(sent()[0].from)).toBe(SYSTEM)
  })

  it('APP_BASE_URL is used for the reset link when set', async () => {
    await setup({ APP_BASE_URL: 'https://stock.nwu.ac.za' })
    await callForgot({ email: 'jessica@example.com' })
    expect(sent()[0].text).toContain('https://stock.nwu.ac.za/auth/action?mode=resetPassword&oobCode=')
  })
})

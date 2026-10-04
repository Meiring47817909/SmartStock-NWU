// Route tests for the staff area: /api/staff, /api/staff/[id] and the three routes that also talk to Firebase Auth
// (update-email, send-reset-email, admin/update-name). Staff rows, profiles and audit entries are in the test
// PostgreSQL database; Firebase Admin, the client SDK and the mailer are replaced so nothing initialises Firebase.
import { eq } from 'drizzle-orm'
import { NextRequest } from 'next/server'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const fb = vi.hoisted(() => ({
  users: new Map<string, { uid: string; email: string }>(),
  updateUser: vi.fn(),
  createUser: vi.fn(),
  links: 0,
  resetSent: [] as string[],
  mailSent: [] as { to: string; subject: string }[],
  mailEnabled: false,
}))

vi.mock('@/lib/firebase/admin', () => ({
  adminAuth: {
    updateUser: fb.updateUser,
    createUser: fb.createUser,
    async getUser(uid: string) {
      const u = [...fb.users.values()].find((x) => x.uid === uid)
      if (!u) throw Object.assign(new Error('not found'), { code: 'auth/user-not-found' })
      return u
    },
    async getUserByEmail(email: string) {
      const u = fb.users.get(email)
      if (!u) throw Object.assign(new Error('not found'), { code: 'auth/user-not-found' })
      return u
    },
    async generatePasswordResetLink(email: string) {
      fb.links++
      return `https://example.test/__/auth/action?mode=resetPassword&oobCode=code-${email}`
    },
  },
}))
vi.mock('@/lib/firebase/config', () => ({ auth: { name: 'client-auth' } }))
vi.mock('firebase/auth', () => ({
  sendPasswordResetEmail: async (_auth: unknown, email: string) => {
    fb.resetSent.push(email)
  },
}))
vi.mock('@/lib/server/mailer', () => ({
  isMailEnabled: () => fb.mailEnabled,
  sendMail: async (msg: { to: string; subject: string }) => {
    fb.mailSent.push({ to: msg.to, subject: msg.subject })
    return true
  },
  MailUnreachableError: class MailUnreachableError extends Error {},
  MailConfigError: class MailConfigError extends Error {},
}))
vi.mock('@/lib/server/notificationDelivery', () => ({
  systemFromAddress: async () => undefined,
  appBaseUrl: () => 'http://localhost:3000',
}))

import { GET as staffGET, POST as staffPOST } from '@/app/api/staff/route'
import { GET as staffIdGET, POST as staffIdPOST } from '@/app/api/staff/[id]/route'
import { POST as updateEmailPOST } from '@/app/api/staff/update-email/route'
import { POST as sendResetPOST } from '@/app/api/staff/send-reset-email/route'
import { POST as updateNamePOST } from '@/app/api/admin/update-name/route'
import { auditLog, products, profiles, returnWaivers, staff, transactionLines, transactions } from '@/server/db/schema'
import type { Db } from '@/server/db/client'
import { installFakeAuth, tokenFor } from '../helpers/auth'
import { closeTestDb, resetTestDb } from '../helpers/db'

let db: Db
let restore: () => void

function request(method: 'GET' | 'POST', url: string, uid?: string, body?: unknown) {
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: {
      ...(uid ? { authorization: `Bearer ${tokenFor(uid)}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}
const segment = (id: string) => ({ params: Promise.resolve({ id }) })
const json = async (res: Response) => ({ status: res.status, body: await res.json() })
const audits = () => db.select().from(auditLog)

beforeAll(async () => {
  db = await resetTestDb()
  restore = installFakeAuth(db)
})
afterAll(async () => {
  restore()
  await closeTestDb()
})

beforeEach(async () => {
  fb.users.clear()
  fb.updateUser.mockReset()
  fb.createUser.mockReset()
  fb.links = 0
  fb.resetSent = []
  fb.mailSent = []
  fb.mailEnabled = false
  await db.delete(auditLog)
  await db.delete(returnWaivers)
  await db.delete(transactionLines)
  await db.delete(transactions)
  await db.delete(products)
  await db.delete(staff)
  await db.delete(profiles)
  await db.insert(profiles).values([
    { uid: 'admin-uid', full_name: 'Ada Admin', role: 'admin' },
    { uid: 'sam-uid', full_name: 'Sam Staff', role: 'staff' },
  ])
  await db.insert(staff).values([
    { id: 'staff-1', name: 'Sam', surname: 'Staff', full_name: 'Sam Staff', email: 'sam@nwu.test', uid: 'sam-uid' },
    { id: 'staff-2', name: 'Bo', surname: 'Rrower', full_name: 'Bo Rrower', email: 'bo@nwu.test' },
    { id: 'staff-3', name: 'No', surname: 'Mail', full_name: 'No Mail' },
  ])
})

describe('/api/staff and /api/staff/[id]', () => {
  it('lists for an admin; a staff caller gets 403; signed out gets 401', async () => {
    const ok = await json(await staffGET(request('GET', '/api/staff', 'admin-uid')))
    expect(ok.status).toBe(200)
    expect(ok.body.map((s: { full_name: string }) => s.full_name)).toEqual(['Bo Rrower', 'No Mail', 'Sam Staff'])
    expect((await json(await staffGET(request('GET', '/api/staff', 'sam-uid')))).status).toBe(403)
    expect((await json(await staffGET(request('GET', '/api/staff')))).status).toBe(401)
  })

  it('a staff caller reads only their own record', async () => {
    expect((await json(await staffIdGET(request('GET', '/api/staff/staff-1', 'sam-uid'), segment('staff-1')))).body).toMatchObject({ id: 'staff-1' })
    expect((await json(await staffIdGET(request('GET', '/api/staff/staff-2', 'sam-uid'), segment('staff-2')))).status).toBe(403)
    expect((await json(await staffIdGET(request('GET', '/api/staff/nope', 'admin-uid'), segment('nope')))).status).toBe(404)
  })

  it('create, update, setActive and the email check work end to end for an admin and are audited', async () => {
    const created = await json(await staffPOST(request('POST', '/api/staff', 'admin-uid', { action: 'create', name: 'Tess', surname: 'Ter', email: 'Tess@nwu.test' })))
    expect(created.status).toBe(200)
    const id = created.body.id as string

    const conflict = await json(await staffGET(request('GET', '/api/staff?kind=emailConflict&email=TESS@nwu.test', 'admin-uid')))
    expect(conflict.body).toEqual({ id, full_name: 'Tess Ter' })
    const none = await json(await staffGET(request('GET', `/api/staff?kind=emailConflict&email=TESS@nwu.test&excludeId=${id}`, 'admin-uid')))
    expect(none.body).toBeNull()

    const dup = await json(await staffPOST(request('POST', '/api/staff', 'admin-uid', { action: 'create', name: 'X', surname: 'Y', email: 'tess@NWU.test' })))
    expect(dup).toEqual({ status: 409, body: { error: 'This email is already used by Tess Ter.' } })

    const upd = await json(await staffIdPOST(request('POST', `/api/staff/${id}`, 'admin-uid', { action: 'update', staff: { name: 'Tessa', surname: 'Ter', email: 'tess@nwu.test', department: 'Art' } }), segment(id)))
    expect(upd.body).toMatchObject({ full_name: 'Tessa Ter', department: 'Art' })
    const off = await json(await staffIdPOST(request('POST', `/api/staff/${id}`, 'admin-uid', { action: 'setActive', active: false }), segment(id)))
    expect(off.body).toMatchObject({ is_active: false })
    expect((await audits()).map((a) => a.action).sort()).toEqual(['create', 'deactivate', 'update'])

    // A staff caller can do none of it, even to their own row.
    expect((await json(await staffIdPOST(request('POST', '/api/staff/staff-1', 'sam-uid', { action: 'setActive', active: false }), segment('staff-1')))).status).toBe(403)
    expect((await json(await staffIdPOST(request('POST', '/api/staff/staff-1', 'sam-uid', { action: 'update', staff: { name: 'A', surname: 'B' } }), segment('staff-1')))).status).toBe(403)
    expect((await json(await staffPOST(request('POST', '/api/staff', 'sam-uid', { action: 'create', name: 'A', surname: 'B' })))).status).toBe(403)
  })

  it('My Profile: updateOwn saves the caller\'s own details and profile name; syncOwnEmail updates their email', async () => {
    const res = await json(await staffPOST(request('POST', '/api/staff', 'sam-uid', { action: 'updateOwn', name: 'Samuel', surname: 'Staff', department: 'Art' })))
    expect(res.body).toMatchObject({ id: 'staff-1', full_name: 'Samuel Staff', department: 'Art' })
    const [p] = await db.select().from(profiles).where(eq(profiles.uid, 'sam-uid'))
    expect(p.full_name).toBe('Samuel Staff')
    // The address must be the one Firebase Auth has for the caller.
    fb.users.set('sam.old@nwu.test', { uid: 'sam-uid', email: 'sam.old@nwu.test' })
    const refused = await json(await staffPOST(request('POST', '/api/staff', 'sam-uid', { action: 'syncOwnEmail', email: 'evil@nwu.test' })))
    expect(refused).toEqual({ status: 403, body: { error: 'You can only sync your own login email.' } })
    expect((await db.select().from(staff).where(eq(staff.id, 'staff-1')))[0].email).toBe('sam@nwu.test')
    fb.users.clear()
    fb.users.set('sam.new@nwu.test', { uid: 'sam-uid', email: 'sam.new@nwu.test' })
    const sync = await json(await staffPOST(request('POST', '/api/staff', 'sam-uid', { action: 'syncOwnEmail', email: 'Sam.New@nwu.test' })))
    expect(sync.body).toMatchObject({ id: 'staff-1', email: 'sam.new@nwu.test' })
  })

  it('unknown actions and kinds are 400', async () => {
    expect((await json(await staffPOST(request('POST', '/api/staff', 'admin-uid', { action: 'nope' })))).status).toBe(400)
    expect((await json(await staffGET(request('GET', '/api/staff?kind=nope', 'admin-uid')))).status).toBe(400)
  })
})

describe('POST /api/staff/update-email', () => {

  it('re-points the linked Auth account (lower-cased) and does not touch the staff row', async () => {
    fb.updateUser.mockResolvedValue({})
    const res = await json(await updateEmailPOST(request('POST', '/api/staff/update-email', 'admin-uid', { staffId: 'staff-1', newEmail: ' Sam.New@NWU.test ' })))
    expect(res).toEqual({ status: 200, body: { email: 'sam.new@nwu.test' } })
    expect(fb.updateUser).toHaveBeenCalledWith('sam-uid', { email: 'sam.new@nwu.test' })
    const [row] = await db.select().from(staff).where(eq(staff.id, 'staff-1'))
    expect(row.email).toBe('sam@nwu.test')
  })

  it('keeps today\'s errors: 403, 400, 404, no login account, Auth conflicts', async () => {
    const call = async (uid: string, body: unknown) => json(await updateEmailPOST(request('POST', '/api/staff/update-email', uid, body)))
    expect(await call('sam-uid', { staffId: 'staff-1', newEmail: 'a@b.c' })).toEqual({ status: 403, body: { error: 'Only admins can manage staff logins.' } })
    expect(await call('admin-uid', { staffId: 'staff-1' })).toEqual({ status: 400, body: { error: 'Missing staffId or newEmail.' } })
    expect(await call('admin-uid', { staffId: 'nope', newEmail: 'a@b.c' })).toEqual({ status: 404, body: { error: 'Staff record not found.' } })
    expect(await call('admin-uid', { staffId: 'staff-2', newEmail: 'a@b.c' })).toEqual({
      status: 400,
      body: { error: 'This staff member has no linked login account to update.' },
    })
    fb.updateUser.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'auth/email-already-exists' }))
    expect(await call('admin-uid', { staffId: 'staff-1', newEmail: 'a@b.c' })).toEqual({
      status: 409,
      body: { error: 'This email is already used by a different account.' },
    })
    fb.updateUser.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'auth/invalid-email' }))
    expect(await call('admin-uid', { staffId: 'staff-1', newEmail: 'bad' })).toEqual({ status: 400, body: { error: 'That email address is not valid.' } })
  })
})

describe('POST /api/staff/send-reset-email', () => {
  const call = async (uid: string, staffId: unknown) => json(await sendResetPOST(request('POST', '/api/staff/send-reset-email', uid, { staffId })))

  it('no account yet: creates one, links it, audits grant_access and sends the reset email', async () => {
    fb.createUser.mockImplementation(async ({ email }: { email: string }) => {
      const u = { uid: 'bo-uid', email }
      fb.users.set(email, u)
      return u
    })
    const res = await call('admin-uid', 'staff-2')
    expect(res).toEqual({ status: 200, body: { linked: true, email: 'bo@nwu.test', uid: 'bo-uid' } })
    const [row] = await db.select().from(staff).where(eq(staff.id, 'staff-2'))
    expect(row.uid).toBe('bo-uid')
    expect(fb.resetSent).toEqual(['bo@nwu.test'])
    const [entry] = await audits()
    expect(entry).toMatchObject({
      user_id: 'admin-uid',
      user_name: 'Ada Admin',
      action: 'grant_access',
      entity_type: 'staff',
      entity_id: 'staff-2',
      before: { full_name: 'Bo Rrower', email: 'bo@nwu.test', uid: 'bo-uid' },
      after: { full_name: 'Bo Rrower', email: 'bo@nwu.test', uid: 'bo-uid' },
    })
  })

  it('already linked: resends to the account\'s own email and audits resend_access without relinking', async () => {
    fb.users.set('sam.login@nwu.test', { uid: 'sam-uid', email: 'sam.login@nwu.test' })
    const res = await call('admin-uid', 'staff-1')
    expect(res).toEqual({ status: 200, body: { linked: false, email: 'sam.login@nwu.test', uid: 'sam-uid' } })
    expect(fb.resetSent).toEqual(['sam.login@nwu.test'])
    const [entry] = await audits()
    expect(entry).toMatchObject({
      action: 'resend_access',
      entity_id: 'staff-1',
      after: { full_name: 'Sam Staff', email: 'sam.login@nwu.test', uid: 'sam-uid' },
    })
  })

  it('an Auth account that exists for the email is linked (and audited) when no other staff row owns it', async () => {
    fb.users.set('bo@nwu.test', { uid: 'bo-existing', email: 'bo@nwu.test' })
    const res = await call('admin-uid', 'staff-2')
    expect(res).toEqual({ status: 200, body: { linked: true, email: 'bo@nwu.test', uid: 'bo-existing' } })
    const [row] = await db.select().from(staff).where(eq(staff.id, 'staff-2'))
    expect(row.uid).toBe('bo-existing')
    expect((await audits()).map((a) => a.action)).toEqual(['grant_access'])
  })

  it('an Auth account already linked to ANOTHER staff row is a 409 with today\'s message and nothing is written or sent', async () => {
    fb.users.set('bo@nwu.test', { uid: 'sam-uid', email: 'bo@nwu.test' })
    const res = await call('admin-uid', 'staff-2')
    expect(res).toEqual({
      status: 409,
      body: {
        error:
          'This email is already linked to another staff record (Sam Staff). Fix the email or contact support before sending a login email.',
      },
    })
    expect(fb.resetSent).toEqual([])
    expect(await audits()).toHaveLength(0)
    const [row] = await db.select().from(staff).where(eq(staff.id, 'staff-2'))
    expect(row.uid).toBeNull()
  })

  it('with the mailer on, sends our own email through it instead of Firebase\'s', async () => {
    fb.mailEnabled = true
    fb.users.set('sam.login@nwu.test', { uid: 'sam-uid', email: 'sam.login@nwu.test' })
    const res = await call('admin-uid', 'staff-1')
    expect(res.status).toBe(200)
    expect(fb.resetSent).toEqual([])
    expect(fb.mailSent).toHaveLength(1)
    expect(fb.mailSent[0].to).toBe('sam.login@nwu.test')
  })

  it('keeps today\'s errors: 403, 400 and 404, and a record with no email', async () => {
    expect(await call('sam-uid', 'staff-2')).toEqual({ status: 403, body: { error: 'Only admins can manage staff logins.' } })
    expect(await call('admin-uid', undefined)).toEqual({ status: 400, body: { error: 'Missing staffId.' } })
    expect(await call('admin-uid', 'nope')).toEqual({ status: 404, body: { error: 'Staff record not found.' } })
    expect(await call('admin-uid', 'staff-3')).toEqual({ status: 400, body: { error: 'This staff member has no email on file.' } })
    expect(await audits()).toHaveLength(0)
  })
})

describe('POST /api/admin/update-name', () => {
  const call = async (uid: string | undefined, body: unknown) => json(await updateNamePOST(request('POST', '/api/admin/update-name', uid, body)))

  it('updates the caller\'s own profile name', async () => {
    expect(await call('admin-uid', { fullName: '  Ada L  ' })).toEqual({ status: 200, body: { full_name: 'Ada L' } })
    const [p] = await db.select().from(profiles).where(eq(profiles.uid, 'admin-uid'))
    expect(p.full_name).toBe('Ada L')
  })

  it('keeps today\'s errors: 401, 400, and 404 for a caller with no profile', async () => {
    expect((await call(undefined, { fullName: 'x' })).status).toBe(401)
    expect(await call('admin-uid', {})).toEqual({ status: 400, body: { error: 'Missing fullName.' } })
    expect(await call('borrower-uid', { fullName: 'x' })).toEqual({ status: 404, body: { error: 'No BICS profile found for this account.' } })
  })
})

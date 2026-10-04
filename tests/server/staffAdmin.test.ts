import { NextRequest } from 'next/server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ApiError, assertAdmin, requireAdmin, requireRecentSignIn, requireSignedIn } from '@/lib/server/staffAdmin'
import { profiles } from '@/server/db/schema'
import { installFakeAuth, tokenFor } from '../helpers/auth'
import { closeTestDb, resetTestDb } from '../helpers/db'

let restore: () => void
let authTime = Math.floor(Date.now() / 1000)

const req = (token?: string) =>
  new NextRequest('http://localhost/api/x', { method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {} })

beforeAll(async () => {
  const db = await resetTestDb()
  restore = installFakeAuth(db, { authTime: () => authTime })
  await db.insert(profiles).values([
    { uid: 'admin-uid', full_name: 'Ada Admin', role: 'admin' },
    { uid: 'staff-uid', full_name: 'Sam Staff', role: 'staff' },
  ])
})
afterAll(async () => {
  restore()
  await closeTestDb()
})

const failure = async (p: Promise<unknown>) => p.then(() => null, (e) => e as ApiError)

describe('staffAdmin guards (role read from PostgreSQL profiles)', () => {
  it('requireSignedIn: missing header and expired token keep their 401 messages', async () => {
    expect(await failure(requireSignedIn(req()))).toMatchObject({ status: 401, message: 'Missing Authorization header.' })
    expect(await failure(requireSignedIn(req('bad')))).toMatchObject({
      status: 401,
      message: 'Invalid or expired session — please sign in again.',
    })
    expect(await requireSignedIn(req(tokenFor('staff-uid')))).toEqual({ uid: 'staff-uid' })
  })

  it('requireAdmin: admin passes; staff, borrower with no profile → 403 with the existing message', async () => {
    expect(await requireAdmin(req(tokenFor('admin-uid')))).toEqual({ uid: 'admin-uid' })
    for (const uid of ['staff-uid', 'no-profile']) {
      expect(await failure(requireAdmin(req(tokenFor(uid))))).toMatchObject({
        status: 403,
        message: 'Only admins can manage staff logins.',
      })
    }
  })

  it('assertAdmin accepts a custom message', async () => {
    await expect(assertAdmin('admin-uid', 'x')).resolves.toBeUndefined()
    expect(await failure(assertAdmin('staff-uid', 'Only administrators can change their login email here.'))).toMatchObject({
      status: 403,
      message: 'Only administrators can change their login email here.',
    })
  })

  it('requireRecentSignIn rejects an old sign-in with the existing 401 message', async () => {
    authTime = Math.floor(Date.now() / 1000) - 3600
    expect(await failure(requireRecentSignIn(req(tokenFor('admin-uid')), 300))).toMatchObject({
      status: 401,
      message: 'For security, enter your current password again and retry.',
    })
    authTime = Math.floor(Date.now() / 1000)
    expect(await requireRecentSignIn(req(tokenFor('admin-uid')), 300)).toEqual({ uid: 'admin-uid' })
  })
})

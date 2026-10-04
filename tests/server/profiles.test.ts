import { NextRequest } from 'next/server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getMe } from '@/server/data/profiles'
import { GET } from '@/app/api/me/route'
import { profiles, staff } from '@/server/db/schema'
import type { Db } from '@/server/db/client'
import { loadCaller, type Ctx } from '@/server/context'
import { installFakeAuth, tokenFor } from '../helpers/auth'
import { closeTestDb, resetTestDb } from '../helpers/db'

let db: Db
let restore: () => void

const created = new Date('2026-03-01T08:30:00.000Z')
const updated = new Date('2026-04-02T10:15:30.000Z')

beforeAll(async () => {
  db = await resetTestDb()
  restore = installFakeAuth(db)
  await db.insert(profiles).values([
    { uid: 'admin-uid', full_name: 'Ada Admin', role: 'admin', created_at: created },
    { uid: 'both-uid', full_name: 'Both Person', role: 'staff', created_at: created },
  ])
  await db.insert(staff).values([
    { id: 'staff-admin-row', name: 'Ada', surname: 'Admin', full_name: 'Ada Admin', uid: 'admin-uid', is_admin_account: true },
    {
      id: 'staff-both-row',
      name: 'Both',
      surname: 'Person',
      full_name: 'Both Person',
      email: 'both@example.com',
      department: 'IT',
      card_uid: 'CARD1',
      uid: 'both-uid',
      created_at: created,
      updated_at: updated,
    },
    { id: 'borrower-row', name: 'Bo', surname: 'Rrower', full_name: 'Bo Rrower', uid: 'borrower-uid', is_active: false },
    { id: 'unlinked-row', name: 'Un', surname: 'Linked', full_name: 'Un Linked' },
  ])
})
afterAll(async () => {
  restore()
  await closeTestDb()
})

async function ctxFor(uid: string): Promise<Ctx> {
  return { db, caller: await loadCaller(db, uid), now: () => new Date() }
}

describe('getMe', () => {
  it('returns the own profile (id = uid, ISO timestamp) and the linked staff row', async () => {
    const me = await getMe(await ctxFor('both-uid'))
    expect(me.profile).toEqual({ id: 'both-uid', full_name: 'Both Person', role: 'staff', created_at: created.toISOString() })
    expect(me.staff).toEqual({
      id: 'staff-both-row',
      name: 'Both',
      surname: 'Person',
      full_name: 'Both Person',
      email: 'both@example.com',
      department: 'IT',
      card_uid: 'CARD1',
      is_active: true,
      uid: 'both-uid',
      is_admin_account: false,
      created_at: created.toISOString(),
      updated_at: updated.toISOString(),
    })
  })

  it('never returns another user\'s rows', async () => {
    const me = await getMe(await ctxFor('admin-uid'))
    expect(me.profile?.id).toBe('admin-uid')
    expect(me.staff?.id).toBe('staff-admin-row')
    expect(JSON.stringify(me)).not.toContain('Both')
    expect(JSON.stringify(me)).not.toContain('borrower')
  })

  it('a portal borrower has no profile: profile is null, staff is the linked row', async () => {
    const me = await getMe(await ctxFor('borrower-uid'))
    expect(me.profile).toBeNull()
    expect(me.staff).toMatchObject({ id: 'borrower-row', is_active: false, uid: 'borrower-uid' })
  })

  it('a user with neither gets nulls', async () => {
    expect(await getMe(await ctxFor('nobody-uid'))).toEqual({ profile: null, staff: null })
  })
})

describe('GET /api/me', () => {
  const req = (token?: string) =>
    new NextRequest('http://localhost/api/me', { headers: token ? { authorization: `Bearer ${token}` } : {} })

  it('returns the caller\'s own profile and staff', async () => {
    const res = await GET(req(tokenFor('both-uid')))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.profile.id).toBe('both-uid')
    expect(body.staff.id).toBe('staff-both-row')
  })

  it('401 without a token or with an expired one', async () => {
    expect((await GET(req())).status).toBe(401)
    const res = await GET(req('expired'))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Invalid or expired session — please sign in again.' })
  })
})

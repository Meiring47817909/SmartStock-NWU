import { NextRequest } from 'next/server'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { DataError, assertStaffSelf, type Ctx } from '@/server/context'
import { route } from '@/server/http'
import { profiles, staff } from '@/server/db/schema'
import type { Db } from '@/server/db/client'
import { installFakeAuth, tokenFor } from '../helpers/auth'
import { closeTestDb, resetTestDb } from '../helpers/db'

let db: Db
let restore: () => void

beforeAll(async () => {
  db = await resetTestDb()
  restore = installFakeAuth(db)
  await db.insert(profiles).values([
    { uid: 'admin-uid', full_name: 'Ada Admin', role: 'admin' },
    { uid: 'staff-uid', full_name: 'Profile Name', role: 'staff' },
  ])
  await db.insert(staff).values([
    { id: 'staff-row-1', name: 'Sam', surname: 'Staff', full_name: 'Sam Staff', uid: 'staff-uid' },
    { id: 'borrower-row', name: 'Bo', surname: 'Rrower', full_name: 'Bo Rrower', uid: 'borrower-uid' },
  ])
})

afterAll(async () => {
  restore()
  await closeTestDb()
})

function req(method: 'GET' | 'POST', opts: { token?: string; body?: unknown; query?: string } = {}) {
  return new NextRequest(`http://localhost/api/test${opts.query ?? ''}`, {
    method,
    headers: {
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  })
}

describe('route()', () => {
  it('public route works signed out', async () => {
    const handler = route('public', async (ctx, body: { x: number }) => ({ uid: ctx.caller.uid, doubled: body.x * 2 }))
    const res = await handler(req('POST', { body: { x: 4 } }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ uid: null, doubled: 8 })
  })

  it('public route ignores a bad token instead of failing', async () => {
    const handler = route('public', async (ctx) => ({ uid: ctx.caller.uid }))
    const res = await handler(req('GET', { token: 'garbage' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ uid: null })
  })

  it('signed-in route without a token → 401 "Missing Authorization header."', async () => {
    const handler = route('signed-in', async () => ({ ok: true }))
    const res = await handler(req('GET'))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Missing Authorization header.' })
  })

  it('expired token → 401 "Invalid or expired session — please sign in again."', async () => {
    const handler = route('signed-in', async () => ({ ok: true }))
    const res = await handler(req('GET', { token: 'expired-token' }))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Invalid or expired session — please sign in again.' })
  })

  it('expired token on an admin route → the same 401', async () => {
    const handler = route('admin', async () => ({ ok: true }))
    const res = await handler(req('POST', { token: 'expired-token', body: {} }))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe('Invalid or expired session — please sign in again.')
  })

  it('staff caller on an admin route → 403', async () => {
    const handler = vi.fn(async () => ({ ok: true }))
    const res = await route('admin', handler)(req('POST', { token: tokenFor('staff-uid'), body: {} }))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Only admins can do this.' })
    expect(handler).not.toHaveBeenCalled()
  })

  it('admin caller on an admin route succeeds', async () => {
    const res = await route('admin', async () => ({ ok: true }))(req('POST', { token: tokenFor('admin-uid'), body: {} }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('caller carries role from profiles and staffId from staff.uid', async () => {
    const handler = route('signed-in', async (ctx) => ctx.caller)
    expect(await (await handler(req('GET', { token: tokenFor('admin-uid') }))).json()).toEqual({
      uid: 'admin-uid',
      name: 'Ada Admin',
      role: 'admin',
      staffId: null,
    })
    expect(await (await handler(req('GET', { token: tokenFor('staff-uid') }))).json()).toEqual({
      uid: 'staff-uid',
      name: 'Profile Name',
      role: 'staff',
      staffId: 'staff-row-1',
    })
  })

  it('a portal borrower with no profile is a staff-role caller named after the staff record', async () => {
    const handler = route('signed-in', async (ctx) => ctx.caller)
    const res = await handler(req('GET', { token: tokenFor('borrower-uid') }))
    expect(await res.json()).toEqual({ uid: 'borrower-uid', name: 'Bo Rrower', role: 'staff', staffId: 'borrower-row' })
  })

  it('a signed-in user with neither profile nor staff row has a null name and staffId', async () => {
    const handler = route('signed-in', async (ctx) => ctx.caller)
    const res = await handler(req('GET', { token: tokenFor('nobody') }))
    expect(await res.json()).toEqual({ uid: 'nobody', name: null, role: 'staff', staffId: null })
  })

  it('GET handlers receive the query params as the body', async () => {
    const handler = route('public', async (_ctx, body: Record<string, string>) => body)
    const res = await handler(req('GET', { query: '?a=1&b=two' }))
    expect(await res.json()).toEqual({ a: '1', b: 'two' })
  })

  it('passes dynamic-segment params to the handler (catch-all values joined with "/")', async () => {
    const handler = route('public', async (_ctx, _body, _req, params) => params)
    const res = await handler(req('GET'), { params: Promise.resolve({ id: 'abc', rest: ['x', 'y'] }) })
    expect(await res.json()).toEqual({ id: 'abc', rest: 'x/y' })
    const none = await handler(req('GET'))
    expect(await none.json()).toEqual({})
  })

  it('ctx.now defaults to the current time and ctx.db is the test database', async () => {
    const handler = route('public', async (ctx) => ({ sameDb: ctx.db === db, near: Math.abs(ctx.now().getTime() - Date.now()) < 5000 }))
    expect(await (await handler(req('GET'))).json()).toEqual({ sameDb: true, near: true })
  })

  it('DataError(409) keeps its status and message', async () => {
    const handler = route('public', async () => {
      throw new DataError(409, 'Barcode already used by Widget.')
    })
    const res = await handler(req('POST', { body: {} }))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'Barcode already used by Widget.' })
  })

  it('unexpected error → 500 generic message, logged', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const handler = route('public', async () => {
        throw new Error('connection refused to 10.0.0.5')
      })
      const res = await handler(req('POST', { body: {} }))
      expect(res.status).toBe(500)
      expect(await res.json()).toEqual({ error: 'Something went wrong.' })
      expect(spy).toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })
})

describe('assertStaffSelf', () => {
  const ctxFor = (caller: Ctx['caller']): Ctx => ({ db, caller, now: () => new Date() })
  it('allows an admin, and a caller acting on their own staff record', () => {
    expect(() => assertStaffSelf(ctxFor({ uid: 'a', name: null, role: 'admin', staffId: null }), 'x')).not.toThrow()
    expect(() => assertStaffSelf(ctxFor({ uid: 's', name: null, role: 'staff', staffId: 'x' }), 'x')).not.toThrow()
  })
  it("rejects a caller acting on someone else's record with 403", () => {
    expect(() => assertStaffSelf(ctxFor({ uid: 's', name: null, role: 'staff', staffId: 'y' }), 'x')).toThrowError(
      expect.objectContaining({ status: 403 }),
    )
  })
})

// Route tests for /api/dashboard: admin only (401 signed out, 403 for staff), the two answers, and an unknown kind.
import { NextRequest } from 'next/server'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { GET } from '@/app/api/dashboard/route'
import { loanRequestLines, loanRequests, products, profiles, staff, transactionLines, transactions } from '@/server/db/schema'
import type { Db } from '@/server/db/client'
import { installFakeAuth, tokenFor } from '../helpers/auth'
import { closeTestDb, resetTestDb } from '../helpers/db'

let db: Db
let restore: () => void

const get = (url: string, uid?: string) =>
  GET(new NextRequest(`http://localhost${url}`, { method: 'GET', headers: uid ? { authorization: `Bearer ${tokenFor(uid)}` } : {} })).then(
    async (res) => ({ status: res.status, body: await res.json() }),
  )

beforeAll(async () => {
  db = await resetTestDb()
  restore = installFakeAuth(db)
})
afterAll(async () => {
  restore()
  await closeTestDb()
})

beforeEach(async () => {
  await db.delete(transactionLines)
  await db.delete(transactions)
  await db.delete(loanRequestLines)
  await db.delete(loanRequests)
  await db.delete(products)
  await db.delete(staff)
  await db.delete(profiles)
  await db.insert(profiles).values([
    { uid: 'admin-uid', full_name: 'Ada Admin', role: 'admin' },
    { uid: 'sam-uid', full_name: 'Sam Staff', role: 'staff' },
  ])
  await db.insert(staff).values({ id: 'staff-1', name: 'Sam', surname: 'Staff', full_name: 'Sam Staff', email: 'sam@nwu.test', uid: 'sam-uid' })
  await db.insert(products).values([
    { id: 'p1', name: 'Projector', quantity_on_hand: 0, reorder_threshold: 1 },
    { id: 'p2', name: 'Cable', quantity_on_hand: 9, reorder_threshold: 1 },
  ])
  await db.insert(transactions).values({ id: 't1', transaction_type: 'OUT', reference_no: 'TXN-AAAAAAAA', staff_id: 'staff-1', staff_name: 'Sam Staff', lend_to: '2020-01-01' })
  await db.insert(transactionLines).values({ id: 't1-l0', transaction_id: 't1', product_id: 'p1', product_name: 'Projector', line_no: 0, quantity: 1 })
})

describe('/api/dashboard', () => {
  it('signed out is a 401, staff a 403', async () => {
    const signedOut = { status: 401, body: { error: 'Missing Authorization header.' } }
    expect(await get('/api/dashboard')).toEqual(signedOut)
    expect(await get('/api/dashboard?kind=alertCounts')).toEqual(signedOut)
    expect((await get('/api/dashboard', 'sam-uid')).status).toBe(403)
    expect((await get('/api/dashboard?kind=alertCounts', 'sam-uid')).status).toBe(403)
  })

  it('answers the dashboard and the badge counts for an admin', async () => {
    const dash = await get('/api/dashboard', 'admin-uid')
    expect(dash.status).toBe(200)
    expect(dash.body.outstandingReturns).toMatchObject([{ id: 't1_p1', qty: 1, status: 'overdue', staff_name: 'Sam Staff', txn_ref: 'TXN-AAAAAAAA' }])
    expect(dash.body.lowStock).toMatchObject([{ id: 'p1', status: 'out_of_stock' }])
    expect(dash.body.incomingPickups).toEqual([])
    expect(dash.body.stats).toMatchObject({ total_products: 2, total_stock: 9, low_stock: 1, total_staff: 1 })
    expect(await get('/api/dashboard?kind=alertCounts', 'admin-uid')).toEqual({
      status: 200,
      body: { outstandingReturns: 1, lowStock: 1, incomingPickups: 0, total: 2 },
    })
  })

  it('an unknown kind is a 400', async () => {
    expect(await get('/api/dashboard?kind=nope', 'admin-uid')).toEqual({ status: 400, body: { error: 'Unknown request.' } })
  })
})

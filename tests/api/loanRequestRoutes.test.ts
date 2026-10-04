// Route tests for /api/loan-requests/*: signed-out is a 401, access follows the data layer (staff only their own, admin
// actions a 403 for staff), and one end-to-end pass. Also /api/products/expected-return-dates against a PostgreSQL fixture.
import { eq } from 'drizzle-orm'
import { NextRequest } from 'next/server'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { GET as listGET, POST as listPOST } from '@/app/api/loan-requests/route'
import { GET as oneGET } from '@/app/api/loan-requests/[id]/route'
import { POST as transitionPOST } from '@/app/api/loan-requests/[id]/transition/route'
import { POST as expectedReturnPOST } from '@/app/api/products/expected-return-dates/route'
import {
  auditLog,
  loanRequestLines,
  loanRequests,
  productBarcodes,
  products,
  profiles,
  returnWaivers,
  staff,
  transactionLines,
  transactions,
} from '@/server/db/schema'
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
const json = async (res: Response) => ({ status: res.status, body: await res.json() })
const segment = (id: string) => ({ params: Promise.resolve({ id }) })
const transition = (id: string, uid: string | undefined, body: unknown) =>
  transitionPOST(request('POST', `/api/loan-requests/${id}/transition`, uid, body), segment(id)).then(json)

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
  await db.delete(returnWaivers)
  await db.delete(transactionLines)
  await db.update(loanRequests).set({ fulfilled_txn_id: null })
  await db.delete(transactions)
  await db.delete(loanRequestLines)
  await db.delete(loanRequests)
  await db.delete(productBarcodes)
  await db.delete(products)
  await db.delete(staff)
  await db.delete(profiles)
  await db.insert(profiles).values([
    { uid: 'admin-uid', full_name: 'Ada Admin', role: 'admin' },
    { uid: 'sam-uid', full_name: 'Sam Staff', role: 'staff' },
    { uid: 'bo-uid', full_name: 'Bo Rrower', role: 'staff' },
  ])
  await db.insert(staff).values([
    { id: 'staff-1', name: 'Sam', surname: 'Staff', full_name: 'Sam Staff', email: 'sam@nwu.test', uid: 'sam-uid' },
    { id: 'staff-2', name: 'Bo', surname: 'Rrower', full_name: 'Bo Rrower', email: 'bo@nwu.test', uid: 'bo-uid' },
  ])
  await db.insert(products).values([
    { id: 'p1', name: 'Projector', quantity_on_hand: 5, lend_from: '2026-01-01', lending_interval: 'week_1' },
    { id: 'p2', name: 'Cable', quantity_on_hand: 0, lend_from: '2026-01-01', lending_interval: 'week_1' },
    { id: 'p3', name: 'Laptop', quantity_on_hand: 0 },
  ])
})

describe('/api/loan-requests', () => {
  it('signed out: 401 on every route', async () => {
    const expected = { status: 401, body: { error: 'Missing Authorization header.' } }
    expect(await json(await listGET(request('GET', '/api/loan-requests')))).toEqual(expected)
    expect(await json(await listPOST(request('POST', '/api/loan-requests', undefined, { action: 'submit' })))).toEqual(expected)
    expect(await json(await oneGET(request('GET', '/api/loan-requests/x'), segment('x')))).toEqual(expected)
    expect(await transition('x', undefined, { action: 'approve' })).toEqual(expected)
    // An expired or invalid token: the standard message.
    const bad = new NextRequest('http://localhost/api/loan-requests', { headers: { authorization: 'Bearer nonsense' } })
    expect(await json(await listGET(bad))).toEqual({ status: 401, body: { error: 'Invalid or expired session — please sign in again.' } })
  })

  it('submit, list, read, counter, accept, with access enforced by the data layer', async () => {
    const submitted = await json(
      await listPOST(
        request('POST', '/api/loan-requests', 'sam-uid', {
          action: 'submit',
          cart: [{ productId: 'p1', quantity: 2 }],
          fromDate: '2099-10-10',
          toDate: '2099-10-14',
          message: 'Open day',
        }),
      ),
    )
    expect(submitted.status).toBe(200)
    const id = submitted.body.id as string

    // Validation endpoint: the messages are the portal's own.
    expect(
      await json(await listPOST(request('POST', '/api/loan-requests', 'sam-uid', { action: 'validate', cart: [{ productId: 'p1', quantity: 9 }], fromDate: '2099-10-10', toDate: '2099-10-12' }))),
    ).toEqual({ status: 200, body: { valid: false, errors: ['Projector: only 3 unit(s) available for these dates, you requested 9.'] } })
    expect((await json(await listPOST(request('POST', '/api/loan-requests', 'sam-uid', { action: 'nope' })))).status).toBe(400)

    // Staff see their own, not each other's.
    const mine = await json(await listGET(request('GET', '/api/loan-requests?statuses=pending,countered', 'sam-uid')))
    expect(mine.body.map((r: { id: string }) => r.id)).toEqual([id])
    expect((await json(await listGET(request('GET', '/api/loan-requests', 'bo-uid')))).body).toEqual([])
    expect((await json(await listGET(request('GET', '/api/loan-requests?staffId=staff-1', 'bo-uid')))).status).toBe(403)
    expect((await json(await oneGET(request('GET', `/api/loan-requests/${id}`, 'bo-uid'), segment(id)))).status).toBe(404)
    const one = await json(await oneGET(request('GET', `/api/loan-requests/${id}`, 'sam-uid'), segment(id)))
    expect(one.body.request).toMatchObject({ id, status: 'pending', staff_name: 'Sam Staff' })
    expect(one.body.lines).toHaveLength(1)

    // Admin-only: 403 for staff.
    expect((await transition(id, 'sam-uid', { action: 'approve' })).status).toBe(403)
    expect((await json(await listGET(request('GET', '/api/loan-requests?kind=holders&productId=p1&fromDate=2099-10-01&toDate=2099-10-31', 'sam-uid')))).status).toBe(403)
    expect((await json(await listGET(request('GET', '/api/loan-requests?kind=alertCount', 'sam-uid')))).status).toBe(403)
    expect((await json(await listGET(request('GET', '/api/loan-requests?kind=alertCount', 'admin-uid')))).body).toEqual({ count: 1 })
    expect((await json(await listGET(request('GET', '/api/loan-requests?kind=myAlertCount', 'sam-uid')))).body).toEqual({ count: 1 })

    // Admin counters; the staff member accepts; nobody else can.
    const lineId = (await db.select().from(loanRequestLines))[0].id
    const countered = await transition(id, 'admin-uid', { action: 'counter', lines: [{ lineId, product_id: 'p1', offered_quantity: 1 }], message: 'One only' })
    expect(countered).toMatchObject({ status: 200, body: { id, status: 'countered', admin_message: 'One only' } })
    expect((await transition(id, 'bo-uid', { action: 'acceptCounter' })).status).toBe(404)
    expect((await transition(id, 'admin-uid', { action: 'approve' })).body).toEqual({ error: 'This request has already changed — reload to see its current state.' })
    expect(await transition(id, 'sam-uid', { action: 'acceptCounter' })).toMatchObject({ status: 200, body: { status: 'accepted' } })
    expect((await transition(id, 'sam-uid', { action: 'frobnicate' })).status).toBe(400)

    // The reads Stock Out, the cart and the Products page use.
    const holders = await json(await listGET(request('GET', '/api/loan-requests?kind=holders&productId=p1&fromDate=2099-10-01&toDate=2099-10-31&statuses=accepted', 'admin-uid')))
    expect(holders.body).toEqual([{ requestId: id, staffId: 'staff-1', staffName: 'Sam Staff', quantity: 1, fromDate: '2099-10-10', toDate: '2099-10-14', status: 'accepted' }])
    expect((await json(await listGET(request('GET', '/api/loan-requests?kind=reserved&productId=p1&fromDate=2099-10-14&toDate=2099-10-15', 'bo-uid')))).body).toEqual({ quantity: 1 })
    expect((await json(await listGET(request('GET', `/api/loan-requests?kind=reserved&productId=p1&fromDate=2099-10-14&toDate=2099-10-15&excludeRequestId=${id}`, 'bo-uid')))).body).toEqual({ quantity: 0 })
    expect((await json(await listGET(request('GET', '/api/loan-requests?kind=intervals&productIds=p1,p2', 'bo-uid')))).body).toEqual({
      p1: [{ fromDate: '2099-10-10', toDate: '2099-10-14', quantity: 1 }],
      p2: [],
    })
    expect((await json(await listGET(request('GET', '/api/loan-requests?kind=quantityConflicts&productId=p1&quantity=0', 'admin-uid')))).body).toHaveLength(1)
    expect((await json(await listGET(request('GET', '/api/loan-requests?kind=nope', 'admin-uid')))).status).toBe(400)
    // A missing or malformed quantity is a 400, never "no conflicts".
    for (const q of ['', '&quantity=', '&quantity=abc', '&quantity=-1', '&quantity=1.5', '&quantity=1e3']) {
      expect(await json(await listGET(request('GET', `/api/loan-requests?kind=quantityConflicts&productId=p1${q}`, 'admin-uid')))).toEqual({
        status: 400,
        body: { error: 'Quantity must be a whole number, zero or more.' },
      })
    }

    // withdraw by the owner, with the lazy expiry pass available as an action
    expect(await transition(id, 'sam-uid', { action: 'expire' })).toEqual({ status: 200, body: { status: 'accepted' } })
    expect(await transition(id, 'sam-uid', { action: 'withdraw' })).toMatchObject({ status: 200, body: { status: 'withdrawn' } })
    expect((await db.select().from(auditLog).where(eq(auditLog.entity_id, id))).map((a) => a.action)).toEqual(['create', 'update', 'update', 'update'])
  })
})

describe('/api/products/expected-return-dates', () => {
  async function out(id: string, ref: string, lendTo: string | null, lines: [string, number][], type: 'OUT' | 'RETURN' = 'OUT', linked?: string) {
    await db.insert(transactions).values({
      id, transaction_type: type, reference_no: ref, staff_id: 'staff-1', staff_name: 'Sam Staff', lend_to: lendTo, linked_txn_id: linked ?? null,
    })
    await db.insert(transactionLines).values(
      lines.map(([productId, quantity], i) => ({
        id: `${id}-l${i}`, transaction_id: id, product_id: productId, product_name: productId, line_no: i, quantity,
      })),
    )
  }

  it('returns the earliest due date among loans still outstanding, per product', async () => {
    // p1: A (due 10-20, 2 out in two scan lines, 1 returned), B (due 10-10, fully returned), C (open-ended), D (due 10-15, 1 out).
    await out('A', 'TXN-AAAAAAAA', '2099-10-20', [['p1', 1], ['p1', 1]])
    await out('RA', 'TXN-RRRRRRR1', null, [['p1', 1]], 'RETURN', 'A')
    await out('B', 'TXN-BBBBBBBB', '2099-10-10', [['p1', 1]])
    await out('RB', 'TXN-RRRRRRR2', null, [['p1', 1]], 'RETURN', 'B')
    await out('C', 'TXN-CCCCCCCC', null, [['p1', 3]])
    await out('D', 'TXN-DDDDDDDD', '2099-10-15', [['p1', 1]])
    // p2: out on A-like loan but written off; p3: out, due later, outstanding; p4: not asked about.
    await out('E', 'TXN-EEEEEEEE', '2099-10-12', [['p2', 1], ['p3', 2]])
    await db.insert(returnWaivers).values({ id: 'w1', transaction_id: 'E', product_id: 'p2', product_name: 'Cable', staff_id: 'staff-1', quantity: 1, reason: 'Kept' })

    const res = await expectedReturnPOST(request('POST', '/api/products/expected-return-dates', 'bo-uid', { productIds: ['p1', 'p2', 'p3', 'p9', 42] }))
    expect(await json(res)).toEqual({ status: 200, body: { expectedReturn: { p1: '2099-10-15', p2: null, p3: '2099-10-12', p9: null } } })
  })

  it('is open to any signed-in user, 401 otherwise, and answers {} for an empty list', async () => {
    expect((await expectedReturnPOST(request('POST', '/api/products/expected-return-dates', undefined, { productIds: ['p1'] }))).status).toBe(401)
    expect(await json(await expectedReturnPOST(request('POST', '/api/products/expected-return-dates', 'sam-uid', { productIds: [] })))).toEqual({ status: 200, body: { expectedReturn: {} } })
    expect(await json(await expectedReturnPOST(request('POST', '/api/products/expected-return-dates', 'sam-uid', {})))).toEqual({ status: 200, body: { expectedReturn: {} } })
  })
})

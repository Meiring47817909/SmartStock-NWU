// Route tests for /api/stock/*: access (401 signed out, 403 for a staff caller, admin only) and one end-to-end pass.
import { eq } from 'drizzle-orm'
import { NextRequest } from 'next/server'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { POST as inPOST } from '@/app/api/stock/in/route'
import { POST as outPOST } from '@/app/api/stock/out/route'
import { POST as returnPOST } from '@/app/api/stock/return/route'
import { GET as waiversGET, POST as waiversPOST } from '@/app/api/stock/waivers/route'
import { GET as outstandingGET } from '@/app/api/stock/outstanding/route'
import {
  auditLog,
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
  await db.delete(transactions)
  await db.delete(productBarcodes)
  await db.delete(products)
  await db.delete(staff)
  await db.delete(profiles)
  await db.insert(profiles).values([
    { uid: 'admin-uid', full_name: 'Ada Admin', role: 'admin' },
    { uid: 'sam-uid', full_name: 'Sam Staff', role: 'staff' },
  ])
  await db.insert(staff).values({ id: 'staff-1', name: 'Sam', surname: 'Staff', full_name: 'Sam Staff', uid: 'sam-uid' })
  await db.insert(products).values({ id: 'p1', name: 'Projector', quantity_on_hand: 2 })
  await db.insert(productBarcodes).values({ barcode: 'P1A', product_id: 'p1', position: 0 })
})

describe('/api/stock/*', () => {
  it('rejects a signed-out caller with 401 and a staff caller with 403, writing nothing', async () => {
    const out = { staffId: 'staff-1', items: [{ productId: 'p1', quantity: 1, barcodes: ['P1A'] }], lendFrom: '2026-10-04' }
    const calls: [string, (uid?: string) => Promise<Response>][] = [
      ['in', (u) => inPOST(request('POST', '/api/stock/in', u, { items: out.items, notes: '' }))],
      ['out', (u) => outPOST(request('POST', '/api/stock/out', u, out))],
      ['return', (u) => returnPOST(request('POST', '/api/stock/return', u, { staffId: 'staff-1', linkedTxnId: 'x', items: out.items }))],
      ['waivers', (u) => waiversPOST(request('POST', '/api/stock/waivers', u, { transactionId: 'x', productId: 'p1', quantity: 1 }))],
      ['waivers list', (u) => waiversGET(request('GET', '/api/stock/waivers', u))],
      ['outstanding', (u) => outstandingGET(request('GET', '/api/stock/outstanding?staffId=staff-1', u))],
    ]
    for (const [name, call] of calls) {
      expect([name, (await json(await call(undefined))).status]).toEqual([name, 401])
      expect([name, (await json(await call('sam-uid'))).status]).toEqual([name, 403])
    }
    expect(await db.select().from(transactions)).toHaveLength(0)
    expect((await db.select().from(products).where(eq(products.id, 'p1')))[0].quantity_on_hand).toBe(2)
  })

  it('runs Stock In, Stock Out, outstanding, Return and a waiver end to end for an admin', async () => {
    const received = await json(await inPOST(request('POST', '/api/stock/in', 'admin-uid', { items: [{ productId: 'p1', quantity: 1, barcodes: ['P1A'] }], notes: 'PO 1' })))
    expect(received.status).toBe(200)
    expect(received.body.reference_no).toMatch(/^TXN-[A-Z0-9]{8}$/)

    const issued = await json(await outPOST(request('POST', '/api/stock/out', 'admin-uid', {
      staffId: 'staff-1',
      items: [{ productId: 'p1', quantity: 3, barcodes: ['P1A'] }],
      lendFrom: '2026-10-04',
      lendTo: '2026-10-11',
    })))
    expect(issued.status).toBe(200)

    const tooMany = await json(await outPOST(request('POST', '/api/stock/out', 'admin-uid', {
      staffId: 'staff-1',
      items: [{ productId: 'p1', quantity: 1, barcodes: ['P1A'] }],
      lendFrom: '2026-10-04',
    })))
    expect(tooMany).toEqual({ status: 409, body: { error: 'Not enough stock for Projector.' } })

    const open = await json(await outstandingGET(request('GET', '/api/stock/outstanding?staffId=staff-1', 'admin-uid')))
    expect(open.status).toBe(200)
    expect(open.body.lines).toHaveLength(1)
    expect(open.body.lines[0]).toMatchObject({ txn_id: issued.body.id, barcode: 'P1A', issued_qty: 3, returnable: 3, expected_date: '2026-10-11' })

    const back = await json(await returnPOST(request('POST', '/api/stock/return', 'admin-uid', {
      staffId: 'staff-1',
      linkedTxnId: issued.body.id,
      items: [{ productId: 'p1', quantity: 1, barcodes: ['P1A'] }],
    })))
    expect(back.status).toBe(200)
    const tooManyBack = await json(await returnPOST(request('POST', '/api/stock/return', 'admin-uid', {
      staffId: 'staff-1',
      linkedTxnId: issued.body.id,
      items: [{ productId: 'p1', quantity: 5, barcodes: ['P1A'] }],
    })))
    expect(tooManyBack.status).toBe(400)

    const waiver = await json(await waiversPOST(request('POST', '/api/stock/waivers', 'admin-uid', { transactionId: issued.body.id, productId: 'p1', quantity: 2, reason: 'Kept' })))
    expect(waiver.status).toBe(200)
    expect(typeof waiver.body.id).toBe('string')
    const none = await json(await waiversPOST(request('POST', '/api/stock/waivers', 'admin-uid', { transactionId: issued.body.id, productId: 'p1', quantity: 1 })))
    expect(none).toEqual({ status: 409, body: { error: 'Nothing outstanding to resolve for this item.' } })

    expect((await json(await waiversGET(request('GET', '/api/stock/waivers?kind=byTxn', 'admin-uid')))).body).toEqual({ [issued.body.id]: { p1: 2 } })
    const list = await json(await waiversGET(request('GET', '/api/stock/waivers', 'admin-uid')))
    expect(list.body).toHaveLength(1)
    expect(list.body[0]).toMatchObject({ product_name: 'Projector', quantity: 2, reason: 'Kept', staff_id: 'staff-1' })
    expect((await json(await waiversGET(request('GET', '/api/stock/waivers?kind=nope', 'admin-uid')))).status).toBe(400)

    expect((await db.select().from(products).where(eq(products.id, 'p1')))[0].quantity_on_hand).toBe(1)
    // IN, OUT, RETURN transactions plus the resolve entry: four audit entries (the refused saves wrote none).
    expect(await db.select().from(auditLog)).toHaveLength(4)
  })
})

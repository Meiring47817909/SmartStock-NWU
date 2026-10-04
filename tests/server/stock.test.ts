import { asc, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  createReturnWaiver,
  listOutstandingForStaff,
  loadWaivedByTxn,
  loadWaivers,
  recordAdjust,
  recordReturn,
  recordStockIn,
  recordStockOut,
} from '@/server/data/stock'
import { resolveHeldItem } from '@/server/data/staff'
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
import { closeDb, getDb, type Db } from '@/server/db/client'
import { DataError, type Caller, type Ctx } from '@/server/context'
import { waivedQty } from '@/lib/stockRules'
import { closeTestDb, resetTestDb, TEST_DATABASE_URL } from '../helpers/db'
import { raceBehindLock } from '../helpers/locks'

let db: Db
// Two more pools on the same database: a transaction on each really runs on its own connection, so row locks contend.
const POOL_B_URL = `${TEST_DATABASE_URL}?application_name=stock-test-b`
const POOL_C_URL = `${TEST_DATABASE_URL}?application_name=stock-test-c`
let dbB: Db
let dbC: Db

const NOW = new Date('2026-10-04T09:00:00.000Z')
const NOW_ISO = NOW.toISOString()
const admin: Caller = { uid: 'admin-uid', name: 'Ada Admin', role: 'admin', staffId: null }
const sam: Caller = { uid: 'sam-uid', name: 'Sam Staff', role: 'staff', staffId: 'staff-1' }

const ctxAs = (caller: Caller, on: Db = db): Ctx => ({ db: on, caller, now: () => NOW })
const adminCtx = (on: Db = db) => ctxAs(admin, on)
/** An admin context whose clock reads NOW plus `seconds`, for tests that need entries in a known order. */
const adminCtxAt = (seconds: number): Ctx => ({ db, caller: admin, now: () => new Date(NOW.getTime() + seconds * 1000) })

async function expectDataError(p: Promise<unknown>, status: number, message?: string) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(DataError)
  expect((err as DataError).status).toBe(status)
  if (message !== undefined) expect((err as DataError).message).toBe(message)
}

const audits = () => db.select().from(auditLog).orderBy(asc(auditLog.created_at), asc(auditLog.id))
const qty = async (id: string) => (await db.select().from(products).where(eq(products.id, id)))[0].quantity_on_hand

const raceOnRow = <T>(table: 'products' | 'transactions', id: string, attempts: (() => Promise<T>)[]) =>
  raceBehindLock(db, dbC, table, id, attempts)

beforeAll(async () => {
  db = await resetTestDb()
  dbB = getDb(POOL_B_URL)
  dbC = getDb(POOL_C_URL)
})
afterAll(async () => {
  await closeDb(POOL_B_URL)
  await closeDb(POOL_C_URL)
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
  ])
  await db.insert(staff).values([
    { id: 'staff-1', name: 'Sam', surname: 'Staff', full_name: 'Sam Staff', email: 'sam@nwu.test', uid: 'sam-uid' },
    { id: 'staff-2', name: 'Bo', surname: 'Rrower', full_name: 'Bo Rrower', email: 'bo@nwu.test' },
  ])
  await db.insert(products).values([
    { id: 'p1', name: 'Projector', quantity_on_hand: 5 },
    { id: 'p2', name: 'Cable', quantity_on_hand: 1 },
    { id: 'p3', name: 'Laptop', quantity_on_hand: 10 },
  ])
  await db.insert(productBarcodes).values([
    { barcode: 'P1A', product_id: 'p1', position: 0 },
    { barcode: 'P1B', product_id: 'p1', position: 1 },
    { barcode: 'P1C', product_id: 'p1', position: 2 },
    { barcode: 'C1', product_id: 'p2', position: 0 },
    { barcode: 'L1', product_id: 'p3', position: 0 },
  ])
})

describe('recordStockIn', () => {
  it('adds to stock and writes the transaction, one line per barcode, and the create audit entry', async () => {
    const res = await recordStockIn(adminCtx(), {
      items: [
        { productId: 'p1', quantity: 2, barcodes: ['P1A'] },
        { productId: 'p1', quantity: 1, barcodes: ['P1B'] },
        { productId: 'p2', quantity: 3, barcodes: ['C1'], unitCost: 12.5 },
      ],
      notes: 'Delivery note 7',
    })
    expect(res.reference_no).toMatch(/^TXN-[A-Z0-9]{8}$/)
    expect(await qty('p1')).toBe(8)
    expect(await qty('p2')).toBe(4)

    const [txn] = await db.select().from(transactions)
    expect(txn).toMatchObject({
      id: res.id,
      transaction_type: 'IN',
      reference_no: res.reference_no,
      user_id: 'admin-uid',
      operator_name: 'Ada Admin',
      notes: 'Delivery note 7',
      staff_id: null,
      linked_request_id: null,
      linked_request_ref: null,
    })
    expect(txn.created_at).toEqual(NOW)
    const lines = await db.select().from(transactionLines).orderBy(asc(transactionLines.id))
    expect(lines.map((l) => [l.product_id, l.barcode, l.quantity, l.unit_cost, l.product_name]).sort()).toEqual([
      ['p1', 'P1A', 2, 0, 'Projector'],
      ['p1', 'P1B', 1, 0, 'Projector'],
      ['p2', 'C1', 3, 12.5, 'Cable'],
    ])

    const entries = await audits()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      action: 'create',
      entity_type: 'transaction',
      entity_id: res.id,
      user_id: 'admin-uid',
      user_name: 'Ada Admin',
      before: null,
    })
    expect(entries[0].after).toEqual({
      transaction_type: 'IN',
      reference_no: res.reference_no,
      user_id: 'admin-uid',
      operator_name: 'Ada Admin',
      linked_request_id: null,
      linked_request_ref: null,
      notes: 'Delivery note 7',
      created_at: NOW_ISO,
      line_count: 2,
      total_qty: 6,
      lines: [
        {
          product_id: 'p1',
          product_name: 'Projector',
          quantity: 3,
          barcodes: ['P1A', 'P1B'],
          barcode_quantities: [
            { barcode: 'P1A', quantity: 2 },
            { barcode: 'P1B', quantity: 1 },
          ],
        },
        {
          product_id: 'p2',
          product_name: 'Cable',
          quantity: 3,
          barcodes: ['C1'],
          barcode_quantities: [{ barcode: 'C1', quantity: 3 }],
        },
      ],
    })
  })

  it('spreads a quantity over several barcodes, or over the product barcodes when none are given', async () => {
    await recordStockIn(adminCtx(), { items: [{ productId: 'p1', quantity: 3 }], notes: '' })
    const lines = await db.select().from(transactionLines)
    expect(lines.map((l) => [l.barcode, l.quantity]).sort()).toEqual([
      ['P1A', 1],
      ['P1B', 1],
      ['P1C', 1],
    ])
    expect(await qty('p1')).toBe(8)
  })

  it('uses only as many of the product barcodes as there are units when none are named, and writes lines in scan order', async () => {
    await recordStockIn(adminCtx(), { items: [{ productId: 'p1', quantity: 1 }], notes: '' })
    expect((await db.select().from(transactionLines)).map((l) => [l.barcode, l.quantity])).toEqual([['P1A', 1]])

    const res = await recordStockIn(adminCtx(), {
      items: [
        { productId: 'p1', quantity: 1, barcodes: ['P1C'] },
        { productId: 'p2', quantity: 1, barcodes: ['C1'] },
        { productId: 'p1', quantity: 1, barcodes: ['P1A'] },
      ],
      notes: '',
    })
    const lines = (await db.select().from(transactionLines).where(eq(transactionLines.transaction_id, res.id))).sort((a, b) => a.line_no - b.line_no)
    expect(lines.map((l) => [l.line_no, l.barcode])).toEqual([[0, 'P1C'], [1, 'C1'], [2, 'P1A']])
    // Every line carries the transaction's one instant; line_no alone orders them.
    const [txn] = await db.select().from(transactions).where(eq(transactions.id, res.id))
    expect(new Set(lines.map((l) => l.created_at.getTime()))).toEqual(new Set([txn.created_at.getTime()]))
  })

  it('naming more barcodes than units is a 400 (no barcode is silently dropped); nothing is written', async () => {
    await expectDataError(
      recordStockIn(adminCtx(), { items: [{ productId: 'p1', quantity: 1, barcodes: ['P1A', 'P1B'] }], notes: '' }),
      400,
      'Each barcode needs at least one unit; give a larger quantity or fewer barcodes.',
    )
    expect(await db.select().from(transactions)).toHaveLength(0)
    expect(await qty('p1')).toBe(5)
  })

  it('refuses a barcode that is not registered to the product, an empty list and a bad quantity; nothing is written', async () => {
    await expectDataError(
      recordStockIn(adminCtx(), { items: [{ productId: 'p1', quantity: 1, barcodes: ['C1'] }], notes: '' }),
      400,
      'Barcode "C1" is not registered to Projector.',
    )
    await expectDataError(recordStockIn(adminCtx(), { items: [], notes: '' }), 400)
    await expectDataError(recordStockIn(adminCtx(), { items: [{ productId: 'p1', quantity: 0 }], notes: '' }), 400)
    await expectDataError(recordStockIn(adminCtx(), { items: [{ productId: 'nope', quantity: 1 }], notes: '' }), 404)
    expect(await db.select().from(transactions)).toHaveLength(0)
    expect(await audits()).toHaveLength(0)
    expect(await qty('p1')).toBe(5)
  })
})

describe('recordStockOut', () => {
  it('lowers quantities and writes the transaction, lines and the create audit entry atomically', async () => {
    const res = await recordStockOut(adminCtx(), {
      staffId: 'staff-1',
      items: [
        { productId: 'p1', quantity: 2, barcodes: ['P1A'] },
        { productId: 'p1', quantity: 1, barcodes: ['P1B'] },
        { productId: 'p2', quantity: 1, barcodes: ['C1'] },
      ],
      lendFrom: '2026-10-04',
      lendTo: '2026-10-11',
      manualOverride: true,
      notes: 'Staff selected manually (no card scan)',
    })
    expect(await qty('p1')).toBe(2)
    expect(await qty('p2')).toBe(0)

    const [txn] = await db.select().from(transactions)
    expect(txn).toMatchObject({
      id: res.id,
      transaction_type: 'OUT',
      staff_id: 'staff-1',
      staff_name: 'Sam Staff',
      user_id: 'admin-uid',
      operator_name: 'Ada Admin',
      manual_override: true,
      lend_from: '2026-10-04',
      lend_to: '2026-10-11',
      linked_request_id: null,
    })
    expect(await db.select().from(transactionLines)).toHaveLength(3)

    const entries = await audits()
    expect(entries).toHaveLength(1)
    expect(entries[0].after).toEqual({
      transaction_type: 'OUT',
      reference_no: res.reference_no,
      staff_id: 'staff-1',
      staff_name: 'Sam Staff',
      user_id: 'admin-uid',
      operator_name: 'Ada Admin',
      manual_override: true,
      notes: 'Staff selected manually (no card scan)',
      lend_from: '2026-10-04',
      lend_to: '2026-10-11',
      linked_request_id: null,
      linked_request_ref: null,
      created_at: NOW_ISO,
      line_count: 2,
      total_qty: 4,
      lines: [
        {
          product_id: 'p1',
          product_name: 'Projector',
          quantity: 3,
          barcodes: ['P1A', 'P1B'],
          barcode_quantities: [
            { barcode: 'P1A', quantity: 2 },
            { barcode: 'P1B', quantity: 1 },
          ],
        },
        { product_id: 'p2', product_name: 'Cable', quantity: 1, barcodes: ['C1'], barcode_quantities: [{ barcode: 'C1', quantity: 1 }] },
      ],
    })
  })

  it('stock out of more than on hand is a 409 and nothing is written', async () => {
    await expectDataError(
      recordStockOut(adminCtx(), {
        staffId: 'staff-1',
        items: [
          { productId: 'p1', quantity: 1, barcodes: ['P1A'] },
          { productId: 'p2', quantity: 2, barcodes: ['C1'] },
        ],
        lendFrom: '2026-10-04',
      }),
      409,
      'Not enough stock for Cable.',
    )
    // Several rows for one product are added up before the check.
    await expectDataError(
      recordStockOut(adminCtx(), {
        staffId: 'staff-1',
        items: [
          { productId: 'p1', quantity: 3, barcodes: ['P1A'] },
          { productId: 'p1', quantity: 3, barcodes: ['P1B'] },
        ],
        lendFrom: '2026-10-04',
      }),
      409,
      'Not enough stock for Projector.',
    )
    expect(await db.select().from(transactions)).toHaveLength(0)
    expect(await db.select().from(transactionLines)).toHaveLength(0)
    expect(await audits()).toHaveLength(0)
    expect(await qty('p1')).toBe(5)
    expect(await qty('p2')).toBe(1)
  })

  it('refuses an unknown staff member and a return date before the from date', async () => {
    await expectDataError(
      recordStockOut(adminCtx(), { staffId: 'nobody', items: [{ productId: 'p1', quantity: 1 }], lendFrom: '2026-10-04' }),
      404,
      'Staff record not found.',
    )
    await expectDataError(
      recordStockOut(adminCtx(), {
        staffId: 'staff-1',
        items: [{ productId: 'p1', quantity: 1 }],
        lendFrom: '2026-10-04',
        lendTo: '2026-10-03',
      }),
      400,
      "Return (To) date can't be before the From date.",
    )
    expect(await qty('p1')).toBe(5)
  })

  it('impossible calendar dates are a 400, not a database error', async () => {
    const items = [{ productId: 'p1', quantity: 1, barcodes: ['P1A'] }]
    await expectDataError(recordStockOut(adminCtx(), { staffId: 'staff-1', items, lendFrom: '2026-02-30' }), 400, 'From date must be a date (YYYY-MM-DD).')
    await expectDataError(recordStockOut(adminCtx(), { staffId: 'staff-1', items, lendFrom: '2026-02-01', lendTo: '2026-13-01' }), 400, 'Return (To) date must be a date (YYYY-MM-DD).')
    await expectDataError(recordStockOut(adminCtx(), { staffId: 'staff-1', items, lendFrom: '2026-4-1' }), 400)
    const out = await recordStockOut(adminCtx(), { staffId: 'staff-1', items, lendFrom: '2028-02-29', lendTo: '2028-03-01' })
    await expectDataError(recordReturn(adminCtx(), { staffId: 'staff-1', linkedTxnId: out.id, items, returnDate: '2026-06-31' }), 400, 'Return date must be a date (YYYY-MM-DD).')
    expect(await db.select().from(transactions)).toHaveLength(1)
    expect(await qty('p1')).toBe(4)
  })

  it('two concurrent stock outs of the last unit: exactly one succeeds and the quantity is 0', async () => {
    await db.update(products).set({ quantity_on_hand: 1 }).where(eq(products.id, 'p1'))
    const attempt = (on: Db) =>
      recordStockOut(adminCtx(on), { staffId: 'staff-1', items: [{ productId: 'p1', quantity: 1, barcodes: ['P1A'] }], lendFrom: '2026-10-04' })
    // Both callers are provably in flight (waiting on the lock held from a third connection) before it is released.
    const results = await raceOnRow('products', 'p1', [() => attempt(db), () => attempt(dbB)])

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    expect(rejected).toHaveLength(1)
    expect(rejected[0].reason).toBeInstanceOf(DataError)
    expect((rejected[0].reason as DataError).status).toBe(409)
    expect(await qty('p1')).toBe(0)
    expect(await db.select().from(transactions)).toHaveLength(1)
    expect(await db.select().from(transactionLines)).toHaveLength(1)
    expect(await audits()).toHaveLength(1)
  })

  async function acceptedRequest(over: Partial<typeof loanRequests.$inferInsert> = {}) {
    await db.insert(loanRequests).values({
      id: 'req1',
      reference_no: 'LR-ABCD1234',
      staff_id: 'staff-1',
      staff_name: 'Sam Staff',
      status: 'accepted',
      message: 'For the open day',
      from_date: '2026-10-04',
      to_date: '2026-10-11',
      original_from_date: '2026-10-04',
      original_to_date: '2026-10-11',
      created_at: new Date('2026-10-01T08:00:00.000Z'),
      updated_at: new Date('2026-10-02T08:00:00.000Z'),
      ...over,
    })
    await db.insert(loanRequestLines).values({
      id: 'rl1',
      request_id: 'req1',
      product_id: 'p1',
      product_name: 'Projector',
      line_no: 0,
      requested_quantity: 2,
      offered_quantity: 2,
    })
  }

  it('fulfilling a request sets its status, fulfilled_txn_id and its update audit entry in the same transaction', async () => {
    await acceptedRequest()
    const res = await recordStockOut(adminCtx(), {
      staffId: 'staff-1',
      items: [{ productId: 'p1', quantity: 2, barcodes: ['P1A'] }],
      lendFrom: '2026-10-04',
      lendTo: '2026-10-11',
      notes: '',
      linkedRequestId: 'req1',
    })
    const [req] = await db.select().from(loanRequests).where(eq(loanRequests.id, 'req1'))
    expect(req).toMatchObject({ status: 'fulfilled', fulfilled_txn_id: res.id })
    expect(req.updated_at).toEqual(NOW)
    const [txn] = await db.select().from(transactions)
    expect(txn).toMatchObject({ linked_request_id: 'req1', linked_request_ref: 'LR-ABCD1234' })

    const entries = await audits()
    expect(entries.map((e) => [e.action, e.entity_type])).toEqual(
      expect.arrayContaining([
        ['create', 'transaction'],
        ['update', 'loan_request'],
      ]),
    )
    expect(entries).toHaveLength(2)
    const created = entries.find((e) => e.entity_type === 'transaction')!
    expect(created.after).toMatchObject({ linked_request_id: 'req1', linked_request_ref: 'LR-ABCD1234' })
    const updated = entries.find((e) => e.entity_type === 'loan_request')!
    expect(updated.entity_id).toBe('req1')
    const snapshot = {
      reference_no: 'LR-ABCD1234',
      staff_id: 'staff-1',
      staff_name: 'Sam Staff',
      from_date: '2026-10-04',
      to_date: '2026-10-11',
      original_from_date: '2026-10-04',
      original_to_date: '2026-10-11',
      message: 'For the open day',
      admin_message: null,
      lines: [{ product_id: 'p1', product_name: 'Projector', requested_quantity: 2, offered_quantity: 2 }],
      line_count: 1,
      total_qty: 2,
    }
    expect(updated.before).toEqual({ ...snapshot, status: 'accepted', fulfilled_txn_id: null })
    expect(updated.after).toEqual({
      ...snapshot,
      status: 'fulfilled',
      fulfilled_txn_id: res.id,
      fulfilled_txn_ref: res.reference_no,
    })
  })

  it('refuses a request that is not accepted, already fulfilled, someone else\'s or missing; nothing is written', async () => {
    await acceptedRequest({ status: 'pending' })
    const attempt = (over: Partial<Parameters<typeof recordStockOut>[1]> = {}) =>
      recordStockOut(adminCtx(), {
        staffId: 'staff-1',
        items: [{ productId: 'p1', quantity: 1, barcodes: ['P1A'] }],
        lendFrom: '2026-10-04',
        linkedRequestId: 'req1',
        ...over,
      })
    await expectDataError(attempt(), 409, 'This loan request can no longer be fulfilled.')
    await db.update(loanRequests).set({ status: 'accepted' })
    await expectDataError(attempt({ staffId: 'staff-2' }), 400, 'This loan request belongs to a different staff member.')
    await expectDataError(attempt({ linkedRequestId: 'missing' }), 404, 'Loan request not found.')
    await attempt()
    // Fulfilled now: a second Stock Out against it is refused (no double issue).
    await expectDataError(attempt(), 409, 'This loan request can no longer be fulfilled.')
    expect(await db.select().from(transactions)).toHaveLength(1)
    expect(await qty('p1')).toBe(4)
  })
})

describe('recordReturn', () => {
  /** staff-1 holds out1: Projector P1A x2 and P1B x1, and one Cable (C1). Stock is 5-3=2 and 1-1=0. */
  async function issue() {
    const out = await recordStockOut(adminCtx(), {
      staffId: 'staff-1',
      items: [
        { productId: 'p1', quantity: 2, barcodes: ['P1A'] },
        { productId: 'p1', quantity: 1, barcodes: ['P1B'] },
        { productId: 'p2', quantity: 1, barcodes: ['C1'] },
      ],
      lendFrom: '2026-10-04',
      lendTo: '2026-10-11',
    })
    await db.delete(auditLog)
    return out
  }

  it('puts units back on the shelf and writes a RETURN transaction, lines and the audit entry', async () => {
    const out = await issue()
    const res = await recordReturn(adminCtx(), {
      staffId: 'staff-1',
      linkedTxnId: out.id,
      items: [
        { productId: 'p1', quantity: 1, barcodes: ['P1A'] },
        { productId: 'p2', quantity: 1, barcodes: ['C1'] },
      ],
      manualOverride: false,
      notes: 'Return of Projector, Cable',
    })
    expect(await qty('p1')).toBe(3)
    expect(await qty('p2')).toBe(1)
    const [txn] = await db.select().from(transactions).where(eq(transactions.id, res.id))
    expect(txn).toMatchObject({
      transaction_type: 'RETURN',
      staff_id: 'staff-1',
      staff_name: 'Sam Staff',
      linked_txn_id: out.id,
      manual_override: false,
      notes: 'Return of Projector, Cable',
      return_date: null,
    })
    const lines = await db.select().from(transactionLines).where(eq(transactionLines.transaction_id, res.id))
    expect(lines.map((l) => [l.product_id, l.barcode, l.issued_barcode, l.quantity]).sort()).toEqual([
      ['p1', 'P1A', null, 1],
      ['p2', 'C1', null, 1],
    ])
    const [entry] = await audits()
    expect(entry.after).toEqual({
      transaction_type: 'RETURN',
      reference_no: res.reference_no,
      staff_id: 'staff-1',
      staff_name: 'Sam Staff',
      user_id: 'admin-uid',
      operator_name: 'Ada Admin',
      linked_txn_id: out.id,
      linked_request_id: null,
      linked_request_ref: null,
      manual_override: false,
      notes: 'Return of Projector, Cable',
      created_at: NOW_ISO,
      line_count: 2,
      total_qty: 2,
      lines: [
        { product_id: 'p1', product_name: 'Projector', quantity: 1, barcodes: ['P1A'], barcode_quantities: [{ barcode: 'P1A', quantity: 1 }] },
        { product_id: 'p2', product_name: 'Cable', quantity: 1, barcodes: ['C1'], barcode_quantities: [{ barcode: 'C1', quantity: 1 }] },
      ],
    })
  })

  it('returns the first units still out in issue order when no barcodes are given, and records a return date', async () => {
    const out = await issue()
    await recordReturn(adminCtx(), {
      staffId: 'staff-1',
      linkedTxnId: out.id,
      items: [{ productId: 'p1', quantity: 3 }],
      returnDate: '2026-10-09',
      notes: null,
    })
    const [ret] = await db.select().from(transactions).where(eq(transactions.transaction_type, 'RETURN'))
    expect(ret.return_date).toBe('2026-10-09')
    const lines = await db.select().from(transactionLines).where(eq(transactionLines.transaction_id, ret.id))
    expect(lines.map((l) => [l.barcode, l.quantity]).sort()).toEqual([
      ['P1A', 2],
      ['P1B', 1],
    ])
    const [entry] = await audits()
    expect(entry.after).toMatchObject({ return_date: '2026-10-09' })
  })

  it('a unit that lost its label comes back under a replacement barcode and counts against the barcode it left with', async () => {
    const out = await issue()
    const res = await recordReturn(adminCtx(), {
      staffId: 'staff-1',
      linkedTxnId: out.id,
      items: [{ productId: 'p1', quantity: 1, barcodes: ['P1C'], issuedBarcode: 'P1B' }],
      notes: 'Return of Projector. Barcode lost, returned as: P1B → P1C ×1',
    })
    const [line] = await db.select().from(transactionLines).where(eq(transactionLines.transaction_id, res.id))
    expect(line).toMatchObject({ barcode: 'P1C', issued_barcode: 'P1B', quantity: 1 })
    const [entry] = await audits()
    expect((entry.after as { lines: unknown[] }).lines).toEqual([
      {
        product_id: 'p1',
        product_name: 'Projector',
        quantity: 1,
        barcodes: ['P1C'],
        barcode_quantities: [{ barcode: 'P1C', quantity: 1 }],
        relabelled: [{ from: 'P1B', to: 'P1C', quantity: 1 }],
      },
    ])
    // P1B is now fully back; a second unit under it is more than is still out.
    await expectDataError(
      recordReturn(adminCtx(), { staffId: 'staff-1', linkedTxnId: out.id, items: [{ productId: 'p1', quantity: 1, barcodes: ['P1B'] }] }),
      400,
    )
    // The replacement barcode must be registered to the product.
    await expectDataError(
      recordReturn(adminCtx(), { staffId: 'staff-1', linkedTxnId: out.id, items: [{ productId: 'p1', quantity: 1, barcodes: ['C1'], issuedBarcode: 'P1A' }] }),
      400,
      'Barcode "C1" is no longer registered to Projector. Remove that unit and enter a registered barcode.',
    )
  })

  it('return of a barcode never issued on that Stock Out is a 400 and nothing is written', async () => {
    const out = await issue()
    await expectDataError(
      recordReturn(adminCtx(), { staffId: 'staff-1', linkedTxnId: out.id, items: [{ productId: 'p1', quantity: 1, barcodes: ['P1C'] }] }),
      400,
      'Barcode "P1C" was not issued on this Stock Out.',
    )
    await expectDataError(
      recordReturn(adminCtx(), { staffId: 'staff-1', linkedTxnId: out.id, items: [{ productId: 'p3', quantity: 1 }] }),
      400,
      'Laptop was not issued on this Stock Out.',
    )
    expect(await db.select().from(transactions)).toHaveLength(1)
    expect(await qty('p1')).toBe(2)
    expect(await audits()).toHaveLength(0)
  })

  it('return beyond what is still out is a 400, counting units across rows and earlier returns', async () => {
    const out = await issue()
    await expectDataError(
      recordReturn(adminCtx(), { staffId: 'staff-1', linkedTxnId: out.id, items: [{ productId: 'p1', quantity: 3, barcodes: ['P1A'] }] }),
      400,
      'Returning 3 of "P1A" is more than is still out.',
    )
    await expectDataError(
      recordReturn(adminCtx(), {
        staffId: 'staff-1',
        linkedTxnId: out.id,
        items: [
          { productId: 'p1', quantity: 1, barcodes: ['P1B'] },
          { productId: 'p1', quantity: 1, barcodes: ['P1B'] },
        ],
      }),
      400,
    )
    await expectDataError(recordReturn(adminCtx(), { staffId: 'staff-1', linkedTxnId: out.id, items: [{ productId: 'p1', quantity: 4 }] }), 400)
    await recordReturn(adminCtx(), { staffId: 'staff-1', linkedTxnId: out.id, items: [{ productId: 'p1', quantity: 2, barcodes: ['P1A'] }] })
    await expectDataError(
      recordReturn(adminCtx(), { staffId: 'staff-1', linkedTxnId: out.id, items: [{ productId: 'p1', quantity: 1, barcodes: ['P1A'] }] }),
      400,
    )
    expect(await qty('p1')).toBe(4)
  })

  it('naming more barcodes than units on a return is a 400', async () => {
    const out = await issue()
    await expectDataError(
      recordReturn(adminCtx(), { staffId: 'staff-1', linkedTxnId: out.id, items: [{ productId: 'p1', quantity: 1, barcodes: ['P1A', 'P1B'] }] }),
      400,
      'Each barcode needs at least one unit; give a larger quantity or fewer barcodes.',
    )
    expect(await qty('p1')).toBe(2)
  })

  it('refuses a linked transaction that is missing, not an OUT, or someone else\'s', async () => {
    const out = await issue()
    const items = [{ productId: 'p1', quantity: 1, barcodes: ['P1A'] }]
    await expectDataError(recordReturn(adminCtx(), { staffId: 'staff-1', linkedTxnId: 'nope', items }), 404, 'Stock Out not found.')
    await expectDataError(
      recordReturn(adminCtx(), { staffId: 'staff-2', linkedTxnId: out.id, items }),
      400,
      'That Stock Out was not issued to this staff member.',
    )
    const inn = await recordStockIn(adminCtx(), { items: [{ productId: 'p1', quantity: 1 }], notes: '' })
    await expectDataError(recordReturn(adminCtx(), { staffId: 'staff-1', linkedTxnId: inn.id, items }), 404, 'Stock Out not found.')
  })

  it('a return inherits the loan request link of its Stock Out', async () => {
    await db.insert(loanRequests).values({
      id: 'req1',
      reference_no: 'LR-ABCD1234',
      staff_id: 'staff-1',
      staff_name: 'Sam Staff',
      status: 'accepted',
      from_date: '2026-10-04',
      original_from_date: '2026-10-04',
    })
    const out = await recordStockOut(adminCtx(), {
      staffId: 'staff-1',
      items: [{ productId: 'p1', quantity: 1, barcodes: ['P1A'] }],
      lendFrom: '2026-10-04',
      linkedRequestId: 'req1',
    })
    const ret = await recordReturn(adminCtx(), { staffId: 'staff-1', linkedTxnId: out.id, items: [{ productId: 'p1', quantity: 1 }] })
    const [txn] = await db.select().from(transactions).where(eq(transactions.id, ret.id))
    expect(txn).toMatchObject({ linked_request_id: 'req1', linked_request_ref: 'LR-ABCD1234' })
  })

  it('two concurrent returns of the last outstanding unit: exactly one succeeds and stock goes up once', async () => {
    const out = await recordStockOut(adminCtx(), {
      staffId: 'staff-1',
      items: [{ productId: 'p2', quantity: 1, barcodes: ['C1'] }],
      lendFrom: '2026-10-04',
    })
    const attempt = (on: Db) =>
      recordReturn(adminCtx(on), { staffId: 'staff-1', linkedTxnId: out.id, items: [{ productId: 'p2', quantity: 1, barcodes: ['C1'] }] })
    // Both callers are provably in flight (waiting on the lock held from a third connection) before it is released.
    const results = await raceOnRow('transactions', out.id, [() => attempt(db), () => attempt(dbB)])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    expect((rejected[0].reason as DataError).status).toBe(400)
    expect(await qty('p2')).toBe(1)
    expect(await db.select().from(transactions).where(eq(transactions.transaction_type, 'RETURN'))).toHaveLength(1)
  })
})

describe('recordAdjust', () => {
  it('adds or removes stock and writes an ADJUST transaction with its audit entry', async () => {
    const up = await recordAdjust(adminCtxAt(0), { direction: 1, items: [{ productId: 'p1', quantity: 2, barcodes: ['P1A'] }], notes: 'Found in cupboard' })
    expect(await qty('p1')).toBe(7)
    await recordAdjust(adminCtxAt(1), { direction: -1, items: [{ productId: 'p1', quantity: 4 }], notes: 'Stock take' })
    expect(await qty('p1')).toBe(3)
    const [txn] = await db.select().from(transactions).where(eq(transactions.id, up.id))
    expect(txn).toMatchObject({ transaction_type: 'ADJUST', notes: 'Found in cupboard', staff_id: null })
    // An adjustment is not a scan: lines carry no barcode.
    const lines = await db.select().from(transactionLines).where(eq(transactionLines.transaction_id, up.id))
    expect(lines.map((l) => [l.barcode, l.quantity])).toEqual([[null, 2]])
    const entries = await audits()
    expect(entries).toHaveLength(2)
    expect(entries[0].after).toMatchObject({ transaction_type: 'ADJUST', direction: 1, total_qty: 2, line_count: 1 })
    expect(entries[1].after).toMatchObject({ direction: -1 })
  })

  it('refuses to take stock below zero', async () => {
    await expectDataError(recordAdjust(adminCtx(), { direction: -1, items: [{ productId: 'p2', quantity: 2 }], notes: '' }), 409, 'Not enough stock for Cable.')
    await expectDataError(recordAdjust(adminCtx(), { direction: 0 as 1, items: [{ productId: 'p2', quantity: 1 }], notes: '' }), 400)
    expect(await qty('p2')).toBe(1)
    expect(await db.select().from(transactions)).toHaveLength(0)
  })
})

describe('return waivers', () => {
  /** out1: staff-1 holds Projector x3 (P1A) and Cable x1; one Projector comes back. */
  async function holdAndReturn() {
    const out = await recordStockOut(adminCtx(), {
      staffId: 'staff-1',
      items: [
        { productId: 'p1', quantity: 3, barcodes: ['P1A'] },
        { productId: 'p2', quantity: 1, barcodes: ['C1'] },
      ],
      lendFrom: '2026-10-04',
      lendTo: '2026-10-11',
    })
    await recordReturn(adminCtx(), { staffId: 'staff-1', linkedTxnId: out.id, items: [{ productId: 'p1', quantity: 1, barcodes: ['P1A'] }] })
    await db.delete(auditLog)
    return out
  }

  it('writes the waiver and the resolve audit entry against the originating transaction, leaving stock alone', async () => {
    const out = await holdAndReturn()
    const stockBefore = await qty('p1')
    const id = await createReturnWaiver(adminCtx(), { transactionId: out.id, productId: 'p1', quantity: 2, reason: ' Lost on campus ' })
    const [w] = await db.select().from(returnWaivers).where(eq(returnWaivers.id, id))
    expect(w).toMatchObject({
      transaction_id: out.id,
      product_id: 'p1',
      product_name: 'Projector',
      staff_id: 'staff-1',
      staff_name: 'Sam Staff',
      quantity: 2,
      reason: 'Lost on campus',
      resolved_by_uid: 'admin-uid',
      resolved_by_name: 'Ada Admin',
    })
    expect(w.created_at).toEqual(NOW)
    expect(await qty('p1')).toBe(stockBefore)
    expect(await audits()).toHaveLength(1)
    const [entry] = await audits()
    expect(entry).toMatchObject({ action: 'resolve', entity_type: 'transaction', entity_id: out.id, before: null })
    expect(entry.after).toEqual({
      transaction_id: out.id,
      product_id: 'p1',
      product_name: 'Projector',
      staff_id: 'staff-1',
      staff_name: 'Sam Staff',
      quantity: 2,
      reason: 'Lost on campus',
      created_at: NOW_ISO,
      resolved_by_uid: 'admin-uid',
      resolved_by_name: 'Ada Admin',
    })
  })

  it('refuses more than is outstanding (issued - returned - already written off), and bad input; nothing is written', async () => {
    const out = await holdAndReturn()
    const attempt = (quantity: number, over: Record<string, unknown> = {}) =>
      createReturnWaiver(adminCtx(), { transactionId: out.id, productId: 'p1', quantity, ...over })
    await expectDataError(attempt(3), 409, 'Nothing outstanding to resolve for this item.')
    await attempt(1)
    await expectDataError(attempt(2), 409, 'Nothing outstanding to resolve for this item.')
    await expectDataError(attempt(0), 400, 'Quantity must be a whole number above zero.')
    await expectDataError(attempt(1.5), 400)
    await expectDataError(attempt(1, { productId: 'p3' }), 409, 'Nothing outstanding to resolve for this item.')
    await expectDataError(attempt(1, { transactionId: 'nope' }), 409, 'Nothing outstanding to resolve for this item.')
    await expectDataError(attempt(1, { staffId: 'staff-2' }), 409, 'Nothing outstanding to resolve for this item.')
    await expectDataError(attempt(1, { staffId: 'nobody' }), 404, 'Staff record not found.')
    expect(await db.select().from(returnWaivers)).toHaveLength(1)
    expect(await audits()).toHaveLength(1)
  })

  it('two concurrent waivers for the last outstanding unit: exactly one succeeds', async () => {
    const out = await recordStockOut(adminCtx(), {
      staffId: 'staff-1',
      items: [{ productId: 'p2', quantity: 1, barcodes: ['C1'] }],
      lendFrom: '2026-10-04',
    })
    await db.delete(auditLog)
    const attempt = (on: Db) => createReturnWaiver(adminCtx(on), { transactionId: out.id, productId: 'p2', quantity: 1 })
    // Both callers are provably in flight (waiting on the lock held from a third connection) before it is released.
    const results = await raceOnRow('transactions', out.id, [() => attempt(db), () => attempt(dbB)])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    expect((rejected[0].reason as DataError).status).toBe(409)
    expect(await db.select().from(returnWaivers)).toHaveLength(1)
    expect(await audits()).toHaveLength(1)
  })

  it('the Staff page\'s resolveHeldItem goes through the same path, so it is just as safe under concurrency', async () => {
    const out = await recordStockOut(adminCtx(), {
      staffId: 'staff-1',
      items: [{ productId: 'p2', quantity: 1, barcodes: ['C1'] }],
      lendFrom: '2026-10-04',
    })
    const attempt = (on: Db) => resolveHeldItem(adminCtx(on), 'staff-1', { transactionId: out.id, productId: 'p2', quantity: 1 })
    // Both callers are provably in flight (waiting on the lock held from a third connection) before it is released.
    const results = await raceOnRow('transactions', out.id, [() => attempt(db), () => attempt(dbB)])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(await db.select().from(returnWaivers)).toHaveLength(1)
  })

  it('loadWaivedByTxn totals per transaction and product, loadWaivers lists them, waivedQty reads the map', async () => {
    const out = await holdAndReturn()
    await createReturnWaiver(adminCtxAt(0), { transactionId: out.id, productId: 'p1', quantity: 1 })
    await createReturnWaiver(adminCtxAt(1), { transactionId: out.id, productId: 'p1', quantity: 1, reason: 'Second' })
    await createReturnWaiver(adminCtxAt(2), { transactionId: out.id, productId: 'p2', quantity: 1 })
    const map = await loadWaivedByTxn(adminCtx())
    expect(map).toEqual({ [out.id]: { p1: 2, p2: 1 } })
    expect(waivedQty(map, out.id, 'p1')).toBe(2)
    expect(waivedQty(map, out.id, 'p3')).toBe(0)
    expect(waivedQty(map, 'other', 'p1')).toBe(0)
    const list = await loadWaivers(adminCtx())
    expect(list).toHaveLength(3)
    expect(list[0]).toMatchObject({
      transaction_id: out.id,
      product_id: 'p1',
      product_name: 'Projector',
      staff_id: 'staff-1',
      quantity: 1,
      reason: null,
      created_at: NOW_ISO,
      resolved_by_uid: 'admin-uid',
    })
    await expectDataError(loadWaivedByTxn(ctxAs(sam)), 403)
    await expectDataError(loadWaivers(ctxAs(sam)), 403)
  })
})

describe('listOutstandingForStaff', () => {
  it('lists what a staff member still has out per Stock Out, product and barcode, oldest first', async () => {
    const t = (n: number) => new Date(NOW.getTime() + n * 1000)
    const ctxAt = (n: number): Ctx => ({ db, caller: admin, now: () => t(n) })
    const out1 = await recordStockOut(ctxAt(1), {
      staffId: 'staff-1',
      items: [
        { productId: 'p1', quantity: 2, barcodes: ['P1A'] },
        { productId: 'p1', quantity: 1, barcodes: ['P1B'] },
      ],
      lendFrom: '2026-10-04',
      lendTo: '2026-10-11',
    })
    const out2 = await recordStockOut(ctxAt(2), { staffId: 'staff-1', items: [{ productId: 'p3', quantity: 1, barcodes: ['L1'] }], lendFrom: '2026-10-05' })
    await recordStockOut(ctxAt(3), { staffId: 'staff-2', items: [{ productId: 'p3', quantity: 1, barcodes: ['L1'] }], lendFrom: '2026-10-05' })
    await recordReturn(ctxAt(4), { staffId: 'staff-1', linkedTxnId: out1.id, items: [{ productId: 'p1', quantity: 1, barcodes: ['P1A'] }] })
    // A written-off item can still come back, so waivers do not reduce what is returnable.
    await createReturnWaiver(ctxAt(5), { transactionId: out1.id, productId: 'p1', quantity: 1 })

    const res = await listOutstandingForStaff(adminCtx(), 'staff-1')
    expect(res.unscannable).toEqual([])
    expect(res.lines).toEqual([
      {
        txn_id: out1.id,
        txn_ref: out1.reference_no,
        txn_date: t(1).toISOString(),
        line_id: `${out1.id}|p1|P1A`,
        product_id: 'p1',
        product_name: 'Projector',
        barcode: 'P1A',
        issued_qty: 2,
        already_returned: 1,
        returnable: 1,
        expected_date: '2026-10-11',
        linked_request_id: null,
        linked_request_ref: null,
      },
      {
        txn_id: out1.id,
        txn_ref: out1.reference_no,
        txn_date: t(1).toISOString(),
        line_id: `${out1.id}|p1|P1B`,
        product_id: 'p1',
        product_name: 'Projector',
        barcode: 'P1B',
        issued_qty: 1,
        already_returned: 0,
        returnable: 1,
        expected_date: '2026-10-11',
        linked_request_id: null,
        linked_request_ref: null,
      },
      {
        txn_id: out2.id,
        txn_ref: out2.reference_no,
        txn_date: t(2).toISOString(),
        line_id: `${out2.id}|p3|L1`,
        product_id: 'p3',
        product_name: 'Laptop',
        barcode: 'L1',
        issued_qty: 1,
        already_returned: 0,
        returnable: 1,
        expected_date: null,
        linked_request_id: null,
        linked_request_ref: null,
      },
    ])
    expect((await listOutstandingForStaff(adminCtx(), 'staff-2')).lines).toHaveLength(1)
    expect(await listOutstandingForStaff(adminCtx(), 'nobody')).toEqual({ lines: [], unscannable: [] })
  })

  it('reports units issued without a barcode as unscannable, and is admin-only', async () => {
    await db.insert(transactions).values({ id: 'old1', transaction_type: 'OUT', reference_no: 'TXN-OLD00001', staff_id: 'staff-1', created_at: NOW })
    await db.insert(transactionLines).values({ id: 'ol1', transaction_id: 'old1', product_id: 'p1', product_name: 'Projector', barcode: null, line_no: 0, quantity: 2 })
    expect(await listOutstandingForStaff(adminCtx(), 'staff-1')).toEqual({
      lines: [],
      unscannable: [{ txn_ref: 'TXN-OLD00001', product_name: 'Projector', quantity: 2 }],
    })
    await expectDataError(listOutstandingForStaff(ctxAs(sam), 'staff-1'), 403)
  })
})

describe('every save needs an admin', () => {
  it('a staff caller gets 403 on every save and nothing is written', async () => {
    const s = ctxAs(sam)
    const out = await recordStockOut(adminCtx(), { staffId: 'staff-1', items: [{ productId: 'p1', quantity: 1, barcodes: ['P1A'] }], lendFrom: '2026-10-04' })
    await db.delete(auditLog)
    const items = [{ productId: 'p1', quantity: 1, barcodes: ['P1A'] }]
    await expectDataError(recordStockIn(s, { items, notes: '' }), 403, 'Only admins can do this.')
    await expectDataError(recordStockOut(s, { staffId: 'staff-1', items, lendFrom: '2026-10-04' }), 403)
    await expectDataError(recordReturn(s, { staffId: 'staff-1', linkedTxnId: out.id, items }), 403)
    await expectDataError(recordAdjust(s, { direction: 1, items, notes: '' }), 403)
    await expectDataError(createReturnWaiver(s, { transactionId: out.id, productId: 'p1', quantity: 1 }), 403)
    expect(await qty('p1')).toBe(4)
    expect(await db.select().from(transactions)).toHaveLength(1)
    expect(await db.select().from(returnWaivers)).toHaveLength(0)
    expect(await audits()).toHaveLength(0)
  })
})

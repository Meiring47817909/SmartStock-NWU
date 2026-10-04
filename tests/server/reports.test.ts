import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { loadReport } from '@/server/data/reports'
import { categories, productBarcodes, products, profiles, returnWaivers, staff, transactionLines, transactions } from '@/server/db/schema'
import type { Db } from '@/server/db/client'
import { DataError, type Caller, type Ctx } from '@/server/context'
import { collapseLinesByProduct } from '@/lib/transactionLines'
import { closeTestDb, resetTestDb } from '../helpers/db'

let db: Db

const NOW = new Date('2026-10-04T09:00:00.000Z')
const admin: Caller = { uid: 'admin-uid', name: 'Ada Admin', role: 'admin', staffId: null }
const sam: Caller = { uid: 'sam-uid', name: 'Sam Staff', role: 'staff', staffId: 'staff-1' }
const ctxFor = (caller: Caller = admin): Ctx => ({ db, caller, now: () => NOW })

async function expectDataError(p: Promise<unknown>, status: number, message?: string) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(DataError)
  expect((err as DataError).status).toBe(status)
  if (message !== undefined) expect((err as DataError).message).toBe(message)
}

const NAMES: Record<string, string> = { p1: 'Projector', p2: 'Cable', p3: 'Laptop', p4: 'Stapler', p5: 'Tripod', p6: 'camera' }

/** A transaction with its lines in scan order: [product, quantity, barcode, issuedBarcode?]. */
async function txn(
  id: string,
  opts: {
    type?: 'OUT' | 'RETURN' | 'IN'
    staffId?: string | null
    lendTo?: string | null
    created: string
    linked?: string | null
    lines: [productId: string, quantity: number, barcode: string | null, issuedBarcode?: string][]
  },
) {
  const staffId = opts.staffId === undefined ? 'staff-1' : opts.staffId
  const staffNames: Record<string, string> = { 'staff-1': 'Sam Staff', 'staff-2': 'Bo Rrower', 'staff-3': 'Gone Away' }
  await db.insert(transactions).values({
    id,
    transaction_type: opts.type ?? 'OUT',
    reference_no: `TXN-${id.toUpperCase().padEnd(8, '0').slice(0, 8)}`,
    staff_id: staffId,
    staff_name: staffId ? staffNames[staffId] : null,
    lend_from: opts.lendTo ? '2026-09-01' : null,
    lend_to: opts.lendTo ?? null,
    linked_txn_id: opts.linked ?? null,
    created_at: new Date(opts.created),
  })
  await db.insert(transactionLines).values(
    opts.lines.map(([productId, quantity, barcode, issuedBarcode], i) => ({
      id: `${id}-l${i}`,
      transaction_id: id,
      product_id: productId,
      product_name: NAMES[productId],
      barcode,
      issued_barcode: issuedBarcode ?? null,
      line_no: i,
      quantity,
      created_at: new Date(opts.created),
    })),
  )
}

beforeAll(async () => {
  db = await resetTestDb()
})
afterAll(async () => {
  await closeTestDb()
})

beforeEach(async () => {
  await db.delete(returnWaivers)
  await db.delete(transactionLines)
  await db.delete(transactions)
  await db.delete(productBarcodes)
  await db.delete(products)
  await db.delete(categories)
  await db.delete(staff)
  await db.delete(profiles)
  await db.insert(profiles).values([
    { uid: 'admin-uid', full_name: 'Ada Admin', role: 'admin' },
    { uid: 'sam-uid', full_name: 'Sam Staff', role: 'staff' },
  ])
  await db.insert(staff).values([
    { id: 'staff-1', name: 'Sam', surname: 'Staff', full_name: 'Sam Staff', department: 'Finance', email: 'sam@nwu.test', uid: 'sam-uid' },
    { id: 'staff-2', name: 'Bo', surname: 'Rrower', full_name: 'Bo Rrower', department: 'IT', email: 'bo@nwu.test' },
    { id: 'staff-3', name: 'Gone', surname: 'Away', full_name: 'Gone Away', email: 'gone@nwu.test', is_active: false },
    { id: 'staff-4', name: 'Zed', surname: 'Zero', full_name: 'Zed Zero', email: 'zed@nwu.test' }, // active, never borrowed
  ])
  await db.insert(categories).values({ id: 'c1', name: 'AV' })
  await db.insert(products).values([
    { id: 'p1', name: 'Projector', category_id: 'c1', category_name: 'AV', quantity_on_hand: 0, reorder_threshold: 1 }, // out
    { id: 'p2', name: 'Cable', category_id: 'c1', category_name: 'AV', quantity_on_hand: 9, reorder_threshold: 10 }, // low
    { id: 'p3', name: 'Laptop', quantity_on_hand: 5, reorder_threshold: 5 }, // low (at the threshold), uncategorized
    { id: 'p4', name: 'Stapler', quantity_on_hand: 20, reorder_threshold: 2 }, // healthy
    { id: 'p5', name: 'Tripod', quantity_on_hand: 3, reorder_threshold: 1 }, // healthy
    { id: 'p6', name: 'camera', quantity_on_hand: 7, reorder_threshold: 2 }, // healthy; lower-case on purpose
  ])
})

describe('admin only', () => {
  it('a staff caller gets a 403 from every report', async () => {
    for (const report of ['stock-levels', 'low-stock', 'issued-per-staff', 'returns'] as const) {
      await expectDataError(loadReport(ctxFor(sam), { report }), 403, 'Only admins can do this.')
    }
  })

  it('an unknown report or a malformed date is a 400', async () => {
    await expectDataError(loadReport(ctxFor(), { report: 'nope' as never }), 400, 'Unknown report.')
    await expectDataError(loadReport(ctxFor(), { report: 'returns', from: '03/10/2026' }), 400, 'From must be a date (YYYY-MM-DD).')
    await expectDataError(loadReport(ctxFor(), { report: 'returns', to: '2026-13-45' }), 400, 'To must be a date (YYYY-MM-DD).')
  })
})

describe('stock-levels', () => {
  it('lists every product by name, with its quantity, threshold and status', async () => {
    const rows = await loadReport(ctxFor(), { report: 'stock-levels' })
    // localeCompare order, not the database collation's: "camera" sits between Cable and Laptop.
    expect(rows.map((r) => [r.name, r.category_name, r.qty, r.threshold, r.status])).toEqual([
      ['Cable', 'AV', 9, 10, 'LOW STOCK'],
      ['camera', null, 7, 2, 'IN STOCK'],
      ['Laptop', null, 5, 5, 'LOW STOCK'],
      ['Projector', 'AV', 0, 1, 'OUT OF STOCK'],
      ['Stapler', null, 20, 2, 'IN STOCK'],
      ['Tripod', null, 3, 1, 'IN STOCK'],
    ])
    expect(rows.find((r) => r.name === 'Cable')).toMatchObject({ id: 'p2', category_id: 'c1' })
    expect(rows.find((r) => r.name === 'Laptop')?.category_id).toBeNull()
    expect(rows.reduce((n, r) => n + r.qty, 0)).toBe(44)
  })
})

describe('low-stock', () => {
  it('lists products at or below their threshold, lowest quantity first', async () => {
    const rows = await loadReport(ctxFor(), { report: 'low-stock' })
    expect(rows.map((r) => [r.name, r.quantity_on_hand, r.reorder_threshold])).toEqual([
      ['Projector', 0, 1],
      ['Laptop', 5, 5], // exactly at the threshold counts
      ['Cable', 9, 10],
    ])
  })

  it('is empty when every product is healthy', async () => {
    await db.update(products).set({ quantity_on_hand: 50 })
    expect(await loadReport(ctxFor(), { report: 'low-stock' })).toEqual([])
  })
})

/**
 * Sam: t1 (Laptops under two barcodes + Cables, due 09-27) and t2 (Staplers, no return date; recorded 23:30 UTC on 10-01 =
 * 01:30 on 10-02 in Johannesburg). Bo: t3 (Projector, due 10-05). Gone Away is inactive; Zed never borrowed.
 */
async function seedIssued() {
  await txn('t1', { lendTo: '2026-09-27', created: '2026-09-20T08:00:00.000Z', lines: [['p3', 2, 'L-1'], ['p3', 1, 'L-2'], ['p2', 4, 'C-1']] })
  await txn('t2', { lendTo: null, created: '2026-10-01T23:30:00.000Z', lines: [['p4', 3, 'S-1']] })
  await txn('t3', { staffId: 'staff-2', lendTo: '2026-10-05', created: '2026-09-25T10:00:00.000Z', lines: [['p1', 1, 'P-1']] })
  await txn('t4', { staffId: 'staff-3', lendTo: '2026-10-05', created: '2026-09-25T10:00:00.000Z', lines: [['p5', 9, 'T-1']] })
  await txn('stockin', { type: 'IN', staffId: null, created: '2026-09-01T08:00:00.000Z', lines: [['p1', 10, 'P-1']] })
}

describe('issued-per-staff', () => {
  it('lists every active staff member by name, zeroes included, with their Stock Outs newest first', async () => {
    await seedIssued()
    const { staff: rows, undatedCount } = await loadReport(ctxFor(), { report: 'issued-per-staff' })
    expect(rows.map((s) => [s.full_name, s.department, s.txns.map((t) => t.reference_no), s.totalQty])).toEqual([
      ['Bo Rrower', 'IT', ['TXN-T3000000'], 1],
      ['Sam Staff', 'Finance', ['TXN-T2000000', 'TXN-T1000000'], 10], // t2 (10-01) before t1 (09-20); 3 + (2 + 1 + 4)
      ['Zed Zero', null, [], 0],
    ])
    expect(undatedCount).toBe(1) // t2 has no return date
    const t2 = rows[1].txns[0]
    expect(t2).toMatchObject({ id: 't2', created_at: '2026-10-01T23:30:00.000Z', lend_from: null, lend_to: null })
  })

  it('orders staff by name with localeCompare, whatever collation the database was created with', async () => {
    await db.insert(staff).values([
      { id: 'staff-5', name: 'ann', surname: 'lower', full_name: 'ann lower', email: 'ann@nwu.test' },
      { id: 'staff-6', name: 'bo', surname: 'rrower', full_name: 'bo rrower', email: 'bo2@nwu.test' },
    ])
    const { staff: rows } = await loadReport(ctxFor(), { report: 'issued-per-staff' })
    // A C-collating database would put every capitalised name before the lower-case ones.
    expect(rows.map((s) => s.full_name)).toEqual(['ann lower', 'bo rrower', 'Bo Rrower', 'Sam Staff', 'Zed Zero'])
  })

  it('returns lines in scan order, and the page groups a multi-barcode product as before', async () => {
    await seedIssued()
    const { staff: rows } = await loadReport(ctxFor(), { report: 'issued-per-staff' })
    const t1 = rows[1].txns[1]
    expect(t1.lend_to).toBe('2026-09-27')
    expect(t1.transaction_lines.map((l) => [l.product_name, l.barcode, l.quantity])).toEqual([
      ['Laptop', 'L-1', 2],
      ['Laptop', 'L-2', 1],
      ['Cable', 'C-1', 4],
    ])
    const collapsed = collapseLinesByProduct(t1.transaction_lines)
    expect(collapsed.map((l) => [l.product_name, l.quantity, l.barcodeQuantities])).toEqual([
      ['Laptop', 3, [{ barcode: 'L-1', quantity: 2 }, { barcode: 'L-2', quantity: 1 }]],
      ['Cable', 4, [{ barcode: 'C-1', quantity: 4 }]],
    ])
  })

  it('orders lines by (line_no, id) whatever order they were stored in', async () => {
    await txn('t1', { lendTo: null, created: '2026-09-20T08:00:00.000Z', lines: [['p3', 1, 'A'], ['p2', 1, 'B'], ['p4', 1, 'C']] })
    await db.update(transactionLines).set({ line_no: 5 }).where(eq(transactionLines.id, 't1-l0'))
    await db.update(transactionLines).set({ line_no: 1 }).where(eq(transactionLines.id, 't1-l1'))
    await db.update(transactionLines).set({ line_no: 1 }).where(eq(transactionLines.id, 't1-l2')) // ties on line_no break on id
    const { staff: rows } = await loadReport(ctxFor(), { report: 'issued-per-staff' })
    expect(rows.find((s) => s.id === 'staff-1')?.txns[0].transaction_lines.map((l) => l.barcode)).toEqual(['B', 'C', 'A'])
  })

  it('"Issued from" is a Johannesburg calendar day: 23:30 UTC belongs to the next day', async () => {
    await seedIssued()
    // t2 was recorded at 23:30 UTC on 10-01 = 01:30 on 10-02 in Johannesburg.
    const on02 = await loadReport(ctxFor(), { report: 'issued-per-staff', from: '2026-10-02' })
    expect(on02.staff.map((s) => [s.full_name, s.txns.map((t) => t.id)])).toEqual([['Sam Staff', ['t2']]])
    const on01 = await loadReport(ctxFor(), { report: 'issued-per-staff', from: '2026-10-01' })
    expect(on01.staff.map((s) => s.txns.map((t) => t.id))).toEqual([['t2']]) // from the 1st or the 2nd: it is in
    const on03 = await loadReport(ctxFor(), { report: 'issued-per-staff', from: '2026-10-03' })
    expect(on03).toEqual({ staff: [], undatedCount: 0 })
  })

  it('"Issued from" drops a staff member with nothing in range and recomputes the totals', async () => {
    await seedIssued()
    const { staff: rows } = await loadReport(ctxFor(), { report: 'issued-per-staff', from: '2026-09-22' })
    expect(rows.map((s) => [s.full_name, s.txns.map((t) => t.id), s.totalQty])).toEqual([
      ['Bo Rrower', ['t3'], 1],
      ['Sam Staff', ['t2'], 3], // t1 (09-20) is before the window
    ])
  })

  it('"Expected back by" compares Lend To as a plain day; a Stock Out with none follows includeUndated', async () => {
    await seedIssued()
    const withUndated = await loadReport(ctxFor(), { report: 'issued-per-staff', to: '2026-09-30' })
    expect(withUndated.staff.map((s) => [s.full_name, s.txns.map((t) => t.id), s.totalQty])).toEqual([
      ['Sam Staff', ['t2', 't1'], 10], // t1 is due 09-27; t2 has no date and is included by default; Bo's t3 is due 10-05
    ])
    expect(withUndated.undatedCount).toBe(1)
    const without = await loadReport(ctxFor(), { report: 'issued-per-staff', to: '2026-09-30', includeUndated: false })
    expect(without.staff.map((s) => [s.full_name, s.txns.map((t) => t.id)])).toEqual([['Sam Staff', ['t1']]])
    expect(without.undatedCount).toBe(1) // the switch's size does not shrink when it is switched
    const dueOn = await loadReport(ctxFor(), { report: 'issued-per-staff', to: '2026-10-05', includeUndated: false })
    expect(dueOn.staff.map((s) => s.txns.map((t) => t.id))).toEqual([['t3'], ['t1']]) // 10-05 is inclusive
  })

  it('counts the no-return-date Stock Outs that clear "Issued from"', async () => {
    await seedIssued()
    await txn('t5', { lendTo: null, created: '2026-09-10T08:00:00.000Z', lines: [['p4', 1, 'S-2']] })
    expect((await loadReport(ctxFor(), { report: 'issued-per-staff' })).undatedCount).toBe(2)
    expect((await loadReport(ctxFor(), { report: 'issued-per-staff', from: '2026-09-15' })).undatedCount).toBe(1)
  })
})

/**
 * Returns, newest first:
 *   r2 (10-06)  settles t3 (Projector, due 10-05): all back, so not partial.
 *   r4 (10-02)  settles t2 (3 Staplers, no return date): 1 back, 2 still out.
 *   r3 (09-28)  settles nothing (no linked Stock Out).
 *   r1 (09-26)  settles t1 (due 09-27): 1 of 3 Laptops back, 1 written off, the Cables all back, so 1 Laptop (L-2) still out.
 */
async function seedReturns() {
  await seedIssued()
  await txn('r1', { type: 'RETURN', linked: 't1', created: '2026-09-26T09:00:00.000Z', lines: [['p3', 1, 'L-1'], ['p2', 4, 'C-1']] })
  await db.insert(returnWaivers).values({ id: 'w1', transaction_id: 't1', product_id: 'p3', product_name: 'Laptop', staff_id: 'staff-1', quantity: 1 })
  await txn('r3', { type: 'RETURN', linked: null, created: '2026-09-28T09:00:00.000Z', lines: [['p4', 1, 'S-1']] })
  await txn('r4', { type: 'RETURN', linked: 't2', created: '2026-10-02T08:00:00.000Z', lines: [['p4', 1, 'S-1']] })
  await txn('r2', { type: 'RETURN', staffId: 'staff-2', linked: 't3', created: '2026-10-06T08:00:00.000Z', lines: [['p1', 1, 'P-1']] })
}

describe('returns', () => {
  it('lists every return newest first with its Stock Out, expected date and what is still owed', async () => {
    await seedReturns()
    const { returns, undatedCount } = await loadReport(ctxFor(), { report: 'returns' })
    expect(returns.map((r) => [r.id, r.staff_name, r.linked_txn_ref, r.expected_date, r.partial, r.created_at])).toEqual([
      ['r2', 'Bo Rrower', 'TXN-T3000000', '2026-10-05', false, '2026-10-06T08:00:00.000Z'],
      ['r4', 'Sam Staff', 'TXN-T2000000', null, true, '2026-10-02T08:00:00.000Z'],
      ['r3', 'Sam Staff', null, null, false, '2026-09-28T09:00:00.000Z'],
      ['r1', 'Sam Staff', 'TXN-T1000000', '2026-09-27', true, '2026-09-26T09:00:00.000Z'],
    ])
    expect(undatedCount).toBe(2) // r3 and r4
    const byId = Object.fromEntries(returns.map((r) => [r.id, r]))
    expect(byId.r2.outstandingLines).toEqual([])
    // 3 Staplers out, 1 back against S-1: 2 still out under it. (r3 is not linked to t2, so it does not count.)
    expect(byId.r4.outstandingLines).toEqual([{ product_name: 'Stapler', outstanding: 2, barcodeQuantities: [{ barcode: 'S-1', quantity: 2 }] }])
    // 3 Laptops out under L-1 x2 and L-2 x1; 1 back against L-1; 1 written off (taken off the earliest open barcode, L-1):
    // the Cables are all back, so only L-2 is left.
    expect(byId.r1.outstandingLines).toEqual([{ product_name: 'Laptop', outstanding: 1, barcodeQuantities: [{ barcode: 'L-2', quantity: 1 }] }])
    expect(byId.r1.transaction_lines.map((l) => [l.product_name, l.barcode, l.quantity])).toEqual([['Laptop', 'L-1', 1], ['Cable', 'C-1', 4]])
    expect(byId.r1).toMatchObject({ staff_id: 'staff-1', linked_txn_id: 't1', reference_no: 'TXN-R1000000' })
  })

  it('a write-off clears the balance a Partial row claimed', async () => {
    await seedReturns()
    await db.insert(returnWaivers).values({ id: 'w2', transaction_id: 't1', product_id: 'p3', product_name: 'Laptop', staff_id: 'staff-1', quantity: 1 })
    const { returns } = await loadReport(ctxFor(), { report: 'returns' })
    expect(returns.find((r) => r.id === 'r1')).toMatchObject({ partial: false, outstandingLines: [] })
  })

  it('counts a return made under a replacement barcode against the barcode the unit left with', async () => {
    await txn('o1', { lendTo: '2026-09-27', created: '2026-09-20T08:00:00.000Z', lines: [['p3', 1, 'L-1'], ['p3', 1, 'L-2']] })
    await txn('rr', { type: 'RETURN', linked: 'o1', created: '2026-09-26T09:00:00.000Z', lines: [['p3', 1, 'NEW-9', 'L-2']] })
    const { returns } = await loadReport(ctxFor(), { report: 'returns' })
    expect(returns[0].outstandingLines).toEqual([{ product_name: 'Laptop', outstanding: 1, barcodeQuantities: [{ barcode: 'L-1', quantity: 1 }] }])
    expect(returns[0].transaction_lines[0]).toMatchObject({ barcode: 'NEW-9', issued_barcode: 'L-2' })
  })

  it('"Expected from / to" bounds the expected date as a plain day, inclusive; undated returns follow includeUndated', async () => {
    await seedReturns()
    const ids = async (p: { from?: string; to?: string; includeUndated?: boolean }) =>
      (await loadReport(ctxFor(), { report: 'returns', ...p })).returns.map((r) => r.id)
    expect(await ids({ from: '2026-09-27', to: '2026-09-30' })).toEqual(['r4', 'r3', 'r1'])
    expect(await ids({ from: '2026-09-27', to: '2026-09-30', includeUndated: false })).toEqual(['r1'])
    expect(await ids({ from: '2026-09-28', includeUndated: false })).toEqual(['r2']) // r1 was due the 27th
    expect(await ids({ to: '2026-10-05', includeUndated: false })).toEqual(['r2', 'r1']) // the 5th is inclusive
    expect(await ids({ from: '2026-10-06', includeUndated: false })).toEqual([])
    expect(await ids({})).toEqual(['r2', 'r4', 'r3', 'r1'])
  })

  it('keeps the live balance of a Partial row even when its Stock Out is outside the window', async () => {
    await seedReturns()
    const { returns, undatedCount } = await loadReport(ctxFor(), { report: 'returns', from: '2026-09-27', to: '2026-09-27', includeUndated: false })
    expect(returns.map((r) => [r.id, r.partial])).toEqual([['r1', true]])
    expect(undatedCount).toBe(2) // counted over the whole set, not the window
  })

  it('is empty with no returns', async () => {
    await seedIssued()
    expect(await loadReport(ctxFor(), { report: 'returns' })).toEqual({ returns: [], undatedCount: 0 })
  })
})

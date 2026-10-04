import { asc, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { loadDashboard, loadDashboardAlertCounts } from '@/server/data/dashboard'
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
import { DataError, type Caller, type Ctx } from '@/server/context'
import { outstandingStatusOf } from '@/lib/dashboardRules'
import type { LoanRequestStatus } from '@/types/database'
import { closeTestDb, resetTestDb } from '../helpers/db'

let db: Db

// 09:00 UTC is 11:00 in Johannesburg on the same day.
const NOW = new Date('2026-10-04T09:00:00.000Z')
const admin: Caller = { uid: 'admin-uid', name: 'Ada Admin', role: 'admin', staffId: null }
const sam: Caller = { uid: 'sam-uid', name: 'Sam Staff', role: 'staff', staffId: 'staff-1' }
const ctxAt = (now: Date = NOW, caller: Caller = admin): Ctx => ({ db, caller, now: () => now })

async function expectDataError(p: Promise<unknown>, status: number, message?: string) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(DataError)
  expect((err as DataError).status).toBe(status)
  if (message !== undefined) expect((err as DataError).message).toBe(message)
}

const SEPT = '2026-09-20T08:00:00.000Z'

/** A Stock Out (or a return linked to one) with its lines, in scan order. Names come from the products below. */
async function txn(
  id: string,
  opts: { type?: 'OUT' | 'RETURN' | 'IN'; staffId?: string | null; lendTo?: string | null; created?: string; linked?: string; lines: [productId: string, quantity: number][] },
) {
  const names: Record<string, string> = { p1: 'Projector', p2: 'Cable', p3: 'Laptop', p4: 'Stapler', p5: 'Tripod' }
  const staffId = opts.staffId === undefined ? 'staff-1' : opts.staffId
  const created = new Date(opts.created ?? SEPT)
  await db.insert(transactions).values({
    id,
    transaction_type: opts.type ?? 'OUT',
    reference_no: `TXN-${id.toUpperCase().padEnd(8, '0').slice(0, 8)}`,
    staff_id: staffId,
    staff_name: staffId === 'staff-1' ? 'Sam Staff' : staffId === 'staff-2' ? 'Bo Rrower' : null,
    lend_to: opts.lendTo ?? null,
    linked_txn_id: opts.linked ?? null,
    created_at: created,
  })
  await db.insert(transactionLines).values(
    opts.lines.map(([productId, quantity], i) => ({
      id: `${id}-l${i}`,
      transaction_id: id,
      product_id: productId,
      product_name: names[productId],
      line_no: i,
      quantity,
      created_at: created,
    })),
  )
}

async function request(
  id: string,
  opts: { status?: LoanRequestStatus; staffId?: string; from?: string; to?: string | null; lines: [productId: string, offered: number][] },
) {
  const names: Record<string, string> = { p1: 'Projector', p2: 'Cable', p3: 'Laptop', p4: 'Stapler', p5: 'Tripod' }
  const staffId = opts.staffId ?? 'staff-1'
  const at = new Date('2026-10-01T08:00:00.000Z')
  await db.insert(loanRequests).values({
    id,
    reference_no: `LR-${id.toUpperCase().padEnd(8, '0').slice(0, 8)}`,
    staff_id: staffId,
    staff_name: staffId === 'staff-1' ? 'Sam Staff' : 'Bo Rrower',
    status: opts.status ?? 'accepted',
    from_date: opts.from ?? '2026-10-10',
    to_date: opts.to === undefined ? '2026-10-14' : opts.to,
    original_from_date: opts.from ?? '2026-10-10',
    original_to_date: opts.to === undefined ? '2026-10-14' : opts.to,
    created_at: at,
    updated_at: at,
  })
  await db.insert(loanRequestLines).values(
    opts.lines.map(([productId, offered], i) => ({
      id: `${id}-l${i}`,
      request_id: id,
      product_id: productId,
      product_name: names[productId],
      requested_quantity: offered,
      offered_quantity: offered,
      line_no: i,
      created_at: at,
    })),
  )
}

const audits = () => db.select().from(auditLog).orderBy(asc(auditLog.created_at), asc(auditLog.id))
const statusOf = async (id: string) => (await db.select().from(loanRequests).where(eq(loanRequests.id, id)))[0].status

beforeAll(async () => {
  db = await resetTestDb()
})
afterAll(async () => {
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
    { id: 'staff-3', name: 'Gone', surname: 'Away', full_name: 'Gone Away', email: 'gone@nwu.test', is_active: false },
  ])
  await db.insert(products).values([
    { id: 'p1', name: 'Projector', quantity_on_hand: 5, reorder_threshold: 2 }, // healthy
    { id: 'p2', name: 'Cable', quantity_on_hand: 0, reorder_threshold: 3 }, // out of stock
    { id: 'p3', name: 'Laptop', quantity_on_hand: 2, reorder_threshold: 2 }, // low (at the threshold)
    { id: 'p4', name: 'Stapler', quantity_on_hand: 9, reorder_threshold: 2 }, // healthy
    { id: 'p5', name: 'Tripod', quantity_on_hand: 1, reorder_threshold: 5 }, // low
  ])
})

/** One Outstanding Returns row per badge, every shape of "partly resolved" and a holder with two products. */
async function seedOutstanding() {
  // Overdue: due 10-01, 2 Projectors out with Sam.
  await txn('overdue', { lendTo: '2026-10-01', lines: [['p1', 2]] })
  // Partly resolved: 3 Laptops on two scan lines, 1 returned, 1 written off -> 1 left (overdue, due 10-02).
  await txn('partial', { lendTo: '2026-10-02', lines: [['p3', 2], ['p3', 1]] })
  await txn('partial-ret', { type: 'RETURN', linked: 'partial', created: '2026-09-25T08:00:00.000Z', lines: [['p3', 1]] })
  await db.insert(returnWaivers).values({ id: 'w-partial', transaction_id: 'partial', product_id: 'p3', product_name: 'Laptop', staff_id: 'staff-1', quantity: 1 })
  // Mixed holder: Bo has a Projector (all back) and 2 Cables (still out, overdue, due 10-02).
  await txn('mixed', { staffId: 'staff-2', lendTo: '2026-10-02', created: '2026-09-21T08:00:00.000Z', lines: [['p1', 1], ['p2', 2]] })
  await txn('mixed-ret', { type: 'RETURN', staffId: 'staff-2', linked: 'mixed', created: '2026-09-25T08:00:00.000Z', lines: [['p1', 1]] })
  // Due today (10-04, created 22:00 UTC the evening before = 00:00 in Johannesburg: counts as today's transaction).
  await txn('today', { lendTo: '2026-10-04', created: '2026-10-03T22:00:00.000Z', lines: [['p4', 1]] })
  // Not due yet (10-10; created 21:59 UTC = still yesterday in Johannesburg).
  await txn('future', { lendTo: '2026-10-10', created: '2026-10-03T21:59:00.000Z', lines: [['p4', 1]] })
  // No return date agreed, held by Bo as well (the same product Sam holds in 'overdue').
  await txn('nodate', { staffId: 'staff-2', lendTo: null, lines: [['p1', 1]] })
  // Settled and absent: fully returned, fully written off, and a Stock In.
  await txn('done', { lendTo: '2026-10-01', lines: [['p4', 2]] })
  await txn('done-ret', { type: 'RETURN', linked: 'done', created: '2026-09-25T08:00:00.000Z', lines: [['p4', 2]] })
  await txn('kept', { lendTo: '2026-10-01', lines: [['p5', 1]] })
  await db.insert(returnWaivers).values({ id: 'w-kept', transaction_id: 'kept', product_id: 'p5', product_name: 'Tripod', staff_id: 'staff-1', quantity: 1 })
  await txn('stockin', { type: 'IN', staffId: null, lines: [['p1', 10]] })
}

async function seedPickups() {
  // On schedule: the Projector is plentiful (5 on hand, nothing else holds it).
  await request('pk-ok', { from: '2026-10-08', to: '2026-10-09', lines: [['p1', 1]] })
  // Insufficient with a cause: 0 Cables on hand and Bo's overdue 'mixed' loan explains it. Two lines, one short.
  await request('pk-cause', { from: '2026-10-10', to: '2026-10-14', staffId: 'staff-2', lines: [['p1', 1], ['p2', 2]] })
  // Insufficient without a cause: 9 Staplers, another request holds 8 of them over the same days, so 1 is free of 3 promised.
  await request('pk-held', { from: '2026-10-12', to: '2026-10-13', lines: [['p4', 3]] })
  await request('holder', { status: 'pending', staffId: 'staff-2', from: '2026-10-13', to: '2026-10-20', lines: [['p4', 8]] })
  // Not active: never listed.
  await request('declined', { status: 'declined', lines: [['p2', 1]] })
}

describe('outstandingStatusOf', () => {
  it('compares the day strings: before, on and after the due day, and no date', () => {
    expect(outstandingStatusOf('2026-10-03', '2026-10-04')).toBe('overdue')
    expect(outstandingStatusOf('2026-10-04', '2026-10-04')).toBe('due_today')
    expect(outstandingStatusOf('2026-10-05', '2026-10-04')).toBe('not_due_yet')
    expect(outstandingStatusOf(null, '2026-10-04')).toBe('no_return_date')
  })
})

describe('loadDashboard: Outstanding Returns', () => {
  it('lists each (Stock Out, product) still out once, with its badge, most urgent first', async () => {
    await seedOutstanding()
    const { outstandingReturns } = await loadDashboard(ctxAt())
    expect(outstandingReturns.map((o) => [o.id, o.product_name, o.staff_name, o.qty, o.expected_date, o.status])).toEqual([
      ['overdue_p1', 'Projector', 'Sam Staff', 2, '2026-10-01', 'overdue'],
      ['partial_p3', 'Laptop', 'Sam Staff', 1, '2026-10-02', 'overdue'], // 3 out, 1 returned, 1 written off
      ['mixed_p2', 'Cable', 'Bo Rrower', 2, '2026-10-02', 'overdue'], // the returned Projector is gone
      ['today_p4', 'Stapler', 'Sam Staff', 1, '2026-10-04', 'due_today'],
      ['future_p4', 'Stapler', 'Sam Staff', 1, '2026-10-10', 'not_due_yet'],
      ['nodate_p1', 'Projector', 'Bo Rrower', 1, null, 'no_return_date'],
    ])
    expect(outstandingReturns[0]).toEqual({
      id: 'overdue_p1',
      txn_id: 'overdue',
      product_id: 'p1',
      product_name: 'Projector',
      staff_id: 'staff-1',
      staff_name: 'Sam Staff',
      qty: 2,
      expected_date: '2026-10-01',
      txn_ref: 'TXN-OVERDUE0',
      status: 'overdue',
    })
  })

  it('shows an em dash when the Stock Out has no staff name', async () => {
    await txn('anon', { staffId: null, lendTo: null, lines: [['p1', 1]] })
    const { outstandingReturns } = await loadDashboard(ctxAt())
    expect(outstandingReturns).toMatchObject([{ id: 'anon_p1', staff_id: null, staff_name: '—', status: 'no_return_date' }])
  })

  it('a return only cancels the loan it was linked to, not another loan of the same product', async () => {
    await txn('first', { lendTo: '2026-10-10', lines: [['p1', 1]] })
    await txn('second', { lendTo: '2026-10-12', lines: [['p1', 1]] })
    await txn('first-ret', { type: 'RETURN', linked: 'first', created: '2026-09-25T08:00:00.000Z', lines: [['p1', 1]] })
    const { outstandingReturns } = await loadDashboard(ctxAt())
    expect(outstandingReturns.map((o) => o.id)).toEqual(['second_p1'])
  })

  it('groups overdue rows by product (the likely cause of a short pickup), leaving out rows that are not overdue', async () => {
    await seedOutstanding()
    const { overdueByProduct } = await loadDashboard(ctxAt())
    expect(overdueByProduct).toEqual({
      p1: [{ id: 'overdue_p1', staff_name: 'Sam Staff', qty: 2, expected_date: '2026-10-01', txn_ref: 'TXN-OVERDUE0' }],
      p3: [{ id: 'partial_p3', staff_name: 'Sam Staff', qty: 1, expected_date: '2026-10-02', txn_ref: 'TXN-PARTIAL0' }],
      p2: [{ id: 'mixed_p2', staff_name: 'Bo Rrower', qty: 2, expected_date: '2026-10-02', txn_ref: 'TXN-MIXED000' }],
    })
  })
})

describe('Outstanding Returns badges follow the Johannesburg calendar day, not UTC', () => {
  beforeEach(async () => {
    await txn('d-yesterday', { lendTo: '2026-10-03', lines: [['p1', 1]] })
    await txn('d-today', { lendTo: '2026-10-04', lines: [['p2', 1]] })
    await txn('d-tomorrow', { lendTo: '2026-10-05', lines: [['p3', 1]] })
  })
  const statuses = async (now: Date) =>
    Object.fromEntries((await loadDashboard(ctxAt(now))).outstandingReturns.map((o) => [o.txn_id, o.status]))

  it('23:30 UTC on 3 Oct is 01:30 on 4 Oct: what was due the 3rd is overdue and what is due the 4th is due today', async () => {
    expect(await statuses(new Date('2026-10-03T23:30:00.000Z'))).toEqual({
      'd-yesterday': 'overdue', // by the UTC date (3 Oct) it would still be "due today"
      'd-today': 'due_today', // by the UTC date it would be "not due yet"
      'd-tomorrow': 'not_due_yet',
    })
  })

  it('21:30 UTC on 3 Oct is 23:30 on the 3rd: nothing has turned over yet', async () => {
    expect(await statuses(new Date('2026-10-03T21:30:00.000Z'))).toEqual({
      'd-yesterday': 'due_today',
      'd-today': 'not_due_yet',
      'd-tomorrow': 'not_due_yet',
    })
  })

  it('21:59:59 UTC is the last second of the 3rd, 22:00:00 UTC the first of the 4th', async () => {
    expect((await statuses(new Date('2026-10-03T21:59:59.000Z')))['d-yesterday']).toBe('due_today')
    expect((await statuses(new Date('2026-10-03T22:00:00.000Z')))['d-yesterday']).toBe('overdue')
  })
})

describe('loadDashboard: Low Stock Alerts', () => {
  it('lists products at or under their reorder threshold, emptiest first, with out of stock told apart', async () => {
    await seedOutstanding()
    const { lowStock } = await loadDashboard(ctxAt())
    expect(lowStock).toEqual([
      { id: 'p2', name: 'Cable', quantity_on_hand: 0, reorder_threshold: 3, status: 'out_of_stock' },
      { id: 'p5', name: 'Tripod', quantity_on_hand: 1, reorder_threshold: 5, status: 'low_stock' },
      { id: 'p3', name: 'Laptop', quantity_on_hand: 2, reorder_threshold: 2, status: 'low_stock' }, // equal to the threshold counts
    ])
  })

  it('a product with no threshold set (0) is only low when it is out of stock', async () => {
    await db.insert(products).values({ id: 'p6', name: 'Pen', quantity_on_hand: 0, reorder_threshold: 0 })
    await db.insert(products).values({ id: 'p7', name: 'Pad', quantity_on_hand: 1, reorder_threshold: 0 })
    const ids = (await loadDashboard(ctxAt())).lowStock.map((p) => p.id)
    expect(ids).toContain('p6')
    expect(ids).not.toContain('p7')
  })
})

describe('loadDashboard: Incoming Pickups', () => {
  it('lists accepted requests soonest first, with item counts and an insufficiency badge only where stock falls short', async () => {
    await seedOutstanding()
    await seedPickups()
    const { incomingPickups, pickupLines } = await loadDashboard(ctxAt())
    expect(incomingPickups).toEqual([
      { id: 'pk-ok', reference_no: 'LR-PK-OK000', staff_name: 'Sam Staff', item_count: 1, from_date: '2026-10-08', to_date: '2026-10-09', noShow: false, insufficient: false },
      { id: 'pk-cause', reference_no: 'LR-PK-CAUSE', staff_name: 'Bo Rrower', item_count: 2, from_date: '2026-10-10', to_date: '2026-10-14', noShow: false, insufficient: true },
      { id: 'pk-held', reference_no: 'LR-PK-HELD0', staff_name: 'Sam Staff', item_count: 1, from_date: '2026-10-12', to_date: '2026-10-13', noShow: false, insufficient: true },
    ])
    const brief = (id: string) => pickupLines[id].map((l) => [l.product_name, l.offered_quantity, l.available, l.shortBy])
    expect(brief('pk-ok')).toEqual([['Projector', 1, 5, 0]])
    expect(brief('pk-cause')).toEqual([['Projector', 1, 5, 0], ['Cable', 2, 0, 2]]) // in the request's own line order
    expect(brief('pk-held')).toEqual([['Stapler', 3, 1, 2]]) // 9 on hand - 8 held by the other request; its own 3 is not counted against it
  })

  it('tells a short pickup with a likely cause from one without', async () => {
    await seedOutstanding()
    await seedPickups()
    const { pickupLines, overdueByProduct } = await loadDashboard(ctxAt())
    const shortProducts = Object.values(pickupLines).flat().filter((l) => l.shortBy > 0).map((l) => l.product_id)
    expect(shortProducts.sort()).toEqual(['p2', 'p4'])
    expect(overdueByProduct.p2).toMatchObject([{ staff_name: 'Bo Rrower', qty: 2, expected_date: '2026-10-02', txn_ref: 'TXN-MIXED000' }]) // with a cause
    expect(overdueByProduct.p4).toBeUndefined() // the Staplers out are not due yet: no explanation
  })

  it('settles a request whose pickup window has passed as a no-show instead of listing it, once, as the system', async () => {
    await request('gone', { from: '2026-09-28', to: '2026-10-02', lines: [['p1', 1]] })
    await request('open-ended', { from: '2026-09-01', to: null, lines: [['p1', 1]] })
    const first = await loadDashboard(ctxAt())
    expect(first.incomingPickups.map((p) => p.id)).toEqual(['open-ended'])
    expect(first.pickupLines.gone).toBeUndefined()
    expect(await statusOf('gone')).toBe('no_show')
    expect(await statusOf('open-ended')).toBe('accepted')

    await loadDashboard(ctxAt())
    await loadDashboardAlertCounts(ctxAt())
    const entries = await audits()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ action: 'update', entity_type: 'loan_request', entity_id: 'gone', user_id: null, user_name: 'System (automatic)' })
  })

  it('several callers opening the Dashboard at the same moment settle a no-show once: one status change, one audit entry', async () => {
    await request('gone', { from: '2026-09-28', to: '2026-10-02', lines: [['p1', 1]] })
    await Promise.all([loadDashboard(ctxAt()), loadDashboard(ctxAt()), loadDashboardAlertCounts(ctxAt()), loadDashboardAlertCounts(ctxAt())])
    expect(await statusOf('gone')).toBe('no_show')
    expect(await audits()).toHaveLength(1)
  })

  it('a request is not yet a no-show on the last day of its window, but is the morning after (Johannesburg day)', async () => {
    await request('edge', { from: '2026-10-01', to: '2026-10-03', lines: [['p1', 1]] })
    // 21:59 UTC on 3 Oct is 23:59 on the 3rd: still its last day.
    expect((await loadDashboard(ctxAt(new Date('2026-10-03T21:59:00.000Z')))).incomingPickups.map((p) => p.id)).toEqual(['edge'])
    expect(await statusOf('edge')).toBe('accepted')
    // 23:30 UTC on 3 Oct is 01:30 on the 4th: the window has passed (by the UTC date it would still be the 3rd).
    expect((await loadDashboard(ctxAt(new Date('2026-10-03T23:30:00.000Z')))).incomingPickups).toEqual([])
    expect(await statusOf('edge')).toBe('no_show')
  })

  it('pending and countered requests are neither listed nor counted (the Loan Requests page has its own badge)', async () => {
    await request('pending', { status: 'pending', lines: [['p1', 1]] })
    await request('countered', { status: 'countered', lines: [['p1', 1]] })
    const data = await loadDashboard(ctxAt())
    expect(data.incomingPickups).toEqual([])
    expect((await loadDashboardAlertCounts(ctxAt())).incomingPickups).toBe(0)
  })
})

describe('loadDashboard: stats', () => {
  it('counts products, stock units, low stock, active staff and today\'s transactions (Johannesburg midnight)', async () => {
    await seedOutstanding()
    const { stats } = await loadDashboard(ctxAt())
    expect(stats).toEqual({
      total_products: 5,
      total_stock: 17, // 5 + 0 + 2 + 9 + 1
      low_stock: 3,
      today_transactions: 1, // 'today' (22:00 UTC = 00:00 SAST); 'future' at 21:59 UTC is still yesterday
      total_staff: 2, // Gone Away is inactive
    })
  })
})

describe('the badge counts match what the tabs show', () => {
  it('Sidebar total = Outstanding Returns + Incoming Pickups + Low Stock rows', async () => {
    await seedOutstanding()
    await seedPickups()
    await request('gone', { from: '2026-09-28', to: '2026-10-02', lines: [['p1', 1]] }) // settled away before counting
    const counts = await loadDashboardAlertCounts(ctxAt())
    const data = await loadDashboard(ctxAt())
    expect(counts).toEqual({
      outstandingReturns: data.outstandingReturns.length,
      incomingPickups: data.incomingPickups.length,
      lowStock: data.lowStock.length,
      total: data.outstandingReturns.length + data.incomingPickups.length + data.lowStock.length,
    })
    expect(counts).toEqual({ outstandingReturns: 6, incomingPickups: 3, lowStock: 3, total: 12 })
  })

  it('an empty database counts zero everywhere', async () => {
    await db.delete(products)
    expect(await loadDashboardAlertCounts(ctxAt())).toEqual({ outstandingReturns: 0, incomingPickups: 0, lowStock: 0, total: 0 })
    const data = await loadDashboard(ctxAt())
    expect(data.stats).toEqual({ total_products: 0, total_stock: 0, low_stock: 0, today_transactions: 0, total_staff: 2 })
    expect([data.outstandingReturns, data.incomingPickups, data.lowStock]).toEqual([[], [], []])
  })
})

describe('access', () => {
  it('is admin only', async () => {
    await expectDataError(loadDashboard(ctxAt(NOW, sam)), 403, 'Only admins can do this.')
    await expectDataError(loadDashboardAlertCounts(ctxAt(NOW, sam)), 403, 'Only admins can do this.')
  })

  it('does not write anything when there is nothing due', async () => {
    await seedOutstanding()
    await seedPickups()
    await loadDashboard(ctxAt())
    expect(await audits()).toEqual([])
    const [{ n }] = await db.execute<{ n: number }>(sql`select count(*)::int as n from return_waivers`).then((r) => r.rows)
    expect(n).toBe(2)
  })
})

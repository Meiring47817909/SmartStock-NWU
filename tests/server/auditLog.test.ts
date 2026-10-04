import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { listAuditLog } from '@/server/data/auditLog'
import { auditLog, loanRequestLines, loanRequests, products, profiles, staff, transactionLines, transactions } from '@/server/db/schema'
import type { Db } from '@/server/db/client'
import { DataError, type Caller, type Ctx } from '@/server/context'
import type { AuditAction, AuditEntityType } from '@/types/database'
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

async function entry(
  id: string,
  created: string,
  entityType: AuditEntityType,
  action: AuditAction,
  entityId: string,
  opts: { userId?: string | null; userName?: string | null; before?: Record<string, unknown> | null; after?: Record<string, unknown> | null } = {},
) {
  await db.insert(auditLog).values({
    id,
    user_id: opts.userId === undefined ? 'admin-uid' : opts.userId,
    user_name: opts.userName === undefined ? 'Ada Admin' : opts.userName,
    action,
    entity_type: entityType,
    entity_id: entityId,
    before: opts.before ?? null,
    after: opts.after ?? null,
    created_at: new Date(created),
  })
}

beforeAll(async () => {
  db = await resetTestDb()
})
afterAll(async () => {
  await closeTestDb()
})

beforeEach(async () => {
  await db.delete(auditLog)
  await db.delete(transactionLines)
  await db.delete(transactions)
  await db.delete(loanRequestLines)
  await db.delete(loanRequests)
  await db.delete(products)
  await db.delete(staff)
  await db.delete(profiles)
  await db.insert(profiles).values([
    { uid: 'admin-uid', full_name: 'Ada Admin (renamed)', role: 'admin' },
    { uid: 'sam-uid', full_name: 'Sam Staff', role: 'staff' },
  ])
  await db.insert(staff).values({ id: 'staff-1', name: 'Sam', surname: 'Staff', full_name: 'Sam Staff', email: 'sam@nwu.test', uid: 'sam-uid' })
  await db.insert(products).values([
    { id: 'p1', name: 'Projector' },
    { id: 'p2', name: 'Cable' },
  ])
})

/** Seven entries across three Johannesburg days; times chosen around the 22:00 UTC (midnight in Johannesburg) turnover. */
async function seed() {
  // 10-02 in Johannesburg although 10-01 in UTC.
  await entry('a1', '2026-10-01T22:30:00.000Z', 'product', 'create', 'p1', { after: { name: 'Projector' } })
  // 23:59 on 10-02 in Johannesburg.
  await entry('a2', '2026-10-02T21:59:00.000Z', 'transaction', 'create', 't1', { after: { transaction_type: 'OUT', reference_no: 'TXN-T1' } })
  // 00:00 on 10-03 in Johannesburg.
  await entry('a3', '2026-10-02T22:00:00.000Z', 'staff', 'update', 'staff-1', { userId: 'sam-uid', userName: 'Sam Staff', before: { department: 'A' }, after: { department: 'B' } })
  await entry('a4', '2026-09-30T10:00:00.000Z', 'loan_request', 'create', 'lr1', { after: { status: 'pending' } })
  await entry('a5', '2026-09-29T10:00:00.000Z', 'transaction', 'create', 't2', { after: { transaction_type: 'IN', lines: [{ product_name: 'Cable', quantity: 2 }] } })
  await entry('a6', '2026-09-28T10:00:00.000Z', 'transaction', 'resolve', 't1', { after: { product_name: 'Projector', quantity: 1 } })
  await entry('a7', '2026-09-27T10:00:00.000Z', 'loan_request', 'update', 'lr1', { before: { status: 'pending' }, after: { status: 'accepted' } })
}

describe('listAuditLog', () => {
  it('is admin only', async () => {
    await expectDataError(listAuditLog(ctxFor(sam)), 403, 'Only admins can do this.')
  })

  it('lists every entry newest first, names as stored', async () => {
    await seed()
    const { entries } = await listAuditLog(ctxFor())
    expect(entries.map((e) => e.id)).toEqual(['a3', 'a2', 'a1', 'a4', 'a5', 'a6', 'a7'])
    // The user's name is the one frozen on the entry, not the profile's current one.
    expect(entries.find((e) => e.id === 'a1')).toEqual({
      id: 'a1',
      user_id: 'admin-uid',
      user_name: 'Ada Admin',
      action: 'create',
      entity_type: 'product',
      entity_id: 'p1',
      before: null,
      after: { name: 'Projector' },
      created_at: '2026-10-01T22:30:00.000Z',
    })
    expect(entries.find((e) => e.id === 'a3')).toMatchObject({ before: { department: 'A' }, after: { department: 'B' }, user_name: 'Sam Staff' })
  })

  it('breaks a tie on created_at the same way every time', async () => {
    await entry('b1', '2026-10-01T10:00:00.000Z', 'product', 'create', 'p1')
    await entry('b2', '2026-10-01T10:00:00.000Z', 'product', 'create', 'p2')
    expect((await listAuditLog(ctxFor())).entries.map((e) => e.id)).toEqual(['b2', 'b1'])
  })

  it('date filters are Johannesburg calendar days, both ends inclusive', async () => {
    await seed()
    const ids = async (from?: string, to?: string) => (await listAuditLog(ctxFor(), { from, to })).entries.map((e) => e.id)
    // The 3rd starts at 22:00 UTC on the 2nd: only a3 is on it.
    expect(await ids('2026-10-03', '2026-10-03')).toEqual(['a3'])
    expect(await ids('2026-10-03')).toEqual(['a3'])
    // a1 (22:30 UTC on the 1st) is on the 2nd with a2 (21:59 UTC on the 2nd = 23:59), not on the 1st.
    expect(await ids('2026-10-02', '2026-10-02')).toEqual(['a2', 'a1'])
    expect(await ids(undefined, '2026-10-01')).toEqual(['a4', 'a5', 'a6', 'a7'])
    expect(await ids('2026-09-28', '2026-09-30')).toEqual(['a4', 'a5', 'a6'])
    expect(await ids('2026-10-04')).toEqual([])
    expect(await ids()).toHaveLength(7)
  })

  it('filters by entity type, action and user', async () => {
    await seed()
    const ids = async (p: Parameters<typeof listAuditLog>[1]) => (await listAuditLog(ctxFor(), p)).entries.map((e) => e.id)
    expect(await ids({ entityType: 'transaction' })).toEqual(['a2', 'a5', 'a6'])
    expect(await ids({ entityType: ['transaction', 'staff'] })).toEqual(['a3', 'a2', 'a5', 'a6'])
    expect(await ids({ entityType: 'loan_request,product' })).toEqual(['a1', 'a4', 'a7'])
    expect(await ids({ action: 'create' })).toEqual(['a2', 'a1', 'a4', 'a5'])
    expect(await ids({ entityType: 'transaction', action: 'resolve' })).toEqual(['a6'])
    expect(await ids({ userId: 'sam-uid' })).toEqual(['a3'])
    expect(await ids({ entityType: 'transaction', from: '2026-09-29', to: '2026-10-02' })).toEqual(['a2', 'a5'])
  })

  it('rejects an unknown entity type, action or date', async () => {
    await expectDataError(listAuditLog(ctxFor(), { entityType: 'nope' }), 400, 'Unknown entity type.')
    await expectDataError(listAuditLog(ctxFor(), { action: 'create,nope' }), 400, 'Unknown action.')
    await expectDataError(listAuditLog(ctxFor(), { from: 'yesterday' }), 400, 'From must be a date (YYYY-MM-DD).')
  })

  it('looks up the lines only of the entries that show them, in line order', async () => {
    await seed()
    const at = new Date('2026-09-30T10:00:00.000Z')
    await db.insert(transactions).values({ id: 't1', transaction_type: 'OUT', reference_no: 'TXN-T1', staff_id: 'staff-1', created_at: at })
    await db.insert(transactionLines).values([
      { id: 'x-b', transaction_id: 't1', product_id: 'p2', product_name: 'Cable', barcode: 'C-1', line_no: 1, quantity: 4, created_at: at },
      { id: 'x-a', transaction_id: 't1', product_id: 'p1', product_name: 'Projector', barcode: 'P-1', line_no: 0, quantity: 1, created_at: at },
    ])
    await db.insert(loanRequests).values({
      id: 'lr1', reference_no: 'LR-LR100000', staff_id: 'staff-1', staff_name: 'Sam Staff', status: 'accepted',
      from_date: '2026-10-10', to_date: '2026-10-14', original_from_date: '2026-10-10', original_to_date: '2026-10-14', created_at: at, updated_at: at,
    })
    await db.insert(loanRequestLines).values([
      { id: 'q2', request_id: 'lr1', product_id: 'p2', product_name: 'Cable', line_no: 1, requested_quantity: 5, offered_quantity: 3, created_at: at },
      { id: 'q1', request_id: 'lr1', product_id: 'p1', product_name: 'Projector', line_no: 0, requested_quantity: 1, offered_quantity: 1, created_at: at },
    ])
    const { transactionLines: tl, loanRequestLines: lrl } = await listAuditLog(ctxFor())
    // t1: its 'create' entry (a2) froze no lines; its 'resolve' entry (a6) shows none. t2 froze its lines (a5): no lookup.
    expect(Object.keys(tl)).toEqual(['t1'])
    expect(tl.t1.map((l) => [l.id, l.transaction_id, l.product_id, l.product_name, l.barcode, l.issued_barcode, l.quantity, l.created_at])).toEqual([
      ['x-a', 't1', 'p1', 'Projector', 'P-1', null, 1, '2026-09-30T10:00:00.000Z'],
      ['x-b', 't1', 'p2', 'Cable', 'C-1', null, 4, '2026-09-30T10:00:00.000Z'],
    ])
    // lr1: only its 'create' entry (a4, before null) shows the join; the 'update' entry (a7) does not.
    expect(Object.keys(lrl)).toEqual(['lr1'])
    expect(lrl.lr1.map((l) => [l.product_name, l.requested_quantity, l.offered_quantity])).toEqual([['Projector', 1, 1], ['Cable', 5, 3]])
  })

  it('answers an empty list for a listed transaction or request that has no lines', async () => {
    await seed()
    const { transactionLines: tl, loanRequestLines: lrl } = await listAuditLog(ctxFor())
    expect(tl).toEqual({ t1: [] })
    expect(lrl).toEqual({ lr1: [] })
  })

  it('looks lines up only for the entries that survive the filters', async () => {
    await seed()
    const only = await listAuditLog(ctxFor(), { entityType: 'product' })
    expect(only.transactionLines).toEqual({})
    expect(only.loanRequestLines).toEqual({})
  })

  it('is empty with no entries', async () => {
    expect(await listAuditLog(ctxFor())).toEqual({ entries: [], transactionLines: {}, loanRequestLines: {} })
  })
})

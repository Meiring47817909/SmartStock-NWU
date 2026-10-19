import { asc, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  acceptCounter,
  approveAsIs,
  declineCounter,
  declineRequest,
  expireIfNeeded,
  findQuantityReductionConflicts,
  getRequest,
  getRequestLines,
  getReservationHolders,
  getReservationIntervals,
  getReservedQuantity,
  listRequests,
  loadLoanRequestsAlertCount,
  loadMyRequestsAlertCount,
  sendCounter,
  submitLoanRequest,
  validateCartDates,
  withdrawRequest,
} from '@/server/data/loanRequests'
import { recordStockOut } from '@/server/data/stock'
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
import type { LoanRequestStatus } from '@/types/database'
import { raceBehindLock } from '../helpers/locks'
import { closeTestDb, resetTestDb, TEST_DATABASE_URL } from '../helpers/db'

let db: Db
// Two more pools on the same database, so a transaction on each really runs on its own connection and row locks contend.
const POOL_B_URL = `${TEST_DATABASE_URL}?application_name=loanrequests-test-b`
const POOL_C_URL = `${TEST_DATABASE_URL}?application_name=loanrequests-test-c`
let dbB: Db
let dbC: Db

const NOW = new Date('2026-10-04T09:00:00.000Z')
const NOW_ISO = NOW.toISOString()
const admin: Caller = { uid: 'admin-uid', name: 'Ada Admin', role: 'admin', staffId: null }
const sam: Caller = { uid: 'sam-uid', name: 'Sam Staff', role: 'staff', staffId: 'staff-1' }
const bo: Caller = { uid: 'bo-uid', name: 'Bo Rrower', role: 'staff', staffId: 'staff-2' }
const loner: Caller = { uid: 'loner-uid', name: 'No Staff Row', role: 'staff', staffId: null }

const ctxAs = (caller: Caller, on: Db = db, now: Date = NOW): Ctx => ({ db: on, caller, now: () => now })
const adminCtx = (on: Db = db) => ctxAs(admin, on)
const samCtx = (on: Db = db) => ctxAs(sam, on)
const boCtx = (on: Db = db) => ctxAs(bo, on)

async function expectDataError(p: Promise<unknown>, status: number, message?: string) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(DataError)
  expect((err as DataError).status).toBe(status)
  if (message !== undefined) expect((err as DataError).message).toBe(message)
}

const CHANGED = 'This request has already changed — reload to see its current state.'
const audits = () => db.select().from(auditLog).orderBy(asc(auditLog.created_at), asc(auditLog.id))
const requestRow = async (id: string) => (await db.select().from(loanRequests).where(eq(loanRequests.id, id)))[0]
const offered = async (requestId: string) =>
  (await db.select().from(loanRequestLines).where(eq(loanRequestLines.request_id, requestId)).orderBy(asc(loanRequestLines.line_no))).map(
    (l) => [l.product_id, l.offered_quantity],
  )

interface SeedRequest {
  id: string
  staff_id?: string
  status?: LoanRequestStatus
  from?: string
  to?: string | null
  updated?: string
  message?: string | null
  admin_message?: string | null
  lines?: [productId: string, requested: number, offered?: number][]
}

/** Insert a request (and its lines) directly, in any state. Names come from the fixtures: p1 Projector, p2 Cable, p3 Laptop. */
async function seedRequest(r: SeedRequest) {
  const staffName = (r.staff_id ?? 'staff-1') === 'staff-1' ? 'Sam Staff' : 'Bo Rrower'
  const updated = new Date(r.updated ?? NOW_ISO)
  await db.insert(loanRequests).values({
    id: r.id,
    reference_no: `LR-${r.id.toUpperCase().padEnd(8, '0').slice(0, 8)}`,
    staff_id: r.staff_id ?? 'staff-1',
    staff_name: staffName,
    status: r.status ?? 'pending',
    message: r.message ?? null,
    admin_message: r.admin_message ?? null,
    from_date: r.from ?? '2026-10-10',
    to_date: r.to === undefined ? '2026-10-14' : r.to,
    original_from_date: r.from ?? '2026-10-10',
    original_to_date: r.to === undefined ? '2026-10-14' : r.to,
    created_at: updated,
    updated_at: updated,
  })
  const names: Record<string, string> = { p1: 'Projector', p2: 'Cable', p3: 'Laptop' }
  const lines = r.lines ?? [['p1', 2]]
  await db.insert(loanRequestLines).values(
    lines.map(([productId, requested, off], i) => ({
      id: `${r.id}-l${i}`,
      request_id: r.id,
      product_id: productId,
      product_name: names[productId],
      requested_quantity: requested,
      offered_quantity: off ?? requested,
      line_no: i,
      created_at: updated,
    })),
  )
}

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
  await db.execute(sql`drop trigger if exists fail_audit on audit_log`)
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
    // Projector: lendable from 2026-01-01 with no end, 1-week cap, 5 in stock.
    { id: 'p1', name: 'Projector', quantity_on_hand: 5, lend_from: '2026-01-01', lending_interval: 'week_1' },
    // Cable: lendable only 2026-01-01 – 2026-12-31, 1-month cap, 3 in stock.
    { id: 'p2', name: 'Cable', quantity_on_hand: 3, lend_from: '2026-01-01', lend_to: '2026-12-31', lending_interval: 'month_1' },
    // Laptop: no end date, Indefinitely, 2 in stock.
    { id: 'p3', name: 'Laptop', quantity_on_hand: 2, lend_from: '2026-01-01', lending_interval: 'indefinite' },
    // Not set up for portal lending.
    { id: 'p4', name: 'Stapler', quantity_on_hand: 9 },
  ])
})

// --- Submission ----------------------------------------------------------------------------------------------------

describe('submitLoanRequest', () => {
  it('writes the request, its lines and the create audit entry (pending, original dates, in cart order)', async () => {
    const id = await submitLoanRequest(samCtx(), {
      cart: [
        { productId: 'p2', quantity: 1 },
        { productId: 'p1', quantity: 2 },
      ],
      fromDate: '2026-10-10',
      toDate: '2026-10-14',
      message: '  Open day  ',
    })
    expect(id).toMatch(/^[A-Za-z0-9]{20}$/)

    const row = await requestRow(id)
    expect(row).toMatchObject({
      status: 'pending',
      staff_id: 'staff-1',
      staff_name: 'Sam Staff',
      message: 'Open day',
      admin_message: null,
      from_date: '2026-10-10',
      to_date: '2026-10-14',
      original_from_date: '2026-10-10',
      original_to_date: '2026-10-14',
      fulfilled_txn_id: null,
    })
    expect(row.reference_no).toMatch(/^LR-[A-Z0-9]{8}$/)
    expect(row.created_at).toEqual(NOW)
    expect(row.updated_at).toEqual(NOW)

    // Cart order is stored, not inferred from timestamps: every line has the same created_at.
    const stored = await db.select().from(loanRequestLines).where(eq(loanRequestLines.request_id, id)).orderBy(asc(loanRequestLines.line_no))
    expect(stored.map((l) => [l.line_no, l.product_id])).toEqual([[0, 'p2'], [1, 'p1']])
    expect(new Set(stored.map((l) => l.created_at.getTime())).size).toBe(1)
    const lines = (await getRequestLines(adminCtx(), id)).map((l) => [l.product_id, l.product_name, l.requested_quantity, l.offered_quantity])
    expect(lines).toEqual([
      ['p2', 'Cable', 1, 1],
      ['p1', 'Projector', 2, 2],
    ])

    const entries = await audits()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ action: 'create', entity_type: 'loan_request', entity_id: id, user_id: 'sam-uid', user_name: 'Sam Staff', before: null })
    expect(entries[0].created_at).toEqual(NOW)
    expect(entries[0].after).toEqual({
      reference_no: row.reference_no,
      staff_id: 'staff-1',
      staff_name: 'Sam Staff',
      status: 'pending',
      from_date: '2026-10-10',
      to_date: '2026-10-14',
      original_from_date: '2026-10-10',
      original_to_date: '2026-10-14',
      message: 'Open day',
      admin_message: null,
      fulfilled_txn_id: null,
      lines: [
        { product_id: 'p2', product_name: 'Cable', requested_quantity: 1, offered_quantity: 1 },
        { product_id: 'p1', product_name: 'Projector', requested_quantity: 2, offered_quantity: 2 },
      ],
      line_count: 2,
      total_qty: 3,
    })
  })

  it('an open-ended request (every item Indefinitely, no To date) stores a null to_date', async () => {
    const id = await submitLoanRequest(samCtx(), { cart: [{ productId: 'p3', quantity: 1 }], fromDate: '2026-10-10', toDate: '', message: null })
    const row = await requestRow(id)
    expect(row.to_date).toBeNull()
    expect(row.original_to_date).toBeNull()
    expect(row.message).toBeNull()
  })

  it("a staff member can only submit for their own staff record; an admin can for anyone; someone with no staff row can't", async () => {
    const input = { cart: [{ productId: 'p1', quantity: 1 }], fromDate: '2026-10-10', toDate: '2026-10-12' }
    await expectDataError(submitLoanRequest(samCtx(), { ...input, staffId: 'staff-2' }), 403)
    await expectDataError(submitLoanRequest(ctxAs(loner), input), 403)
    expect(await db.select().from(loanRequests)).toHaveLength(0)

    const own = await submitLoanRequest(samCtx(), { ...input, staffId: 'staff-1' })
    expect((await requestRow(own)).staff_id).toBe('staff-1')
    const onBehalf = await submitLoanRequest(adminCtx(), { ...input, staffId: 'staff-2' })
    expect(await requestRow(onBehalf)).toMatchObject({ staff_id: 'staff-2', staff_name: 'Bo Rrower' })
    await expectDataError(submitLoanRequest(adminCtx(), input), 400, 'Choose a staff member.')
    await expectDataError(submitLoanRequest(adminCtx(), { ...input, staffId: 'nobody' }), 404, 'Staff record not found.')
  })

  it('a failed check is a 400 with the first message and writes nothing', async () => {
    await expectDataError(
      submitLoanRequest(samCtx(), { cart: [{ productId: 'p1', quantity: 9 }], fromDate: '2026-10-10', toDate: '2026-10-12' }),
      400,
      'Projector: only 5 unit(s) available for these dates, you requested 9.',
    )
    await expectDataError(submitLoanRequest(samCtx(), { cart: [{ productId: 'p1', quantity: 1 }], fromDate: '', toDate: '' }), 400, 'Select a From date.')
    await expectDataError(submitLoanRequest(samCtx(), { cart: [], fromDate: '2026-10-10', toDate: '2026-10-12' }), 400, 'Add at least one item.')
    await expectDataError(
      submitLoanRequest(samCtx(), { cart: [{ productId: 'p1', quantity: 0 }], fromDate: '2026-10-10', toDate: '2026-10-12' }),
      400,
      'Quantity must be a whole number above zero.',
    )
    await expectDataError(
      submitLoanRequest(samCtx(), { cart: [{ productId: 'nope', quantity: 1 }], fromDate: '2026-10-10', toDate: '2026-10-12' }),
      404,
      'Product not found.',
    )
    await expectDataError(
      submitLoanRequest(samCtx(), { cart: [{ productId: 'p1', quantity: 1 }], fromDate: '2026-02-30', toDate: '2026-10-12' }),
      400,
      'From date must be a date (YYYY-MM-DD).',
    )
    expect(await db.select().from(loanRequests)).toHaveLength(0)
    expect(await db.select().from(loanRequestLines)).toHaveLength(0)
    expect(await audits()).toHaveLength(0)
  })

  it('counts a pending request against availability, so the last unit cannot be requested twice (one at a time)', async () => {
    await db.update(products).set({ quantity_on_hand: 1 }).where(eq(products.id, 'p1'))
    const input = { cart: [{ productId: 'p1', quantity: 1 }], fromDate: '2026-10-10', toDate: '2026-10-12' }
    await submitLoanRequest(samCtx(), input)
    await expectDataError(
      submitLoanRequest(boCtx(), { ...input, toDate: '2026-10-11' }),
      400,
      'Projector: only 0 unit(s) available for these dates, you requested 1.',
    )
    // A different week is fine.
    await submitLoanRequest(boCtx(), { ...input, fromDate: '2026-10-20', toDate: '2026-10-21' })
  })

  it('two simultaneous submissions for the last unit: one is accepted, one is told it is gone', async () => {
    await db.update(products).set({ quantity_on_hand: 1 }).where(eq(products.id, 'p1'))
    const input = { cart: [{ productId: 'p1', quantity: 1 }], fromDate: '2026-10-10', toDate: '2026-10-12' }
    const results = await raceBehindLock(db, dbC, 'products', 'p1', [
      () => submitLoanRequest(samCtx(db), input),
      () => submitLoanRequest(boCtx(dbB), input),
    ])
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    const loser = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect((loser.reason as DataError).message).toBe('Projector: only 0 unit(s) available for these dates, you requested 1.')
    expect(await db.select().from(loanRequests)).toHaveLength(1)
    expect(await audits()).toHaveLength(1)
  })
})

describe('validateCartDates', () => {
  const cart = (...items: [string, number][]) => items.map(([productId, quantity]) => ({ productId, quantity }))

  it('an item the IT Store has switched to Unavailable is refused, by name, and accepted again once it is switched back on', async () => {
    await db.update(products).set({ available: false }).where(eq(products.id, 'p1'))
    expect(await validateCartDates(samCtx(), cart(['p1', 1], ['p2', 1]), '2026-10-10', '2026-10-12')).toEqual({
      valid: false,
      errors: ['Projector is no longer offered — remove it from your cart.'],
    })
    // The submit runs the same check on the server, so a stale cart page can't get round it.
    await expectDataError(
      submitLoanRequest(samCtx(), { cart: [{ productId: 'p1', quantity: 1 }], fromDate: '2026-10-10', toDate: '2026-10-12' }),
      400,
      'Projector is no longer offered — remove it from your cart.',
    )
    expect(await db.select().from(loanRequests)).toEqual([])
    await db.update(products).set({ available: true }).where(eq(products.id, 'p1'))
    expect(await validateCartDates(samCtx(), cart(['p1', 1], ['p2', 1]), '2026-10-10', '2026-10-12')).toEqual({ valid: true, errors: [] })
  })

  it('an over-reserved range names the product and how many units are left', async () => {
    await seedRequest({ id: 'held', status: 'accepted', from: '2026-10-12', to: '2026-10-16', lines: [['p1', 3]] })
    const res = await validateCartDates(samCtx(), cart(['p1', 3]), '2026-10-14', '2026-10-18')
    expect(res).toEqual({ valid: false, errors: ['Projector: only 2 unit(s) available for these dates, you requested 3.'] })
    // Outside the held window (the day after it ends) the full stock is there.
    expect(await validateCartDates(samCtx(), cart(['p1', 3]), '2026-10-17', '2026-10-20')).toEqual({ valid: true, errors: [] })
    // The edges are inclusive: a range ending on the held window's first day overlaps it.
    expect((await validateCartDates(samCtx(), cart(['p1', 3]), '2026-10-09', '2026-10-12')).valid).toBe(false)
    // Declined, withdrawn, expired... requests hold nothing.
    await db.update(loanRequests).set({ status: 'declined' })
    expect((await validateCartDates(samCtx(), cart(['p1', 3]), '2026-10-14', '2026-10-18')).valid).toBe(true)
  })

  it('an open-ended reservation holds everything from its start date on', async () => {
    await seedRequest({ id: 'open', status: 'accepted', from: '2026-10-12', to: null, lines: [['p3', 2]] })
    expect((await validateCartDates(samCtx(), cart(['p3', 1]), '2027-03-01', '2027-03-02')).errors).toEqual([
      'Laptop: only 0 unit(s) available for these dates, you requested 1.',
    ])
    expect((await validateCartDates(samCtx(), cart(['p3', 1]), '2026-10-01', '2026-10-11')).valid).toBe(true)
  })

  it('date and lending-interval messages, all collected at once', async () => {
    expect(await validateCartDates(samCtx(), cart(['p1', 1]), '', '')).toEqual({ valid: false, errors: ['Select a From date.'] })
    expect((await validateCartDates(samCtx(), cart(['p1', 1]), '2026-10-10', '')).errors).toEqual([
      'Select a To date — one or more items in your cart have a limited lending interval.',
    ])
    expect((await validateCartDates(samCtx(), cart(['p1', 1]), '2026-10-10', '2026-10-09')).errors).toEqual(["To date can't be before the From date."])
    // 1 Week cap on the projector binds the whole cart, even next to a 1 Month cable.
    expect((await validateCartDates(samCtx(), cart(['p1', 1], ['p2', 1]), '2026-10-10', '2026-10-18')).errors).toEqual([
      'Loan window cannot exceed 1 Week for the items in your cart.',
    ])
    expect((await validateCartDates(samCtx(), cart(['p1', 1]), '2026-10-10', '2026-10-17')).valid).toBe(true)
    // Every item Indefinitely: no To date needed, and none is capped.
    expect((await validateCartDates(samCtx(), cart(['p3', 1]), '2026-10-10', '')).valid).toBe(true)
    expect((await validateCartDates(samCtx(), cart(['p3', 1]), '2026-10-10', '2030-01-01')).valid).toBe(true)
  })

  it("a product's own lend window", async () => {
    expect((await validateCartDates(samCtx(), cart(['p4', 1]), '2026-10-10', '2026-10-12')).errors).toEqual(["Stapler isn't set up for portal lending."])
    // The cable has a lend_to cutoff (and a 1 Month cap), so an open-ended request is refused even though the laptop alone would allow one.
    expect((await validateCartDates(samCtx(), cart(['p2', 1], ['p3', 1]), '2026-10-10', '')).errors).toEqual([
      'Select a To date — one or more items in your cart have a limited lending interval.',
      'Cable must be returned by 2026-12-31 — pick a To date within its lendable window.',
    ])
    expect((await validateCartDates(samCtx(), cart(['p2', 1]), '2025-12-30', '2026-01-02')).errors).toEqual([
      'Cable is only lendable 2026-01-01 – 2026-12-31 — outside your selected range.',
    ])
    expect((await validateCartDates(samCtx(), cart(['p2', 1]), '2026-12-28', '2027-01-02')).errors).toEqual([
      'Cable is only lendable 2026-01-01 – 2026-12-31 — outside your selected range.',
    ])
    expect((await validateCartDates(samCtx(), cart(['p1', 1]), '2025-12-30', '2026-01-02')).errors).toEqual([
      'Projector is only lendable from 2026-01-01 — outside your selected range.',
    ])
  })

  it('writes nothing', async () => {
    await validateCartDates(samCtx(), cart(['p1', 1]), '2026-10-10', '2026-10-12')
    expect(await db.select().from(loanRequests)).toHaveLength(0)
    expect(await audits()).toHaveLength(0)
  })
})

// --- Reads and access ----------------------------------------------------------------------------------------------

describe('who can read what', () => {
  beforeEach(async () => {
    await seedRequest({ id: 'sams', staff_id: 'staff-1', status: 'pending' })
    await seedRequest({ id: 'bos', staff_id: 'staff-2', status: 'accepted', lines: [['p2', 1]] })
  })

  it("a staff member cannot read another staff member's request: 404, not 403", async () => {
    await expectDataError(getRequest(boCtx(), 'sams'), 404, 'Loan request not found.')
    await expectDataError(getRequestLines(boCtx(), 'sams'), 404, 'Loan request not found.')
    await expectDataError(expireIfNeeded(boCtx(), 'sams'), 404)
    // Same answer as a request that does not exist, so nothing is revealed.
    await expectDataError(getRequest(boCtx(), 'missing'), 404, 'Loan request not found.')
    const own = await getRequest(samCtx(), 'sams')
    expect(own.request).toMatchObject({ id: 'sams', status: 'pending', reference_no: 'LR-SAMS0000', staff_name: 'Sam Staff', created_at: NOW_ISO, updated_at: NOW_ISO, fulfilled_txn_id: null })
    expect(own.lines).toHaveLength(1)
    expect((await getRequest(adminCtx(), 'bos')).request.id).toBe('bos')
  })

  it("listRequests: staff get only their own, admins get everyone's and can filter", async () => {
    expect((await listRequests(samCtx())).map((r) => r.id)).toEqual(['sams'])
    expect((await listRequests(samCtx(), { staffId: 'staff-1' })).map((r) => r.id)).toEqual(['sams'])
    await expectDataError(listRequests(samCtx(), { staffId: 'staff-2' }), 403)
    expect(await listRequests(ctxAs(loner))).toEqual([])
    expect((await listRequests(adminCtx())).map((r) => r.id).sort()).toEqual(['bos', 'sams'])
    expect((await listRequests(adminCtx(), { staffId: 'staff-2' })).map((r) => r.id)).toEqual(['bos'])
    expect((await listRequests(adminCtx(), { statuses: ['accepted'] })).map((r) => r.id)).toEqual(['bos'])
    expect((await listRequests(adminCtx(), { statuses: ['accepted', 'pending'] })).map((r) => r.id).sort()).toEqual(['bos', 'sams'])
    expect(await listRequests(adminCtx(), { statuses: [] })).toEqual([])
    await expectDataError(listRequests(adminCtx(), { statuses: ['bogus' as LoanRequestStatus] }), 400)
  })

  it("Stock Out's accepted pickups of a staff member: listRequests(staffId, ['accepted']) leaves out anything fulfilled", async () => {
    await seedRequest({ id: 'bos2', staff_id: 'staff-2', status: 'fulfilled', lines: [['p2', 1]] })
    await seedRequest({ id: 'bos3', staff_id: 'staff-2', status: 'pending', lines: [['p2', 1]] })
    const pickups = await listRequests(adminCtx(), { staffId: 'staff-2', statuses: ['accepted'] })
    expect(pickups.map((r) => r.id)).toEqual(['bos'])
    expect(pickups[0].fulfilled_txn_id).toBeNull()
  })

  it('a request that pre-dates references has no reference_no field', async () => {
    await db.update(loanRequests).set({ reference_no: null }).where(eq(loanRequests.id, 'sams'))
    const { request } = await getRequest(samCtx(), 'sams')
    expect('reference_no' in request).toBe(false)
  })

  it('admin actions are a 403 for staff', async () => {
    await expectDataError(approveAsIs(samCtx(), 'sams'), 403, 'Only admins can do this.')
    await expectDataError(sendCounter(samCtx(), 'sams', { lines: [] }), 403)
    await expectDataError(declineRequest(samCtx(), 'sams', 'no'), 403)
    await expectDataError(getReservationHolders(samCtx(), 'p1', '2026-10-01', '2026-10-31'), 403)
    await expectDataError(findQuantityReductionConflicts(samCtx(), 'p1', 0), 403)
    await expectDataError(loadLoanRequestsAlertCount(samCtx()), 403)
    expect((await requestRow('sams')).status).toBe('pending')
    expect(await audits()).toHaveLength(0)
  })
})

// --- Admin decisions -----------------------------------------------------------------------------------------------

describe('approveAsIs', () => {
  it('moves pending to accepted and writes the update audit with the full before/after snapshot', async () => {
    await seedRequest({ id: 'r1', message: 'For the open day', lines: [['p1', 2], ['p2', 1]] })
    const later = new Date('2026-10-04T10:30:00.000Z')
    const res = await approveAsIs(ctxAs(admin, db, later), 'r1')
    expect(res).toMatchObject({ id: 'r1', status: 'accepted', updated_at: later.toISOString() })
    expect(await requestRow('r1')).toMatchObject({ status: 'accepted', from_date: '2026-10-10', to_date: '2026-10-14' })

    const entries = await audits()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ action: 'update', entity_type: 'loan_request', entity_id: 'r1', user_id: 'admin-uid', user_name: 'Ada Admin' })
    const frozen = {
      reference_no: 'LR-R1000000',
      staff_id: 'staff-1',
      staff_name: 'Sam Staff',
      from_date: '2026-10-10',
      to_date: '2026-10-14',
      original_from_date: '2026-10-10',
      original_to_date: '2026-10-14',
      message: 'For the open day',
      admin_message: null,
      fulfilled_txn_id: null,
      lines: [
        { product_id: 'p1', product_name: 'Projector', requested_quantity: 2, offered_quantity: 2 },
        { product_id: 'p2', product_name: 'Cable', requested_quantity: 1, offered_quantity: 1 },
      ],
      line_count: 2,
      total_qty: 3,
    }
    expect(entries[0].before).toEqual({ ...frozen, status: 'pending' })
    expect(entries[0].after).toEqual({ ...frozen, status: 'accepted' })
  })

  it('refuses when stock no longer covers a line (other requests count, this one does not count against itself)', async () => {
    await seedRequest({ id: 'r1', lines: [['p1', 3]] })
    await seedRequest({ id: 'other', staff_id: 'staff-2', status: 'accepted', from: '2026-10-12', to: '2026-10-20', lines: [['p1', 3]] })
    await expectDataError(
      approveAsIs(adminCtx(), 'r1'),
      409,
      'Availability changed since this request was submitted — not enough stock remains for one of the lines.',
    )
    expect((await requestRow('r1')).status).toBe('pending')
    expect(await audits()).toHaveLength(0)

    await db.update(products).set({ quantity_on_hand: 6 }).where(eq(products.id, 'p1'))
    expect((await approveAsIs(adminCtx(), 'r1')).status).toBe('accepted')
  })

  it('only from pending; a second approval (a stale page) is a 409', async () => {
    await seedRequest({ id: 'r1' })
    await approveAsIs(adminCtx(), 'r1')
    await expectDataError(approveAsIs(adminCtx(), 'r1'), 409, CHANGED)
    await expectDataError(approveAsIs(adminCtx(), 'missing'), 404, 'Loan request not found.')
    for (const status of ['countered', 'declined', 'withdrawn', 'fulfilled', 'expired', 'no_show'] as const) {
      await db.update(loanRequests).set({ status }).where(eq(loanRequests.id, 'r1'))
      await expectDataError(approveAsIs(adminCtx(), 'r1'), 409, CHANGED)
    }
    expect(await audits()).toHaveLength(1)
  })

  it('accepts a whole request object as well as an id', async () => {
    await seedRequest({ id: 'r1' })
    expect((await approveAsIs(adminCtx(), { id: 'r1' })).status).toBe('accepted')
  })
})

describe('sendCounter', () => {
  it('edits offered quantities and dates in one transaction, with the before/after lines in the audit entry', async () => {
    await seedRequest({ id: 'r1', message: 'Please', lines: [['p1', 3], ['p2', 2]] })
    const res = await sendCounter(adminCtx(), 'r1', {
      lines: [
        { lineId: 'r1-l0', product_id: 'p1', offered_quantity: 1 },
        { lineId: 'r1-l1', product_id: 'p2', offered_quantity: 0 },
      ],
      fromDate: '2026-10-11',
      toDate: '2026-10-13',
      message: '  Only one left.  ',
    })
    expect(res).toMatchObject({ status: 'countered', from_date: '2026-10-11', to_date: '2026-10-13', admin_message: 'Only one left.', original_from_date: '2026-10-10', original_to_date: '2026-10-14' })
    expect(await offered('r1')).toEqual([['p1', 1], ['p2', 0]])
    expect((await db.select().from(loanRequestLines).where(eq(loanRequestLines.id, 'r1-l0')))[0].requested_quantity).toBe(3)

    const [entry] = await audits()
    expect(entry).toMatchObject({ action: 'update', entity_id: 'r1', user_id: 'admin-uid' })
    expect(entry.before).toMatchObject({
      status: 'pending', from_date: '2026-10-10', to_date: '2026-10-14', admin_message: null, line_count: 2, total_qty: 5,
      lines: [
        { product_id: 'p1', requested_quantity: 3, offered_quantity: 3 },
        { product_id: 'p2', requested_quantity: 2, offered_quantity: 2 },
      ],
    })
    expect(entry.after).toMatchObject({
      status: 'countered', from_date: '2026-10-11', to_date: '2026-10-13', admin_message: 'Only one left.',
      original_from_date: '2026-10-10', original_to_date: '2026-10-14', message: 'Please', line_count: 2, total_qty: 1,
      lines: [
        { product_id: 'p1', product_name: 'Projector', requested_quantity: 3, offered_quantity: 1 },
        { product_id: 'p2', product_name: 'Cable', requested_quantity: 2, offered_quantity: 0 },
      ],
    })
  })

  it('a null To date makes the request open-ended; leaving the dates out keeps them', async () => {
    await seedRequest({ id: 'r1', lines: [['p3', 1]] })
    const res = await sendCounter(adminCtx(), 'r1', { lines: [], toDate: null })
    expect(res).toMatchObject({ from_date: '2026-10-10', to_date: null })
    await db.update(loanRequests).set({ status: 'pending' })
    expect(await sendCounter(adminCtx(), 'r1', { lines: [] })).toMatchObject({ from_date: '2026-10-10', to_date: null, admin_message: null })
  })

  it('rolls everything back when its audit entry cannot be written', async () => {
    await seedRequest({ id: 'r1', lines: [['p1', 3]] })
    await db.execute(sql`create or replace function fail_audit() returns trigger as $$ begin raise exception 'audit down'; end $$ language plpgsql`)
    await db.execute(sql`create trigger fail_audit before insert on audit_log for each row execute function fail_audit()`)
    try {
      await expect(
        sendCounter(adminCtx(), 'r1', { lines: [{ lineId: 'r1-l0', product_id: 'p1', offered_quantity: 1 }], fromDate: '2026-10-11', message: 'x' }),
      ).rejects.toThrow()
    } finally {
      await db.execute(sql`drop trigger fail_audit on audit_log`)
    }
    expect(await requestRow('r1')).toMatchObject({ status: 'pending', from_date: '2026-10-10', admin_message: null })
    expect(await offered('r1')).toEqual([['p1', 3]])
  })

  it('refuses offers above the request, unknown lines, backwards dates, other statuses and short stock', async () => {
    await seedRequest({ id: 'r1', lines: [['p1', 3]] })
    await expectDataError(sendCounter(adminCtx(), 'r1', { lines: [{ lineId: 'r1-l0', product_id: 'p1', offered_quantity: 4 }] }), 400)
    await expectDataError(sendCounter(adminCtx(), 'r1', { lines: [{ lineId: 'r1-l0', product_id: 'p1', offered_quantity: -1 }] }), 400)
    await expectDataError(sendCounter(adminCtx(), 'r1', { lines: [{ lineId: 'r1-l0', product_id: 'p1', offered_quantity: 1.5 }] }), 400)
    await expectDataError(sendCounter(adminCtx(), 'r1', { lines: [{ lineId: 'nope', product_id: 'p1', offered_quantity: 1 }] }), 400)
    await expectDataError(sendCounter(adminCtx(), 'r1', { lines: [], fromDate: '2026-10-20', toDate: '2026-10-19' }), 400, "To date can't be before the From date.")
    await expectDataError(sendCounter(adminCtx(), 'r1', { lines: [], fromDate: 'soon' }), 400)

    await seedRequest({ id: 'other', staff_id: 'staff-2', status: 'accepted', lines: [['p1', 4]] })
    await expectDataError(sendCounter(adminCtx(), 'r1', { lines: [] }), 409, 'Availability changed since this request was submitted — not enough stock remains for one of the lines.')
    // Offering fewer than the other request leaves room for is fine.
    expect((await sendCounter(adminCtx(), 'r1', { lines: [{ lineId: 'r1-l0', product_id: 'p1', offered_quantity: 1 }] })).status).toBe('countered')
    // Already countered: a stale page cannot counter again.
    await expectDataError(sendCounter(adminCtx(), 'r1', { lines: [] }), 409, CHANGED)
    expect(await audits()).toHaveLength(1)
  })
})

describe('declineRequest', () => {
  it('declines a pending request with the admin message and a full snapshot', async () => {
    await seedRequest({ id: 'r1', message: 'Please', lines: [['p1', 2]] })
    const res = await declineRequest(adminCtx(), 'r1', '  Not available  ')
    expect(res).toMatchObject({ status: 'declined', admin_message: 'Not available' })
    const [entry] = await audits()
    expect(entry.before).toMatchObject({ status: 'pending', admin_message: null })
    expect(entry.after).toMatchObject({ status: 'declined', admin_message: 'Not available', message: 'Please', total_qty: 2 })
    // Nothing was countered, so nothing extra is frozen.
    expect(entry.after).not.toHaveProperty('countered_lines')
  })

  it('declining a countered request freezes the counter offer into the audit entry', async () => {
    await seedRequest({ id: 'r1', status: 'countered', message: 'Please', admin_message: 'Only one', lines: [['p1', 3, 1], ['p2', 2, 0]] })
    await declineRequest(adminCtx(), 'r1', null)
    expect(await requestRow('r1')).toMatchObject({ status: 'declined', admin_message: null })
    const [entry] = await audits()
    expect(entry.after).toMatchObject({
      status: 'declined',
      admin_message: null,
      staff_message: 'Please',
      counter_message: 'Only one',
      countered_lines: [
        { product_name: 'Projector', requested_quantity: 3, offered_quantity: 1 },
        { product_name: 'Cable', requested_quantity: 2, offered_quantity: 0 },
      ],
    })
  })

  it('only from pending or countered', async () => {
    await seedRequest({ id: 'r1', status: 'accepted' })
    await expectDataError(declineRequest(adminCtx(), 'r1', 'x'), 409, CHANGED)
  })
})

// --- Staff responses -----------------------------------------------------------------------------------------------

describe('acceptCounter / declineCounter', () => {
  it('accept moves countered to accepted, with the full snapshot (offered quantities as countered)', async () => {
    await seedRequest({ id: 'r1', status: 'countered', admin_message: 'Only one', lines: [['p1', 3, 1]] })
    const res = await acceptCounter(samCtx(), 'r1')
    expect(res.status).toBe('accepted')
    const [entry] = await audits()
    expect(entry).toMatchObject({ action: 'update', entity_id: 'r1', user_id: 'sam-uid', user_name: 'Sam Staff' })
    expect(entry.before).toMatchObject({ status: 'countered', admin_message: 'Only one', total_qty: 1, lines: [{ requested_quantity: 3, offered_quantity: 1 }] })
    expect(entry.after).toMatchObject({ status: 'accepted', admin_message: 'Only one', total_qty: 1 })
  })

  it('decline moves countered to declined', async () => {
    await seedRequest({ id: 'r1', status: 'countered' })
    expect((await declineCounter(samCtx(), 'r1')).status).toBe('declined')
    expect((await audits())[0].after).toMatchObject({ status: 'declined' })
  })

  it('only from countered', async () => {
    for (const status of ['pending', 'accepted', 'declined', 'withdrawn', 'fulfilled', 'expired', 'no_show'] as const) {
      await seedRequest({ id: `r-${status}`, status })
      await expectDataError(acceptCounter(samCtx(), `r-${status}`), 409, CHANGED)
      await expectDataError(declineCounter(samCtx(), `r-${status}`), 409, CHANGED)
      expect((await requestRow(`r-${status}`)).status).toBe(status)
    }
    expect(await audits()).toHaveLength(0)
  })

  it("only the request's own staff member: another staff member gets a 404, an admin who is not that person a 403", async () => {
    await seedRequest({ id: 'r1', status: 'countered' })
    await expectDataError(acceptCounter(boCtx(), 'r1'), 404, 'Loan request not found.')
    await expectDataError(declineCounter(boCtx(), 'r1'), 404, 'Loan request not found.')
    await expectDataError(acceptCounter(adminCtx(), 'r1'), 403)
    await expectDataError(acceptCounter(ctxAs(loner), 'r1'), 404)
    expect((await requestRow('r1')).status).toBe('countered')
  })
})

describe('withdrawRequest', () => {
  it.each(['pending', 'countered', 'accepted'] as const)('a staff member withdraws their own %s request', async (status) => {
    await seedRequest({ id: 'r1', status })
    expect((await withdrawRequest(samCtx(), 'r1')).status).toBe('withdrawn')
    const [entry] = await audits()
    expect(entry.user_id).toBe('sam-uid')
    expect(entry.before).toMatchObject({ status })
    expect(entry.after).toMatchObject({ status: 'withdrawn' })
    expect(entry.after).not.toHaveProperty('cancel_reason')
  })

  it('an admin cancels an accepted pickup with a reason, recorded as cancel_reason', async () => {
    await seedRequest({ id: 'r1', status: 'accepted', lines: [['p1', 1]] })
    await withdrawRequest(adminCtx(), { id: 'r1' }, '  Out for repair ')
    const [entry] = await audits()
    expect(entry).toMatchObject({ user_id: 'admin-uid', user_name: 'Ada Admin' })
    expect(entry.after).toMatchObject({ status: 'withdrawn', cancel_reason: 'Out for repair', total_qty: 1 })
  })

  it("another staff member's request is a 404; finished requests are a 409", async () => {
    await seedRequest({ id: 'r1', status: 'accepted' })
    await expectDataError(withdrawRequest(boCtx(), 'r1'), 404, 'Loan request not found.')
    for (const status of ['declined', 'withdrawn', 'fulfilled', 'expired', 'no_show'] as const) {
      await db.update(loanRequests).set({ status }).where(eq(loanRequests.id, 'r1'))
      await expectDataError(withdrawRequest(samCtx(), 'r1'), 409, CHANGED)
      await expectDataError(withdrawRequest(adminCtx(), 'r1', 'x'), 409, CHANGED)
    }
    expect(await audits()).toHaveLength(0)
  })
})

describe('simultaneous decisions on one request', () => {
  it('approve and decline at once: one wins, the other is told the request changed', async () => {
    await seedRequest({ id: 'r1' })
    const results = await raceBehindLock<unknown>(db, dbC, 'loan_requests', 'r1', [
      () => approveAsIs(adminCtx(db), 'r1'),
      () => declineRequest(adminCtx(dbB), 'r1', 'no'),
    ])
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    const loser = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect((loser.reason as DataError).status).toBe(409)
    expect((loser.reason as DataError).message).toBe(CHANGED)
    expect(await audits()).toHaveLength(1)
  })

  it('a staff withdrawal racing an approval: exactly one change and one audit entry', async () => {
    await seedRequest({ id: 'r1' })
    const results = await raceBehindLock<unknown>(db, dbC, 'loan_requests', 'r1', [
      () => approveAsIs(adminCtx(db), 'r1'),
      () => withdrawRequest(samCtx(dbB), 'r1'),
    ])
    // Whichever went first, the second one saw the first one's result: approve then withdraw both succeed in order, or
    // withdraw then approve fails. Either way, one audit entry per successful change and a consistent final status.
    const ok = results.filter((r) => r.status === 'fulfilled').length
    expect(await audits()).toHaveLength(ok)
    const final = (await requestRow('r1')).status
    expect(['accepted', 'withdrawn']).toContain(final)
    if (ok === 1) expect(results.some((r) => r.status === 'rejected' && (r.reason as DataError).message === CHANGED)).toBe(true)
  })
})

// --- Expiry and no-show --------------------------------------------------------------------------------------------

describe('expireIfNeeded', () => {
  const SYSTEM_NAME = 'System (automatic)'

  it('expires a pending request 30 days after its last change (or at its From date, if sooner), recorded as the system', async () => {
    // updated 2026-09-01 + 30 days = 2026-10-01, before the From date: expired by 2026-10-04.
    await seedRequest({ id: 'r1', status: 'pending', updated: '2026-09-01T08:00:00.000Z', from: '2026-10-10', lines: [['p1', 2]] })
    expect(await expireIfNeeded(samCtx(), 'r1')).toBe('expired')
    expect(await requestRow('r1')).toMatchObject({ status: 'expired', updated_at: NOW })
    const entries = await audits()
    expect(entries).toHaveLength(1)
    // Not the person whose page ran the pass.
    expect(entries[0]).toMatchObject({ action: 'update', entity_type: 'loan_request', entity_id: 'r1', user_id: null, user_name: SYSTEM_NAME })
    expect(entries[0].before).toMatchObject({ status: 'pending', staff_name: 'Sam Staff', fulfilled_txn_id: null, line_count: 1, total_qty: 2, lines: [{ product_id: 'p1', offered_quantity: 2 }] })
    expect(entries[0].after).toMatchObject({ status: 'expired', staff_name: 'Sam Staff', fulfilled_txn_id: null, line_count: 1, total_qty: 2 })
    // Already settled: asking again changes and writes nothing.
    expect(await expireIfNeeded(samCtx(), 'r1')).toBe('expired')
    expect(await audits()).toHaveLength(1)
  })

  it('a countered request expires the same way; a request near its From date expires after it', async () => {
    await seedRequest({ id: 'c1', status: 'countered', updated: '2026-09-20T08:00:00.000Z', from: '2026-10-03' })
    expect(await expireIfNeeded(adminCtx(), 'c1')).toBe('expired') // From date 2026-10-03 is the cap; today is the 4th
    await seedRequest({ id: 'c2', status: 'pending', updated: '2026-09-20T08:00:00.000Z', from: '2026-10-04' })
    expect(await expireIfNeeded(adminCtx(), 'c2')).toBe('pending') // expiry day itself is not yet past
    expect(await expireIfNeeded(ctxAs(admin, db, new Date('2026-10-05T09:00:00.000Z')), 'c2')).toBe('expired') // the server clock decides
  })

  it('a recent pending or countered request is left alone', async () => {
    await seedRequest({ id: 'r1', status: 'pending', updated: '2026-10-01T08:00:00.000Z', from: '2026-10-20' })
    expect(await expireIfNeeded(adminCtx(), 'r1')).toBe('pending')
    expect(await audits()).toHaveLength(0)
  })

  it('an accepted request whose whole window has passed with nothing issued becomes a no-show', async () => {
    await seedRequest({ id: 'r1', status: 'accepted', from: '2026-09-20', to: '2026-10-03' })
    expect(await expireIfNeeded(samCtx(), 'r1')).toBe('no_show')
    const [entry] = await audits()
    expect(entry).toMatchObject({ user_id: null, user_name: SYSTEM_NAME, entity_id: 'r1' })
    expect(entry.before).toMatchObject({ status: 'accepted' })
    expect(entry.after).toMatchObject({ status: 'no_show', fulfilled_txn_id: null })
  })

  it('never flags an accepted request still inside its window, an open-ended one, or a fulfilled one', async () => {
    await seedRequest({ id: 'in-window', status: 'accepted', from: '2026-10-01', to: '2026-10-04' })
    await seedRequest({ id: 'open', status: 'accepted', from: '2026-01-01', to: null })
    await seedRequest({ id: 'done', status: 'fulfilled', from: '2026-01-01', to: '2026-01-02' })
    for (const id of ['in-window', 'open', 'done']) expect(await expireIfNeeded(adminCtx(), id)).toBe(id === 'done' ? 'fulfilled' : 'accepted')
    expect(await audits()).toHaveLength(0)
  })

  it('works for a request of any staff member when an admin asks, and refuses someone elses request for staff', async () => {
    await seedRequest({ id: 'r1', status: 'accepted', from: '2026-09-20', to: '2026-10-03', staff_id: 'staff-2' })
    await expectDataError(expireIfNeeded(samCtx(), 'r1'), 404)
    expect(await expireIfNeeded(adminCtx(), 'r1')).toBe('no_show')
    await expectDataError(expireIfNeeded(adminCtx(), 'missing'), 404)
  })

  it('two simultaneous expireIfNeeded calls on an expired request: one status change, one audit entry', async () => {
    await seedRequest({ id: 'r1', status: 'pending', updated: '2026-09-01T08:00:00.000Z', from: '2026-10-10' })
    const results = await raceBehindLock(db, dbC, 'loan_requests', 'r1', [
      () => expireIfNeeded(samCtx(db), 'r1'),
      () => expireIfNeeded(adminCtx(dbB), 'r1'),
    ])
    expect(results.map((r) => (r.status === 'fulfilled' ? r.value : 'rejected'))).toEqual(['expired', 'expired'])
    expect(await requestRow('r1')).toMatchObject({ status: 'expired' })
    const entries = await audits()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ entity_id: 'r1', user_id: null })
  })

  it('two simultaneous no-show transitions: one status change, one audit entry', async () => {
    await seedRequest({ id: 'r1', status: 'accepted', from: '2026-09-20', to: '2026-10-03' })
    const results = await raceBehindLock(db, dbC, 'loan_requests', 'r1', [
      () => expireIfNeeded(samCtx(db), 'r1'),
      () => expireIfNeeded(samCtx(dbB), 'r1'),
    ])
    expect(results.map((r) => (r.status === 'fulfilled' ? r.value : 'rejected'))).toEqual(['no_show', 'no_show'])
    const entries = await audits()
    expect(entries).toHaveLength(1)
    expect(entries[0].after).toMatchObject({ status: 'no_show' })
  })

  it('an expiry racing a staff withdrawal never writes two outcomes', async () => {
    await seedRequest({ id: 'r1', status: 'pending', updated: '2026-09-01T08:00:00.000Z', from: '2026-10-10' })
    const results = await raceBehindLock<unknown>(db, dbC, 'loan_requests', 'r1', [
      () => expireIfNeeded(samCtx(db), 'r1'),
      () => withdrawRequest(samCtx(dbB), 'r1'),
    ])
    const entries = await audits()
    const final = (await requestRow('r1')).status
    expect(['expired', 'withdrawn']).toContain(final)
    // Exactly one of them changed the request.
    expect(entries).toHaveLength(1)
    expect((entries[0].after as { status: string }).status).toBe(final)
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true)
  })
})

// Production runs in UTC; the business runs in Johannesburg (UTC+2). 23:30 UTC on the 4th is 01:30 SAST on the 5th.
describe('expiry follows Johannesburg calendar days', () => {
  const at = (iso: string) => ctxAs(admin, db, new Date(iso))

  it('"today" is the SAST day: 23:30 UTC already counts as tomorrow', async () => {
    // updated 2026-09-04 (SAST) + 30 days: expires after 2026-10-04.
    await seedRequest({ id: 'r1', status: 'pending', updated: '2026-09-04T08:00:00.000Z', from: '2026-10-20' })
    expect(await expireIfNeeded(at('2026-10-04T21:30:00.000Z'), 'r1')).toBe('pending') // 23:30 SAST on the 4th
    expect(await audits()).toHaveLength(0)
    expect(await expireIfNeeded(at('2026-10-04T23:30:00.000Z'), 'r1')).toBe('expired') // 01:30 SAST on the 5th
    expect(await audits()).toHaveLength(1)
  })

  it("a request last changed in the 00:00-01:59 SAST window counts from SAST's day, not UTC's (no early expiry)", async () => {
    // Changed 2026-09-04T23:30Z = 01:30 SAST on 2026-09-05: expires after 2026-10-05, not after 2026-10-04.
    await seedRequest({ id: 'r1', status: 'pending', updated: '2026-09-04T23:30:00.000Z', from: '2026-10-20' })
    expect(await expireIfNeeded(at('2026-10-04T23:30:00.000Z'), 'r1')).toBe('pending') // the 5th in SAST: the last good day
    expect(await expireIfNeeded(at('2026-10-05T21:30:00.000Z'), 'r1')).toBe('pending') // 23:30 SAST on the 5th
    expect(await audits()).toHaveLength(0)
    expect(await expireIfNeeded(at('2026-10-05T22:30:00.000Z'), 'r1')).toBe('expired') // 00:30 SAST on the 6th
  })

  it('no-show: the window ends with the SAST day', async () => {
    await seedRequest({ id: 'r1', status: 'accepted', from: '2026-09-20', to: '2026-10-04' })
    expect(await expireIfNeeded(at('2026-10-04T21:30:00.000Z'), 'r1')).toBe('accepted')
    expect(await expireIfNeeded(at('2026-10-04T23:30:00.000Z'), 'r1')).toBe('no_show')
  })
})

describe('a decision on an expired request settles it instead', () => {
  const SYSTEM_NAME = 'System (automatic)'
  const expiredPending = (id = 'r1') => seedRequest({ id, status: 'pending', updated: '2026-09-01T08:00:00.000Z', from: '2026-10-10', lines: [['p1', 2]] })
  const expiredCountered = (id = 'r1') =>
    seedRequest({ id, status: 'countered', updated: '2026-09-01T08:00:00.000Z', from: '2026-10-10', lines: [['p1', 2, 1]] })

  async function expectSettled(id: string, p: Promise<unknown>) {
    await expectDataError(p, 409, CHANGED)
    // The expiry itself committed even though the caller got the 409, with the same audit entry expireIfNeeded writes.
    expect((await requestRow(id)).status).toBe('expired')
    const entries = await audits()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ action: 'update', entity_id: id, user_id: null, user_name: SYSTEM_NAME })
    expect((entries[0].after as { status: string }).status).toBe('expired')
    // Reloading shows the truth, and asking again changes nothing more.
    expect(await expireIfNeeded(adminCtx(), id)).toBe('expired')
    expect(await audits()).toHaveLength(1)
  }

  it('approveAsIs', async () => {
    await expiredPending()
    await expectSettled('r1', approveAsIs(adminCtx(), 'r1'))
  })

  it('sendCounter', async () => {
    await expiredPending()
    await expectSettled('r1', sendCounter(adminCtx(), 'r1', { lines: [{ lineId: 'r1-l0', product_id: 'p1', offered_quantity: 1 }], message: 'x' }))
    expect(await offered('r1')).toEqual([['p1', 2]])
  })

  it('acceptCounter', async () => {
    await expiredCountered()
    await expectSettled('r1', acceptCounter(samCtx(), 'r1'))
  })

  it('declineCounter', async () => {
    await expiredCountered()
    await expectSettled('r1', declineCounter(samCtx(), 'r1'))
  })

  it('a request that is not yet due is decided as usual', async () => {
    await seedRequest({ id: 'r1', status: 'pending', updated: '2026-10-01T08:00:00.000Z', from: '2026-10-20' })
    expect((await approveAsIs(adminCtx(), 'r1')).status).toBe('accepted')
    expect(await audits()).toHaveLength(1)
  })
})

// --- Sidebar counts ------------------------------------------------------------------------------------------------

describe('alert counts', () => {
  beforeEach(async () => {
    await seedRequest({ id: 'pend', status: 'pending', updated: '2026-10-01T08:00:00.000Z', from: '2026-10-20' })
    await seedRequest({ id: 'counter', status: 'countered', updated: '2026-10-02T08:00:00.000Z', from: '2026-10-20' })
    await seedRequest({ id: 'acc', status: 'accepted', from: '2026-10-20', to: '2026-10-25' })
    await seedRequest({ id: 'old', status: 'pending', updated: '2026-08-01T08:00:00.000Z', from: '2026-10-20' }) // long expired
    await seedRequest({ id: 'noshow', status: 'accepted', from: '2026-09-01', to: '2026-09-05' })
    await seedRequest({ id: 'gone', status: 'declined' })
    await seedRequest({ id: 'bos', staff_id: 'staff-2', status: 'pending', updated: '2026-10-01T08:00:00.000Z', from: '2026-10-20' })
  })

  it("the admin badge counts pending and countered only (accepted pickups are tracked on the Dashboard), after applying expiry", async () => {
    expect(await loadLoanRequestsAlertCount(adminCtx())).toBe(3) // pend, counter, bos
    expect((await requestRow('old')).status).toBe('expired')
    expect((await requestRow('noshow')).status).toBe('no_show')
    expect((await audits()).every((a) => a.user_id === null)).toBe(true)
    expect(await audits()).toHaveLength(2)
  })

  it("the staff badge counts the caller's own pending, countered and accepted requests", async () => {
    expect(await loadMyRequestsAlertCount(samCtx())).toBe(3) // pend, counter, acc
    expect(await loadMyRequestsAlertCount(boCtx())).toBe(1)
    expect(await loadMyRequestsAlertCount(ctxAs(loner))).toBe(0)
    // Only their own were settled.
    expect((await requestRow('old')).status).toBe('expired')
    expect((await requestRow('noshow')).status).toBe('no_show')
  })
})

// --- Reservation ledger --------------------------------------------------------------------------------------------

describe('reservation ledger', () => {
  beforeEach(async () => {
    await seedRequest({ id: 'a', status: 'accepted', from: '2026-10-10', to: '2026-10-14', lines: [['p1', 2]] })
    await seedRequest({ id: 'b', staff_id: 'staff-2', status: 'pending', from: '2026-10-14', to: '2026-10-16', lines: [['p1', 1]] })
    await seedRequest({ id: 'c', status: 'countered', from: '2026-11-01', to: null, lines: [['p1', 1, 0], ['p2', 1]] })
    await seedRequest({ id: 'd', status: 'declined', from: '2026-10-10', to: '2026-10-14', lines: [['p1', 4]] })
  })

  it('getReservedQuantity: overlap is inclusive, only active statuses count, one request can be left out', async () => {
    expect(await getReservedQuantity(samCtx(), 'p1', '2026-10-14', '2026-10-14')).toBe(3)
    expect(await getReservedQuantity(samCtx(), 'p1', '2026-10-15', '2026-10-20')).toBe(1)
    expect(await getReservedQuantity(samCtx(), 'p1', '2026-10-17', '2026-10-31')).toBe(0)
    expect(await getReservedQuantity(samCtx(), 'p1', '2026-10-14', '2026-10-14', 'a')).toBe(1)
    // The open-ended counter offered 0 of the projector, so it holds nothing; the cable's counts.
    expect(await getReservedQuantity(samCtx(), 'p1', '2027-01-01', '2027-01-02')).toBe(0)
    expect(await getReservedQuantity(samCtx(), 'p2', '2027-01-01', '2027-01-02')).toBe(1)
    await expectDataError(getReservedQuantity(samCtx(), 'p1', 'x', '2026-10-14'), 400)
  })

  it('getReservationHolders names whose and in what state; offered 0 and inactive requests are not holders', async () => {
    const holders = await getReservationHolders(adminCtx(), 'p1', '2026-10-01', '2026-12-31')
    expect(holders).toEqual([
      { requestId: 'a', staffId: 'staff-1', staffName: 'Sam Staff', quantity: 2, fromDate: '2026-10-10', toDate: '2026-10-14', status: 'accepted' },
      { requestId: 'b', staffId: 'staff-2', staffName: 'Bo Rrower', quantity: 1, fromDate: '2026-10-14', toDate: '2026-10-16', status: 'pending' },
    ])
    expect((await getReservationHolders(adminCtx(), 'p1', '2026-10-01', '2026-12-31', ['accepted'])).map((h) => h.requestId)).toEqual(['a'])
    expect(await getReservationHolders(adminCtx(), 'p1', '2026-10-01', '2026-12-31', [])).toEqual([])
    expect((await getReservationHolders(adminCtx(), 'p2', '0001-01-01', '9999-12-31'))[0]).toMatchObject({ requestId: 'c', toDate: null, status: 'countered' })
  })

  it('getReservationIntervals: one pass for many products, open-ended windows resolved, nothing for offered 0', async () => {
    const res = await getReservationIntervals(samCtx(), ['p1', 'p2', 'p3'])
    expect(res).toEqual({
      p1: [
        { fromDate: '2026-10-10', toDate: '2026-10-14', quantity: 2 },
        { fromDate: '2026-10-14', toDate: '2026-10-16', quantity: 1 },
      ],
      p2: [{ fromDate: '2026-11-01', toDate: '9999-12-31', quantity: 1 }],
      p3: [],
    })
    expect(await getReservationIntervals(samCtx(), [])).toEqual({})
  })

  it('findQuantityReductionConflicts refuses a quantity that is not a whole number of zero or more', async () => {
    for (const bad of [Number.NaN, -1, 1.5, Infinity]) {
      await expectDataError(findQuantityReductionConflicts(adminCtx(), 'p1', bad), 400, 'Quantity must be a whole number, zero or more.')
    }
    // Zero is a real answer: everything on the product would be broken.
    expect((await findQuantityReductionConflicts(adminCtx(), 'p1', 0)).map((h) => h.requestId)).toEqual(['a', 'b'])
  })

  it('findQuantityReductionConflicts: only requests whose own window the new quantity would break', async () => {
    // a (2, 10-10..14) overlaps b (1, 10-14..16) on the 14th: 3 units needed there.
    expect((await findQuantityReductionConflicts(adminCtx(), 'p1', 3)).map((h) => h.requestId)).toEqual([])
    expect((await findQuantityReductionConflicts(adminCtx(), 'p1', 2)).map((h) => h.requestId)).toEqual(['a', 'b'])
    // Two requests in different weeks never count against each other.
    await db.delete(loanRequestLines).where(eq(loanRequestLines.request_id, 'b'))
    await db.delete(loanRequests).where(eq(loanRequests.id, 'b'))
    await seedRequest({ id: 'e', status: 'accepted', from: '2026-12-01', to: '2026-12-03', lines: [['p1', 2]] })
    expect(await findQuantityReductionConflicts(adminCtx(), 'p1', 2)).toEqual([])
    expect((await findQuantityReductionConflicts(adminCtx(), 'p1', 1)).map((h) => h.requestId)).toEqual(['a', 'e'])
  })
})

// --- Stock Out uses the same snapshot builder ----------------------------------------------------------------------

describe('fulfilment by Stock Out', () => {
  it('still writes the request update audit through the shared snapshot builder (with the transaction reference)', async () => {
    await db.insert(productBarcodes).values({ barcode: 'P1A', product_id: 'p1', position: 0 })
    await seedRequest({ id: 'r1', status: 'accepted', lines: [['p1', 1]] })
    const res = await recordStockOut(adminCtx(), { staffId: 'staff-1', items: [{ productId: 'p1', quantity: 1, barcodes: ['P1A'] }], linkedRequestId: 'r1' })
    expect(await requestRow('r1')).toMatchObject({ status: 'fulfilled', fulfilled_txn_id: res.id })
    const entry = (await audits()).find((a) => a.entity_type === 'loan_request')
    expect(entry?.after).toMatchObject({ status: 'fulfilled', fulfilled_txn_id: res.id, fulfilled_txn_ref: res.reference_no, line_count: 1, total_qty: 1 })
    // A fulfilled request is never expired or no-showed afterwards.
    expect(await expireIfNeeded(adminCtx(), 'r1')).toBe('fulfilled')
  })
})

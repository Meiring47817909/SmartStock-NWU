import { readFileSync } from 'node:fs'
import path from 'node:path'
import { asc, count, eq, getTableName, is } from 'drizzle-orm'
import { PgTable } from 'drizzle-orm/pg-core'
import { Timestamp } from 'firebase-admin/firestore'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadCaller, type Caller, type Ctx } from '@/server/context'
import { getDb, type Db } from '@/server/db/client'
import * as schema from '@/server/db/schema'
import {
  auditLog,
  categories,
  loanRequestLines,
  loanRequests,
  productBarcodes,
  products,
  profiles,
  returnWaivers,
  sentNotifications,
  settings,
  staff,
  transactionLines,
  transactions,
} from '@/server/db/schema'
import {
  IMPORTED_COLLECTIONS,
  INT4_MAX,
  memorySource,
  readFirestoreSnapshot,
  planImport,
  type FirestoreState,
  type ImportPlan,
} from '@/server/import/mapFirestore'
import { IMPORT_TABLES, ImportRefusedError, newestPlannedTimestamp, runImport } from '@/server/import/runImport'
import { claimNotificationMarker } from '@/lib/server/notificationDelivery'
import { getSettingsRow } from '@/server/data/settings'
import { loadDashboard } from '@/server/data/dashboard'
import { listRequests } from '@/server/data/loanRequests'
import { listOutstandingForStaff } from '@/server/data/stock'
import { loadReport } from '@/server/data/reports'
import { listAuditLog } from '@/server/data/auditLog'
import { getProduct } from '@/server/data/catalog'
import { closeTestDb, resetTestDb, TEST_DATABASE_URL } from '../helpers/db'
import { parseCliArgs, checkTarget, emulatorHostProblem, liveEnvProblem, main } from '../../scripts/import-firestore'

// The Firestore -> PostgreSQL importer (Task 17). Every test reads Firestore through an in-memory FirestoreSource built
// from a JSON fixture in the shapes the old app wrote; the database is the real test PostgreSQL.

const FIXTURES = path.resolve(__dirname, 'fixtures')
const load = (name: string): FirestoreState => JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8')).db
const ONE = load('one-per-collection.json')
const one = (): FirestoreState => structuredClone(ONE)
/** one-per-collection plus the history of two products deleted in Firestore (p-gone has a delete audit entry, p-nolog not). */
const withDeleted = (): FirestoreState => {
  const state = one()
  for (const [collection, docs] of Object.entries(load('deleted-products.json'))) Object.assign((state[collection] ??= {}), structuredClone(docs))
  return state
}
const DEFAULT_LOCATION = 'NWU - Potchefstroom, Building G4, Room 28'
const planOf = (state: FirestoreState) => planImport(memorySource(state), { now: new Date('2026-10-04T12:00:00.000Z') })

let db: Db

async function tableCounts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const [name, table] of Object.entries(IMPORT_TABLES)) {
    const [row] = await db.select({ n: count() }).from(table)
    out[name] = row.n
  }
  return out
}
const allZero = Object.fromEntries(Object.keys(IMPORT_TABLES).map((k) => [k, 0]))
const problemTexts = (plan: ImportPlan) => plan.problems.map((p) => `${p.collection}/${p.id}: ${p.problem}`)

beforeAll(async () => {
  db = await resetTestDb()
})

afterAll(async () => {
  await closeTestDb()
})

describe('planImport + runImport: one record per collection', () => {
  let plan: ImportPlan

  beforeAll(async () => {
    db = await resetTestDb()
    plan = await planOf(one())
    await runImport(db, plan, { replace: false })
  })

  it('plans with no problems', () => {
    expect(problemTexts(plan)).toEqual([])
  })

  it('keeps every Firestore id verbatim and copies every field', async () => {
    expect(await db.select().from(profiles)).toEqual([
      { uid: 'admin-uid', full_name: 'Ada Admin', role: 'admin', created_at: new Date('2026-09-01T08:00:00.000Z') },
    ])
    expect(await db.select().from(categories)).toEqual([
      { id: 'c1', name: 'Cables & Adapters', description: 'USB, HDMI, DisplayPort', created_at: new Date('2026-09-01T10:00:00.000Z') },
    ])
    const [p1] = await db.select().from(products).where(eq(products.id, 'p1'))
    expect(p1).toEqual({
      id: 'p1', category_id: 'c1', category_name: 'Cables & Adapters', name: 'HDMI Cable 2m', description: 'Braided',
      quantity_on_hand: 7, reorder_threshold: 2, available: true, location: 'Building G4, Room 28',
      lend_from: '2026-10-01', lend_to: '2026-12-31', lending_interval: 'week_2', images: ['products/p1/photo-1.jpg'],
      created_at: new Date('2026-09-01T11:00:00.000Z'), updated_at: new Date('2026-09-05T11:00:00.000Z'),
    })
    const [p2] = await db.select().from(products).where(eq(products.id, 'p2'))
    expect(p2).toMatchObject({ category_id: null, lending_interval: null, images: [], available: false, lend_from: null })
    const [s1] = await db.select().from(staff).where(eq(staff.id, 's1'))
    expect(s1).toEqual({
      id: 's1', name: 'Sam', surname: 'Staff', full_name: 'Sam Staff', email: 'sam.staff@gmail.com', department: 'Biological Sciences',
      card_uid: '04A1B2C3', is_active: true, uid: 'sam-uid', is_admin_account: false,
      created_at: new Date('2026-09-01T09:00:00.000Z'), updated_at: new Date('2026-09-03T09:00:00.000Z'),
    })
    const [out] = await db.select().from(transactions).where(eq(transactions.id, 'z-out'))
    expect(out).toEqual({
      id: 'z-out', transaction_type: 'OUT', reference_no: 'TXN-OUT00001', staff_id: 's1', staff_name: 'Sam Staff',
      user_id: 'admin-uid', operator_name: 'Ada Admin', notes: null, return_date: null, linked_txn_id: null, manual_override: false,
      lend_from: '2026-09-20', lend_to: '2026-09-27', linked_request_id: 'r1', linked_request_ref: 'LR-AAAA1111',
      created_at: new Date('2026-09-20T08:00:00.000Z'),
    })
    const [ret] = await db.select().from(transactions).where(eq(transactions.id, 'a-return'))
    expect(ret).toMatchObject({ linked_txn_id: 'z-out', manual_override: true, return_date: '2026-09-25' })
    // A Stock In document never had the field at all: it stays absent (null), not false.
    const [stockIn] = await db.select().from(transactions).where(eq(transactions.id, 'm-in'))
    expect(stockIn.manual_override).toBeNull()
    const [lr] = await db.select().from(transactionLines).where(eq(transactionLines.id, 'l-r'))
    expect(lr).toEqual({
      id: 'l-r', transaction_id: 'a-return', product_id: 'p1', product_name: 'HDMI Cable 2m', barcode: 'P1-NEW', issued_barcode: 'P1-SECOND',
      line_no: 0, quantity: 1, unit_cost: 0, created_at: new Date('2026-09-25T08:00:00.000Z'),
    })
    const [li] = await db.select().from(transactionLines).where(eq(transactionLines.id, 'l-i'))
    expect(li.unit_cost).toBe(12.5)
    expect(await db.select().from(returnWaivers)).toEqual([
      {
        id: 'w1', transaction_id: 'z-out', product_id: 'p2', product_name: 'Old Projector', staff_id: 's1', staff_name: 'Sam Staff', quantity: 1,
        reason: null, created_at: new Date('2026-09-26T08:00:00.000Z'), resolved_by_uid: 'admin-uid', resolved_by_name: 'Ada Admin',
      },
    ])
    expect(await db.select().from(loanRequests)).toEqual([
      {
        id: 'r1', reference_no: 'LR-AAAA1111', staff_id: 's1', staff_name: 'Sam Staff', status: 'fulfilled', message: 'For the field trip',
        admin_message: null, from_date: '2026-09-20', to_date: '2026-09-27', original_from_date: '2026-09-19', original_to_date: '2026-09-26',
        fulfilled_txn_id: 'z-out', created_at: new Date('2026-09-18T08:00:00.000Z'), updated_at: new Date('2026-09-20T08:00:00.000Z'),
      },
    ])
    expect(await db.select().from(auditLog)).toEqual([
      {
        id: 'a1', user_id: 'admin-uid', user_name: 'Ada Admin', action: 'create', entity_type: 'transaction', entity_id: 'z-out', before: null,
        after: ONE.audit_log.a1.after, created_at: new Date('2026-09-20T08:00:00.002Z'),
      },
    ])
  })

  it('turns barcodes[] into product_barcodes rows in their saved order, and a legacy single `barcode` into one row at position 0', async () => {
    const rows = await db.select().from(productBarcodes).orderBy(asc(productBarcodes.product_id), asc(productBarcodes.position))
    expect(rows).toEqual([
      { barcode: 'P1-PRIMARY', product_id: 'p1', position: 0 },
      { barcode: 'P1-SECOND', product_id: 'p1', position: 1 },
      { barcode: 'P2-LEGACY', product_id: 'p2', position: 0 },
    ])
    // and the app reads them back as the product's barcodes
    const admin: Caller = { uid: 'admin-uid', name: 'Ada Admin', role: 'admin', staffId: 's-admin' }
    const p2 = await getProduct({ db, caller: admin, now: () => new Date() }, 'p2')
    expect(p2?.barcodes).toEqual(['P2-LEGACY'])
  })

  it("fills line_no with each parent's scan / cart order: created_at, then document id", async () => {
    const lines = await db.select({ id: transactionLines.id, n: transactionLines.line_no }).from(transactionLines).where(eq(transactionLines.transaction_id, 'z-out'))
    // l-z was scanned first (earlier created_at); l-x and l-y share a timestamp, so the id decides.
    expect(Object.fromEntries(lines.map((l) => [l.id, l.n]))).toEqual({ 'l-z': 0, 'l-x': 1, 'l-y': 2 })
    const cart = await db.select({ id: loanRequestLines.id, n: loanRequestLines.line_no }).from(loanRequestLines)
    expect(Object.fromEntries(cart.map((l) => [l.id, l.n]))).toEqual({ la: 0, lb: 1 })
  })

  it('copies settings/notifications to the settings key the app reads, and the sent markers so mails are not sent twice', async () => {
    const row = await getSettingsRow(db, 'notifications')
    expect(row).toEqual({
      stock_out_confirmation: false,
      low_stock_alert: true,
      admin_notification_email: 'ada.admin@nwu.ac.za',
      system_from_email: null,
      updated_by_uid: 'admin-uid',
      updated_by_name: 'Ada Admin',
    })
    const [stored] = await db.select().from(settings)
    expect(stored.updated_at).toEqual(new Date('2026-09-02T08:00:00.000Z'))
    expect(await db.select().from(sentNotifications)).toEqual([
      { key: 'stock_out_confirmation__z-out', toggle: 'stock_out_confirmation', entity_id: 'z-out', created_at: new Date('2026-09-20T08:00:05.000Z') },
    ])
    // The delivery code's own claim sees the imported marker: this mail counts as already sent.
    expect(await claimNotificationMarker(db, 'stock_out_confirmation__z-out', 'stock_out_confirmation')).toBe(false)
  })

  it('keeps logins and their roles: the profile makes the administrator an admin, staff.uid links each login to its record', async () => {
    expect(await loadCaller(db, 'admin-uid')).toMatchObject({ uid: 'admin-uid', name: 'Ada Admin', role: 'admin', staffId: 's-admin' })
    expect(await loadCaller(db, 'sam-uid')).toMatchObject({ uid: 'sam-uid', role: 'staff', staffId: 's1' })
  })

  it('resolves the circular links: the request points at its Stock Out and the Stock Out at its request', async () => {
    const [r1] = await db.select().from(loanRequests)
    const [out] = await db.select().from(transactions).where(eq(transactions.id, 'z-out'))
    expect(r1.fulfilled_txn_id).toBe('z-out')
    expect(out.linked_request_id).toBe('r1')
  })

  it('copies quantity_on_hand as stored (no recomputation from the ledger)', async () => {
    const [p1] = await db.select().from(products).where(eq(products.id, 'p1'))
    expect(p1.quantity_on_hand).toBe(7)
  })

  it('returns the planned row counts', () => {
    expect(Object.fromEntries(Object.entries(plan.rows).map(([k, v]) => [k, v.length]))).toEqual({
      profiles: 1, categories: 1, products: 2, product_barcodes: 3, staff: 2, loan_requests: 1, transactions: 3,
      transaction_lines: 5, return_waivers: 1, loan_request_lines: 2, audit_log: 1, settings: 1, sent_notifications: 1,
    })
  })
})

describe('problems block the write', () => {
  beforeEach(async () => {
    db = await resetTestDb()
  })

  it('a line pointing at a missing product is a problem, and runImport writes nothing until it is fixed', async () => {
    const state = one()
    state.transaction_lines['l-x'].product_id = 'deleted-product'
    const plan = await planOf(state)
    expect(problemTexts(plan)).toEqual([
      'products/deleted-product: missing product ("HDMI Cable 2m") is still referenced by 1 transaction line, 0 loan request lines and 0 waivers; ' +
        'there is no delete entry for it in the audit log, so it cannot be restored automatically',
    ])
    await expect(runImport(db, plan, { replace: false })).rejects.toThrow(ImportRefusedError)
    await expect(runImport(db, plan, { replace: true, confirmDatabase: 'smartstock_test' })).rejects.toThrow(/1 problem/)
    expect(await tableCounts()).toEqual(allZero)
    // fixed in Firestore -> imports
    state.transaction_lines['l-x'].product_id = 'p1'
    const fixed = await planOf(state)
    expect(fixed.problems).toEqual([])
    await runImport(db, fixed, { replace: false })
    expect((await tableCounts()).transaction_lines).toBe(5)
  })

  it('reports every dangling reference, not just product ids', async () => {
    const state = one()
    state.products.p1.category_id = 'gone-cat'
    state.transactions['a-return'].linked_txn_id = 'gone-out'
    state.transactions['z-out'].staff_id = 'gone-staff'
    state.loan_requests.r1.fulfilled_txn_id = 'gone-txn'
    state.loan_request_lines.la.request_id = 'gone-request'
    state.return_waivers.w1.transaction_id = 'gone-txn2'
    const plan = await planOf(state)
    expect(problemTexts(plan).sort()).toEqual([
      'loan_request_lines/la: request_id "gone-request" is not in loan_requests',
      'loan_requests/r1: fulfilled_txn_id "gone-txn" is not in transactions',
      'products/p1: category_id "gone-cat" is not in categories',
      'return_waivers/w1: transaction_id "gone-txn2" is not in transactions',
      'transactions/a-return: linked_txn_id "gone-out" is not in transactions',
      'transactions/z-out: staff_id "gone-staff" is not in staff',
    ])
  })

  it.each([
    ['loan_requests', 'r1', 'status', 'on_hold'],
    ['transactions', 'z-out', 'transaction_type', 'TRANSFER'],
    ['products', 'p1', 'lending_interval', 'week_5'],
    ['audit_log', 'a1', 'action', 'archive'],
    ['audit_log', 'a1', 'entity_type', 'invoice'],
    ['profiles', 'admin-uid', 'role', 'superuser'],
  ])('an unknown %s.%s value is a problem', async (collection, id, field, value) => {
    const state = one()
    state[collection][id][field] = value
    const plan = await planOf(state)
    expect(plan.problems).toHaveLength(1)
    expect(plan.problems[0]).toMatchObject({ collection, id })
    expect(plan.problems[0].problem).toContain(`${field} "${value}" is not one of`)
  })

  it('a barcode on two products is a problem (product_barcodes allows one product per barcode)', async () => {
    const state = one()
    state.products.p2.barcode = 'P1-SECOND'
    const plan = await planOf(state)
    expect(problemTexts(plan)).toEqual(['products/p2: barcode "P1-SECOND" is also on product p1 (HDMI Cable 2m)'])
  })

  it('a duplicate category name is a problem (categories.name is unique; Firestore had no such rule)', async () => {
    const state = one()
    state.categories.c2 = { name: 'Cables & Adapters', description: null, created_at: '2026-09-02T10:00:00.000Z' }
    const plan = await planOf(state)
    expect(problemTexts(plan)).toEqual(['categories/c2: name "Cables & Adapters" is also used by category c1'])
  })

  it('duplicate staff email (any case), card, login uid and duplicate references are problems', async () => {
    const state = one()
    state.staff.s2 = { ...state.staff.s1, email: 'SAM.Staff@gmail.com', created_at: '2026-09-02T09:00:00.000Z', updated_at: '2026-09-02T09:00:00.000Z' }
    state.transactions['m-in'].reference_no = 'TXN-OUT00001'
    state.loan_requests.r2 = { ...state.loan_requests.r1, fulfilled_txn_id: null, status: 'declined' }
    const plan = await planOf(state)
    expect(problemTexts(plan).sort()).toEqual([
      'loan_requests/r2: reference_no "LR-AAAA1111" is also used by loan request r1',
      'staff/s2: card_uid "04A1B2C3" is also used by staff s1',
      'staff/s2: email "SAM.Staff@gmail.com" is also used by staff s1 (emails are unique in any letter case)',
      'staff/s2: uid "sam-uid" is also used by staff s1',
      // the first document in id order keeps the value; every later one is the problem
      'transactions/z-out: reference_no "TXN-OUT00001" is also used by transaction m-in',
    ])
  })

  it('missing required fields, wrong types and out-of-range numbers are problems', async () => {
    const state = one()
    delete state.staff.s1.surname
    state.products.p1.quantity_on_hand = -1
    state.transaction_lines['l-i'].quantity = 0
    state.loan_request_lines.lb.requested_quantity = 1.5
    state.categories.c1.name = 42
    delete state.loan_requests.r1.staff_name
    state.audit_log.a1.after = 'not an object'
    const plan = await planOf(state)
    expect(problemTexts(plan).sort()).toEqual([
      'audit_log/a1: after should be a map or null, found string',
      'categories/c1: name should be text, found number',
      'loan_request_lines/lb: requested_quantity should be a whole number, found 1.5',
      'loan_requests/r1: staff_name is missing',
      'products/p1: quantity_on_hand should be at least 0, found -1',
      'staff/s1: surname is missing',
      'transaction_lines/l-i: quantity should be at least 1, found 0',
    ])
  })

  it('a NUL character in any text or JSON value, and a whole number above the int4 range, are problems (not database errors)', async () => {
    const state = one()
    state.categories.c1.description = 'USB\u0000HDMI'
    state.products.p1.quantity_on_hand = INT4_MAX + 1
    state.products.p1.barcodes = ['P1-PRIMARY', 'P1\u0000X']
    state.audit_log.a1.after = { note: 'x\u0000y' }
    state.settings.notifications.admin_notification_email = 'a\u0000@b.c'
    state.transaction_lines['l-i'].quantity = 2 ** 31
    state.staff.s1.surname = 'St\u0000aff'
    const plan = await planOf(state)
    expect(problemTexts(plan).sort()).toEqual([
      'audit_log/a1: after.note contains a NUL character, which PostgreSQL cannot store',
      'categories/c1: description contains a NUL character, which PostgreSQL cannot store',
      'products/p1: barcodes contains a NUL character, which PostgreSQL cannot store',
      'products/p1: quantity_on_hand is 2147483648, more than the column can hold (2147483647)',
      'settings/notifications: value.admin_notification_email contains a NUL character, which PostgreSQL cannot store',
      'staff/s1: surname contains a NUL character, which PostgreSQL cannot store',
      'transaction_lines/l-i: quantity is 2147483648, more than the column can hold (2147483647)',
    ])
    expect(INT4_MAX).toBe(2 ** 31 - 1)
  })

  it('barcodes are trimmed (as the app saves them) and a NUL in the legacy single barcode is a problem', async () => {
    const state = one()
    state.products.p1.barcodes = [' P1-PRIMARY', 'P1-SECOND ', 'P1-PRIMARY']
    state.products.p2.barcode = '  P2-LEGACY\t'
    let plan = await planOf(state)
    expect(plan.problems).toEqual([])
    expect(plan.rows.product_barcodes).toEqual([
      { barcode: 'P1-PRIMARY', product_id: 'p1', position: 0 },
      { barcode: 'P1-SECOND', product_id: 'p1', position: 1 },
      { barcode: 'P2-LEGACY', product_id: 'p2', position: 0 },
    ])
    expect(plan.warnings).toEqual(
      expect.arrayContaining([
        { collection: 'products', id: 'p1', problem: 'barcode " P1-PRIMARY" had spaces around it; imported as "P1-PRIMARY"' },
        { collection: 'products', id: 'p1', problem: 'barcode "P1-PRIMARY" is listed twice on this product; imported once' },
        { collection: 'products', id: 'p2', problem: 'barcode "  P2-LEGACY\\t" had spaces around it; imported as "P2-LEGACY"' },
      ]),
    )
    // A legacy barcode equal to a listed one once trimmed is not reported as ignored.
    state.products.p1.barcode = ' P1-SECOND'
    plan = await planOf(state)
    expect(plan.warnings.filter((w) => w.problem.startsWith('legacy barcode'))).toEqual([])

    const nul = one()
    nul.products.p2.barcode = 'P2\u0000LEGACY'
    plan = await planOf(nul)
    expect(problemTexts(plan)).toEqual(['products/p2: barcode contains a NUL character, which PostgreSQL cannot store'])
    expect(plan.rows.product_barcodes.filter((b) => b.product_id === 'p2')).toEqual([])
  })

  it("legacy documents lacking a NOT NULL field get the old app's reading of it, with a warning", async () => {
    const state = one()
    for (const f of ['location', 'available', 'quantity_on_hand', 'reorder_threshold', 'images']) delete state.products.p1[f]
    delete state.profiles['admin-uid'].role
    delete state.staff.s1.is_active
    delete state.loan_requests.r1.original_from_date
    delete state.loan_request_lines.lb.requested_quantity
    delete state.loan_request_lines.lb.offered_quantity
    delete state.transaction_lines['l-x'].unit_cost
    delete state.staff['s-admin'].updated_at
    delete state.products.p2.updated_at
    const plan = await planOf(state)
    expect(plan.problems).toEqual([])
    expect(plan.rows.products.find((p) => p.id === 'p1')).toMatchObject({
      location: DEFAULT_LOCATION, available: true, quantity_on_hand: 0, reorder_threshold: 0, images: [],
    })
    expect(plan.rows.profiles[0].role).toBe('staff')
    expect(plan.rows.staff.find((x) => x.id === 's1')?.is_active).toBe(false)
    expect(plan.rows.loan_requests[0].original_from_date).toBe('2026-09-20')
    expect(plan.rows.loan_request_lines.find((l) => l.id === 'lb')).toMatchObject({ requested_quantity: 0, offered_quantity: 0 })
    const said = (collection: string, id: string, field: string, value: unknown) =>
      expect(plan.warnings).toContainEqual({ collection, id, problem: `${field} is missing; imported as ${JSON.stringify(value)}, as the old app read it` })
    said('products', 'p1', 'location', DEFAULT_LOCATION)
    said('products', 'p1', 'available', true)
    said('products', 'p1', 'quantity_on_hand', 0)
    said('products', 'p1', 'reorder_threshold', 0)
    said('products', 'p1', 'images', [])
    said('profiles', 'admin-uid', 'role', 'staff')
    said('staff', 's1', 'is_active', false)
    said('loan_requests', 'r1', 'original_from_date', '2026-09-20')
    said('loan_request_lines', 'lb', 'requested_quantity', 0)
    said('loan_request_lines', 'lb', 'offered_quantity', 0)
    // safe defaults that are not old readings: unit_cost 0 (what every writer stored), updated_at = created_at
    expect(plan.rows.transaction_lines.find((l) => l.id === 'l-x')?.unit_cost).toBe(0)
    expect(plan.rows.staff.find((x) => x.id === 's-admin')?.updated_at).toEqual(new Date('2026-09-01T08:00:00.000Z'))
    expect(plan.rows.products.find((p) => p.id === 'p2')?.updated_at).toEqual(new Date('2026-08-01T11:00:00.000Z'))
    expect(plan.warnings).toContainEqual({ collection: 'transaction_lines', id: 'l-x', problem: 'unit_cost is missing; imported as 0 (what every writer stored, and the column default)' })
    expect(plan.warnings).toContainEqual({ collection: 'staff', id: 's-admin', problem: 'updated_at is missing; imported as 2026-09-01T08:00:00.000Z (its created_at: the truthful lower bound)' })
    expect(plan.warnings).toContainEqual({ collection: 'products', id: 'p2', problem: 'updated_at is missing; imported as 2026-08-01T11:00:00.000Z (its created_at: the truthful lower bound)' })
    // and is_admin_account, absent on every ordinary staff record by design, is read as false without a warning
    expect(plan.rows.staff.find((x) => x.id === 's1')?.is_admin_account).toBe(false)
    expect(plan.warnings.some((w) => w.problem.includes('is_admin_account'))).toBe(false)
  })

  it('a loop of linked transactions is a problem (it can never be inserted)', async () => {
    const state = one()
    state.transactions['z-out'].linked_txn_id = 'a-return'
    const plan = await planOf(state)
    expect(problemTexts(plan)).toEqual([
      'transactions/a-return: linked_txn_id makes a loop (a-return -> z-out -> a-return)',
    ])
  })
})

describe('timestamps and dates', () => {
  it('accepts Admin SDK Timestamps, Dates, {_seconds,_nanoseconds}, {seconds,nanoseconds} and ISO strings with a zone', async () => {
    const state = one()
    const instant = new Date('2026-09-01T10:00:00.123Z')
    const secs = Math.floor(instant.getTime() / 1000)
    const nanos = 123_000_000
    state.categories.c1.created_at = new Timestamp(secs, nanos)
    state.categories.c2 = { name: 'A', description: null, created_at: { _seconds: secs, _nanoseconds: nanos } }
    state.categories.c3 = { name: 'B', description: null, created_at: { seconds: secs, nanoseconds: nanos } }
    state.categories.c4 = { name: 'C', description: null, created_at: instant }
    state.categories.c5 = { name: 'D', description: null, created_at: '2026-09-01T12:00:00.123+02:00' }
    const plan = await planOf(state)
    expect(plan.problems).toEqual([])
    for (const row of plan.rows.categories) expect((row.created_at as Date).toISOString(), row.id).toBe(instant.toISOString())
  })

  it.each([
    ['yesterday'],
    ['2026-09-01'],
    ['2026-09-01T10:00:00'], // no zone: ambiguous
    ['2026-02-30T10:00:00Z'], // not a real day (a JS Date would roll it to March 2nd)
    [1759312800],
    [{ seconds: 'soon' }],
    [null],
  ])('an unparseable timestamp (%j) is a problem', async (value) => {
    const state = one()
    state.categories.c1.created_at = value
    const plan = await planOf(state)
    expect(plan.problems).toHaveLength(1)
    expect(plan.problems[0]).toMatchObject({ collection: 'categories', id: 'c1' })
    expect(plan.problems[0].problem).toMatch(/^created_at (is missing|is not a timestamp)/)
  })

  it('date-only fields stay YYYY-MM-DD strings, with no time-zone shift, and come back the same through the app', async () => {
    db = await resetTestDb()
    const state = one()
    state.products.p1.lend_from = '2026-01-01'
    state.products.p1.lend_to = '2026-12-31'
    const plan = await planOf(state)
    expect(plan.rows.products.find((p) => p.id === 'p1')).toMatchObject({ lend_from: '2026-01-01', lend_to: '2026-12-31' })
    await runImport(db, plan, { replace: false })
    const admin: Caller = { uid: 'admin-uid', name: 'Ada Admin', role: 'admin', staffId: 's-admin' }
    const p1 = await getProduct({ db, caller: admin, now: () => new Date() }, 'p1')
    expect(p1).toMatchObject({ lend_from: '2026-01-01', lend_to: '2026-12-31' })
    const [r1] = await db.select().from(loanRequests)
    expect([r1.from_date, r1.to_date, r1.original_from_date, r1.original_to_date]).toEqual(['2026-09-20', '2026-09-27', '2026-09-19', '2026-09-26'])
  })

  it.each([['2026-9-1'], ['2026-02-30'], ['2026-10-01T00:00:00.000Z'], [20261001]])('a bad date-only value (%j) is a problem', async (value) => {
    const state = one()
    state.loan_requests.r1.from_date = value
    const plan = await planOf(state)
    expect(problemTexts(plan)).toEqual([`loan_requests/r1: from_date is not a YYYY-MM-DD date (${JSON.stringify(value)})`])
  })
})

describe('what is reported but not imported', () => {
  it('reports collections the app no longer has, and imports every settings document under its own key', async () => {
    const state = one()
    state.old_reports = { x1: { a: 1 }, x2: { a: 2 } }
    state.settings.branding = { colour: 'purple', updated_at: '2026-09-03T08:00:00.000Z' }
    state.settings.legacy_flags = { beta: true }
    const plan = await planOf(state)
    expect(plan.problems).toEqual([])
    expect(plan.notImported).toEqual([{ collection: 'old_reports', documents: 2 }])
    expect(plan.rows.settings.map((x) => x.key)).toEqual(['branding', 'legacy_flags', 'notifications'])
    expect(plan.rows.settings[0]).toEqual({ key: 'branding', value: { colour: 'purple' }, updated_at: new Date('2026-09-03T08:00:00.000Z') })
    expect(plan.rows.settings[1]).toEqual({ key: 'legacy_flags', value: { beta: true }, updated_at: new Date('2026-10-04T12:00:00.000Z') })
    expect(plan.warnings).toContainEqual({ collection: 'settings', id: 'legacy_flags', problem: 'updated_at is missing; set to the time of the import' })
    db = await resetTestDb()
    await runImport(db, plan, { replace: false })
    expect(await getSettingsRow(db, 'branding')).toEqual({ colour: 'purple' })
  })

  it('warns once per field the app has no column for, and about the legacy barcode it supersedes', async () => {
    const state = one()
    state.staff.s1.phone = '012 345 6789'
    state.staff['s-admin'].phone = '012 999 0000'
    state.products.p1.barcode = 'OLD-P1'
    const plan = await planOf(state)
    expect(plan.problems).toEqual([])
    expect(plan.warnings).toContainEqual({ collection: 'staff', id: '*', problem: 'field "phone" (2 documents) has no column; not imported' })
    expect(plan.warnings).toContainEqual({
      collection: 'products', id: 'p1',
      problem: 'legacy barcode "OLD-P1" ignored: the product has barcodes[], which the old app showed and saved instead',
    })
  })

  it('fills a transaction line written before lines carried product_name with the product name, and says so', async () => {
    const state = one()
    delete state.transaction_lines['l-i'].product_name
    const plan = await planOf(state)
    expect(plan.problems).toEqual([])
    expect(plan.rows.transaction_lines.find((l) => l.id === 'l-i')?.product_name).toBe('HDMI Cable 2m')
    expect(plan.warnings).toContainEqual({ collection: 'transaction_lines', id: 'l-i', problem: `product_name was missing; filled with the product's name "HDMI Cable 2m"` })
  })

  it('imports a blank email / card / uid as none (two blanks would collide on the unique columns), with a warning', async () => {
    const state = one()
    state.staff.s1.email = ''
    state.staff.s1.card_uid = '  '
    state.staff['s-admin'].email = ''
    const plan = await planOf(state)
    expect(plan.problems).toEqual([])
    expect(plan.rows.staff.map((s) => [s.id, s.email, s.card_uid])).toEqual([['s-admin', null, null], ['s1', null, null]])
    expect(plan.warnings).toContainEqual({ collection: 'staff', id: 's1', problem: 'email was blank; imported as none' })
  })

  it('stores audit payloads as JSON: nested Timestamps become ISO strings, anything JSON cannot hold is a problem', async () => {
    const state = one()
    state.audit_log.a1.after = { when: new Timestamp(1758355200, 0), nested: { at: { _seconds: 1758355200, _nanoseconds: 5_000_000 } } }
    const plan = await planOf(state)
    expect(plan.problems).toEqual([])
    expect(plan.rows.audit_log[0].after).toEqual({ when: '2025-09-20T08:00:00.000Z', nested: { at: '2025-09-20T08:00:00.005Z' } })
    class DocumentReference { path = 'staff/s1' }
    state.audit_log.a1.after = { staff: new DocumentReference() }
    state.audit_log.a1.before = { ratio: Number.NaN }
    // (not memorySource: its structuredClone would turn the class instance into a plain map; the Admin SDK hands over the
    // real instance)
    const uncloned = { list: async (c: string) => Object.entries(state[c] ?? {}).map(([id, data]) => ({ id, data })) }
    const bad = await planImport(uncloned, { now: new Date() })
    expect(problemTexts(bad).sort()).toEqual([
      'audit_log/a1: after.staff holds a DocumentReference value, which cannot be stored as JSON',
      'audit_log/a1: before.ratio is NaN, which JSON cannot hold',
    ])
  })

  it('says when a profile stores an id different from its document id (the document id is the uid)', async () => {
    const state = one()
    state.profiles['admin-uid'].id = 'someone-else'
    const plan = await planOf(state)
    expect(plan.problems).toEqual([])
    expect(plan.rows.profiles[0].uid).toBe('admin-uid')
    expect(plan.warnings).toContainEqual({ collection: 'profiles', id: 'admin-uid', problem: 'id field "someone-else" differs from the document id; the document id is the uid' })
  })

  it('works with a source that cannot list collections (it then only reads the known ones)', async () => {
    const { listCollections: _unused, ...listOnly } = memorySource(one())
    void _unused
    const plan = await planImport(listOnly, { now: new Date() })
    expect(plan.problems).toEqual([])
    expect(plan.notImported).toEqual([])
    expect(plan.rows.transactions).toHaveLength(3)
  })

  it('reads live Firestore in ONE read-only transaction, through nothing but listCollections, collection(), tx.get() and count()', async () => {
    const calls: string[] = []
    const transactions: unknown[] = []
    let inTransaction = false
    const state: FirestoreState = { ...one(), old_reports: { x1: { a: 1 }, x2: { a: 2 } }, empty_parent: {} }
    const forbid = (where: string) => (_t: object, prop: string | symbol) => {
      throw new Error(`write-capable or unexpected access ${where}.${String(prop)}`)
    }
    const allow = <T extends object>(where: string, allowed: T) =>
      new Proxy(allowed, { get: (t, prop) => (prop in t ? t[prop as keyof T] : forbid(where)(t, prop)) })
    const fakeFirestore = allow('firestore', {
      listCollections: async () => {
        calls.push('listCollections')
        return Object.keys(state).map((id) => ({ id }))
      },
      collection: (name: string) =>
        allow(`collection(${name})`, {
          name,
          // count() aggregate: the number only, never the documents
          count: () =>
            allow(`collection(${name}).count()`, {
              get: async () => {
                calls.push(`count ${name}${inTransaction ? ' (inside the transaction)' : ''}`)
                const n = Object.keys(state[name] ?? {}).length
                return { data: () => ({ count: n }) }
              },
            }),
        } as never),
      runTransaction: async (fn: (tx: unknown) => Promise<unknown>, options: unknown) => {
        transactions.push(options)
        const tx = allow('tx', {
          get: async (ref: { name: string }) => {
            calls.push(`tx.get ${ref.name}`)
            return { docs: Object.entries(state[ref.name] ?? {}).map(([id, data]) => ({ id, data: () => structuredClone(data) })) }
          },
        })
        inTransaction = true
        try {
          return await fn(tx)
        } finally {
          inTransaction = false
        }
      },
    })
    const source = await readFirestoreSnapshot(fakeFirestore as never)
    const plan = await planImport(source, { now: new Date() })
    expect(transactions).toEqual([{ readOnly: true }])
    expect(calls[0]).toBe('listCollections')
    expect(calls).toContain('tx.get transactions')
    // The app's collections are read in the transaction; any other collection is only counted, after it.
    expect(calls.filter((c) => c.startsWith('tx.get ')).sort()).toEqual([...IMPORTED_COLLECTIONS].map((c) => `tx.get ${c}`).sort())
    expect(calls.filter((c) => c.startsWith('count ')).sort()).toEqual(['count empty_parent', 'count old_reports'])
    expect(calls).not.toContain('tx.get old_reports')
    expect(plan.problems).toEqual([])
    expect(plan.rows.transactions).toHaveLength(3)
    expect(plan.notImported).toEqual([{ collection: 'old_reports', documents: 2 }])
  })
})

describe('deleted products that history still points at', () => {
  it('are grouped into one problem per product id, naming the frozen names, the counts and the delete entry', async () => {
    const plan = await planOf(withDeleted())
    expect(problemTexts(plan)).toEqual([
      'products/p-gone: missing product ("Cordless Drill") is still referenced by 1 transaction line, 1 loan request line and 1 waiver; ' +
        'deleted 2026-09-28T08:00:00.000Z by Ada Admin (audit entry a-del-gone); --restore-deleted-products would restore it as an unavailable product with 0 in stock',
      'products/p-nolog: missing product ("Mystery Cable") is still referenced by 1 transaction line, 1 loan request line and 0 waivers; ' +
        'there is no delete entry for it in the audit log, so it cannot be restored automatically',
    ])
    expect(plan.missingProducts).toEqual([
      { id: 'p-gone', names: ['Cordless Drill'], transactionLines: 1, requestLines: 1, waivers: 1, deleted: { auditId: 'a-del-gone', at: '2026-09-28T08:00:00.000Z', by: 'Ada Admin' }, restored: false },
      { id: 'p-nolog', names: ['Mystery Cable'], transactionLines: 1, requestLines: 1, waivers: 0, deleted: null, restored: false },
    ])
    expect(plan.restoredProducts).toEqual([])
  })

  it('--restore-deleted-products rebuilds the one with a delete entry from its snapshot; the one without stays a problem', async () => {
    const plan = await planImport(memorySource(withDeleted()), { now: new Date(), restoreDeletedProducts: true })
    expect(problemTexts(plan)).toEqual([expect.stringMatching(/^products\/p-nolog: missing product \("Mystery Cable"\)/)])
    expect(plan.restoredProducts).toEqual(['p-gone'])
    expect(plan.missingProducts.find((m) => m.id === 'p-gone')?.restored).toBe(true)
    expect(plan.rows.products.find((p) => p.id === 'p-gone')).toEqual({
      id: 'p-gone', category_id: 'c1', category_name: 'Cables & Adapters', name: 'Cordless Drill', description: '18V',
      quantity_on_hand: 0, reorder_threshold: 3, available: false, location: 'Shelf 9', lend_from: null, lend_to: null,
      lending_interval: null, images: [], created_at: new Date('2026-09-28T08:00:00.000Z'), updated_at: new Date('2026-09-28T08:00:00.000Z'),
    })
    // its own barcode comes back; the one another product now owns does not
    expect(plan.rows.product_barcodes.filter((b) => b.product_id === 'p-gone')).toEqual([{ barcode: 'GONE-1', product_id: 'p-gone', position: 0 }])
    expect(plan.warnings).toContainEqual({ collection: 'products', id: 'p-gone', problem: 'barcode "P1-PRIMARY" of the deleted product is now on product p1 (HDMI Cable 2m); not restored' })
    expect(plan.warnings).toContainEqual({
      collection: 'products', id: 'p-gone',
      problem: 'RESTORED from delete audit entry a-del-gone (deleted 2026-09-28T08:00:00.000Z by Ada Admin): "Cordless Drill", unavailable, 0 in stock, no photos',
    })
  })

  it('a restored product whose category no longer exists loses the category name too', async () => {
    const state = withDeleted()
    const del = Object.values(state.audit_log).find((a) => a.entity_id === 'p-gone' && a.action === 'delete')!
    ;(del.before as Record<string, unknown>).category_id = 'c-gone'
    const plan = await planImport(memorySource(state), { now: new Date(), restoreDeletedProducts: true })
    expect(plan.rows.products.find((p) => p.id === 'p-gone')).toMatchObject({ category_id: null, category_name: null })
    expect(plan.warnings).toContainEqual({
      collection: 'products', id: 'p-gone', problem: 'category_id "c-gone" of the deleted product no longer exists; restored without a category',
    })
  })

  it('imports the restored product with its history and writes no audit entry of its own (the ledger stays verbatim)', async () => {
    db = await resetTestDb()
    const state = withDeleted()
    // p-nolog cannot be restored: its history is taken out in Firestore first (the user's call)
    delete state.transaction_lines['l-nolog']
    delete state.loan_request_lines.ld
    const plan = await planImport(memorySource(state), { now: new Date(), restoreDeletedProducts: true })
    expect(plan.problems).toEqual([])
    const counts = await runImport(db, plan, { replace: false })
    expect(counts.products).toBe(3)
    expect(counts.audit_log).toBe(Object.keys(state.audit_log).length)
    const admin: Caller = { uid: 'admin-uid', name: 'Ada Admin', role: 'admin', staffId: 's-admin' }
    expect(await getProduct({ db, caller: admin, now: () => new Date() }, 'p-gone')).toMatchObject({ name: 'Cordless Drill', available: false, quantity_on_hand: 0, barcodes: ['GONE-1'] })
    expect(await db.select({ id: transactionLines.id }).from(transactionLines).where(eq(transactionLines.product_id, 'p-gone'))).toEqual([{ id: 'l-gone-out' }])
  })
})

describe('runImport: one transaction, never into existing data', () => {
  let plan: ImportPlan

  beforeAll(async () => {
    plan = await planOf(one())
  })

  beforeEach(async () => {
    db = await resetTestDb()
  })

  it('covers every app table (so --replace empties them all and the non-empty check sees them all)', () => {
    const schemaTables = (Object.values(schema) as unknown[]).filter((t): t is PgTable => is(t, PgTable)).map((t) => getTableName(t)).sort()
    expect(Object.values(IMPORT_TABLES).map((t) => getTableName(t)).sort()).toEqual(schemaTables)
  })

  it('into a non-empty database without replace it refuses and leaves the database exactly as it was', async () => {
    await db.insert(categories).values({ id: 'existing', name: 'Already here', created_at: new Date('2026-01-01T00:00:00Z') })
    await expect(runImport(db, plan, { replace: false })).rejects.toThrow(ImportRefusedError)
    await expect(runImport(db, plan, { replace: false })).rejects.toThrow(/already has data: categories \(1\)/)
    expect(await tableCounts()).toEqual({ ...allZero, categories: 1 })
    expect(await db.select().from(categories)).toEqual([{ id: 'existing', name: 'Already here', description: null, created_at: new Date('2026-01-01T00:00:00Z') }])
  })

  it('run twice: the second run refuses and changes nothing', async () => {
    await runImport(db, plan, { replace: false })
    const after = await tableCounts()
    await expect(runImport(db, plan, { replace: false })).rejects.toThrow(ImportRefusedError)
    expect(await tableCounts()).toEqual(after)
  })

  it('with replace it empties the app tables first, in the same transaction, and imports', async () => {
    // An earlier (rehearsal) import's row, under an id the plan has: replaced by the plan's version.
    await db.insert(categories).values({ id: 'c1', name: 'Already here', created_at: new Date('2026-01-01T00:00:00Z') })
    const counts = await runImport(db, plan, { replace: true, confirmDatabase: 'smartstock_test' })
    expect(await db.select({ id: categories.id, name: categories.name }).from(categories)).toEqual([{ id: 'c1', name: plan.rows.categories[0].name }])
    expect(counts).toEqual(await tableCounts())
    expect(counts.transactions).toBe(3)
  })

  it('inserts large collections in chunks (more rows than one INSERT can bind)', async () => {
    const state = one()
    for (let i = 0; i < 1201; i++) {
      state.audit_log[`bulk-${String(i).padStart(4, '0')}`] = {
        user_id: 'admin-uid', user_name: 'Ada Admin', action: 'update', entity_type: 'product', entity_id: 'p1',
        before: { quantity_on_hand: i }, after: { quantity_on_hand: i + 1 }, created_at: new Date(Date.UTC(2026, 8, 1) + i * 1000).toISOString(),
      }
    }
    // 300 Stock Outs and 300 Returns whose ids sort BEFORE their Stock Outs, so in id order a Return would land in an
    // earlier INSERT than the Stock Out it points at. (Within one INSERT PostgreSQL checks the self-reference at the end
    // of the statement, so only link order across chunks proves the ordering.)
    for (let i = 0; i < 300; i++) {
      const n = String(i).padStart(3, '0')
      state.transactions[`z-bulk-out-${n}`] = { ...state.transactions['z-out'], reference_no: `TXN-BO${n}`, linked_request_id: null, linked_request_ref: null }
      state.transactions[`a-bulk-ret-${n}`] = { ...state.transactions['a-return'], reference_no: `TXN-BR${n}`, linked_txn_id: `z-bulk-out-${n}`, linked_request_id: null, linked_request_ref: null }
    }
    const big = await planOf(state)
    expect(big.problems).toEqual([])
    const counts = await runImport(db, big, { replace: false })
    expect(counts.audit_log).toBe(1202)
    expect(counts.transactions).toBe(603)
  })

  it('a failing insert mid-way rolls everything back', async () => {
    const broken: ImportPlan = structuredClone(plan)
    // audit_log is inserted near the end; a value its CHECK refuses fails after every table before it was written.
    ;(broken.rows.audit_log[0] as { action: string }).action = 'bogus'
    await expect(runImport(db, broken, { replace: false })).rejects.toThrow()
    expect(await tableCounts()).toEqual(allZero)
  })

  it('a failing insert with replace also restores the data that was there before', async () => {
    await db.insert(categories).values({ id: 'c1', name: 'Already here', created_at: new Date('2026-01-01T00:00:00Z') })
    const broken: ImportPlan = structuredClone(plan)
    ;(broken.rows.audit_log[0] as { action: string }).action = 'bogus'
    await expect(runImport(db, broken, { replace: true, confirmDatabase: 'smartstock_test' })).rejects.toThrow(/audit_log_action_check|Failed query/)
    expect(await tableCounts()).toEqual({ ...allZero, categories: 1 })
    expect(await db.select({ name: categories.name }).from(categories)).toEqual([{ name: 'Already here' }])
  })

  it('replace guard (a): it needs the target database named, and refuses any other name, changing nothing', async () => {
    await runImport(db, plan, { replace: false })
    const before = await tableCounts()
    await expect(runImport(db, plan, { replace: true })).rejects.toThrow('Refusing to replace: the target database is "smartstock_test", and replacing it needs that name confirmed (none was given). Nothing was written.')
    await expect(runImport(db, plan, { replace: true, confirmDatabase: 'smartstock' })).rejects.toThrow(/target database is "smartstock_test".*"smartstock" was given/)
    expect(await tableCounts()).toEqual(before)
    await expect(runImport(db, plan, { replace: true, confirmDatabase: 'smartstock_test' })).resolves.toEqual(before)
  })

  it('replace guard (b): it refuses when the target holds a row whose id is not in the import, changing nothing', async () => {
    await runImport(db, plan, { replace: false })
    // a Stock In saved in PostgreSQL after cut-over, dated before the newest Firestore record (a clock that disagrees)
    await db.insert(transactions).values({ id: 'after-go-live', transaction_type: 'IN', reference_no: 'TXN-NEW00001', created_at: new Date('2026-09-01T09:00:00.000Z') })
    const before = await tableCounts()
    await expect(runImport(db, plan, { replace: true, confirmDatabase: 'smartstock_test' })).rejects.toThrow(
      'Refusing to replace: transactions has 1 row whose id is not in the import ("after-go-live"). ' +
        'Rows like that exist only in PostgreSQL (entered after cut-over?) and would be lost. Nothing was written.',
    )
    expect(await tableCounts()).toEqual(before)
    expect(await db.select({ id: transactions.id }).from(transactions).where(eq(transactions.id, 'after-go-live'))).toHaveLength(1)
    // More than three: the first three by id, then "...".
    for (const id of ['x-1', 'x-2', 'x-3', 'x-4']) await db.insert(categories).values({ id, name: `Extra ${id}`, created_at: new Date('2026-09-01T00:00:00Z') })
    await expect(runImport(db, plan, { replace: true, confirmDatabase: 'smartstock_test' })).rejects.toThrow(
      'Refusing to replace: categories has 4 rows whose id is not in the import ("x-1", "x-2", "x-3", ...).',
    )
  })

  it('replace guard (b): it refuses when the target holds a row created after the newest record being imported', async () => {
    await runImport(db, plan, { replace: false })
    expect(newestPlannedTimestamp(plan)?.toISOString()).toBe('2026-09-26T08:00:00.000Z')
    await db.update(categories).set({ created_at: new Date('2026-10-05T09:00:00.000Z') }).where(eq(categories.id, 'c1'))
    const before = await tableCounts()
    await expect(runImport(db, plan, { replace: true, confirmDatabase: 'smartstock_test' })).rejects.toThrow(
      'Refusing to replace: categories has a row created 2026-10-05T09:00:00.000Z, after the newest record being imported (2026-09-26T08:00:00.000Z). ' +
        'Rows like that exist only in PostgreSQL (entered after cut-over?) and would be lost. Nothing was written.',
    )
    expect(await tableCounts()).toEqual(before)
  })

  it('replace guard (b): it refuses when a row was updated after the newest record being imported (an edit after go-live)', async () => {
    await runImport(db, plan, { replace: false })
    // e.g. a product edited in the new app; its audit entry has been lost or was never written
    await db.update(products).set({ updated_at: new Date('2026-10-06T10:00:00.000Z'), name: 'Edited after go-live' }).where(eq(products.id, 'p1'))
    await expect(runImport(db, plan, { replace: true, confirmDatabase: 'smartstock_test' })).rejects.toThrow(
      'Refusing to replace: products has a row updated 2026-10-06T10:00:00.000Z, after the newest record being imported (2026-09-26T08:00:00.000Z).',
    )
    expect((await db.select({ name: products.name }).from(products).where(eq(products.id, 'p1')))[0].name).toBe('Edited after go-live')
  })

  it('newestPlannedTimestamp reads updated_at as well as created_at', () => {
    const later: ImportPlan = structuredClone(plan)
    later.rows.products[0].updated_at = new Date('2026-09-30T00:00:00.000Z')
    expect(newestPlannedTimestamp(later)?.toISOString()).toBe('2026-09-30T00:00:00.000Z')
  })
})

describe('the command line', () => {
  it('defaults to a dry run and needs a source', () => {
    expect(parseCliArgs(['--source', 'live'])).toEqual({ source: 'live', write: false, replace: null, restoreDeletedProducts: false, allowNonLocalDb: false })
    expect(parseCliArgs(['--source', 'live', '--dry-run'])).toEqual(parseCliArgs(['--source', 'live']))
    expect(parseCliArgs(['--source=emulator', '--write', '--replace=smartstock'])).toMatchObject({ source: 'emulator', write: true, replace: { database: 'smartstock' } })
    expect(parseCliArgs(['--source=live', '--write', '--replace'])).toMatchObject({ replace: { database: null } }) // refused once the target is known
    expect(parseCliArgs(['--source=live', '--restore-deleted-products'])).toMatchObject({ restoreDeletedProducts: true })
    expect(() => parseCliArgs([])).toThrow(/--source emulator\|live/)
    expect(() => parseCliArgs(['--source', 'prod'])).toThrow(/--source emulator\|live/)
    expect(() => parseCliArgs(['--source', 'live', '--replace=smartstock'])).toThrow(/--replace only makes sense with --write/)
    expect(() => parseCliArgs(['--source', 'live', '--dry-run', '--write'])).toThrow(/--dry-run and --write contradict each other/)
    expect(() => parseCliArgs(['--source', 'live', '--force'])).toThrow(/Unknown option --force/)
  })

  it('writes to a non-local database only with --allow-non-local-db, and says where it is writing', () => {
    expect(() => checkTarget('postgres://u:secret@10.20.0.3:5432/smartstock', false)).toThrow(/--allow-non-local-db/)
    const target = checkTarget('postgres://u:secret@10.20.0.3:5432/smartstock', true)
    expect(target).toBe('host 10.20.0.3, database smartstock (NOT this machine)')
    expect(target).not.toContain('secret')
    expect(checkTarget('postgres://postgres:postgres@127.0.0.1:5432/smartstock', false)).toBe('host 127.0.0.1, database smartstock')
  })

  it('emulator mode only reads a local emulator; live mode refuses when an emulator host is set', () => {
    expect(emulatorHostProblem('127.0.0.1:8081')).toBeNull()
    expect(emulatorHostProblem('localhost:8081')).toBeNull()
    expect(emulatorHostProblem('firestore.example.com:8081')).toMatch(/not on this machine/)
    expect(liveEnvProblem({ FIRESTORE_EMULATOR_HOST: '127.0.0.1:8081' })).toMatch(/FIRESTORE_EMULATOR_HOST is set/)
    expect(liveEnvProblem({})).toBeNull()
  })
})

describe('the command, run against the test database with an in-memory Firestore', () => {
  const originalUrl = process.env.DATABASE_URL
  let output: string[]
  const run = async (argv: string[], state: FirestoreState) => {
    output = []
    const log = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void output.push(a.join(' ')))
    const err = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void output.push(a.join(' ')))
    try {
      process.env.DATABASE_URL = TEST_DATABASE_URL
      return await main(argv, async () => ({ source: memorySource(state), label: 'test Firestore' }))
    } finally {
      log.mockRestore()
      err.mockRestore()
      if (originalUrl === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = originalUrl
      db = getDb(TEST_DATABASE_URL) // main() closes the pool it used
    }
  }

  beforeEach(async () => {
    db = await resetTestDb()
  })

  it('a dry run prints what it would do, writes nothing and exits 0', async () => {
    expect(await run(['--source', 'live'], one())).toBe(0)
    const text = output.join('\n')
    expect(text).toContain('Reading test Firestore')
    expect(text).toMatch(/transactions\s+3/)
    expect(text).toContain('Problems (0;')
    expect(text).toContain('Dry run: nothing was written. Re-run with --write to import.')
    expect(await tableCounts()).toEqual(allZero)
  })

  it('a dry run with problems lists them and exits 1; --write then refuses and writes nothing', async () => {
    const state = one()
    state.loan_requests.r1.status = 'on_hold'
    expect(await run(['--source', 'live'], state)).toBe(1)
    expect(output.join('\n')).toContain('loan_requests/r1: status "on_hold" is not one of')
    expect(await run(['--source', 'live', '--write'], state)).toBe(1)
    expect(output.join('\n')).toContain('--write refused: 1 problem(s) above. Nothing was written.')
    expect(await tableCounts()).toEqual(allZero)
  })

  it('--write echoes the target, imports, and a second --write refuses (the database already has data)', async () => {
    expect(await run(['--source', 'live', '--write'], one())).toBe(0)
    const text = output.join('\n')
    expect(text).toContain('Writing to PostgreSQL: host 127.0.0.1, database smartstock_test')
    expect(text).toMatch(/Connected: database smartstock_test on server \S+, PostgreSQL 17/)
    expect(text).toContain('Imported (one transaction, committed):')
    const after = await tableCounts()
    expect(after.transactions).toBe(3)
    expect(await run(['--source', 'live', '--write'], one())).toBe(1)
    expect(output.join('\n')).toContain('The database already has data')
    expect(await tableCounts()).toEqual(after)
    // a bare --replace is refused, naming the target database
    expect(await run(['--source', 'live', '--write', '--replace'], one())).toBe(1)
    expect(output.join('\n')).toContain("--replace needs the target database's name, to show you mean this one: --replace=smartstock_test. Nothing was written.")
    expect(await run(['--source', 'live', '--write', '--replace=smartstock'], one())).toBe(1)
    expect(output.join('\n')).toContain('Refusing to replace: the target database is "smartstock_test"')
    expect(await tableCounts()).toEqual(after)
    expect(await run(['--source', 'live', '--write', '--replace=smartstock_test'], one())).toBe(0)
    expect(await tableCounts()).toEqual(after)
  })

  it('points at --restore-deleted-products next to the grouped problems, and lists what it restored', async () => {
    const state = withDeleted()
    delete state.transaction_lines['l-nolog']
    delete state.loan_request_lines.ld
    expect(await run(['--source', 'live'], state)).toBe(1)
    expect(output.join('\n')).toContain('1 of the missing products above have a delete entry in the audit log. Run again with --restore-deleted-products')
    expect(await run(['--source', 'live', '--write', '--restore-deleted-products'], state)).toBe(0)
    const text = output.join('\n')
    expect(text).toMatch(/products\s+3 {2}\(incl\. 1 RESTORED deleted product\(s\)\)/)
    expect(text).toContain('p-gone  Cordless Drill  deleted 2026-09-28T08:00:00.000Z by Ada Admin')
    expect(text).toContain('Restored deleted products (no audit entry written): p-gone')
  })
})

describe('end to end: the full Firestore state of the old seed:comprehensive', () => {
  // The fixture is the old seed's Firestore state, exported on 2026-10-04 at about 17:00 UTC; the app is read "as of" a
  // moment shortly after, so the day-relative scenarios (overdue, due today, pickups) read as they did then.
  const STATE = load('firestore-comprehensive-state.json')
  const NOW = new Date('2026-10-04T17:30:00.000Z')
  const SOURCE_COUNTS = {
    profiles: 1, settings: 1, staff: 32, categories: 8, audit_log: 140, products: 25, transactions: 31,
    transaction_lines: 61, return_waivers: 1, loan_requests: 37, loan_request_lines: 44,
  }
  let plan: ImportPlan
  let counts: Record<string, number>
  let admin: Caller
  const ctx = (caller: Caller = admin): Ctx => ({ db, caller, now: () => NOW })

  beforeAll(async () => {
    db = await resetTestDb()
    plan = await planImport(memorySource(structuredClone(STATE)), { now: NOW })
    counts = await runImport(db, plan, { replace: false })
    admin = await loadCaller(db, 'seed-admin')
  })

  it('plans with 0 problems, reads every collection and leaves nothing out', () => {
    expect(problemTexts(plan)).toEqual([])
    expect(plan.sourceCounts).toEqual({ ...SOURCE_COUNTS, sent_notifications: 0 })
    expect(plan.notImported).toEqual([])
    // nothing is dropped silently either: no field without a column, no legacy shape (the profile's copy of its own id is
    // the uid it is keyed by)
    expect(plan.warnings).toEqual([])
  })

  it('imports matching counts: one row per Firestore document, plus one product_barcodes row per barcode', async () => {
    expect(counts).toEqual({ ...SOURCE_COUNTS, product_barcodes: 41, sent_notifications: 0 })
    expect(await tableCounts()).toEqual(counts)
  })

  it('keeps the administrator an admin and every portal login linked to its staff record', async () => {
    expect(admin).toMatchObject({ uid: 'seed-admin', name: 'Jonathan Pritchard', role: 'admin', staffId: 'doc00001' })
    const linked = await db.select({ id: staff.id, uid: staff.uid }).from(staff)
    const withLogin = linked.filter((s) => s.uid !== null)
    expect(withLogin).toHaveLength(17)
    for (const s of withLogin) {
      const caller = await loadCaller(db, s.uid as string)
      expect(caller.staffId, s.uid as string).toBe(s.id)
      expect(caller.role).toBe(s.uid === 'seed-admin' ? 'admin' : 'staff')
    }
  })

  it('loadDashboard: the outstanding returns, pickups and low-stock alerts of the seeded scenarios', async () => {
    const { outstandingReturns, incomingPickups, lowStock } = await loadDashboard(ctx())
    const row = (who: string, product: string) => outstandingReturns.find((o) => o.staff_name === who && o.product_name === product)
    expect(row('Lucas Hamilton', 'External Hard Drive 2TB')).toMatchObject({ qty: 1, status: 'no_return_date' })
    expect(row('Hannah Wells', 'Ultrabook Laptop 14-inch')).toMatchObject({ qty: 2, status: 'overdue' })
    expect(row('Nathan Brooks', 'USB Flash Drive 64GB')).toMatchObject({ qty: 1, status: 'due_today' })
    expect(row('Victoria Lang', 'HDMI Cable 2m')).toMatchObject({ qty: 3, status: 'not_due_yet' })
    expect(row('Joshua Kerr', '24-inch Monitor')).toMatchObject({ qty: 1 }) // one unit written off by the waiver
    expect(row('Amelia Hayes', 'Desktop PC')).toMatchObject({ qty: 2, status: 'overdue' })
    expect(row('Ethan Marshall', 'Compact Wireless Mouse')).toBeUndefined() // fully returned
    expect(new Set(outstandingReturns.map((o) => o.status))).toEqual(new Set(['no_return_date', 'overdue', 'due_today', 'not_due_yet']))
    expect(incomingPickups.find((p) => p.staff_name === 'Charlotte Ellis')).toMatchObject({ insufficient: false })
    expect(incomingPickups.filter((p) => p.insufficient).map((p) => p.staff_name).sort()).toEqual(['Benjamin Carter', 'Daniel Mercer'])
    expect(Object.fromEntries(lowStock.map((l) => [l.name, l.status]))).toMatchObject({
      'Ethernet Patch Cable Cat6': 'low_stock',
      'Solid State Drive 1TB': 'out_of_stock',
    })
  })

  it('listRequests: every status in the same numbers, and the portal borrower sees only her own', async () => {
    const all = await listRequests(ctx(), {})
    expect(all).toHaveLength(37)
    const statuses: Record<string, number> = {}
    for (const r of all) statuses[r.status] = (statuses[r.status] ?? 0) + 1
    // The live no-show was settled by the Dashboard load above (accepted 7 -> 6, no_show 3 -> 4), as the app does.
    expect(statuses).toEqual({ pending: 5, countered: 5, accepted: 6, no_show: 4, expired: 3, fulfilled: 3, declined: 7, withdrawn: 4 })
    const jessica = await loadCaller(db, 'seed-demo-portallinked-uid')
    const mine = await listRequests(ctx(jessica), {})
    expect(mine.length).toBeGreaterThan(10)
    expect(mine.every((r) => r.staff_id === jessica.staffId)).toBe(true)
    // lines come back in cart order with their quantities
    const withLines = all.find((r) => r.reference_no === 'LR-ULVX1R7Y')
    expect(withLines).toMatchObject({ staff_name: 'Emma Richardson', status: 'pending', from_date: '2026-10-07', to_date: '2026-10-14' })
  })

  it('listOutstandingForStaff: what Natalie Pierce still holds, as Returns would show it', async () => {
    const [natalie] = await db.select().from(staff).where(eq(staff.full_name, 'Natalie Pierce'))
    const held = await listOutstandingForStaff(ctx(), natalie.id)
    const names = JSON.stringify(held)
    for (const product of ['External Hard Drive 2TB', 'Ultrabook Laptop 14-inch', 'USB Flash Drive 64GB']) expect(names).toContain(product)
  })

  it('loadReport: stock levels for all 25 products, and the four returns (two partial)', async () => {
    const levels = await loadReport(ctx(), { report: 'stock-levels' })
    expect(levels).toHaveLength(25)
    expect(levels.find((p) => p.name === 'Wireless Mouse')).toMatchObject({ qty: 23, threshold: 5 })
    const { returns } = await loadReport(ctx(), { report: 'returns' })
    expect(returns).toHaveLength(4)
    expect(returns.filter((r) => r.partial).map((r) => r.staff_name).sort()).toEqual(['Megan Holloway', 'Rachel Dawson'])
    const { staff: holders } = await loadReport(ctx(), { report: 'issued-per-staff' })
    expect(holders.filter((h) => h.txns.length > 0)).toHaveLength(15)
  })

  it('listAuditLog: the 140 imported entries (plus what the app itself just audited), newest first', async () => {
    const page = await listAuditLog(ctx(), {})
    const ids = new Set(Object.keys(STATE.audit_log))
    const imported = page.entries.filter((e) => ids.has(e.id))
    expect(imported).toHaveLength(140)
    const times = page.entries.map((e) => e.created_at)
    expect([...times].sort().reverse()).toEqual(times)
    const sample = STATE.audit_log.doc00010
    expect(page.entries.find((e) => e.id === 'doc00010')).toMatchObject({ action: sample.action, entity_type: sample.entity_type, after: sample.after })
  })
})

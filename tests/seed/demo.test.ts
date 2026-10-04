import { count, eq } from 'drizzle-orm'
import type { PgTable } from 'drizzle-orm/pg-core'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminCaller, createFakeAuthAndBucket, seedCtx, seedCtxSequence } from '../../scripts/seed/context'
import { COMPREHENSIVE_CAST, seedComprehensive, summaryLines, type SeedCast, type SeedSummary } from '../../scripts/seed/comprehensive'
import { DEMO_ADMIN, DEMO_CAST, DROPPED_SCENARIOS, seedDemo } from '../../scripts/seed/demo'
import { loadCaller } from '@/server/context'
import type { Db } from '@/server/db/client'
import {
  auditLog,
  categories,
  loanRequestLines,
  loanRequests,
  productBarcodes,
  products,
  profiles,
  returnWaivers,
  settings,
  staff,
  transactionLines,
  transactions,
} from '@/server/db/schema'
import { loadDashboard } from '@/server/data/dashboard'
import { listRequests } from '@/server/data/loanRequests'
import { closeTestDb, resetTestDb } from '../helpers/db'

// seed:demo on PostgreSQL: the NWU demo version of seed:comprehensive, run end to end against a fresh test database with
// in-memory Auth/Storage stand-ins. The first 11 tests are the 11 assertions of the scratch check-seed-demo.mjs that checked
// the Firestore version (the numbers in their titles); the rest pin what the PostgreSQL version adds.
//
// The expected counts are seed:comprehensive's (see tests/seed/comprehensive.test.ts) with the 10 dropped scenarios, the
// 10 fewer staff and the one extra product taken into account:
//
//   table                  comprehensive   demo   why
//   staff                        32          22    20 NWU staff + Meiring + Selouna's own hidden record (was 31 + 1)
//   products                     25          26    + Bostik Glu Dots
//   categories                    8           8
//   loan_requests                37          32    - CounteredSimple, NoShowLive, ExpiredRecorded, DeclinedPending, WithdrawnByStaff
//   loan_request_lines           44          39    one line each for those five
//   transactions                 31          24    - 7: the OUTs of ReturnNoDate / ReturnOverdue / ReturnDueToday, the OUT + RETURN of
//                                                    ReturnCompleted and of ReturnPartial
//   transaction_lines            61          54    one line each for those seven
//   audit_log                   206         165    see below
//   profiles, settings, return_waivers: 1, 1, 1
//
//   audit action (entity)   comprehensive   demo   why
//   category create                 8          8
//   category update                 1          1
//   staff create                   31         21    one per record (the administrator's own record is saved by My Profile's save, not by Add Staff)
//   staff update / activate         1 / 1      1 / 1
//   staff deactivate                2          2
//   staff grant_access             16          1    only Meiring has a login link (15 other portal staff in comprehensive)
//   staff resend_access             1          1    Meiring's
//   product create                 25         26    + Bostik Glu Dots
//   product update                  3          3
//   transaction create             31         24    - 7
//   transaction resolve             1          1
//   loan_request create            37         32    - 5
//   loan_request update            46         41    - 5 (the counter, the live approval, the expiry, the decline, the withdrawal)
//   settings update                 2          2

const NOW = new Date()

const DEPT = 'Computer Science and Information Systems'
const ADMIN = 'selouna.visser@nwu.ac.za'
const MEIRING = '47817909@mynwu.ac.za'

// The cast: [full name, email, has a card, has a login]. Written out literally (the cards follow the comprehensive roster's
// index mod 4 mix, the logins are Meiring's only), so a change to the cast fails here.
const ROSTER: [string, string, boolean, boolean][] = [
  ['Estelle Taylor', 'estelle.taylor@nwu.ac.za', true, false],
  ['Annette van der Merwe', 'annette.vandermerwe@nwu.ac.za', true, false],
  ['Linda Redelinghuys', 'linda.redelinghuys@nwu.ac.za', false, false],
  ['Rodney Sebopelo', 'rodney.sebopelo@nwu.ac.za', true, false],
  ['Susan Campher', 'susan.campher@nwu.ac.za', true, false],
  ['Kobus van Aswegen', 'kobus.vanaswegen@nwu.ac.za', false, false],
  ['Tiny du Toit', 'tiny.dutoit@nwu.ac.za', false, false],
  ['Marijke Coetzee', 'marijke.coetzee@nwu.ac.za', true, false],
  ['Lynette Drevin', 'lynette.drevin@nwu.ac.za', false, false],
  ['Absalom Ezugwu', 'absalom.ezugwu@nwu.ac.za', true, false],
  ['Dimitri Keykaan', 'dimi.keykaan@nwu.ac.za', false, false],
  ['Neels Kruger', 'neels.kruger@nwu.ac.za', true, false],
  ['Janet Liebenberg', 'janet.liebenberg@nwu.ac.za', true, false],
  ['Rudi Serfontein', 'rudi.serfontein@nwu.ac.za', true, false],
  ['Henri van Rensburg', 'henri.vanrensburg@nwu.ac.za', false, false],
  ['Dumani Kunjuzwa', 'dumani.kunjuzwa@nwu.ac.za', true, false],
  ['Jeanne-Mari Maree', 'jeanne.maree@nwu.ac.za', false, false],
  ['Heystek Grobler', 'heystek.grobler@nwu.ac.za', false, false],
  ['Phenyo Modisane', 'phenyo.modisane@nwu.ac.za', true, false],
  ['Gunther Drevin', 'gunther.drevin@nwu.ac.za', true, false],
  ['Meiring van Niekerk', MEIRING, false, true],
]
const NWU_EMAILS = ROSTER.filter((r) => r[1] !== MEIRING).map((r) => r[1])

let db: Db
let summary: SeedSummary
let fake: ReturnType<typeof createFakeAuthAndBucket>
let admin: ReturnType<typeof adminCaller>
let staffRows: (typeof staff.$inferSelect)[]
let productRows: (typeof products.$inferSelect)[]
let auditRows: (typeof auditLog.$inferSelect)[]
let requestRows: (typeof loanRequests.$inferSelect)[]
let txnRows: (typeof transactions.$inferSelect)[]
let statusCounts: Record<string, number>
let auditCounts: Record<string, number>
let tableCounts: Record<string, number>

async function tableCount(table: PgTable): Promise<number> {
  const [row] = await db.select({ n: count() }).from(table)
  return row.n
}

beforeAll(async () => {
  db = await resetTestDb()
  fake = createFakeAuthAndBucket()
  summary = await seedDemo({ db, auth: fake.auth, bucket: fake.bucket, now: NOW })

  const [adminRow] = await db.select().from(profiles).where(eq(profiles.role, 'admin'))
  const [adminStaff] = await db.select().from(staff).where(eq(staff.uid, adminRow.uid))
  admin = adminCaller(adminRow.uid, adminRow.full_name, adminStaff.id)

  staffRows = await db.select().from(staff)
  productRows = await db.select().from(products)
  auditRows = await db.select().from(auditLog)
  requestRows = await db.select().from(loanRequests)
  txnRows = await db.select().from(transactions)
  statusCounts = Object.fromEntries(requestRows.reduce((m, r) => m.set(r.status, (m.get(r.status) ?? 0) + 1), new Map<string, number>()))
  auditCounts = Object.fromEntries(auditRows.reduce((m, a) => m.set(`${a.entity_type} ${a.action}`, (m.get(`${a.entity_type} ${a.action}`) ?? 0) + 1), new Map<string, number>()))
  tableCounts = {
    audit_log: await tableCount(auditLog),
    categories: await tableCount(categories),
    loan_request_lines: await tableCount(loanRequestLines),
    loan_requests: await tableCount(loanRequests),
    products: await tableCount(products),
    profiles: await tableCount(profiles),
    return_waivers: await tableCount(returnWaivers),
    settings: await tableCount(settings),
    staff: await tableCount(staff),
    transaction_lines: await tableCount(transactionLines),
    transactions: await tableCount(transactions),
  }
}, 180_000)

afterAll(async () => {
  await closeTestDb()
})

const ctxNow = () => seedCtx(db, NOW, admin)

describe('the 11 checks of the Firestore seed:demo', () => {
  it('1. only two logins: Selouna (admin) and Meiring (portal)', () => {
    expect([...fake.users.values()].map((u) => u.email).sort()).toEqual([MEIRING, ADMIN].sort())
    expect([...fake.users.values()].find((u) => u.email === ADMIN)?.uid).toBe('admin-selouna-visser')
    expect(fake.users.size).toBe(2)
  })

  it('2. Selouna is the administrator everywhere', async () => {
    const [profile] = await db.select().from(profiles).where(eq(profiles.uid, 'admin-selouna-visser'))
    expect(profile).toMatchObject({ full_name: 'Selouna Visser', role: 'admin' })
    const [notifications] = await db.select().from(settings).where(eq(settings.key, 'notifications'))
    expect(notifications.value.admin_notification_email).toBe(ADMIN)
    // Her own hidden borrower record (also the old check-seed-admin-staff.mjs: name, surname, department, email, admin flags, no card)
    const own = staffRows.find((s) => s.is_admin_account)
    expect(own).toMatchObject({
      email: ADMIN, name: 'Selouna', surname: 'Visser', full_name: 'Selouna Visser', department: DEPT,
      uid: 'admin-selouna-visser', is_admin_account: true, is_active: true, card_uid: null,
    })
    expect(staffRows.filter((s) => s.is_admin_account)).toHaveLength(1)
    const adminActors = new Set(auditRows.filter((a) => a.user_id === 'admin-selouna-visser').map((a) => a.user_name))
    expect([...adminActors]).toEqual(['Selouna Visser'])
    expect(auditRows.some((a) => /Jonathan|Pritchard/.test(JSON.stringify(a))), 'no Jonathan Pritchard left in the audit log').toBe(false)
    expect(summary).toMatchObject({ adminName: 'Selouna Visser', adminEmail: ADMIN })
  })

  it("3. staff are exactly the 20 NWU staff, Meiring and Selouna's own record", () => {
    const emails = staffRows.filter((s) => !s.is_admin_account).map((s) => s.email).sort()
    expect(emails).toEqual([...NWU_EMAILS, MEIRING].sort())
    expect(staffRows).toHaveLength(22)
    expect(NWU_EMAILS).toHaveLength(20)
  })

  it('4. Meiring van Niekerk took over the portal account (Computer Science and Information Systems)', () => {
    const m = staffRows.find((s) => s.email === MEIRING)
    expect(m).toMatchObject({ name: 'Meiring', surname: 'van Niekerk', full_name: 'Meiring van Niekerk', department: DEPT })
    expect(m?.uid).toBe([...fake.users.values()].find((u) => u.email === MEIRING)?.uid)
    expect(summary.portalBorrower).toEqual({ fullName: 'Meiring van Niekerk', email: MEIRING })
  })

  it('5. no NWU staff member has a login; everyone is in Computer Science and Information Systems', () => {
    for (const s of staffRows) {
      if (s.email !== MEIRING && !s.is_admin_account) expect(s.uid ?? null, s.email as string).toBeNull()
      expect(s.department, s.email as string).toBe(DEPT)
    }
  })

  it('6. no made-up names or gmail addresses anywhere in staff, requests, transactions or the audit log', () => {
    const blob = JSON.stringify({ staffRows, requestRows, txnRows, auditRows })
    expect(blob).not.toMatch(/@gmail\.com/)
    for (const name of ['Jessica Moore', 'Emma Richardson', 'Megan Holloway', 'Callum Rhodes', 'Zoe Mitchell']) expect(blob.includes(name), name).toBe(false)
    const names = new Set(staffRows.map((s) => s.full_name))
    for (const r of requestRows) expect(names.has(r.staff_name), `request staff ${r.staff_name}`).toBe(true)
    for (const t of txnRows) if (t.staff_name) expect(names.has(t.staff_name), `txn staff ${t.staff_name}`).toBe(true)
  })

  it('7. every loan request status is still represented', () => {
    const present = new Set(requestRows.map((r) => r.status))
    for (const s of ['pending', 'countered', 'accepted', 'fulfilled', 'declined', 'expired', 'no_show', 'withdrawn']) expect(present.has(s as never), s).toBe(true)
  })

  it('8. Meiring owns the full My Requests history (more than 10 in History)', () => {
    const mine = requestRows.filter((r) => r.staff_name === 'Meiring van Niekerk')
    const history = mine.filter((r) => ['fulfilled', 'declined', 'expired', 'no_show', 'withdrawn'].includes(r.status))
    expect(mine.length).toBeGreaterThanOrEqual(20)
    expect(history.length).toBeGreaterThan(10)
  })

  it('9. Bostik Glu Dots exists exactly as it was created in the demo, with no photos and 4 in stock', async () => {
    const bostik = productRows.filter((p) => p.name === 'Bostik Glu Dots')
    expect(bostik).toHaveLength(1)
    const p = bostik[0]
    const codes = await db.select().from(productBarcodes).where(eq(productBarcodes.product_id, p.id))
    expect(codes.map((c) => c.barcode)).toEqual(['6001364000266'])
    expect(p).toMatchObject({
      category_name: 'Consumables', description: 'Bostik Glu Dots', quantity_on_hand: 4, reorder_threshold: 1, available: false,
      lending_interval: 'week_1', location: 'NWU - Potchefstroom, Building G4, Room 28', lend_from: '2026-09-29', lend_to: null, images: [],
    })
    const [category] = await db.select().from(categories).where(eq(categories.id, p.category_id as string))
    expect(category.name).toBe('Consumables')
    // A fixed historical moment, not relative to today: the product is stamped when the live record was created.
    expect(p.created_at.toISOString()).toBe('2026-09-29T08:17:02.292Z')
    expect(p.updated_at.toISOString()).toBe('2026-09-29T08:17:02.292Z')
  })

  it('10. its product-create audit entry (Selouna, 29 Sep 2026 10:17) and no transactions for it', async () => {
    const p = productRows.find((x) => x.name === 'Bostik Glu Dots') as (typeof productRows)[number]
    const entries = auditRows.filter((a) => a.entity_id === p.id)
    expect(entries).toHaveLength(1)
    const a = entries[0]
    expect(a).toMatchObject({ action: 'create', entity_type: 'product', before: null, user_name: 'Selouna Visser', user_id: 'admin-selouna-visser' })
    // 115 ms after the product itself: the old seed wrote these two distinct instants.
    expect(a.created_at.toISOString()).toBe('2026-09-29T08:17:02.407Z')
    expect(a.after).toMatchObject({
      name: 'Bostik Glu Dots', barcodes: ['6001364000266'], quantity_on_hand: 4, category_id: p.category_id, category_name: 'Consumables',
      reorder_threshold: 1, available: false, lend_from: '2026-09-29', lend_to: null, lending_interval: 'week_1', images: [],
      created_at: '2026-09-29T08:17:02.292Z', updated_at: '2026-09-29T08:17:02.292Z',
    })
    const [lines] = await db.select({ n: count() }).from(transactionLines).where(eq(transactionLines.product_id, p.id))
    expect(lines.n).toBe(0)
  })

  it('11. the comprehensive catalogue is still there (same product barcodes plus Bostik)', async () => {
    const codes = new Set((await db.select().from(productBarcodes)).map((c) => c.barcode))
    for (const c of ['DEMO-HEALTHY', 'DEMO-LOWSTOCK', 'DEMO-OUTOFSTOCK', 'DEMO-PARTIALRETURN', 'DEMO-FULLRETURN', 'DEMO-RET-NODATE', 'DEMO-KITCABLE-A', 'DEMO-LOSTLABEL-A', 'DEMO-MANYBARCODE-01']) {
      expect(codes.has(c), c).toBe(true)
    }
    expect(productRows).toHaveLength(26)
  })
})

describe('only the two logins can sign in', () => {
  it('has exactly two Auth users and no login link for any NWU staff member', () => {
    expect(fake.users.size).toBe(2)
    // staff.uid is the login link: Meiring's and Selouna's own record, nobody else's
    expect(staffRows.filter((s) => s.uid !== null).map((s) => s.email).sort()).toEqual([MEIRING, ADMIN].sort())
    expect(auditRows.filter((a) => a.entity_type === 'staff' && a.action === 'grant_access')).toHaveLength(1)
    expect(summary.otherPortalEmails).toEqual([])
  })

  it('resolves both logins to the right caller: Selouna is admin, Meiring is staff linked to his record', async () => {
    const selouna = await loadCaller(db, 'admin-selouna-visser')
    expect(selouna).toMatchObject({ uid: 'admin-selouna-visser', name: 'Selouna Visser', role: 'admin' })
    expect(selouna.staffId).not.toBeNull()
    const meiring = await loadCaller(db, 'seed-demo-portallinked-uid')
    const row = staffRows.find((s) => s.email === MEIRING)
    expect(meiring).toMatchObject({ role: 'staff', name: 'Meiring van Niekerk', staffId: row?.id })
    // No other login uid resolves to anyone: the Auth users are the only way in
    for (const s of staffRows.filter((x) => !x.is_admin_account && x.email !== MEIRING)) {
      expect(s.uid, s.full_name).toBeNull()
      expect((await loadCaller(db, s.id)).role, s.full_name).toBe('staff') // loadCaller treats an unknown uid as plain staff, with no linked record
      expect((await loadCaller(db, s.id)).staffId, s.full_name).toBeNull()
    }
  })

  it('gives the cast the pinned cards: made-up UIDs, unique, none for the people without one', () => {
    const rows = staffRows.filter((s) => !s.is_admin_account)
    const actual = rows.map((r): [string, string, boolean, boolean] => [r.full_name, r.email as string, r.card_uid !== null, r.uid !== null])
    expect(actual.sort((x, y) => x[0].localeCompare(y[0]))).toEqual([...ROSTER].sort((x, y) => x[0].localeCompare(y[0])))
    const cards = rows.map((r) => r.card_uid).filter((c): c is string => c !== null)
    expect(new Set(cards).size).toBe(cards.length)
    for (const c of cards) expect(c).toMatch(/^[0-9A-F]{8}$/)
    // The made-up UIDs seed:comprehensive gives the same roster positions (cardUidFor), pinned literally: never a real card.
    expect(Object.fromEntries(rows.filter((r) => r.card_uid).map((r) => [r.email, r.card_uid]))).toEqual({
      'estelle.taylor@nwu.ac.za': '04A1F3B7',
      'annette.vandermerwe@nwu.ac.za': '04A3E76E',
      'rodney.sebopelo@nwu.ac.za': '04A9C293',
      'susan.campher@nwu.ac.za': '04ABB64A',
      'marijke.coetzee@nwu.ac.za': '04B38526',
      'absalom.ezugwu@nwu.ac.za': '04BB5402',
      'neels.kruger@nwu.ac.za': '04C12F27',
      'janet.liebenberg@nwu.ac.za': '04C8FE03',
      'rudi.serfontein@nwu.ac.za': '04CAF1BA',
      'dumani.kunjuzwa@nwu.ac.za': '04D2C096',
      'phenyo.modisane@nwu.ac.za': '04D89BBB',
      'gunther.drevin@nwu.ac.za': '04DA8F72',
    })
  })

  it('has everyone active except Gunther Drevin (his badge was switched off), and creates the staff one row after another', () => {
    const rows = staffRows.filter((s) => !s.is_admin_account)
    expect(rows.filter((r) => !r.is_active).map((r) => r.full_name)).toEqual(['Gunther Drevin'])
    const inCreationOrder = [...rows].sort((a, b) => a.created_at.getTime() - b.created_at.getTime()).map((r) => r.full_name)
    expect(inCreationOrder).toEqual(ROSTER.map((r) => r[0]))
    expect(summary.staff.map((m) => m.fullName)).toEqual(ROSTER.map((r) => r[0]))
  })
})

describe('what is in and what is dropped', () => {
  it('leaves out exactly the 10 dropped scenarios and keeps the other 21', () => {
    expect(DROPPED_SCENARIOS).toEqual([
      'CounteredSimple', 'NoShowLive', 'ExpiredRecorded', 'DeclinedPending', 'WithdrawnByStaff',
      'ReturnNoDate', 'ReturnOverdue', 'ReturnDueToday', 'ReturnCompleted', 'ReturnPartial',
    ])
    const keys = new Set(DEMO_CAST.staff.map((m) => m.key))
    for (const dropped of DROPPED_SCENARIOS) expect(keys.has(dropped), dropped).toBe(false)
    expect(DEMO_CAST.staff).toHaveLength(21)
    expect(COMPREHENSIVE_CAST.staff).toHaveLength(31)
    expect(new Set([...keys, ...DROPPED_SCENARIOS])).toEqual(new Set(COMPREHENSIVE_CAST.staff.map((m) => m.key)))
    expect(DEMO_CAST.admin).toEqual(DEMO_ADMIN)
  })

  it('has the loan request statuses of seed:comprehensive less the five dropped requests', () => {
    expect(statusCounts).toEqual({ pending: 5, countered: 4, accepted: 6, no_show: 3, expired: 2, fulfilled: 3, declined: 6, withdrawn: 3 })
  })

  it("gives Meiring van Niekerk's History 12 terminal requests (past the 10-row page size) and every other tab several rows", async () => {
    const [meiring] = staffRows.filter((s) => s.email === MEIRING)
    const own = seedCtx(db, NOW, { uid: 'seed-demo-portallinked-uid', name: 'Meiring van Niekerk', role: 'staff', staffId: meiring.id })
    const mine = await listRequests(own, {})
    const of = (...statuses: string[]) => mine.filter((r) => statuses.includes(r.status)).length
    expect(of('fulfilled', 'declined', 'expired', 'no_show', 'withdrawn')).toBe(12)
    expect(of('countered')).toBe(3)
    expect(of('pending')).toBe(3)
    expect(of('accepted')).toBe(3)
    expect(mine).toHaveLength(21)
  })

  it('has the table counts of the header', () => {
    expect(tableCounts).toEqual({
      audit_log: 165,
      categories: 8,
      loan_request_lines: 39,
      loan_requests: 32,
      products: 26,
      profiles: 1,
      return_waivers: 1,
      settings: 1,
      staff: 22,
      transaction_lines: 54,
      transactions: 24,
    })
  })

  it('has the audit counts per entity and action of the header', () => {
    expect(auditCounts).toEqual({
      'category create': 8,
      'category update': 1,
      'staff create': 21,
      'staff update': 1,
      'staff activate': 1,
      'staff deactivate': 2,
      'staff grant_access': 1,
      'staff resend_access': 1,
      'product create': 26,
      'product update': 3,
      'transaction create': 24,
      'transaction resolve': 1,
      'loan_request create': 32,
      'loan_request update': 41,
      'settings update': 2,
    })
  })

  it('stamps every audit entry in the past and attributes the administrator\'s to Selouna', () => {
    for (const r of auditRows) expect(r.created_at.getTime(), `${r.entity_type} ${r.action}`).toBeLessThan(NOW.getTime())
    expect(auditRows.filter((r) => r.user_id === 'admin-selouna-visser').length).toBeGreaterThan(80)
    // the system's expiries and no-shows: 2 expired + 3 no_show (Marijke Coetzee's and Meiring's two)
    expect(auditRows.filter((r) => r.user_name === 'System (automatic)')).toHaveLength(5)
  })

  it('has the same products as seed:comprehensive: the legacy product without an interval, 1-3 photos each (Bostik none), final stock levels', async () => {
    const withoutBostik = productRows.filter((p) => p.name !== 'Bostik Glu Dots')
    expect(withoutBostik).toHaveLength(25)
    for (const p of withoutBostik) {
      expect(p.images.length, p.name).toBeGreaterThanOrEqual(1)
      expect(p.images.length, p.name).toBeLessThanOrEqual(3)
      for (const path of p.images) expect(fake.files.has(path), path).toBe(true)
    }
    expect(productRows.filter((p) => p.lending_interval === null).map((p) => p.name)).toEqual(['Surge Protector Power Strip'])
    const qty = Object.fromEntries(productRows.map((p) => [p.name, p.quantity_on_hand]))
    expect(qty).toMatchObject({
      'Wireless Mouse': 23,
      'Solid State Drive 1TB': 0,
      'Desktop PC': 1,
      'UPS Battery Backup 1500VA': 1,
      'USB-C Cable 1m': 8,
      'Surge Protector Power Strip': 11,
      'Bostik Glu Dots': 4,
      // the products of the dropped scenarios never left the shelf
      'Compact Wireless Mouse': 19, // 20, one walk-in for Phenyo Modisane
      'Network Switch 24-Port': 20,
      'Ultrabook Laptop 14-inch': 19, // 20, one for Henri van Rensburg
    })
  })
})

describe('Dashboard', () => {
  it('shows the outstanding returns of the kept scenarios, and no live Not Picked Up request is left to settle', async () => {
    const before = (await db.select({ n: count() }).from(auditLog))[0].n
    const { outstandingReturns, incomingPickups, lowStock } = await loadDashboard(ctxNow())
    const row = (staffName: string, product: string) => outstandingReturns.find((o) => o.staff_name === staffName && o.product_name === product)
    expect(row('Janet Liebenberg', 'HDMI Cable 2m')).toMatchObject({ qty: 3, status: 'not_due_yet' })
    expect(row('Rudi Serfontein', '24-inch Monitor')).toMatchObject({ qty: 1, status: 'not_due_yet' })
    expect(row('Henri van Rensburg', 'External Hard Drive 2TB')).toMatchObject({ status: 'no_return_date' })
    expect(row('Henri van Rensburg', 'Ultrabook Laptop 14-inch')).toMatchObject({ status: 'overdue' })
    expect(row('Henri van Rensburg', 'USB Flash Drive 64GB')).toMatchObject({ status: 'due_today' })
    expect(row('Kobus van Aswegen', 'Desktop PC')).toMatchObject({ qty: 2, status: 'overdue' })
    expect(row('Jeanne-Mari Maree', 'USB-C Cable 1m')).toMatchObject({ qty: 1, status: 'due_today' })
    expect(row('Heystek Grobler', '27-inch Monitor')).toMatchObject({ qty: 3 })
    expect(new Set(outstandingReturns.map((o) => o.status))).toEqual(new Set(['no_return_date', 'overdue', 'due_today', 'not_due_yet']))
    // Pickups: Rodney on schedule, Susan and Tiny short on stock, Meiring's three; nothing flips on this load
    const pickup = (name: string) => incomingPickups.find((p) => p.staff_name === name)
    expect(pickup('Rodney Sebopelo')).toMatchObject({ insufficient: false, noShow: false })
    expect(pickup('Susan Campher')).toMatchObject({ insufficient: true })
    expect(pickup('Tiny du Toit')).toMatchObject({ insufficient: true })
    expect(incomingPickups).toHaveLength(6)
    expect((await db.select({ n: count() }).from(auditLog))[0].n).toBe(before)
    expect(lowStock.map((l) => l.name).sort()).toEqual(['Desktop PC', 'Ethernet Patch Cable Cat6', 'Solid State Drive 1TB', 'UPS Battery Backup 1500VA'])
  })
})

describe('the Bostik clock', () => {
  it('reads the given instants one after another and fails loudly on any other number of reads', () => {
    const a = new Date('2026-01-01T00:00:00.001Z')
    const b = new Date('2026-01-01T00:00:00.002Z')
    const seq = seedCtxSequence(db, [a, b], admin)
    expect(seq.ctx.now()).toBe(a)
    expect(() => seq.assertAllUsed()).toThrow(/1 times but 2/)
    expect(seq.ctx.now()).toBe(b)
    expect(() => seq.assertAllUsed()).not.toThrow()
    expect(() => seq.ctx.now()).toThrow(/3 times but only 2/)
  })
})

describe('guards and the printed summary', () => {
  it('refuses to run again on a database that already has data', async () => {
    await expect(seedDemo({ db, auth: fake.auth, bucket: fake.bucket, now: NOW })).rejects.toThrow(/already has data/)
    expect(await tableCount(staff)).toBe(22)
    expect(fake.users.size).toBe(2)
  })

  it('rejects a cast the scenarios cannot run with', async () => {
    const run = (cast: SeedCast) => seedComprehensive({ db, auth: fake.auth, bucket: fake.bucket, now: NOW, cast })
    const staffOf = DEMO_CAST.staff
    await expect(run({ ...DEMO_CAST, staff: staffOf.filter((m) => m.key !== 'BadgeActive') })).rejects.toThrow(/required scenario staff missing: BadgeActive/)
    await expect(run({ ...DEMO_CAST, staff: [...staffOf, { ...staffOf[0] }] })).rejects.toThrow(/listed twice/)
    await expect(run({ ...DEMO_CAST, staff: [...staffOf, { ...staffOf[0], key: 'Nobody' }] })).rejects.toThrow(/"Nobody" is not a scenario/)
    await expect(run({ ...DEMO_CAST, staff: staffOf.map((m) => (m.key === 'PortalLinked' ? { ...m, login: false } : m)) })).rejects.toThrow(/PortalLinked member must have a login/)
  })

  it('prints the demo wording: Selouna and Meiring, no other logins, Bostik, the pickups already recorded', () => {
    const text = summaryLines(summary).join('\n')
    expect(text).toContain('Seeded the NWU demo data (seed:demo):')
    expect(text).toContain('BICS admin:      selouna.visser@nwu.ac.za / password123')
    expect(text).toContain('Portal borrower: 47817909@mynwu.ac.za / password123 -> http://localhost:3000/lend/login')
    expect(text).not.toContain('Other staff with portal access')
    expect(text).toContain('message), and Not Picked Up (already recorded).')
    expect(text).not.toContain('first Dashboard load')
    expect(text).toContain('BOSTIK GLU DOTS: the product scanned in during the client demo (barcode 6001364000266,')
    expect(text).toContain('WHO IS WHO (each staff member demonstrates one scenario):')
    expect(text).toContain('Estelle Taylor       Pending loan request (fresh); staff create/update audit')
    expect(text).toContain('LOST LABELS: Returns -> "Heystek Grobler" has one row per product (3 x 27-inch Monitor,')
    expect(text.indexOf('BOSTIK GLU DOTS')).toBeLessThan(text.indexOf('WHO IS WHO'))
  })
})

describe('seed:demo wiring', () => {
  const root = process.cwd()
  const scripts = (JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts

  it('runs through tsx with the react-server condition, like seed:comprehensive', () => {
    expect(scripts['seed:demo']).toBe('tsx --conditions=react-server scripts/seed/demo.ts')
    expect(scripts['seed:comprehensive']).toBe('tsx --conditions=react-server scripts/seed/comprehensive.ts')
  })

  it('has retired the Firestore seeds and their npm scripts, and kept the image scripts', () => {
    const retired = [
      'seed-demo.mjs', 'seed-emulator.mjs', 'seed-lending-portal.mjs', 'seed-staff-roster.mjs', 'seed-conflict-scenarios.mjs',
      'seed-outstanding.mjs', 'seed-products.mjs', 'seed-product-catalog.mjs', 'cleanup-borrower-test-data.mjs',
      'seed-real-production.mjs',
    ]
    for (const file of retired) expect(existsSync(path.join(root, 'scripts', file)), file).toBe(false)
    for (const name of ['seed:emulators', 'seed:lending', 'seed:products', 'seed:staff', 'seed:outstanding', 'seed:conflicts', 'seed:catalog', 'seed:real-production', 'cleanup:borrower-test']) {
      expect(scripts[name], name).toBeUndefined()
    }
    expect(scripts['images:fetch']).toBeDefined()
    expect(scripts['images:generate']).toBeDefined()
  })
})

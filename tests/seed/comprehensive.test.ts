import { count, eq, sql } from 'drizzle-orm'
import type { PgTable } from 'drizzle-orm/pg-core'
import net from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  assertEmulatorEnv,
  assertEmulatorsReachable,
  assertLocalDatabase,
  adminCaller,
  assertLocalDatabaseUrl,
  createFakeAuthAndBucket,
  databaseHosts,
  seedClock,
  seedCtx,
} from '../../scripts/seed/context'
import { seedComprehensive, summaryLines, type SeedSummary } from '../../scripts/seed/comprehensive'
import { loadCaller } from '@/server/context'
import type { Db } from '@/server/db/client'
import {
  auditLog,
  categories,
  loanRequestLines,
  loanRequests,
  products,
  profiles,
  returnWaivers,
  settings,
  staff,
  transactionLines,
  transactions,
} from '@/server/db/schema'
import { loadDashboard, loadDashboardAlertCounts } from '@/server/data/dashboard'
import { listRequests } from '@/server/data/loanRequests'
import { loadReport } from '@/server/data/reports'
import { closeTestDb, resetTestDb } from '../helpers/db'

// seed:comprehensive on PostgreSQL, run end to end against a fresh test database with in-memory Auth/Storage stand-ins.
//
// The expected numbers, and why some of them are what they are:
//
//   table                     rows   why
//   audit_log                  206   see the per-action rows below
//   categories                   8
//   loan_request_lines          44
//   loan_requests               37
//   products                    25
//   profiles                     1   portal borrowers have no profile row (loadCaller treats a missing one as 'staff'),
//                                    so only the admin has one
//   return_waivers               1
//   settings                     1   one row, key 'notifications'
//   staff                       32
//   transaction_lines           61
//   transactions                31
//   auth users                  17
//
//   audit action (entity)     rows   why
//   category create              8   every category is created through createCategory, which audits each create
//   category update              1
//   staff create                31   same: createStaff audits every record
//   staff update                 1
//   staff activate               1
//   staff deactivate             2   Zoe Mitchell is switched off (day -21) and back on (day -20), so the 'activate' is a
//                                    real change; Callum Rhodes is switched off (day -19)
//   staff grant_access          16   linkStaffLogin audits each login link
//   staff resend_access          1
//   product create              25   createProduct audits every product
//   product update               3   Desktop PC + the UPS and the SSD, whose last units are written off with a stock-count
//                                    edit after their requests were made
//   transaction create          31
//   transaction resolve          1
//   loan_request create         37
//   loan_request update         46
//   settings update              2   the two notification addresses are saved with saveAddress, which audits
//
// Other things pinned here:
//   - the system's expiry / no-show entries carry the name 'System (automatic)';
//   - the app settles a request the day after its due date, so expiry and no-show entries are dated that day;
//   - the live "Not Picked Up" request is settled by the first Dashboard load and leaves the list at once;
//   - no window is longer than the app allows (7 days on a 1-week product): Grace Thornton's pickup ends on day -3 and
//     Samuel Prescott's on day -18 (see the seed for the dates).

const NOW = new Date()

// Stock Outs / Returns entered by picking the staff member from the list: all 17 of those made by the 15 staff without a
// card (Amelia Hayes 1, Henry Caldwell 4, Hannah Wells 1, Nathan Brooks 1, Natalie Pierce 3, Ethan Marshall 2 (OUT + RETURN),
// Megan Holloway 2 (OUT + RETURN), Ryan Fletcher 1, Jessica Moore 2) plus Lucas Hamilton's explicit one.
const MANUAL_OVERRIDES = 18

// The cast the user records their video with: it must never change. [full name, email, department, has a card, has a login]
// (one row per scenario staff member).
const ROSTER: [string, string, string, boolean, boolean][] = [
  ['Emma Richardson', 'emma.richardson@nwu.ac.za', 'Computer Science and Information Systems', true, true],
  ['Oliver Bennett', 'oliver.bennett@nwu.ac.za', 'Physical and Chemical Sciences', true, false],
  ['Sophie Hartley', 'sophie.hartley@nwu.ac.za', 'Biological Sciences', false, true],
  ['James Whitfield', 'james.whitfield@nwu.ac.za', 'Geo- and Spatial Sciences', false, false],
  ['Charlotte Ellis', 'charlotte.ellis@nwu.ac.za', 'Agricultural Sciences', true, true],
  ['Daniel Mercer', 'daniel.mercer@nwu.ac.za', 'Mathematical and Statistical Sciences', true, false],
  ['Amelia Hayes', 'amelia.hayes@nwu.ac.za', 'Business Mathematics and Informatics', false, true],
  ['Benjamin Carter', 'benjamin.carter@nwu.ac.za', 'Computer Science and Information Systems', false, false],
  ['Grace Thornton', 'grace.thornton@nwu.ac.za', 'Physical and Chemical Sciences', true, true],
  ['Samuel Prescott', 'samuel.prescott@nwu.ac.za', 'Biological Sciences', true, false],
  ['Olivia Sinclair', 'olivia.sinclair@nwu.ac.za', 'Geo- and Spatial Sciences', false, true],
  ['Henry Caldwell', 'henry.caldwell@nwu.ac.za', 'Agricultural Sciences', false, false],
  ['Lily Fraser', 'lily.fraser@nwu.ac.za', 'Mathematical and Statistical Sciences', true, true],
  ['William Ashford', 'william.ashford@nwu.ac.za', 'Business Mathematics and Informatics', true, false],
  ['Chloe Winters', 'chloe.winters@nwu.ac.za', 'Computer Science and Information Systems', false, true],
  ['Thomas Reeves', 'thomas.reeves@nwu.ac.za', 'Physical and Chemical Sciences', false, false],
  ['Isabella Crawford', 'isabella.crawford@nwu.ac.za', 'Biological Sciences', true, true],
  ['Lucas Hamilton', 'lucas.hamilton@nwu.ac.za', 'Geo- and Spatial Sciences', true, false],
  ['Hannah Wells', 'hannah.wells@nwu.ac.za', 'Agricultural Sciences', false, true],
  ['Nathan Brooks', 'nathan.brooks@nwu.ac.za', 'Mathematical and Statistical Sciences', false, false],
  ['Victoria Lang', 'victoria.lang@nwu.ac.za', 'Business Mathematics and Informatics', true, true],
  ['Joshua Kerr', 'joshua.kerr@nwu.ac.za', 'Computer Science and Information Systems', true, false],
  ['Natalie Pierce', 'natalie.pierce@nwu.ac.za', 'Physical and Chemical Sciences', false, true],
  ['Ethan Marshall', 'ethan.marshall@nwu.ac.za', 'Biological Sciences', false, false],
  ['Rachel Dawson', 'rachel.dawson@nwu.ac.za', 'Geo- and Spatial Sciences', true, true],
  ['Adam Sutton', 'adam.sutton@nwu.ac.za', 'Agricultural Sciences', true, false],
  ['Megan Holloway', 'megan.holloway@nwu.ac.za', 'Mathematical and Statistical Sciences', false, true],
  ['Ryan Fletcher', 'ryan.fletcher@nwu.ac.za', 'Business Mathematics and Informatics', false, false],
  ['Zoe Mitchell', 'zoe.mitchell@nwu.ac.za', 'Computer Science and Information Systems', true, true],
  ['Callum Rhodes', 'callum.rhodes@nwu.ac.za', 'Physical and Chemical Sciences', true, false],
  ['Jessica Moore', 'jessica.moore@nwu.ac.za', 'Biological Sciences', false, true],
]

let db: Db
let summary: SeedSummary
let fake: ReturnType<typeof createFakeAuthAndBucket>
let admin: ReturnType<typeof adminCaller>
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
  summary = await seedComprehensive({ db, auth: fake.auth, bucket: fake.bucket, now: NOW })

  const [adminRow] = await db.select().from(profiles).where(eq(profiles.role, 'admin'))
  const [adminStaff] = await db.select().from(staff).where(eq(staff.uid, adminRow.uid))
  admin = adminCaller(adminRow.uid, adminRow.full_name, adminStaff.id)

  // Everything below is read before any test loads the Dashboard, which settles the one live no-show.
  statusCounts = Object.fromEntries(
    (await db.select({ status: loanRequests.status, n: count() }).from(loanRequests).groupBy(loanRequests.status)).map((r) => [r.status, r.n]),
  )
  auditCounts = Object.fromEntries(
    (
      await db
        .select({ key: sql<string>`${auditLog.entity_type} || ' ' || ${auditLog.action}`, n: count() })
        .from(auditLog)
        .groupBy(auditLog.entity_type, auditLog.action)
    ).map((r) => [r.key, r.n]),
  )
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

describe('seed clock', () => {
  it('isoAt is addDays(TODAY, offset) at 09:00 in Africa/Johannesburg, whatever the machine zone', () => {
    const clock = seedClock(new Date('2026-10-04T12:00:00Z'))
    expect(clock.today).toBe('2026-10-04')
    expect(clock.isoAt(0)).toBe('2026-10-04T07:00:00.000Z')
    expect(clock.isoAt(-1)).toBe('2026-10-03T07:00:00.000Z')
    expect(clock.isoAt(-30)).toBe('2026-09-04T07:00:00.000Z')
    expect(clock.isoAt(0, 30)).toBe('2026-10-04T07:30:00.000Z')
  })

  it("takes TODAY from the Johannesburg day, not UTC's (23:30 UTC on the 3rd is already the 4th there)", () => {
    const clock = seedClock(new Date('2026-10-03T23:30:00Z'))
    expect(clock.today).toBe('2026-10-04')
    expect(clock.isoAt(0)).toBe('2026-10-04T07:00:00.000Z')
    expect(seedClock(new Date('2026-10-03T21:59:00Z')).today).toBe('2026-10-03')
  })
})

describe('safety rails', () => {
  it('refuses a database that is not on this machine unless told explicitly', () => {
    expect(() => assertLocalDatabaseUrl('postgres://u:p@db.example.com:5432/smartstock')).toThrow(/db\.example\.com/)
    expect(() => assertLocalDatabaseUrl('postgres://u:p@10.0.0.5:5432/smartstock')).toThrow(/Refusing/)
    expect(() => assertLocalDatabaseUrl('postgres://u:p@127.0.0.1:5432/smartstock')).not.toThrow()
    expect(() => assertLocalDatabaseUrl('postgres://u:p@localhost/smartstock')).not.toThrow()
    expect(() => assertLocalDatabaseUrl('postgres://u:p@[::1]:5432/smartstock')).not.toThrow()
    expect(() => assertLocalDatabaseUrl('postgres://u:p@db.example.com/smartstock', true)).not.toThrow()
    expect(() => assertLocalDatabaseUrl('not a url')).toThrow(/Refusing/)
  })

  it('checks the host the pg driver will really use: ?host= and ?hostaddr= override the URL host, lists are checked whole', () => {
    expect(() => assertLocalDatabaseUrl('postgres://u:p@localhost/db?host=db.example.com')).toThrow(/db\.example\.com/)
    expect(() => assertLocalDatabaseUrl('postgres://u:p@localhost/db?hostaddr=10.0.0.5')).toThrow(/10\.0\.0\.5/)
    expect(() => assertLocalDatabaseUrl('postgres://u:p@127.0.0.1/db?hostaddr=10.0.0.5&host=localhost')).toThrow(/10\.0\.0\.5/)
    expect(() => assertLocalDatabaseUrl('postgres://u:p@localhost,db.example.com/db')).toThrow(/db\.example\.com/)
    expect(() => assertLocalDatabaseUrl('postgres://u:p@localhost/db?host=db.example.com', true)).not.toThrow()
    // both local: fine
    expect(() => assertLocalDatabaseUrl('postgres://u:p@localhost/db?hostaddr=127.0.0.1')).not.toThrow()
  })

  it('treats a unix-socket path as local', () => {
    expect(() => assertLocalDatabaseUrl('postgres:///smartstock?host=/var/run/postgresql')).not.toThrow()
    expect(() => assertLocalDatabaseUrl('postgres://u:p@%2Fvar%2Frun%2Fpostgresql/smartstock')).not.toThrow()
    expect(() => assertLocalDatabaseUrl('postgres://u:p@localhost/smartstock?host=/tmp')).not.toThrow()
    expect(databaseHosts('postgres:///smartstock?host=/var/run/postgresql')).toEqual(['/var/run/postgresql'])
  })

  it('checks the open connection too, so the seed function itself cannot be pointed at a remote database', () => {
    const open = (options: Record<string, unknown>) => ({ $client: { options } }) as unknown as Db
    expect(() => assertLocalDatabase(open({ connectionString: 'postgres://u:p@db.example.com/x' }))).toThrow(/db\.example\.com/)
    expect(() => assertLocalDatabase(open({ connectionString: 'postgres://u:p@db.example.com/x' }), true)).not.toThrow()
    expect(() => assertLocalDatabase(open({ connectionString: 'postgres://u:p@localhost/x?host=db.example.com' }))).toThrow(/db\.example\.com/)
    expect(() => assertLocalDatabase(open({ connectionString: 'postgres://u:p@localhost/x?hostaddr=10.0.0.5' }))).toThrow(/10\.0\.0\.5/)
    expect(() => assertLocalDatabase(open({ host: 'db.example.com', database: 'x' }))).toThrow(/db\.example\.com/)
    expect(() => assertLocalDatabase(open({ host: '/var/run/postgresql', database: 'x' }))).not.toThrow()
    expect(() => assertLocalDatabase(db)).not.toThrow()
  })

  it('only talks to emulators: both hosts must be set and local', () => {
    expect(() => assertEmulatorEnv({})).toThrow(/FIREBASE_AUTH_EMULATOR_HOST is not set/)
    expect(() => assertEmulatorEnv({ FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' })).toThrow(/FIREBASE_STORAGE_EMULATOR_HOST is not set/)
    expect(() => assertEmulatorEnv({ FIREBASE_AUTH_EMULATOR_HOST: 'auth.example.com:9099', FIREBASE_STORAGE_EMULATOR_HOST: '127.0.0.1:9199' })).toThrow(/this machine/)
    expect(() => assertEmulatorEnv({ FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099', FIREBASE_STORAGE_EMULATOR_HOST: 'localhost:9199' })).not.toThrow()
  })

  it('also rejects a non-local STORAGE_EMULATOR_HOST, which firebase-admin prefers over FIREBASE_STORAGE_EMULATOR_HOST', () => {
    const local = { FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099', FIREBASE_STORAGE_EMULATOR_HOST: '127.0.0.1:9199' }
    expect(() => assertEmulatorEnv({ ...local, STORAGE_EMULATOR_HOST: 'https://storage.googleapis.com' })).toThrow(/STORAGE_EMULATOR_HOST is "https:\/\/storage\.googleapis\.com"/)
    expect(() => assertEmulatorEnv({ ...local, STORAGE_EMULATOR_HOST: 'storage.example.com:9199' })).toThrow(/this machine/)
    expect(() => assertEmulatorEnv({ ...local, STORAGE_EMULATOR_HOST: 'http://127.0.0.1:9199' })).not.toThrow()
    expect(() => assertEmulatorEnv({ ...local, STORAGE_EMULATOR_HOST: 'localhost:9199' })).not.toThrow()
  })

  it('checks that both emulators answer before anything is written, so a down Storage emulator cannot leave a half-seeded database', async () => {
    const listen = (): Promise<net.Server> => new Promise((resolve) => { const srv = net.createServer((c) => c.destroy()); srv.listen(0, '127.0.0.1', () => resolve(srv)) })
    const portOf = (srv: net.Server) => (srv.address() as net.AddressInfo).port
    const authUp = await listen()
    const storageUp = await listen()
    const down = await listen()
    const downPort = portOf(down)
    await new Promise((r) => down.close(r))
    try {
      const env = (storagePort: number) => ({ FIREBASE_AUTH_EMULATOR_HOST: `127.0.0.1:${portOf(authUp)}`, FIREBASE_STORAGE_EMULATOR_HOST: `127.0.0.1:${storagePort}` })
      await expect(assertEmulatorsReachable(env(portOf(storageUp)))).resolves.toBeUndefined()
      await expect(assertEmulatorsReachable(env(downPort))).rejects.toThrow(/FIREBASE_STORAGE_EMULATOR_HOST .* is not reachable.*nothing was written/)
      await expect(assertEmulatorsReachable({ ...env(portOf(storageUp)), FIREBASE_AUTH_EMULATOR_HOST: `127.0.0.1:${downPort}` })).rejects.toThrow(/FIREBASE_AUTH_EMULATOR_HOST .* is not reachable/)
    } finally {
      await new Promise((r) => authUp.close(r))
      await new Promise((r) => storageUp.close(r))
    }
  })

  it('refuses to run again on a database that already has data (the ledger is append-only)', async () => {
    await expect(seedComprehensive({ db, auth: fake.auth, bucket: fake.bucket, now: NOW })).rejects.toThrow(/already has data/)
    // and left it untouched
    expect(await tableCount(staff)).toBe(32)
  })
})

describe('logins', () => {
  it('creates the administrator and the portal borrower, with the same names, emails and password', () => {
    expect(summary.adminName).toBe('Jonathan Pritchard')
    expect(summary.adminEmail).toBe('jonathan.pritchard@nwu.ac.za')
    expect(summary.portalBorrower).toEqual({ fullName: 'Jessica Moore', email: 'jessica.moore@nwu.ac.za' })
    const byEmail = new Map([...fake.users.values()].map((u) => [u.email, u]))
    expect(byEmail.get('jonathan.pritchard@nwu.ac.za')).toMatchObject({ uid: 'seed-admin', password: 'password123' })
    expect(byEmail.get('jessica.moore@nwu.ac.za')).toMatchObject({ uid: 'seed-demo-portallinked-uid', password: 'password123' })
  })

  it('creates 17 Auth users: the administrator, the portal borrower and 15 other staff', () => {
    expect(fake.users.size).toBe(17)
    expect(summary.otherPortalEmails).toHaveLength(15)
    for (const email of summary.otherPortalEmails) expect([...fake.users.values()].some((u) => u.email === email)).toBe(true)
  })

  it('every login resolves to the right caller: the administrator is admin, Jessica is staff linked to her record', async () => {
    const adminCallerRow = await loadCaller(db, 'seed-admin')
    expect(adminCallerRow).toMatchObject({ uid: 'seed-admin', name: 'Jonathan Pritchard', role: 'admin' })
    expect(adminCallerRow.staffId).not.toBeNull()
    const jessica = await loadCaller(db, 'seed-demo-portallinked-uid')
    expect(jessica).toMatchObject({ role: 'staff', name: 'Jessica Moore' })
    const [row] = await db.select().from(staff).where(eq(staff.email, 'jessica.moore@nwu.ac.za'))
    expect(jessica.staffId).toBe(row.id)
    for (const user of fake.users.values()) {
      const caller = await loadCaller(db, user.uid)
      expect(caller.staffId, user.email).not.toBeNull()
      expect(caller.role).toBe(user.uid === 'seed-admin' ? 'admin' : 'staff')
    }
  })
})

describe('staff', () => {
  it('has exactly the 31 scenario staff: names, emails, departments, cards and logins', async () => {
    const rows = await db.select().from(staff).where(eq(staff.is_admin_account, false))
    expect(rows).toHaveLength(31)
    expect(ROSTER).toHaveLength(31)
    const actual = rows
      .map((r): [string, string, string | null, boolean, boolean] => [r.full_name, r.email as string, r.department, r.card_uid !== null, r.uid !== null])
      .sort((x, y) => x[0].localeCompare(y[0]))
    expect(actual).toEqual([...ROSTER].sort((x, y) => x[0].localeCompare(y[0])))
    expect(summary.staff.map((m) => m.fullName)).toEqual(ROSTER.map((r) => r[0]))
    // Everyone is active except Callum Rhodes (his badge was switched off).
    expect(rows.filter((r) => !r.is_active).map((r) => r.full_name)).toEqual(['Callum Rhodes'])
  })

  it("has the administrator's own hidden borrower record, and Jessica Moore's login linked to her record", async () => {
    const rows = await db.select().from(staff)
    expect(rows).toHaveLength(32)
    expect(rows.find((r) => r.is_admin_account)).toMatchObject({
      full_name: 'Jonathan Pritchard', email: 'jonathan.pritchard@nwu.ac.za', uid: 'seed-admin', department: 'Computer Science and Information Systems', card_uid: null,
    })
    expect(rows.find((r) => r.full_name === 'Jessica Moore')).toMatchObject({ uid: 'seed-demo-portallinked-uid', card_uid: null })
  })

  it('creates the staff and the catalogue one row after another, so created_at follows the order they were set up in', async () => {
    const rows = await db.select().from(staff).where(eq(staff.is_admin_account, false))
    const inCreationOrder = [...rows].sort((a, b) => a.created_at.getTime() - b.created_at.getTime()).map((r) => r.full_name)
    expect(inCreationOrder).toEqual(ROSTER.map((r) => r[0]))
    expect(new Set(rows.map((r) => r.created_at.getTime())).size).toBe(31)
    const cats = await db.select().from(categories)
    expect(new Set(cats.filter((c) => c.name !== 'Office Accessories').map((c) => c.created_at.getTime())).size).toBe(7)
    const prods = await db.select().from(products)
    expect(new Set(prods.map((p) => p.created_at.getTime())).size).toBe(25)
  })
})

describe('loan requests', () => {
  it('has every status in the expected numbers', () => {
    expect(statusCounts).toEqual({ pending: 5, countered: 5, accepted: 7, no_show: 3, expired: 3, fulfilled: 3, declined: 7, withdrawn: 4 })
  })

  it("gives Jessica Moore's History more than the 10-row page size (12 terminal requests) and every other tab several rows", async () => {
    const [jessica] = await db.select().from(staff).where(eq(staff.email, 'jessica.moore@nwu.ac.za'))
    const own = seedCtx(db, NOW, { uid: 'seed-demo-portallinked-uid', name: 'Jessica Moore', role: 'staff', staffId: jessica.id })
    const mine = await listRequests(own, {})
    const of = (...statuses: string[]) => mine.filter((r) => statuses.includes(r.status)).length
    const history = of('fulfilled', 'declined', 'expired', 'no_show', 'withdrawn')
    expect(history).toBe(12)
    expect(history).toBeGreaterThan(10)
    expect(of('countered')).toBe(3)
    expect(of('pending')).toBe(3)
    expect(of('accepted')).toBe(3)
    expect(mine).toHaveLength(21)
  })

  it('creates every request at a past Johannesburg 09:00 (the staff member\'s own save, with the clock stopped there)', async () => {
    const rows = await db.select().from(loanRequests)
    for (const r of rows) {
      const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Johannesburg', hour: '2-digit', hourCycle: 'h23' }).format(r.created_at))
      expect(hour, `${r.reference_no} created at ${r.created_at.toISOString()}`).toBe(9)
      expect(r.created_at.getTime()).toBeLessThan(NOW.getTime())
    }
  })
})

describe('tables and audit log', () => {
  it('has the row counts listed in the header', () => {
    expect(tableCounts).toEqual({
      audit_log: 206,
      categories: 8,
      loan_request_lines: 44,
      loan_requests: 37,
      products: 25,
      profiles: 1,
      return_waivers: 1,
      settings: 1,
      staff: 32,
      transaction_lines: 61,
      transactions: 31,
    })
  })

  it('has the expected transaction mix', async () => {
    const rows = await db.select({ type: transactions.transaction_type, n: count() }).from(transactions).groupBy(transactions.transaction_type)
    expect(Object.fromEntries(rows.map((r) => [r.type, r.n]))).toEqual({ OUT: 23, IN: 3, ADJUST: 1, RETURN: 4 })
  })

  it("records the manual overrides: every Stock Out / Return of a staff member without a card, plus Lucas Hamilton's explicit one", async () => {
    const rows = await db
      .select({ type: transactions.transaction_type, manual: transactions.manual_override, who: transactions.staff_name, card: staff.card_uid, notes: transactions.notes })
      .from(transactions)
      .leftJoin(staff, eq(staff.id, transactions.staff_id))
    const withStaff = rows.filter((r) => r.type === 'OUT' || r.type === 'RETURN')
    // The rule: no card on file -> picked from the list; otherwise only when the scenario says so.
    for (const r of withStaff) {
      if (r.card === null) expect(r.manual, `${r.type} for ${r.who}`).toBe(true)
    }
    const manual = withStaff.filter((r) => r.manual)
    // Lucas Hamilton has a card; his "No Return Date" walk-in was still entered manually, as the old seed said.
    const lucas = withStaff.filter((r) => r.who === 'Lucas Hamilton')
    expect(lucas).toHaveLength(1)
    expect(lucas[0]).toMatchObject({ type: 'OUT', manual: true, notes: 'Staff selected manually (no card scan)' })
    expect(lucas[0].card).not.toBeNull()
    // Pinned: the only manual entry by someone with a card is Lucas's; the rest are staff without one.
    expect(manual.filter((r) => r.card !== null).map((r) => r.who)).toEqual(['Lucas Hamilton'])
    expect(manual).toHaveLength(MANUAL_OVERRIDES)
    // Stock In and ADJUST have no staff step to bypass.
    expect(rows.filter((r) => r.type === 'IN' || r.type === 'ADJUST').every((r) => !r.manual)).toBe(true)
  })

  it('has the audit counts per entity and action listed in the header', () => {
    expect(auditCounts).toEqual({
      'category create': 8,
      'category update': 1,
      'staff create': 31,
      'staff update': 1,
      'staff activate': 1,
      'staff deactivate': 2,
      'staff grant_access': 16,
      'staff resend_access': 1,
      'product create': 25,
      'product update': 3,
      'transaction create': 31,
      'transaction resolve': 1,
      'loan_request create': 37,
      'loan_request update': 46,
      'settings update': 2,
    })
  })

  it('records the system expiries and no-shows as the system, at the moment they became due', async () => {
    const rows = await db.select().from(auditLog).where(eq(auditLog.user_name, 'System (automatic)'))
    expect(rows).toHaveLength(6)
    for (const r of rows) expect(r.user_id).toBeNull()
  })

  it('stamps every audit entry in the past and attributes the administrator\'s to the administrator', async () => {
    const rows = await db.select().from(auditLog)
    for (const r of rows) expect(r.created_at.getTime()).toBeLessThan(NOW.getTime())
    const adminEntries = rows.filter((r) => r.user_id === 'seed-admin')
    expect(adminEntries.length).toBeGreaterThan(100)
    expect(new Set(adminEntries.map((r) => r.user_name))).toEqual(new Set(['Jonathan Pritchard']))
  })
})

describe('products', () => {
  it('has the 25 products, each with 1-3 photos uploaded', async () => {
    const rows = await db.select().from(products)
    expect(rows).toHaveLength(25)
    for (const p of rows) {
      expect(p.images.length, p.name).toBeGreaterThanOrEqual(1)
      expect(p.images.length, p.name).toBeLessThanOrEqual(3)
      for (const path of p.images) {
        expect(path.startsWith(`products/${p.id}/`), path).toBe(true)
        expect(fake.files.has(path), path).toBe(true)
      }
    }
  })

  it('ends at the expected stock levels', async () => {
    const rows = await db.select({ name: products.name, qty: products.quantity_on_hand }).from(products)
    const qty = Object.fromEntries(rows.map((r) => [r.name, r.qty]))
    expect(qty).toMatchObject({
      'Wireless Mouse': 23, // 25 - 2 walk-in
      'Ethernet Patch Cable Cat6': 4,
      'Solid State Drive 1TB': 0,
      'Desktop PC': 1, // 3 - 2 overdue
      'UPS Battery Backup 1500VA': 1,
      'USB-C Cable 1m': 8, // 9 in, 3 out, 3 back, 3 out, 2 back
      'Surge Protector Power Strip': 11, // +1 adjust
    })
  })

  it('keeps the one deliberately legacy product without a lending interval', async () => {
    const rows = await db.select({ name: products.name, interval: products.lending_interval }).from(products).where(sql`${products.lending_interval} is null`)
    expect(rows.map((r) => r.name)).toEqual(['Surge Protector Power Strip'])
  })
})

describe('Dashboard', () => {
  it('shows every Outstanding Returns badge, with the holders the scenarios name', async () => {
    const { outstandingReturns } = await loadDashboard(ctxNow())
    const row = (staffName: string, product: string) => outstandingReturns.find((o) => o.staff_name === staffName && o.product_name === product)
    expect(row('Lucas Hamilton', 'External Hard Drive 2TB')).toMatchObject({ qty: 1, status: 'no_return_date' })
    expect(row('Hannah Wells', 'Ultrabook Laptop 14-inch')).toMatchObject({ qty: 2, status: 'overdue' })
    expect(row('Nathan Brooks', 'USB Flash Drive 64GB')).toMatchObject({ qty: 1, status: 'due_today' })
    expect(row('Victoria Lang', 'HDMI Cable 2m')).toMatchObject({ qty: 3, status: 'not_due_yet' })
    // Partly resolved: one unit written off, one issued again and still out.
    expect(row('Joshua Kerr', '24-inch Monitor')).toMatchObject({ qty: 1, status: 'not_due_yet' })
    // One holder, three states at once.
    expect(row('Natalie Pierce', 'External Hard Drive 2TB')).toMatchObject({ status: 'no_return_date' })
    expect(row('Natalie Pierce', 'Ultrabook Laptop 14-inch')).toMatchObject({ status: 'overdue' })
    expect(row('Natalie Pierce', 'USB Flash Drive 64GB')).toMatchObject({ status: 'due_today' })
    // The overdue return behind the short pickup.
    expect(row('Amelia Hayes', 'Desktop PC')).toMatchObject({ qty: 2, status: 'overdue' })
    // Partial returns leave the rest out.
    expect(row('Megan Holloway', 'USB-C Cable 1m')).toMatchObject({ qty: 1, status: 'due_today' })
    expect(row('Megan Holloway', 'DisplayPort Cable 2m')).toMatchObject({ qty: 1, status: 'due_today' })
    expect(row('Rachel Dawson', 'Network Switch 24-Port')).toMatchObject({ qty: 2, status: 'not_due_yet' })
    expect(row('Ryan Fletcher', '27-inch Monitor')).toMatchObject({ qty: 3 })
    // Fully returned or fully written off: gone.
    expect(row('Ethan Marshall', 'Compact Wireless Mouse')).toBeUndefined()
    expect(row('Adam Sutton', 'USB-C Cable 1m')).toBeUndefined()
    const statuses = new Set(outstandingReturns.map((o) => o.status))
    expect(statuses).toEqual(new Set(['no_return_date', 'overdue', 'due_today', 'not_due_yet']))
    expect(outstandingReturns.filter((o) => o.status === 'overdue').length).toBeLessThan(outstandingReturns.filter((o) => o.status === 'not_due_yet').length)
  })

  it('shows Incoming Pickups: On Schedule, and two Insufficient (one with an overdue cause, one without)', async () => {
    const { incomingPickups, pickupLines, overdueByProduct } = await loadDashboard(ctxNow())
    const pickup = (name: string) => incomingPickups.find((p) => p.staff_name === name)
    expect(pickup('Charlotte Ellis')).toMatchObject({ insufficient: false, noShow: false })
    expect(pickup('Daniel Mercer')).toMatchObject({ insufficient: true })
    expect(pickup('Benjamin Carter')).toMatchObject({ insufficient: true })
    expect(incomingPickups.filter((p) => p.insufficient).map((p) => p.staff_name).sort()).toEqual(['Benjamin Carter', 'Daniel Mercer'])
    const short = Object.values(pickupLines).flat().filter((l) => l.shortBy > 0)
    expect(short.map((l) => l.product_name).sort()).toEqual(['Desktop PC', 'UPS Battery Backup 1500VA'])
    // With a likely cause (Amelia Hayes's overdue Desktop PCs), and without (nobody holds a UPS).
    const desktop = short.find((l) => l.product_name === 'Desktop PC')!
    const ups = short.find((l) => l.product_name === 'UPS Battery Backup 1500VA')!
    expect(overdueByProduct[desktop.product_id]).toMatchObject([{ staff_name: 'Amelia Hayes', qty: 2 }])
    expect(overdueByProduct[ups.product_id]).toBeUndefined()
  })

  it('settles the live "Not Picked Up" request on the first load, once, as the system, and lists the other pickups', async () => {
    // (the first Dashboard test above already loaded it; loading again must not settle anything twice)
    const before = (await db.select({ n: count() }).from(auditLog))[0].n
    const { incomingPickups } = await loadDashboard(ctxNow())
    await loadDashboardAlertCounts(ctxNow())
    expect((await db.select({ n: count() }).from(auditLog))[0].n).toBe(before)
    expect(incomingPickups.map((p) => p.staff_name)).not.toContain('Grace Thornton')
    const [grace] = await db.select().from(loanRequests).where(eq(loanRequests.staff_name, 'Grace Thornton'))
    expect(grace.status).toBe('no_show')
    const noShowAudits = await db.select().from(auditLog).where(eq(auditLog.entity_id, grace.id))
    expect(noShowAudits.filter((a) => a.user_name === 'System (automatic)')).toHaveLength(1)
    // 7 accepted - the one that just flipped; the three portal pickups are among the 6
    expect(incomingPickups).toHaveLength(6)
  })

  it('lists the low-stock and out-of-stock alerts', async () => {
    const { lowStock } = await loadDashboard(ctxNow())
    const byName = Object.fromEntries(lowStock.map((l) => [l.name, l.status]))
    expect(byName[summary.lowStockProductName]).toBe('low_stock')
    expect(byName[summary.outOfStockProductName]).toBe('out_of_stock')
    expect(summary.lowStockProductName).toBe('Ethernet Patch Cable Cat6')
    expect(summary.outOfStockProductName).toBe('Solid State Drive 1TB')
    // Desktop PC (1 <= 2) and UPS (1 <= 3) are low because of the pickup scenarios.
    expect(Object.keys(byName).sort()).toEqual(['Desktop PC', 'Ethernet Patch Cable Cat6', 'Solid State Drive 1TB', 'UPS Battery Backup 1500VA'])
  })
})

describe('reports and the printed summary', () => {
  it('Returns has two full and two partial returns, and Issued per Staff lists every holder with their Stock Outs', async () => {
    const { returns } = await loadReport(ctxNow(), { report: 'returns' })
    expect(returns).toHaveLength(4)
    expect(returns.filter((r) => r.partial).map((r) => r.staff_name).sort()).toEqual(['Megan Holloway', 'Rachel Dawson'])
    expect(returns.filter((r) => !r.partial).map((r) => r.staff_name).sort()).toEqual(['Adam Sutton', 'Ethan Marshall'])
    const { staff: holders } = await loadReport(ctxNow(), { report: 'issued-per-staff' })
    const withStockOuts = holders.filter((h) => h.txns.length > 0)
    expect(withStockOuts).toHaveLength(15)
    expect(withStockOuts.find((h) => h.full_name === 'Henry Caldwell')?.txns).toHaveLength(4)
  })

  it('prints the old wording: logins, who is who, the audit-log hint', () => {
    const text = summaryLines(summary).join('\n')
    expect(text).toContain('Seeded comprehensive demo data:')
    expect(text).toContain('BICS admin:      jonathan.pritchard@nwu.ac.za / password123')
    expect(text).toContain('Portal borrower: jessica.moore@nwu.ac.za / password123 -> http://localhost:3000/login')
    expect(text).toContain('WHO IS WHO (each staff member demonstrates one scenario):')
    expect(text).toContain('Emma Richardson      Pending loan request (fresh); staff create/update audit')
    expect(text).toContain('LOST LABELS: Returns -> "Ryan Fletcher" has one row per product (3 x 27-inch Monitor,')
    expect(text).toContain('Run alongside: npm run dev:emulators')
  })
})

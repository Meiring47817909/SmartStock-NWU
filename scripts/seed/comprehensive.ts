// Seeds the local PostgreSQL database (and the Firebase Auth / Storage emulators) with one comprehensive demo dataset
// covering essentially every distinct status/badge/label the app can show, in one place, so the whole thing can be
// eyeballed in one sitting:
//
//   - Dashboard -> Outstanding Returns: No Return Date, Overdue, Due Today, Not Due Yet, Partly Resolved (waived), Mixed
//     (one holder, 3 states), plus partial returns whose remaining items are not yet due.
//   - Dashboard -> Incoming Pickups: On Schedule, Insufficient (with a correlated overdue return as the "likely cause"),
//     Insufficient (no overdue return to blame -- the fallback message), and a Not Picked Up request that is still
//     'accepted' with its pickup window passed, so the first Dashboard load settles it as a no-show (as the system), plus
//     three already recorded as permanent no_shows for stable inspection.
//   - Dashboard -> Low Stock Alerts: Low stock and Out of stock.
//   - Loan Requests -> every LoanRequestStatus: pending (fresh + near expiry), countered (a rich one with a removed line,
//     both sides' optional messages and a date change, and a plain one), accepted, fulfilled (a full pending -> countered
//     -> accepted -> fulfilled history), declined (by the administrator from pending, from an already-sent counter, and
//     by the staff member themselves via the portal), expired, no_show and withdrawn (by staff with no reason, by the
//     administrator cancelling a pickup with one).
//   - Reports: IN/OUT/RETURN/ADJUST transactions across several staff and products, a full return, a partial return, and
//     portal pickups that are really linked to their loan request (linked_request_id).
//   - Product images: every product gets 1-3 photos uploaded to the Storage emulator.
//   - Audit Log: an entry for every entity_type/action combination a real code path produces.
//
// seed:demo (demo.ts) is this same seed with a different cast: `seedComprehensive({ ..., cast })` takes who the administrator
// is and which staff act out which scenario (default: COMPREHENSIVE_CAST, the made-up staff of the spin video, which must
// never change), and skips the scenarios the cast has no staff member for (OPTIONAL_SCENARIOS).
//
// Everything is written through the data layer (src/server/data/*) -- the same functions the API routes call -- with the
// clock stopped at each scenario's historical moment (`seedCtx`), so history reads exactly as if it had happened then.
// The only raw writes are listed at the foot of this comment:
//   1. the administrator's `profiles` row (the app has no function that creates one; the admin login is created in the
//      Firebase console, not in the app);
//   2. the Surge Protector's `lending_interval` set to NULL (the deliberately pre-Lending-Interval legacy shape;
//      createProduct always writes an interval).
//
// This is the only seed that also provisions Firebase Auth logins (password123), so running just this one is enough to
// sign into the app: it creates the BICS admin login and a linked portal-borrower login, plus a login for every other
// staff member who has portal access.
//
// Run it with the emulators and PostgreSQL up:
//   npm run emulators         (Auth + Storage emulators)
//   npm run db                (or any local PostgreSQL)  then  npm run db:migrate
//   npm run seed:comprehensive
//
// It refuses to run against a database that already has data (the ledger and audit tables are append-only, so a second run
// would pile a second batch on top): run `npm run db:reset` first, or pass `--reset` to clear the app tables for you
// (`--reset` refuses a database not named smartstock or smartstock_test unless `--force` is given). It
// refuses a PostgreSQL that is not on 127.0.0.1/localhost unless `--allow-non-local-db` is given, and it only talks to
// emulators. `--dry-auth` runs the whole seed with in-memory stand-ins for the Auth and Storage emulators (nothing is
// uploaded and no logins exist) -- for checking the database side without the emulators running.
import { eq } from 'drizzle-orm'
import {
  adminCaller,
  assertEmptyDatabase,
  assertLocalDatabase,
  assertLocalDatabaseUrl,
  cardUidFor,
  createEmulatorAuthAndBucket,
  createFakeAuthAndBucket,
  createProductImageSeeder,
  resetAppTables,
  SEED_PASSWORD,
  seedClock,
  seedCtx,
  staffCaller,
  SYSTEM_CALLER,
  upsertSeedUser,
  type SeedAuth,
  type SeedBucket,
} from './context'
import { assertResettableDatabase } from '../dbGuard'
import type { Caller } from '@/server/context'
import { closeDb, getDb, type Db } from '@/server/db/client'
import { newId } from '@/server/db/ids'
import { products, profiles } from '@/server/db/schema'
import { createCategory, createProduct, updateCategory, updateProduct } from '@/server/data/catalog'
import {
  createStaff,
  linkStaffLogin,
  logResendAccess,
  setStaffActive,
  updateOwnDetails,
  updateStaff,
} from '@/server/data/staff'
import {
  recordAdjust,
  recordReturn,
  recordStockIn,
  recordStockOut,
  createReturnWaiver,
} from '@/server/data/stock'
import {
  acceptCounter,
  approveAsIs,
  declineCounter,
  declineRequest,
  expireIfNeeded,
  getRequest,
  sendCounter,
  submitLoanRequest,
  withdrawRequest,
} from '@/server/data/loanRequests'
import { saveAddress } from '@/server/data/settings'
import type { ProductInput } from '@/lib/catalogRules'
import type { StockItemInput } from '@/lib/stockRules'
import type { LendingInterval, LoanRequestStatus } from '@/types/database'

export const LOCATION = 'NWU - Potchefstroom, Building G4, Room 28'
const DEPARTMENT = 'Computer Science and Information Systems'
// Settings -> Notifications: the system sending address (every email comes From it).
const SYSTEM_FROM_EMAIL = 'noreply@smartstock-nwu.com'
const PORTAL_BORROWER_UID = 'seed-demo-portallinked-uid'
// When the catalogue, the staff roster and the settings were set up: before the oldest scenario (a request made 65 days ago).
const SETUP = -70


// ---------------------------------------------------------------------------------------------------------------------------
// The cast: who the administrator is and which staff act out the scenarios. seed:comprehensive uses COMPREHENSIVE_CAST (the
// made-up staff of the spin video, which must never change); seed:demo (demo.ts) passes its own with real NWU staff. The
// scenarios, products, categories, stock and audit history are the same either way.
// ---------------------------------------------------------------------------------------------------------------------------

/** One scenario staff member. `key` names the scenario they act out (see the scenarios below). */
export interface SeedCastMember {
  key: string
  name: string
  surname: string
  email: string
  department: string
  /** What this person demonstrates (printed in the "who is who" legend). */
  scenario: string
  /** The department the record is created in, when a later edit (the staff "update" audit entry) moves them to `department`. */
  startDepartment?: string
  /** The card on file is `cardUidFor(cardIndex)`; null means no card on file. */
  cardIndex: number | null
  /** Whether this person gets a real Firebase Auth login (password123) and a login link. The PortalLinked member must. */
  login: boolean
}

/** What a cast's `extras` hook is given, once the catalogue exists and before any stock moves. */
export interface SeedExtrasHelpers {
  db: Db
  admin: Caller
  /** Category id by category name (the 7 standard categories). */
  categoryId: Record<string, string>
  location: string
}

export interface SeedCast {
  /** First line of the printed summary. */
  title: string
  admin: { uid: string; name: string; email: string }
  /** In creation order. A scenario whose key is not in the list is not seeded (see OPTIONAL_SCENARIOS). */
  staff: SeedCastMember[]
  /** Anything the cast adds on top of the shared catalogue (seed:demo adds one product). */
  extras?: (helpers: SeedExtrasHelpers) => Promise<void>
  /** Paragraphs (lines) the summary prints just before the "who is who" legend. */
  notes?: string[][]
}

/**
 * The scenarios a cast may leave out: no other scenario depends on their staff member, so each is skipped when its key is
 * missing. Every other key is required (other scenarios build on them).
 */
export const OPTIONAL_SCENARIOS = [
  'CounteredSimple',
  'NoShowLive',
  'ExpiredRecorded',
  'DeclinedPending',
  'WithdrawnByStaff',
  'ReturnNoDate',
  'ReturnOverdue',
  'ReturnDueToday',
  'ReturnCompleted',
  'ReturnPartial',
] as const

/** Card / login mix spread evenly over a 31-person roster (index mod 4): card + login, card only, login only, neither. */
export const hasCardAt = (index: number): boolean => index % 4 === 0 || index % 4 === 1
export const hasLoginAt = (index: number): boolean => index % 4 === 0 || index % 4 === 2

type CastRow = [key: string, name: string, surname: string, email: string, department: string, scenario: string]

// The departments the comprehensive cast is spread over.
const D = {
  phys: 'Physical and Chemical Sciences',
  bio: 'Biological Sciences',
  geo: 'Geo- and Spatial Sciences',
  agri: 'Agricultural Sciences',
  math: 'Mathematical and Statistical Sciences',
  cs: 'Computer Science and Information Systems',
  bmi: 'Business Mathematics and Informatics',
}
const COMPREHENSIVE_ROWS: CastRow[] = [
  ['PendingFresh', 'Emma', 'Richardson', 'emma.richardson@gmail.com', D.cs, 'Pending loan request (fresh); staff create/update audit'],
  ['PendingNearExpiry', 'Oliver', 'Bennett', 'oliver.bennett92@gmail.com', D.phys, 'Pending loan request, close to expiring'],
  ['CounteredRich', 'Sophie', 'Hartley', 'sophie.hartley@gmail.com', D.bio, 'Counter-offer with removed line, messages and date change'],
  ['CounteredSimple', 'James', 'Whitfield', 'james.whitfield@gmail.com', D.geo, 'Plain counter-offer'],
  ['AcceptedOnSchedule', 'Charlotte', 'Ellis', 'charlotte.ellis88@gmail.com', D.agri, 'Accepted request, pickup on schedule'],
  ['InsufficientCauseRecipient', 'Daniel', 'Mercer', 'daniel.mercer@gmail.com', D.math, 'Pickup short on stock, overdue return is the likely cause'],
  ['OverdueHolderCause', 'Amelia', 'Hayes', 'amelia.hayes@gmail.com', D.bmi, 'Holds the overdue item behind the shortage above'],
  ['InsufficientNoCauseRecipient', 'Benjamin', 'Carter', 'ben.carter.work@gmail.com', D.cs, 'Pickup short on stock, no overdue return to blame'],
  ['NoShowLive', 'Grace', 'Thornton', 'grace.thornton@gmail.com', D.phys, 'Missed pickup -- flips to Not Picked Up live on first Dashboard load'],
  ['NoShowRecorded', 'Samuel', 'Prescott', 'samuel.prescott@gmail.com', D.bio, 'Missed pickup, already recorded'],
  ['ExpiredRecorded', 'Olivia', 'Sinclair', 'olivia.sinclair@gmail.com', D.geo, 'Expired request'],
  ['FulfilledPickup', 'Henry', 'Caldwell', 'henry.caldwell@gmail.com', D.agri, 'Full pending -> countered -> accepted -> fulfilled history'],
  ['DeclinedPending', 'Lily', 'Fraser', 'lily.fraser@gmail.com', D.math, 'Declined by admin from pending'],
  ['DeclinedCounterRich', 'William', 'Ashford', 'william.ashford@gmail.com', D.bmi, 'Admin declined a rich counter-offer'],
  ['DeclinedByStaff', 'Chloe', 'Winters', 'chloe.winters@gmail.com', D.cs, 'Declined by the staff member via the portal'],
  ['WithdrawnByStaff', 'Thomas', 'Reeves', 'thomas.reeves@gmail.com', D.phys, 'Withdrawn by staff, no reason'],
  ['WithdrawnByAdmin', 'Isabella', 'Crawford', 'isabella.crawford@gmail.com', D.bio, 'Admin cancelled an accepted pickup, with a reason'],
  ['ReturnNoDate', 'Lucas', 'Hamilton', 'lucas.hamilton@gmail.com', D.geo, 'Outstanding return -- No Return Date'],
  ['ReturnOverdue', 'Hannah', 'Wells', 'hannah.wells@gmail.com', D.agri, 'Outstanding return -- Overdue'],
  ['ReturnDueToday', 'Nathan', 'Brooks', 'nathan.brooks@gmail.com', D.math, 'Outstanding return -- Due Today'],
  ['ReturnNotDueYet', 'Victoria', 'Lang', 'victoria.lang@gmail.com', D.bmi, 'Outstanding return -- Not Due Yet'],
  ['ReturnPartlyResolved', 'Joshua', 'Kerr', 'joshua.kerr@gmail.com', D.cs, 'Outstanding return -- Partly Resolved (one unit written off)'],
  ['ReturnMixedHolder', 'Natalie', 'Pierce', 'natalie.pierce@gmail.com', D.phys, 'One holder, three return states at once'],
  ['ReturnCompleted', 'Ethan', 'Marshall', 'ethan.marshall@gmail.com', D.bio, 'Fully returned'],
  ['ReturnPartial', 'Rachel', 'Dawson', 'rachel.dawson@gmail.com', D.geo, 'Partially returned, the rest not due yet'],
  ['MultiBarcodeFull', 'Adam', 'Sutton', 'adam.sutton@gmail.com', D.agri, 'Multi-product, multi-barcode Stock Out, fully returned'],
  ['MultiBarcodePartial', 'Megan', 'Holloway', 'megan.holloway@gmail.com', D.math, 'Multi-product, multi-barcode Stock Out, partly returned (rest due today)'],
  ['LostLabels', 'Ryan', 'Fletcher', 'ryan.fletcher@gmail.com', D.bmi, 'Lost-label Returns demo (relabel flow)'],
  ['BadgeActive', 'Zoe', 'Mitchell', 'zoe.mitchell@gmail.com', D.cs, 'Staff badge activated (audit log); holds two items that are not due yet'],
  ['BadgeDeactivated', 'Callum', 'Rhodes', 'callum.rhodes@gmail.com', D.phys, 'Deactivated staff badge (audit log, inactive card)'],
  ['PortalLinked', 'Jessica', 'Moore', 'jessica.moore@gmail.com', D.bio, 'Portal borrower login -- owns the My Requests history'],
]

export const COMPREHENSIVE_CAST: SeedCast = {
  title: 'Seeded comprehensive demo data:',
  admin: { uid: 'seed-admin', name: 'Jonathan Pritchard', email: 'jonathan.pritchard@nwu.ac.za' },
  staff: COMPREHENSIVE_ROWS.map(([key, name, surname, email, department, scenario], i) => ({
    key,
    name,
    surname,
    email,
    department,
    scenario,
    // Emma starts in Mathematical and Statistical Sciences: moving her to Computer Science is the staff 'update' audit
    // entry, so it is a real before/after.
    ...(key === 'PendingFresh' ? { startDepartment: D.math } : {}),
    cardIndex: hasCardAt(i) ? i : null,
    login: hasLoginAt(i),
  })),
}

/** Throws on a cast the scenarios cannot run with: an unknown key, a duplicate, or a missing required scenario. */
function assertValidCast(cast: SeedCast): void {
  const known = new Set(COMPREHENSIVE_ROWS.map((r) => r[0]))
  const optional = new Set<string>(OPTIONAL_SCENARIOS)
  const given = new Set<string>()
  for (const m of cast.staff) {
    if (!known.has(m.key)) throw new Error(`Seed cast: "${m.key}" is not a scenario.`)
    if (given.has(m.key)) throw new Error(`Seed cast: "${m.key}" is listed twice.`)
    given.add(m.key)
  }
  const missing = [...known].filter((k) => !given.has(k) && !optional.has(k))
  if (missing.length > 0) throw new Error(`Seed cast: required scenario staff missing: ${missing.join(', ')}.`)
  const login = cast.staff.find((m) => m.key === 'PortalLinked')
  if (!login?.login) throw new Error('Seed cast: the PortalLinked member must have a login.')
}

export interface SeedDeps {
  db: Db
  auth: SeedAuth
  bucket: SeedBucket
  /** The instant the seed treats as "now" (default: the real clock). Dates are all relative to its Johannesburg day. */
  now?: Date
  /** Lets the seed run against a PostgreSQL that is not on this machine. Never set it by accident. */
  allowNonLocalDb?: boolean
  /** Who the administrator and the scenario staff are (default: COMPREHENSIVE_CAST). */
  cast?: SeedCast
}

export interface SeedSummary {
  /** First line of the printed summary. */
  title: string
  adminName: string
  adminEmail: string
  systemFromEmail: string
  password: string
  portalBorrower: { fullName: string; email: string }
  /** The other staff who can sign in (same password). */
  otherPortalEmails: string[]
  lowStockProductName: string
  outOfStockProductName: string
  /** Every scenario staff member, in the order of the "who is who" legend. */
  staff: { fullName: string; scenario: string }[]
  multiBarcodeFull: string
  multiBarcodePartial: string
  lostLabels: { staff: string; monitor: string; webcam: string }
  declinedCounterRich: string
  /** Whether the live "Not Picked Up" request (settled by the first Dashboard load) was seeded. */
  liveNoShow: boolean
  /** Extra paragraphs printed before the "who is who" legend. */
  notes: string[][]
}

/** The text the CLI prints when the seed finishes. */
export function summaryLines(s: SeedSummary): string[] {
  return [
    `${s.title}\n`,
    'LOGINS:',
    `  BICS admin:      ${s.adminEmail} / ${s.password}               -> http://localhost:3000/login   (${s.adminName})`,
    `  Notifications:   administrator emails -> ${s.adminEmail}; sent from ${s.systemFromEmail}`,
    `  Portal borrower: ${s.portalBorrower.email} / ${s.password} -> http://localhost:3000/lend/login`,
    ...(s.otherPortalEmails.length > 0 ? ['  Other staff with portal access (same password): ' + s.otherPortalEmails.join(', ')] : []),
    '',
    'DASHBOARD -> Outstanding Returns: No Date / Overdue / Due Today / Not Due Yet /',
    '  Partly Resolved / Mixed holder / the Insufficient-cause overdue OUT. Mostly Not',
    '  Due Yet, a few Due Today and No Return Date, and only a handful Overdue --',
    '  expand any row to see its items.',
    '',
    'DASHBOARD -> Incoming Pickups: On Schedule, Insufficient (x2 -- one with an',
    '  overdue "likely cause" bullet, one with the fallback "worth a stock check"',
    ...(s.liveNoShow
      ? [
          '  message). One more accepted request has its whole pickup window already behind it:',
          '  your first Dashboard load settles it as Not Picked Up (as the system, once) and it',
          '  leaves the list; the others are already recorded.',
        ]
      : ['  message), and Not Picked Up (already recorded).']),
    '',
    `DASHBOARD -> Low Stock Alerts: "${s.lowStockProductName}" (low) and "${s.outOfStockProductName}" (out of stock).`,
    '',
    'LOAN REQUESTS: every status is represented -- expand any row on',
    '  Needs Review / Sent Counters, and check History for accepted/fulfilled/',
    '  declined/expired/no_show/withdrawn.',
    '',
    'MY REQUESTS (portal): sign in as the portal borrower above, then',
    '  http://localhost:3000/lend/requests -- every tab (Needs your response,',
    '  Awaiting Selouna, Upcoming, History) has several rows, and History alone',
    '  has 12 -- past the 10-row page size, so its pagination footer has a real',
    '  second page to click through.',
    '',
    'REPORTS: Stock Levels & Low Stock reflect the products above; Issued Per',
    '  Staff and Transaction History include IN/OUT/RETURN/ADJUST activity across',
    '  every staff member; Returns has a full and a partial return.',
    '',
    `MULTI-BARCODE: ${s.multiBarcodeFull} (fully returned) and ${s.multiBarcodePartial} (partly) each have a`,
    '  multi-product, multi-barcode Stock Out and a Return using exactly its barcodes;',
    '  a matching multi-barcode Stock In sits in Transaction History / Audit Log.',
    '',
    `LOST LABELS: Returns -> "${s.lostLabels.staff}" has one row per product (3 x ${s.lostLabels.monitor},`,
    `  barcode DEMO-LOSTLABEL-A; 2 x ${s.lostLabels.webcam}, barcode DEMO-LOSTPAIR-A). Scan A once, then click + twice and enter`,
    '  DEMO-LOSTLABEL-B / -C: every unit can be returned, lost labels included.',
    '',
    ...s.notes.flatMap((paragraph) => [...paragraph, '']),
    'WHO IS WHO (each staff member demonstrates one scenario):',
    ...s.staff.map((m) => `  ${m.fullName.padEnd(20)} ${m.scenario}`),
    '',
    'PRODUCT IMAGES: every product above got 1-3 product photos (scripts/catalog-images)',
    '  uploaded to the Storage emulator -- check Browse or the Products page.',
    '',
    'AUDIT LOG: filter by entity to see product/category/staff/transaction/',
    '  loan_request coverage -- including the new decline-of-a-counter rich',
    '  snapshot on "' + s.declinedCounterRich + '".',
    '',
    'Run this seed on an empty database: a second run is refused. For a clean slate run',
    '"npm run db:reset" (or add --reset to clear the app tables), and clear the Auth/Storage',
    'emulator data from http://127.0.0.1:4000 if you want those fresh as well.',
    '',
    'Run alongside: npm run dev:emulators',
    'Emulator UI: http://127.0.0.1:4000',
  ]
}

// A seeded staff member as the scenarios use them.
interface SeedStaff {
  id: string
  name: string
  surname: string
  full_name: string
  email: string
  department: string
  card_uid: string | null
  uid: string | null
}

// A seeded product: what the scenarios need, plus the full input so a later edit can change just one field.
interface SeedProduct {
  id: string
  name: string
  barcodes: string[]
  input: ProductInput
}

interface ProductSpec {
  name: string
  barcode: string
  barcodes?: string[]
  quantity_on_hand: number
  reorder_threshold: number
  lending_interval?: LendingInterval
  category: string
  image_slug: string
  description: string
  available?: boolean
}

interface LineSpec {
  product: SeedProduct
  requested: number
  /** What the counter offers (default: all that was requested). */
  offered?: number
}

interface SeedRequest {
  id: string
  staff: SeedStaff
  lines: (LineSpec & { lineId: string })[]
}

export async function seedComprehensive(deps: SeedDeps): Promise<SeedSummary> {
  const { db, auth, bucket } = deps
  const cast = deps.cast ?? COMPREHENSIVE_CAST
  assertValidCast(cast)
  const { uid: ADMIN_UID, name: ADMIN_NAME, email: ADMIN_EMAIL } = cast.admin
  assertLocalDatabase(db, deps.allowNonLocalDb)
  await assertEmptyDatabase(db)

  const clock = seedClock(deps.now)
  const { addDays, today: TODAY } = clock
  const seedImages = createProductImageSeeder(bucket)

  // ---- who a save runs as, and when ------------------------------------------------------------------------------------
  let admin: Caller = adminCaller(ADMIN_UID, ADMIN_NAME, null)
  const asAdmin = (dayOffset: number, minutes = 0) => seedCtx(db, clock.at(dayOffset, minutes), admin)
  const asStaff = (member: SeedStaff, dayOffset: number, minutes = 0) => seedCtx(db, clock.at(dayOffset, minutes), staffCaller(member))
  // The catalogue, roster and settings are set up one row after another (the old seed stamped each with the clock as it went),
  // so created_at ordering on the Staff, Products and Categories pages follows the creation order, not random ids.
  let setupTick = 0
  const setupAt = () => new Date(clock.at(SETUP).getTime() + setupTick++ * 1000)
  const asSetup = () => seedCtx(db, setupAt(), admin)
  const asSystem = (dayOffset: number) => seedCtx(db, clock.at(dayOffset), SYSTEM_CALLER)

  // =====================================================================
  // 0. LOGINS -- the Firebase Auth accounts needed to actually sign into the app, not just have data sitting in it.
  //    ADMIN_UID/ADMIN_NAME are the real account's uid/display name, so every audit entry attributed to the
  //    administrator corresponds to an account you can really sign in as.
  // =====================================================================
  const adminUser = await upsertSeedUser(auth, ADMIN_EMAIL, SEED_PASSWORD, ADMIN_UID)
  // RAW INSERT 1: the administrator's profile (role) row -- the app has no save path that creates it.
  await db.insert(profiles).values({ uid: adminUser.uid, full_name: ADMIN_NAME, role: 'admin', created_at: setupAt() })
  admin = adminCaller(adminUser.uid, ADMIN_NAME, null)

  // My Profile -> My details (name, surname, department) reads this record: the same save My Profile makes the first
  // time the administrator opens it (it creates her own borrower record, hidden from the Staff page).
  const [adminFirstName, ...adminRest] = ADMIN_NAME.split(' ')
  const adminStaff = await updateOwnDetails(asSetup(), {
    name: adminFirstName,
    surname: adminRest.join(' '),
    department: DEPARTMENT,
    email: ADMIN_EMAIL,
    card_uid: null,
  })
  admin = adminCaller(adminUser.uid, ADMIN_NAME, adminStaff.id)

  // Settings -> Notifications addresses: administrator emails are delivered to the administrator's own login address,
  // and every email is sent From the system address. The toggles are left untouched.
  await saveAddress(asSetup(), 'admin_notification_email', ADMIN_EMAIL)
  await saveAddress(asSetup(), 'system_from_email', SYSTEM_FROM_EMAIL)

  // A portal-borrower login, linked to the Portal Linked staff record created in section 2 below.
  const portalMember = cast.staff.find((m) => m.key === 'PortalLinked') as SeedCastMember
  const portalBorrowerUser = await upsertSeedUser(auth, portalMember.email, SEED_PASSWORD, PORTAL_BORROWER_UID)

  // =====================================================================
  // 1. CATEGORIES -- the standard 7-category list, plus one dedicated pair to demonstrate a category 'create' and
  //    'update' audit entry without touching the real 7.
  // =====================================================================
  const CATEGORY_SPECS = [
    { name: 'Cables & Adapters', description: 'USB, HDMI, DisplayPort, network cables' },
    { name: 'Consumables', description: 'Toner, paper, labels, cleaning kits' },
    { name: 'Laptops & Computers', description: 'Portable and desktop computers' },
    { name: 'Networking', description: 'Switches, routers, access points' },
    { name: 'Peripherals', description: 'Keyboards, mice, monitors, webcams' },
    { name: 'Power', description: 'UPS units, power strips, surge protectors' },
    { name: 'Storage', description: 'SSDs, HDDs, USB drives' },
  ]
  const categoryId: Record<string, string> = {}
  for (const c of CATEGORY_SPECS) categoryId[c.name] = (await createCategory(asSetup(), c)).id

  const demoCategory = await createCategory(asAdmin(-14), { name: 'Office Accessories', description: 'Desk organisers, monitor stands and cable trays.' })
  await updateCategory(asAdmin(-13), demoCategory.id, {
    name: 'Office Accessories',
    description: 'Desk organisers, monitor stands, cable trays and laptop risers.',
  })

  // =====================================================================
  // 2. STAFF -- the cast of characters. Each scenario below gets its own staff record so every row is unambiguous in
  //    every list/sidebar.
  // =====================================================================
  const S: Record<string, SeedStaff> = {}
  // Whether the cast has this scenario's staff member (the OPTIONAL_SCENARIOS are skipped without one).
  const has = (key: string) => key in S
  // Card / portal-access mix, set per member by the cast (for the comprehensive cast: spread evenly over the list, index mod
  // 4 -- card + portal, card only, portal only, neither -- so the Staff page's "Not linked" / "Not granted" badges sit next
  // to real values). Portal access is a real Auth login (password123), not just a flag: only members with `login` get one.
  const portalStaffKeys: string[] = []
  const loginUid: Record<string, string> = {}
  for (const member of cast.staff) {
    const { key, name, surname, email, department } = member
    if (member.login) {
      loginUid[key] =
        key === 'PortalLinked'
          ? portalBorrowerUser.uid
          : (await upsertSeedUser(auth, email, SEED_PASSWORD, `seed-staff-${key.toLowerCase()}-uid`)).uid
      portalStaffKeys.push(key)
    }
    const startDepartment = member.startDepartment ?? department
    const card_uid = member.cardIndex === null ? null : cardUidFor(member.cardIndex)
    const created = await createStaff(asSetup(), { name, surname, email, department: startDepartment, card_uid })
    S[key] = { id: created.id, name, surname, full_name: `${name} ${surname}`, email, department, card_uid, uid: null }
  }

  // ---- Staff audit log coverage: create (every record above) / update / activate / deactivate / portal access -----------
  await updateStaff(asAdmin(-29), S.PendingFresh.id, {
    name: S.PendingFresh.name,
    surname: S.PendingFresh.surname,
    email: S.PendingFresh.email,
    department: S.PendingFresh.department,
    card_uid: S.PendingFresh.card_uid,
  })
  // Zoe's badge was switched off and then switched back on; Callum's was switched off and left that way.
  await setStaffActive(asAdmin(-21), S.BadgeActive.id, false)
  await setStaffActive(asAdmin(-20), S.BadgeActive.id, true)
  await setStaffActive(asAdmin(-19), S.BadgeDeactivated.id, false)

  // Portal access: granting a login, and later re-issuing the link (Jessica Moore). One grant_access each for the other
  // staff with a login, spread over the past weeks.
  const otherPortalKeys = portalStaffKeys.filter((k) => k !== 'PortalLinked')
  for (const [n, key] of otherPortalKeys.entries()) {
    const linked = await linkStaffLogin(asAdmin(-45 + n * 3), S[key].id, loginUid[key])
    S[key].uid = linked.uid
  }
  S.PortalLinked.uid = (await linkStaffLogin(asAdmin(-18), S.PortalLinked.id, loginUid.PortalLinked)).uid
  await logResendAccess(asAdmin(-11), S.PortalLinked.id, { email: S.PortalLinked.email, uid: loginUid.PortalLinked })

  // =====================================================================
  // 3. PRODUCTS -- variety across stock level, lending interval, and the "Availability" toggle.
  // =====================================================================
  const P: Record<string, SeedProduct> = {}
  async function makeProduct(spec: ProductSpec, overrides: { quantity_on_hand?: number } = {}): Promise<SeedProduct> {
    // Photos go up first under products/<id>/ (the Products page does the same), then the product is saved with the paths.
    const id = newId()
    const images = await seedImages(id, spec.name, spec.image_slug)
    const barcodes = spec.barcodes ?? [spec.barcode]
    const input: ProductInput = {
      id,
      name: spec.name,
      description: spec.description,
      barcodes,
      category_id: categoryId[spec.category],
      quantity_on_hand: overrides.quantity_on_hand ?? spec.quantity_on_hand,
      reorder_threshold: spec.reorder_threshold,
      available: spec.available ?? true,
      location: LOCATION,
      lend_from: addDays(-365),
      lend_to: null,
      lending_interval: spec.lending_interval ?? 'week_1',
      images,
    }
    await createProduct(asSetup(), input)
    return { id, name: spec.name, barcodes, input }
  }
  // Edit one product the way the Products page does (every field is re-sent, one changes), recording an audit entry.
  async function reviseProduct(product: SeedProduct, patch: Partial<ProductInput>, dayOffset: number, minutes = 0) {
    const input: ProductInput = { ...product.input, ...patch }
    await updateProduct(asAdmin(dayOffset, minutes), product.id, input)
    product.input = { ...input, quantity_reason: undefined }
  }

  P.healthy = await makeProduct({
    name: 'Wireless Mouse', barcode: 'DEMO-HEALTHY', barcodes: ['DEMO-HEALTHY', 'DEMO-HEALTHY-ALT'],
    quantity_on_hand: 25, reorder_threshold: 5, lending_interval: 'week_1', category: 'Peripherals',
    image_slug: 'wireless-mouse', description: '2.4 GHz wireless optical mouse with a nano USB-A receiver that stores inside the battery bay. Ergonomic right-hand shape with a precision scroll wheel, forward and back buttons and adjustable 800 / 1200 / 1600 DPI. Runs up to 12 months on a single AA battery. Plug-and-play on Windows, macOS and Linux.',
  })
  // Edge case: ten barcodes on one product -- stress-tests how the Issued per Staff report renders a long barcode list
  // under a single product line. Paper is a natural fit: every ream carries its own barcode.
  P.manyBarcodes = await makeProduct({
    name: 'A4 Copy Paper (500 sheets)', barcode: 'DEMO-MANYBARCODE-01',
    barcodes: Array.from({ length: 10 }, (_, i) => `DEMO-MANYBARCODE-${String(i + 1).padStart(2, '0')}`),
    quantity_on_hand: 20, reorder_threshold: 3, lending_interval: 'week_1', category: 'Consumables',
    image_slug: 'a4-copy-paper', description: '80 gsm white A4 multipurpose paper (210 x 297 mm), 500 sheets per ream. Suitable for laser and inkjet printers, photocopiers and fax machines. Acid-free, with a smooth finish that feeds reliably and resists jamming. Each ream carries its own barcode so individual reams can be issued and returned.',
  })
  // Two more multi-barcode products for the "Multi-Barcode" Stock In / Stock Out / Return scenario in section 5.
  P.kitCable = await makeProduct({
    name: 'USB-C Cable 1m', barcode: 'DEMO-KITCABLE-A', barcodes: ['DEMO-KITCABLE-A', 'DEMO-KITCABLE-B', 'DEMO-KITCABLE-C'],
    quantity_on_hand: 0, reorder_threshold: 2, lending_interval: 'week_2', category: 'Cables & Adapters',
    image_slug: 'usb-c-cable', description: 'Braided nylon USB-C to USB-C cable, 1 metre, with a connector at each end. Supports USB 3.1 Gen 2 data transfer up to 10 Gbps, 60 W fast charging and video output on compatible devices. Reinforced strain relief and a reversible plug that fits either way round.',
  })
  P.kitAdapter = await makeProduct({
    name: 'DisplayPort Cable 2m', barcode: 'DEMO-KITADAPTER-A', barcodes: ['DEMO-KITADAPTER-A', 'DEMO-KITADAPTER-B'],
    quantity_on_hand: 0, reorder_threshold: 2, lending_interval: 'week_2', category: 'Cables & Adapters',
    image_slug: 'displayport-cable', description: 'DisplayPort 1.4 cable, 2 metres, with a DisplayPort male connector at each end. Carries video and audio up to 8K at 30 Hz or 4K at 120 Hz, with HDR support. Gold-plated latching connectors give a secure fit on monitors, docking stations and graphics cards.',
  })
  // Lost-label demo: THREE units are issued under ONE barcode (A) even though the product has three registered barcodes.
  P.lostLabel = await makeProduct({
    name: '27-inch Monitor', barcode: 'DEMO-LOSTLABEL-A', barcodes: ['DEMO-LOSTLABEL-A', 'DEMO-LOSTLABEL-B', 'DEMO-LOSTLABEL-C'],
    quantity_on_hand: 10, reorder_threshold: 2, lending_interval: 'week_2', category: 'Peripherals',
    image_slug: 'monitor-27', description: '27-inch Full HD (1920 x 1080) IPS monitor with wide 178-degree viewing angles and a 75 Hz refresh rate. Inputs: 2 x HDMI 1.4, 1 x DisplayPort 1.2 and a 3.5 mm audio output. Height-adjustable stand with tilt and swivel, plus a 100 x 100 mm VESA mount. Flicker-free with a low blue-light mode.',
  })
  // Second product on the same Lost Labels transaction, so that row has TWO products (3 x monitor + 2 x webcam).
  P.lostLabelPair = await makeProduct({
    name: 'HD Webcam', barcode: 'DEMO-LOSTPAIR-A', barcodes: ['DEMO-LOSTPAIR-A', 'DEMO-LOSTPAIR-B'],
    quantity_on_hand: 8, reorder_threshold: 2, lending_interval: 'week_2', category: 'Peripherals',
    image_slug: 'hd-webcam', description: '1080p Full HD webcam recording at 30 frames per second with a 90-degree wide-angle lens and autofocus. Built-in dual noise-reducing microphones. Connects through a 1.5 m attached USB-A 2.0 cable, plug and play with no drivers. Clips onto a monitor or screws onto a standard tripod, and works with Teams, Zoom and Google Meet.',
  })
  P.lowStock = await makeProduct({
    name: 'Ethernet Patch Cable Cat6', barcode: 'DEMO-LOWSTOCK', quantity_on_hand: 4, reorder_threshold: 5,
    lending_interval: 'week_2', category: 'Cables & Adapters',
    image_slug: 'ethernet-patch-cable', description: 'Cat6 patch cable with RJ45 connectors at both ends, 2 metres. Supports Gigabit Ethernet up to 1 Gbps (rated to 250 MHz) for switches, routers, access points and wall points. Snagless moulded boots protect the latch, and the shielded cable reduces interference.',
  })
  // Out of stock by the end of the seed. It is created with one unit so that the declined requests below could be
  // submitted (the app refuses a request for stock that is not there); the last unit is written off at the end (section 8).
  P.outOfStock = await makeProduct({
    name: 'Solid State Drive 1TB', barcode: 'DEMO-OUTOFSTOCK', quantity_on_hand: 0, reorder_threshold: 3,
    lending_interval: 'week_3', category: 'Storage',
    image_slug: 'ssd-1tb', description: '1 TB 2.5-inch SATA III solid state drive with sequential reads up to 550 MB/s and writes up to 520 MB/s. Connects through a standard SATA data port plus SATA power, in a 7 mm slim case that fits laptops and desktops. Shock-resistant with no moving parts, a quick way to upgrade an ageing hard drive.',
  }, { quantity_on_hand: 1 })
  P.indefinite = await makeProduct({
    name: 'Business Laptop', barcode: 'DEMO-INDEFINITE', quantity_on_hand: 12, reorder_threshold: 2,
    lending_interval: 'indefinite', category: 'Laptops & Computers',
    image_slug: 'business-laptop', description: '14-inch business laptop with a Full HD anti-glare display, 16 GB RAM and a 512 GB NVMe SSD. Ports: 2 x USB-A 3.2, 2 x USB-C (Thunderbolt 4, charging and DisplayPort), 1 x HDMI 2.0, a 3.5 mm combo audio jack and a microSD reader. Backlit keyboard, fingerprint reader and Wi-Fi 6. Issued for the duration of a project.',
  })
  P.monthInterval = await makeProduct({
    name: 'Wi-Fi Router', barcode: 'DEMO-MONTH', quantity_on_hand: 15, reorder_threshold: 3,
    lending_interval: 'month_1', category: 'Networking',
    image_slug: 'wifi-router', description: 'Dual-band AC1200 Wi-Fi router (2.4 GHz and 5 GHz) with four external antennas. Ports: 1 x Gigabit WAN, 4 x Gigabit LAN and 1 x USB 3.0 for sharing storage. Supports guest networks, WPA3 and basic parental controls, and is configured through a web page. Ideal for labs and temporary office set-ups.',
  })
  P.legacyNoInterval = await makeProduct({
    name: 'Surge Protector Power Strip', barcode: 'DEMO-LEGACY', quantity_on_hand: 10, reorder_threshold: 2,
    category: 'Power',
    image_slug: 'surge-power-strip', description: 'Six-outlet surge protector with an illuminated on/off switch and a protected and grounded indicator light. Absorbs up to 1800 joules and has a built-in overload breaker. 2 metre power cord, and keyhole mounting slots so it can be fixed to a wall or desk underside.',
  })
  // RAW INSERT 2 (an update): lending_interval left empty on purpose (pre-Lending-Interval-field legacy shape) -- the app's
  // createProduct always writes one, and the app treats an empty interval as 1 Week.
  await db.update(products).set({ lending_interval: null }).where(eq(products.id, P.legacyNoInterval.id))
  P.unavailable = await makeProduct({
    name: 'Laser Toner Cartridge (Black)', barcode: 'DEMO-UNAVAILABLE', quantity_on_hand: 8, reorder_threshold: 2,
    available: false, lending_interval: 'week_1', category: 'Consumables',
    image_slug: 'toner-cartridge', description: 'Black toner cartridge for departmental monochrome laser printers, with a page yield of about 3,000 pages at 5 percent coverage. Includes a new drum interface and chip, installs without tools, and prints sharp text and graphics. Currently withdrawn from lending.',
  })
  // Starts at 5 / reorder 1 / 1 Week and is edited to 3 / reorder 2 / 2 Weeks (the product 'update' audit entry below).
  P.insufficientCause = await makeProduct({
    name: 'Desktop PC', barcode: 'DEMO-INSUFF-CAUSE', quantity_on_hand: 5, reorder_threshold: 1,
    lending_interval: 'week_1', category: 'Laptops & Computers',
    image_slug: 'desktop-pc', description: 'Compact desktop PC with a quad-core processor, 16 GB RAM and a 512 GB SSD. Front ports: 2 x USB 3.2 and 1 x headphone/microphone combo jack. Rear ports: 1 x HDMI, 1 x DisplayPort, 1 x Gigabit Ethernet, 4 x USB 2.0 and 2 x audio jacks. Wi-Fi and Bluetooth are built in. Suited to labs and temporary workstations.',
  })
  // Two units on the shelf until the pickup below is approved; one is written off afterwards (section 8), which is what
  // makes the accepted request for two come up short.
  P.insufficientNoCause = await makeProduct({
    name: 'UPS Battery Backup 1500VA', barcode: 'DEMO-INSUFF-NOCAUSE', quantity_on_hand: 1, reorder_threshold: 3,
    lending_interval: 'week_2', category: 'Power',
    image_slug: 'ups-battery-backup', description: '1500VA / 900 W line-interactive UPS with automatic voltage regulation and a front LCD showing input, output, load and runtime. Eight outlets: four with battery backup and surge protection, four surge-only. Includes a USB port for monitoring software and RJ45 network surge protection. Keeps equipment running through load-shedding and short power cuts.',
  }, { quantity_on_hand: 2 })
  P.onSchedule = await makeProduct({
    name: 'Network Switch 8-Port', barcode: 'DEMO-ONSCHEDULE', quantity_on_hand: 10, reorder_threshold: 2,
    lending_interval: 'week_2', category: 'Networking',
    image_slug: 'network-switch', description: '8-port gigabit unmanaged Ethernet switch with 8 x 10/100/1000 RJ45 ports that auto-negotiate speed and cable type. Plug and play with no configuration, and LED indicators for link and activity on every port. Compact metal case with a fanless design, suited to desks, labs and small cabinets.',
  })
  P.noShowFeeder = await makeProduct({
    name: 'Wireless Access Point', barcode: 'DEMO-NOSHOW', quantity_on_hand: 5, reorder_threshold: 2,
    lending_interval: 'week_1', category: 'Networking',
    image_slug: 'wireless-access-point', description: 'Ceiling- or wall-mount Wi-Fi 6 access point, dual-band up to 1.8 Gbps, supporting more than 100 connected devices. One Gigabit Ethernet port that is powered over PoE (802.3af), so no separate power adapter is needed. Supports multiple SSIDs, VLANs and band steering. Mounting bracket included.',
  })
  P.fulfilled = await makeProduct({
    name: 'Mechanical Keyboard', barcode: 'DEMO-FULFILLED', quantity_on_hand: 10, reorder_threshold: 2,
    lending_interval: 'week_2', category: 'Peripherals',
    image_slug: 'mechanical-keyboard', description: 'Full-size mechanical keyboard with 104 keys including a numeric keypad. Tactile blue switches rated for 50 million keystrokes, with per-key backlighting and N-key rollover. Metal top plate with a removable cable and a USB-A connection. Compatible with Windows, macOS and Linux.',
  })
  P.returnNoDate = await makeProduct({
    name: 'External Hard Drive 2TB', barcode: 'DEMO-RET-NODATE', quantity_on_hand: 20, reorder_threshold: 5,
    category: 'Storage', image_slug: 'external-hard-drive', description: 'Portable 2 TB external hard drive in a slim, shock-resistant case. Supports USB 3.0 (5 Gbps), with both a USB-A and a USB-C connection cable included. Powered over USB with no external adapter. Pre-formatted for Windows and also usable on macOS and Linux. Ideal for backups and moving large datasets.',
  })
  P.returnOverdue = await makeProduct({
    name: 'Ultrabook Laptop 14-inch', barcode: 'DEMO-RET-OVERDUE', quantity_on_hand: 20, reorder_threshold: 5,
    category: 'Laptops & Computers', image_slug: 'business-laptop', description: 'Lightweight 14-inch ultrabook weighing about 1.3 kg, with a Full HD display, 16 GB RAM and a 512 GB SSD. Ports: 2 x USB-C (Thunderbolt 4), 1 x USB-A 3.2, 1 x HDMI 2.0 and a 3.5 mm audio jack. Up to 12 hours of battery life. Popular for conferences and fieldwork.',
  })
  P.returnDueToday = await makeProduct({
    name: 'USB Flash Drive 64GB', barcode: 'DEMO-RET-DUETODAY', quantity_on_hand: 20, reorder_threshold: 5,
    category: 'Storage', image_slug: 'usb-flash-drive', description: '64 GB USB 3.0 flash drive with read speeds up to 120 MB/s. Retractable USB-A connector, so there is no cap to lose, and a loop for a lanyard or key ring. Compatible with Windows, macOS and Linux.',
  })
  P.returnNotDueYet = await makeProduct({
    name: 'HDMI Cable 2m', barcode: 'DEMO-RET-NOTDUEYET', quantity_on_hand: 20, reorder_threshold: 5,
    category: 'Cables & Adapters', image_slug: 'hdmi-cable', description: 'High-speed HDMI 2.0 cable, 2 metres, with HDMI Type A male connectors at both ends. Supports 4K at 60 Hz, HDR and Ethernet channel, and carries up to 8 channels of audio. Gold-plated connectors and a shielded cable for a clean picture.',
  })
  P.returnPartlyResolved = await makeProduct({
    name: '24-inch Monitor', barcode: 'DEMO-RET-PARTRESOLVED', quantity_on_hand: 20, reorder_threshold: 5,
    category: 'Peripherals', image_slug: 'monitor-27', description: '24-inch Full HD (1920 x 1080) IPS monitor with a 75 Hz refresh rate. Inputs: 1 x HDMI 1.4, 1 x VGA and a 3.5 mm audio output. Tilt-adjustable stand and a 75 x 75 mm VESA mount. Slim bezel design suited to lecture rooms and office desks.',
  })
  P.ioAdjustRestock = await makeProduct({
    name: 'High-Yield Toner Cartridge (Black)', barcode: 'DEMO-RESTOCK', quantity_on_hand: 6, reorder_threshold: 3,
    category: 'Consumables', image_slug: 'toner-cartridge', description: 'High-yield black toner cartridge for shared monochrome laser printers, with a page yield of about 6,000 pages at 5 percent coverage. Includes a new drum interface and chip, and installs without tools. A better fit than the standard cartridge for busy printers.',
  })
  P.fullReturnPair = await makeProduct({
    name: 'Compact Wireless Mouse', barcode: 'DEMO-FULLRETURN', quantity_on_hand: 20, reorder_threshold: 5,
    category: 'Peripherals', image_slug: 'wireless-mouse', description: 'Compact 2.4 GHz wireless mouse sized for laptop bags, with a nano USB-A receiver that stores in the battery bay. 1000 DPI optical sensor and a quiet-click scroll wheel. Runs on one AA battery for up to 18 months. Plug and play on Windows, macOS and Linux.',
  })
  P.partialReturnPair = await makeProduct({
    name: 'Network Switch 24-Port', barcode: 'DEMO-PARTIALRETURN', quantity_on_hand: 20, reorder_threshold: 5,
    category: 'Networking', image_slug: 'network-switch', description: '24-port gigabit managed Ethernet switch with 24 x 10/100/1000 RJ45 ports and 2 x SFP uplink slots. Supports VLANs, QoS, link aggregation and port mirroring, configured through a web interface. Rack-mountable in a 19-inch rack (1U), with LED indicators on every port.',
  })

  // ---- Product audit log coverage: create (every product above) / update --------------------------------------------------
  // The Desktop PC was first stocked with 5 at a reorder level of 1 and a 1-week lending interval; then corrected.
  await reviseProduct(P.insufficientCause, { quantity_on_hand: 3, reorder_threshold: 2, lending_interval: 'week_2' }, -21)

  // Whatever the cast adds on top of the shared catalogue.
  await cast.extras?.({ db, admin, categoryId, location: LOCATION })

  // =====================================================================
  // Helpers for the stock and loan-request scenarios below.
  // =====================================================================
  interface MovementArgs {
    type: 'IN' | 'OUT' | 'RETURN' | 'ADJUST'
    staff?: SeedStaff
    items: { product: SeedProduct; quantity: number; barcodes?: string[] }[]
    direction?: 1 | -1
    lendFrom?: string | null
    lendTo?: string | null
    returnDate?: string | null
    notes?: string | null
    linkedTxnId?: string
    linkedRequestId?: string
    /** The staff member was picked from a list although they have a card (an explicit choice in the scenario). */
    manualOverride?: boolean
    dayOffset: number
  }
  // One stock movement through the data layer, stamped at the scenario's moment. Items name barcodes only where the
  // scenario does; otherwise the data layer picks the product's own (IN/OUT) or the units still out (RETURN), as the
  // pages do.
  async function movement(a: MovementArgs): Promise<{ id: string; reference_no: string }> {
    const items: StockItemInput[] = a.items.map((i) => ({ productId: i.product.id, quantity: i.quantity, ...(i.barcodes ? { barcodes: i.barcodes } : {}) }))
    const ctx = asAdmin(a.dayOffset)
    // A staff member with no card on file can only ever have been picked from the list, so their Stock Outs / Returns
    // are manual entries by definition; a scenario can also ask for it explicitly. Stock In and ADJUST have no staff step
    // to bypass.
    const manualOverride = a.manualOverride === true || (!!a.staff && !a.staff.card_uid)
    switch (a.type) {
      case 'IN':
        return recordStockIn(ctx, { items, notes: a.notes ?? null })
      case 'ADJUST':
        return recordAdjust(ctx, { direction: a.direction ?? 1, items, notes: a.notes ?? null })
      case 'OUT':
        return recordStockOut(ctx, {
          staffId: (a.staff as SeedStaff).id, items, lendFrom: a.lendFrom ?? null, lendTo: a.lendTo ?? null,
          manualOverride, notes: a.notes ?? null, linkedRequestId: a.linkedRequestId ?? null,
        })
      case 'RETURN':
        return recordReturn(ctx, {
          staffId: (a.staff as SeedStaff).id, linkedTxnId: a.linkedTxnId as string, items,
          returnDate: a.returnDate ?? null, manualOverride, notes: a.notes ?? null,
        })
    }
  }

  // Submit a request as the staff member (their own save, at the moment they made it) with the ORIGINAL dates; every
  // later transition is a separate call below, so a request's audit history reads the way a real negotiation's would.
  async function openRequest(o: {
    staff: SeedStaff
    lines: LineSpec[]
    fromDate: string
    toDate: string | null
    message?: string | null
    createdDayOffset: number
  }): Promise<SeedRequest> {
    const id = await submitLoanRequest(asStaff(o.staff, o.createdDayOffset), {
      cart: o.lines.map((l) => ({ productId: l.product.id, quantity: l.requested })),
      fromDate: o.fromDate,
      toDate: o.toDate,
      message: o.message ?? null,
    })
    const { lines } = await getRequest(asAdmin(o.createdDayOffset), id)
    return {
      id,
      staff: o.staff,
      lines: o.lines.map((l) => ({ ...l, lineId: (lines.find((x) => x.product_id === l.product.id) as { id: string }).id })),
    }
  }
  const approve = (r: SeedRequest, dayOffset: number) => approveAsIs(asAdmin(dayOffset), r.id)
  const counter = (r: SeedRequest, dayOffset: number, extra: { fromDate?: string; toDate?: string | null; message?: string | null } = {}) =>
    sendCounter(asAdmin(dayOffset), r.id, {
      lines: r.lines.map((l) => ({ lineId: l.lineId, product_id: l.product.id, offered_quantity: l.offered ?? l.requested })),
      ...extra,
    })
  const staffAccepts = (r: SeedRequest, dayOffset: number) => acceptCounter(asStaff(r.staff, dayOffset), r.id)
  const staffDeclines = (r: SeedRequest, dayOffset: number) => declineCounter(asStaff(r.staff, dayOffset), r.id)
  const adminDeclines = (r: SeedRequest, dayOffset: number, message: string) => declineRequest(asAdmin(dayOffset), r.id, message)
  const staffWithdraws = (r: SeedRequest, dayOffset: number) => withdrawRequest(asStaff(r.staff, dayOffset), r.id)
  const adminCancels = (r: SeedRequest, dayOffset: number, reason: string) => withdrawRequest(asAdmin(dayOffset), r.id, reason)
  // The automatic expiry / no-show: the system, on the first day the app's own rule makes the request due (never earlier).
  async function systemSettles(r: SeedRequest, dayOffset: number, expected: LoanRequestStatus) {
    const status = await expireIfNeeded(asSystem(dayOffset), r.id)
    if (status !== expected) throw new Error(`Seed: expected the system to settle request ${r.id} as ${expected} on day ${dayOffset}, got ${status}`)
  }
  // Stock Out against an accepted request: the request becomes fulfilled in the same save.
  const fulfil = (r: SeedRequest, dayOffset: number, items: { product: SeedProduct; quantity: number }[], lendFrom: string, lendTo: string | null) =>
    movement({ type: 'OUT', staff: r.staff, items, lendFrom, lendTo, linkedRequestId: r.id, dayOffset })

  // =====================================================================
  // 4. OUTSTANDING RETURNS (Dashboard tab) -- walk-in Stock Out activity, not tied to any loan request. Every badge
  //    variant, plus a Mixed holder with three at once.
  // =====================================================================
  if (has('ReturnNoDate')) {
    await movement({ type: 'OUT', staff: S.ReturnNoDate, items: [{ product: P.returnNoDate, quantity: 1 }], lendFrom: addDays(-5), lendTo: null, manualOverride: true, notes: 'Staff selected manually (no card scan)', dayOffset: -5 })
  }
  if (has('ReturnOverdue')) {
    await movement({ type: 'OUT', staff: S.ReturnOverdue, items: [{ product: P.returnOverdue, quantity: 2 }], lendFrom: addDays(-15), lendTo: addDays(-3), dayOffset: -15 })
  }
  if (has('ReturnDueToday')) {
    await movement({ type: 'OUT', staff: S.ReturnDueToday, items: [{ product: P.returnDueToday, quantity: 1 }], lendFrom: addDays(-7), lendTo: TODAY, dayOffset: -7 })
  }
  await movement({ type: 'OUT', staff: S.ReturnNotDueYet, items: [{ product: P.returnNotDueYet, quantity: 3 }], lendFrom: addDays(-1), lendTo: addDays(14), dayOffset: -1 })

  const partlyResolvedTxn = await movement({ type: 'OUT', staff: S.ReturnPartlyResolved, items: [{ product: P.returnPartlyResolved, quantity: 1 }], lendFrom: addDays(-30), lendTo: null, dayOffset: -30 })
  await createReturnWaiver(asAdmin(-25), {
    transactionId: partlyResolvedTxn.id, productId: P.returnPartlyResolved.id, staffId: S.ReturnPartlyResolved.id, quantity: 1,
    reason: 'Item was damaged beyond repair -- staff member keeping it, written off.',
  })
  await movement({ type: 'OUT', staff: S.ReturnPartlyResolved, items: [{ product: P.returnPartlyResolved, quantity: 1 }], lendFrom: addDays(-2), lendTo: addDays(5), dayOffset: -2 })

  await movement({ type: 'OUT', staff: S.ReturnMixedHolder, items: [{ product: P.returnNoDate, quantity: 1 }], lendFrom: addDays(-20), lendTo: null, dayOffset: -20 })
  await movement({ type: 'OUT', staff: S.ReturnMixedHolder, items: [{ product: P.returnOverdue, quantity: 1 }], lendFrom: addDays(-10), lendTo: addDays(-1), dayOffset: -10 })
  await movement({ type: 'OUT', staff: S.ReturnMixedHolder, items: [{ product: P.returnDueToday, quantity: 1 }], lendFrom: addDays(-7), lendTo: TODAY, dayOffset: -7 })

  // Two more walk-in stock-outs that are not due for a while, so Not Due Yet is clearly the biggest group on the
  // Dashboard (Overdue only a handful).
  await movement({ type: 'OUT', staff: S.BadgeActive, items: [{ product: P.returnNotDueYet, quantity: 2 }], lendFrom: addDays(-2), lendTo: addDays(8), dayOffset: -2 })
  await movement({ type: 'OUT', staff: S.BadgeActive, items: [{ product: P.fullReturnPair, quantity: 1 }], lendFrom: addDays(-1), lendTo: addDays(12), dayOffset: -1 })

  // =====================================================================
  // 5. REPORTS -- IN / RETURN / ADJUST activity, plus a full and a partial return.
  // =====================================================================
  await movement({ type: 'IN', items: [{ product: P.ioAdjustRestock, quantity: 15 }], notes: 'Quarterly restock from IT Store supplier.', dayOffset: -25 })
  await movement({ type: 'IN', items: [{ product: P.monthInterval, quantity: 5 }], notes: 'Emergency restock -- approved via email.', dayOffset: -18 })
  await movement({ type: 'ADJUST', direction: 1, items: [{ product: P.legacyNoInterval, quantity: 1 }], notes: 'Manual stock count correction -- found 1 extra unit during a physical audit.', dayOffset: -12 })

  if (has('ReturnCompleted')) {
    const fullReturnOut = await movement({ type: 'OUT', staff: S.ReturnCompleted, items: [{ product: P.fullReturnPair, quantity: 2 }], lendFrom: addDays(-20), lendTo: addDays(-10), dayOffset: -20 })
    await movement({ type: 'RETURN', staff: S.ReturnCompleted, items: [{ product: P.fullReturnPair, quantity: 2 }], returnDate: addDays(-9), linkedTxnId: fullReturnOut.id, notes: 'Returned in good condition.', dayOffset: -9 })
  }

  if (has('ReturnPartial')) {
    const partialReturnOut = await movement({ type: 'OUT', staff: S.ReturnPartial, items: [{ product: P.partialReturnPair, quantity: 4 }], lendFrom: addDays(-15), lendTo: addDays(9), dayOffset: -15 })
    await movement({ type: 'RETURN', staff: S.ReturnPartial, items: [{ product: P.partialReturnPair, quantity: 2 }], returnDate: addDays(-4), linkedTxnId: partialReturnOut.id, notes: 'Only 2 of the 4 units back so far -- other 2 still out.', dayOffset: -4 })
  }

  // ---- Multi-item, multi-barcode Stock In / Stock Out / Return -------------
  // Every transaction here has more than one product, and each product has more than one of its barcodes scanned.
  // Returns reuse exactly the barcodes the matching Stock Out was issued with (the data layer enforces that).
  await movement({
    type: 'IN',
    items: [
      { product: P.kitCable, quantity: 9, barcodes: ['DEMO-KITCABLE-A', 'DEMO-KITCABLE-B', 'DEMO-KITCABLE-C'] },
      { product: P.kitAdapter, quantity: 7, barcodes: ['DEMO-KITADAPTER-A', 'DEMO-KITADAPTER-B'] },
    ],
    notes: 'Delivery of cable + adapter kits -- several barcodes scanned per product.', dayOffset: -30,
  })
  // Full return: 2 products x 2-3 barcodes out, exactly the same barcodes back.
  const kitFullOut = await movement({
    type: 'OUT', staff: S.MultiBarcodeFull,
    items: [
      { product: P.kitCable, quantity: 3, barcodes: ['DEMO-KITCABLE-A', 'DEMO-KITCABLE-B', 'DEMO-KITCABLE-C'] },
      { product: P.kitAdapter, quantity: 3, barcodes: ['DEMO-KITADAPTER-A', 'DEMO-KITADAPTER-B'] },
    ],
    lendFrom: addDays(-14), lendTo: addDays(-7), dayOffset: -14,
  })
  await movement({
    type: 'RETURN', staff: S.MultiBarcodeFull,
    items: [
      { product: P.kitCable, quantity: 3, barcodes: ['DEMO-KITCABLE-A', 'DEMO-KITCABLE-B', 'DEMO-KITCABLE-C'] },
      { product: P.kitAdapter, quantity: 3, barcodes: ['DEMO-KITADAPTER-A', 'DEMO-KITADAPTER-B'] },
    ],
    returnDate: addDays(-6), linkedTxnId: kitFullOut.id, notes: 'Everything back -- same barcodes as issued.', dayOffset: -6,
  })
  // Partial return: two products out, only some of the barcodes come back, so the rest stay outstanding (due today).
  const kitPartialOut = await movement({
    type: 'OUT', staff: S.MultiBarcodePartial,
    items: [
      { product: P.kitCable, quantity: 3, barcodes: ['DEMO-KITCABLE-A', 'DEMO-KITCABLE-B', 'DEMO-KITCABLE-C'] },
      { product: P.kitAdapter, quantity: 2, barcodes: ['DEMO-KITADAPTER-A', 'DEMO-KITADAPTER-B'] },
    ],
    lendFrom: addDays(-12), lendTo: TODAY, dayOffset: -12,
  })
  await movement({
    type: 'RETURN', staff: S.MultiBarcodePartial,
    items: [
      { product: P.kitCable, quantity: 2, barcodes: ['DEMO-KITCABLE-A', 'DEMO-KITCABLE-B'] },
      { product: P.kitAdapter, quantity: 1, barcodes: ['DEMO-KITADAPTER-A'] },
    ],
    returnDate: addDays(-3), linkedTxnId: kitPartialOut.id,
    notes: 'Cable A + B and Adapter A back -- Cable C and Adapter B still out.', dayOffset: -3,
  })

  // ---- Lost-label scenario ---------------------------------------------------
  // The Lost Labels scenario (Ryan Fletcher) was issued 3 x 27-inch Monitor, all scanned as DEMO-LOSTLABEL-A, so Returns
  // shows ONE row: barcode A, issued 3, returnable 3. Pretend two of the three labels have come off. To test:
  // The same row also holds 2 x HD Webcam (barcode DEMO-LOSTPAIR-A; -B is its registered replacement barcode).
  //   1. Scan DEMO-LOSTLABEL-A once        -> row 1 / 3, + is still there
  //   2. Click +, enter DEMO-LOSTLABEL-B   -> row 2 / 3, + is still there
  //   3. Click +, enter DEMO-LOSTLABEL-B (or -C) again -> row 3 / 3, + gone
  // Also try: a barcode that isn't registered (rejected -- add it under Products -> Edit first), the issued barcode A via +
  // (rejected -- scan it), and - to take units back off (relabelled ones come off last).
  await movement({
    type: 'OUT', staff: S.LostLabels,
    items: [
      { product: P.lostLabel, quantity: 3, barcodes: ['DEMO-LOSTLABEL-A'] },
      { product: P.lostLabelPair, quantity: 2, barcodes: ['DEMO-LOSTPAIR-A'] },
    ],
    lendFrom: addDays(-10), lendTo: addDays(5), dayOffset: -10,
    notes: 'Seed: 3 units issued under one barcode -- for testing lost-label returns.',
  })

  // =====================================================================
  // 6. LOAN REQUESTS -- every LoanRequestStatus, with a matching audit trail.
  // =====================================================================

  // ---- pending (fresh) ----------------------------------------------------
  await openRequest({
    staff: S.PendingFresh, fromDate: addDays(3), toDate: addDays(10),
    lines: [{ product: P.healthy, requested: 2 }],
    createdDayOffset: -1,
  })

  // ---- pending (near its 30-day expiry) ------------------------------------
  await openRequest({
    staff: S.PendingNearExpiry, fromDate: addDays(20), toDate: addDays(30),
    message: 'Need this for the open day on the 25th, thanks!',
    lines: [{ product: P.monthInterval, requested: 1 }],
    createdDayOffset: -28,
  })

  // ---- countered (rich: removed line + both messages + date change) -------
  {
    const counterMsg = "Can only spare 1 of the first -- the second's almost out of stock so I'd rather not commit it. Let me know if that still works."
    const req = await openRequest({
      staff: S.CounteredRich, fromDate: addDays(2), toDate: addDays(9),
      message: 'Would it be possible to get 3 of these plus 2 of the low-stock item for the open day setup?',
      lines: [{ product: P.healthy, requested: 3, offered: 1 }, { product: P.lowStock, requested: 2, offered: 0 }],
      createdDayOffset: -6,
    })
    await counter(req, -4, { fromDate: addDays(4), toDate: addDays(11), message: counterMsg })
  }

  // ---- countered (plain: one line reduced, no messages, no date change) ---
  if (has('CounteredSimple')) {
    const req = await openRequest({
      staff: S.CounteredSimple, fromDate: addDays(1), toDate: null,
      lines: [{ product: P.indefinite, requested: 3, offered: 2 }],
      createdDayOffset: -3,
    })
    await counter(req, -2)
  }

  // ---- accepted, sufficient stock: "On Schedule" ---------------------------
  {
    const req = await openRequest({
      staff: S.AcceptedOnSchedule, fromDate: addDays(2), toDate: addDays(9),
      lines: [{ product: P.onSchedule, requested: 2, offered: 2 }],
      createdDayOffset: -3,
    })
    await approve(req, -2)
  }

  // ---- accepted, INSUFFICIENT with a correlated overdue cause --------------
  // Approved while the Desktop PCs are still on the shelf (3, two promised); the overdue Stock Out that takes two of them
  // out is recorded straight afterwards (it happened 20 days ago), which is what leaves the pickup short.
  {
    const req = await openRequest({
      staff: S.InsufficientCauseRecipient, fromDate: addDays(-1), toDate: addDays(6),
      lines: [{ product: P.insufficientCause, requested: 2, offered: 2 }],
      createdDayOffset: -4,
    })
    await approve(req, -3)
    // The overdue OUT for this scenario -- structurally just another Overdue Outstanding Returns row (that's the point of
    // the correlation).
    await movement({
      type: 'OUT', staff: S.OverdueHolderCause, items: [{ product: P.insufficientCause, quantity: 2 }],
      lendFrom: addDays(-20), lendTo: addDays(-5), dayOffset: -20,
    })
  }

  // ---- accepted, INSUFFICIENT with no overdue return to blame --------------
  {
    const req = await openRequest({
      staff: S.InsufficientNoCauseRecipient, fromDate: TODAY, toDate: addDays(7),
      lines: [{ product: P.insufficientNoCause, requested: 2, offered: 2 }],
      createdDayOffset: -2,
    })
    await approve(req, -1)
  }

  // ---- Not Picked Up (live transition -- settles as no_show on the first Dashboard load, exactly like a real stale
  //      pickup would). Left 'accepted' here on purpose: nothing in the seed settles it. The window is 7 days (-10 to -3),
  //      the longest a 1-week product can be requested for; the old seed's 9-day window (to day -1) is one the app refuses. -----
  if (has('NoShowLive')) {
    const req = await openRequest({
      staff: S.NoShowLive, fromDate: addDays(-10), toDate: addDays(-3),
      lines: [{ product: P.noShowFeeder, requested: 1, offered: 1 }],
      createdDayOffset: -14,
    })
    await approve(req, -12)
  }

  // ---- Not Picked Up (already recorded -- stable, terminal, no race) -------
  {
    const req = await openRequest({
      staff: S.NoShowRecorded, fromDate: addDays(-25), toDate: addDays(-18),
      lines: [{ product: P.noShowFeeder, requested: 1, offered: 1 }],
      createdDayOffset: -30,
    })
    await approve(req, -28)
    // Auto-expiry never has a human actor. The window ended on day -18 (7 days, the longest a 1-week product can be
    // requested for; the old seed's 10-day window is one the app refuses); it was recorded on day -14 as before.
    await systemSettles(req, -14, 'no_show')
  }

  // ---- expired (already recorded -- blew past the 30-day SLA) -------------
  if (has('ExpiredRecorded')) {
    const req = await openRequest({
      staff: S.ExpiredRecorded, fromDate: addDays(-10), toDate: addDays(-3),
      lines: [{ product: P.healthy, requested: 1, offered: 1 }],
      createdDayOffset: -40,
    })
    // Due once today passes min(created + 30 days, From) = day -10, so the first day it can be settled is -9.
    await systemSettles(req, -9, 'expired')
  }

  // ---- fulfilled: full pending -> countered -> accepted -> fulfilled history
  {
    const origFrom = addDays(-3)
    const origTo = addDays(4)
    const newFrom = addDays(-1)
    const newTo = addDays(6)
    const counterMsg = 'Reduced to 2 units and pushed the start date back a couple of days -- let me know if that works.'
    const req = await openRequest({
      staff: S.FulfilledPickup, fromDate: origFrom, toDate: origTo,
      message: 'First-time request, hoping this is fine.',
      lines: [{ product: P.fulfilled, requested: 3, offered: 2 }],
      createdDayOffset: -12,
    })
    await counter(req, -10, { fromDate: newFrom, toDate: newTo, message: counterMsg })
    // Staff accepted the counter themselves via the portal (acceptCounter) -- distinct from approveAsIs, which is the
    // administrator approving unedited.
    await staffAccepts(req, -9)
    await fulfil(req, -1, [{ product: P.fulfilled, quantity: 2 }], newFrom, newTo)
    // A couple of extra, unrelated stock-outs against the same staff member -- no loan request behind either one -- so the
    // Issued per Staff report has more than a single transaction to expand and group for the Fulfilled Pickup scenario.
    // Both lines' barcodes come from the walk-in default (the Wireless Mouse's two, the Wi-Fi Router's one) -- quantity 2 on
    // the Wireless Mouse simulates both of its barcodes having been scanned once each.
    await movement({
      type: 'OUT', staff: S.FulfilledPickup,
      items: [{ product: P.healthy, quantity: 2 }, { product: P.monthInterval, quantity: 2 }],
      lendFrom: addDays(-20), lendTo: addDays(10), dayOffset: -20,
    })
    await movement({
      type: 'OUT', staff: S.FulfilledPickup, items: [{ product: P.indefinite, quantity: 1 }],
      lendFrom: addDays(-6), lendTo: null, dayOffset: -6,
    })
    // Edge case: a product carrying ten barcodes at once, to see how the Issued per Staff report's expanded row handles a
    // long list of them under one product. Quantity 10 to match -- ten distinct barcodes implies ten scans.
    await movement({
      type: 'OUT', staff: S.FulfilledPickup, items: [{ product: P.manyBarcodes, quantity: 10 }],
      lendFrom: addDays(-3), lendTo: addDays(4), dayOffset: -3,
    })
  }

  // ---- declined while still pending (administrator, simple) ----------------
  if (has('DeclinedPending')) {
    const declineMsg = "Sorry, this model's been discontinued and we don't have replacement units -- happy to help you find an alternative if useful."
    const req = await openRequest({
      staff: S.DeclinedPending, fromDate: addDays(5), toDate: addDays(12),
      lines: [{ product: P.outOfStock, requested: 1, offered: 1 }],
      createdDayOffset: -5,
    })
    await adminDeclines(req, -4, declineMsg)
  }

  // ---- declined FROM an already-sent counter (administrator) -- the rich decline-of-a-counter audit snapshot ----------
  {
    const staffMessage = 'Would it be possible to get 3 of these plus 2 of the whiteboard markers for the open day setup?'
    const counterMessage = "I can only spare 1 of the laptop chargers and none of the markers right now -- sorry, they're almost out. Still happy to help with the laptop charger if useful."
    const declineMessage = "Since it looks like these won't work for what you need, I'll close this one out -- feel free to submit a fresh request if your plans change."
    const req = await openRequest({
      staff: S.DeclinedCounterRich, fromDate: addDays(3), toDate: addDays(10),
      message: staffMessage,
      lines: [{ product: P.healthy, requested: 3, offered: 1 }, { product: P.lowStock, requested: 2, offered: 0 }],
      createdDayOffset: -8,
    })
    await counter(req, -6, { fromDate: addDays(3), toDate: addDays(10), message: counterMessage })
    await adminDeclines(req, -1, declineMessage)
  }

  // ---- declined BY the staff member themselves (portal declineCounter) ----
  {
    const req = await openRequest({
      staff: S.DeclinedByStaff, fromDate: addDays(2), toDate: null,
      lines: [{ product: P.indefinite, requested: 2, offered: 1 }],
      createdDayOffset: -7,
    })
    await counter(req, -5)
    await staffDeclines(req, -3)
  }

  // ---- withdrawn by the staff member (no reason) ---------------------------
  if (has('WithdrawnByStaff')) {
    const req = await openRequest({
      staff: S.WithdrawnByStaff, fromDate: addDays(6), toDate: addDays(13),
      lines: [{ product: P.healthy, requested: 1, offered: 1 }],
      createdDayOffset: -4,
    })
    await staffWithdraws(req, -3)
  }

  // ---- withdrawn by the administrator cancelling an accepted pickup (with reason) ----
  {
    const req = await openRequest({
      staff: S.WithdrawnByAdmin, fromDate: addDays(3), toDate: addDays(10),
      lines: [{ product: P.healthy, requested: 1, offered: 1 }],
      createdDayOffset: -6,
    })
    await approve(req, -5)
    await adminCancels(req, -1, 'Staff member said their project got cancelled -- no longer needed.')
  }

  // =====================================================================
  // 7. MY REQUESTS (portal) -- a full spread of every tab/status combo on ONE staff member (S.PortalLinked /
  //    jessica.moore@gmail.com), so signing into the portal as them shows every possible "My Requests" outcome in one
  //    place, unlike section 6 above which deliberately spreads one status per staff member for the administrator's Loan
  //    Requests queue. History alone runs to 12 rows -- past the 10-row page size -- so its pagination footer has a real
  //    second page to click through.
  // =====================================================================

  // ---- Needs your response (countered) x3 --------------------------------
  {
    const counterMsg = "Can only spare 1 of the first -- the second's almost out of stock so I'd rather not commit it."
    const req = await openRequest({
      staff: S.PortalLinked, fromDate: addDays(2), toDate: addDays(9),
      message: 'Would it be possible to get 3 of these plus 2 of the low-stock item?',
      lines: [{ product: P.healthy, requested: 3, offered: 1 }, { product: P.lowStock, requested: 2, offered: 0 }],
      createdDayOffset: -6,
    })
    await counter(req, -4, { fromDate: addDays(4), toDate: addDays(11), message: counterMsg })
  }
  {
    const req = await openRequest({
      staff: S.PortalLinked, fromDate: addDays(1), toDate: null,
      lines: [{ product: P.indefinite, requested: 3, offered: 2 }],
      createdDayOffset: -3,
    })
    await counter(req, -2)
  }
  {
    const req = await openRequest({
      staff: S.PortalLinked, fromDate: addDays(8), toDate: addDays(15),
      lines: [{ product: P.monthInterval, requested: 2, offered: 1 }, { product: P.onSchedule, requested: 1, offered: 1 }],
      createdDayOffset: -5,
    })
    await counter(req, -3)
  }

  // ---- Awaiting the administrator (pending) x3 --------------------------------------
  await openRequest({
    staff: S.PortalLinked, fromDate: addDays(3), toDate: addDays(10),
    lines: [{ product: P.healthy, requested: 2 }],
    createdDayOffset: -1,
  })
  await openRequest({
    staff: S.PortalLinked, fromDate: addDays(20), toDate: addDays(27),
    message: 'Need this for a workshop on the 25th, thanks!',
    lines: [{ product: P.onSchedule, requested: 1 }],
    createdDayOffset: -2,
  })
  await openRequest({
    staff: S.PortalLinked, fromDate: addDays(5), toDate: addDays(12),
    lines: [{ product: P.monthInterval, requested: 1 }, { product: P.indefinite, requested: 1 }],
    createdDayOffset: -1,
  })

  // ---- Upcoming (accepted) x3 ----------------------------------------------
  {
    const req = await openRequest({
      staff: S.PortalLinked, fromDate: addDays(2), toDate: addDays(9),
      lines: [{ product: P.onSchedule, requested: 2, offered: 2 }],
      createdDayOffset: -3,
    })
    await approve(req, -2)
  }
  {
    const req = await openRequest({
      staff: S.PortalLinked, fromDate: addDays(6), toDate: addDays(13),
      message: 'Two of these for a site visit, if possible.',
      lines: [{ product: P.healthy, requested: 2, offered: 2 }, { product: P.monthInterval, requested: 1, offered: 1 }],
      createdDayOffset: -4,
    })
    await approve(req, -3)
  }
  {
    const req = await openRequest({
      staff: S.PortalLinked, fromDate: TODAY, toDate: addDays(7),
      lines: [{ product: P.indefinite, requested: 1, offered: 1 }],
      createdDayOffset: -2,
    })
    await approve(req, -1)
  }

  // ---- History: every terminal status, x12 total (past the 10-row page size) -----------------------------------------------

  // fulfilled x2 (one plain accepted->fulfilled, one full negotiation chain)
  {
    const req = await openRequest({
      staff: S.PortalLinked, fromDate: addDays(-8), toDate: addDays(6),
      lines: [{ product: P.fulfilled, requested: 2, offered: 2 }],
      createdDayOffset: -15,
    })
    await approve(req, -10)
    await fulfil(req, -8, [{ product: P.fulfilled, quantity: 2 }], addDays(-8), addDays(6))
  }
  {
    const origFrom = addDays(-20)
    const origTo = addDays(-13)
    const newFrom = addDays(-18)
    const newTo = addDays(-11)
    const req = await openRequest({
      staff: S.PortalLinked, fromDate: origFrom, toDate: origTo,
      lines: [{ product: P.onSchedule, requested: 2, offered: 1 }],
      createdDayOffset: -25,
    })
    await counter(req, -21, { fromDate: newFrom, toDate: newTo, message: 'Reduced to 1 unit -- only one left in stock right now.' })
    await staffAccepts(req, -19)
    await fulfil(req, -18, [{ product: P.onSchedule, quantity: 1 }], newFrom, newTo)
  }

  // declined while still pending (administrator) x2
  {
    const req = await openRequest({
      staff: S.PortalLinked, fromDate: addDays(-5), toDate: addDays(2),
      lines: [{ product: P.outOfStock, requested: 1, offered: 1 }],
      createdDayOffset: -12,
    })
    await adminDeclines(req, -11, "Sorry, we don't have spare units of this one right now.")
  }
  {
    const req = await openRequest({
      staff: S.PortalLinked, fromDate: addDays(-14), toDate: addDays(-7),
      lines: [{ product: P.legacyNoInterval, requested: 1, offered: 1 }],
      createdDayOffset: -20,
    })
    await adminDeclines(req, -19, "This model's been retired -- happy to help find an alternative.")
  }

  // declined FROM an already-sent counter (rich decline-of-a-counter snapshot)
  {
    const req = await openRequest({
      staff: S.PortalLinked, fromDate: addDays(-10), toDate: addDays(-3),
      message: 'Could I get 3 of these plus 2 of the low-stock item?',
      lines: [{ product: P.healthy, requested: 3, offered: 1 }, { product: P.lowStock, requested: 2, offered: 0 }],
      createdDayOffset: -18,
    })
    await counter(req, -16, { fromDate: addDays(-10), toDate: addDays(-3), message: 'I can only spare 1 of the first and none of the second right now.' })
    await adminDeclines(req, -11, "Since these won't cover what you need, I'll close this one out -- feel free to resubmit if plans change.")
  }

  // declined BY the staff member themselves (portal declineCounter)
  {
    const req = await openRequest({
      staff: S.PortalLinked, fromDate: addDays(-6), toDate: null,
      lines: [{ product: P.indefinite, requested: 2, offered: 1 }],
      createdDayOffset: -16,
    })
    await counter(req, -15)
    await staffDeclines(req, -13)
  }

  // expired (blew past the 30-day SLA) x2 -- each settled on the first day the app's own rule makes it due (the day after
  // min(created + 30 days, From))
  {
    const req = await openRequest({
      staff: S.PortalLinked, fromDate: addDays(-25), toDate: addDays(-18),
      lines: [{ product: P.healthy, requested: 1, offered: 1 }],
      createdDayOffset: -55,
    })
    await systemSettles(req, -24, 'expired')
  }
  {
    const req = await openRequest({
      staff: S.PortalLinked, fromDate: addDays(-35), toDate: addDays(-28),
      lines: [{ product: P.monthInterval, requested: 1, offered: 1 }],
      createdDayOffset: -65,
    })
    await systemSettles(req, -34, 'expired')
  }

  // no_show (already recorded) x2 -- settled the day after the pickup window ended
  {
    const req = await openRequest({
      staff: S.PortalLinked, fromDate: addDays(-22), toDate: addDays(-15),
      lines: [{ product: P.noShowFeeder, requested: 1, offered: 1 }],
      createdDayOffset: -28,
    })
    await approve(req, -26)
    await systemSettles(req, -14, 'no_show')
  }
  {
    const req = await openRequest({
      staff: S.PortalLinked, fromDate: addDays(-17), toDate: addDays(-10),
      lines: [{ product: P.onSchedule, requested: 1, offered: 1 }],
      createdDayOffset: -22,
    })
    await approve(req, -20)
    await systemSettles(req, -9, 'no_show')
  }

  // withdrawn by the staff member (no reason)
  {
    const req = await openRequest({
      staff: S.PortalLinked, fromDate: addDays(-9), toDate: addDays(-2),
      lines: [{ product: P.healthy, requested: 1, offered: 1 }],
      createdDayOffset: -13,
    })
    await staffWithdraws(req, -12)
  }

  // withdrawn by the administrator cancelling an accepted pickup (with reason)
  {
    const req = await openRequest({
      staff: S.PortalLinked, fromDate: addDays(-4), toDate: addDays(3),
      lines: [{ product: P.healthy, requested: 1, offered: 1 }],
      createdDayOffset: -9,
    })
    await approve(req, -8)
    await adminCancels(req, -1, 'IT Store closing early that week -- pickup no longer possible in the window.')
  }

  // =====================================================================
  // 8. STOCK COUNT CORRECTIONS -- the two products the scenarios above needed on the shelf while their requests were being
  //    made are brought to their final level the way an administrator would: a Products-page edit with a reason, which
  //    writes a product 'update' audit entry.
  // =====================================================================
  await reviseProduct(
    P.insufficientNoCause,
    { quantity_on_hand: 1, quantity_reason: 'Stock count correction -- one unit failed its battery test and was taken out of circulation.' },
    -1, 30,
  )
  await reviseProduct(
    P.outOfStock,
    { quantity_on_hand: 0, quantity_reason: 'Last unit sold off with the discontinued model -- none left to lend.' },
    -3,
  )

  return {
    title: cast.title,
    adminName: ADMIN_NAME,
    adminEmail: ADMIN_EMAIL,
    systemFromEmail: SYSTEM_FROM_EMAIL,
    password: SEED_PASSWORD,
    portalBorrower: { fullName: S.PortalLinked.full_name, email: S.PortalLinked.email },
    otherPortalEmails: otherPortalKeys.map((k) => S[k].email),
    lowStockProductName: P.lowStock.name,
    outOfStockProductName: P.outOfStock.name,
    staff: cast.staff.map(({ key, scenario }) => ({ fullName: S[key].full_name, scenario })),
    multiBarcodeFull: S.MultiBarcodeFull.full_name,
    multiBarcodePartial: S.MultiBarcodePartial.full_name,
    lostLabels: { staff: S.LostLabels.full_name, monitor: P.lostLabel.name, webcam: P.lostLabelPair.name },
    declinedCounterRich: S.DeclinedCounterRich.full_name,
    liveNoShow: has('NoShowLive'),
    notes: cast.notes ?? [],
  }
}

// ---------------------------------------------------------------------------
// Command line (shared with seed:demo, which passes its own seed function)
// ---------------------------------------------------------------------------
export async function runSeedCli(seed: (deps: SeedDeps) => Promise<SeedSummary>): Promise<void> {
  const args = process.argv.slice(2)
  const url = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/smartstock'
  const allowNonLocalDb = args.includes('--allow-non-local-db')
  assertLocalDatabaseUrl(url, allowNonLocalDb)

  // Emulator hosts default to the standard local ports, like the old seed; a different local host can be set beforehand.
  process.env.FIREBASE_AUTH_EMULATOR_HOST ||= '127.0.0.1:9099'
  process.env.FIREBASE_STORAGE_EMULATOR_HOST ||= '127.0.0.1:9199'

  const dryAuth = args.includes('--dry-auth')
  const { auth, bucket } = dryAuth ? createFakeAuthAndBucket() : await createEmulatorAuthAndBucket()
  if (dryAuth) console.log('--dry-auth: Auth and Storage are in-memory stand-ins; no logins or photos exist outside this run.\n')

  const db = getDb(url)
  try {
    if (args.includes('--reset')) {
      // The host check above cannot tell Cloud SQL behind the Auth Proxy from the local database; the name can.
      await assertResettableDatabase(db.$client, args.includes('--force'), 'clear (--reset)')
      await resetAppTables(db)
    }
    await assertEmptyDatabase(db)
    const summary = await seed({ db, auth, bucket, allowNonLocalDb })
    for (const line of summaryLines(summary)) console.log(line)
  } finally {
    await closeDb(url)
  }
}

// Run only when started as a script (not when a test imports this file).
if (/[\\/]seed[\\/]comprehensive\.ts$/.test(process.argv[1] ?? '')) {
  runSeedCli(seedComprehensive)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Seed failed:', err)
      process.exit(1)
    })
}


// seed:demo -- the NWU demo version of seed:comprehensive (same products, categories, scenarios and audit history), for
// showing the app to the client. It is seed:comprehensive with a different cast (see seedComprehensive's `cast` option);
// everything it does is written through the same data layer. Differences from seed:comprehensive, which stays as it is for
// the spin video:
//   - Selouna Visser (selouna.visser@nwu.ac.za, uid admin-selouna-visser) is the administrator.
//   - The staff are the 20 real Computer Science and Information Systems staff (the roster the retired seed:staff loaded),
//     each taking over one scenario. The 10 scenarios with no NWU staff member left over are not seeded (see
//     DROPPED_SCENARIOS below); every loan request status and return badge is still covered.
//   - The portal borrower with the full My Requests history is Meiring van Niekerk (47817909@mynwu.ac.za).
//   - Only Selouna and Meiring get a login (password123). The NWU staff are staff records only: no Auth user and no login
//     link for them, so nobody can sign in as them. (Their cards on file, where a scenario gives one, are the same made-up
//     UIDs seed:comprehensive uses.)
//   - Bostik Glu Dots, the product scanned in during the client demo on 29 September 2026, is included with its original
//     create audit entry (none of that demo's transactions).
//
// DROPPED scenarios (no staff member for them): CounteredSimple, NoShowLive, ExpiredRecorded, DeclinedPending,
// WithdrawnByStaff, ReturnNoDate, ReturnOverdue, ReturnDueToday, ReturnCompleted, ReturnPartial.
//
// Run it with the emulators and PostgreSQL up, exactly like seed:comprehensive (same flags: --reset, --dry-auth,
// --allow-non-local-db; same safety rails: local database only, emulators only, an empty database):
//   npm run emulators
//   npm run db   then   npm run db:migrate
//   npm run seed:demo
// Do not run it on top of seed:comprehensive: start from an empty database (npm run db:reset, or --reset).
import { createProduct } from '@/server/data/catalog'
import {
  hasCardAt,
  OPTIONAL_SCENARIOS,
  runSeedCli,
  seedComprehensive,
  type SeedCast,
  type SeedCastMember,
  type SeedDeps,
  type SeedExtrasHelpers,
  type SeedSummary,
} from './comprehensive'
import { seedCtxSequence } from './context'

const DEPARTMENT = 'Computer Science and Information Systems'

export const DEMO_ADMIN = { uid: 'admin-selouna-visser', name: 'Selouna Visser', email: 'selouna.visser@nwu.ac.za' }

/** The scenarios seed:demo leaves out: the comprehensive cast has a person for each, the 20 NWU staff do not. */
export const DROPPED_SCENARIOS: readonly string[] = OPTIONAL_SCENARIOS

// [key, first name, surname, email, scenario, position in seed:comprehensive's roster]
// The position keeps each scenario's card on file the same as in seed:comprehensive (it decides the card mix).
const DEMO_ROWS: [string, string, string, string, string, number][] = [
  ['PendingFresh', 'Estelle', 'Taylor', 'estelle.taylor@nwu.ac.za', 'Pending loan request (fresh); staff create/update audit', 0],
  ['PendingNearExpiry', 'Annette', 'van der Merwe', 'annette.vandermerwe@nwu.ac.za', 'Pending loan request, close to expiring', 1],
  ['CounteredRich', 'Linda', 'Redelinghuys', 'linda.redelinghuys@nwu.ac.za', 'Counter-offer with removed line, messages and date change', 2],
  ['AcceptedOnSchedule', 'Rodney', 'Sebopelo', 'rodney.sebopelo@nwu.ac.za', 'Accepted request, pickup on schedule', 4],
  ['InsufficientCauseRecipient', 'Susan', 'Campher', 'susan.campher@nwu.ac.za', 'Pickup short on stock, overdue return is the likely cause', 5],
  ['OverdueHolderCause', 'Kobus', 'van Aswegen', 'kobus.vanaswegen@nwu.ac.za', 'Holds the overdue item behind the shortage above', 6],
  ['InsufficientNoCauseRecipient', 'Tiny', 'du Toit', 'tiny.dutoit@nwu.ac.za', 'Pickup short on stock, no overdue return to blame', 7],
  ['NoShowRecorded', 'Marijke', 'Coetzee', 'marijke.coetzee@nwu.ac.za', 'Missed pickup, already recorded', 9],
  ['FulfilledPickup', 'Lynette', 'Drevin', 'lynette.drevin@nwu.ac.za', 'Full pending -> countered -> accepted -> fulfilled history', 11],
  ['DeclinedCounterRich', 'Absalom', 'Ezugwu', 'absalom.ezugwu@nwu.ac.za', 'Admin declined a rich counter-offer', 13],
  ['DeclinedByStaff', 'Dimitri', 'Keykaan', 'dimi.keykaan@nwu.ac.za', 'Declined by the staff member via the portal', 14],
  ['WithdrawnByAdmin', 'Neels', 'Kruger', 'neels.kruger@nwu.ac.za', 'Admin cancelled an accepted pickup, with a reason', 16],
  ['ReturnNotDueYet', 'Janet', 'Liebenberg', 'janet.liebenberg@nwu.ac.za', 'Outstanding return -- Not Due Yet', 20],
  ['ReturnPartlyResolved', 'Rudi', 'Serfontein', 'rudi.serfontein@nwu.ac.za', 'Outstanding return -- Partly Resolved (one unit written off)', 21],
  ['ReturnMixedHolder', 'Henri', 'van Rensburg', 'henri.vanrensburg@nwu.ac.za', 'One holder, three return states at once', 22],
  ['MultiBarcodeFull', 'Dumani', 'Kunjuzwa', 'dumani.kunjuzwa@nwu.ac.za', 'Multi-product, multi-barcode Stock Out, fully returned', 25],
  ['MultiBarcodePartial', 'Jeanne-Mari', 'Maree', 'jeanne.maree@nwu.ac.za', 'Multi-product, multi-barcode Stock Out, partly returned (rest due today)', 26],
  ['LostLabels', 'Heystek', 'Grobler', 'heystek.grobler@nwu.ac.za', 'Lost-label Returns demo (relabel flow)', 27],
  ['BadgeActive', 'Phenyo', 'Modisane', 'phenyo.modisane@nwu.ac.za', 'Staff badge activated (audit log); holds two items that are not due yet', 28],
  ['BadgeDeactivated', 'Gunther', 'Drevin', 'gunther.drevin@nwu.ac.za', 'Deactivated staff badge (audit log, inactive card)', 29],
  ['PortalLinked', 'Meiring', 'van Niekerk', '47817909@mynwu.ac.za', 'Portal borrower login -- owns the My Requests history', 30],
]

// Bostik Glu Dots as the live record the client demo created: a fixed historical moment (not relative to today), with the
// product written at 10:17:02.292 and its audit entry 115 ms later. Only the product is kept, none of that demo's
// transactions, so it has the 4 units it was created with.
const BOSTIK = {
  barcode: '6001364000266',
  createdAt: new Date('2026-09-29T08:17:02.292Z'),
  auditAt: new Date('2026-09-29T08:17:02.407Z'),
}

/**
 * Create Bostik Glu Dots through createProduct. That one save reads the clock twice (the product's created_at / updated_at,
 * then its audit entry), so it runs on a clock that returns the two original instants in turn: the product and its create
 * entry carry exactly the times the live record had.
 */
async function addBostik({ db, admin, categoryId, location }: SeedExtrasHelpers): Promise<void> {
  const clock = seedCtxSequence(db, [BOSTIK.createdAt, BOSTIK.auditAt], admin)
  const created = await createProduct(clock.ctx, {
    name: 'Bostik Glu Dots',
    barcodes: [BOSTIK.barcode],
    category_id: categoryId.Consumables,
    description: 'Bostik Glu Dots',
    quantity_on_hand: 4,
    reorder_threshold: 1,
    available: false,
    location,
    lend_from: '2026-09-29',
    lend_to: null,
    lending_interval: 'week_1',
    images: [],
  })
  clock.assertAllUsed()
  if (created.created_at !== BOSTIK.createdAt.toISOString()) {
    throw new Error(`Seed: Bostik Glu Dots was stamped ${created.created_at}, expected ${BOSTIK.createdAt.toISOString()}.`)
  }
}

export const DEMO_CAST: SeedCast = {
  title: 'Seeded the NWU demo data (seed:demo):',
  admin: DEMO_ADMIN,
  staff: DEMO_ROWS.map(([key, name, surname, email, scenario, position]): SeedCastMember => ({
    key,
    name,
    surname,
    email,
    department: DEPARTMENT,
    scenario,
    // As in seed:comprehensive, the first person's record is edited once (the staff 'update' audit entry): it starts in
    // Mathematical and Statistical Sciences and moves to Computer Science and Information Systems.
    ...(key === 'PendingFresh' ? { startDepartment: 'Mathematical and Statistical Sciences' } : {}),
    cardIndex: hasCardAt(position) ? position : null,
    // Only Meiring (the portal borrower) can sign in; the NWU staff are records only.
    login: key === 'PortalLinked',
  })),
  extras: addBostik,
  notes: [
    [
      `BOSTIK GLU DOTS: the product scanned in during the client demo (barcode ${BOSTIK.barcode},`,
      '  4 in stock, not available for lending) with its create entry in the Audit Log.',
    ],
  ],
}

export type SeedDemoDeps = Omit<SeedDeps, 'cast'>

export function seedDemo(deps: SeedDemoDeps): Promise<SeedSummary> {
  return seedComprehensive({ ...deps, cast: DEMO_CAST })
}

// Run only when started as a script (not when a test imports this file).
if (/[\\/]seed[\\/]demo\.ts$/.test(process.argv[1] ?? '')) {
  runSeedCli(seedDemo)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Seed failed:', err)
      process.exit(1)
    })
}

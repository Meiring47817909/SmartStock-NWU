// seed:video -- seed:comprehensive for recording the spin (marketing) video. Same products, categories, staff and
// scenarios; the only differences:
//   - Jessica Moore (the portal borrower, jessica.moore@nwu.ac.za / password123) starts with NO loan requests, so the one
//     she makes on camera is the only request of hers in My Requests, Loan Requests and Incoming Pickups.
//   - The My Requests history that seed:comprehensive gives Jessica (every tab and status, section 7) goes to Zoe Mitchell
//     (zoe.mitchell@nwu.ac.za / password123) instead, so the admin pages still show the full spread.
//   - Jessica has a card on file (so the Stock Out / Returns card tap finds her) and holds nothing on loan: the only
//     items she ever borrows are the ones she requests, collects and returns on camera.
//   - Three products are renamed (see productRenames) so the items she borrows sit on Browse page 2.
//
// Run it exactly like seed:comprehensive (emulators and PostgreSQL up, empty database or --reset):
//   npm run seed:video
import { COMPREHENSIVE_CAST, runSeedCli, seedComprehensive, type SeedCast, type SeedDeps, type SeedSummary } from './comprehensive'

// Jessica is last in the roster (position 30), which has no card in seed:comprehensive's card mix; 30 is used as her card
// index here, so her card number is one no other staff member has.
const JESSICA_CARD_INDEX = 30

export const VIDEO_CAST: SeedCast = {
  ...COMPREHENSIVE_CAST,
  title: 'Seeded spin-video demo data:',
  staff: COMPREHENSIVE_CAST.staff.map((m) =>
    m.key === 'PortalLinked'
      ? { ...m, cardIndex: JESSICA_CARD_INDEX, scenario: 'Portal borrower login -- starts with no loan requests and nothing on loan (spin video)' }
      : m.key === 'BadgeActive'
        ? { ...m, scenario: m.scenario + '; owns the full My Requests history (spin video)' }
        : m,
  ),
  spinVideo: {
    historyHolderKey: 'BadgeActive',
    // Browse lists products by name, 10 per page. These names sort the items Jessica borrows on camera onto page 2,
    // so the video can show her paging through the catalogue. Barcodes and photos are unchanged.
    productRenames: {
      '27-inch Monitor': 'Monitor 27-inch',
      '24-inch Monitor': 'Monitor 24-inch',
      'Compact Wireless Mouse': 'Mouse (Compact Wireless)',
    },
  },
}

export type SeedVideoDeps = Omit<SeedDeps, 'cast'>

export function seedVideo(deps: SeedVideoDeps): Promise<SeedSummary> {
  return seedComprehensive({ ...deps, cast: VIDEO_CAST })
}

// Run only when started as a script (not when a test imports this file).
if (/[\\/]seed[\\/]video\.ts$/.test(process.argv[1] ?? '')) {
  runSeedCli(seedVideo, VIDEO_CAST)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Seed failed:', err)
      process.exit(1)
    })
}

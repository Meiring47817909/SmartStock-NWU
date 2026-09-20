// Seeds the Firebase emulator with the real Computer Science and
// Information Systems staff roster the user provided — for testing against
// realistic staff data (Stock Out/Returns manual search, Staff page, the
// lending portal's "Send Login Email" flow) without touching the real
// project's `staff` collection.
//
// Run this AFTER `npm run emulators` is already up, in a separate terminal:
//   npm run seed:staff
//
// Talks to the emulators only (via the FIRESTORE_EMULATOR_HOST env var
// below) — never touches the real Firebase project, and needs zero real
// credentials to run. Safe to run multiple times (upserts by email, same
// pattern as the other seed scripts' upsert-by-barcode/upsert-by-name).
//
// Deliberately doesn't create Firebase Auth accounts or link `uid` — these
// records start exactly like a freshly-added staff member does in the real
// app (no card, no portal login yet), so "Send Login Email" and card-UID
// linking can be exercised from a clean state per person.

process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8081'

import { initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

const PROJECT_ID = 'demo-smartstock-nwu'

const app = initializeApp({ projectId: PROJECT_ID })
const db = getFirestore(app)

const DEPARTMENT = 'Computer Science and Information Systems'

// [name, surname, email] — email cased exactly as given, normalized to
// lowercase below to match how the app stores/compares every other email
// (see normalizeEmail() in src/lib/firebase/staff.ts).
const ROSTER = [
  ['Estelle', 'Taylor', 'Estelle.Taylor@nwu.ac.za'],
  ['Annette', 'van der Merwe', 'Annette.VanDerMerwe@nwu.ac.za'],
  ['Linda', 'Redelinghuys', 'Linda.redelinghuys@nwu.ac.za'],
  ['Rodney', 'Sebopelo', 'Rodney.Sebopelo@nwu.ac.za'],
  ['Susan', 'Campher', 'Susan.Campher@nwu.ac.za'],
  ['Kobus', 'van Aswegen', 'Kobus.VanAswegen@nwu.ac.za'],
  ['Tiny', 'du Toit', 'Tiny.DuToit@nwu.ac.za'],
  ['Marijke', 'Coetzee', 'marijke.coetzee@nwu.ac.za'],
  ['Lynette', 'Drevin', 'Lynette.Drevin@nwu.ac.za'],
  ['Absalom', 'Ezugwu', 'Absalom.Ezugwu@nwu.ac.za'],
  ['Dimitri', 'Keykaan', 'Dimi.Keykaan@nwu.ac.za'],
  ['Neels', 'Kruger', 'Neels.Kruger@nwu.ac.za'],
  ['Janet', 'Liebenberg', 'Janet.Liebenberg@nwu.ac.za'],
  ['Rudi', 'Serfontein', 'Rudi.Serfontein@nwu.ac.za'],
  ['Henri', 'van Rensburg', 'Henri.VanRensburg@nwu.ac.za'],
  ['Dumani', 'Kunjuzwa', 'Dumani.Kunjuzwa@nwu.ac.za'],
  ['Jeanne-Mari', 'Maree', 'Jeanne.Maree@nwu.ac.za'],
  ['Heystek', 'Grobler', 'Heystek.grobler@nwu.ac.za'],
  ['Phenyo', 'Modisane', 'Phenyo.Modisane@nwu.ac.za'],
  ['Gunther', 'Drevin', 'Gunther.Drevin@nwu.ac.za'],
]

async function upsertStaff(name, surname, rawEmail) {
  const email = rawEmail.trim().toLowerCase()
  const full_name = `${name} ${surname}`.trim()
  const now = new Date().toISOString()

  const existingSnap = await db.collection('staff').where('email', '==', email).get()
  const payload = {
    name, surname, full_name, email, department: DEPARTMENT,
    updated_at: now,
  }

  if (!existingSnap.empty) {
    await existingSnap.docs[0].ref.set(payload, { merge: true })
    return { id: existingSnap.docs[0].id, full_name, status: 'updated' }
  }

  const ref = await db.collection('staff').add({
    ...payload,
    card_uid: null,
    is_active: true,
    uid: null,
    created_at: now,
  })
  return { id: ref.id, full_name, status: 'created' }
}

async function main() {
  const results = []
  for (const [name, surname, email] of ROSTER) {
    results.push(await upsertStaff(name, surname, email))
  }

  console.log(`Seeded ${results.length} staff members (${DEPARTMENT}):`)
  for (const r of results) console.log(`  ${r.status === 'created' ? '+' : '~'} ${r.full_name} — ${r.id}`)
  console.log('')
  console.log('View in Firestore emulator UI: http://127.0.0.1:4000')
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Seed failed:', err)
    process.exit(1)
  })

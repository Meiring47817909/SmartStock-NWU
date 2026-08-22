// Seeds the Firebase emulators (Auth + Firestore) with just enough fake
// data to test the staff login-provisioning feature locally — see
// handout.md, "Testing locally with the Firebase emulators".
//
// Run this AFTER `npm run emulators` is already up, in a separate terminal:
//   npm run seed:emulators
//
// Talks to the emulators only (via the FIREBASE_*_EMULATOR_HOST env vars
// below) — never touches the real Firebase project, and needs zero real
// credentials to run.

process.env.FIREBASE_AUTH_EMULATOR_HOST ||= '127.0.0.1:9099'
process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8081'

import { initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore } from 'firebase-admin/firestore'

// Keep in sync with EMULATOR_PROJECT_ID in src/lib/firebase/config.ts and
// src/lib/firebase/admin.ts.
const PROJECT_ID = 'demo-smartstock-nwu'

const app = initializeApp({ projectId: PROJECT_ID })
const auth = getAuth(app)
const db = getFirestore(app)

async function upsertAdminUser(email, password, uid) {
  try {
    return await auth.getUserByEmail(email)
  } catch {
    return await auth.createUser({ uid, email, password, emailVerified: true })
  }
}

async function main() {
  // A real, known-password account for signing into the app itself (as
  // admin) so you can exercise the Staff page and click "Send Login Email".
  // This is NOT the pattern the feature itself uses for staff/borrower
  // accounts — see the passwordless createUser() call in
  // src/app/api/staff/send-reset-email/route.ts — this one just needs a
  // password because it's how *you* log into SmartStock-NWU to test it.
  const admin = await upsertAdminUser('admin@nwu.test', 'password123', 'seed-admin')
  await db.collection('profiles').doc(admin.uid).set(
    {
      id: admin.uid,
      full_name: 'Test Admin',
      role: 'admin',
      created_at: new Date().toISOString(),
    },
    { merge: true },
  )

  // A staff/borrower record with a fake email and no linked uid yet —
  // click "Send Login Email" on this one in the UI to exercise the
  // create-account-and-send path. Click it again afterwards to exercise
  // the resend path.
  const staffId = 'seed-staff-1'
  await db.collection('staff').doc(staffId).set(
    {
      name: 'Test',
      surname: 'Borrower',
      full_name: 'Test Borrower',
      email: 'test.borrower@example.com',
      department: 'Testing',
      card_uid: null,
      is_active: true,
      uid: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    { merge: true },
  )

  console.log('Seeded emulator data:')
  console.log(`  App login (admin role): admin@nwu.test / password123`)
  console.log(`  Staff record: "${staffId}" — test.borrower@example.com, no uid yet`)
  console.log('')
  console.log('Emulator UI: http://127.0.0.1:4000')
  console.log('  Auth tab — see created accounts, incl. one created by "Send Login Email"')
  console.log('  Firestore tab — see the `staff` doc pick up its `uid` field')
  console.log('  Auth emulator never sends real email — grab the reset link from:')
  console.log(`    http://127.0.0.1:9099/emulator/v1/projects/${PROJECT_ID}/oobCodes`)
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Seed failed:', err)
    process.exit(1)
  })

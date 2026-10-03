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

// Get-or-create an Auth account with a known password. Named generically
// because it's used for both the BICS admin and the portal borrower below —
// under the two-role model those are the only two kinds of login there are.
async function upsertUser(email, password, uid) {
  try {
    return await auth.getUserByEmail(email)
  } catch {
    try {
      // The same account left over from an earlier run under an old email (the
      // emulators keep their data while they stay up): adopt it.
      return await auth.updateUser(uid, { email, emailVerified: true })
    } catch {
      return await auth.createUser({ uid, email, password, emailVerified: true })
    }
  }
}

async function main() {
  // A real, known-password account for signing into the app itself (as
  // admin) so you can exercise the Staff page and click "Send Login Email".
  // This is NOT the pattern the feature itself uses for staff/borrower
  // accounts — see the passwordless createUser() call in
  // src/app/api/staff/send-reset-email/route.ts — this one just needs a
  // password because it's how *you* log into SmartStock-NWU to test it.
  const admin = await upsertUser('jonathan.pritchard@nwu.ac.za', 'password123', 'seed-admin')
  await db.collection('profiles').doc(admin.uid).set(
    {
      id: admin.uid,
      full_name: 'Test Admin',
      role: 'admin',
      created_at: new Date().toISOString(),
    },
    { merge: true },
  )

  // The portal borrower: a staff record with a real Auth account and a
  // known password, linked via `uid` — sign straight into /lend as this
  // person without going near the reset-email flow. Since the two-role
  // change, 'staff' means lending-portal-only, so this is the account that
  // exercises everything a non-admin can actually do.
  // uid is 'seed-test-borrower', NOT 'seed-borrower' — seed-lending-portal.mjs
  // already claims that one for borrower@nwu.test. Both scripts are meant to
  // be run against the same emulator, and createUser() with a uid that
  // already exists throws auth/uid-already-exists, so the two must not collide.
  const borrower = await upsertUser('test.borrower@example.com', 'password123', 'seed-test-borrower')
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
      uid: borrower.uid,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    { merge: true },
  )

  // Linking the borrower above means clicking "Send Login Email" on that row
  // now takes the *resend* branch, so this second record keeps the
  // create-account-and-send path testable from a genuinely clean state:
  // no Auth account, no uid, exactly like a freshly-added staff member.
  // Click it once for the create path, again for the resend path.
  const unlinkedStaffId = 'seed-staff-2'
  await db.collection('staff').doc(unlinkedStaffId).set(
    {
      name: 'Unprovisioned',
      surname: 'Borrower',
      full_name: 'Unprovisioned Borrower',
      email: 'new.borrower@example.com',
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
  console.log(`  BICS admin (full access):      jonathan.pritchard@nwu.ac.za / password123          → /dashboard`)
  console.log(`  Portal borrower (lend only):   test.borrower@example.com / password123 → /lend`)
  console.log(`  Unprovisioned staff record:    new.borrower@example.com — no account yet, for "Send Login Email"`)
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

// Seeds the Firebase emulators with enough fake data to test the lending
// portal end-to-end locally — an admin (BICS) account, a portal-borrower
// account already linked to a staff record (skips the "Send Login Email"
// provisioning flow — see seed-emulator.mjs for that path instead), and one
// lendable product.
//
// Run this AFTER `npm run emulators` is already up, in a separate terminal:
//   npm run seed:lending
//
// Talks to the emulators only (via the FIREBASE_*_EMULATOR_HOST env vars
// below) — never touches the real Firebase project, and needs zero real
// credentials to run. Safe to run multiple times (upserts).

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

function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  dt.setDate(dt.getDate() + days)
  const mm = String(dt.getMonth() + 1).padStart(2, '0')
  const dd = String(dt.getDate()).padStart(2, '0')
  return `${dt.getFullYear()}-${mm}-${dd}`
}
function todayStr() {
  const dt = new Date()
  const mm = String(dt.getMonth() + 1).padStart(2, '0')
  const dd = String(dt.getDate()).padStart(2, '0')
  return `${dt.getFullYear()}-${mm}-${dd}`
}

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

// Same 7-category list as seed-products.mjs, kept duplicated here rather
// than factored into a shared helper — matches this project's existing
// convention of small, self-contained seed scripts. Only the one category
// this script's product actually needs is upserted (not all 7) — run
// seed:products too if you want the full set for the Categories page.
async function upsertCategory(name, description) {
  const existingSnap = await db.collection('categories').where('name', '==', name).get()
  if (!existingSnap.empty) {
    const ref = existingSnap.docs[0].ref
    await ref.set({ description }, { merge: true })
    return ref.id
  }
  const ref = await db.collection('categories').add({ name, description, created_at: new Date().toISOString() })
  return ref.id
}

async function main() {
  // BICS admin — signs into /login, approves/counters requests at /loan-requests.
  const admin = await upsertUser('jonathan.pritchard@nwu.ac.za', 'password123', 'seed-admin')
  await db.collection('profiles').doc(admin.uid).set(
    { id: admin.uid, full_name: 'Test Admin', role: 'admin', created_at: new Date().toISOString() },
    { merge: true },
  )

  // Portal borrower — signs into /lend/login, browses/requests equipment.
  // Already linked (uid set) so you can log straight in without going
  // through the Staff page's "Send Login Email" flow.
  const borrower = await upsertUser('borrower@nwu.test', 'password123', 'seed-borrower')
  const staffId = 'seed-staff-borrower'
  await db.collection('staff').doc(staffId).set(
    {
      name: 'Portal', surname: 'Borrower', full_name: 'Portal Borrower',
      email: 'borrower@nwu.test', department: 'Testing', card_uid: null,
      is_active: true, uid: borrower.uid,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    },
    { merge: true },
  )

  // A lendable product with an open window and a few units on hand.
  // No dedicated AV/presentation category exists in the current category
  // list — Peripherals ("Keyboards, mice, monitors, webcams") is the
  // closest fit as a display/output device, same call made for the Epson
  // projector in seed-products.mjs.
  const peripheralsCategoryId = await upsertCategory('Peripherals', 'Keyboards, mice, monitors, webcams')
  const today = todayStr()
  const existing = await db.collection('products').where('barcodes', 'array-contains', 'TESTPROJ001').get()
  const productId = existing.empty ? undefined : existing.docs[0].id
  const productPayload = {
    // Denormalized, same as the app's own handleSave (products/page.tsx) —
    // the Products table reads p.category_name directly rather than
    // joining against category_id at render time.
    category_id: peripheralsCategoryId, category_name: 'Peripherals', name: 'Test Projector', description: 'Seed product for lending portal testing',
    barcodes: ['TESTPROJ001'], quantity_on_hand: 3, reorder_threshold: 1, available: true,
    location: 'NWU - Potchefstroom, Building G4, Room 28', lend_from: today, lend_to: addDays(today, 30),
    updated_at: new Date().toISOString(),
  }
  let productRef
  if (productId) {
    productRef = db.collection('products').doc(productId)
    await productRef.set(productPayload, { merge: true })
  } else {
    productRef = await db.collection('products').add({ ...productPayload, created_at: new Date().toISOString() })
  }

  console.log('Seeded lending-portal test data:')
  console.log(`  BICS admin login:    jonathan.pritchard@nwu.ac.za / password123  →  http://localhost:3000/login`)
  console.log(`  Portal borrower login: borrower@nwu.test / password123  →  http://localhost:3000/lend/login`)
  console.log(`  Product: ${productRef.id} — Test Projector, qty ${productPayload.quantity_on_hand}, lendable ${today}..${productPayload.lend_to}`)
  console.log('')
  console.log('Run alongside: npm run dev:emulators')
  console.log('Emulator UI: http://127.0.0.1:4000')
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Seed failed:', err)
    process.exit(1)
  })

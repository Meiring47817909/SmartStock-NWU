// Seeds the Firebase emulators with OUT transactions in every state the
// Dashboard's Outstanding Returns / Resolve flow and the Staff page's
// expandable "currently held" rows need to be exercised against:
//   - no return date agreed (the main "will never come back" case)
//   - overdue
//   - due today
//   - not due yet
//   - one item already resolved (a return_waivers doc exists), sitting
//     alongside a still-outstanding item for the same person
//   - one person holding several items in different states at once, to
//     exercise the Staff page's multi-row expand
//
// Every OUT transaction and its lines are written directly with the Admin
// SDK rather than driven through the Stock Out UI — this is historical
// ledger data, the same shape handleConfirm() in stock-out/page.tsx writes,
// just backdated so the dates read as realistic instead of everything
// having been "issued just now".
//
// Run this AFTER `npm run emulators` is already up, in a separate terminal:
//   npm run seed:outstanding
//
// Talks to the emulators only (via the FIRESTORE_EMULATOR_HOST env var
// below) — never touches the real Firebase project, and needs zero real
// credentials to run. NOT safe to blindly re-run and expect the same
// numbers: it upserts staff/products by name, but every run adds a fresh
// batch of OUT transactions and lines (the ledger is append-only, same as
// the real app — see transactions' `allow update, delete: if false` rule),
// so re-running doubles up the outstanding quantities. Run
// `npm run cleanup:borrower-test`'s sibling for this data if one gets
// added later, or just watch the Dashboard for numbers that look doubled.

process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8081'

import { initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

const PROJECT_ID = 'demo-smartstock-nwu'
const LOCATION = 'NWU - Potchefstroom, Building G4, Room 28'
const DEPARTMENT = 'Computer Science and Information Systems'

const app = initializeApp({ projectId: PROJECT_ID })
const db = getFirestore(app)

function todayStr() {
  const dt = new Date()
  const mm = String(dt.getMonth() + 1).padStart(2, '0')
  const dd = String(dt.getDate()).padStart(2, '0')
  return `${dt.getFullYear()}-${mm}-${dd}`
}
function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  dt.setDate(dt.getDate() + days)
  const mm = String(dt.getMonth() + 1).padStart(2, '0')
  const dd = String(dt.getDate()).padStart(2, '0')
  return `${dt.getFullYear()}-${mm}-${dd}`
}
function genRef() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  let result = 'TXN-'
  for (let i = 0; i < 8; i++) result += chars.charAt(Math.floor(Math.random() * chars.length))
  return result
}

const TODAY = todayStr()

// ---- Products these scenarios issue against -------------------------------
// Kept separate from seed-products.mjs's catalogue (different barcode
// prefix) so this script never fights that one over the same docs, and
// works whether or not seed-products has been run at all.
const PRODUCTS = [
  { name: 'Seed Test Drill', barcode: 'SEED-OUT-DRILL', reorder_threshold: 2 },
  { name: 'Seed Test Laptop Charger', barcode: 'SEED-OUT-CHARGER', reorder_threshold: 3 },
  { name: 'Seed Test Whiteboard Marker Set', barcode: 'SEED-OUT-MARKERS', reorder_threshold: 5 },
  { name: 'Seed Test Camera Tripod', barcode: 'SEED-OUT-TRIPOD', reorder_threshold: 1 },
  { name: 'Seed Test HDMI Adapter', barcode: 'SEED-OUT-HDMI', reorder_threshold: 4 },
]

async function upsertProduct(spec) {
  const existingSnap = await db.collection('products').where('barcodes', 'array-contains', spec.barcode).get()
  const now = new Date().toISOString()
  const payload = {
    category_id: null,
    name: spec.name,
    description: 'Seed data for testing Outstanding Returns / Resolve / Staff lending rows.',
    barcodes: [spec.barcode],
    reorder_threshold: spec.reorder_threshold,
    available: true,
    location: LOCATION,
    // Set once here so the product has SOME lend window (Availability
    // requires lend_from) — not the point of this script, so an
    // indefinite one (no lend_to) is fine.
    lend_from: addDays(TODAY, -90),
    lend_to: null,
    updated_at: now,
  }
  if (!existingSnap.empty) {
    const ref = existingSnap.docs[0].ref
    // Don't stomp quantity_on_hand on a re-run — see the decrement loop
    // below, which treats it as authoritative and keeps subtracting from
    // whatever's already there.
    await ref.set(payload, { merge: true })
    return { id: ref.id, name: spec.name }
  }
  const ref = await db.collection('products').add({
    ...payload,
    quantity_on_hand: 30,
    created_at: now,
    images: [],
  })
  return { id: ref.id, name: spec.name }
}

// ---- Staff these scenarios belong to ---------------------------------------
const STAFF = [
  { name: 'Seed', surname: 'NoDate', full_name: 'Seed Outstanding — No Date', email: 'seed.outstanding.nodate@example.com' },
  { name: 'Seed', surname: 'Overdue', full_name: 'Seed Outstanding — Overdue', email: 'seed.outstanding.overdue@example.com' },
  { name: 'Seed', surname: 'DueToday', full_name: 'Seed Outstanding — Due Today', email: 'seed.outstanding.duetoday@example.com' },
  { name: 'Seed', surname: 'NotDue', full_name: 'Seed Outstanding — Not Due Yet', email: 'seed.outstanding.notdue@example.com' },
  { name: 'Seed', surname: 'AlreadyResolved', full_name: 'Seed Outstanding — Partly Resolved', email: 'seed.outstanding.resolved@example.com' },
  { name: 'Seed', surname: 'Mixed', full_name: 'Seed Outstanding — Mixed (multiple items)', email: 'seed.outstanding.mixed@example.com' },
]

async function upsertStaff(spec) {
  const now = new Date().toISOString()
  const existingSnap = await db.collection('staff').where('email', '==', spec.email).get()
  const payload = {
    name: spec.name, surname: spec.surname, full_name: spec.full_name,
    email: spec.email, department: DEPARTMENT, is_active: true,
    updated_at: now,
  }
  if (!existingSnap.empty) {
    const ref = existingSnap.docs[0].ref
    await ref.set(payload, { merge: true })
    return { id: ref.id, full_name: spec.full_name }
  }
  const ref = await db.collection('staff').add({
    ...payload, card_uid: null, uid: null, created_at: now,
  })
  return { id: ref.id, full_name: spec.full_name }
}

// Writes one OUT transaction + one transaction_lines doc per cart item, and
// decrements the product's quantity_on_hand — the same three writes
// handleConfirm() makes in stock-out/page.tsx, just with `created_at` and
// `lend_from`/`lend_to` backdated so the scenario reads as realistic
// history rather than "issued one second ago".
async function issueOut({ staff, items, lendFrom, lendTo, issuedAt }) {
  const ref = genRef()
  const txnPayload = {
    transaction_type: 'OUT',
    reference_no: ref,
    staff_id: staff.id,
    staff_name: staff.full_name,
    user_id: null,
    notes: 'Seeded by scripts/seed-outstanding.mjs',
    return_date: null,
    linked_txn_id: null,
    manual_override: true,
    lend_from: lendFrom,
    lend_to: lendTo,
    linked_request_id: null,
    created_at: issuedAt,
  }
  const txnRef = await db.collection('transactions').add(txnPayload)

  for (const item of items) {
    await db.collection('transaction_lines').add({
      transaction_id: txnRef.id,
      product_id: item.product.id,
      quantity: item.quantity,
      unit_cost: 0,
      product_name: item.product.name,
      created_at: issuedAt,
    })
    await db.collection('products').doc(item.product.id).update({
      quantity_on_hand: item.product.quantity_on_hand - item.quantity,
      updated_at: new Date().toISOString(),
    })
    // Keep the in-memory record in sync so a second issue against the same
    // product later in this same run decrements from the right number.
    item.product.quantity_on_hand -= item.quantity
  }

  return { id: txnRef.id, reference_no: ref }
}

async function writeWaiver({ txn, product, staff, quantity }) {
  const payload = {
    transaction_id: txn.id,
    product_id: product.id,
    product_name: product.name,
    staff_id: staff.id,
    staff_name: staff.full_name,
    quantity,
    reason: null,
    created_at: new Date().toISOString(),
    resolved_by_uid: null,
    resolved_by_name: 'Seed Script (pre-resolved for testing)',
  }
  await db.collection('return_waivers').add(payload)
}

async function main() {
  const products = {}
  for (const spec of PRODUCTS) {
    const p = await upsertProduct(spec)
    products[spec.name] = { ...p, quantity_on_hand: 30 }
  }
  // Re-fetch actual current quantity_on_hand rather than assuming 30 — a
  // second run of this script would otherwise decrement from the wrong
  // starting point and eventually go negative.
  for (const name of Object.keys(products)) {
    const snap = await db.collection('products').doc(products[name].id).get()
    products[name].quantity_on_hand = snap.data()?.quantity_on_hand ?? 30
  }

  const staffByRole = {}
  for (const spec of STAFF) {
    staffByRole[spec.surname] = await upsertStaff(spec)
  }

  const drill = products['Seed Test Drill']
  const charger = products['Seed Test Laptop Charger']
  const markers = products['Seed Test Whiteboard Marker Set']
  const tripod = products['Seed Test Camera Tripod']
  const hdmi = products['Seed Test HDMI Adapter']

  // 1. No return date agreed — the main "will probably never come back"
  //    case the Dashboard's Resolve button and the Staff page's "No Return
  //    Date" badge exist for.
  await issueOut({
    staff: staffByRole['NoDate'],
    items: [{ product: drill, quantity: 1 }],
    lendFrom: addDays(TODAY, -5),
    lendTo: null,
    issuedAt: new Date(addDays(TODAY, -5)).toISOString(),
  })

  // 2. Overdue — a real return date was agreed, and it's passed.
  await issueOut({
    staff: staffByRole['Overdue'],
    items: [{ product: charger, quantity: 2 }],
    lendFrom: addDays(TODAY, -15),
    lendTo: addDays(TODAY, -3),
    issuedAt: new Date(addDays(TODAY, -15)).toISOString(),
  })

  // 3. Due today.
  await issueOut({
    staff: staffByRole['DueToday'],
    items: [{ product: tripod, quantity: 1 }],
    lendFrom: addDays(TODAY, -7),
    lendTo: TODAY,
    issuedAt: new Date(addDays(TODAY, -7)).toISOString(),
  })

  // 4. Not due yet.
  await issueOut({
    staff: staffByRole['NotDue'],
    items: [{ product: markers, quantity: 3 }],
    lendFrom: addDays(TODAY, -1),
    lendTo: addDays(TODAY, 14),
    issuedAt: new Date(addDays(TODAY, -1)).toISOString(),
  })

  // 5. One item already resolved (a return_waivers doc pre-written, so
  //    "No Return Due" shows immediately with nothing to click), sitting
  //    next to a still-outstanding item for the SAME person — on two
  //    separate OUT transactions, exactly like a real waiver is scoped
  //    (per-transaction, never a flat per-product total). Exercises: the
  //    Staff page showing both a resolved and an active row for one
  //    person, and that the Lending badge stays on because of the second
  //    item even though the first is done.
  const resolvedTxn = await issueOut({
    staff: staffByRole['AlreadyResolved'],
    items: [{ product: hdmi, quantity: 1 }],
    lendFrom: addDays(TODAY, -30),
    lendTo: null,
    issuedAt: new Date(addDays(TODAY, -30)).toISOString(),
  })
  await writeWaiver({ txn: resolvedTxn, product: hdmi, staff: staffByRole['AlreadyResolved'], quantity: 1 })
  await issueOut({
    staff: staffByRole['AlreadyResolved'],
    items: [{ product: drill, quantity: 1 }],
    lendFrom: addDays(TODAY, -2),
    lendTo: addDays(TODAY, 5),
    issuedAt: new Date(addDays(TODAY, -2)).toISOString(),
  })

  // 6. One person holding several different items in different states at
  //    once — the main exercise for the Staff page's expandable multi-row
  //    list (Dashboard only shows the top 8 rows overall, so this is the
  //    easiest place to see three statuses stacked together).
  await issueOut({
    staff: staffByRole['Mixed'],
    items: [{ product: charger, quantity: 1 }],
    lendFrom: addDays(TODAY, -20),
    lendTo: null,
    issuedAt: new Date(addDays(TODAY, -20)).toISOString(),
  })
  await issueOut({
    staff: staffByRole['Mixed'],
    items: [{ product: markers, quantity: 1 }],
    lendFrom: addDays(TODAY, -10),
    lendTo: addDays(TODAY, -1),
    issuedAt: new Date(addDays(TODAY, -10)).toISOString(),
  })
  await issueOut({
    staff: staffByRole['Mixed'],
    items: [{ product: tripod, quantity: 1 }],
    lendFrom: TODAY,
    lendTo: addDays(TODAY, 30),
    issuedAt: new Date().toISOString(),
  })

  console.log('Seeded outstanding-returns test data:')
  console.log('')
  console.log('  Dashboard → Outstanding Returns, one row per status:')
  console.log('    Seed Outstanding — No Date        → "No Return Date" badge, Resolve')
  console.log('    Seed Outstanding — Overdue         → "Overdue" badge, Resolve')
  console.log('    Seed Outstanding — Due Today       → "Due Today" badge, Resolve')
  console.log('    Seed Outstanding — Not Due Yet     → "Not Due Yet" badge, Resolve')
  console.log('    Seed Outstanding — Partly Resolved → one outstanding line (Resolve), one already resolved')
  console.log('    Seed Outstanding — Mixed           → 3 outstanding lines, mixed statuses')
  console.log('')
  console.log('  Staff page → expand any "Seed Outstanding —" row to see the same items,')
  console.log('  plus its own Resolve button on each still-outstanding line.')
  console.log('')
  console.log(' "Seed Outstanding — Partly Resolved" already has one line marked')
  console.log('  "No Return Due" (a return_waivers doc pre-written) — expand it to see that')
  console.log('  state without clicking Resolve yourself first.')
  console.log('')
  console.log('  Re-running this script adds a fresh batch on top (transactions are')
  console.log('  append-only, like the real app) — quantities will look doubled if you')
  console.log('  run it more than once without clearing the emulator data.')
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Seed failed:', err)
    process.exit(1)
  })

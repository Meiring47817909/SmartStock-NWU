// Seeds the Firebase emulators with test data for the three feature sets
// built on 2026-09-20:
//
//   1. Staff page badge variety — a staff member with Card UID linked AND
//      portal access granted, one with only a card, one with only portal
//      access, one with neither, and a DEACTIVATED one (to see "Send Login
//      Email" disabled). Also writes two ready-made Audit Log entries
//      (an activate and a deactivate) so /audit-log has something to look
//      at immediately, without you clicking a toggle first.
//
//   2. Portal Browse page — two fully-checked-out ("Unavailable") products:
//      one with a known expected return date, one with none (open-ended
//      issue), so both label variants can be seen.
//
//   3. Stock Out's loan-request awareness — three products, each paired
//      with a different reservation state, so all three Confirm-step
//      outcomes can be exercised:
//        - "Hard Block"    — an ACCEPTED request holds all the stock.
//                            Walk-in issuing this to anyone else is blocked.
//        - "Soft Warning"  — only a PENDING request holds the stock.
//                            Walk-in issuing this to anyone else just warns.
//        - "FYI"           — an ACCEPTED request holds some stock, but
//                            there's plenty spare. Walk-in issuing a unit
//                            or two shows the informational "Heads up"
//                            panel, nothing blocks.
//
// Run this AFTER `npm run emulators` is already up, in a separate terminal:
//   node scripts/seed-conflict-scenarios.mjs
//
// Talks to the emulators only (via the FIRESTORE_EMULATOR_HOST env var
// below) — never touches the real Firebase project, and needs zero real
// credentials to run. Staff/product upserts are safe to re-run (by
// email/barcode, same convention as the other seed scripts). The OUT
// transaction and loan_requests writes are NOT — like seed-outstanding.mjs,
// they're append-only ledger data, so re-running adds a second batch
// instead of resetting the first. If a scenario needs a clean slate, clear
// it from the emulator UI (http://127.0.0.1:4000) first.

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

// ---------------------------------------------------------------------------
// Shared upsert helpers (same upsert-by-email / upsert-by-barcode
// convention as seed-outstanding.mjs / seed-staff-roster.mjs)
// ---------------------------------------------------------------------------
async function upsertStaff(spec) {
  const now = new Date().toISOString()
  const existingSnap = await db.collection('staff').where('email', '==', spec.email).get()
  const payload = {
    name: spec.name, surname: spec.surname, full_name: spec.full_name,
    email: spec.email, department: DEPARTMENT,
    is_active: spec.is_active ?? true,
    card_uid: spec.card_uid ?? null,
    uid: spec.uid ?? null,
    updated_at: now,
  }
  if (!existingSnap.empty) {
    const ref = existingSnap.docs[0].ref
    await ref.set(payload, { merge: true })
    return { id: ref.id, full_name: spec.full_name }
  }
  const ref = await db.collection('staff').add({ ...payload, created_at: now })
  return { id: ref.id, full_name: spec.full_name }
}

async function upsertProduct(spec) {
  const existingSnap = await db.collection('products').where('barcodes', 'array-contains', spec.barcode).get()
  const now = new Date().toISOString()
  const payload = {
    category_id: null,
    name: spec.name,
    description: spec.description ?? 'Seed data — scripts/seed-conflict-scenarios.mjs',
    barcodes: [spec.barcode],
    reorder_threshold: spec.reorder_threshold ?? 1,
    available: true,
    location: LOCATION,
    lend_from: addDays(TODAY, -90),
    lend_to: null,
    updated_at: now,
  }
  if (!existingSnap.empty) {
    const ref = existingSnap.docs[0].ref
    // Don't stomp quantity_on_hand on a re-run, same reasoning as
    // seed-outstanding.mjs — treat whatever's already there as authoritative.
    await ref.set(payload, { merge: true })
    const snap = await ref.get()
    return { id: ref.id, name: spec.name, barcode: spec.barcode, quantity_on_hand: snap.data()?.quantity_on_hand ?? spec.quantity_on_hand }
  }
  const ref = await db.collection('products').add({
    ...payload, quantity_on_hand: spec.quantity_on_hand, created_at: now, images: [],
  })
  return { id: ref.id, name: spec.name, barcode: spec.barcode, quantity_on_hand: spec.quantity_on_hand }
}

// Same three writes handleConfirm() makes in stock-out/page.tsx (transaction
// + lines + quantity_on_hand decrement), backdated — see seed-outstanding.mjs.
async function issueOut({ staff, items, lendFrom, lendTo, issuedAt }) {
  const ref = genRef()
  const txnRef = await db.collection('transactions').add({
    transaction_type: 'OUT', reference_no: ref,
    staff_id: staff.id, staff_name: staff.full_name,
    user_id: null, operator_name: 'Seed Script',
    notes: 'Seeded by scripts/seed-conflict-scenarios.mjs',
    return_date: null, linked_txn_id: null, manual_override: true,
    lend_from: lendFrom, lend_to: lendTo,
    linked_request_id: null, linked_request_ref: null,
    created_at: issuedAt,
  })
  for (const item of items) {
    await db.collection('transaction_lines').add({
      transaction_id: txnRef.id, product_id: item.product.id, quantity: item.quantity,
      unit_cost: 0, product_name: item.product.name,
      barcode: item.product.barcode ?? null, // scanned at Stock Out; required to return it later
      created_at: issuedAt,
    })
    await db.collection('products').doc(item.product.id).update({
      quantity_on_hand: item.product.quantity_on_hand - item.quantity, updated_at: new Date().toISOString(),
    })
  }
  return { id: txnRef.id, reference_no: ref }
}

async function createLoanRequest({ staff, product, quantity, status, fromDate, toDate }) {
  const now = new Date().toISOString()
  const reqRef = await db.collection('loan_requests').add({
    staff_id: staff.id, staff_name: staff.full_name, status,
    message: null,
    from_date: fromDate, to_date: toDate,
    original_from_date: fromDate, original_to_date: toDate,
    created_at: now, updated_at: now, fulfilled_txn_id: null,
  })
  await db.collection('loan_request_lines').add({
    request_id: reqRef.id, product_id: product.id, product_name: product.name,
    requested_quantity: quantity, offered_quantity: quantity, created_at: now,
  })
  return { id: reqRef.id }
}

async function writeAuditEntry({ staff, action }) {
  await db.collection('audit_log').add({
    user_id: 'seed-script', user_name: 'Seed Script',
    action, entity_type: 'staff', entity_id: staff.id,
    before: { is_active: action === 'deactivate', name: staff.full_name.split(' ')[0], surname: staff.full_name.split(' ').slice(1).join(' '), full_name: staff.full_name, email: staff.email },
    after: { is_active: action !== 'deactivate', name: staff.full_name.split(' ')[0], surname: staff.full_name.split(' ').slice(1).join(' '), full_name: staff.full_name, email: staff.email },
    created_at: new Date().toISOString(),
  })
}

async function main() {
  // ---- 1. Staff badge variety + audit log entries --------------------------
  const badgeSpecs = [
    { name: 'Seed', surname: 'FullyLinked', full_name: 'Seed Badges — Fully Linked', email: 'seed.badges.linked@example.com', card_uid: 'CARD-SEED-0001', uid: 'seed-badges-linked-uid', is_active: true },
    { name: 'Seed', surname: 'CardOnly', full_name: 'Seed Badges — Card Only', email: 'seed.badges.cardonly@example.com', card_uid: 'CARD-SEED-0002', uid: null, is_active: true },
    { name: 'Seed', surname: 'PortalOnly', full_name: 'Seed Badges — Portal Only', email: 'seed.badges.portalonly@example.com', card_uid: null, uid: 'seed-badges-portalonly-uid', is_active: true },
    { name: 'Seed', surname: 'Neither', full_name: 'Seed Badges — Neither', email: 'seed.badges.neither@example.com', card_uid: null, uid: null, is_active: true },
    { name: 'Seed', surname: 'Deactivated', full_name: 'Seed Badges — Deactivated', email: 'seed.badges.deactivated@example.com', card_uid: 'CARD-SEED-0003', uid: 'seed-badges-deactivated-uid', is_active: false },
  ]
  const badgeStaff = {}
  for (const spec of badgeSpecs) badgeStaff[spec.surname] = { ...(await upsertStaff(spec)), email: spec.email }

  await writeAuditEntry({ staff: badgeStaff['FullyLinked'], action: 'activate' })
  await writeAuditEntry({ staff: badgeStaff['Deactivated'], action: 'deactivate' })

  // ---- 2. Portal Browse — "Unavailable" cards -------------------------------
  const soldOutDated = await upsertProduct({
    name: 'Seed Portal — Sold Out (return date known)', barcode: 'SEED-PORTAL-SOLDOUT-DATED', quantity_on_hand: 1,
  })
  const soldOutNoDate = await upsertProduct({
    name: 'Seed Portal — Sold Out (no return date)', barcode: 'SEED-PORTAL-SOLDOUT-NODATE', quantity_on_hand: 1,
  })
  const portalHolder = await upsertStaff({
    name: 'Seed', surname: 'PortalHolder', full_name: 'Seed Portal — Current Holder', email: 'seed.portal.holder@example.com',
  })
  if (soldOutDated.quantity_on_hand > 0) {
    await issueOut({
      staff: portalHolder, items: [{ product: soldOutDated, quantity: soldOutDated.quantity_on_hand }],
      lendFrom: TODAY, lendTo: addDays(TODAY, 5), issuedAt: new Date().toISOString(),
    })
  }
  if (soldOutNoDate.quantity_on_hand > 0) {
    await issueOut({
      staff: portalHolder, items: [{ product: soldOutNoDate, quantity: soldOutNoDate.quantity_on_hand }],
      lendFrom: TODAY, lendTo: null, issuedAt: new Date().toISOString(),
    })
  }

  // ---- 3. Stock Out — hard block / soft warning / FYI -----------------------
  const hardBlockProduct = await upsertProduct({
    name: 'Seed Conflict — Hard Block (fully reserved)', barcode: 'SEED-CONFLICT-BLOCK', quantity_on_hand: 2,
  })
  const softWarnProduct = await upsertProduct({
    name: 'Seed Conflict — Soft Warning (pending only)', barcode: 'SEED-CONFLICT-WARN', quantity_on_hand: 2,
  })
  const fyiProduct = await upsertProduct({
    name: 'Seed Conflict — FYI (plenty of stock)', barcode: 'SEED-CONFLICT-FYI', quantity_on_hand: 5,
  })

  const acceptedHolder = await upsertStaff({
    name: 'Seed', surname: 'AcceptedHolder', full_name: 'Seed Conflict — Accepted Holder', email: 'seed.conflict.holder@example.com',
  })
  const pendingProposer = await upsertStaff({
    name: 'Seed', surname: 'PendingProposer', full_name: 'Seed Conflict — Pending Proposer', email: 'seed.conflict.proposer@example.com',
  })
  const fyiHolder = await upsertStaff({
    name: 'Seed', surname: 'FyiHolder', full_name: 'Seed Conflict — FYI Holder', email: 'seed.conflict.fyiholder@example.com',
  })

  const windowFrom = TODAY
  const windowTo = addDays(TODAY, 7)

  await createLoanRequest({
    staff: acceptedHolder, product: hardBlockProduct, quantity: 2,
    status: 'accepted', fromDate: windowFrom, toDate: windowTo,
  })
  await createLoanRequest({
    staff: pendingProposer, product: softWarnProduct, quantity: 2,
    status: 'pending', fromDate: windowFrom, toDate: windowTo,
  })
  await createLoanRequest({
    staff: fyiHolder, product: fyiProduct, quantity: 2,
    status: 'accepted', fromDate: windowFrom, toDate: windowTo,
  })

  console.log('Seeded conflict/availability test data:\n')

  console.log('1. Staff page (http://localhost:3000/staff):')
  console.log('   Seed Badges — Fully Linked   → Card UID + Portal Access both green badges')
  console.log('   Seed Badges — Card Only      → Card UID green, Portal Access "Not Granted"')
  console.log('   Seed Badges — Portal Only    → Card UID "Not Linked", Portal Access green')
  console.log('   Seed Badges — Neither        → both "Not Linked"/"Not Granted"')
  console.log('   Seed Badges — Deactivated    → Status "Deactivated", Send Login Email disabled/greyed out')
  console.log('')
  console.log('   Audit Log (http://localhost:3000/audit-log) already has one activate + one')
  console.log('   deactivate entry for the above — expand either to see the staff/email/status summary.')
  console.log('')

  console.log('2. Portal Browse (http://localhost:3000/lend) — log in as a portal borrower and look for:')
  console.log('   Seed Portal — Sold Out (return date known) → "Unavailable — back ' + addDays(TODAY, 5) + '"')
  console.log('   Seed Portal — Sold Out (no return date)    → "Unavailable — return date not set"')
  console.log('   (No existing portal-borrower login seeded here — run `npm run seed:lending` too')
  console.log('    for the borrower@nwu.test / password123 account if you need one.)')
  console.log('')

  console.log('3. Stock Out (http://localhost:3000/stock-out) — pick any staff OTHER than the')
  console.log('   holder below, scan/select the matching product, leave Lend To blank (or set it')
  console.log('   inside ' + windowFrom + '..' + windowTo + '), go to Review & Confirm:')
  console.log('   Seed Conflict — Hard Block (fully reserved)  → holder: Seed Conflict — Accepted Holder')
  console.log('     issuing ANY quantity to someone else is BLOCKED (Confirm disabled, red alert).')
  console.log('   Seed Conflict — Soft Warning (pending only)  → holder: Seed Conflict — Pending Proposer')
  console.log('     issuing to someone else is allowed, shows the existing non-blocking warning.')
  console.log('   Seed Conflict — FYI (plenty of stock)        → holder: Seed Conflict — FYI Holder')
  console.log('     issuing 1-2 units to someone else shows the blue "Heads up" info panel only.')
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

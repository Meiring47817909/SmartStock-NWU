// Seeds the Firebase emulators with a single, comprehensive demo dataset
// covering essentially every distinct status/badge/label the app can show,
// in one place, so the whole thing can be eyeballed in one sitting:
//
//   - Dashboard -> Outstanding Returns: No Return Date, Overdue, Due Today,
//     Not Due Yet, Partly Resolved (waived), Mixed (one holder, 3 states),
//     plus a partial-return-still-overdue example from the Returns section
//     below.
//   - Dashboard -> Incoming Pickups: On Schedule, Insufficient (with a
//     correlated overdue return as the "likely cause"), Insufficient (no
//     overdue return to blame -- the fallback message), and Not Picked Up
//     (one seeded so it flips live the moment you open the Dashboard, one
//     already recorded as a permanent no_show for stable inspection).
//   - Dashboard -> Low Stock Alerts: Low stock and Out of stock.
//   - Loan Requests -> every LoanRequestStatus: pending (fresh + near
//     expiry), countered (a rich one with a removed line + both sides'
//     optional messages + a date change, and a plain one with neither),
//     accepted, fulfilled (a full pending -> countered -> accepted ->
//     fulfilled history on one request), declined (by Selouna from
//     pending, by Selouna from an already-sent counter -- the rich
//     decline-of-a-counter audit snapshot added 2026-09-20, and by the
//     staff member themselves via the portal), expired, no_show, and
//     withdrawn (by staff with no reason, by Selouna cancelling a pickup
//     with one).
//   - Reports: IN/OUT/RETURN/ADJUST transactions across several staff and
//     products, a full return, a partial return, and a portal pickup
//     that's actually linked to its loan request (linked_request_id).
//   - Product images: every seeded product gets 1-3 generated placeholder
//     images uploaded to the Storage emulator (counts cycle 1/2/3 across
//     products), so Browse and the Products page image gallery both have
//     something to show instead of the "no photo" fallback everywhere.
//   - Audit Log: at least one entry for every entity_type/action
//     combination any real code path in this app currently produces --
//     which is now also every value each of those two enums has, since
//     AuditAction's 'delete' and AuditEntityType's 'return_waiver' (never
//     produced by any real code path -- a resolved return is logged
//     against the *transaction* it originated from, see waivers.ts) were
//     removed from types/database.ts entirely (2026-09-20) rather than
//     left as dead union members.
//
// This is deliberately its own script rather than folded into the existing
// seed:* scripts -- those each drill into ONE feature's edge cases (staff
// badges, stock-out conflicts, outstanding returns); this one's job is
// breadth across the whole app at once, for a single "look at everything"
// pass. Safe to run alongside any of the others.
//
// Run this AFTER `npm run emulators` is already up, in a separate terminal:
//   npm run seed:comprehensive
//
// Talks to the emulators only (via the FIRESTORE_EMULATOR_HOST/
// FIREBASE_AUTH_EMULATOR_HOST env vars below) -- never touches the real
// Firebase project, and needs zero real credentials to run. This is the
// only seed:* script that also provisions Firebase Auth logins (see
// upsertUser below) -- everything else here is Firestore-only -- so running
// just this one is enough to actually sign into the app, not only to have
// data sitting in it: it creates BOTH the BICS admin login and a linked
// portal-borrower login (credentials are printed at the end). Everything
// else is upserted (safe to re-run) except transactions, loan_requests and
// audit_log entries, which are append-only ledger data -- same as every
// other seed:* script and the real app itself (see transactions'
// `allow update, delete: if false` rule) -- so re-running this script adds
// a second batch of those on top of the first rather than resetting them.
// Clear the emulator data from http://127.0.0.1:4000 first for a clean
// slate.
//
// One thing this script CANNOT fully bake in ahead of time: the "Not
// Picked Up (Live Transition)" request is seeded as still 'accepted' with
// its pickup window already passed -- exactly the shape a real stale
// request has. The very first time you open the Dashboard afterward,
// expireIfNeeded() will flip it to 'no_show' live and log its own audit
// entry for you (with a blank actor, same as any unattended auto-expiry --
// see isNoShowCandidate's doc comment in loanRequests.ts) -- reload fast to
// catch the "Not Picked Up" badge before the row disappears, exactly the
// behavior confirmed earlier this session. The "Not Picked Up (Already
// Recorded)" request below is the stable alternative if you just want to
// see the end state without racing a reload.

process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8081'
process.env.FIREBASE_AUTH_EMULATOR_HOST ||= '127.0.0.1:9099'
process.env.FIREBASE_STORAGE_EMULATOR_HOST ||= '127.0.0.1:9199'

import { initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore } from 'firebase-admin/firestore'
import { getStorage } from 'firebase-admin/storage'

const PROJECT_ID = 'demo-smartstock-nwu'
const LOCATION = 'NWU - Potchefstroom, Building G4, Room 28'
const DEPARTMENT = 'Computer Science and Information Systems'
// The administrator's display name (profile + every audit entry attributed to them).
const ADMIN_NAME = 'Jonathan Pritchard'
const ADMIN_EMAIL = 'jonathan.pritchard@nwu.ac.za'
// Settings -> Notifications: the system sending address (every email comes From it).
const SYSTEM_FROM_EMAIL = 'noreply@smartstock-nwu.com'
const ADMIN_UID = 'seed-admin'
// Must match NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET in .env.local -- see
// scripts/seed-products.mjs's own copy of this constant for why.
const BUCKET_NAME = 'smartstock-nwu.firebasestorage.app'

const app = initializeApp({ projectId: PROJECT_ID, storageBucket: BUCKET_NAME })
const auth = getAuth(app)
const db = getFirestore(app)
const bucket = getStorage(app).bucket()

// ---------------------------------------------------------------------------
// Shared helpers -- same conventions (todayStr/addDays/genRef, upsert-by-
// name/email/barcode) as every other scripts/seed-*.mjs.
// ---------------------------------------------------------------------------
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
function genPrefixedRef(prefix) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  let result = `${prefix}-`
  for (let i = 0; i < 8; i++) result += chars.charAt(Math.floor(Math.random() * chars.length))
  return result
}
// Mirrors genRef/genRequestRef in src/lib/utils.ts -- seeded records must
// carry references, or the demo data looks like legacy data that predates
// them and the feature can't be seen at all.
function genRef() { return genPrefixedRef('TXN') }
function genRequestRef() { return genPrefixedRef('LR') }
const TODAY = todayStr()
// A day offset expressed as a full ISO timestamp, for created_at/updated_at
// fields -- 09:00 local-ish so ordering between same-day entries is stable.
const isoAt = (dayOffset) => new Date(`${addDays(TODAY, dayOffset)}T09:00:00`).toISOString()

// ---------------------------------------------------------------------------
// Product images -- every seeded product gets 1-3 generated placeholder
// images uploaded to the Storage emulator (same technique as
// scripts/seed-products.mjs), so the lending portal's Browse page and the
// Products page's image gallery both have something to render instead of
// every card showing its "no photo" fallback. Counts cycle 1/2/3 across
// products in call order (via imageSeq below) rather than being fixed
// per product, purely to get a visible mix of 1-image/2-image/3-image
// products without hand-assigning a count to all ~20 call sites.
// ---------------------------------------------------------------------------
const IMAGE_PALETTE = [
  { color: '#2563eb', glyph: '💻' },
  { color: '#7c3aed', glyph: '📦' },
  { color: '#059669', glyph: '🔌' },
  { color: '#d97706', glyph: '🖥️' },
  { color: '#db2777', glyph: '📷' },
  { color: '#0891b2', glyph: '⚙️' },
]
let imageSeq = 0

function placeholderSvg(name, angleLabel, bgColor, glyph) {
  const escapedName = name.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640" viewBox="0 0 640 640">
  <rect width="640" height="640" fill="${bgColor}"/>
  <text x="320" y="280" font-size="200" text-anchor="middle" font-family="system-ui, sans-serif">${glyph}</text>
  <text x="320" y="400" font-size="36" font-weight="700" fill="white" text-anchor="middle" font-family="system-ui, sans-serif">${escapedName}</text>
  <text x="320" y="450" font-size="26" fill="rgba(255,255,255,0.85)" text-anchor="middle" font-family="system-ui, sans-serif">${angleLabel}</text>
</svg>`
}

// Uploads 1-3 placeholder images for a product (cycling counts across
// calls) and returns their Storage paths, ready to save on the product doc.
async function seedProductImages(productId, productName) {
  const imageCount = (imageSeq % 3) + 1
  imageSeq += 1
  const angleLabels = ['Front', 'Side', 'In case']
  const paths = []
  for (let i = 0; i < imageCount; i++) {
    const swatch = IMAGE_PALETTE[(imageSeq + i) % IMAGE_PALETTE.length]
    const path = `products/${productId}/placeholder-${i}.svg`
    const svg = placeholderSvg(productName, angleLabels[i], swatch.color, swatch.glyph)
    await bucket.file(path).save(Buffer.from(svg, 'utf8'), {
      contentType: 'image/svg+xml',
      metadata: { cacheControl: 'public, max-age=3600' },
    })
    paths.push(path)
  }
  return paths
}

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

// Get-or-create a Firebase Auth account with a known password -- same
// pattern as seed-emulator.mjs/seed-lending-portal.mjs's own upsertUser().
// This is the piece those two scripts had that this one didn't: a Firestore
// `staff`/`profiles` doc alone is data sitting in the database, not
// something you can actually log into the app as.
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

// The administrator's own record in `staff` -- what My Profile reads and edits
// (and what Stock Out lists as a borrower). Same shape the My Profile page
// writes itself; the Staff page filters it out through is_admin_account.
// Safe to re-run, and keeps a card UID someone already assigned.
async function upsertAdminStaffRecord({ uid, name, surname, email, department }) {
  const now = new Date().toISOString()
  const payload = {
    name, surname, full_name: `${name} ${surname}`, email, department,
    uid, is_admin_account: true, is_active: true, updated_at: now,
  }
  const existing = await db.collection('staff').where('uid', '==', uid).limit(1).get()
  if (!existing.empty) {
    await existing.docs[0].ref.set(payload, { merge: true })
    return existing.docs[0].id
  }
  const ref = await db.collection('staff').add({ ...payload, card_uid: null, created_at: now })
  return ref.id
}

async function upsertStaff(spec) {
  const now = new Date().toISOString()
  const existingSnap = await db.collection('staff').where('email', '==', spec.email).get()
  const payload = {
    name: spec.name, surname: spec.surname, full_name: spec.full_name,
    email: spec.email, department: spec.department ?? DEPARTMENT,
    is_active: spec.is_active ?? true, card_uid: spec.card_uid ?? null, uid: spec.uid ?? null,
    updated_at: now,
  }
  if (!existingSnap.empty) {
    const ref = existingSnap.docs[0].ref
    await ref.set(payload, { merge: true })
    return { id: ref.id, full_name: spec.full_name, email: spec.email }
  }
  const ref = await db.collection('staff').add({ ...payload, created_at: now })
  return { id: ref.id, full_name: spec.full_name, email: spec.email }
}

async function upsertProduct(spec) {
  const existingSnap = await db.collection('products').where('barcodes', 'array-contains', spec.barcode).get()
  const now = new Date().toISOString()
  const payload = {
    category_id: spec.category_id ?? null,
    category_name: spec.category_name ?? null,
    name: spec.name,
    description: spec.description ?? 'Seed data -- scripts/seed-comprehensive-demo.mjs',
    barcodes: [spec.barcode],
    reorder_threshold: spec.reorder_threshold,
    available: spec.available ?? true,
    location: LOCATION,
    lend_from: spec.lend_from !== undefined ? spec.lend_from : addDays(TODAY, -365),
    lend_to: spec.lend_to !== undefined ? spec.lend_to : null,
    updated_at: now,
  }
  // Omitted entirely (not even `null`) for the one product deliberately
  // testing the pre-Lending-Interval-field legacy shape -- see
  // DEFAULT_LENDING_INTERVAL's doc comment in loanRequests.ts.
  if (spec.lending_interval !== undefined) payload.lending_interval = spec.lending_interval
  if (!existingSnap.empty) {
    const ref = existingSnap.docs[0].ref
    // Don't stomp quantity_on_hand on a re-run -- whatever's already there
    // is authoritative, same reasoning as seed-outstanding.mjs.
    await ref.set(payload, { merge: true })
    // Re-generate images on every run too, same as a fresh create below --
    // cheap (small SVGs) and keeps a re-run's image count in sync with
    // wherever this product now falls in the seq counter's cycle.
    const images = await seedProductImages(ref.id, spec.name)
    await ref.set({ images }, { merge: true })
    const snap = await ref.get()
    return { id: ref.id, name: spec.name, quantity_on_hand: snap.data()?.quantity_on_hand ?? spec.quantity_on_hand }
  }
  const ref = await db.collection('products').add({
    ...payload, quantity_on_hand: spec.quantity_on_hand, created_at: now, images: [],
  })
  const images = await seedProductImages(ref.id, spec.name)
  await ref.set({ images }, { merge: true })
  return { id: ref.id, name: spec.name, quantity_on_hand: spec.quantity_on_hand }
}

async function writeAudit({ userId = null, userName = null, action, entityType, entityId, before = null, after = null, createdAt }) {
  await db.collection('audit_log').add({
    user_id: userId, user_name: userName,
    action, entity_type: entityType, entity_id: entityId,
    before, after,
    created_at: createdAt ?? new Date().toISOString(),
  })
}

// Writes one transaction + its lines, adjusts quantity_on_hand by the given
// direction, and logs the same 'create' audit entry stock-in/stock-out/
// returns' own page.tsx files write for a real transaction.
async function recordTxn({
  type, staff = null, items, direction, lendFrom = null, lendTo = null, returnDate = null,
  manualOverride = false, notes = null, linkedTxnId = null,
  linkedRequestId = null, linkedRequestRef = null,
  dayOffset, actorName = ADMIN_NAME, actorId = ADMIN_UID,
}) {
  const dir = direction ?? (type === 'OUT' ? -1 : 1) // IN/RETURN default to +1, OUT to -1; ADJUST must pass direction explicitly
  // manual_override means "the staff member was picked from a list instead
  // of scanning their card". Only Stock Out and Returns have a staff step
  // that can be bypassed, so only OUT/RETURN can ever carry it -- Stock In
  // and ADJUST write no staff_id at all. Seeding it on an IN produced an
  // "Manual entry -- no card scan" badge in the Audit Log for a transaction
  // type that has no card scan to skip, which is not a state any real code
  // path can reach. Fail loudly rather than fabricating it again, and omit
  // the field entirely on the other types so a seeded IN/ADJUST document
  // matches what stock-in/page.tsx actually writes (no key at all, not
  // `false`).
  const isStaffFlow = type === 'OUT' || type === 'RETURN'
  if (manualOverride && !isStaffFlow) {
    throw new Error(`recordTxn: manual_override is only meaningful on OUT/RETURN transactions, got ${type}`)
  }
  const issuedAt = isoAt(dayOffset)
  const ref = genRef()
  const txnPayload = {
    transaction_type: type, reference_no: ref,
    staff_id: staff?.id ?? null, staff_name: staff?.full_name ?? null,
    user_id: actorId, operator_name: actorName, notes, return_date: returnDate,
    linked_txn_id: linkedTxnId, ...(isStaffFlow ? { manual_override: manualOverride } : {}),
    lend_from: lendFrom, lend_to: lendTo,
    // Both halves of the loan-request link, explicitly null when the
    // movement isn't against a request, so the field always exists.
    linked_request_id: linkedRequestId, linked_request_ref: linkedRequestRef,
    created_at: issuedAt,
  }
  const txnRef = await db.collection('transactions').add(txnPayload)
  for (const item of items) {
    await db.collection('transaction_lines').add({
      transaction_id: txnRef.id, product_id: item.product.id, quantity: item.quantity,
      unit_cost: item.unit_cost ?? 0, product_name: item.product.name, created_at: issuedAt,
    })
    await db.collection('products').doc(item.product.id).update({
      quantity_on_hand: item.product.quantity_on_hand + dir * item.quantity,
      updated_at: new Date().toISOString(),
    })
    item.product.quantity_on_hand += dir * item.quantity
  }
  await writeAudit({
    userId: actorId, userName: actorName, action: 'create', entityType: 'transaction', entityId: txnRef.id,
    before: null,
    after: {
      ...txnPayload,
      line_count: items.length,
      total_qty: items.reduce((s, i) => s + i.quantity, 0),
      // Frozen product lines, matching the shape stock-in/stock-out/returns'
      // own page.tsx files freeze into `after.lines` (see commit 7907272).
      // Without this, the Audit Log's raw-data view and CSV export have
      // nothing to show for which products moved -- only the on-screen
      // friendly summary would still work, via its separate fallback join
      // to transaction_lines.
      lines: items.map(i => ({ product_id: i.product.id, product_name: i.product.name, quantity: i.quantity })),
    },
    createdAt: issuedAt,
  })
  return { id: txnRef.id, reference_no: ref }
}

async function writeWaiver({ txn, product, staff, quantity, reason = null, dayOffset, actorName = ADMIN_NAME, actorId = ADMIN_UID }) {
  const payload = {
    transaction_id: txn.id, product_id: product.id, product_name: product.name,
    staff_id: staff.id, staff_name: staff.full_name, quantity, reason,
    created_at: isoAt(dayOffset), resolved_by_uid: actorId, resolved_by_name: actorName,
  }
  await db.collection('return_waivers').add(payload)
  await writeAudit({
    userId: actorId, userName: actorName, action: 'resolve', entityType: 'transaction', entityId: txn.id,
    before: null, after: payload, createdAt: payload.created_at,
  })
}

// Writes a loan_requests doc + its loan_request_lines at whatever FINAL
// status/dates this scenario needs, plus the 'create' audit entry a real
// submitLoanRequest() call always logs -- which always shows status
// 'pending' and the ORIGINAL dates, since every request starts there
// regardless of where this seed drops it off. Any further transitions
// (countered/accepted/declined/etc.) are logged separately with
// writeLoanUpdate below, so a request's full audit history reads the same
// way a real negotiation's would.
async function createLoanRequest({
  staff, lines, status, fromDate, toDate, originalFromDate = fromDate, originalToDate = toDate,
  message = null, adminMessage = null, fulfilledTxnId = null, createdDayOffset, updatedDayOffset,
}) {
  const created = isoAt(createdDayOffset)
  const updated = isoAt(updatedDayOffset ?? createdDayOffset)
  const requestRef = genRequestRef()
  const reqPayload = {
    reference_no: requestRef,
    staff_id: staff.id, staff_name: staff.full_name, status, message, admin_message: adminMessage,
    from_date: fromDate, to_date: toDate,
    original_from_date: originalFromDate, original_to_date: originalToDate,
    created_at: created, updated_at: updated, fulfilled_txn_id: fulfilledTxnId,
  }
  // Same shape requestAuditSnapshot() produces in the app, so seeded
  // history is indistinguishable from history the app writes itself.
  const snapshotLines = lines.map((l) => ({
    product_id: l.product.id,
    product_name: l.product.name,
    requested_quantity: l.requested,
    offered_quantity: l.offered ?? l.requested,
  }))
  const snapshotBase = {
    reference_no: requestRef,
    staff_id: staff.id, staff_name: staff.full_name,
    status, from_date: fromDate, to_date: toDate,
    original_from_date: originalFromDate, original_to_date: originalToDate,
    message, admin_message: adminMessage, fulfilled_txn_id: fulfilledTxnId,
    lines: snapshotLines,
    line_count: snapshotLines.length,
    total_qty: snapshotLines.reduce((s, l) => s + l.offered_quantity, 0),
  }
  const reqRef = await db.collection('loan_requests').add(reqPayload)
  for (const line of lines) {
    await db.collection('loan_request_lines').add({
      request_id: reqRef.id, product_id: line.product.id, product_name: line.product.name,
      requested_quantity: line.requested, offered_quantity: line.offered ?? line.requested,
      created_at: created,
    })
  }
  await writeAudit({
    userId: staff.id, userName: staff.full_name,
    action: 'create', entityType: 'loan_request', entityId: reqRef.id,
    before: null,
    after: {
      ...snapshotBase,
      status: 'pending',
      from_date: originalFromDate, to_date: originalToDate,
      admin_message: null, fulfilled_txn_id: null,
      // At submission requested and offered are equal — a counter is what
      // later drives them apart.
      lines: snapshotLines.map((l) => ({ ...l, offered_quantity: l.requested_quantity })),
      total_qty: snapshotLines.reduce((s, l) => s + l.requested_quantity, 0),
    },
    createdAt: created,
  })
  return { id: reqRef.id, reference_no: requestRef, staff, lines, snapshotBase }
}

async function writeLoanUpdate({ request, before, after, dayOffset, actorName = ADMIN_NAME, actorId = ADMIN_UID }) {
  await writeAudit({
    userId: actorId, userName: actorName, action: 'update', entityType: 'loan_request', entityId: request.id,
    // Every real loan_request transition now carries the reference on both
    // sides (identifying context, never a change), so seeded history has to
    // as well or it won't match what the app produces.
    // Every real transition repeats the full request snapshot, differing
    // only in status and whatever that transition changed — so the seeded
    // history has to as well, or the CSV columns won't line up.
    before: { ...(request.snapshotBase ?? {}), ...before },
    after: { ...(request.snapshotBase ?? {}), ...after },
    createdAt: isoAt(dayOffset),
  })
}

async function main() {
  // =====================================================================
  // 0. LOGINS -- the two Firebase Auth accounts needed to actually sign
  //    into the app, not just have data sitting in it. ADMIN_UID/ADMIN_NAME
  //    are reused as the real account's uid/display name, so every audit
  //    entry already attributed to the administrator below corresponds to an
  //    account you can really sign in as and see them under.
  // =====================================================================
  const adminUser = await upsertUser(ADMIN_EMAIL, 'password123', ADMIN_UID)
  await db.collection('profiles').doc(adminUser.uid).set(
    { id: adminUser.uid, full_name: ADMIN_NAME, role: 'admin', created_at: new Date().toISOString() },
    { merge: true },
  )

  // Settings -> Notifications addresses: administrator emails are delivered to
  // the administrator's own login address, and every email is sent From the
  // system address. Merged, so the notification toggles are left untouched.
  await db.collection('settings').doc('notifications').set(
    {
      admin_notification_email: ADMIN_EMAIL,
      system_from_email: SYSTEM_FROM_EMAIL,
      updated_at: new Date().toISOString(),
      updated_by_uid: ADMIN_UID,
      updated_by_name: ADMIN_NAME,
    },
    { merge: true },
  )

  // My Profile -> My details (name, surname, department) reads this record.
  const [adminFirstName, ...adminRest] = ADMIN_NAME.split(' ')
  await upsertAdminStaffRecord({
    uid: ADMIN_UID, name: adminFirstName, surname: adminRest.join(' '), email: ADMIN_EMAIL, department: DEPARTMENT,
  })

  // A portal-borrower login, linked to the "Staff -- Portal Access Granted"
  // staff record created in section 2 below (that record's own point was to
  // demonstrate the "portal access granted" audit entry -- giving it a real
  // account as well means it doubles as something you can actually sign
  // into /lend/login as, rather than needing a 29th, separate staff record
  // just for that).
  const portalBorrowerUser = await upsertUser('demo.portallinked@example.com', 'password123', 'seed-demo-portallinked-uid')

  // =====================================================================
  // 1. CATEGORIES -- reuse the standard 7-category list (seed-products.mjs)
  //    so product assignments below line up with what's already on a
  //    typical seeded instance, plus one dedicated pair to demonstrate a
  //    category 'create' and 'update' audit entry without touching any of
  //    the real 7.
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
  const categoryId = {}
  for (const c of CATEGORY_SPECS) categoryId[c.name] = await upsertCategory(c.name, c.description)

  const demoCatId = await upsertCategory('Demo Category -- Seed', 'Placeholder category for audit-log demo purposes.')
  await writeAudit({
    userId: ADMIN_UID, userName: ADMIN_NAME, action: 'create', entityType: 'category', entityId: demoCatId,
    before: null, after: { name: 'Demo Category -- Seed', description: 'Placeholder category for audit-log demo purposes.' },
    createdAt: isoAt(-14),
  })
  await db.collection('categories').doc(demoCatId).set({ description: 'Renamed -- audit-log update demo.' }, { merge: true })
  await writeAudit({
    userId: ADMIN_UID, userName: ADMIN_NAME, action: 'update', entityType: 'category', entityId: demoCatId,
    before: { name: 'Demo Category -- Seed', description: 'Placeholder category for audit-log demo purposes.' },
    after: { name: 'Demo Category -- Seed', description: 'Renamed -- audit-log update demo.' },
    createdAt: isoAt(-13),
  })

  // =====================================================================
  // 2. STAFF -- the Demo cast of characters. Each scenario below gets its
  //    own staff record so every row is unambiguous in every list/sidebar.
  // =====================================================================
  const S = {}
  const staffSpecs = [
    ['PendingFresh', 'Demo', 'Pending Fresh', 'demo.pendingfresh@example.com'],
    ['PendingNearExpiry', 'Demo', 'Pending Near Expiry', 'demo.pendingnearexpiry@example.com'],
    ['CounteredRich', 'Demo', 'Countered Rich', 'demo.counteredrich@example.com'],
    ['CounteredSimple', 'Demo', 'Countered Simple', 'demo.counteredsimple@example.com'],
    ['AcceptedOnSchedule', 'Demo', 'Accepted On Schedule', 'demo.acceptedonschedule@example.com'],
    ['InsufficientCauseRecipient', 'Demo', 'Insufficient Recipient (Overdue Cause)', 'demo.insufficientcause@example.com'],
    ['OverdueHolderCause', 'Demo', 'Overdue Holder (Insufficient Cause)', 'demo.overdueholdercause@example.com'],
    ['InsufficientNoCauseRecipient', 'Demo', 'Insufficient Recipient (No Cause)', 'demo.insufficientnocause@example.com'],
    ['NoShowLive', 'Demo', 'No Show (Live Transition)', 'demo.noshowlive@example.com'],
    ['NoShowRecorded', 'Demo', 'No Show (Already Recorded)', 'demo.noshowrecorded@example.com'],
    ['ExpiredRecorded', 'Demo', 'Expired (Already Recorded)', 'demo.expiredrecorded@example.com'],
    ['FulfilledPickup', 'Demo', 'Fulfilled Pickup', 'demo.fulfilledpickup@example.com'],
    ['DeclinedPending', 'Demo', 'Declined Pending', 'demo.declinedpending@example.com'],
    ['DeclinedCounterRich', 'Demo', 'Declined Counter Rich', 'demo.declinedcounterrich@example.com'],
    ['DeclinedByStaff', 'Demo', 'Declined By Staff', 'demo.declinedbystaff@example.com'],
    ['WithdrawnByStaff', 'Demo', 'Withdrawn By Staff', 'demo.withdrawnbystaff@example.com'],
    ['WithdrawnByAdmin', 'Demo', 'Withdrawn By Admin (Cancelled Pickup)', 'demo.withdrawnbyadmin@example.com'],
    ['ReturnNoDate', 'Demo', 'Return -- No Date', 'demo.returnnodate@example.com'],
    ['ReturnOverdue', 'Demo', 'Return -- Overdue', 'demo.returnoverdue@example.com'],
    ['ReturnDueToday', 'Demo', 'Return -- Due Today', 'demo.returnduetoday@example.com'],
    ['ReturnNotDueYet', 'Demo', 'Return -- Not Due Yet', 'demo.returnnotdueyet@example.com'],
    ['ReturnPartlyResolved', 'Demo', 'Return -- Partly Resolved', 'demo.returnpartlyresolved@example.com'],
    ['ReturnMixedHolder', 'Demo', 'Return -- Mixed Holder', 'demo.returnmixedholder@example.com'],
    ['ReturnCompleted', 'Demo', 'Return -- Fully Returned', 'demo.returncompleted@example.com'],
    ['ReturnPartial', 'Demo', 'Return -- Partially Returned (Overdue)', 'demo.returnpartial@example.com'],
    ['BadgeActive', 'Demo', 'Staff Badge -- Active', 'demo.badgeactive@example.com'],
    ['BadgeDeactivated', 'Demo', 'Staff Badge -- Deactivated', 'demo.badgedeactivated@example.com'],
    ['PortalLinked', 'Demo', 'Staff -- Portal Access Granted', 'demo.portallinked@example.com'],
  ]
  for (const [key, name, surname, email] of staffSpecs) {
    S[key] = await upsertStaff({ name, surname, full_name: `${name} ${surname}`, email })
  }
  // A deactivated one, seeded directly (rather than toggled after create)
  // so it's already in that state.
  await upsertStaff({ name: 'Demo', surname: 'Staff Badge -- Deactivated', full_name: S.BadgeDeactivated.full_name, email: S.BadgeDeactivated.email, is_active: false, card_uid: 'CARD-SEED-DEMO-01' })
  // Link the real portal-borrower Auth account created in section 0 above --
  // upsertStaff's tuple-based staffSpecs loop above has no uid field, so
  // this one's own doc still needs its uid filled in after the fact.
  await db.collection('staff').doc(S.PortalLinked.id).update({ uid: portalBorrowerUser.uid })

  // ---- Staff audit log coverage: create / update / activate / deactivate /
  //      portal-access-granted, one of each ------------------------------
  await writeAudit({
    userId: ADMIN_UID, userName: ADMIN_NAME, action: 'create', entityType: 'staff', entityId: S.PendingFresh.id,
    before: null,
    after: { name: 'Demo', surname: 'Pending Fresh', full_name: S.PendingFresh.full_name, email: S.PendingFresh.email, department: DEPARTMENT, card_uid: null, is_active: true, uid: null },
    createdAt: isoAt(-30),
  })
  await writeAudit({
    userId: ADMIN_UID, userName: ADMIN_NAME, action: 'update', entityType: 'staff', entityId: S.PendingFresh.id,
    before: { name: 'Demo', surname: 'Pending Fresh', full_name: S.PendingFresh.full_name, email: S.PendingFresh.email, department: 'Testing', card_uid: null },
    after: { name: 'Demo', surname: 'Pending Fresh', full_name: S.PendingFresh.full_name, email: S.PendingFresh.email, department: DEPARTMENT, card_uid: null },
    createdAt: isoAt(-29),
  })
  await writeAudit({
    userId: ADMIN_UID, userName: ADMIN_NAME, action: 'activate', entityType: 'staff', entityId: S.BadgeActive.id,
    before: { is_active: false, name: 'Demo', surname: 'Staff Badge -- Active', full_name: S.BadgeActive.full_name, email: S.BadgeActive.email },
    after: { is_active: true, name: 'Demo', surname: 'Staff Badge -- Active', full_name: S.BadgeActive.full_name, email: S.BadgeActive.email },
    createdAt: isoAt(-20),
  })
  await writeAudit({
    userId: ADMIN_UID, userName: ADMIN_NAME, action: 'deactivate', entityType: 'staff', entityId: S.BadgeDeactivated.id,
    before: { is_active: true, name: 'Demo', surname: 'Staff Badge -- Deactivated', full_name: S.BadgeDeactivated.full_name, email: S.BadgeDeactivated.email },
    after: { is_active: false, name: 'Demo', surname: 'Staff Badge -- Deactivated', full_name: S.BadgeDeactivated.full_name, email: S.BadgeDeactivated.email },
    createdAt: isoAt(-19),
  })
  // Portal access: granting a login, and later re-issuing the link. These
  // used to be logged as a plain 'update' carrying only { uid }, which the
  // Audit Log rendered as "No details recorded" because uid is a hidden
  // field — so both shapes are seeded in their corrected form here.
  const portalAccessContext = {
    full_name: S.PortalLinked.full_name,
    email: S.PortalLinked.email,
    uid: 'seed-demo-portallinked-uid',
  }
  await writeAudit({
    userId: ADMIN_UID, userName: ADMIN_NAME,
    action: 'grant_access', entityType: 'staff', entityId: S.PortalLinked.id,
    before: portalAccessContext, after: portalAccessContext,
    createdAt: isoAt(-18),
  })
  await writeAudit({
    userId: ADMIN_UID, userName: ADMIN_NAME,
    action: 'resend_access', entityType: 'staff', entityId: S.PortalLinked.id,
    before: portalAccessContext, after: portalAccessContext,
    createdAt: isoAt(-11),
  })

  // =====================================================================
  // 3. PRODUCTS -- variety across stock level, lending interval, and the
  //    "Availability" toggle. Reused across the scenarios below.
  // =====================================================================
  const P = {}
  P.healthy = await upsertProduct({ name: 'Demo Product -- Healthy Stock', barcode: 'DEMO-HEALTHY', quantity_on_hand: 25, reorder_threshold: 5, lending_interval: 'week_1', category_id: categoryId['Peripherals'], category_name: 'Peripherals' })
  P.lowStock = await upsertProduct({ name: 'Demo Product -- Low Stock', barcode: 'DEMO-LOWSTOCK', quantity_on_hand: 4, reorder_threshold: 5, lending_interval: 'week_2', category_id: categoryId['Cables & Adapters'], category_name: 'Cables & Adapters' })
  P.outOfStock = await upsertProduct({ name: 'Demo Product -- Out of Stock', barcode: 'DEMO-OUTOFSTOCK', quantity_on_hand: 0, reorder_threshold: 3, lending_interval: 'week_3', category_id: categoryId['Storage'], category_name: 'Storage' })
  P.indefinite = await upsertProduct({ name: 'Demo Product -- Indefinite Lending', barcode: 'DEMO-INDEFINITE', quantity_on_hand: 12, reorder_threshold: 2, lending_interval: 'indefinite', category_id: categoryId['Laptops & Computers'], category_name: 'Laptops & Computers' })
  P.monthInterval = await upsertProduct({ name: 'Demo Product -- 1 Month Interval', barcode: 'DEMO-MONTH', quantity_on_hand: 15, reorder_threshold: 3, lending_interval: 'month_1', category_id: categoryId['Networking'], category_name: 'Networking' })
  P.legacyNoInterval = await upsertProduct({ name: 'Demo Product -- Legacy (No Interval Set)', barcode: 'DEMO-LEGACY', quantity_on_hand: 10, reorder_threshold: 2, category_id: categoryId['Power'], category_name: 'Power' }) // lending_interval omitted on purpose
  P.unavailable = await upsertProduct({ name: 'Demo Product -- Unavailable (Toggled Off)', barcode: 'DEMO-UNAVAILABLE', quantity_on_hand: 8, reorder_threshold: 2, available: false, lending_interval: 'week_1', category_id: categoryId['Consumables'], category_name: 'Consumables' })
  P.insufficientCause = await upsertProduct({ name: 'Demo Product -- Insufficient Pickup (Overdue Cause)', barcode: 'DEMO-INSUFF-CAUSE', quantity_on_hand: 3, reorder_threshold: 2, lending_interval: 'week_2' })
  P.insufficientNoCause = await upsertProduct({ name: 'Demo Product -- Insufficient Pickup (No Clear Cause)', barcode: 'DEMO-INSUFF-NOCAUSE', quantity_on_hand: 1, reorder_threshold: 3, lending_interval: 'week_2' })
  P.onSchedule = await upsertProduct({ name: 'Demo Product -- On Schedule Pickup', barcode: 'DEMO-ONSCHEDULE', quantity_on_hand: 10, reorder_threshold: 2, lending_interval: 'week_2' })
  P.noShowFeeder = await upsertProduct({ name: 'Demo Product -- Not Picked Up Feeder', barcode: 'DEMO-NOSHOW', quantity_on_hand: 5, reorder_threshold: 2, lending_interval: 'week_1' })
  P.fulfilled = await upsertProduct({ name: 'Demo Product -- Fulfilled Pickup', barcode: 'DEMO-FULFILLED', quantity_on_hand: 10, reorder_threshold: 2, lending_interval: 'week_2' })
  P.returnNoDate = await upsertProduct({ name: 'Demo Product -- Return Feeder (No Date)', barcode: 'DEMO-RET-NODATE', quantity_on_hand: 20, reorder_threshold: 5 })
  P.returnOverdue = await upsertProduct({ name: 'Demo Product -- Return Feeder (Overdue)', barcode: 'DEMO-RET-OVERDUE', quantity_on_hand: 20, reorder_threshold: 5 })
  P.returnDueToday = await upsertProduct({ name: 'Demo Product -- Return Feeder (Due Today)', barcode: 'DEMO-RET-DUETODAY', quantity_on_hand: 20, reorder_threshold: 5 })
  P.returnNotDueYet = await upsertProduct({ name: 'Demo Product -- Return Feeder (Not Due Yet)', barcode: 'DEMO-RET-NOTDUEYET', quantity_on_hand: 20, reorder_threshold: 5 })
  P.returnPartlyResolved = await upsertProduct({ name: 'Demo Product -- Return Feeder (Partly Resolved)', barcode: 'DEMO-RET-PARTRESOLVED', quantity_on_hand: 20, reorder_threshold: 5 })
  P.ioAdjustRestock = await upsertProduct({ name: 'Demo Product -- Stock-In Restock Example', barcode: 'DEMO-RESTOCK', quantity_on_hand: 6, reorder_threshold: 3 })
  P.fullReturnPair = await upsertProduct({ name: 'Demo Product -- Full Return Example', barcode: 'DEMO-FULLRETURN', quantity_on_hand: 20, reorder_threshold: 5 })
  P.partialReturnPair = await upsertProduct({ name: 'Demo Product -- Partial Return (Still Overdue)', barcode: 'DEMO-PARTIALRETURN', quantity_on_hand: 20, reorder_threshold: 5 })

  // ---- Product audit log coverage: create / update -----------------------
  await writeAudit({
    userId: ADMIN_UID, userName: ADMIN_NAME, action: 'create', entityType: 'product', entityId: P.healthy.id,
    before: null,
    after: {
      category_id: categoryId['Peripherals'], name: 'Demo Product -- Healthy Stock', description: 'Seed data -- scripts/seed-comprehensive-demo.mjs',
      barcodes: ['DEMO-HEALTHY'], quantity_on_hand: 25, reorder_threshold: 5, available: true, location: LOCATION,
      lend_from: addDays(TODAY, -365), lend_to: null, lending_interval: 'week_1', images: [],
    },
    createdAt: isoAt(-30),
  })
  await writeAudit({
    userId: ADMIN_UID, userName: ADMIN_NAME, action: 'update', entityType: 'product', entityId: P.insufficientCause.id,
    before: {
      name: 'Demo Product -- Insufficient Pickup (Overdue Cause)', barcodes: ['DEMO-INSUFF-CAUSE'], category_id: null,
      description: 'Seed data -- scripts/seed-comprehensive-demo.mjs', quantity_on_hand: 5, reorder_threshold: 1,
      available: true, location: LOCATION, lend_from: addDays(TODAY, -365), lend_to: null, lending_interval: 'week_1', images: [],
    },
    after: {
      name: 'Demo Product -- Insufficient Pickup (Overdue Cause)', barcodes: ['DEMO-INSUFF-CAUSE'], category_id: null,
      description: 'Seed data -- scripts/seed-comprehensive-demo.mjs', quantity_on_hand: 3, reorder_threshold: 2,
      available: true, location: LOCATION, lend_from: addDays(TODAY, -365), lend_to: null, lending_interval: 'week_2', images: [],
    },
    createdAt: isoAt(-21),
  })

  // =====================================================================
  // 4. OUTSTANDING RETURNS (Dashboard tab) -- walk-in Stock Out activity,
  //    not tied to any loan request. Every badge variant, plus a Mixed
  //    holder with three at once.
  // =====================================================================
  await recordTxn({ type: 'OUT', staff: S.ReturnNoDate, items: [{ product: P.returnNoDate, quantity: 1 }], lendFrom: addDays(TODAY, -5), lendTo: null, manualOverride: true, notes: 'Staff selected manually (no card scan)', dayOffset: -5 })
  await recordTxn({ type: 'OUT', staff: S.ReturnOverdue, items: [{ product: P.returnOverdue, quantity: 2 }], lendFrom: addDays(TODAY, -15), lendTo: addDays(TODAY, -3), dayOffset: -15 })
  await recordTxn({ type: 'OUT', staff: S.ReturnDueToday, items: [{ product: P.returnDueToday, quantity: 1 }], lendFrom: addDays(TODAY, -7), lendTo: TODAY, dayOffset: -7 })
  await recordTxn({ type: 'OUT', staff: S.ReturnNotDueYet, items: [{ product: P.returnNotDueYet, quantity: 3 }], lendFrom: addDays(TODAY, -1), lendTo: addDays(TODAY, 14), dayOffset: -1 })

  const partlyResolvedTxn = await recordTxn({ type: 'OUT', staff: S.ReturnPartlyResolved, items: [{ product: P.returnPartlyResolved, quantity: 1 }], lendFrom: addDays(TODAY, -30), lendTo: null, dayOffset: -30 })
  await writeWaiver({ txn: partlyResolvedTxn, product: P.returnPartlyResolved, staff: S.ReturnPartlyResolved, quantity: 1, reason: 'Item was damaged beyond repair -- staff member keeping it, written off.', dayOffset: -25 })
  await recordTxn({ type: 'OUT', staff: S.ReturnPartlyResolved, items: [{ product: P.returnPartlyResolved, quantity: 1 }], lendFrom: addDays(TODAY, -2), lendTo: addDays(TODAY, 5), dayOffset: -2 })

  await recordTxn({ type: 'OUT', staff: S.ReturnMixedHolder, items: [{ product: P.returnNoDate, quantity: 1 }], lendFrom: addDays(TODAY, -20), lendTo: null, dayOffset: -20 })
  await recordTxn({ type: 'OUT', staff: S.ReturnMixedHolder, items: [{ product: P.returnOverdue, quantity: 1 }], lendFrom: addDays(TODAY, -10), lendTo: addDays(TODAY, -1), dayOffset: -10 })
  await recordTxn({ type: 'OUT', staff: S.ReturnMixedHolder, items: [{ product: P.returnDueToday, quantity: 1 }], lendFrom: addDays(TODAY, -7), lendTo: TODAY, dayOffset: -7 })

  // The overdue OUT for the Insufficient-with-cause pickup scenario below --
  // grouped here since it's also, structurally, just another Overdue
  // Outstanding Returns row (that's the whole point of the correlation).
  await recordTxn({
    type: 'OUT', staff: S.OverdueHolderCause, items: [{ product: P.insufficientCause, quantity: 2 }],
    lendFrom: addDays(TODAY, -20), lendTo: addDays(TODAY, -5), dayOffset: -20,
  })

  // =====================================================================
  // 5. REPORTS -- IN / RETURN / ADJUST activity, plus a full and a partial
  //    return (the partial one lands as an extra Overdue Outstanding
  //    Returns row for free, same as a real partial return would).
  // =====================================================================
  await recordTxn({ type: 'IN', items: [{ product: P.ioAdjustRestock, quantity: 15 }], notes: 'Quarterly restock from IT Store supplier.', dayOffset: -25 })
  await recordTxn({ type: 'IN', items: [{ product: P.monthInterval, quantity: 5 }], notes: 'Emergency restock -- approved via email.', dayOffset: -18 })
  await recordTxn({ type: 'ADJUST', direction: 1, items: [{ product: P.legacyNoInterval, quantity: 1 }], notes: 'Manual stock count correction -- found 1 extra unit during a physical audit.', dayOffset: -12 })

  const fullReturnOut = await recordTxn({ type: 'OUT', staff: S.ReturnCompleted, items: [{ product: P.fullReturnPair, quantity: 2 }], lendFrom: addDays(TODAY, -20), lendTo: addDays(TODAY, -10), dayOffset: -20 })
  await recordTxn({ type: 'RETURN', staff: S.ReturnCompleted, items: [{ product: P.fullReturnPair, quantity: 2 }], returnDate: addDays(TODAY, -9), linkedTxnId: fullReturnOut.id, notes: 'Returned in good condition.', dayOffset: -9 })

  const partialReturnOut = await recordTxn({ type: 'OUT', staff: S.ReturnPartial, items: [{ product: P.partialReturnPair, quantity: 4 }], lendFrom: addDays(TODAY, -15), lendTo: addDays(TODAY, -5), dayOffset: -15 })
  await recordTxn({ type: 'RETURN', staff: S.ReturnPartial, items: [{ product: P.partialReturnPair, quantity: 2 }], returnDate: addDays(TODAY, -4), linkedTxnId: partialReturnOut.id, notes: 'Only 2 of the 4 units back so far -- other 2 still out.', dayOffset: -4 })

  // =====================================================================
  // 6. LOAN REQUESTS -- every LoanRequestStatus, with a matching audit trail.
  // =====================================================================

  // ---- pending (fresh) ----------------------------------------------------
  await createLoanRequest({
    staff: S.PendingFresh, status: 'pending',
    fromDate: addDays(TODAY, 3), toDate: addDays(TODAY, 10),
    lines: [{ product: P.healthy, requested: 2 }],
    createdDayOffset: -1,
  })

  // ---- pending (near its 30-day expiry) ------------------------------------
  await createLoanRequest({
    staff: S.PendingNearExpiry, status: 'pending',
    fromDate: addDays(TODAY, 20), toDate: addDays(TODAY, 30),
    message: 'Need this for the open day on the 25th, thanks!',
    lines: [{ product: P.monthInterval, requested: 1 }],
    createdDayOffset: -28, updatedDayOffset: -28,
  })

  // ---- countered (rich: removed line + both messages + date change) -------
  {
    const counterMsg = "Can only spare 1 of the first -- the second's almost out of stock so I'd rather not commit it. Let me know if that still works."
    const req = await createLoanRequest({
      staff: S.CounteredRich, status: 'countered',
      fromDate: addDays(TODAY, 4), toDate: addDays(TODAY, 11),
      originalFromDate: addDays(TODAY, 2), originalToDate: addDays(TODAY, 9),
      message: 'Would it be possible to get 3 of these plus 2 of the low-stock item for the open day setup?',
      adminMessage: counterMsg,
      lines: [{ product: P.healthy, requested: 3, offered: 1 }, { product: P.lowStock, requested: 2, offered: 0 }],
      createdDayOffset: -6, updatedDayOffset: -4,
    })
    await writeLoanUpdate({
      request: req, dayOffset: -4,
      before: { status: 'pending', from_date: addDays(TODAY, 2), to_date: addDays(TODAY, 9) },
      after: { status: 'countered', from_date: addDays(TODAY, 4), to_date: addDays(TODAY, 11), admin_message: counterMsg },
    })
  }

  // ---- countered (plain: one line reduced, no messages, no date change) ---
  {
    const req = await createLoanRequest({
      staff: S.CounteredSimple, status: 'countered',
      fromDate: addDays(TODAY, 1), toDate: null,
      lines: [{ product: P.indefinite, requested: 3, offered: 2 }],
      createdDayOffset: -3, updatedDayOffset: -2,
    })
    await writeLoanUpdate({
      request: req, dayOffset: -2,
      before: { status: 'pending', from_date: addDays(TODAY, 1), to_date: null },
      after: { status: 'countered', from_date: addDays(TODAY, 1), to_date: null },
    })
  }

  // ---- accepted, sufficient stock: "On Schedule" ---------------------------
  {
    const req = await createLoanRequest({
      staff: S.AcceptedOnSchedule, status: 'accepted',
      fromDate: addDays(TODAY, 2), toDate: addDays(TODAY, 9),
      lines: [{ product: P.onSchedule, requested: 2, offered: 2 }],
      createdDayOffset: -3, updatedDayOffset: -2,
    })
    await writeLoanUpdate({ request: req, dayOffset: -2, before: { status: 'pending' }, after: { status: 'accepted' } })
  }

  // ---- accepted, INSUFFICIENT with a correlated overdue cause --------------
  {
    const req = await createLoanRequest({
      staff: S.InsufficientCauseRecipient, status: 'accepted',
      fromDate: addDays(TODAY, -1), toDate: addDays(TODAY, 6),
      lines: [{ product: P.insufficientCause, requested: 2, offered: 2 }],
      createdDayOffset: -4, updatedDayOffset: -3,
    })
    await writeLoanUpdate({ request: req, dayOffset: -3, before: { status: 'pending' }, after: { status: 'accepted' } })
  }

  // ---- accepted, INSUFFICIENT with no overdue return to blame --------------
  {
    const req = await createLoanRequest({
      staff: S.InsufficientNoCauseRecipient, status: 'accepted',
      fromDate: TODAY, toDate: addDays(TODAY, 7),
      lines: [{ product: P.insufficientNoCause, requested: 2, offered: 2 }],
      createdDayOffset: -2, updatedDayOffset: -1,
    })
    await writeLoanUpdate({ request: req, dayOffset: -1, before: { status: 'pending' }, after: { status: 'accepted' } })
  }

  // ---- Not Picked Up (live transition -- flips to no_show on next Dashboard
  //      load, exactly like a real stale pickup would) ----------------------
  {
    const req = await createLoanRequest({
      staff: S.NoShowLive, status: 'accepted',
      fromDate: addDays(TODAY, -10), toDate: addDays(TODAY, -1),
      lines: [{ product: P.noShowFeeder, requested: 1, offered: 1 }],
      createdDayOffset: -14, updatedDayOffset: -12,
    })
    await writeLoanUpdate({ request: req, dayOffset: -12, before: { status: 'pending' }, after: { status: 'accepted' } })
  }

  // ---- Not Picked Up (already recorded -- stable, terminal, no race) -------
  {
    const req = await createLoanRequest({
      staff: S.NoShowRecorded, status: 'no_show',
      fromDate: addDays(TODAY, -25), toDate: addDays(TODAY, -15),
      lines: [{ product: P.noShowFeeder, requested: 1, offered: 1 }],
      createdDayOffset: -30, updatedDayOffset: -14,
    })
    await writeLoanUpdate({ request: req, dayOffset: -28, before: { status: 'pending' }, after: { status: 'accepted' } })
    // Auto-expiry never has a human actor -- see expireIfNeeded()'s
    // actor: ActorInfo = {} default and isNoShowCandidate's doc comment.
    await writeLoanUpdate({ request: req, dayOffset: -14, actorId: null, actorName: null, before: { status: 'accepted' }, after: { status: 'no_show' } })
  }

  // ---- expired (already recorded -- blew past the 30-day SLA) -------------
  {
    const req = await createLoanRequest({
      staff: S.ExpiredRecorded, status: 'expired',
      fromDate: addDays(TODAY, -10), toDate: addDays(TODAY, -3),
      lines: [{ product: P.healthy, requested: 1, offered: 1 }],
      createdDayOffset: -40, updatedDayOffset: -10,
    })
    await writeLoanUpdate({ request: req, dayOffset: -10, actorId: null, actorName: null, before: { status: 'pending' }, after: { status: 'expired' } })
  }

  // ---- fulfilled: full pending -> countered -> accepted -> fulfilled history
  {
    const origFrom = addDays(TODAY, -3)
    const origTo = addDays(TODAY, 4)
    const newFrom = addDays(TODAY, -1)
    const newTo = addDays(TODAY, 6)
    const counterMsg = "Reduced to 2 units and pushed the start date back a couple of days -- let me know if that works."
    const req = await createLoanRequest({
      staff: S.FulfilledPickup, status: 'accepted',
      fromDate: newFrom, toDate: newTo, originalFromDate: origFrom, originalToDate: origTo,
      message: 'First-time request, hoping this is fine.',
      adminMessage: counterMsg,
      lines: [{ product: P.fulfilled, requested: 3, offered: 2 }],
      createdDayOffset: -12, updatedDayOffset: -9,
    })
    await writeLoanUpdate({
      request: req, dayOffset: -10,
      before: { status: 'pending', from_date: origFrom, to_date: origTo },
      after: { status: 'countered', from_date: newFrom, to_date: newTo, admin_message: counterMsg },
    })
    // Staff accepted the counter themselves via the portal (acceptCounter) --
    // distinct from approveAsIs, which is Selouna approving unedited.
    await writeLoanUpdate({ request: req, dayOffset: -9, actorId: S.FulfilledPickup.id, actorName: S.FulfilledPickup.full_name, before: { status: 'countered' }, after: { status: 'accepted' } })
    const fulfillTxn = await recordTxn({
      type: 'OUT', staff: S.FulfilledPickup, items: [{ product: P.fulfilled, quantity: 2 }],
      lendFrom: newFrom, lendTo: newTo,
      linkedRequestId: req.id, linkedRequestRef: req.reference_no, dayOffset: -1,
    })
    await db.collection('loan_requests').doc(req.id).update({ status: 'fulfilled', fulfilled_txn_id: fulfillTxn.id, updated_at: isoAt(-1) })
    await writeLoanUpdate({
      request: req, dayOffset: -1, before: { status: 'accepted' },
      after: { status: 'fulfilled', fulfilled_txn_id: fulfillTxn.id, fulfilled_txn_ref: fulfillTxn.reference_no },
    })
    // A couple of extra, unrelated stock-outs against the same staff member --
    // no loan request behind either one -- so the Issued per Staff report has
    // more than a single transaction to expand and group for Demo Fulfilled
    // Pickup: a multi-item pickup and a later single-item one.
    await recordTxn({
      type: 'OUT', staff: S.FulfilledPickup,
      items: [{ product: P.healthy, quantity: 1 }, { product: P.monthInterval, quantity: 2 }],
      lendFrom: addDays(TODAY, -20), lendTo: addDays(TODAY, -13), dayOffset: -20,
    })
    await recordTxn({
      type: 'OUT', staff: S.FulfilledPickup, items: [{ product: P.indefinite, quantity: 1 }],
      lendFrom: addDays(TODAY, -6), lendTo: null, dayOffset: -6,
    })
  }

  // ---- declined while still pending (Selouna, simple) ----------------------
  {
    const declineMsg = "Sorry, this model's been discontinued and we don't have replacement units -- happy to help you find an alternative if useful."
    const req = await createLoanRequest({
      staff: S.DeclinedPending, status: 'declined',
      fromDate: addDays(TODAY, 5), toDate: addDays(TODAY, 12),
      adminMessage: declineMsg,
      lines: [{ product: P.outOfStock, requested: 1, offered: 1 }],
      createdDayOffset: -5, updatedDayOffset: -4,
    })
    await writeLoanUpdate({
      request: req, dayOffset: -4,
      before: { status: 'pending' },
      after: { status: 'declined', admin_message: declineMsg },
    })
  }

  // ---- declined FROM an already-sent counter (Selouna) -- the rich
  //      decline-of-a-counter audit snapshot added 2026-09-20 --------------
  {
    const staffMessage = 'Would it be possible to get 3 of these plus 2 of the whiteboard markers for the open day setup?'
    const counterMessage = "I can only spare 1 of the laptop chargers and none of the markers right now -- sorry, they're almost out. Still happy to help with the laptop charger if useful."
    const declineMessage = "Since it looks like these won't work for what you need, I'll close this one out -- feel free to submit a fresh request if your plans change."
    const req = await createLoanRequest({
      staff: S.DeclinedCounterRich, status: 'declined',
      fromDate: addDays(TODAY, 3), toDate: addDays(TODAY, 10),
      message: staffMessage, adminMessage: declineMessage,
      lines: [{ product: P.healthy, requested: 3, offered: 1 }, { product: P.lowStock, requested: 2, offered: 0 }],
      createdDayOffset: -8, updatedDayOffset: -1,
    })
    await writeLoanUpdate({
      request: req, dayOffset: -6,
      before: { status: 'pending', from_date: addDays(TODAY, 3), to_date: addDays(TODAY, 10) },
      after: { status: 'countered', from_date: addDays(TODAY, 3), to_date: addDays(TODAY, 10), admin_message: counterMessage },
    })
    await writeLoanUpdate({
      request: req, dayOffset: -1,
      before: { status: 'countered' },
      after: {
        status: 'declined', admin_message: declineMessage,
        staff_message: staffMessage, counter_message: counterMessage,
        countered_lines: [
          { product_name: P.healthy.name, requested_quantity: 3, offered_quantity: 1 },
          { product_name: P.lowStock.name, requested_quantity: 2, offered_quantity: 0 },
        ],
      },
    })
  }

  // ---- declined BY the staff member themselves (portal declineCounter) ----
  {
    const req = await createLoanRequest({
      staff: S.DeclinedByStaff, status: 'declined',
      fromDate: addDays(TODAY, 2), toDate: null,
      lines: [{ product: P.indefinite, requested: 2, offered: 1 }],
      createdDayOffset: -7, updatedDayOffset: -3,
    })
    await writeLoanUpdate({
      request: req, dayOffset: -5,
      before: { status: 'pending', from_date: addDays(TODAY, 2), to_date: null },
      after: { status: 'countered', from_date: addDays(TODAY, 2), to_date: null },
    })
    await writeLoanUpdate({ request: req, dayOffset: -3, actorId: S.DeclinedByStaff.id, actorName: S.DeclinedByStaff.full_name, before: { status: 'countered' }, after: { status: 'declined' } })
  }

  // ---- withdrawn by the staff member (no reason) ---------------------------
  {
    const req = await createLoanRequest({
      staff: S.WithdrawnByStaff, status: 'withdrawn',
      fromDate: addDays(TODAY, 6), toDate: addDays(TODAY, 13),
      lines: [{ product: P.healthy, requested: 1, offered: 1 }],
      createdDayOffset: -4, updatedDayOffset: -3,
    })
    await writeLoanUpdate({ request: req, dayOffset: -3, actorId: S.WithdrawnByStaff.id, actorName: S.WithdrawnByStaff.full_name, before: { status: 'pending' }, after: { status: 'withdrawn' } })
  }

  // ---- withdrawn by Selouna cancelling an accepted pickup (with reason) ----
  {
    const req = await createLoanRequest({
      staff: S.WithdrawnByAdmin, status: 'withdrawn',
      fromDate: addDays(TODAY, 3), toDate: addDays(TODAY, 10),
      lines: [{ product: P.healthy, requested: 1, offered: 1 }],
      createdDayOffset: -6, updatedDayOffset: -1,
    })
    await writeLoanUpdate({ request: req, dayOffset: -5, before: { status: 'pending' }, after: { status: 'accepted' } })
    await writeLoanUpdate({
      request: req, dayOffset: -1,
      before: { status: 'accepted' },
      after: { status: 'withdrawn', cancel_reason: 'Staff member said their project got cancelled -- no longer needed.' },
    })
  }

  // =====================================================================
  // 7. MY REQUESTS (portal) -- a full spread of every tab/status combo on
  //    ONE staff member (S.PortalLinked / demo.portallinked@example.com),
  //    so signing into the portal as them shows every possible "My
  //    Requests" outcome in one place, unlike section 6 above which
  //    deliberately spreads one status per staff member for the ADMIN's
  //    Loan Requests queue. History alone runs to 12 rows -- past the
  //    10-row page size -- so its pagination footer has a real second
  //    page to click through.
  // =====================================================================

  // ---- Needs your response (countered) x3 --------------------------------
  {
    const counterMsg = "Can only spare 1 of the first -- the second's almost out of stock so I'd rather not commit it."
    const req = await createLoanRequest({
      staff: S.PortalLinked, status: 'countered',
      fromDate: addDays(TODAY, 4), toDate: addDays(TODAY, 11),
      originalFromDate: addDays(TODAY, 2), originalToDate: addDays(TODAY, 9),
      message: 'Would it be possible to get 3 of these plus 2 of the low-stock item?',
      adminMessage: counterMsg,
      lines: [{ product: P.healthy, requested: 3, offered: 1 }, { product: P.lowStock, requested: 2, offered: 0 }],
      createdDayOffset: -6, updatedDayOffset: -4,
    })
    await writeLoanUpdate({
      request: req, dayOffset: -4,
      before: { status: 'pending', from_date: addDays(TODAY, 2), to_date: addDays(TODAY, 9) },
      after: { status: 'countered', from_date: addDays(TODAY, 4), to_date: addDays(TODAY, 11), admin_message: counterMsg },
    })
  }
  {
    const req = await createLoanRequest({
      staff: S.PortalLinked, status: 'countered',
      fromDate: addDays(TODAY, 1), toDate: null,
      lines: [{ product: P.indefinite, requested: 3, offered: 2 }],
      createdDayOffset: -3, updatedDayOffset: -2,
    })
    await writeLoanUpdate({
      request: req, dayOffset: -2,
      before: { status: 'pending', from_date: addDays(TODAY, 1), to_date: null },
      after: { status: 'countered', from_date: addDays(TODAY, 1), to_date: null },
    })
  }
  {
    const req = await createLoanRequest({
      staff: S.PortalLinked, status: 'countered',
      fromDate: addDays(TODAY, 8), toDate: addDays(TODAY, 15),
      lines: [{ product: P.monthInterval, requested: 2, offered: 1 }, { product: P.onSchedule, requested: 1, offered: 1 }],
      createdDayOffset: -5, updatedDayOffset: -3,
    })
    await writeLoanUpdate({
      request: req, dayOffset: -3,
      before: { status: 'pending' },
      after: { status: 'countered' },
    })
  }

  // ---- Awaiting Selouna (pending) x3 --------------------------------------
  await createLoanRequest({
    staff: S.PortalLinked, status: 'pending',
    fromDate: addDays(TODAY, 3), toDate: addDays(TODAY, 10),
    lines: [{ product: P.healthy, requested: 2 }],
    createdDayOffset: -1,
  })
  await createLoanRequest({
    staff: S.PortalLinked, status: 'pending',
    fromDate: addDays(TODAY, 20), toDate: addDays(TODAY, 27),
    message: 'Need this for a workshop on the 25th, thanks!',
    lines: [{ product: P.onSchedule, requested: 1 }],
    createdDayOffset: -2,
  })
  await createLoanRequest({
    staff: S.PortalLinked, status: 'pending',
    fromDate: addDays(TODAY, 5), toDate: addDays(TODAY, 12),
    lines: [{ product: P.monthInterval, requested: 1 }, { product: P.indefinite, requested: 1 }],
    createdDayOffset: -1,
  })

  // ---- Upcoming (accepted) x3 ----------------------------------------------
  {
    const req = await createLoanRequest({
      staff: S.PortalLinked, status: 'accepted',
      fromDate: addDays(TODAY, 2), toDate: addDays(TODAY, 9),
      lines: [{ product: P.onSchedule, requested: 2, offered: 2 }],
      createdDayOffset: -3, updatedDayOffset: -2,
    })
    await writeLoanUpdate({ request: req, dayOffset: -2, before: { status: 'pending' }, after: { status: 'accepted' } })
  }
  {
    const req = await createLoanRequest({
      staff: S.PortalLinked, status: 'accepted',
      fromDate: addDays(TODAY, 6), toDate: addDays(TODAY, 13),
      message: 'Two of these for a site visit, if possible.',
      lines: [{ product: P.healthy, requested: 2, offered: 2 }, { product: P.monthInterval, requested: 1, offered: 1 }],
      createdDayOffset: -4, updatedDayOffset: -3,
    })
    await writeLoanUpdate({ request: req, dayOffset: -3, before: { status: 'pending' }, after: { status: 'accepted' } })
  }
  {
    const req = await createLoanRequest({
      staff: S.PortalLinked, status: 'accepted',
      fromDate: TODAY, toDate: addDays(TODAY, 7),
      lines: [{ product: P.indefinite, requested: 1, offered: 1 }],
      createdDayOffset: -2, updatedDayOffset: -1,
    })
    await writeLoanUpdate({ request: req, dayOffset: -1, before: { status: 'pending' }, after: { status: 'accepted' } })
  }

  // ---- History: every terminal status, x12 total (past the 10-row page
  //      size) -----------------------------------------------------------

  // fulfilled x2 (one plain accepted->fulfilled, one full negotiation chain)
  {
    const req = await createLoanRequest({
      staff: S.PortalLinked, status: 'fulfilled',
      fromDate: addDays(TODAY, -8), toDate: addDays(TODAY, -1),
      lines: [{ product: P.fulfilled, requested: 2, offered: 2 }],
      createdDayOffset: -15, updatedDayOffset: -8,
    })
    await writeLoanUpdate({ request: req, dayOffset: -10, before: { status: 'pending' }, after: { status: 'accepted' } })
    const fulfillTxn = await recordTxn({
      type: 'OUT', staff: S.PortalLinked, items: [{ product: P.fulfilled, quantity: 2 }],
      lendFrom: addDays(TODAY, -8), lendTo: addDays(TODAY, -1),
      linkedRequestId: req.id, linkedRequestRef: req.reference_no, dayOffset: -8,
    })
    await db.collection('loan_requests').doc(req.id).update({ status: 'fulfilled', fulfilled_txn_id: fulfillTxn.id, updated_at: isoAt(-8) })
    await writeLoanUpdate({
      request: req, dayOffset: -8, before: { status: 'accepted' },
      after: { status: 'fulfilled', fulfilled_txn_id: fulfillTxn.id, fulfilled_txn_ref: fulfillTxn.reference_no },
    })
  }
  {
    const origFrom = addDays(TODAY, -20)
    const origTo = addDays(TODAY, -13)
    const newFrom = addDays(TODAY, -18)
    const newTo = addDays(TODAY, -11)
    const counterMsg = 'Reduced to 1 unit -- only one left in stock right now.'
    const req = await createLoanRequest({
      staff: S.PortalLinked, status: 'accepted',
      fromDate: newFrom, toDate: newTo, originalFromDate: origFrom, originalToDate: origTo,
      adminMessage: counterMsg,
      lines: [{ product: P.onSchedule, requested: 2, offered: 1 }],
      createdDayOffset: -25, updatedDayOffset: -19,
    })
    await writeLoanUpdate({
      request: req, dayOffset: -21,
      before: { status: 'pending', from_date: origFrom, to_date: origTo },
      after: { status: 'countered', from_date: newFrom, to_date: newTo, admin_message: counterMsg },
    })
    await writeLoanUpdate({ request: req, dayOffset: -19, actorId: S.PortalLinked.id, actorName: S.PortalLinked.full_name, before: { status: 'countered' }, after: { status: 'accepted' } })
    const fulfillTxn2 = await recordTxn({
      type: 'OUT', staff: S.PortalLinked, items: [{ product: P.onSchedule, quantity: 1 }],
      lendFrom: newFrom, lendTo: newTo,
      linkedRequestId: req.id, linkedRequestRef: req.reference_no, dayOffset: -18,
    })
    await db.collection('loan_requests').doc(req.id).update({ status: 'fulfilled', fulfilled_txn_id: fulfillTxn2.id, updated_at: isoAt(-18) })
    await writeLoanUpdate({
      request: req, dayOffset: -18, before: { status: 'accepted' },
      after: { status: 'fulfilled', fulfilled_txn_id: fulfillTxn2.id, fulfilled_txn_ref: fulfillTxn2.reference_no },
    })
  }

  // declined while still pending (Selouna) x2
  {
    const declineMsg = "Sorry, we don't have spare units of this one right now."
    const req = await createLoanRequest({
      staff: S.PortalLinked, status: 'declined',
      fromDate: addDays(TODAY, -5), toDate: addDays(TODAY, 2),
      adminMessage: declineMsg,
      lines: [{ product: P.outOfStock, requested: 1, offered: 1 }],
      createdDayOffset: -12, updatedDayOffset: -11,
    })
    await writeLoanUpdate({ request: req, dayOffset: -11, before: { status: 'pending' }, after: { status: 'declined', admin_message: declineMsg } })
  }
  {
    const declineMsg2 = "This model's been retired -- happy to help find an alternative."
    const req = await createLoanRequest({
      staff: S.PortalLinked, status: 'declined',
      fromDate: addDays(TODAY, -14), toDate: addDays(TODAY, -7),
      adminMessage: declineMsg2,
      lines: [{ product: P.legacyNoInterval, requested: 1, offered: 1 }],
      createdDayOffset: -20, updatedDayOffset: -19,
    })
    await writeLoanUpdate({ request: req, dayOffset: -19, before: { status: 'pending' }, after: { status: 'declined', admin_message: declineMsg2 } })
  }

  // declined FROM an already-sent counter (rich decline-of-a-counter snapshot)
  {
    const staffMessage = 'Could I get 3 of these plus 2 of the low-stock item?'
    const counterMessage = 'I can only spare 1 of the first and none of the second right now.'
    const declineMessage = "Since these won't cover what you need, I'll close this one out -- feel free to resubmit if plans change."
    const req = await createLoanRequest({
      staff: S.PortalLinked, status: 'declined',
      fromDate: addDays(TODAY, -10), toDate: addDays(TODAY, -3),
      message: staffMessage, adminMessage: declineMessage,
      lines: [{ product: P.healthy, requested: 3, offered: 1 }, { product: P.lowStock, requested: 2, offered: 0 }],
      createdDayOffset: -18, updatedDayOffset: -11,
    })
    await writeLoanUpdate({
      request: req, dayOffset: -16,
      before: { status: 'pending', from_date: addDays(TODAY, -10), to_date: addDays(TODAY, -3) },
      after: { status: 'countered', from_date: addDays(TODAY, -10), to_date: addDays(TODAY, -3), admin_message: counterMessage },
    })
    await writeLoanUpdate({
      request: req, dayOffset: -11,
      before: { status: 'countered' },
      after: {
        status: 'declined', admin_message: declineMessage,
        staff_message: staffMessage, counter_message: counterMessage,
        countered_lines: [
          { product_name: P.healthy.name, requested_quantity: 3, offered_quantity: 1 },
          { product_name: P.lowStock.name, requested_quantity: 2, offered_quantity: 0 },
        ],
      },
    })
  }

  // declined BY the staff member themselves (portal declineCounter)
  {
    const req = await createLoanRequest({
      staff: S.PortalLinked, status: 'declined',
      fromDate: addDays(TODAY, -6), toDate: null,
      lines: [{ product: P.indefinite, requested: 2, offered: 1 }],
      createdDayOffset: -16, updatedDayOffset: -13,
    })
    await writeLoanUpdate({
      request: req, dayOffset: -15,
      before: { status: 'pending', from_date: addDays(TODAY, -6), to_date: null },
      after: { status: 'countered', from_date: addDays(TODAY, -6), to_date: null },
    })
    await writeLoanUpdate({ request: req, dayOffset: -13, actorId: S.PortalLinked.id, actorName: S.PortalLinked.full_name, before: { status: 'countered' }, after: { status: 'declined' } })
  }

  // expired (blew past the 30-day SLA) x2
  {
    const req = await createLoanRequest({
      staff: S.PortalLinked, status: 'expired',
      fromDate: addDays(TODAY, -25), toDate: addDays(TODAY, -18),
      lines: [{ product: P.healthy, requested: 1, offered: 1 }],
      createdDayOffset: -55, updatedDayOffset: -25,
    })
    await writeLoanUpdate({ request: req, dayOffset: -25, actorId: null, actorName: null, before: { status: 'pending' }, after: { status: 'expired' } })
  }
  {
    const req = await createLoanRequest({
      staff: S.PortalLinked, status: 'expired',
      fromDate: addDays(TODAY, -35), toDate: addDays(TODAY, -28),
      lines: [{ product: P.monthInterval, requested: 1, offered: 1 }],
      createdDayOffset: -65, updatedDayOffset: -35,
    })
    await writeLoanUpdate({ request: req, dayOffset: -35, actorId: null, actorName: null, before: { status: 'pending' }, after: { status: 'expired' } })
  }

  // no_show (already recorded) x2
  {
    const req = await createLoanRequest({
      staff: S.PortalLinked, status: 'no_show',
      fromDate: addDays(TODAY, -22), toDate: addDays(TODAY, -15),
      lines: [{ product: P.noShowFeeder, requested: 1, offered: 1 }],
      createdDayOffset: -28, updatedDayOffset: -15,
    })
    await writeLoanUpdate({ request: req, dayOffset: -26, before: { status: 'pending' }, after: { status: 'accepted' } })
    await writeLoanUpdate({ request: req, dayOffset: -15, actorId: null, actorName: null, before: { status: 'accepted' }, after: { status: 'no_show' } })
  }
  {
    const req = await createLoanRequest({
      staff: S.PortalLinked, status: 'no_show',
      fromDate: addDays(TODAY, -17), toDate: addDays(TODAY, -10),
      lines: [{ product: P.onSchedule, requested: 1, offered: 1 }],
      createdDayOffset: -22, updatedDayOffset: -10,
    })
    await writeLoanUpdate({ request: req, dayOffset: -20, before: { status: 'pending' }, after: { status: 'accepted' } })
    await writeLoanUpdate({ request: req, dayOffset: -10, actorId: null, actorName: null, before: { status: 'accepted' }, after: { status: 'no_show' } })
  }

  // withdrawn by the staff member (no reason)
  {
    const req = await createLoanRequest({
      staff: S.PortalLinked, status: 'withdrawn',
      fromDate: addDays(TODAY, -9), toDate: addDays(TODAY, -2),
      lines: [{ product: P.healthy, requested: 1, offered: 1 }],
      createdDayOffset: -13, updatedDayOffset: -12,
    })
    await writeLoanUpdate({ request: req, dayOffset: -12, actorId: S.PortalLinked.id, actorName: S.PortalLinked.full_name, before: { status: 'pending' }, after: { status: 'withdrawn' } })
  }

  // withdrawn by Selouna cancelling an accepted pickup (with reason)
  {
    const req = await createLoanRequest({
      staff: S.PortalLinked, status: 'withdrawn',
      fromDate: addDays(TODAY, -4), toDate: addDays(TODAY, 3),
      lines: [{ product: P.healthy, requested: 1, offered: 1 }],
      createdDayOffset: -9, updatedDayOffset: -1,
    })
    await writeLoanUpdate({ request: req, dayOffset: -8, before: { status: 'pending' }, after: { status: 'accepted' } })
    await writeLoanUpdate({
      request: req, dayOffset: -1,
      before: { status: 'accepted' },
      after: { status: 'withdrawn', cancel_reason: 'IT Store closing early that week -- pickup no longer possible in the window.' },
    })
  }

  // =====================================================================
  console.log('Seeded comprehensive demo data:\n')
  console.log('LOGINS:')
  console.log(`  BICS admin:      ${ADMIN_EMAIL} / password123               -> http://localhost:3000/login   (${ADMIN_NAME})`)
  console.log(`  Notifications:   administrator emails -> ${ADMIN_EMAIL}; sent from ${SYSTEM_FROM_EMAIL}`)
  console.log('  Portal borrower: demo.portallinked@example.com / password123 -> http://localhost:3000/lend/login')
  console.log('')
  console.log('DASHBOARD -> Outstanding Returns: No Date / Overdue / Due Today / Not Due Yet /')
  console.log('  Partly Resolved / Mixed holder / the Insufficient-cause overdue OUT / a')
  console.log('  still-overdue partial return -- 8 rows in all, expand any "Demo --" one.')
  console.log('')
  console.log('DASHBOARD -> Incoming Pickups: On Schedule, Insufficient (x2 -- one with an')
  console.log('  overdue "likely cause" bullet, one with the fallback "worth a stock check"')
  console.log('  message), and Not Picked Up (one flips live on your next Dashboard load --')
  console.log('  reload fast to catch the badge -- one already recorded).')
  console.log('')
  console.log('DASHBOARD -> Low Stock Alerts: "Demo Product -- Low Stock" and "-- Out of Stock".')
  console.log('')
  console.log('LOAN REQUESTS: every status is represented -- expand any "Demo --" row on')
  console.log('  Needs Review / Sent Counters, and check History for accepted/fulfilled/')
  console.log('  declined/expired/no_show/withdrawn.')
  console.log('')
  console.log('MY REQUESTS (portal): sign in as demo.portallinked@example.com above, then')
  console.log('  http://localhost:3000/lend/requests -- every tab (Needs your response,')
  console.log('  Awaiting Selouna, Upcoming, History) has several rows, and History alone')
  console.log('  has 12 -- past the 10-row page size, so its pagination footer has a real')
  console.log('  second page to click through.')
  console.log('')
  console.log('REPORTS: Stock Levels & Low Stock reflect the products above; Issued Per')
  console.log('  Staff and Transaction History include IN/OUT/RETURN/ADJUST activity across')
  console.log('  every "Demo --" staff member; Returns has a full and a partial return.')
  console.log('')
  console.log('PRODUCT IMAGES: every product above got 1-3 generated placeholder photos')
  console.log('  uploaded to the Storage emulator -- check Browse or the Products page.')
  console.log('')
  console.log("AUDIT LOG: filter by entity to see product/category/staff/transaction/")
  console.log('  loan_request coverage -- including the new decline-of-a-counter rich')
  console.log('  snapshot on "Demo -- Declined Counter Rich".')
  console.log('')
  console.log('Re-running this script adds a second batch of ledger/audit data on top of')
  console.log('this one (append-only, like the real app) -- clear the emulator data from')
  console.log('http://127.0.0.1:4000 first for a clean slate.')
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

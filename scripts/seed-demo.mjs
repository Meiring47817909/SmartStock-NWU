// seed:demo -- the NWU demo version of seed:comprehensive (same products,
// categories, scenarios and audit history), for showing the app to the client.
// Differences from scripts/seed-comprehensive-demo.mjs, which stays as it is
// for the spin video:
//   - Selouna Visser (selouna.visser@nwu.ac.za) is the administrator.
//   - The staff are the 20 real Computer Science and Information Systems staff
//     from scripts/seed-staff-roster.mjs, each taking over one scenario. The 10
//     scenarios with no NWU staff member left over are not seeded (see DROPPED
//     below); every loan request status and return badge is still covered.
//   - The portal borrower with the full My Requests history is Meiring van
//     Niekerk (47817909@mynwu.ac.za).
//   - Only Selouna and Meiring get a login (password123). The NWU staff are
//     staff records only, so nobody can sign in as them.
//   - Bostik Glu Dots, the product scanned in during the client demo on
//     29 September 2026, is included with its original create audit entry
//     (none of that demo's transactions).
//
// DROPPED scenarios (no staff member for them): CounteredSimple, NoShowLive,
// ExpiredRecorded, DeclinedPending, WithdrawnByStaff, ReturnNoDate,
// ReturnOverdue, ReturnDueToday, ReturnCompleted, ReturnPartial.
//
// Emulators only, like seed:comprehensive. Start from empty emulators (clear
// them at http://127.0.0.1:4000, or restart them) so the two datasets don't mix.
//
// The notes below are seed:comprehensive's own and still describe this data.
//
// Seeds the Firebase emulators with a single, comprehensive demo dataset
// covering essentially every distinct status/badge/label the app can show,
// in one place, so the whole thing can be eyeballed in one sitting:
//
//   - Dashboard -> Outstanding Returns: No Return Date, Overdue, Due Today,
//     Not Due Yet, Partly Resolved (waived), Mixed (one holder, 3 states),
//     plus a partial return whose remaining items are not yet due from the Returns section
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
//   npm run seed:demo
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

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore } from 'firebase-admin/firestore'
import { getStorage } from 'firebase-admin/storage'

const PROJECT_ID = 'demo-smartstock-nwu'
const LOCATION = 'NWU - Potchefstroom, Building G4, Room 28'
const DEPARTMENT = 'Computer Science and Information Systems'
// The administrator's display name (profile + every audit entry attributed to them).
const ADMIN_NAME = 'Selouna Visser'
const ADMIN_EMAIL = 'selouna.visser@nwu.ac.za'
// Settings -> Notifications: the system sending address (every email comes From it).
const SYSTEM_FROM_EMAIL = 'noreply@smartstock-nwu.com'
const ADMIN_UID = 'admin-selouna-visser'
// Must match NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET in .env.local -- see
// scripts/seed-products.mjs's own copy of this constant for why.
const BUCKET_NAME = 'smartstock-nwu.firebasestorage.app'

const app = initializeApp({ projectId: PROJECT_ID, storageBucket: BUCKET_NAME })
const auth = getAuth(app)
const db = getFirestore(app)
const bucket = getStorage(app).bucket()
// Real product photos (AI-generated, see scripts/generate-product-images.mjs).
const CATALOG_IMAGES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'catalog-images')

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
async function seedProductImages(productId, productName, imageSlug = null) {
  // Real photos when scripts/catalog-images/<slug>/1.jpg, 2.jpg ... exist.
  if (imageSlug) {
    const real = []
    for (let n = 1; n <= 3; n++) {
      const file = join(CATALOG_IMAGES_DIR, imageSlug, `${n}.jpg`)
      if (existsSync(file)) real.push({ n, file })
    }
    if (real.length > 0) {
      const paths = []
      for (const { n, file } of real) {
        const path = `products/${productId}/${imageSlug}-${n}.jpg`
        await bucket.file(path).save(readFileSync(file), {
          contentType: 'image/jpeg',
          metadata: { cacheControl: 'public, max-age=3600' },
        })
        paths.push(path)
      }
      return paths
    }
  }
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
    return { id: ref.id, name: spec.name, surname: spec.surname, full_name: spec.full_name, email: spec.email, department: payload.department, card_uid: payload.card_uid, uid: payload.uid }
  }
  const ref = await db.collection('staff').add({ ...payload, created_at: now })
  return { id: ref.id, name: spec.name, surname: spec.surname, full_name: spec.full_name, email: spec.email, department: payload.department, card_uid: payload.card_uid, uid: payload.uid }
}

async function upsertProduct(spec) {
  const existingSnap = await db.collection('products').where('barcodes', 'array-contains', spec.barcode).get()
  const now = new Date().toISOString()
  const payload = {
    category_id: spec.category_id ?? null,
    category_name: spec.category_name ?? null,
    name: spec.name,
    description: spec.description ?? `${spec.name} -- seeded by scripts/seed-comprehensive-demo.mjs`,
    // spec.barcode is always the lookup/primary key; spec.barcodes lets a
    // product carry extras on top of it (e.g. a manufacturer code plus an
    // NWU-printed one) so Stock Out's multi-barcode capture has something
    // real to demonstrate against -- see P.healthy below.
    barcodes: spec.barcodes ?? [spec.barcode],
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
    const images = await seedProductImages(ref.id, spec.name, spec.image_slug)
    await ref.set({ images }, { merge: true })
    const snap = await ref.get()
    return { id: ref.id, name: spec.name, description: payload.description, quantity_on_hand: snap.data()?.quantity_on_hand ?? spec.quantity_on_hand, barcodes: payload.barcodes }
  }
  const ref = await db.collection('products').add({
    ...payload, quantity_on_hand: spec.quantity_on_hand, created_at: now, images: [],
  })
  const images = await seedProductImages(ref.id, spec.name, spec.image_slug)
  await ref.set({ images }, { merge: true })
  return { id: ref.id, name: spec.name, description: payload.description, quantity_on_hand: spec.quantity_on_hand, barcodes: payload.barcodes }
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
// OUT txn id -> [{product_id, barcode, quantity}] as issued, and OUT txn id ->
// Map('productId|barcode' -> units already returned). Lets recordTxn make a
// RETURN use exactly the barcodes its OUT was issued with.
const txnLineIndex = new Map()
const returnedIndex = new Map()

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
  // A staff member with no card on file can only ever have been picked from the
  // list, so their Stock Outs / Returns are manual entries by definition.
  if (isStaffFlow && staff && !staff.card_uid) manualOverride = true
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
  // One transaction_lines document per (product, barcode), exactly like the
  // app writes them now (see stock-out / stock-in / returns page.tsx): scanning
  // two different barcodes of the same product yields two rows, each with its
  // own singular `barcode` and its own quantity.
  //
  // Where the barcodes come from, per item:
  //   - item.barcodes (string[])  -> explicit; quantity is spread across them
  //   - RETURN with linkedTxnId   -> must be drawn from the linked OUT's own
  //                                  barcodes for that product (exact match,
  //                                  same rule Returns enforces at scan time)
  //   - otherwise IN/OUT          -> the product's own barcodes
  //   - ADJUST                    -> none (a manual count correction isn't scanned)
  // Capped at the line's quantity: each distinct barcode implies at least one
  // scan, which is at least one unit.
  function spreadQuantity(codes, quantity) {
    const n = Math.min(codes.length, quantity)
    const base = Math.floor(quantity / n)
    const extra = quantity - base * n
    return codes.slice(0, n).map((code, i) => ({ barcode: code, quantity: base + (i < extra ? 1 : 0) }))
  }
  function resolveLines(item) {
    if (type === 'ADJUST') return [{ barcode: null, quantity: item.quantity }]
    if (type === 'RETURN' && linkedTxnId) {
      const outLines = (txnLineIndex.get(linkedTxnId) ?? []).filter(l => l.product_id === item.product.id)
      const returned = returnedIndex.get(linkedTxnId) ?? new Map()
      const remaining = new Map(outLines.map(l => [l.barcode, l.quantity - (returned.get(`${l.product_id}|${l.barcode}`) ?? 0)]))
      if (item.barcodes) {
        for (const code of item.barcodes) {
          if (!remaining.has(code)) throw new Error(`recordTxn: RETURN barcode "${code}" was never issued on OUT ${linkedTxnId}`)
        }
        const spread = spreadQuantity(item.barcodes, item.quantity)
        for (const s of spread) {
          if (s.quantity > remaining.get(s.barcode)) throw new Error(`recordTxn: RETURN of ${s.quantity} x "${s.barcode}" exceeds what is still out`)
        }
        return spread
      }
      // No explicit barcodes: return the first units still out, in issue order.
      const picked = []
      let need = item.quantity
      for (const l of outLines) {
        const take = Math.min(need, remaining.get(l.barcode))
        if (take > 0) { picked.push({ barcode: l.barcode, quantity: take }); need -= take }
        if (need === 0) break
      }
      if (need > 0) throw new Error(`recordTxn: RETURN quantity ${item.quantity} exceeds units still out on OUT ${linkedTxnId}`)
      return picked
    }
    const all = item.barcodes ?? item.product.barcodes
    if (!all || all.length === 0) return [{ barcode: null, quantity: item.quantity }]
    return spreadQuantity(all, item.quantity)
  }
  const resolved = items.map(item => resolveLines(item))
  for (const [idx, item] of items.entries()) {
    for (const l of resolved[idx]) {
      await db.collection('transaction_lines').add({
        transaction_id: txnRef.id, product_id: item.product.id, quantity: l.quantity,
        unit_cost: item.unit_cost ?? 0, product_name: item.product.name,
        barcode: l.barcode,
        created_at: issuedAt,
      })
    }
    await db.collection('products').doc(item.product.id).update({
      quantity_on_hand: item.product.quantity_on_hand + dir * item.quantity,
      updated_at: new Date().toISOString(),
    })
    item.product.quantity_on_hand += dir * item.quantity
  }
  // Remember what each OUT issued / each RETURN took back so later RETURNs can
  // be validated against it.
  if (type === 'OUT') {
    txnLineIndex.set(txnRef.id, items.flatMap((item, idx) => resolved[idx].map(l => ({ product_id: item.product.id, barcode: l.barcode, quantity: l.quantity }))))
  }
  if (type === 'RETURN' && linkedTxnId) {
    const m = returnedIndex.get(linkedTxnId) ?? new Map()
    items.forEach((item, idx) => resolved[idx].forEach(l => {
      const k = `${item.product.id}|${l.barcode}`
      m.set(k, (m.get(k) ?? 0) + l.quantity)
    }))
    returnedIndex.set(linkedTxnId, m)
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
      // One entry per PRODUCT; barcodes is always an array of every distinct
      // barcode scanned for it (matches the app's frozen audit lines).
      lines: items.map((i, idx) => ({
        product_id: i.product.id, product_name: i.product.name, quantity: i.quantity,
        barcodes: [...new Set(resolved[idx].map(l => l.barcode).filter(b => b !== null))],
        // Units per barcode (what the audit CSV shows as "A ×2 | B ×1").
        barcode_quantities: [...resolved[idx].filter(l => l.barcode !== null).reduce((m, l) => m.set(l.barcode, (m.get(l.barcode) ?? 0) + l.quantity), new Map())].map(([barcode, quantity]) => ({ barcode, quantity })),
      })),
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
  const portalBorrowerUser = await upsertUser('47817909@mynwu.ac.za', 'password123', 'seed-demo-portallinked-uid')

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

  const demoCatId = await upsertCategory('Office Accessories', 'Desk organisers, monitor stands and cable trays.')
  await writeAudit({
    userId: ADMIN_UID, userName: ADMIN_NAME, action: 'create', entityType: 'category', entityId: demoCatId,
    before: null, after: { name: 'Office Accessories', description: 'Desk organisers, monitor stands and cable trays.' },
    createdAt: isoAt(-14),
  })
  await db.collection('categories').doc(demoCatId).set({ description: 'Desk organisers, monitor stands, cable trays and laptop risers.' }, { merge: true })
  await writeAudit({
    userId: ADMIN_UID, userName: ADMIN_NAME, action: 'update', entityType: 'category', entityId: demoCatId,
    before: { name: 'Office Accessories', description: 'Desk organisers, monitor stands and cable trays.' },
    after: { name: 'Office Accessories', description: 'Desk organisers, monitor stands, cable trays and laptop risers.' },
    createdAt: isoAt(-13),
  })

  // =====================================================================
  // 2. STAFF -- the cast of characters. Each scenario below gets its
  //    own staff record so every row is unambiguous in every list/sidebar.
  // =====================================================================
  const S = {}
  // [key, first name, surname, gmail, department, what this person demonstrates]
  // Every scenario still gets its OWN person (so each row is unambiguous in
  // every list), but they now read like real staff. The last column is the
  // scenario -- printed as a "who is who" legend when the seed finishes.
  const D = {
    phys: 'Physical and Chemical Sciences', bio: 'Biological Sciences', geo: 'Geo- and Spatial Sciences',
    agri: 'Agricultural Sciences', math: 'Mathematical and Statistical Sciences',
    cs: 'Computer Science and Information Systems', bmi: 'Business Mathematics and Informatics',
  }
  // [key, first name, surname, email, department, scenario, index in seed:comprehensive]
  // The NWU Computer Science and Information Systems staff (scripts/seed-staff-roster.mjs),
  // one scenario each. The last column keeps each scenario's card on file the same as in
  // seed:comprehensive (it decides the card mix below).
  const staffSpecs = [
    ['PendingFresh', 'Estelle', 'Taylor', 'estelle.taylor@nwu.ac.za', DEPARTMENT, 'Pending loan request (fresh); staff create/update audit', 0],
    ['PendingNearExpiry', 'Annette', 'van der Merwe', 'annette.vandermerwe@nwu.ac.za', DEPARTMENT, 'Pending loan request, close to expiring', 1],
    ['CounteredRich', 'Linda', 'Redelinghuys', 'linda.redelinghuys@nwu.ac.za', DEPARTMENT, 'Counter-offer with removed line, messages and date change', 2],
    ['AcceptedOnSchedule', 'Rodney', 'Sebopelo', 'rodney.sebopelo@nwu.ac.za', DEPARTMENT, 'Accepted request, pickup on schedule', 4],
    ['InsufficientCauseRecipient', 'Susan', 'Campher', 'susan.campher@nwu.ac.za', DEPARTMENT, 'Pickup short on stock, overdue return is the likely cause', 5],
    ['OverdueHolderCause', 'Kobus', 'van Aswegen', 'kobus.vanaswegen@nwu.ac.za', DEPARTMENT, 'Holds the overdue item behind the shortage above', 6],
    ['InsufficientNoCauseRecipient', 'Tiny', 'du Toit', 'tiny.dutoit@nwu.ac.za', DEPARTMENT, 'Pickup short on stock, no overdue return to blame', 7],
    ['NoShowRecorded', 'Marijke', 'Coetzee', 'marijke.coetzee@nwu.ac.za', DEPARTMENT, 'Missed pickup, already recorded', 9],
    ['FulfilledPickup', 'Lynette', 'Drevin', 'lynette.drevin@nwu.ac.za', DEPARTMENT, 'Full pending -> countered -> accepted -> fulfilled history', 11],
    ['DeclinedCounterRich', 'Absalom', 'Ezugwu', 'absalom.ezugwu@nwu.ac.za', DEPARTMENT, 'Admin declined a rich counter-offer', 13],
    ['DeclinedByStaff', 'Dimitri', 'Keykaan', 'dimi.keykaan@nwu.ac.za', DEPARTMENT, 'Declined by the staff member via the portal', 14],
    ['WithdrawnByAdmin', 'Neels', 'Kruger', 'neels.kruger@nwu.ac.za', DEPARTMENT, 'Admin cancelled an accepted pickup, with a reason', 16],
    ['ReturnNotDueYet', 'Janet', 'Liebenberg', 'janet.liebenberg@nwu.ac.za', DEPARTMENT, 'Outstanding return -- Not Due Yet', 20],
    ['ReturnPartlyResolved', 'Rudi', 'Serfontein', 'rudi.serfontein@nwu.ac.za', DEPARTMENT, 'Outstanding return -- Partly Resolved (one unit written off)', 21],
    ['ReturnMixedHolder', 'Henri', 'van Rensburg', 'henri.vanrensburg@nwu.ac.za', DEPARTMENT, 'One holder, three return states at once', 22],
    ['MultiBarcodeFull', 'Dumani', 'Kunjuzwa', 'dumani.kunjuzwa@nwu.ac.za', DEPARTMENT, 'Multi-product, multi-barcode Stock Out, fully returned', 25],
    ['MultiBarcodePartial', 'Jeanne-Mari', 'Maree', 'jeanne.maree@nwu.ac.za', DEPARTMENT, 'Multi-product, multi-barcode Stock Out, partly returned (rest due today)', 26],
    ['LostLabels', 'Heystek', 'Grobler', 'heystek.grobler@nwu.ac.za', DEPARTMENT, 'Lost-label Returns demo (relabel flow)', 27],
    ['BadgeActive', 'Phenyo', 'Modisane', 'phenyo.modisane@nwu.ac.za', DEPARTMENT, 'Staff badge activated (audit log); holds two items that are not due yet', 28],
    ['BadgeDeactivated', 'Gunther', 'Drevin', 'gunther.drevin@nwu.ac.za', DEPARTMENT, 'Deactivated staff badge (audit log, inactive card)', 29],
    ['PortalLinked', 'Meiring', 'van Niekerk', '47817909@mynwu.ac.za', DEPARTMENT, 'Portal borrower login -- owns the My Requests history', 30],
  ]
  const STAFF_SCENARIO = Object.fromEntries(staffSpecs.map((r) => [r[0], r[5]]))
  // Card / portal-access mix, spread evenly over the list (index mod 4):
  // card + portal, card only, portal only, neither -- so the Staff page's
  // "Not linked" / "Not granted" badges sit next to real values. Portal
  // access is a real Auth login (password123), not just a flag.
  const portalStaffKeys = []
  for (const [key, name, surname, email, department, , i] of staffSpecs) {
    const hasCard = i % 4 === 0 || i % 4 === 1
    // Only Meiring (the portal borrower) has a login; the NWU staff are records only.
    const hasPortal = key === 'PortalLinked'
    const card_uid = hasCard ? (0x04a00000 + (i + 1) * 0x1f3b7).toString(16).toUpperCase().padStart(8, '0') : null
    let uid = null
    if (hasPortal) {
      uid = key === 'PortalLinked' ? portalBorrowerUser.uid : (await upsertUser(email, 'password123', `seed-staff-${key.toLowerCase()}-uid`)).uid
      portalStaffKeys.push(key)
    }
    S[key] = await upsertStaff({ name, surname, full_name: `${name} ${surname}`, email, department, card_uid, uid })
  }
  // A deactivated one, seeded directly (rather than toggled after create)
  // so it's already in that state.
  await upsertStaff({ name: S.BadgeDeactivated.name, surname: S.BadgeDeactivated.surname, full_name: S.BadgeDeactivated.full_name, email: S.BadgeDeactivated.email, department: S.BadgeDeactivated.department, is_active: false, card_uid: S.BadgeDeactivated.card_uid })
  // Link the real portal-borrower Auth account created in section 0 above --
  // upsertStaff's tuple-based staffSpecs loop above has no uid field, so
  // this one's own doc still needs its uid filled in after the fact.
  await db.collection('staff').doc(S.PortalLinked.id).update({ uid: portalBorrowerUser.uid })

  // ---- Staff audit log coverage: create / update / activate / deactivate /
  //      portal-access-granted, one of each ------------------------------
  await writeAudit({
    userId: ADMIN_UID, userName: ADMIN_NAME, action: 'create', entityType: 'staff', entityId: S.PendingFresh.id,
    before: null,
    after: { name: S.PendingFresh.name, surname: S.PendingFresh.surname, full_name: S.PendingFresh.full_name, email: S.PendingFresh.email, department: S.PendingFresh.department, card_uid: null, is_active: true, uid: null },
    createdAt: isoAt(-30),
  })
  await writeAudit({
    userId: ADMIN_UID, userName: ADMIN_NAME, action: 'update', entityType: 'staff', entityId: S.PendingFresh.id,
    before: { name: S.PendingFresh.name, surname: S.PendingFresh.surname, full_name: S.PendingFresh.full_name, email: S.PendingFresh.email, department: D.math, card_uid: null },
    after: { name: S.PendingFresh.name, surname: S.PendingFresh.surname, full_name: S.PendingFresh.full_name, email: S.PendingFresh.email, department: S.PendingFresh.department, card_uid: null },
    createdAt: isoAt(-29),
  })
  await writeAudit({
    userId: ADMIN_UID, userName: ADMIN_NAME, action: 'activate', entityType: 'staff', entityId: S.BadgeActive.id,
    before: { is_active: false, name: S.BadgeActive.name, surname: S.BadgeActive.surname, full_name: S.BadgeActive.full_name, email: S.BadgeActive.email },
    after: { is_active: true, name: S.BadgeActive.name, surname: S.BadgeActive.surname, full_name: S.BadgeActive.full_name, email: S.BadgeActive.email },
    createdAt: isoAt(-20),
  })
  await writeAudit({
    userId: ADMIN_UID, userName: ADMIN_NAME, action: 'deactivate', entityType: 'staff', entityId: S.BadgeDeactivated.id,
    before: { is_active: true, name: S.BadgeDeactivated.name, surname: S.BadgeDeactivated.surname, full_name: S.BadgeDeactivated.full_name, email: S.BadgeDeactivated.email },
    after: { is_active: false, name: S.BadgeDeactivated.name, surname: S.BadgeDeactivated.surname, full_name: S.BadgeDeactivated.full_name, email: S.BadgeDeactivated.email },
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

  // Portal access granted to the other staff with a login (Meiring van Niekerk's two
  // entries are above): one grant_access each, spread over the past weeks.
  for (const [n, key] of portalStaffKeys.filter((k) => k !== 'PortalLinked').entries()) {
    const ctx = { full_name: S[key].full_name, email: S[key].email, uid: S[key].uid }
    await writeAudit({
      userId: ADMIN_UID, userName: ADMIN_NAME, action: 'grant_access', entityType: 'staff', entityId: S[key].id,
      before: ctx, after: ctx, createdAt: isoAt(-45 + n * 3),
    })
  }

  // =====================================================================
  // 3. PRODUCTS -- variety across stock level, lending interval, and the
  //    "Availability" toggle. Reused across the scenarios below.
  // =====================================================================
  const P = {}
  // Each scenario product is a believable catalogue item. image_slug points
  // at scripts/catalog-images/<slug>/ (the generated product photos); a few
  // items share a photo set with a close variant. Barcodes keep their DEMO-
  // prefix on purpose: the scenarios below (and the Returns/Stock Out
  // walkthroughs in the notes at the bottom) refer to them by value.
  const cat = (n) => ({ category_id: categoryId[n], category_name: n })

  // Carries two barcodes on purpose -- its manufacturer code plus an
  // NWU-printed one -- so the Fulfilled Pickup walk-in stock-out below can
  // demonstrate a line where more than one of a product's barcodes was
  // scanned (see TransactionLine.barcodes in database.ts).
  P.healthy = await upsertProduct({
    name: 'Wireless Mouse', barcode: 'DEMO-HEALTHY', barcodes: ['DEMO-HEALTHY', 'DEMO-HEALTHY-ALT'],
    quantity_on_hand: 25, reorder_threshold: 5, lending_interval: 'week_1', ...cat('Peripherals'),
    image_slug: 'wireless-mouse', description: '2.4 GHz wireless optical mouse with a nano USB-A receiver that stores inside the battery bay. Ergonomic right-hand shape with a precision scroll wheel, forward and back buttons and adjustable 800 / 1200 / 1600 DPI. Runs up to 12 months on a single AA battery. Plug-and-play on Windows, macOS and Linux.',
  })
  // Edge case: ten barcodes on one product (see the "Edge case" stock-out
  // below, under Fulfilled Pickup) -- stress-tests how the Issued per Staff
  // report renders a long barcode list under a single product line. Paper
  // is a natural fit: every ream carries its own barcode.
  P.manyBarcodes = await upsertProduct({
    name: 'A4 Copy Paper (500 sheets)', barcode: 'DEMO-MANYBARCODE-01',
    barcodes: Array.from({ length: 10 }, (_, i) => `DEMO-MANYBARCODE-${String(i + 1).padStart(2, '0')}`),
    quantity_on_hand: 20, reorder_threshold: 3, lending_interval: 'week_1', ...cat('Consumables'),
    image_slug: 'a4-copy-paper', description: '80 gsm white A4 multipurpose paper (210 x 297 mm), 500 sheets per ream. Suitable for laser and inkjet printers, photocopiers and fax machines. Acid-free, with a smooth finish that feeds reliably and resists jamming. Each ream carries its own barcode so individual reams can be issued and returned.',
  })
  // Two more multi-barcode products for the "Multi-Barcode" Stock In / Stock
  // Out / Return scenario in section 5: each carries several barcodes, and
  // that scenario uses more than one of them per product, on more than one
  // product per transaction.
  P.kitCable = await upsertProduct({
    name: 'USB-C Cable 1m', barcode: 'DEMO-KITCABLE-A',
    barcodes: ['DEMO-KITCABLE-A', 'DEMO-KITCABLE-B', 'DEMO-KITCABLE-C'],
    quantity_on_hand: 0, reorder_threshold: 2, lending_interval: 'week_2', ...cat('Cables & Adapters'),
    image_slug: 'usb-c-cable', description: 'Braided nylon USB-C to USB-C cable, 1 metre, with a connector at each end. Supports USB 3.1 Gen 2 data transfer up to 10 Gbps, 60 W fast charging and video output on compatible devices. Reinforced strain relief and a reversible plug that fits either way round.',
  })
  P.kitAdapter = await upsertProduct({
    name: 'DisplayPort Cable 2m', barcode: 'DEMO-KITADAPTER-A',
    barcodes: ['DEMO-KITADAPTER-A', 'DEMO-KITADAPTER-B'],
    quantity_on_hand: 0, reorder_threshold: 2, lending_interval: 'week_2', ...cat('Cables & Adapters'),
    image_slug: 'displayport-cable', description: 'DisplayPort 1.4 cable, 2 metres, with a DisplayPort male connector at each end. Carries video and audio up to 8K at 30 Hz or 4K at 120 Hz, with HDR support. Gold-plated latching connectors give a secure fit on monitors, docking stations and graphics cards.',
  })
  // Lost-label demo: THREE units are issued under ONE barcode (A) even though
  // the product has three registered barcodes -- so Returns shows a single row
  // "issued 3, returnable 3" for barcode A. See the LostLabels scenario below.
  P.lostLabel = await upsertProduct({
    name: '27-inch Monitor', barcode: 'DEMO-LOSTLABEL-A',
    barcodes: ['DEMO-LOSTLABEL-A', 'DEMO-LOSTLABEL-B', 'DEMO-LOSTLABEL-C'],
    quantity_on_hand: 10, reorder_threshold: 2, lending_interval: 'week_2', ...cat('Peripherals'),
    image_slug: 'monitor-27', description: '27-inch Full HD (1920 x 1080) IPS monitor with wide 178-degree viewing angles and a 75 Hz refresh rate. Inputs: 2 x HDMI 1.4, 1 x DisplayPort 1.2 and a 3.5 mm audio output. Height-adjustable stand with tilt and swivel, plus a 100 x 100 mm VESA mount. Flicker-free with a low blue-light mode.',
  })
  // Second product on the same Lost Labels transaction, so that row has TWO
  // products (3 x monitor + 2 x webcam) -- shows how a multi-product return,
  // relabels and outstanding items look in the Returns report CSV.
  P.lostLabelPair = await upsertProduct({
    name: 'HD Webcam', barcode: 'DEMO-LOSTPAIR-A',
    barcodes: ['DEMO-LOSTPAIR-A', 'DEMO-LOSTPAIR-B'],
    quantity_on_hand: 8, reorder_threshold: 2, lending_interval: 'week_2', ...cat('Peripherals'),
    image_slug: 'hd-webcam', description: '1080p Full HD webcam recording at 30 frames per second with a 90-degree wide-angle lens and autofocus. Built-in dual noise-reducing microphones. Connects through a 1.5 m attached USB-A 2.0 cable, plug and play with no drivers. Clips onto a monitor or screws onto a standard tripod, and works with Teams, Zoom and Google Meet.',
  })
  P.lowStock = await upsertProduct({
    name: 'Ethernet Patch Cable Cat6', barcode: 'DEMO-LOWSTOCK', quantity_on_hand: 4, reorder_threshold: 5,
    lending_interval: 'week_2', ...cat('Cables & Adapters'),
    image_slug: 'ethernet-patch-cable', description: 'Cat6 patch cable with RJ45 connectors at both ends, 2 metres. Supports Gigabit Ethernet up to 1 Gbps (rated to 250 MHz) for switches, routers, access points and wall points. Snagless moulded boots protect the latch, and the shielded cable reduces interference.',
  })
  P.outOfStock = await upsertProduct({
    name: 'Solid State Drive 1TB', barcode: 'DEMO-OUTOFSTOCK', quantity_on_hand: 0, reorder_threshold: 3,
    lending_interval: 'week_3', ...cat('Storage'),
    image_slug: 'ssd-1tb', description: '1 TB 2.5-inch SATA III solid state drive with sequential reads up to 550 MB/s and writes up to 520 MB/s. Connects through a standard SATA data port plus SATA power, in a 7 mm slim case that fits laptops and desktops. Shock-resistant with no moving parts, a quick way to upgrade an ageing hard drive.',
  })
  P.indefinite = await upsertProduct({
    name: 'Business Laptop', barcode: 'DEMO-INDEFINITE', quantity_on_hand: 12, reorder_threshold: 2,
    lending_interval: 'indefinite', ...cat('Laptops & Computers'),
    image_slug: 'business-laptop', description: '14-inch business laptop with a Full HD anti-glare display, 16 GB RAM and a 512 GB NVMe SSD. Ports: 2 x USB-A 3.2, 2 x USB-C (Thunderbolt 4, charging and DisplayPort), 1 x HDMI 2.0, a 3.5 mm combo audio jack and a microSD reader. Backlit keyboard, fingerprint reader and Wi-Fi 6. Issued for the duration of a project.',
  })
  P.monthInterval = await upsertProduct({
    name: 'Wi-Fi Router', barcode: 'DEMO-MONTH', quantity_on_hand: 15, reorder_threshold: 3,
    lending_interval: 'month_1', ...cat('Networking'),
    image_slug: 'wifi-router', description: 'Dual-band AC1200 Wi-Fi router (2.4 GHz and 5 GHz) with four external antennas. Ports: 1 x Gigabit WAN, 4 x Gigabit LAN and 1 x USB 3.0 for sharing storage. Supports guest networks, WPA3 and basic parental controls, and is configured through a web page. Ideal for labs and temporary office set-ups.',
  })
  // lending_interval omitted on purpose (pre-Lending-Interval-field legacy shape)
  P.legacyNoInterval = await upsertProduct({
    name: 'Surge Protector Power Strip', barcode: 'DEMO-LEGACY', quantity_on_hand: 10, reorder_threshold: 2,
    ...cat('Power'),
    image_slug: 'surge-power-strip', description: 'Six-outlet surge protector with an illuminated on/off switch and a protected and grounded indicator light. Absorbs up to 1800 joules and has a built-in overload breaker. 2 metre power cord, and keyhole mounting slots so it can be fixed to a wall or desk underside.',
  })
  P.unavailable = await upsertProduct({
    name: 'Laser Toner Cartridge (Black)', barcode: 'DEMO-UNAVAILABLE', quantity_on_hand: 8, reorder_threshold: 2,
    available: false, lending_interval: 'week_1', ...cat('Consumables'),
    image_slug: 'toner-cartridge', description: 'Black toner cartridge for departmental monochrome laser printers, with a page yield of about 3,000 pages at 5 percent coverage. Includes a new drum interface and chip, installs without tools, and prints sharp text and graphics. Currently withdrawn from lending.',
  })
  P.insufficientCause = await upsertProduct({
    name: 'Desktop PC', barcode: 'DEMO-INSUFF-CAUSE', quantity_on_hand: 3, reorder_threshold: 2,
    lending_interval: 'week_2', ...cat('Laptops & Computers'),
    image_slug: 'desktop-pc', description: 'Compact desktop PC with a quad-core processor, 16 GB RAM and a 512 GB SSD. Front ports: 2 x USB 3.2 and 1 x headphone/microphone combo jack. Rear ports: 1 x HDMI, 1 x DisplayPort, 1 x Gigabit Ethernet, 4 x USB 2.0 and 2 x audio jacks. Wi-Fi and Bluetooth are built in. Suited to labs and temporary workstations.',
  })
  P.insufficientNoCause = await upsertProduct({
    name: 'UPS Battery Backup 1500VA', barcode: 'DEMO-INSUFF-NOCAUSE', quantity_on_hand: 1, reorder_threshold: 3,
    lending_interval: 'week_2', ...cat('Power'),
    image_slug: 'ups-battery-backup', description: '1500VA / 900 W line-interactive UPS with automatic voltage regulation and a front LCD showing input, output, load and runtime. Eight outlets: four with battery backup and surge protection, four surge-only. Includes a USB port for monitoring software and RJ45 network surge protection. Keeps equipment running through load-shedding and short power cuts.',
  })
  P.onSchedule = await upsertProduct({
    name: 'Network Switch 8-Port', barcode: 'DEMO-ONSCHEDULE', quantity_on_hand: 10, reorder_threshold: 2,
    lending_interval: 'week_2', ...cat('Networking'),
    image_slug: 'network-switch', description: '8-port gigabit unmanaged Ethernet switch with 8 x 10/100/1000 RJ45 ports that auto-negotiate speed and cable type. Plug and play with no configuration, and LED indicators for link and activity on every port. Compact metal case with a fanless design, suited to desks, labs and small cabinets.',
  })
  P.noShowFeeder = await upsertProduct({
    name: 'Wireless Access Point', barcode: 'DEMO-NOSHOW', quantity_on_hand: 5, reorder_threshold: 2,
    lending_interval: 'week_1', ...cat('Networking'),
    image_slug: 'wireless-access-point', description: 'Ceiling- or wall-mount Wi-Fi 6 access point, dual-band up to 1.8 Gbps, supporting more than 100 connected devices. One Gigabit Ethernet port that is powered over PoE (802.3af), so no separate power adapter is needed. Supports multiple SSIDs, VLANs and band steering. Mounting bracket included.',
  })
  P.fulfilled = await upsertProduct({
    name: 'Mechanical Keyboard', barcode: 'DEMO-FULFILLED', quantity_on_hand: 10, reorder_threshold: 2,
    lending_interval: 'week_2', ...cat('Peripherals'),
    image_slug: 'mechanical-keyboard', description: 'Full-size mechanical keyboard with 104 keys including a numeric keypad. Tactile blue switches rated for 50 million keystrokes, with per-key backlighting and N-key rollover. Metal top plate with a removable cable and a USB-A connection. Compatible with Windows, macOS and Linux.',
  })
  P.returnNoDate = await upsertProduct({
    name: 'External Hard Drive 2TB', barcode: 'DEMO-RET-NODATE', quantity_on_hand: 20, reorder_threshold: 5,
    ...cat('Storage'), image_slug: 'external-hard-drive', description: 'Portable 2 TB external hard drive in a slim, shock-resistant case. Supports USB 3.0 (5 Gbps), with both a USB-A and a USB-C connection cable included. Powered over USB with no external adapter. Pre-formatted for Windows and also usable on macOS and Linux. Ideal for backups and moving large datasets.',
  })
  P.returnOverdue = await upsertProduct({
    name: 'Ultrabook Laptop 14-inch', barcode: 'DEMO-RET-OVERDUE', quantity_on_hand: 20, reorder_threshold: 5,
    ...cat('Laptops & Computers'), image_slug: 'business-laptop', description: 'Lightweight 14-inch ultrabook weighing about 1.3 kg, with a Full HD display, 16 GB RAM and a 512 GB SSD. Ports: 2 x USB-C (Thunderbolt 4), 1 x USB-A 3.2, 1 x HDMI 2.0 and a 3.5 mm audio jack. Up to 12 hours of battery life. Popular for conferences and fieldwork.',
  })
  P.returnDueToday = await upsertProduct({
    name: 'USB Flash Drive 64GB', barcode: 'DEMO-RET-DUETODAY', quantity_on_hand: 20, reorder_threshold: 5,
    ...cat('Storage'), image_slug: 'usb-flash-drive', description: '64 GB USB 3.0 flash drive with read speeds up to 120 MB/s. Retractable USB-A connector, so there is no cap to lose, and a loop for a lanyard or key ring. Compatible with Windows, macOS and Linux.',
  })
  P.returnNotDueYet = await upsertProduct({
    name: 'HDMI Cable 2m', barcode: 'DEMO-RET-NOTDUEYET', quantity_on_hand: 20, reorder_threshold: 5,
    ...cat('Cables & Adapters'), image_slug: 'hdmi-cable', description: 'High-speed HDMI 2.0 cable, 2 metres, with HDMI Type A male connectors at both ends. Supports 4K at 60 Hz, HDR and Ethernet channel, and carries up to 8 channels of audio. Gold-plated connectors and a shielded cable for a clean picture.',
  })
  P.returnPartlyResolved = await upsertProduct({
    name: '24-inch Monitor', barcode: 'DEMO-RET-PARTRESOLVED', quantity_on_hand: 20, reorder_threshold: 5,
    ...cat('Peripherals'), image_slug: 'monitor-27', description: '24-inch Full HD (1920 x 1080) IPS monitor with a 75 Hz refresh rate. Inputs: 1 x HDMI 1.4, 1 x VGA and a 3.5 mm audio output. Tilt-adjustable stand and a 75 x 75 mm VESA mount. Slim bezel design suited to lecture rooms and office desks.',
  })
  P.ioAdjustRestock = await upsertProduct({
    name: 'High-Yield Toner Cartridge (Black)', barcode: 'DEMO-RESTOCK', quantity_on_hand: 6, reorder_threshold: 3,
    ...cat('Consumables'), image_slug: 'toner-cartridge', description: 'High-yield black toner cartridge for shared monochrome laser printers, with a page yield of about 6,000 pages at 5 percent coverage. Includes a new drum interface and chip, and installs without tools. A better fit than the standard cartridge for busy printers.',
  })
  P.fullReturnPair = await upsertProduct({
    name: 'Compact Wireless Mouse', barcode: 'DEMO-FULLRETURN', quantity_on_hand: 20, reorder_threshold: 5,
    ...cat('Peripherals'), image_slug: 'wireless-mouse', description: 'Compact 2.4 GHz wireless mouse sized for laptop bags, with a nano USB-A receiver that stores in the battery bay. 1000 DPI optical sensor and a quiet-click scroll wheel. Runs on one AA battery for up to 18 months. Plug and play on Windows, macOS and Linux.',
  })
  P.partialReturnPair = await upsertProduct({
    name: 'Network Switch 24-Port', barcode: 'DEMO-PARTIALRETURN', quantity_on_hand: 20, reorder_threshold: 5,
    ...cat('Networking'), image_slug: 'network-switch', description: '24-port gigabit managed Ethernet switch with 24 x 10/100/1000 RJ45 ports and 2 x SFP uplink slots. Supports VLANs, QoS, link aggregation and port mirroring, configured through a web interface. Rack-mountable in a 19-inch rack (1U), with LED indicators on every port.',
  })

  // ---- Product audit log coverage: create / update -----------------------
  await writeAudit({
    userId: ADMIN_UID, userName: ADMIN_NAME, action: 'create', entityType: 'product', entityId: P.healthy.id,
    before: null,
    after: {
      category_id: categoryId['Peripherals'], name: P.healthy.name, description: P.healthy.description,
      barcodes: ['DEMO-HEALTHY'], quantity_on_hand: 25, reorder_threshold: 5, available: true, location: LOCATION,
      lend_from: addDays(TODAY, -365), lend_to: null, lending_interval: 'week_1', images: [],
    },
    createdAt: isoAt(-30),
  })
  await writeAudit({
    userId: ADMIN_UID, userName: ADMIN_NAME, action: 'update', entityType: 'product', entityId: P.insufficientCause.id,
    before: {
      name: P.insufficientCause.name, barcodes: ['DEMO-INSUFF-CAUSE'], category_id: categoryId['Laptops & Computers'],
      description: P.insufficientCause.description, quantity_on_hand: 5, reorder_threshold: 1,
      available: true, location: LOCATION, lend_from: addDays(TODAY, -365), lend_to: null, lending_interval: 'week_1', images: [],
    },
    after: {
      name: P.insufficientCause.name, barcodes: ['DEMO-INSUFF-CAUSE'], category_id: categoryId['Laptops & Computers'],
      description: P.insufficientCause.description, quantity_on_hand: 3, reorder_threshold: 2,
      available: true, location: LOCATION, lend_from: addDays(TODAY, -365), lend_to: null, lending_interval: 'week_2', images: [],
    },
    createdAt: isoAt(-21),
  })

  // ---- Bostik Glu Dots -- scanned in during the client demo on 29 September
  //      2026 (10:17), with its original create audit entry. Only the product
  //      is kept, none of that demo's transactions, so it has the 4 units it
  //      was created with. Created once; a re-run leaves it as it is.
  {
    const BOSTIK_BARCODE = '6001364000266'
    const BOSTIK_CREATED_AT = '2026-09-29T08:17:02.292Z'
    const bostik = {
      name: 'Bostik Glu Dots', barcodes: [BOSTIK_BARCODE], ...cat('Consumables'),
      description: 'Bostik Glu Dots', quantity_on_hand: 4, reorder_threshold: 1, available: false,
      location: LOCATION, lend_from: '2026-09-29', lend_to: null, lending_interval: 'week_1',
      updated_at: BOSTIK_CREATED_AT, created_at: BOSTIK_CREATED_AT, images: [],
    }
    const existing = await db.collection('products').where('barcodes', 'array-contains', BOSTIK_BARCODE).limit(1).get()
    if (existing.empty) {
      const ref = db.collection('products').doc()
      await ref.set(bostik)
      await writeAudit({
        userId: ADMIN_UID, userName: ADMIN_NAME, action: 'create', entityType: 'product', entityId: ref.id,
        before: null, after: bostik, createdAt: '2026-09-29T08:17:02.407Z',
      })
    }
  }

  // =====================================================================
  // 4. OUTSTANDING RETURNS (Dashboard tab) -- walk-in Stock Out activity,
  //    not tied to any loan request. Every badge variant, plus a Mixed
  //    holder with three at once.
  // =====================================================================
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

  // Two more walk-in stock-outs that are not due for a while, so Not Due Yet is
  // clearly the biggest group on the Dashboard (Overdue only a handful).
  await recordTxn({ type: 'OUT', staff: S.BadgeActive, items: [{ product: P.returnNotDueYet, quantity: 2 }], lendFrom: addDays(TODAY, -2), lendTo: addDays(TODAY, 8), dayOffset: -2 })
  await recordTxn({ type: 'OUT', staff: S.BadgeActive, items: [{ product: P.fullReturnPair, quantity: 1 }], lendFrom: addDays(TODAY, -1), lendTo: addDays(TODAY, 12), dayOffset: -1 })

  // =====================================================================
  // 5. REPORTS -- IN / RETURN / ADJUST activity, plus a full and a partial
  //    return (the partial one lands as an extra Overdue Outstanding
  //    Returns row for free, same as a real partial return would).
  // =====================================================================
  await recordTxn({ type: 'IN', items: [{ product: P.ioAdjustRestock, quantity: 15 }], notes: 'Quarterly restock from IT Store supplier.', dayOffset: -25 })
  await recordTxn({ type: 'IN', items: [{ product: P.monthInterval, quantity: 5 }], notes: 'Emergency restock -- approved via email.', dayOffset: -18 })
  await recordTxn({ type: 'ADJUST', direction: 1, items: [{ product: P.legacyNoInterval, quantity: 1 }], notes: 'Manual stock count correction -- found 1 extra unit during a physical audit.', dayOffset: -12 })



  // ---- Multi-item, multi-barcode Stock In / Stock Out / Return -------------
  // Every transaction here has more than one product, and each product has
  // more than one of its barcodes scanned. Returns reuse exactly the barcodes
  // the matching Stock Out was issued with (recordTxn enforces that).
  const kitIn = await recordTxn({
    type: 'IN',
    items: [
      { product: P.kitCable, quantity: 9, barcodes: ['DEMO-KITCABLE-A', 'DEMO-KITCABLE-B', 'DEMO-KITCABLE-C'] },
      { product: P.kitAdapter, quantity: 7, barcodes: ['DEMO-KITADAPTER-A', 'DEMO-KITADAPTER-B'] },
    ],
    notes: 'Delivery of cable + adapter kits -- several barcodes scanned per product.', dayOffset: -30,
  })
  // Full return: 2 products x 2-3 barcodes out, exactly the same barcodes back.
  const kitFullOut = await recordTxn({
    type: 'OUT', staff: S.MultiBarcodeFull,
    items: [
      { product: P.kitCable, quantity: 3, barcodes: ['DEMO-KITCABLE-A', 'DEMO-KITCABLE-B', 'DEMO-KITCABLE-C'] },
      { product: P.kitAdapter, quantity: 3, barcodes: ['DEMO-KITADAPTER-A', 'DEMO-KITADAPTER-B'] },
    ],
    lendFrom: addDays(TODAY, -14), lendTo: addDays(TODAY, -7), dayOffset: -14,
  })
  await recordTxn({
    type: 'RETURN', staff: S.MultiBarcodeFull,
    items: [
      { product: P.kitCable, quantity: 3, barcodes: ['DEMO-KITCABLE-A', 'DEMO-KITCABLE-B', 'DEMO-KITCABLE-C'] },
      { product: P.kitAdapter, quantity: 3, barcodes: ['DEMO-KITADAPTER-A', 'DEMO-KITADAPTER-B'] },
    ],
    returnDate: addDays(TODAY, -6), linkedTxnId: kitFullOut.id, notes: 'Everything back -- same barcodes as issued.', dayOffset: -6,
  })
  // Partial return: two products out, only some of the barcodes come back, so
  // the rest stay outstanding (due today) on the dashboard.
  const kitPartialOut = await recordTxn({
    type: 'OUT', staff: S.MultiBarcodePartial,
    items: [
      { product: P.kitCable, quantity: 3, barcodes: ['DEMO-KITCABLE-A', 'DEMO-KITCABLE-B', 'DEMO-KITCABLE-C'] },
      { product: P.kitAdapter, quantity: 2, barcodes: ['DEMO-KITADAPTER-A', 'DEMO-KITADAPTER-B'] },
    ],
    lendFrom: addDays(TODAY, -12), lendTo: TODAY, dayOffset: -12,
  })
  await recordTxn({
    type: 'RETURN', staff: S.MultiBarcodePartial,
    items: [
      { product: P.kitCable, quantity: 2, barcodes: ['DEMO-KITCABLE-A', 'DEMO-KITCABLE-B'] },
      { product: P.kitAdapter, quantity: 1, barcodes: ['DEMO-KITADAPTER-A'] },
    ],
    returnDate: addDays(TODAY, -3), linkedTxnId: kitPartialOut.id,
    notes: 'Cable A + B and Adapter A back -- Cable C and Adapter B still out.', dayOffset: -3,
  })
  void kitIn

  // ---- Lost-label scenario ---------------------------------------------------
  // The Lost Labels scenario (Ryan Fletcher) was issued 3 x 27-inch Monitor, all scanned
  // as DEMO-LOSTLABEL-A, so Returns shows ONE row: barcode A, issued 3,
  // returnable 3. Pretend two of the three labels have come off. To test:
  // The same row also holds 2 x HD Webcam (barcode DEMO-LOSTPAIR-A; -B is
  // its registered replacement barcode).
  //   1. Scan DEMO-LOSTLABEL-A once        -> row 1 / 3, + is still there
  //   2. Click +, enter DEMO-LOSTLABEL-B   -> row 2 / 3, + is still there
  //   3. Click +, enter DEMO-LOSTLABEL-B (or -C) again -> row 3 / 3, + gone
  // Also try: a barcode that isn't registered (rejected -- add it under
  // Products -> Edit first), the issued barcode A via + (rejected -- scan it),
  // and - to take units back off (relabelled ones come off last).
  await recordTxn({
    type: 'OUT', staff: S.LostLabels,
    items: [
      { product: P.lostLabel, quantity: 3, barcodes: ['DEMO-LOSTLABEL-A'] },
      { product: P.lostLabelPair, quantity: 2, barcodes: ['DEMO-LOSTPAIR-A'] },
    ],
    lendFrom: addDays(TODAY, -10), lendTo: addDays(TODAY, 5), dayOffset: -10,
    notes: 'Seed: 3 units issued under one barcode -- for testing lost-label returns.',
  })

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
    // more than a single transaction to expand and group for the Fulfilled Pickup scenario
    // Pickup: a multi-item pickup and a later single-item one. Both lines'
    // barcodes come from recordTxn's walk-in default now (the Wireless Mouse's
    // two, the Wi-Fi Router's one) -- quantity 2 on the Wireless Mouse simulates
    // both of its barcodes having been scanned once each.
    await recordTxn({
      type: 'OUT', staff: S.FulfilledPickup,
      items: [{ product: P.healthy, quantity: 2 }, { product: P.monthInterval, quantity: 2 }],
      lendFrom: addDays(TODAY, -20), lendTo: addDays(TODAY, 10), dayOffset: -20,
    })
    await recordTxn({
      type: 'OUT', staff: S.FulfilledPickup, items: [{ product: P.indefinite, quantity: 1 }],
      lendFrom: addDays(TODAY, -6), lendTo: null, dayOffset: -6,
    })
    // Edge case: a product carrying ten barcodes at once, to see how the
    // Issued per Staff report's expanded row handles a long list of them
    // under one product (wrapping, row height, etc.) rather than just two.
    // Quantity 10 to match -- ten distinct barcodes implies ten scans, so
    // ten units issued, not one (see spreadQuantity in recordTxn
    // above).
    await recordTxn({
      type: 'OUT', staff: S.FulfilledPickup, items: [{ product: P.manyBarcodes, quantity: 10 }],
      lendFrom: addDays(TODAY, -3), lendTo: addDays(TODAY, 4), dayOffset: -3,
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
  //    ONE staff member (S.PortalLinked / 47817909@mynwu.ac.za),
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
      fromDate: addDays(TODAY, -8), toDate: addDays(TODAY, 6),
      lines: [{ product: P.fulfilled, requested: 2, offered: 2 }],
      createdDayOffset: -15, updatedDayOffset: -8,
    })
    await writeLoanUpdate({ request: req, dayOffset: -10, before: { status: 'pending' }, after: { status: 'accepted' } })
    const fulfillTxn = await recordTxn({
      type: 'OUT', staff: S.PortalLinked, items: [{ product: P.fulfilled, quantity: 2 }],
      lendFrom: addDays(TODAY, -8), lendTo: addDays(TODAY, 6),
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
  console.log('Seeded the NWU demo data (seed:demo):\n')
  console.log('LOGINS:')
  console.log(`  BICS admin:      ${ADMIN_EMAIL} / password123               -> http://localhost:3000/login   (${ADMIN_NAME})`)
  console.log(`  Notifications:   administrator emails -> ${ADMIN_EMAIL}; sent from ${SYSTEM_FROM_EMAIL}`)
  console.log(`  Portal borrower: ${S.PortalLinked.email} / password123 -> http://localhost:3000/lend/login`)
  console.log('')
  console.log('DASHBOARD -> Outstanding Returns: No Date / Overdue / Due Today / Not Due Yet /')
  console.log('  Partly Resolved / Mixed holder / the Insufficient-cause overdue OUT. Mostly Not')
  console.log('  Due Yet, a few Due Today and No Return Date, and only a handful Overdue --')
  console.log('  expand any row to see its items.')
  console.log('')
  console.log('DASHBOARD -> Incoming Pickups: On Schedule, Insufficient (x2 -- one with an')
  console.log('  overdue "likely cause" bullet, one with the fallback "worth a stock check"')
  console.log('  message), and Not Picked Up (already recorded).')
  console.log('')
  console.log(`DASHBOARD -> Low Stock Alerts: "${P.lowStock.name}" (low) and "${P.outOfStock.name}" (out of stock).`)
  console.log('')
  console.log('LOAN REQUESTS: every status is represented -- expand any row on')
  console.log('  Needs Review / Sent Counters, and check History for accepted/fulfilled/')
  console.log('  declined/expired/no_show/withdrawn.')
  console.log('')
  console.log('MY REQUESTS (portal): sign in as the portal borrower above, then')
  console.log('  http://localhost:3000/lend/requests -- every tab (Needs your response,')
  console.log('  Awaiting Selouna, Upcoming, History) has several rows, and History alone')
  console.log('  has 12 -- past the 10-row page size, so its pagination footer has a real')
  console.log('  second page to click through.')
  console.log('')
  console.log('REPORTS: Stock Levels & Low Stock reflect the products above; Issued Per')
  console.log('  Staff and Transaction History include IN/OUT/RETURN/ADJUST activity across')
  console.log('  every staff member; Returns has a full and a partial return.')
  console.log('')
  console.log(`MULTI-BARCODE: ${S.MultiBarcodeFull.full_name} (fully returned) and ${S.MultiBarcodePartial.full_name} (partly) each have a`)
  console.log('  multi-product, multi-barcode Stock Out and a Return using exactly its barcodes;')
  console.log('  a matching multi-barcode Stock In sits in Transaction History / Audit Log.')
  console.log('')
  console.log(`LOST LABELS: Returns -> "${S.LostLabels.full_name}" has one row per product (3 x ${P.lostLabel.name},`)
  console.log(`  barcode DEMO-LOSTLABEL-A; 2 x ${P.lostLabelPair.name}, barcode DEMO-LOSTPAIR-A). Scan A once, then click + twice and enter`)
  console.log('  DEMO-LOSTLABEL-B / -C: every unit can be returned, lost labels included.')
  console.log('')
  console.log('BOSTIK GLU DOTS: the product scanned in during the client demo (barcode 6001364000266,')
  console.log('  4 in stock, not available for lending) with its create entry in the Audit Log.')
  console.log('')
  console.log('WHO IS WHO (each staff member demonstrates one scenario):')
  for (const [key, , , , department] of staffSpecs) {
    console.log(`  ${S[key].full_name.padEnd(20)} ${STAFF_SCENARIO[key]}`)
  }
  console.log('')
  console.log('PRODUCT IMAGES: every product above got 1-3 product photos (scripts/catalog-images)')
  console.log('  uploaded to the Storage emulator -- check Browse or the Products page.')
  console.log('')
  console.log("AUDIT LOG: filter by entity to see product/category/staff/transaction/")
  console.log('  loan_request coverage -- including the new decline-of-a-counter rich')
  console.log('  snapshot on "' + S.DeclinedCounterRich.full_name + '".')
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

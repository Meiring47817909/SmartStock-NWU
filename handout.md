# SmartStock-NWU: Firebase Migration Handout
**Date:** August 9, 2026
**Time:** 00:28 (SAST)

## Overview
This document details the complete migration of the NWU BICS (Basic Inventory Control System) application from Supabase to Firebase. The new application, named **SmartStock-NWU**, retains the original modern design aesthetics while being fully backed by Google Firebase for authentication and database services.

## Technical Details & Accomplishments

### 1. Project Initialization & Architecture
* **Framework:** Initialized a brand new Next.js 15 application utilizing the App Router.
* **Styling & UI:** Installed and configured Tailwind CSS along with `lucide-react` icons. All global styles, custom utility classes, and components (such as the Sidebar) were successfully ported over to match the exact premium visual design of the original system.
* **Firebase Integration:** Initialized the Firebase SDK. Set up the core configuration in `src/lib/firebase/config.ts` utilizing the `smartstock-nwu` Firebase project credentials.

### 2. Authentication Migration
* **Client-Side Auth:** Transitioned from Supabase's Server-Side Rendering (SSR) session management to Firebase Client-Side Authentication.
* **Auth Context:** Created a React `AuthContext` to manage the user's session globally. It securely listens to Firebase's `onAuthStateChanged` to supply the currently logged-in user to the application.
* **Route Protection:** Reconfigured the `(protected)` layout routing to properly guard pages. Unauthenticated users are strictly redirected to the `(auth)/login` page.
* **Login Flow:** Switched the login page out to use Firebase's `signInWithEmailAndPassword`.

### 3. Database Schema Re-architecture (PostgreSQL → NoSQL)
* **NoSQL Adaptation:** Transitioned from a highly relational PostgreSQL schema to a document-oriented Firestore NoSQL schema. 
* **Data Denormalization:** Addressed the "N+1 query problem" typical in NoSQL migrations by denormalizing related data. For example, instead of using cross-table joins, `staff_name`, `product_name`, and `product_sku` are now saved directly on the `transaction` documents when they are created. 
* **Embedded Arrays:** Moved away from linking separate `transaction_lines` tables. Transaction line items are now directly embedded as an array inside their parent `transaction` document, allowing the application to fetch entire records atomically in a single query.
* **TypeScript Types:** Thoroughly updated `src/types/database.ts` to reflect the new document structures and resolve casting errors.

### 4. Page & Feature Migrations
Every page in the application was refactored to interface strictly with Firebase Firestore:
* **Dashboard:** Modified to fetch total stock levels, transaction counts, and low stock items by pulling data directly from the `products` and `transactions` collections.
* **Products & Staff:** Refactored standard CRUD tables and forms. Replaced Supabase's PostgREST `ilike` filters with efficient client-side filtering on fetched Firestore collections for robust searching.
* **Stock In / Stock Out:** Fully rebuilt the logic for handling stock movements. These workflows now successfully process cart payloads, decrement/increment the `quantity_on_hand` in the `products` collection via `updateDoc`, and write permanent `transaction` records.
* **Returns:** Rebuilt the highly complex Returns mapping logic. It correctly fetches outstanding "OUT" transactions for specific staff members and subtracts quantities from their linked "RETURN" transactions natively on the client to calculate the correct returnable thresholds.
* **Reports:** Re-wrote all 5 multi-dimensional sub-reports (`StockLevelsReport`, `LowStockReport`, `IssuedPerStaffReport`, `ReturnsReport`, and `TransactionHistoryReport`) using Firebase queries and aggregation.

### 5. Seeding & Cleanup
* **Supabase Eradication:** Systematically scoured the codebase to uninstall and delete all residual Supabase dependencies, types, server routes, and helper configurations. The codebase is strictly Firebase-only.
* **Security Rules:** Supplied basic `firestore.rules` to lock down read and write operations to authenticated users only.
* **User Seeding:** Deployed a local automation script using Firebase Auth and Firestore to instantly create and configure the default users:
  * `admin@nwu.ac.za` -> Assigned **Admin** Role
  * `staff@nwu.ac.za` -> Assigned **Staff** Role

---

# Next Up: Product Lending Workflow
**Date:** August 15, 2026

## Context — what already exists
`Product` (see `src/types/database.ts`) already has `available: boolean`, `location: string`, and `lend_from: string | null` / `lend_to: string | null`. The lend dates are set by Selouna on the Add/Edit Product dialog (`src/app/(protected)/products/page.tsx`) and are **purely informational today** — nothing reads or enforces them yet. They're native `<input type="date">` values, so they're plain `YYYY-MM-DD` strings, not timestamps. `lend_from` is constrained to today-or-later in the picker; `lend_to` can't be before `lend_from`.

Note: the "Embedded Arrays" description in Section 3 above is **out of date**. `transaction_lines` is now a real Firestore collection (one document per line item, each carrying `transaction_id`, `product_id`, `quantity`, `product_name`, `created_at`), not an array embedded in the transaction document. Treat the code as the source of truth over that section.

Stock Out (`src/app/(protected)/stock-out/page.tsx`) is a 3-step wizard: `staff` → `items` → `confirm` (see the `Step` type and `STEPS`/`STEP_LABELS` near the top of the file). Staff are identified by card scan or manual search in step 1; step 2 builds a `cart: CartItem[]` via barcode scan (`lookupBarcode`, using the shared `findProductByBarcode` helper in `src/lib/firebase/products.ts`); step 3 (`handleConfirm`) writes one `transactions` doc plus one `transaction_lines` doc per cart item, and decrements `quantity_on_hand` on each product.

This feature ships in two stages. Do Stage A first — it's small, self-contained, and useful even before Stage B exists. Stage B depends on Stage A's data model.

## Stage A — Manual lend dates on Stock Out's Confirm step
Selouna needs to record a from/to date on the transaction itself when she hands equipment to a staff member who walked in and asked to borrow something (no online request involved).

1. **Type:** Add `lend_from: string | null` and `lend_to: string | null` to the `Transaction` interface in `src/types/database.ts`, same `YYYY-MM-DD` convention as `Product.lend_from`/`lend_to`.
2. **UI:** In the Confirm card (`step === 'confirm'` block, currently around line 333), add two `<Input type="date">` fields (From / To) above or below the items table. Make them optional — not every Stock Out is a loan (e.g. consumables that don't come back), so don't require them to proceed. Reuse the same "To can't be before From" guard used on the Product form (see `handleSave` in `products/page.tsx` for the pattern).
3. **State + save:** Add `lendFrom`/`lendTo` state, include them in `txnPayload` inside `handleConfirm` (currently around line 143), and reset them in the `reset()` function alongside the other step-reset state.
4. **Audit log:** `handleConfirm` already calls `logAudit(...)` — include the two new fields in the `after` snapshot passed there.

That's the whole of Stage A. No new collections, no new pages.

## Stage B — Staff self-service lending + Scan Items integration
Now let staff request a product online ahead of time, using the lend window Selouna already configured on the product, and have Stock Out surface that request when she serves them.

### 1. New collection: `loan_requests`
Add a `LoanRequest` type to `src/types/database.ts`:
```ts
export interface LoanRequest {
  id: string                 // Firestore document ID
  product_id: string
  product_name: string       // denormalized, same pattern used elsewhere in this app
  staff_id: string           // StaffMember document ID
  staff_name: string         // denormalized
  lend_from: string          // snapshot of Product.lend_from at request time
  lend_to: string            // snapshot of Product.lend_to at request time
  status: 'pending' | 'fulfilled' | 'cancelled'
  fulfilled_txn_id?: string  // set once Selouna actually checks it out
  created_at: string
}
```
Snapshot the product's dates onto the request rather than re-reading the live product later — if Selouna edits the product's window after a request was made, the original request shouldn't silently change.

### 2. Staff login — resolved auth model — **DONE, implemented on branch `Meiring`**
**Decision:** there is no self-service registration. A staff member registers in person at Selouna's office. She adds them via the existing "Add Staff Member" dialog, and separately provisions their login on demand via a "Send Login Email" row action. Only after they've followed that link and set a password can they log into the lending portal — there's no sign-up form anywhere in this app.

This was built as two independent, single-purpose actions rather than one combined "Add Staff" that also creates the Auth account — specifically to avoid a partial-failure/retry bug (a failure between a Firestore write and an Auth-account write would otherwise leave an orphaned Auth account, and retrying "Add Staff" would then fail with "email already in use" for a record Selouna believes she's never successfully added). If you're picking this branch up: this section is reference documentation for what already exists, not a spec to build from scratch — check it's still merged/intact before starting Stage B section 3.

**What was added, file by file:**

- **`src/types/database.ts`** — `StaffMember.uid: string | null`, the linked Firebase Auth UID (`null` until provisioned).
- **`src/lib/firebase/staff.ts`** (new, client-side) — `normalizeEmail(email)` (trim + lowercase — Firebase Auth treats email case-insensitively, so every comparison and every write needs to agree on this form); `findStaffEmailConflict(email, excludeId?)` (mirrors `findBarcodeConflict` in `src/lib/firebase/products.ts` — queries `staff` for an existing document with that email, excluding the record being edited); `postStaffAdmin<T>(path, user, body)` (attaches the caller's Firebase ID token as a Bearer header and throws with the server's error message on failure — the shared client-side entry point into the two API routes below).
- **`src/lib/server/staffAdmin.ts`** (new, server-only, `import 'server-only'`) — `ApiError` (status + message, thrown by the two routes and converted back into a `NextResponse.json` in their catch blocks); `requireAdmin(request)` (verifies the `Authorization: Bearer <idToken>` header via `adminAuth.verifyIdToken`, then checks the caller's `profiles` doc has `role === 'admin'` — matches `canManageStaff` in `RoleContext.tsx`, which was already admin-only by convention even though the Staff page UI itself doesn't gate on it); `findStaffDocOwningUid(uid, excludeStaffId?)` (the shared "does any staff doc already own this UID" query, used by both routes below).
- **`src/app/api/staff/send-reset-email/route.ts`** (new) — `POST { staffId }`. Implements the full decision tree: already-linked → resend to the linked account's current email (re-fetched via `adminAuth.getUser`, falling back to re-provisioning if that UID no longer exists in Auth); no account for this email → `adminAuth.createUser({ email })` with no password, link the new UID, send; account exists for this email → `findStaffDocOwningUid` first — a different staff record owning it is a **409 refusal**, naming the conflicting record, nothing gets sent; otherwise link (if not already) and send via the *client* SDK's `sendPasswordResetEmail` (imported from `@/lib/firebase/config` — Firebase only auto-sends its built-in email template through that call, not the Admin SDK's link-generation function, and the client SDK works fine inside a server route). Returns `{ linked, email, uid }`.
- **`src/app/api/staff/update-email/route.ts`** (new) — `POST { staffId, newEmail }`. Deliberately touches **only** Auth, never Firestore: `adminAuth.updateUser(uid, { email: newEmail })` on the *existing* linked account (same UID, never a second account, never a delete). Requires the record to already have a `uid` (400 if not — nothing to sync). Maps `auth/email-already-exists` → 409, `auth/invalid-email` → 400.
- **`src/app/(protected)/staff/page.tsx`** — `handleSave` now runs `findStaffEmailConflict` before every save (add or edit), and, when editing a record whose email actually changed and which already has a `uid`, calls `/api/staff/update-email` first and only proceeds to the Firestore `updateDoc` (which still includes the new email in the same payload as name/surname/department/card_uid) if that succeeds — so Firestore and Auth can never drift apart. New `sendLoginEmail(s)` function + a "Send Login Email" / "Resend Login Email" row button (disabled with a tooltip if the record has no email, disabled per-row while in flight via `sendingId` state), using `sonner`'s `toast` for success/error feedback (already wired up app-wide via `Toaster` in `layout.tsx`) rather than the page-level `error` banner, since this is a row action, not a form submission. The email line under each name now shows a small "· portal linked" indicator when `uid` is set.

**Not yet built / still open:** anything about the lending portal itself (section 3 below) — none of that exists yet, this section only covers provisioning the login.

#### Testing this locally with the Firebase emulators
Also set up on this branch — lets you exercise the whole flow (create account, send/resend, edit-email sync, both 409 conflict paths) against fake data, with **zero real emails ever sent** and **zero real Firebase credentials required**. All emulator wiring is opt-in — the normal `npm run dev` workflow against the real project is untouched unless you explicitly use the commands below.

How it works: `firebase.json` / `.firebaserc` configure Auth + Firestore + Storage emulators plus the Emulator UI, all under a fixed `demo-smartstock-nwu` project id (the `demo-` prefix means the emulators never touch real GCP — no billing, no real project needed at all). `src/lib/firebase/admin.ts` auto-detects the `FIREBASE_AUTH_EMULATOR_HOST`/`FIRESTORE_EMULATOR_HOST` env vars (Firebase's own convention) and initializes with just that project id instead of the real service-account cert. `src/lib/firebase/config.ts` does the client-side equivalent behind an explicit `NEXT_PUBLIC_USE_FIREBASE_EMULATORS=true` flag, calling `connectAuthEmulator`/`connectFirestoreEmulator`/`connectStorageEmulator` once per instance.

**Gotcha that cost real debugging time:** don't guard the "only connect once" logic with a boolean on `globalThis`. Next.js compiles page/SSR code and API-route code as *separate bundles*, each getting its own independent module instance of `config.ts` — so `auth` is a genuinely different object per bundle even though `globalThis` (the actual Node process global) is shared across all of them. A shared boolean flag means whichever bundle loads first "claims" the flag and logs success, while every other bundle's own `auth` instance silently never gets connected. This bit us for real: `send-reset-email/route.ts` calls the client SDK's `sendPasswordResetEmail` on its own bundle's `auth` instance, which never got connected — so it silently called the *real* Firebase project instead of the emulator. It didn't even throw: Firebase's email-enumeration protection makes `sendPasswordResetEmail` return success for an email that doesn't exist on the real project, so the API route reported "sent" while nothing ever showed up in `/oobCodes`. Fix: tag the "connected" flag onto the `auth`/`db`/`storage` instance itself (not `globalThis`), wrapped in try/catch to swallow the harmless "already connected" error from same-instance Fast Refresh re-evaluation.

**Run it (three terminals):**
1. `npm run emulators` — starts Auth/Firestore/Storage emulators + the UI at `http://127.0.0.1:4000`. Leave running.
2. `npm run seed:emulators` — one-off script (`scripts/seed-emulator.mjs`) that creates a test admin login (`admin@nwu.test` / `password123`, with a `profiles` doc so `requireAdmin` accepts it) and one `staff` record (`test.borrower@example.com`) with no `uid` yet, ready to click "Send Login Email" on.
3. `npm run dev:emulators` — same dev server as usual, just with the emulator env vars set (`cross-env` handles this cross-platform). Sign into the app with the seeded admin login, go to Staff, click "Send Login Email" on the seeded Test Borrower row.

**No real email is ever sent**, for any address — the Auth emulator intercepts `sendPasswordResetEmail` entirely. Grab the actual generated reset link either from the Emulator UI's Auth tab, or the emulator's REST endpoint: `GET http://127.0.0.1:9099/emulator/v1/projects/demo-smartstock-nwu/oobCodes` (lists every generated link with the email it targets).

To test the conflict paths, use the running app itself rather than the seed script: try adding a second staff member with `test.borrower@example.com` (should be blocked by `findStaffEmailConflict` before it ever reaches Auth), and try editing an already-linked staff member's email to one already used elsewhere (should hit `/api/staff/update-email`'s 409).

**All six of the following have been manually verified end-to-end against the emulators (2026-08-16) and pass:**
1. Duplicate email on Add — blocked client-side by `findStaffEmailConflict`, no request ever reaches Auth.
2. Duplicate email on Edit — same client-side block.
3. Auth email sync on Edit of an already-linked record — `/api/staff/update-email` fires, same UID's email changes in place (verified in the Auth emulator UI — no second account created), Firestore updates to match.
4. `update-email` 409 (`auth/email-already-exists`) — simulated by creating a "stray" account directly in the Auth emulator UI with an email no staff doc has, then editing a linked record's email to that exact address. `findStaffEmailConflict` passes (Firestore has no conflict), but the Admin SDK's `updateUser` call itself refuses; surfaces as a form error, Firestore stays unchanged.
5. `send-reset-email` 409 (cross-record UID conflict) — simulated by manually editing a *second* staff doc's `email` field directly in the Firestore emulator UI to match an already-linked record's email (bypassing the app's own uniqueness check, standing in for stale/manually-edited data), leaving its `uid` as `null`. Clicking "Send Login Email" on that second record correctly finds the existing Auth account, runs `findStaffDocOwningUid`, and refuses with a 409 naming the record that already owns it — nothing sent, `uid` stays `null`.
6. Re-provisioning after the linked Auth account is deleted — deleted a linked record's account directly in the Auth emulator UI (leaving a stale `uid` on the Firestore doc), then clicked "Resend Login Email". Correctly detected the missing account, created a new one, overwrote the stale `uid` with the new one, and sent — no error surfaced.

One gotcha: the client SDK's persistent Firestore cache is IndexedDB-backed and origin-scoped, so switching between `dev` (real project) and `dev:emulators` (fake project) in the *same browser* can show stale cached data from whichever you used last. Use a separate browser profile or incognito window for emulator testing to avoid this.

### 3. New staff-facing page (public lending portal)
A new route (e.g. `src/app/lend/page.tsx`, outside the `(protected)` layout) where a logged-in staff member — authenticated via the email + password they set through the flow above — sees products where `available === true`, both `lend_from`/`lend_to` are set, and `quantity_on_hand > 0`. Each product gets a "Lend this" button that creates a `loan_requests` doc as above, with `staff_id` resolved by querying `staff` for `where('uid', '==', auth.currentUser.uid)` — this is exactly what the `uid` field exists for.

Still decide before building: can a staff member have more than one pending request at once (same or different products), and should a request auto-expire/cancel itself once its `lend_to` date has passed unfulfilled? Neither is handled by this spec — add if needed.

### 4. Stock Out — surface requests in Scan Items
Once `staff` is set (end of step 1), query `loan_requests` where `staff_id == staff.id` and `status == 'pending'`. Show these as a list at the top of the Scan Items step (step 2), separate from the barcode-scan flow — keep barcode scanning working alongside it for walk-ins with no online request. Clicking a requested item adds it to `cart` the same way `lookupBarcode` does, but also needs to remember which `loan_requests` document it came from (e.g. track `cart: (CartItem & { loanRequestId?: string })[]`) so Confirm can use it.

### 5. Stock Out — prefill Confirm dates
When the cart contains items sourced from loan requests, prefill the From/To inputs added in Stage A from those requests instead of leaving them blank. If multiple requested items have different windows, decide how to reconcile (e.g. use the earliest `lend_from` and latest `lend_to` across them, or only prefill when all matched requests share the same window and leave it blank otherwise). Selouna can still edit the prefilled dates before confirming — the fields stay editable either way.

### 6. Stock Out — fulfill the request
Inside `handleConfirm`, after the transaction and its lines are written successfully, `updateDoc` each matched `loan_requests` doc to `status: 'fulfilled'`, `fulfilled_txn_id: txnRef.id`.

## Suggested build order
1. Stage A end-to-end (type, UI, save, audit log) — verify with `npm run build`.
2. Stage B data model (`LoanRequest` type + Firestore collection, no UI yet).
3. ~~Staff login provisioning~~ — **done** (section 2 above). Re-test the conflict/refusal paths after merging (duplicate email on add/edit, email sync failure, reset-email collision) before building anything that depends on it — don't just trust that it still works untouched.
4. Lending portal page, using the login flow from step 3.
5. Stock Out Scan Items integration.
6. Stock Out Confirm prefill + fulfillment write-back.
7. Full walkthrough test: staff logs in and submits a request → Selouna identifies that staff member in Stock Out → sees the requested item in Scan Items → dates prefill in Confirm → confirms → request flips to `fulfilled`.

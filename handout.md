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

## Stage A — Manual lend dates on Stock Out's Confirm step — **DONE**
Selouna needs to record a from/to date on the transaction itself when she hands equipment to a staff member who walked in and asked to borrow something (no online request involved).

**Built as:** `Transaction.lend_from`/`lend_to` (`string | null`, same `YYYY-MM-DD` convention as `Product.lend_from`/`lend_to`) added to `src/types/database.ts`. On the Confirm step in `stock-out/page.tsx`, two `<Input type="date">` fields sit between the items table and the Confirm/Back buttons — **Lend From defaults to today and stays editable** (`min` floored at today, same as the Product form's picker), **Lend To is required** (marked with `*`, `min` floored at Lend From, `required` on the input) — this is a deliberate change from the original spec below, which had both fields optional; Selouna decided every Stock Out needs a return date, not just loans. `lendFrom`/`lendTo` state is reset in `reset()` alongside the rest of the wizard state. `handleConfirm` guards against a missing or invalid Lend To before writing anything (`Select a return (To) date.` / `Return (To) date can't be before the From date.`), and the Confirm Issue button is disabled under the same conditions so the bad state is unreachable, not just rejected after the fact. Both fields are included in `txnPayload`, so they flow into `transactions` and — since `handleConfirm`'s `logAudit(...)` call spreads `...txnPayload` into `after` — into the audit log for free, no extra work needed there. `todayDateStr()` (the timezone-safe "today" helper, previously local to `products/page.tsx`) moved to the shared `@/lib/utils` so both pages use the same one.

<details>
<summary>Original spec (superseded by "Built as" above, kept for context)</summary>

1. **Type:** Add `lend_from: string | null` and `lend_to: string | null` to the `Transaction` interface in `src/types/database.ts`, same `YYYY-MM-DD` convention as `Product.lend_from`/`lend_to`.
2. **UI:** In the Confirm card (`step === 'confirm'` block, currently around line 333), add two `<Input type="date">` fields (From / To) above or below the items table. Make them optional — not every Stock Out is a loan (e.g. consumables that don't come back), so don't require them to proceed. Reuse the same "To can't be before From" guard used on the Product form (see `handleSave` in `products/page.tsx` for the pattern).
3. **State + save:** Add `lendFrom`/`lendTo` state, include them in `txnPayload` inside `handleConfirm` (currently around line 143), and reset them in the `reset()` function alongside the other step-reset state.
4. **Audit log:** `handleConfirm` already calls `logAudit(...)` — include the two new fields in the `after` snapshot passed there.

</details>

## Stage B — Staff self-service lending + Scan Items integration — **DONE**
Full negotiation-based lending portal: staff build a cart, pick one shared date range, Selouna reviews/counters/approves, staff accepts/declines, Stock Out fulfills. This ended up far more involved than the single-product `LoanRequest` sketch originally below (kept in the `<details>` block for history) — the actual design was worked out over several rounds of design review with the store manager before any code was written, captured in **`LENDING_PORTAL_SPEC.md`** (the spec, written first), then built by a second developer on branch `marco` and merged into `main`, with every deviation and bug fix recorded in **`LENDING_PORTAL_CHANGELOG.md`**. Read those two documents for the full detail — this section is a pointer + summary, not a duplicate.

**Built as:** `LoanRequest` (header: `staff_id`/`staff_name`, `status` — `pending → countered → accepted/declined`, plus terminal `expired`/`withdrawn`/`fulfilled`/`no_show` — `from_date`/`to_date` (mutable, Selouna's counter can change them), `original_from_date`/`original_to_date` (immutable snapshot, powers the staff-facing "dates changed" diff), `message`, `fulfilled_txn_id`) + `LoanRequestLine` (`requested_quantity` immutable / `offered_quantity` mutable — Selouna's counter edits this per line, 0 = dropped) as two real Firestore collections, same header-plus-lines shape as `transactions`/`transaction_lines`. `src/lib/firebase/loanRequests.ts` is the shared logic library everything else depends on: a live reservation ledger (`getReservedQuantity` — no stored counter, scans active requests and checks date-range overlap, same "never persist what can drift" philosophy as everything else in this app), cart validation against each product's own `lend_from`/`lend_to` window plus a 1-week max, and the expiry formula `min(updated_at + 7 days, from_date)` (capped at the request's own pickup date so a near-term request can't be kept "pending" past the point where fulfilling it would even make sense — the reasoning is spelled out as decision #5 in the spec).

New route group `src/app/(portal)/lend/` — a second, separate auth context (`StaffPortalContext`, resolving a `StaffMember` via `staff.uid`, not a BICS `Profile`) for staff to browse lendable products, build a cart, and manage their requests, entirely outside the `(protected)` BICS app. Selouna's side is `src/app/(protected)/loan-requests/page.tsx` (admin/manager, new `canManageLoanRequests` role gate) — a four-tab queue (Needs Review / Sent Counters / Incoming Pickups / History) with an inline line editor for countering. Stock Out (`stock-out/page.tsx`) now surfaces a staff member's accepted requests as selectable cards above the barcode scanner, prefills the Confirm step's dates from the request, and on confirm writes `linked_request_id` on the transaction and flips the request to `fulfilled` — walk-in barcode scans still work unchanged alongside it, and now show a non-blocking warning if they'd eat into stock already reserved by an active request.

**Real bug found and fixed along the way, worth knowing about if you touch auth:** the spec (§2.4) flagged a latent gap — `AuthContext.tsx` used to synthesize a fake `role: 'staff'` `Profile` for any Firebase Auth account with no `profiles/{uid}` doc, which is exactly what a portal-only borrower account looks like, meaning a borrower could accidentally sign into the real BICS app. Fixed by having `AuthContext` set `profile: null` instead, with `(protected)/layout.tsx` redirecting to `/login?error=no-profile`. A second, harder bug (`onAuthStateChanged` firing more than once during a single sign-in and leaving a stale `loading:false` next to a not-yet-updated `profile`, causing a spurious redirect flash) was found and fixed afterward — see changelog §15 for the full investigation, it's a good read if a similar "loading flag doesn't match the data next to it" bug ever shows up elsewhere.

**Deviations from this handout's original spec below**, both decided during implementation for the feature to actually work (documented in full in the changelog §17): Firestore rules for `loan_requests`/`loan_request_lines` had to be **read-open to any signed-in user**, not "own requests only" — the reservation ledger has to scan every active request across all borrowers for a product, not just the caller's own. And BICS `staff`-role till operators got a **narrow write right** (just the `accepted→fulfilled` transition Stock Out needs, plus the lazy expiry/no-show writes), not pure read-only, since `canManageStock` (which gates Stock Out) is true for every role. One post-build change at explicit request: login was unified into a single `/login` for both BICS operators and portal borrowers (one-shot post-auth lookup routes to `/dashboard` or `/lend`), so `LENDING_PORTAL_SPEC.md` §5.2's separate `/lend/login` page no longer reflects reality — that page was built, then deleted.

<details>
<summary>Original spec (superseded by "Built as" above and by <code>LENDING_PORTAL_SPEC.md</code>, kept for history)</summary>

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

</details>

## Suggested build order
1. ~~Stage A end-to-end (type, UI, save, audit log)~~ — **done**, see Stage A above (Lend To ended up required, not optional — read the "Built as" note, not the struck-through spec below it, before touching this code).
2. ~~Stage B data model~~ — **done**, see `LENDING_PORTAL_SPEC.md` §2 and the "Built as" note above (ended up as `LoanRequest`+`LoanRequestLine`, cart/negotiation-based, not the single-product sketch this list originally pointed at).
3. ~~Staff login provisioning~~ — **done** (section 2 above). Re-test the conflict/refusal paths after merging (duplicate email on add/edit, email sync failure, reset-email collision) before building anything that depends on it — don't just trust that it still works untouched.
4. ~~Lending portal page~~ — **done**, `src/app/(portal)/lend/` (Browse/Cart/My Requests), using the unified `/login` (see "Built as" above — the portal no longer has its own separate login page).
5. ~~Stock Out Scan Items integration~~ — **done**, accepted requests surface as selectable cards above the barcode scanner in `stock-out/page.tsx`.
6. ~~Stock Out Confirm prefill + fulfillment write-back~~ — **done**, same file — dates prefill from the request, confirm writes `linked_request_id` and flips the request to `fulfilled`.
7. ~~Full walkthrough test~~ — **done**, verified live against the local emulator: submit → approve → Stock Out fulfillment (quantity decrement, `linked_request_id`, audit trail all correct), and separately submit → counter → decline. See `LENDING_PORTAL_CHANGELOG.md` §18 for exactly what's been exercised live vs. only implemented-per-spec (expiry/no-show lazy transitions and withdraw haven't been clicked through yet, logic-only).

Stage B is complete. Anything further on the lending portal (e.g. exercising the not-yet-clicked-through paths in changelog §18, or reconciling `LENDING_PORTAL_SPEC.md` §5.2's now-stale separate-login description) is a follow-up, not a continuation of this build.

---

# Session Handoff — 7 September 2026
**For whoever (human or Claude) picks this project up next.** Everything below happened *after* `LENDING_PORTAL_CHANGELOG.md` was written (that document covers the other developer's initial build on branch `marco`, already merged into `main`). This section covers a long run of follow-up fixes, UX refinements, and emulator-testing tooling done directly on top of that merge, in a single continuous session. Read this whole section before touching the lending portal or the Products/Staff/Dashboard pages — several small behavior changes here aren't reflected anywhere else yet.

## ⚠️ Read this first: nothing below has been committed
Every change described in this section exists only as **uncommitted working-directory changes on top of `main`** — no commits, no branch, nothing pushed. Run `git status` before doing anything else. As of this writing, the real (non-whitespace) diff touches exactly these tracked files:

```
LENDING_PORTAL_SPEC.md
handout.md
package.json
scripts/seed-lending-portal.mjs
scripts/seed-products.mjs
src/app/(portal)/lend/cart/page.tsx
src/app/(portal)/lend/page.tsx
src/app/(protected)/dashboard/page.tsx
src/app/(protected)/products/page.tsx
src/app/(protected)/returns/page.tsx
src/app/(protected)/staff/page.tsx
src/app/(protected)/stock-out/page.tsx
src/components/products/ProductPreviewDialog.tsx
src/lib/firebase/loanRequests.ts
src/lib/utils.ts
```

Plus two new **untracked** files: `scripts/seed-staff-roster.mjs` and `scripts/cleanup-borrower-test-data.mjs`.

(`git status` on its own will also show nearly every other file in the repo as "modified" — that's a CRLF/LF line-ending artifact from the Windows checkout, not real content changes. Use `git diff -b` — the `-b` ignores whitespace — to see only the files that actually changed, which is the list above.)

**Do not commit any of this without asking the user first** — nothing in this session included an explicit "commit this" instruction, and the user has been driving commits themselves throughout this project.

## What changed this session, in detail

### 1. Staff page — Status badge now means "currently lending," not "active/inactive"
`src/app/(protected)/staff/page.tsx`. The Status column used to just mirror `is_active`. It now shows **Lending** (if the staff member has at least one OUT transaction line not yet fully returned) or **Active** (if not) — computed by a new `loadLendingStatus()` function using the same correctly-scoped issued-vs-returned logic as the Dashboard and Returns page (returns matched back to their specific originating OUT transaction via `linked_txn_id`, never a flat per-product total). The Deactivate/Activate button and the underlying `is_active` field are untouched — that's still a separate concept, just no longer what the badge displays.

### 2. Stock Out / Returns manual staff search — name + email, not department
`src/app/(protected)/stock-out/page.tsx` and `src/app/(protected)/returns/page.tsx`. The "Select Staff Member" modal's `loadStaffList` now filters on `full_name` and `email` (was `full_name` + `department` on Stock Out, `full_name` only on Returns — now consistent between the two). Each row also shows the email right next to the name (`Name Surname - email@domain`). Placeholder text on both search inputs changed to "Search name, email…".

### 3. Emulator seed scripts — categories, real staff roster, fixed location, cleanup
Four separate changes, all emulator-only (never touch the real Firebase project):

- **Categories were never seeded.** `scripts/seed-products.mjs` now seeds all 7 real categories (Cables & Adapters, Consumables, Laptops & Computers, Networking, Peripherals, Power, Storage — exact names/descriptions from a screenshot the user provided of the real category list) via a new `upsertCategory()` helper, *before* seeding products, and assigns each seeded product's `category_id` accordingly. `scripts/seed-lending-portal.mjs`'s Test Projector product got the same treatment (its own small `upsertCategory` call, just for the one category it needs).
  **Open question, not yet confirmed by the user:** neither seed script's projector product (Epson EB-108 Projector, Test Projector) has a clean category fit — there's no AV/presentation category in the real list. Both were mapped to **Peripherals** as the closest analog ("monitors" ≈ a projector's display function). Flag this to the user if it comes up again; it was a judgment call, not a confirmed decision.
- **Fixed product location.** Both seed scripts now write `location: "NWU - Potchefstroom, Building G4, Room 28"` on every seeded product (was per-product placeholders like `"Cage B, Shelf 2"`).
- **New file `scripts/seed-staff-roster.mjs`**, wired as `npm run seed:staff`. Seeds 20 real Computer Science and Information Systems staff members (name/surname/email given directly by the user) into the `staff` collection, upserted by email. All get `department: "Computer Science and Information Systems"`, `is_active: true`, `card_uid: null`, `uid: null` — a clean starting state, same as a freshly-added real staff member, so card-linking and "Send Login Email" can be exercised per person from scratch.
- **New file `scripts/cleanup-borrower-test-data.mjs`**, wired as `npm run cleanup:borrower-test`. One-off cleanup for the seeded "Portal Borrower" test account's loan-request test data — deletes the `loan_requests` doc(s), their `loan_request_lines`, and (if the request had gone as far as Stock Out fulfillment) the fulfilling `transactions`/`transaction_lines` doc and restores the `quantity_on_hand` it had decremented. Safe to re-run.

### 4. Products page — Availability now has real guardrails
`src/app/(protected)/products/page.tsx`, Add/Edit Product dialog:

- **New product default:** Availability now defaults to **Unavailable** on Add (was Available). Editing an existing product still shows whatever its actual saved value is — this only changes the blank-form default.
- **Qty On Hand = 0 forces Unavailable.** Dropping Qty to 0 immediately flips Availability to Unavailable, and the "Available" dropdown option is disabled (with a hint explaining why) until Qty is above 0 again.
- **No Lend From date also forces Unavailable**, same treatment — added this session at explicit user request, stacked on top of the Qty rule (both conditions gate "Available"; the hint text names whichever one, or both, are blocking it).
- **Clearing Lend From also clears Lend To** (can't leave a To date with nothing to be "after").
- **Lend To is now `disabled` until Lend From has a value**, with a small hint underneath ("Set a Lend From date first.").

  **⚠️ Worth double-checking with the user:** the Lend-From-required rule for Availability applies to *every* product, including ones never meant for the portal at all — e.g. the seeded HDMI Cable and Logitech Mouse, which by design have no lend window (`lendable: false` in the seed spec) but are still perfectly normal walk-in-issuable, "Available" stock. As implemented, those products can now *never* be marked Available again unless someone also gives them a Lend From date, even though they were never meant to be portal-lendable. This was implemented exactly as the user asked, but the interaction with non-portal products wasn't explicitly discussed — surface it if it causes confusion (e.g. "why can't I mark this cable Available").

### 5. Portal lending eligibility — `lend_to` is now optional ("indefinite"), not required
This is the biggest semantic change this session, and it **contradicts what `LENDING_PORTAL_SPEC.md` and the original marco-branch build shipped** (both required `lend_from` *and* `lend_to` for a product to be portal-eligible). The user pointed out that a product with a Lend From set but no Lend To (e.g. the Logitech Mouse, once given a Lend From) should still show up on the portal — an unset Lend To should mean "lendable indefinitely, no end date decided yet," not "not lendable."

Changed:
- `src/app/(portal)/lend/page.tsx` — Browse page eligibility filter now only requires `lend_from` + stock > 0. `lend_to` is no longer checked.
- `src/lib/firebase/loanRequests.ts` — `validateCartDates` now only requires `product.lend_from` to exist (still errors if missing — "isn't set up for portal lending"), and only checks the upper-bound (`toDate > product.lend_to`) when `product.lend_to` is actually set. The **1-week max loan length per request is untouched** — this only affects whether the *product* stays eligible over time, not how long any single request can run.
- New shared helper `formatLendWindow(from, to)` in `src/lib/utils.ts` — returns `"27 Aug 2026 – no end date"` when only `from` is set, the normal range when both are set, or `"—"` when neither is set. Used in three places now: the Browse page card, the shared `ProductPreviewDialog` component (admin Products page + portal Browse, since they share this dialog), and a **new "Lendable" column added to the Cart page's item table** (`src/app/(portal)/lend/cart/page.tsx`) — added specifically so a borrower doesn't have to go back to Browse to check a product's window while filling out their cart.

**`LENDING_PORTAL_SPEC.md` is now stale on this point** (its §3.2 description of `validateCartDates` still says both fields are required) — not yet corrected, unlike the earlier `/lend/login` staleness fix in §5.2. Worth fixing next time that file is touched.

### 6. Dashboard — new "Incoming Pickups" card, plus a real no-show bug fix
`src/app/(protected)/dashboard/page.tsx`. The "Outstanding Loan Requests" row is now a 2-column grid (was full-width 1-column) with a new **Incoming Pickups** card to its right: accepted loan requests, sorted by soonest pickup (`from_date`), columns Staff / Items / Pickup Window / Status (an "On Schedule" or "Possible No-show" badge, via `isNoShowCandidate`).

Building this surfaced a real bug: the Dashboard's lazy expiry/no-show transition pass (the "check on read, write the transition right then" pattern used everywhere in this app instead of a cron job) previously only ran for requests with status `pending` or `countered` — **never** `accepted`. Only `loan-requests/page.tsx` (Selouna's queue) actually flipped a stale `accepted` request to `no_show` when its pickup date passed. That meant a no-show would sit as `accepted` indefinitely unless someone specifically opened that one page — and an `accepted` request still counts as reserved stock (`getReservedQuantity` sums `pending`/`countered`/`accepted`), so a real no-show could silently make a product look less available than it actually was, for as long as nobody visited that page. Fixed by extending the Dashboard's same transition loop to also cover `accepted` requests, matching the queue page. Loading the Dashboard (presumably visited far more than the queue page) is now enough on its own to catch and clean up a no-show.

### 7. Things explained this session with no code change (still worth knowing)
- **Turbopack stale dev-cache errors** (e.g. `todayDateStr is not a function` at runtime despite `tsc` passing clean) after a lot of file changes land — fix is `rm -rf .next` + restart the dev server, not a code bug. `.next/` is already gitignored (was from project init), so this was never a git problem.
- **Cross-tab Firebase Auth errors** (`FirebaseError: false for 'get'`) when testing the BICS admin and a portal borrower in two tabs of the same browser at once: expected behavior, not a bug. Firebase Auth persists one session per browser *origin*, shared across every tab — signing into a second tab as a different account silently replaces the first tab's session too. Test both roles with two separate browser contexts (incognito + normal window, or two profiles), not two tabs.
- Before this session's point-5 change, only 4 of the 7 seeded products showed on the portal Browse page (Dell Latitude, Epson Projector, Poly Studio Camera, Test Projector) — the other 3 (HDMI Cable, Logitech Mouse, a manually-created "My product") were correctly excluded for legitimate reasons (no lend window at all, or zero stock), not a bug.
- Real BICS login credentials (`admin@nwu.ac.za` / `staff@nwu.ac.za`, mentioned in the very first section of this handout) are **not recorded anywhere in this repo** — Firebase Auth never stores plaintext passwords, and there's no real-project seed script (only the emulator ones, which have their own separate fake test accounts like `admin@nwu.test`/`password123`). If real access is needed, the user resets it via the Firebase Console.

## Still open — nothing here has been done yet
- **Firestore rules deployment status is unverified.** `firestore.rules` is a real, fairly detailed file now (see `LENDING_PORTAL_CHANGELOG.md` §2), but it's only ever been exercised against the local emulator in everything documented so far. Check whether `firebase deploy --only firestore:rules` has actually been run against the real project before assuming production is protected by it.
- `LENDING_PORTAL_SPEC.md` §3.2 needs the same kind of staleness fix its §5.2 already got — it still describes `lend_to` as required (see point 5 above).
- The Availability/Lend-From coupling (point 4) may need revisiting for non-portal products — not yet raised with the user as a potential problem, just flagged here.
- The category mapping for both projector products (point 3) is an unconfirmed judgment call, not a user-approved decision.
- Everything listed as "not yet exercised live" in `LENDING_PORTAL_CHANGELOG.md` §18 is still true as of this session: expiry lazy-transition on an actually-elapsed request, withdraw at any of its three stages, cart rejection for two products with non-overlapping lend windows, and the "neither BICS nor portal" branch of the unified `/login` (code-review-verified only).
- Nothing in this section has been committed (see the warning at the top).

## Quick orientation notes for a fresh agent
- Build/verify workflow: `npx tsc --noEmit -p tsconfig.json` in a sandbox copy is the fast, reliable check used throughout — `npx next build` will fail in a sandbox with no real Firebase Admin/client credentials (missing-env-var errors on `/api/staff/*` and `/api/auth/cas/validate`), that's an environment limitation, not a code problem.
- Key docs, in order of how specific they are: `LENDING_PORTAL_SPEC.md` (original design spec, written before any code), `LENDING_PORTAL_CHANGELOG.md` (what the other developer actually built on branch `marco`, plus their own bug fixes), this "Session Handoff" section (everything since). When they conflict, the changelog and this section win — the spec is the design intent, not necessarily the shipped behavior.
- Emulator workflow is unchanged from Stage B's original documentation above — `npm run emulators`, then any combination of `npm run seed:emulators` / `seed:lending` / `seed:products` / `seed:staff` in a second terminal, then `npm run dev:emulators`. All are safe to re-run and never touch the real project.

---

# Session Handoff — 19 September 2026

**Read this before touching auth, the Dashboard, Stock Out or the Staff page.** Two changes landed in one session. The second one **changes the security model**, which makes parts of `LENDING_PORTAL_SPEC.md` and `LENDING_PORTAL_CHANGELOG.md` actively wrong rather than merely stale — see "Documents this invalidates" at the end.

## 1. Open-ended loans, and resolving them

**Lend To on Stock Out is now optional.** Blank means no return date was agreed. `Transaction.lend_to` is written as `null`.

Three date comparisons had to be guarded when this changed: `''` sorts *before* any `YYYY-MM-DD` string, so an unguarded `lendTo < lendFrom` reads a blank value as "before the from date". They were previously shielded by a `!lendTo` check that had to go. If you add a fourth comparison, guard it.

The walk-in reservation-conflict check (`getReservedQuantity`) used to be skipped entirely when there was no Lend To. It now runs with `OPEN_ENDED_TO = '9999-12-31'` as the upper bound, because an open-ended issue overlaps *every* future reservation — that's the case most worth warning about, not least. The warning text differs for the two cases.

Fulfilling an accepted loan request with a blanked Lend To shows an alert first: the request agreed a `to_date` and clearing it overrides what the borrower accepted.

**Dashboard → Outstanding Returns has a Resolve button** (admin only) for writing off a line Selouna has agreed the staff member keeps.

The important design point: `transactions` and `transaction_lines` are `allow update, delete: if false`, and that immutability is load-bearing — "outstanding" is never stored, it's replayed from the ledger as issued − returned. So Resolve does **not** flag the OUT line. It appends to a new `return_waivers` collection (`src/lib/firebase/waivers.ts`), which is subtracted as a third term in exactly the places returns are:

- `(protected)/dashboard/page.tsx` — drops the row
- `(protected)/returns/page.tsx` — a written-off line is no longer returnable
- `(protected)/staff/page.tsx` — feeds the Lending badge and the expanded row
- `(protected)/reports/page.tsx` — Partial rows no longer claim a resolved balance

Waivers are append-only too. **There is no undo in the app** — reversing one means deleting the doc in the Firebase Console. A waiver never touches `quantity_on_hand`: the stock left the shelf at issue and isn't coming back, so on-hand is already correct.

`ReturnWaiver.reason` exists in the schema and is always `null` — no note UI was built.

**Staff rows are expandable**, showing Product / Qty / Expected / Status for everything that person holds — the same columns as Outstanding Returns, minus Staff. Written-off items stay listed here marked **No Return Due**; this list is deliberately the record that replaces Selouna writing the item down somewhere. It reuses the single data pass `loadLendingStatus()` already made, so expanding costs no extra reads.

Judgment call worth revisiting: the **Lending** badge clears once a person's only remaining items are waived (nothing left to chase), even though they physically still hold them.

`outstandingStatus(null)` used to return `null`, rendering an empty Status cell. It now returns **No Return Date**. Legacy pre-Stage A loans already had `lend_to: null`, so a batch of old rows suddenly became labelled and resolvable.

## 2. The manager role is gone

`Role` is now **`'admin' | 'staff'`**, and the two mean:

- **admin** — every BICS page. The whole `(protected)` tree.
- **staff** — the lending portal at `/lend`, and nothing else. No BICS access of any kind.

There are no till operators any more. Stock Out, Stock In, Returns and the Dashboard were previously reachable by every BICS role; they are all admin-only now.

**The single BICS gate is "is this profile role admin".** A portal borrower normally has no `profiles/{uid}` doc at all (identified by a `staff` record whose `uid` matches — `StaffPortalContext`). A profiles doc carrying role `'staff'` is treated identically: portal only. Both cases are one check.

What changed, file by file:

- `types/database.ts` — `Role` union narrowed.
- `context/RoleContext.tsx` — `isManager` removed; every capability flag is now `isAdmin`. The flags were kept as separate named booleans rather than collapsed into an `isAdmin` check at each call site, so re-introducing a middle role later is one edit here. This is defense in depth, not the primary gate.
- `(protected)/layout.tsx` — the `ADMIN_ONLY` / `MANAGER_PLUS` route arrays are gone; there's nothing left to differentiate. A non-admin is redirected to `/lend`, **not** to `/login?error=no-profile` as before — the portal's own "your account isn't linked" dead-end screen is a far clearer answer than a login-page error string.
- `(auth)/login/page.tsx` — `routeSignedInUser` sends a profile-holder to `/dashboard` only if the role is `admin`; anything else falls through to the staff-record lookup. Without this the user sees a visible flash of the BICS shell before the layout bounces them.
- `(auth)/cas-callback/page.tsx` — routes on the role the API returned instead of always pushing `/dashboard`.
- `api/auth/cas/validate/route.ts` — an allowlist entry with no explicit role still defaults to `'staff'`, which now means portal-only. **Granting BICS is therefore a deliberate act: someone has to put `role: 'admin'` on the `cas_allowlist` doc.**
- `components/layout/Sidebar.tsx` — manager badge colour removed.
- `firestore.rules` — no `'manager'` anywhere. Every BICS collection is `hasBicsRole(['admin'])`. Two narrow staff-role clauses were **deleted**, not narrowed: the `products` update limited to `quantity_on_hand`/`updated_at` (Stock Out's decrement — admin has full update anyway), and the `loan_requests` block granting till operators the `accepted → fulfilled` transition plus lazy expire/no-show. Both existed only to serve a role that no longer has any pages.

`hasBicsRole(roles)` was kept as a roles-list helper rather than reduced to a bare `isAdmin()`, so restoring a middle role is a change to call sites, not to the shape of every rule.

### Consequences to be aware of

**Existing accounts with role `'staff'` or `'manager'` lose BICS access.** This was a deliberate decision, not an oversight. That includes `staff@nwu.ac.za` from the original seed (§"User Seeding" at the top of this document). Such an account has no linked `staff` record, so it reaches neither BICS nor the portal — it is signed out at login with "This account isn't set up for BICS or portal access". If someone is actually using it, set `role: 'admin'` on its profiles doc in the Console, or link it to a staff record.

**`firestore.rules` must be redeployed.** The emulator picks the file up automatically; the real project needs `firebase deploy --only firestore:rules`. Note the open item below — production rules deployment has never been verified, and these rules are now the *only* thing stopping a portal borrower from reading BICS data directly.

`/login?error=no-profile` is now unreachable — nothing pushes it. The handler was left in place as a harmless fallback.

## Documents this invalidates

`LENDING_PORTAL_SPEC.md` §2.4, §3.2, §5.2 and its permissions tables, and `LENDING_PORTAL_CHANGELOG.md` §2's rules table, §4, and deviation #2 in §17, all describe the three-role model and the till-operator write clauses. **They are wrong now, not just imprecise.** Nothing was rewritten in either file — the convention in "Quick orientation notes" is that this section wins, but a reader who starts from the spec will build on a security model that no longer exists. Worth a proper reconciliation pass.

## State at handoff

`npx tsc --noEmit -p tsconfig.json` passes clean. ESLint introduces no new problem classes (the pre-existing `catch (err: any)` and setState-in-effect warnings are untouched).

**Nothing in either change has been clicked through against the emulator** — it wasn't running during this session. Everything above is code-review-and-typecheck verified only. Start there: `npm run emulators` picks up the new rules automatically, and both seeded logins are role `admin`, so they still work.

---

# Session Handoff — 19 September 2026 (part 2)

## Emulator seed: the portal borrower now has a password

`npm run seed:emulators` changed. `test.borrower@example.com` gets a real Auth account with **password123**, and its `staff` doc is linked via `uid`, so you can sign straight into `/lend` as a borrower. That matters more than it used to: since the two-role change, that account is the only way to exercise what a non-admin can actually do.

Its uid is `seed-test-borrower`, deliberately **not** `seed-borrower` — `seed-lending-portal.mjs` already claims that one for `borrower@nwu.test`, and `createUser()` with an existing uid throws `auth/uid-already-exists`. Both scripts are meant to run against the same emulator, so don't let those collide.

Linking `test.borrower` means clicking "Send Login Email" on that row now takes the **resend** branch, not the create branch. So the seed also writes a second record, `new.borrower@example.com` (`seed-staff-2`, no account, `uid: null`), which is now the one to click for the create-account-and-send path. Without it, that path became untestable from a clean state.

`npm run seed:staff` is unchanged — the 20 CS roster members still seed with `uid: null`.

Three emulator logins now:

| Account | Password | Lands on |
|---|---|---|
| `admin@nwu.test` | password123 | `/dashboard` — full BICS |
| `test.borrower@example.com` | password123 | `/lend` — portal only |
| `borrower@nwu.test` (from `seed:lending`) | password123 | `/lend` — portal only |

## The PWA is gone

Removed entirely, at the user's request. **Deleted:** `src/app/sw.ts`, `src/app/manifest.ts`, `serwist.config.js`, `public/sw.js`, `public/sw.js.map`, `src/context/InstallPromptContext.tsx`, `src/components/layout/InstallAppButton.tsx`, `src/components/layout/OfflineBanner.tsx`, `src/hooks/useOnlineStatus.ts`.

**Changed:**

- `src/app/layout.tsx` — `SerwistProvider` and `InstallPromptProvider` unwrapped; `appleWebApp` metadata dropped. The icons under `public/icons/` are kept and are now plain favicons.
- `src/app/(protected)/layout.tsx` — the "You're offline" blocking screen and the reconnect banner are both gone. Note the blocking screen was already dead code: its condition was `!isOnline && !isAdmin`, and since the two-role change every user in that tree is an admin.
- `src/context/RoleContext.tsx` — `canWorkOffline` removed. It existed only to drive that gate.
- `src/components/layout/Sidebar.tsx` — install button removed.
- `next.config.ts` — the Serwist/Turbopack note is gone; the config is now empty.
- `tsconfig.json` — dropped `"types": ["@serwist/next/typings"]`, the `"webworker"` lib entry (both existed only for `sw.ts`'s service-worker globals) and the `public/sw.js` exclude. Worth knowing: `tsc` kept passing while `@serwist/next` was still in `node_modules` and only failed once `npm install` actually pruned it — so a typecheck run before the prune is not proof this is clean.
- `package.json` — `dev` is plain `next dev`, `build` is plain `next build`, and `dev:emulators` no longer wraps anything in `concurrently`. Dependencies `@serwist/next`, `serwist`, `@serwist/cli` and `concurrently` removed (`concurrently` existed only to run the service-worker build alongside `next dev`). `cross-env` stays — `dev:emulators` still needs it.

### One deliberate non-removal

`src/lib/firebase/config.ts` still configures Firestore's **persistent local cache** (`persistentMultipleTabManager`). That's Firestore's own IndexedDB cache, not part of the PWA, and it still helps read performance. But be aware of what it no longer does: with the service worker gone, the app shell won't load without a network, so the cached data behind it is unreachable anyway. **The app is now online-only in practice.** If you want that cache gone too, it's a separate, deliberate change.

The IndexedDB-cache gotcha from the earlier handoff still applies: it's origin-scoped, so switching between `dev` and `dev:emulators` in the same browser can show stale data from whichever you used last. Use a separate profile or an incognito window.

### After pulling this

Run `npm install` to prune the removed packages. Browsers that already installed the PWA will keep a registered service worker until it's unregistered — during testing, use a hard reload or clear site data, or the old worker may keep serving a cached shell.

## State at handoff

`npx tsc --noEmit` passes clean. Still **not click-tested against the emulator** — that's the next step, and the user's stated plan is to verify everything on the emulator before running `firebase deploy --only firestore:rules` against the real project.

## Session Handoff — 2026-09-19: single-tab-lock removed, Lend To alignment fix, Staff-page Resolve, seed:outstanding

### Single-tab lock removed

Deleted entirely, at the user's request ("Remove the 1 tab restriction delete the functionality"):

- `src/hooks/useSingleTabLock.ts`
- `src/components/layout/TabConflictScreen.tsx`

`src/app/(protected)/layout.tsx` no longer imports or calls either. Confirmed via grep that no other file references them. Opening the app in multiple tabs now just works in every tab; there is no more "Already open elsewhere" screen.

### Lend From / Lend To alignment bug — root cause, not caching

The user reported the Lend From / Lend To fields on Stock Out (and later Add Product) were visually misaligned — repeatedly, even after restarting the dev server, deleting `.next`, rebuilding, and disabling browser cache. It was **not** a caching issue. The actual cause:

- The two fields sit in a `grid-cols-2` row. Default `align-items: stretch` stretches the *shorter* column's cell to match the taller one when the two columns don't have the same number of internal rows (e.g. one has an extra helper line or Clear button, the other doesn't).
- `Label` (`src/components/ui/label.tsx`) is styled `flex items-center …`, so when its wrapping cell gets stretched taller than its own content, the label text visually sinks toward the middle of the stretched cell instead of staying flush with the input above it.

Fix: add `items-start` to the **outer** grid container so cells size to their own content instead of stretching. Applied in two places:

- `src/app/(protected)/stock-out/page.tsx` — `<div className="mb-4 grid grid-cols-2 items-start gap-3">`
- `src/app/(protected)/products/page.tsx` (Add/Edit Product dialog, Lend From/Lend To row only — the Name/Category/Qty/Threshold/Availability grid above it was checked and doesn't have this bug, so it was left alone) — `<div className="grid grid-cols-2 items-start gap-3">`

If a similar "still misaligned after every cache-clearing trick" report comes up elsewhere, check for this same stretch interaction before assuming it's a build/cache problem.

### Add Product: Clear button for Lend To

Same UX as Stock Out's existing Clear button, added to the Add/Edit Product dialog so a product can be marked as available indefinitely (no end date) without retyping the Lend From date. Shown only once both `lend_from` and `lend_to` are set (so it doesn't collide with the pre-existing "Set a Lend From date first" message):

```jsx
{form.lend_from && form.lend_to && (
  <div className="flex items-center justify-between gap-2">
    <p className="text-xs text-muted-foreground">
      Clear this if the item is always available for future lending
    </p>
    <button type="button" onClick={() => setForm((f) => ({ ...f, lend_to: "" }))} className="shrink-0 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground">
      Clear
    </button>
  </div>
)}
```

Clearing Lend To does **not** turn off Availability — that only depends on `lend_from`.

### Staff page: Resolve button on expanded lending rows

The Dashboard's Outstanding Returns table already had a "Resolve" button on every row (admin-only), which writes an append-only `return_waivers` doc via `createReturnWaiver()` (see `src/lib/firebase/waivers.ts`) — it never touches `quantity_on_hand`, it just excludes that quantity from future outstanding-balance calculations everywhere they're computed (Dashboard, Returns, Staff, Reports).

The user asked for the same thing on the Staff page's expandable "currently lent" rows, so it's not just visible on the Dashboard's top-N list. Added in `src/app/(protected)/staff/page.tsx`:

- `LentItem` now carries `txn_id` and `product_id` (needed to call `createReturnWaiver`) alongside the existing `product_name`, `qty`, `expected_date`, `waived`.
- New state: `resolving: { staffId, staffName, item } | null`, `resolveBusy`.
- Each expanded row that isn't already waived gets its own `isAdmin`-gated Resolve button, mirroring the Dashboard's.
- Confirming opens the same style of warning dialog as the Dashboard's (append-only, no stock restored, will show "No Return Due" afterward), then calls `createReturnWaiver()` and reloads that staff member's lending status.

Typechecks clean (`npx tsc --noEmit -p tsconfig.json` → exit 0). **Not yet click-tested against the emulator** — see the new seed script below, which exists specifically to make this testable.

### New: `npm run seed:outstanding`

`scripts/seed-outstanding.mjs` — seeds the emulators with OUT transactions covering every state the Dashboard's Resolve flow and the Staff page's expandable rows need:

| Staff (search "Seed Outstanding") | Scenario |
|---|---|
| — No Date | Single item, no Lend To at all → "No Return Date" badge, Resolve visible |
| — Overdue | Lend To 3 days ago → "Overdue" badge, Resolve visible |
| — Due Today | Lend To = today → "Due Today" badge, Resolve visible |
| — Not Due Yet | Lend To 14 days out → "Not Due Yet" badge, Resolve visible |
| — Partly Resolved | Two separate OUT transactions: one pre-resolved (a `return_waivers` doc is written directly, so it already shows "No Return Due" with no click needed) and one still outstanding |
| — Mixed (multiple items) | Three items across three different states at once, on one staff member — exercises the Staff page's multi-row expand |

Run it after the emulators are up, in its own terminal: `npm run seed:outstanding`. It's **append-only like the real ledger** — re-running it adds a fresh batch on top rather than replacing anything, so quantities will look doubled if you run it more than once without clearing emulator data first. It uses its own product barcodes (`SEED-OUT-*`) so it never collides with `seed:products`' catalogue.

Wired into `package.json`: `"seed:outstanding": "node scripts/seed-outstanding.mjs"`. Syntax-checked with `node --check` and confirmed it runs standalone against `127.0.0.1:8081` like the other seed scripts.

## State at handoff

`npx tsc --noEmit` passes clean. The single-tab-lock removal, alignment fixes, and Add Product Clear button have been visually confirmed by the user. The Staff-page Resolve button is code-complete and typechecked but **not yet click-tested** — next step is: start the emulators, run `npm run seed:outstanding`, then walk through the Dashboard and Staff pages to confirm each of the six seeded scenarios shows the right badge and that Resolve behaves the same in both places.

## Session Handoff — 2026-09-19 (cont.): Dashboard Outstanding Returns was silently truncating at 8 rows

While testing with `seed:outstanding`, the user manually created an extra Stock Out for a real staff member (Estelle Taylor) and noticed one no-return-date line showed up on the Staff page's expanded row but not on the Dashboard's Outstanding Returns table, even though the badge said "11 outstanding."

Root cause: the card rendered `outstanding.slice(0, 8)` — a hard top-8 cap, same pattern as the other three dashboard cards (Low Stock Alerts, Outstanding Loan Requests, Incoming Pickups). The sort pushes undated rows (`No Return Date`) to the very end, so once there were more than 8 outstanding lines, any undated one past position 8 silently fell off the Dashboard's list while the badge count kept counting it. It was never missing data — it was fully present in Firestore and visible/resolvable from the Staff page the whole time.

Fixed **only** on the Outstanding Returns card (the other three cards were left as intentional top-8 previews, since they don't have a "Resolve" action riding on completeness):

- Removed `.slice(0, 8)` — every outstanding row now renders.
- Wrapped the `<Table>` in `<div className="max-h-96 overflow-y-auto">` so the card scrolls instead of growing unbounded, and gave `<TableHeader>` `className="sticky top-0 z-10 bg-card"` so the column headers stay visible while scrolling.

`npx tsc --noEmit` passes clean after this change. Worth remembering if a similar "shows in Staff/Returns but not on the Dashboard" report comes up for any of the *other* three capped cards — they still cap at 8 by design.

## Session Handoff — 2026-09-19 (cont.): staff-search "invisible past 20" bug fixed

Audited the app for other caps like the Outstanding Returns one above and found a more serious one: the manual staff-search modal (Stock Out's "Select Staff Member" dialog and Returns' equivalent) queried Firestore with `where('is_active', '==', true), orderBy('full_name'), limit(20)` **on every keystroke**, then filtered that 20-row page client-side by the typed text. Once there are more than 20 active staff, anyone alphabetically past the 20th became permanently unsearchable through that dialog — typing their name returned nothing, not because they don't match, but because they were never fetched. Scanning a card was unaffected (that's a direct `card_uid` lookup with no limit); this only broke the manual fallback.

Fixed in both `src/app/(protected)/stock-out/page.tsx` and `src/app/(protected)/returns/page.tsx`:

- Replaced `loadStaffList(qStr)` (re-queried Firestore every keystroke, capped at 20) with:
  - `loadAllStaff()` — fetches the full active roster once, with no `limit`, when the dialog opens (`openStaffSearch()`), caching it in a new `staffAll` state.
  - `filterStaffList(qStr)` — filters `staffAll` in memory on every keystroke; no more network calls while typing.
- Removed the now-unused `limit` import from both files' `firebase/firestore` import line.
- The dialog's list (`<div className="-mx-6 flex-1 overflow-y-auto border-t">` inside a `max-h-[80vh]` flex `DialogContent`) was already a scrollable panel, so no markup change was needed there — it already handles an arbitrarily long roster.

`npx tsc --noEmit` passes clean. Still on the list from the same audit, not yet fixed: the Dashboard's Low Stock Alerts / Outstanding Loan Requests / Incoming Pickups cards (same badge-shows-total-but-table-caps-at-8 pattern as Outstanding Returns had), and the Audit Log / Reports → Transaction History pages (fetch a capped most-recent window, then filter by date/type client-side, so an older filtered range can silently come back empty).

## Session Handoff — 2026-09-19 (cont.): every table in the app now fetches all data and scrolls

Finished the cap audit end-to-end. Beyond the Dashboard's Outstanding Returns card and the staff-search dialogs fixed earlier this session, three more real caps were found and removed, and every remaining table in the app (whether or not it was ever capped) was given a consistent scrollable container so none of them can silently truncate again or push the page into an endless scroll as data grows.

### Caps removed

- **Audit Log** (`src/app/(protected)/audit-log/page.tsx`): was `limit(300)` on `audit_log`, with the From/To date filter applied client-side *after* that 300-row fetch — an older date range with 300+ more-recent entries in between would silently come back empty. Now fetches the full audit log (still `orderBy('created_at', 'desc')`) so date filtering is always correct.
- **Reports → Transaction History** (`src/app/(protected)/reports/page.tsx`): same pattern, `limit(200)` on `transactions`, removed for the same reason.
- **Dashboard**: Low Stock Alerts, Outstanding Loan Requests, and Incoming Pickups all had the exact badge-shows-total-but-table-shows-`slice(0, 8)` bug that Outstanding Returns had. All three now render every row.

### Scrollable containers added everywhere

Every `<Table>` in the app (11 files) is now wrapped in a `<div className="max-h-* overflow-y-auto">` with `<TableHeader className="sticky top-0 z-10 bg-card">` (or `bg-muted/40` where the table sits on a tinted background), so long lists scroll inside a fixed-height panel with the column headers pinned, instead of growing the whole page:

| File | Table(s) |
|---|---|
| `dashboard/page.tsx` | Outstanding Returns, Low Stock Alerts, Outstanding Loan Requests, Incoming Pickups |
| `audit-log/page.tsx` | Audit Log |
| `reports/page.tsx` | Stock Levels, Low Stock, Issued Per Staff, Returns, Transaction History (all 5 tabs) |
| `categories/page.tsx` | Categories |
| `products/page.tsx` | Product catalogue |
| `staff/page.tsx` | Staff roster (outer), and each staff member's "Currently held" expanded row (inner, nested) |
| `returns/page.tsx` | "Items Currently Issued" (the per-staff outstanding-items list shown after picking a staff member) |
| `loan-requests/page.tsx` | Needs Review, Sent Counters, Incoming Pickups, History tabs, and the inline per-request line-item editor |
| `stock-in/page.tsx` | The scan cart |
| `stock-out/page.tsx` | Step 2's scan cart, Step 3's confirm-issue review table |
| `(portal)/lend/cart/page.tsx` | The borrower's cart |

Heights used: `max-h-96` (24rem) for compact dashboard-style cards and carts, `max-h-[32rem]` for full data-listing pages (Products, Categories, Reports, Loan Requests tabs), `max-h-64`/`max-h-56` for small nested/inline tables. All are plain Tailwind, no new dependencies.

The staff-search modals (Stock Out, Returns) already had their own `overflow-y-auto` panel from the earlier fix in this session and needed no further change there.

`npx tsc --noEmit` passes clean after every step of this pass (checked incrementally, file group by file group, not just at the end). **Not yet click-tested against a live emulator** — worth spot-checking that no scroll container clips content awkwardly (e.g. a dropdown or dialog opening from inside a scrolled row) before calling this fully done.

## Session Handoff — 2026-09-19 (cont.): Returns page's Items table was capped to 700px page width

The whole Returns page (`src/app/(protected)/returns/page.tsx`) was wrapped in a single `<div className="max-w-[700px]">` around all three steps (Staff lookup, Items, Done). That's a sensible width for the compact "tap a card" staff-lookup step, but it also capped the "Items Currently Issued" table to 700px — with 6 columns (Product, Ref, Issued, Returnable, Expected, Status, Returning) that doesn't fit, forcing a horizontal scrollbar even on a normal-width screen.

Fixed by moving the width cap off the shared outer wrapper and onto just the two steps that want to stay compact:

- Outer `<div>` (return statement's root) no longer has `max-w-[700px]`.
- `<Card>` for `step === 'staff'` now has `className="max-w-[700px]"`.
- `<Card>` for `step === 'done'` now has `className="max-w-[700px]"`.
- `step === 'items'` (the staff-summary card + "Items Currently Issued" table) is untouched and now naturally spans the page's full width, same as every other data table in the app.

`npx tsc --noEmit` passes clean.

## Session Handoff — 2026-09-19 (cont.): Dashboard's 4 tables converted to tabs

Replaced the 2×2 grid of always-visible cards (Outstanding Returns, Low Stock Alerts, Outstanding Loan Requests, Incoming Pickups) with a single `Tabs` control, one table showing at a time — same pattern as the Reports page (`Tabs`/`TabsList`/`TabsTrigger`/`TabsContent` from `@/components/ui/tabs`).

- New state: `dashboardTab: DashboardTab` (`'outstanding-returns' | 'low-stock' | 'loan-requests' | 'incoming-pickups'`), defaults to `'outstanding-returns'`.
- Each `TabsTrigger` carries its own live count in the label (e.g. `Outstanding Returns (19)`), shown only when > 0 — same numbers the old per-card badges showed, so the "badge total must match what's rendered" fix from earlier this session still holds even with only one table on screen.
- Each table kept its own scrollable `max-h-[28rem] overflow-y-auto` wrapper and sticky header from the earlier fix (bumped from `max-h-96` to `max-h-[28rem]` since a full-width single table can afford a bit more height than a half-width card could).
- Dropped the per-card `CardHeader`/`CardTitle` (the tab label now carries the name) — removed the now-unused `CardHeader`/`CardTitle` imports too.
- No data-fetching logic changed; `outstanding`, `lowItems`, `loanRequests`, `incomingPickups` all still load exactly as before, just render into whichever `TabsContent` is active.

`npx tsc --noEmit` passes clean. Not yet click-tested against the emulator — worth confirming the tab switch feels instant (it should, since all four datasets are already loaded up front) and that the Resolve dialog still opens correctly from the Outstanding Returns tab.

## Session Handoff — 2026-09-19 (cont.): visible count badges on Dashboard tabs and the sidebar

Two follow-ups to the Dashboard tabs change above, both from user feedback:

**1. Tab labels now show an actual badge pill, not "(19)" text.** Each `TabsTrigger` in `dashboard/page.tsx` renders a `<Badge>` next to its label instead of parenthesized text — same colors the old per-card badges used (`bg-accent` for Outstanding Returns/Loan Requests/Incoming Pickups, `bg-amber-100 text-amber-800` for Low Stock Alerts), just moved inline into the tab.

**2. New: a combined count badge on the "Dashboard" sidebar nav item.** Added `src/lib/firebase/dashboardAlerts.ts` — a lean, counts-only version of the same four computations the Dashboard page already does (Outstanding Returns' issued-returned-waived math, Low Stock's `quantity_on_hand <= reorder_threshold` check, and the loan-requests `expireIfNeeded()` lazy-transition pass for both Outstanding Loan Requests and Incoming Pickups), returning just `{ outstandingReturns, lowStock, loanRequests, incomingPickups, total }` instead of full row data.

`src/components/layout/Sidebar.tsx` calls `loadDashboardAlertCounts()` once on mount (the Sidebar stays mounted across the whole `(protected)` tree) and shows `total` as a turquoise `<Badge>` pushed to the right edge of the Dashboard nav button (`ml-auto`), hidden entirely when the total is 0. It re-fetches whenever the admin navigates to/from `/dashboard`, so resolving something on the Dashboard updates the sidebar badge without a full page reload. The fetch is best-effort — a failure just leaves the badge hidden rather than erroring, since the Dashboard page itself remains the source of truth.

**Important for future edits:** `dashboardAlerts.ts`'s counting logic is intentionally a duplicate of the equivalent logic inside `dashboard/page.tsx`'s `getDashboardData()`, kept only for the sidebar's lightweight total (the Dashboard page still needs full row data for its tables, so it wasn't refactored to share this function). If the Dashboard's definition of "outstanding" or "low stock" or which loan-request statuses count ever changes, `dashboardAlerts.ts` needs the same change or the sidebar badge will drift out of sync with the Dashboard tabs.

`npx tsc --noEmit` passes clean.

## Session Handoff — 2026-09-19 (cont.): Loan Requests badges, and History tab folded into Audit Log

### Badge bubbles — Loan Requests page and sidebar

Same treatment as the Dashboard tabs/sidebar badge from earlier this session:

- `loan-requests/page.tsx`'s three tabs (Needs Review, Sent Counters, Incoming Pickups) now show a `<Badge>` pill next to the label instead of "(N)" text — amber for Needs Review, sky for Sent Counters, accent for Incoming Pickups, matching each tab's own status-badge color.
- New `loadLoanRequestsAlertCount()` in `src/lib/firebase/loanRequests.ts` — a lean, counts-only companion to the page's own `load()` — returns the combined total of pending + countered + accepted (after the same `expireIfNeeded()` lazy-transition pass), deliberately excluding whatever's terminal (declined/expired/withdrawn/no_show/fulfilled) since those aren't waiting on anyone.
- `Sidebar.tsx` calls it on mount (gated on `canManageLoanRequests`, since staff-only accounts never see this nav item) and shows the total as a turquoise `<Badge>` on the "Loan Requests" nav button, same `ml-auto` placement as the Dashboard badge. Re-fetches on navigating to/from `/loan-requests`.
- **Keep `loadLoanRequestsAlertCount()`'s status filter in sync** with `loan-requests/page.tsx`'s own `pending`/`countered`/`accepted` derivations if those ever change — same caveat as `dashboardAlerts.ts`.

### History tab removed — its two gaps were closed in Audit Log first

The user asked to delete the Loan Requests page's History tab on the assumption the Audit Log already captured everything it showed. Checked before touching anything: the Audit Log already logged every loan_request status transition (create/counter/accept/decline/expire/no-show/withdraw) with who and when — but it had two real gaps versus History:

1. **No item list.** `submitLoanRequest()`'s audit entry only logged `reqPayload` (staff/dates/status/message) — never the requested products/quantities, which live in the separate `loan_request_lines` collection and were never audited at all.
2. **Expanding a loan_request audit entry didn't fetch anything** — it just ran `FieldDiff` on the raw before/after, so even the message field would show but with no way to tell what was actually requested.

Fixed both, then removed the tab:

- `submitLoanRequest()` (`lib/firebase/loanRequests.ts`) now includes `line_count`/`total_qty` in its audit `after` payload — same pattern `stock-out`/`stock-in`/`returns` already use for their transaction audit entries (computed only for the audit record, not real fields on the loan_requests doc itself).
- `audit-log/page.tsx` gained a `LoanRequestSummary` component (mirrors the existing `TransactionSummary`): for a loan_request's **create** entry (`before === null`) it shows Staff, Requested window, Message, and the actual item list (lazily fetched from `loan_request_lines` on expand, cached in a new `loanLines` state keyed by request id — same pattern as `lines`/`transaction_lines`). For any **update** entry (a status/date transition) it just falls back to the existing `FieldDiff`, since that already reads clearly for "status: pending → declined" etc.
- The render switch (`entity_type === 'transaction' ? ... : entity_type === 'loan_request' ? <LoanRequestSummary /> : <FieldDiff />`) and `toggleExpand()` (fetches `loan_request_lines` only for create entries, to avoid a pointless fetch on every status-change row) were updated accordingly.
- `loan-requests/page.tsx`: removed the `history` derived list, the `TERMINAL` status array, the History `TabsTrigger`/`TabsContent`, narrowed the `tab` state type to `'pending' | 'countered' | 'accepted'`, and dropped the now-unused `formatDate`/`CardHeader`/`CardTitle` imports. A completed request's full history (who touched it, when, what changed, and now what was actually requested) is fully visible from Audit Log → filter to "Loan Request" → expand any row.

`npx tsc --noEmit` passes clean throughout this pass. Not yet click-tested against the emulator — worth walking through: submit a portal loan request, then check its Audit Log "create" entry shows the item list; decline/expire/withdraw one and check the Audit Log "update" entry still reads clearly via FieldDiff.

## Session Handoff — 2026-09-19 (cont.): tables now fill the screen height instead of a fixed max-height

The earlier scrollable-tables sweep (see above) wrapped every table in a fixed `max-h-[Nrem]` box. That fixed it, but left a lot of dead white space below the scrollbar on tall/large screens (visible on the Staff page screenshot) — the table stopped scrolling well short of the bottom of the browser window. This pass replaces those fixed heights with a flexbox chain so each table's scroll area stretches to whatever room is actually left on screen, on any monitor.

**Mechanism (three links in a flex chain, from the outside in):**

1. **`(protected)/layout.tsx`** — `<main>` gained `display: 'flex', flexDirection: 'column'` (it already had `flex: 1, overflowY: 'auto'` inside a `height: 100vh` ancestor chain, so its box already had a definite height — it just wasn't passing that height down to its child). `overflowY: 'auto'` was deliberately left in place as a safety net for pages that *don't* opt into this pattern (dialogs, forms, wizard steps) — those keep scrolling exactly as before.
2. **Each page's root `<div>`** changed from bare `<div>` to `<div className="flex h-full min-h-0 flex-col">` — `h-full` claims all of `<main>`'s height, `flex-col` stacks the header/filters/tabs normally (natural height), and `min-h-0` is the standard fix that lets a flex child actually shrink/scroll instead of being clamped to its content's height.
3. **The table's `Card`** (previously `<Card className="py-0">`) now also carries `flex-1 min-h-0` (when its parent is the flex-column page root or a `Tabs` root) or `h-full min-h-0` (when its parent is a `TabsContent` panel, which isn't itself a flex container) — either way it consumes exactly the space left after the header. Its inner wrapper div — previously `max-h-[Nrem] overflow-y-auto` — is now uniformly `min-h-0 flex-1 overflow-y-auto`, so the actual scrollbar appears right at the bottom of the browser window instead of stopping partway down.

For pages with tabs (Dashboard, Reports, Loan Requests), the `<Tabs>` root itself got `className="min-h-0 flex-1"` (it's already `flex flex-col` by default) and every `<TabsContent>` got `className="min-h-0"` (it's already `flex-1` by default) — so the whole tab chain participates: TabsList keeps its natural height, and whichever tab's table is active fills the rest.

**Files touched:** `dashboard/page.tsx` (4 tabs), `staff/page.tsx` (outer roster table only), `products/page.tsx`, `categories/page.tsx`, `audit-log/page.tsx`, `reports/page.tsx` (all 5 report tabs), `loan-requests/page.tsx` (3 tabs), `returns/page.tsx` ("Items Currently Issued" table).

**Deliberately left as fixed-height** (secondary/nested tables, not the "browse a screen of data" tables the complaint was about): Staff's per-row "Currently held" expandable table (`max-h-56`), Loan Requests' inline per-request line-item editor (`max-h-64`), and the Stock In/Stock Out/portal-cart scan tables (`max-h-96`) — these size to their own content by nature (a handful of cart lines), not to the viewport.

`npx tsc --noEmit -p tsconfig.json` passes clean after every file. **Not yet visually verified in a browser** — this is a flexbox height cascade through several nested components (`main` → page root → `Tabs`/`TabsContent` → `Card` → scroll div), and while the structure follows the standard "fill remaining viewport height" pattern, it's worth an actual look at each changed page (especially one with a tab layout, like Dashboard or Reports) to confirm no double scrollbars appeared and that short-data tables don't look oddly stretched.

## Session Handoff — 2026-09-20: resolved (written-off) items stay returnable on the Returns page

The user noticed something the "Resolve" dialog explicitly warns about: it said resolving an item would make it "stop appearing here **and on the Returns page**." They confirmed they don't want that second part — a written-off item should still be processable as a real return later if it physically turns up (the write-off is "stop chasing it," not "it can never come back").

**Decision (asked via AskUserQuestion, user picked):** keep the item fully returnable — Resolve now only affects what counts as *outstanding* (Dashboard's Outstanding Returns table, the Staff page's Lending badge), not what's *returnable* (the Returns page's "Items Currently Issued" list).

**Changes:**

- **`returns/page.tsx`** — the returnable-quantity calc for "Items Currently Issued" no longer subtracts waived quantity. It was `returnable = issued - alreadyReturned - waived`; it's now `returnable = issued - alreadyReturned`. Removed the now-unused `loadWaivedByTxn`/`waivedQty` import and the `waivedByTxn` fetch from this page entirely — this page no longer needs to know about waivers at all.
- **`staff/page.tsx`** — this is the one place that fix could have introduced a stale-data bug: the "Currently held" table shows a separate "No Return Due" row for a fully-waived line, displaying the raw waived quantity unconditionally. Since a waived item can now actually be returned, that row needed to shrink/disappear once a real return comes in against it, instead of sitting there forever showing a quantity that's no longer accurate. Added the "effective waived" calc: any return beyond what the line's non-waived portion (`issued − waived`) already accounts for must have come out of the waived quantity, so that overflow is subtracted from what's still shown as written off (`effectiveWaived = max(0, waived − max(0, returned − (issued − waived)))`). Worked through by hand for full-return, partial-return, and no-return-yet cases before applying.
- **`dashboard/page.tsx`** — updated the Resolve confirmation dialog's copy to match the new behavior (no longer claims it disappears from Returns; now says it can still be returned normally later).

**Deliberately unchanged:** Dashboard's Outstanding Returns table, `dashboardAlerts.ts`'s sidebar badge count, and the Reports → Returns tab's outstanding-balance calc all still subtract waived quantity — those all only use it as a `> 0` boolean gate (never display the raw waived number after the fact), so they weren't at risk of the staleness bug above and correctly continue to exclude resolved items from "needs chasing" views.

`npx tsc --noEmit -p tsconfig.json` passes clean. **Worth testing against the emulator:** resolve an outstanding item, confirm it drops off Dashboard/Staff-lending-badge but still shows up on the Returns page for that staff member; process an actual return against it; confirm the Staff page's "No Return Due" row for it then disappears (rather than staying stuck showing an item that's already back).

## Session Handoff — 2026-09-20 (cont.): Issued per Staff report — one row per item, not one comma-joined cell

Reports → Issued per Staff, expanded transaction rows: a multi-item Stock Out (e.g. TXN-FDH1BA07: Logitech MX Master 3S Mouse ×1, Seed Test Drill ×1) previously rendered as a single row with all items squashed into one comma-joined cell. Changed to one row per line item — each product and its own quantity gets its own row, with the reference/date and expected-date repeated on each so every row still reads standalone. A transaction with no line items still renders one placeholder row ("No items recorded") so the group doesn't just vanish.

`npx tsc --noEmit -p tsconfig.json` passes clean.

## Session Handoff — 2026-09-20 (cont.): deactivated staff can no longer sign into the lending portal

The user asked two things: (1) confirm Deactivate already blocks a staff member from being picked for a Stock Out, and (2) whether it also blocks portal login with a specific error message, and whether that message was grammatically correct.

**(1) Stock Out — already correct, no change needed.** `stock-out/page.tsx` filters `where('is_active', '==', true)` on both the card-UID lookup and the manual staff-search list, so a deactivated staff member is already invisible to Stock Out entirely.

**(2) Portal login — this was a real gap, now fixed.** Neither `login/page.tsx`'s `routeSignedInUser()` nor `StaffPortalContext`/`lend/layout.tsx`'s `PortalShell` checked `is_active` at all — a deactivated staff member could still sign in and fully use the portal (browse, cart, submit loan requests). No "deactivated" message existed anywhere in the codebase yet.

Fixed at the layout level (`(portal)/lend/layout.tsx`'s `PortalShell`), since that's the one place every sign-in path — password login *and* NWU-CAS — passes through before reaching Browse/Cart/My Requests: if `staffMember.is_active` is `false`, it now shows a dead-end screen (same pattern as the existing "Your account isn't linked" one) with a Sign Out button, instead of the normal portal shell. Also added the same check up front in `login/page.tsx`'s `routeSignedInUser()`, purely so the password-login path gets an immediate, specific error right on the login form instead of a "Loading…" flash before landing on the dead-end screen — the layout-level check is what actually enforces it either way, including for CAS (which has its own separate `cas_allowlist`/role system and wasn't touched).

**Grammar note on the message the user proposed** ("Your account has been deactivated; please consult Selouna Visser for more information, Selouna.Visser@nwu.ac.za"): the trailing `, Selouna.Visser@nwu.ac.za` tacked on after a comma isn't valid — an email address can't just follow a comma like that, it needs a connector. Used instead: **"Your account has been deactivated. / Please contact Selouna Visser at Selouna.Visser@nwu.ac.za for more information."** — split into a heading + body to match the existing dead-end screen's style, "contact...at" instead of "consult...for more information, ", and "contact" also matches this app's existing microcopy elsewhere (login page's "contact an administrator", the portal's "Contact the IT Store"). The portal version also makes the address a clickable `mailto:` link.

`npx tsc --noEmit -p tsconfig.json` passes clean. **Worth testing against the emulator:** deactivate a staff member who has a linked portal account, then try signing in with their password — should get the error on the login form itself; also worth confirming an already-open portal session doesn't need a hard block (no live listener on `is_active` — it's re-checked on next sign-in/reload, same as the existing "not linked" dead-end, not on every render of an already-mounted session).

## Session Handoff — 2026-09-20 (cont.): Staff page — Active/Deactivated toggle, normal row styling, Portal Access column

Three related changes to the Staff page table:

1. **Active/Deactivated toggle.** Previously every staff member showed in one list, with deactivated ones just greyed out (`opacity-50`). Added a `Tabs`/`TabsList` toggle (same visual pattern as Reports/Loan Requests, each tab carrying its own count badge) next to the search box — `statusTab` state filters the same in-memory `staff` array into `visibleStaff` (`is_active` for Active, `!is_active` for Deactivated); no new Firestore query, `load()` already fetches everyone. The header line changed from "N active members" to "N active · M deactivated" so it stays accurate regardless of which tab is open.
2. **Deactivated rows now render normally.** Removed the `className={s.is_active ? '' : 'opacity-50'}` on the row. The Status column is what now carries the distinction: a deactivated staff member's Status cell shows a red `Deactivated` badge (`bg-red-100 text-red-800`) instead of falling through to the Lending/Active badge logic — that check now runs first, ahead of the existing Lending-vs-Active branch.
3. **New "Portal Access" column**, between Card UID and Status: `Granted` (green text) if `s.uid` is set (a lending-portal login has been provisioned via Send/Resend Login Email), otherwise `Not Granted` (muted grey) — same visual language as the existing Card UID cell's linked/"Not linked" split. Removed the old inline "· portal linked" note that used to sit under the email, since it's now redundant with this column. Loading/empty-state `colSpan` bumped 6→7 and the expanded "Currently held by…" row's `colSpan` bumped 5→6 to match the new column count.

`npx tsc --noEmit -p tsconfig.json` passes clean.

## Session Handoff — 2026-09-20 (cont.): resolving a return now logs against the Transaction entity, not a separate "Return Waiver" one

The user was looking at the Audit Log and noticed a Resolve action showed up as its own `Return Waiver` entity with a generic `CREATE` badge — they wanted it to instead show up under the `Transaction` entity (so it's findable alongside that Stock Out's own audit entry) with an action badge that reads `Resolved`.

- **`waivers.ts`'s `createReturnWaiver()`** — the audit entry it writes now uses `entityType: 'transaction'` and `entityId: input.transactionId` (the ORIGINATING OUT transaction's real doc id) instead of `entityType: 'return_waiver'` and the new waiver doc's own id. New `action: 'resolve'` (added to the `AuditAction` union in `types/database.ts`) replaces the generic `'create'` it used to log, since that's what actually distinguishes it from that same transaction's own create entry once both share an entity id.
- **`audit-log/page.tsx`** — `resolve` got a violet badge color (`ACTION_BADGE_CLASS`, matching the existing "No Return Due" violet used elsewhere for waived items) and its own `actionBadge()` special case so it reads "Resolved" rather than the generic uppercased "RESOLVE". Added `resolve: 'Resolved'` to the Action filter dropdown. New `ResolveSummary` component renders the expanded view (Item/Qty, Held by, Reason, Resolved by) — a resolve entry's `after` payload doesn't match `TransactionSummary`'s shape (no reference/line-items/lend-window, it's the waiver's own fields), so the render switch now picks `ResolveSummary` specifically when `entity_type === 'transaction' && action === 'resolve'`, falling back to the existing `TransactionSummary` for every other transaction entry.
- **Deliberately left alone:** `return_waiver` stays in `AuditEntityType`, `ENTITY_LABEL`, and the entity filter dropdown — existing historical audit entries already written with that entity type (from before this change) still need to filter/display correctly; only new resolves stop using it.

`npx tsc --noEmit -p tsconfig.json` passes clean. **Worth testing against the emulator:** resolve an outstanding item, then check its Audit Log entry now shows Entity = Transaction (same entity id as that Stock Out's own CREATE entry — filtering to that id should show both), Action = Resolved (violet badge), and expanding it shows the new Item/Held by/Reason/Resolved by summary instead of the old raw field-diff list.

## Session Handoff — 2026-09-20 (cont.): optional Reason field on the Resolve dialog

The Resolve dialog (Dashboard's Outstanding Returns table and the Staff page's per-row expanded list) always sent `reason: null` to `createReturnWaiver()` — there was no way to record why an item was written off, even though `waivers.ts`, the audit entry, and the new `ResolveSummary` view on Audit Log already had a `Reason` field ready to show one.

Added an optional `Textarea` ("Reason (optional)", placeholder "e.g. Lost, damaged beyond repair, written off…") to both Resolve dialogs, right below the existing explanatory paragraphs. New `resolveReason` state per page, reset to `''` whenever the dialog opens or closes (Cancel, the dialog's own close, and after a successful Resolve) so stale text from a previous item never carries over. `createReturnWaiver()` now gets `reason: resolveReason.trim() || null` — blank stays `null`, exactly as before.

**Bonus fix while in there:** the Staff page's copy of this dialog still said "It will stop appearing on the Dashboard and the Returns page" — the wording from before the "resolved items stay returnable" change earlier this session, which only got updated on the Dashboard's own copy of the dialog at the time. Staff page's now reads the same way: "...will stop counting as outstanding here and on the Dashboard — but it can still be returned normally from the Returns page later if it does turn up."

`npx tsc --noEmit -p tsconfig.json` passes clean.

## Session Handoff — 2026-09-20 (cont.): Staff page's "No Return Due" status renamed to "Resolved"

Small consistency fix: the Staff page's "Currently held" table showed a violet `NO RETURN DUE` badge for written-off items, while the Audit Log's Resolve entries (added earlier this session) show the same violet color labeled `RESOLVED`. Changed `lentItemStatus()` in `staff/page.tsx` to return label `'Resolved'` instead of `'No Return Due'` (same `bg-violet-100 text-violet-800` styling — the app's uppercase Badge styling turns it into `RESOLVED` on screen). Also updated the two Resolve confirmation dialogs' own prose (`dashboard/page.tsx` and `staff/page.tsx`, both say "...marked *___*, so there's still a record...") to say `Resolved` instead of `No return due`/`No Return Due`, since they're describing this exact badge.

Left alone: the toast success messages ("resolved — no return due") on both pages — those read as a plain sentence rather than naming the badge, so they weren't touched.

`npx tsc --noEmit -p tsconfig.json` passes clean.

## Session Handoff — 2026-09-20 (cont.): a staff member with only resolved items still shows "Lending", not "Active"

The Staff page's roster row Status badge (`lendingStaffIds` in `staff/page.tsx`) only counted a staff member as "Lending" if they had at least one still-owed (`remaining > 0`) item — a staff member whose every held item had been Resolved fell back to a plain "Active" badge in the roster row, even though their expanded "Currently held" list clearly showed items (all marked Resolved). Resolve only stops an item being chased, it doesn't hand it back, so the row should still read "Lending".

Fixed by also adding the staff member to the `lending` set whenever they have `effectiveWaived > 0` (the same value that drives the Resolved row itself), not just when `remaining > 0`. Dashboard's Outstanding Returns is intentionally unaffected — it still only cares about `remaining > 0`, since a fully-resolved item genuinely isn't something to chase there; this fix is scoped to the Staff page's own "does this person still have something of ours" question, which resolved items still answer yes to.

`npx tsc --noEmit -p tsconfig.json` passes clean.

## Session Handoff — 2026-09-20 (cont.): Card UID and Portal Access are now bubbles too

Both columns switched from plain colored `<span>` text to `<Badge>` pills, matching the Status column's existing style:

- **Card UID:** linked → green badge with the card-icon + UID (`bg-emerald-100 text-emerald-800`, mono font kept); unlinked → muted grey badge "Not Linked" (was "Not linked" as plain text).
- **Portal Access:** unchanged wording, just badged — green "Granted" / muted grey "Not Granted".

`npx tsc --noEmit -p tsconfig.json` passes clean.

## Session Handoff — 2026-09-20 (cont.): Staff activate/deactivate audit entries now show who, and say "Deactivated"

The Audit Log's expanded view for a staff activate/deactivate toggle used to show just "Active: Active → Inactive" via the generic `FieldDiff` — no indication of which staff member. Root cause: `toggleActive()` in `staff/page.tsx` only ever logged `{ is_active }` in before/after, and even if it had logged more, `FieldDiff` only shows fields that actually *changed* between before/after — name/surname/email don't change on an activate/deactivate, so they'd have been filtered out as "unchanged" anyway.

Fixed both ends:

- **`staff/page.tsx`'s `toggleActive()`** now also logs `name`, `surname`, `full_name`, and `email` in both `before` and `after` (identifying context, not something that's changing).
- **`audit-log/page.tsx`** gained a `StaffStatusSummary` component (same pattern as `ResolveSummary`/`LoanRequestSummary`) that reads those fields straight off `after` rather than diffing them, and is picked in the render switch specifically for `entity_type === 'staff' && (action === 'activate' || action === 'deactivate')`. It shows Staff member / Email / Status (Active or Deactivated).
- **"Inactive" → "Deactivated"** — renamed in `friendlyValue()`'s generic `is_active` formatter too (the fallback path any other `is_active` diff would still go through), for consistency with the wording used everywhere else in the app now.

`npx tsc --noEmit -p tsconfig.json` passes clean.

## Session Handoff — 2026-09-20 (cont.): "Send/Resend Login Email" disabled for deactivated staff

`staff/page.tsx`: the Send/Resend Login Email button is now also disabled when `!s.is_active` (alongside the existing "no email on file" check), with its tooltip explaining why ("Staff member is deactivated" takes priority over "No email on file" if somehow both are true). Added the same guard inside `sendLoginEmail()` itself as defense in depth (toasts "This staff member is deactivated — reactivate them first." and bails before calling the API) — a deactivated staff member shouldn't be handed a fresh portal login link while locked out of the portal itself.

`npx tsc --noEmit -p tsconfig.json` passes clean.

## Session Handoff — 2026-09-20 (cont.): out-of-stock items shown as "Unavailable" on the portal, and Stock Out now hard-blocks issuing someone else's approved pickup

Three changes, all from the same request:

**1. Portal Browse page no longer hides sold-out items.** `(portal)/lend/page.tsx` used to filter to `quantity_on_hand > 0`, so a fully-checked-out product just vanished from the list — a staff member had no way to know it existed, let alone when it might come back. It's now kept in the list and shown as an "Unavailable" card (red label, qty controls and Add to Cart disabled) with an expected-return date underneath, e.g. "Unavailable — back 25 Sep 2026".

That date isn't stored anywhere on the Product — it lives per-holder on the OUT `Transaction.lend_to` field set at Stock Out's Confirm step. New helper `getExpectedReturnDates()` in `lib/firebase/availability.ts` replays the same issued/returned/waived math used elsewhere (dashboardAlerts.ts) to find which OUT lines for a product are still outstanding, then takes the earliest `lend_to` among them. If every outstanding line for that product was issued with no return date (open-ended), the card says "return date not set" instead of guessing.

**2. Stock Out now hard-blocks issuing a unit that belongs to someone else's approved pickup**, instead of only warning. Previously `checkConflicts()` only ever produced non-blocking `<Alert>`s; Selouna could always click Confirm regardless. New helper `getAcceptedReservationHolders()` in `loanRequests.ts` returns the holder-level breakdown (staff name, quantity, dates) of ACCEPTED (approved) reservations for a product/date range — `getReservedQuantity()`'s sibling, but named rather than summed. Stock Out now splits on this:

- If issuing would eat into another staff member's **accepted** reservation → red blocking `Alert`, Confirm button disabled, message names the staff member and tells Selouna to cancel that accepted pickup on the Loan Requests page first.
- If the only shortfall is against **pending/countered** proposals (not yet approved) → same soft warning as before, still non-blocking.
- If there's enough stock for both, but another staff member does have an accepted pickup overlapping the window → new blue "Heads up" FYI panel naming them, purely informational.

A staff member's own accepted request is never counted against them (that's what "Select from Accepted Loan Requests" is for) — only *other* staff members' accepted reservations trigger the block or the FYI panel.

`npx tsc --noEmit -p tsconfig.json` passes clean.

## Session Handoff — 2026-09-20 (cont.): new seed script for today's features

Added `scripts/seed-conflict-scenarios.mjs` (`npm run seed:conflicts`) covering test data for everything built today:

- **Staff badges:** 5 "Seed Badges — …" staff covering every Card UID / Portal Access combination, plus a deactivated one (Send Login Email should show disabled/greyed out on that row). Also writes one `activate` and one `deactivate` audit_log entry directly so `/audit-log` has example entries to expand immediately.
- **Portal Browse "Unavailable":** two "Seed Portal — Sold Out …" products, fully issued out to a dedicated holder — one with a Lend To date (shows "Unavailable — back {date}"), one without (shows "Unavailable — return date not set").
- **Stock Out conflict handling:** three "Seed Conflict — …" products, each with a different reservation already in place — an ACCEPTED request (hard block), a PENDING request (soft warning only), and an ACCEPTED request against a product with plenty of spare stock (informational "Heads up" panel only). Console output at the end spells out exactly which staff/product pair to use for each case.

I could not run this myself — this session's device shell is a separate network namespace from wherever the emulators are actually running on your machine, so it can't reach `127.0.0.1:8081`/`9099`. Run it yourself, in a terminal that has the emulators up:

```
npm run dev:emulators   (in one terminal, if not already running)
npm run seed:conflicts  (in another terminal)
```

Re-running it is safe for the staff/product upserts, but NOT for the OUT transaction / loan_requests writes — same append-only caveat as `seed-outstanding.mjs`. Clear the emulator data first (http://127.0.0.1:4000) if you want a clean re-seed.

## Session Handoff — 2026-09-20 (cont.): fixed a firestore.rules permission error on the portal Browse page

The "Unavailable" feature added earlier today broke the portal Browse page for real (non-admin) borrowers with a rules evaluation error (`evaluation error ... for 'list' @ L61 ... false for 'list' @ L140`). Root cause: `getExpectedReturnDates()` queried `transactions`, `transaction_lines`, and `return_waivers` directly from the client — all three are admin-only in `firestore.rules` (`allow read, create: if hasBicsRole(['admin'])`), and rightly so: `transactions` is every staff member's full borrow history, not something a portal borrower should be able to query broadly just to find out when one product is back in stock. A BICS admin session wouldn't have hit this; only a real portal borrower login would, which is presumably how you ran into it.

Fixed by moving the computation server-side instead of loosening the rules:

- **`lib/server/availability.ts`** (new) — the same issued/returned/waived replay, now using the Admin SDK (`adminDb`), which bypasses `firestore.rules` entirely. `lib/firebase/availability.ts` (the broken client-side version) is deleted.
- **`/api/products/expected-return-dates`** (new route) — `POST { productIds: string[] }`, returns `{ expectedReturn: Record<string, string | null> }`. Requires a valid signed-in session (any Firebase Auth user, BICS or portal — see new `requireSignedIn()` in `lib/server/staffAdmin.ts`, factored out of the existing `requireAdmin()`), but no admin role, since portal borrowers are exactly who needs to call this. It only ever returns a single date per product — never transaction/staff details — so it doesn't reopen the privacy concern the rules are protecting.
- **`(portal)/lend/page.tsx`** — now calls that route with the signed-in staff member's own ID token (`useStaffPortal()`) instead of querying Firestore directly. Fails soft: if the call errors, the card still shows "Unavailable", just without a specific date.

`npx tsc --noEmit -p tsconfig.json` passes clean. This wasn't caught earlier because I only reasoned through the data model, not the security rules boundary between BICS admin and portal-borrower sessions — worth remembering: anything a portal page reads has to clear `firestore.rules` under a portal borrower's own auth, not an admin's.

## Session Handoff — 2026-09-20 (cont.): preview dialog also now reflects stock, not just the admin toggle

Clicking a card on the portal Browse page opens `ProductPreviewDialog` — shared with the admin Products page — which showed "Available" for a fully-checked-out product, contradicting the card right behind it ("Unavailable — back {date}"). Cause: the dialog's badge only ever read `product.available`, the admin's own on/off toggle for whether an item is offered for lending at all. That toggle does NOT track live stock — Stock Out decrements `quantity_on_hand` without ever touching `available` (confirmed: `handleConfirm()` in stock-out/page.tsx only writes the quantity, and the admin Products *form* only auto-flips `available` to false on zero stock when Selouna is actively editing that product there — Stock Out issuing the last unit doesn't go through that form at all). So `available: true, quantity_on_hand: 0` is a perfectly normal, common state, and the dialog was blind to it.

Fixed by giving the dialog its own out-of-stock check, layered on top of the existing toggle (admin-disabled still wins and still just says "Unavailable" — that's a deliberate decision, not a stock fact): a new optional `expectedReturnDate` prop, passed by `(portal)/lend/page.tsx` from the `expectedReturn` map it already fetches for the cards. Out of stock but not admin-disabled now shows the same "Unavailable — back {date}" / "Unavailable — return date not set" wording as the card, badge colored red like any other unavailable state. The admin Products page's own use of this same dialog is unaffected — it doesn't pass the new prop, so a product it previews falls back to "return date not set" wording if it's ever out of stock there too (an improvement over silently saying "Available", not a regression).

`npx tsc --noEmit -p tsconfig.json` passes clean.

## Session Handoff — 2026-09-20 (cont.): preview dialog gets its own Add to Cart, badge shows a count

Two small follow-ups to the preview dialog on the portal Browse page:

- **Badge:** an in-stock product now shows `{quantity_on_hand} Available` (e.g. "22 Available") instead of the bare word "Available" — matches the card's own "22 available" line right below it, just as a badge. Only applies to the genuinely-in-stock case; the admin-disabled and out-of-stock badges are unchanged.
- **Footer:** `ProductPreviewDialog` takes a new optional `cart` prop (`{ quantity, onIncrement, onDecrement, onAddToCart }`). When it's passed AND the product is actually available and in stock, the footer swaps the plain "Close" button for the same qty stepper + "Add to Cart" button the Browse card has — no more closing the preview just to go add the item from the card underneath. Clicking Add to Cart in the dialog adds it and closes the dialog. `(portal)/lend/page.tsx` wires this to its existing `qtyFor()`/`setQty()`/`handleAdd()` (same functions the card already uses, so quantity picked in the dialog is the same state as the card's own stepper). Unavailable/out-of-stock products still just get "Close", same as before.

The admin Products page's own use of this dialog is untouched — it doesn't pass `cart`, so its footer is unaffected either way.

`npx tsc --noEmit -p tsconfig.json` passes clean.

## Session Handoff — 2026-09-20 (cont.): Cancel button on Incoming Pickups rows

The Loan Requests page's Incoming Pickups tab (accepted requests) had no way to cancel one — no button anywhere, admin or otherwise. This is also the exact gap Stock Out's new hard-block message points Selouna at ("cancel that accepted pickup on the Loan Requests page first") — it didn't actually exist yet.

Added a "Cancel" button directly on each row's summary line (right next to the expand ▲/▼, `stopPropagation`'d so clicking it doesn't also toggle the row open) in the Incoming Pickups tab specifically — the other two tabs (Needs Review, Sent Counters) are untouched, their actions still live inside the expanded row where the offered-quantity editing happens.

It calls the existing `withdrawRequest()` from `loanRequests.ts` — the same function the portal's own "Withdraw" button already uses — writing status `withdrawn` (audit-logged as an `update`) rather than inventing a separate admin-only status: cancelled-by-Selouna and withdrawn-by-the-staff-member are the same "not happening" outcome from every other page's point of view (Dashboard, Stock Out's reservation check, the staff member's own My Requests page). No confirmation dialog, matching this page's existing Decline button.

`npx tsc --noEmit -p tsconfig.json` passes clean.

## Session Handoff — 2026-09-20 (cont.): Incoming Pickups consolidated onto the Dashboard, Loan Requests page trimmed to open requests only

Per request: Incoming Pickups (accepted loan requests) no longer appears on the Loan Requests page at all — it was duplicated there and on the Dashboard, and the Cancel button added earlier this session belongs on whichever page actually keeps the feature. It now lives only on the Dashboard.

**Dashboard (`dashboard/page.tsx`):**
- Tabs reordered to **Outstanding Returns → Incoming Pickups → Low Stock Alerts**.
- **Outstanding Loan Requests tab removed** — it's redundant with the Loan Requests page's own "Needs Review"/"Sent Counters" tabs, which are the actual place to act on those.
- **Incoming Pickups gained the Cancel button** (moved from Loan Requests page), gated on `isAdmin` like Resolve already is. Uses the same `withdrawRequest()` call, drops the row locally on success rather than refetching the whole dashboard (same convention as Resolve's own success handler).
- Data loading simplified to match: the `loan_requests` fetch is now scoped to `status === 'accepted'` only (previously fetched and lazily transitioned pending/countered/accepted together for two separate tabs) — pending/countered expiry transitions are the Loan Requests page's own job now.

**Loan Requests page (`loan-requests/page.tsx`):**
- Incoming Pickups tab, its `accepted` list, `ReadOnlyRow`, and the Cancel button/handler added earlier this session are all removed.
- `requestRows()` no longer takes an `editable` flag (there's only one row-detail component now — `EditableRow` — since both remaining tabs use it).
- The summary row's "possible no-show" badge and its `tab === 'accepted'` date-column branch are gone too — dead code once accepted requests never appear on this page.
- Page now only has **Needs Review** and **Sent Counters** tabs.

`npx tsc --noEmit -p tsconfig.json` passes clean on both files.

## Session Handoff — 2026-09-20 (cont.): Cancel pickup now confirms via a dialog, same shape as Resolve

The Dashboard's Incoming Pickups "Cancel" button fired immediately with no confirmation. Now matches the Resolve dialog's pattern exactly: clicking Cancel opens a dialog naming the staff member/items/pickup window, an explanatory note (reservation released, staff member isn't auto-notified, can't be undone), an optional Reason textarea, and "Close" / "Cancel pickup" buttons.

- `withdrawRequest()` in `loanRequests.ts` gained an optional third `reason` parameter — when given, it's logged on the audit entry as `cancel_reason` alongside the status transition (the portal's own "Withdraw" button still doesn't pass one — a staff member cancelling their own request doesn't need to explain it, only the admin-side dialog collects a reason). The generic `FieldDiff` on the Audit Log page picks this up automatically as a new field, same as any other diffed change — no dedicated summary component needed.
- Dashboard state: `cancellingId` replaced with `cancelling` (the row being confirmed, or null) + `cancelReason` + `cancelBusy`, mirroring `resolving`/`resolveReason`/`resolveBusy` exactly.

`npx tsc --noEmit -p tsconfig.json` passes clean.

## Session Handoff — 2026-09-20 (cont.): Incoming Pickups rows are expandable

Dashboard's Incoming Pickups table rows now expand on click (▲/▼ indicator, same pattern as the Loan Requests page's own rows) to show a plain product × quantity list for that request — previously the table only showed an aggregate item count with no way to see what was actually in it.

The product/quantity breakdown (`pickupLines`, keyed by request id) is built in the same `loan_request_lines` read the item count already came from — no extra fetch, no lazy-load-on-expand needed. The Cancel button's click is `stopPropagation`'d so it still opens the confirmation dialog without also toggling the row's expand state.

`npx tsc --noEmit -p tsconfig.json` passes clean.

## Session Handoff — 2026-09-20 (cont.): "Offering" quantity auto-clamps to live availability on Loan Requests

Reported: after a Stock Out drops a product's on-hand quantity below what a pending loan request had offered, expanding that request on the Loan Requests page correctly showed the "Availability changed since this request was submitted..." warning (both toast and inline) and correctly disabled Approve as-is/Send Counter — but the "Offering" stepper itself kept showing the stale, no-longer-available number instead of reflecting what's actually available now.

Root cause: `refreshAvailability()` (called on row expand and whenever the draft's from/to dates change) only ever wrote into the `availability` state used for the warning/cap math — it never touched `drafts`, which is what the "Offering" stepper actually renders. So the live availability number and the displayed offered quantity could disagree indefinitely.

Fix, in `refreshAvailability()` (`loan-requests/page.tsx`): right after computing `availabilityMap`, also walk that request's draft lines and clamp any line whose `offered_quantity` exceeds `Math.min(requested_quantity, availabilityMap[product_id])` down to that cap — the exact same formula `updateOfferedQty` already uses for manual stepper edits, just applied automatically. Only ever reduces, never bumps a value back up, and no-ops (skips the `setDrafts` update) when nothing needs clamping.

This has the correct knock-on effect through the existing dirty-check: the auto-clamped draft now differs from the originally-stored line, so `isDirty(r)` flips true — "Approve as-is" (which always checks the stored offered_quantity via `assertStillAvailable`, not the draft, so it would keep failing regardless) becomes disabled, and "Send Counter" (which submits the draft's — now corrected — quantity) becomes enabled, since sending a counter with the reduced amount is the actual way to resolve the conflict.

`npx tsc --noEmit -p tsconfig.json` passes clean.

## Session Handoff — 2026-09-20 (cont.): "Send Counter" disabled when nothing is actually being offered

Following straight on from the auto-clamp fix above: once a product's availability drops to 0, the Offering stepper correctly clamps down to 0 — but "Send Counter" was still clickable, letting staff send a counteroffer of 0 units, which isn't a real counteroffer (it's a de facto decline dressed up as one).

Fix: "Send Counter" is now also disabled whenever every line in the draft has `offered_quantity <= 0` (in addition to the existing dirty-check), with a `title` tooltip explaining why ("Offer at least 1 unit of a product to send a counter."). For a multi-line request this only blocks sending when *all* lines are zeroed out — offering 0 of one item while still offering a real quantity of another remains valid, since that's a legitimate partial counter.

`npx tsc --noEmit -p tsconfig.json` passes clean.

## Session Handoff — 2026-09-20 (cont.): Stock Out now hard-blocks against pending/countered requests too, not just accepted

Follow-up to the "Offering auto-clamps to 0" fix above. Root question raised: if a walk-in Stock Out can still eat into a *pending* loan request's stock (previously only a soft, dismissible warning), the loan-requests page has no way to recover — the Offering just clamps to 0 and stays there once returned stock isn't tracked forward. The better fix is upstream: don't let that walk-in go through at all while it would conflict with an unresolved request.

**`src/lib/firebase/loanRequests.ts`:** `getAcceptedReservationHolders()` (accepted-only) is replaced by `getReservationHolders(productId, fromDate, toDate, statuses = ACTIVE_STATUSES)` — same per-holder breakdown (who, how much, what date range), but now covers pending/countered/accepted by default, and each `ReservationHolder` carries its `status`. `ACTIVE_STATUSES` (`['pending', 'countered', 'accepted']`) is now exported for reuse. The old `getReservedQuantity()`-based soft-warning path (which summed reserved units without naming holders) is no longer used by Stock Out.

**`src/app/(protected)/stock-out/page.tsx`:** The three-tier hard-block / soft-warning / FYI system from earlier this session collapses to two tiers — hard-block and FYI — because pending/countered now carry the same weight as accepted:
- **Blocking** (`blockingConflicts`): any other staff member's active reservation (any status) that would push demand over on-hand disables Confirm, same as accepted-only did before. The alert names each holder's actual status ("pending request" / "countered offer" / "approved pickup" via `reservationStatusLabel()`) and, via a new `resolutionInstruction()` helper, points Selouna at the *correct* page per status — an approved pickup can only be cancelled from the Dashboard's Incoming Pickups tab (that Cancel button doesn't live on the Loan Requests page any more, per the earlier "Incoming Pickups consolidated onto the Dashboard" change this session), while pending/countered is resolved on the Loan Requests page itself. A mixed set of holders gets both instructions in one sentence rather than sending Selouna to the wrong page for half of them.
- **FYI** (`incomingPickups`): unchanged in spirit — enough stock for everyone, just surfaced so Selouna knows who else has a stake — but now includes pending/countered holders too, each labeled with its status.
- A staff member's own reservations are still excluded from both (same as before) — this only fires for *other* people's stake in the product.

Net effect: a walk-in Stock Out can no longer silently strip stock out from under a pending loan request. Selouna has to resolve the conflicting request (approve/counter/decline it, or cancel an accepted pickup) before the issue can proceed — closing the gap that caused the earlier "Offering stuck at 0 with no path back" scenario in the first place.

`npx tsc --noEmit -p tsconfig.json` passes clean.

## Session Handoff — 2026-09-20 (cont.): Products page now guards against a quantity edit breaking an active loan request

Closing the last known gap from the Stock Out hardening above: editing `quantity_on_hand` directly on the Products page (a stocktake correction, writing off damaged/lost units) wrote straight to Firestore with zero reservation check — unlike Stock Out, which now hard-blocks a conflicting walk-in. An admin lowering a count by hand could silently drop stock below what an active loan request already had a claim on.

**`src/lib/firebase/loanRequests.ts`:** `reservationStatusLabel()` and `resolutionInstruction()` (previously local to `stock-out/page.tsx`) are now exported from here instead, so both pages share one copy — `stock-out/page.tsx` imports them rather than redefining them. New `findQuantityReductionConflicts(productId, newQuantity)`: unlike Stock Out or a portal submission, a flat quantity edit has no date window of its own, so instead of checking one range's reserved total, it walks every currently active reservation on the product (any status, any date — via new `OPEN_ENDED_TO`/`ALL_TIME_FROM` sentinels) and re-runs the same per-request "is my own window still satisfiable" check `assertStillAvailable`/`refreshAvailability` already use, against the proposed new quantity. This avoids over-counting: two active requests for non-overlapping weeks don't both count against the same unit just because they're both "active" today.

**`src/app/(protected)/products/page.tsx`:** While editing an existing product (not on Add — a brand-new product can't have requests against it yet), `handleSave` runs `findQuantityReductionConflicts` on Save — same timing as every other validation already on this form (barcode conflict, lend-date ordering), none of which are live-checked either. `formatQuantityConflictError()` turns the offending holders into one message (same holder-naming + `resolutionInstruction()` pattern as Stock Out's alert) shown in the form's existing bottom error box, rather than a separate inline alert — kept consistent with how every other error on this dialog is surfaced.

(First pass had this as a debounced live check with its own inline alert under the Qty field and a disabled Save button — reverted after testing showed it just added a second, redundant message on top of the bottom error box; the plain submit-time check reads the same as the rest of the form.)

`npx tsc --noEmit -p tsconfig.json` passes clean.

## Session Handoff — 2026-09-20 (cont.): Per-product Lending Interval, enforced on the portal — including a genuinely indefinite loan

Requested: relabel Products' "Lend From"/"Lend To" to "Available From"/"Available To (or Until)", add a "Lending Interval" drag bar (1 Week / 2 Weeks / 3 Weeks / 1 Month / Indefinitely) below it, and enforce that cap on the lending portal when staff pick their dates — with "Indefinitely" meaning the staff member genuinely doesn't have to give a return date at all, the same convenience Stock Out's blank "Lend To" already offers.

This replaces the previous flat, app-wide `MAX_LOAN_DAYS = 7` cap (used to be the same for every product) with a per-product setting, and — because "Indefinitely" has to mean an actually-blank return date, not just "no day-count cap" — required widening `LoanRequest.to_date`/`original_to_date` to `string | null` throughout the codebase, mirroring how `Product.lend_to`/`Transaction.lend_to` already represent "no end date." This touched every file that reads or writes a loan request's dates; `tsc --noEmit` was used after each step to make sure nothing was missed, and passes clean end to end.

**Mixed-cart policy (confirmed with the user):** the portal cart shares one From/To date pair across every item in it. When items with different intervals are in the same cart, the **tightest cap wins** and a To date is required whenever *any* item in the cart isn't Indefinitely — a mixed cart behaves like its most restrictive item, not its most lenient one.

**`src/types/database.ts`:** new `LendingInterval = 'week_1' | 'week_2' | 'week_3' | 'month_1' | 'indefinite'` type. `Product.lending_interval?: LendingInterval` (optional — a product saved before this feature existed has none, treated as `'week_1'` everywhere it's read, preserving the old flat 7-day behavior exactly). `LoanRequest.to_date`/`original_to_date` widened to `string | null`.

**`src/lib/firebase/loanRequests.ts`:**
- `LENDING_INTERVALS` (the 5 stops with day-counts and labels), `lendingIntervalDays()`, `lendingIntervalLabel()`, `tightestLendingCap(cartItems)` (the shared tightest-cap-wins logic, used by both `validateCartDates` and the cart page itself for live UI feedback) — all exported for reuse across pages.
- `effectiveToDate(to)` — resolves a null/blank "to" into the existing `OPEN_ENDED_TO` sentinel (`'9999-12-31'`) so every date-overlap comparison in this file keeps working unchanged; used everywhere a *stored* request's `to_date` (now nullable) or a caller's own blank toDate needs to compare against another date.
- `getReservationHolders`/`getReservedQuantity`: overlap checks now resolve a stored request's `to_date` through `effectiveToDate()` before comparing. `ReservationHolder.toDate` is now `string | null`.
- `validateCartDates`: rewritten around `tightestLendingCap()`. A blank To date is accepted only when every cart item is Indefinitely; otherwise it's required and capped at the tightest interval among the cart's items. Also guards a fringe case: a product with its own `lend_to` cutoff (the window during which it can be borrowed at all) still requires a real To date even if its lending interval is Indefinitely — an indefinite loan can't be promised past a hard availability cutoff the admin explicitly set.
- `submitLoanRequest` stores `to_date`/`original_to_date` as `null` (not `''`) for a blank submission. `assertStillAvailable` and `sendCounter` accept/pass a nullable toDate through the same `effectiveToDate()` path. `findQuantityReductionConflicts` (from the earlier Products-quantity-edit fix) updated the same way.
- `MAX_LOAN_DAYS` is kept, but now used only for `computeExpiryDate`'s unrelated 7-day pending-response SLA — not conflated with the new per-product interval even though both happened to be 7 days before this change.

**`src/app/(protected)/products/page.tsx`:** Labels changed to "Available From" / "Available To (or Until)" (error messages and hint text updated to match — the underlying `lend_from`/`lend_to` field names are unchanged, this is a copy-only rename). New "Lending Interval" control below the date fields: a native 5-stop range slider (`<input type="range">`, no new dependency) with tick labels underneath, plus a one-line summary ("Up to 2 Weeks" / "Staff won't be required to set a return date…"). Saved as `lending_interval` on the product, included in the audit-log before/after snapshot.

**`src/app/(protected)/audit-log/page.tsx`:** `lending_interval` gets a friendly label ("Lending interval") and its value is rendered via `LENDING_INTERVALS` (e.g. "2 Weeks" instead of the raw `week_2`) rather than falling through to the generic string display.

**Portal — `src/app/(portal)/lend/cart/page.tsx`:** The To-date field's live validation now runs even when it's blank (previously skipped entirely). Its `max` is computed from `tightestLendingCap(cart)` instead of the old hardcoded `+7 days`, its label shows "(optional)" when every cart item is Indefinitely, and a one-line hint above the date fields explains the current cap ("this loan can run for up to 2 weeks" / "you don't need to set a To date"). The cart table gained a "Max loan" column per item. Submit is enabled with a blank To date only when nothing in the cart requires one.

**Portal — `src/app/(portal)/lend/page.tsx` (Browse) and `src/components/products/ProductPreviewDialog.tsx`:** both now show the product's lending interval alongside its existing "Lendable" window, so staff see the cap before they even add something to their cart.

**Display polish:** `formatDateOnly(from) – formatDateOnly(to)` join patterns (Dashboard's Incoming Pickups table and Cancel dialog, Stock Out's pickup selector, the portal's My Requests card title) were swapped for the existing `formatLendWindow()` helper, so a null `to_date` now reads "20 Sep 2026 – no end date" instead of "20 Sep 2026 – —".

**Not changed / explicitly out of scope:** the admin Loan Requests page's counter-offer date editing still uses plain string state for its date inputs (blank string, converted to/from `null` at the read/write boundary) — Selouna wasn't asked for a way to *toggle* a request to indefinite from that page, only for the portal to enforce what staff can request in the first place; she can still counter with any dates she likes, same as before.

`npx tsc --noEmit -p tsconfig.json` passes clean across every file touched.

## Session Handoff — 2026-09-20 (cont. 2): Add/Edit Product modal — relabel + two-column layout

Two small follow-ups requested right after the Lending Interval feature above:

1. **"Available To (or Until)" → "Available To"** — shortened per feedback; no behavior change, label text only.
2. **Add/Edit Product modal restructured into two columns** for a wider, more scannable form (modal widened `sm:max-w-[480px]` → `sm:max-w-[820px]`, single column below `md` breakpoint):
   - **Left — "Product details":** Name, Category, Qty On Hand + Reorder Threshold (paired), Description, Location, Photos.
   - **Right — "Product availability":** Available From + Available To (paired), Lending Interval slider, Availability (own line) — then, still on the right, a **"Barcodes"** section beneath it.
   - Purely a layout change — every field keeps its existing id, state binding, validation and disabled/hint logic untouched; only the grouping and column placement moved.

`npx tsc --noEmit -p tsconfig.json` passes clean.

## Session Handoff — 2026-09-20 (cont. 3): Fix — Sidebar badge counts didn't match their own pages

User caught this by comparing the Sidebar's badge numbers against what each page actually showed: Dashboard badge said 8 but Outstanding Returns (2) + Incoming Pickups (2) + Low Stock Alerts (3) = 7; Loan Requests badge said 3 but Needs Review (1) + Sent Counters (0) = 1.

Root cause — both badges were counting a status bucket that has no tab on the page they're badging:
- `dashboardAlerts.ts`'s `loadDashboardAlertCounts()` was adding a `pending + countered` loan-request count into the Dashboard's `total`, even though the Dashboard page only has three tabs (Outstanding Returns, Incoming Pickups, Low Stock Alerts) — there's no "Outstanding Loan Requests" tab on the Dashboard anymore (that's the Loan Requests page). Removed the `loanRequests` field and its contribution to `total` entirely; `total` is now exactly `outstandingReturns + lowStock + incomingPickups`, matching the three tabs one-for-one.
- `loanRequests.ts`'s `loadLoanRequestsAlertCount()` was counting `pending + countered + accepted`, but the Loan Requests page only has two tabs (Needs Review = pending, Sent Counters = countered) — `accepted` requests become an Incoming Pickup, which is the Dashboard's job to track, not this page's. Worse, this meant an accepted request was being counted in *both* sidebar badges at once. Dropped `accepted` from this count so it's now `pending + countered` only.

Both functions' doc comments (which described a stale "four tabs" / "three tabs" shape that no longer matches either page) were rewritten to describe the current tabs and explicitly call out the double-counting trap for future changes.

`npx tsc --noEmit -p tsconfig.json` passes clean.

## Session Handoff — 2026-09-20 (cont. 4): Fix — Sidebar badges didn't refresh for in-place actions

Right after the counting-math fix above, the user found a second bug: resolving an Outstanding Return on the Dashboard updated that tab's own count immediately (2 → 1) but the Sidebar's Dashboard badge stayed at the old total until the page was reloaded.

Root cause: the Sidebar loads its two badge counts in a `useEffect` keyed on `pathname === '/dashboard'` / `pathname === '/loan-requests'` — a boolean that only flips when the admin *navigates* to or away from that page. That's enough to pick up a change made elsewhere (e.g. issuing stock on Stock Out, then navigating back to the Dashboard). It's not enough for an action taken **without leaving the page**, which is exactly how Dashboard's Resolve/Cancel-pickup and Loan Requests' Approve/Counter/Decline all work — each patches its own local list in place (`setOutstanding(prev => prev.filter(...))` etc.) rather than doing a full navigation, so the pathname boolean never changes and the Sidebar's effect never re-fires.

Fix: added a tiny pub/sub, `src/lib/alertsBus.ts` (`notifyAlertsChanged()` / `subscribeToAlertsChanged()`), used only for this — no new state library, just a `Set<Listener>` module singleton. The Sidebar subscribes to it alongside its two existing pathname-keyed effects (doesn't replace them — the pathname effects still matter for cross-page navigation). Every in-place mutation that changes a badge's count now calls `notifyAlertsChanged()` right after updating its own local state:
- Dashboard: Resolve (Outstanding Returns), Cancel pickup (Incoming Pickups).
- Loan Requests: Approve, Send Counter, Decline (all three move a request between pending/countered/accepted, which both Sidebar badges partly key on).

`npx tsc --noEmit -p tsconfig.json` passes clean.

## Session Handoff — 2026-09-20 (cont. 5): Fix — stray vertical scrollbar on the tab strip (Dashboard, Reports, Loan Requests)

All three pages' `TabsList` had `overflow-x-auto` (so the tab strip can scroll horizontally on a narrow screen instead of wrapping) but no `overflow-y` set. Per the CSS spec, once one axis is set to anything other than `visible`, a `visible` value on the other axis computes to `auto` instead — so `overflow-x-auto` alone silently turns `overflow-y` into `auto` too, and the fixed-height (`h-8`) tab row shows a vertical scrollbar (with up/down step arrows) the instant its content is even a pixel taller than the box, which badge padding/borders reliably trigger.

Fix: added `overflow-y-hidden` alongside the existing `overflow-x-auto` on all three `TabsList`s — `dashboard/page.tsx`, `loan-requests/page.tsx`, `reports/page.tsx`. Horizontal scroll-on-overflow behavior is unchanged; only the unintended vertical scrollbar is gone.

`npx tsc --noEmit -p tsconfig.json` passes clean.

## Session Handoff — 2026-09-20 (cont. 6): Fix — no-show fired the day after "From", ignoring "To" entirely

User caught this by walking through a real scenario: an item accepted for a whole week (say From Mon, To the following Mon) that a staff member picked up on the Tuesday instead of the Monday was getting flagged a "possible no-show" and pulled from Incoming Pickups the very next day — even though the reservation ledger was still correctly holding those units for that staff member across the whole week and nobody else could have taken them anyway.

Root cause: `isNoShowCandidate()` only ever checked `todayDateStr() > request.from_date` — the "To" date (or Indefinite) played no part in it at all, even though every other part of the system (`getReservedQuantity`/`getReservationHolders`) treats an accepted request as occupying its entire From-To window, not just its first day.

Confirmed with the user (three options offered: trigger after To passes / a grace period after From / leave as-is) — chose **trigger after the whole window passes**. Fix, in `loanRequests.ts`:

```ts
export function isNoShowCandidate(request: LoanRequest): boolean {
  return request.status === 'accepted' && !request.fulfilled_txn_id && todayDateStr() > effectiveToDate(request.to_date)
}
```

Reusing `effectiveToDate()` (already in this file, from the Lending Interval work) meant the Indefinite case needed no special-casing at all: a null `to_date` resolves to the open-ended sentinel, so an Indefinite pickup never auto-flags as a no-show — consistent with "no forced return date" also meaning no forced pickup deadline. An admin can still manually Cancel it from the Dashboard at any time regardless of the no-show badge.

`npx tsc --noEmit -p tsconfig.json` passes clean.

## Session Handoff — 2026-09-20 (cont. 7): Incoming Pickups — new "Insufficient" status, cross-checked against overdue returns

New Dashboard feature, walked through with the user step by step before building: an accepted Incoming Pickup's offered quantity was only ever validated against live stock at the moment it was approved/countered (`assertStillAvailable`). Nothing re-checks it afterwards — so if the shelf ends up short by pickup time (most plausibly because a same-product Outstanding Return that was due back hasn't come in), the pickup would still calmly show "ON SCHEDULE" even though there isn't actually enough stock to hand over.

**The check** (`dashboard/page.tsx`, inside the existing data-load effect): for every still-`accepted` request, for each of its lines, `available = quantity_on_hand − getReservedQuantity(productId, fromDate, effectiveToDate(toDate), excludeThisRequestId)` — the exact same live-availability arithmetic the rest of the app already validates against (Approve/Counter, Stock Out, the Products quantity-edit guard), just re-run here instead of assumed still valid. `shortBy = max(0, offered_quantity − available)`. A pickup is **Insufficient** if any of its lines comes up short.

**Badge:** a new amber "INSUFFICIENT" badge, ranked below "NOT PICKED UP" (no-show still takes priority and removes the row entirely) but distinct from green "ON SCHEDULE".

**Expandable detail:** the row's existing expand-on-click behavior now shows, per short line, "Short by N — only X of Y on hand right now", plus a "likely cause" list of any **overdue** (not merely outstanding — a return that isn't due yet is expected to still be out, so it isn't a "problem") return of that same product, each showing who has it, the expected date, and the transaction reference. If no overdue return of that product explains the gap (a rarer case — e.g. two accepted pickups racing each other), it says so plainly rather than guessing.

**"Goes away" automatically**, per the user's requirement — no special-casing needed, since this is recomputed live from `quantity_on_hand` on every Dashboard load, the same as everything else on this page:
- Selouna manually raises the product's Qty On Hand on the Products page → next load, `available` goes up, `shortBy` clears.
- A Stock In receipt raises Qty On Hand → same.
- Any Return of that product (from a *different* loan, or the same overdue one finally coming back) raises Qty On Hand via `returns/page.tsx` → same.

**Resolving** an overdue return (writing it off) doesn't fix the shelf shortage — the unit is still physically gone — but the now-resolved item is stripped out of the "likely cause" list right when Resolve succeeds, alongside the existing local patch to Outstanding Returns, so the explanation never keeps pointing at something already written off.

**Known scope limit:** this is computed fresh once per Dashboard page load, same as Outstanding Returns/Incoming Pickups/Low Stock already are — cancelling one pickup or resolving a return doesn't retroactively re-check every *other* row's insufficiency within the same session; a fresh load (navigating away and back, or a manual refresh) picks it up.

`npx tsc --noEmit -p tsconfig.json` passes clean.

## Session Handoff — 2026-09-20 (cont. 8): Dashboard reloads its Insufficient check on Cancel, Resolve, and tab switch

Follow-up to the Insufficient-status feature above — the user asked for the "recompute on next load" limitation to be tightened: rather than requiring a navigate-away-and-back, trigger a fresh check right on the actions that can actually change it.

`getDashboardData()` was pulled out of the mount `useEffect` into a normal component function, taking an optional `{ silent?: boolean }` — `silent: true` skips the full-page "Loading dashboard..." replacement (`setLoading(true)`) so a background re-check doesn't blank the screen the admin is looking at; the initial mount call stays non-silent since that's the one real "still loading" moment.

Wired to call `getDashboardData({ silent: true })` from three places:
- **Tab switch** (`Tabs onValueChange`) — catches anything that changed elsewhere while this page sat idle.
- **Cancel pickup** — genuinely can change other rows: withdrawing a request frees its hold on the product, which `getReservedQuantity` subtracts for every other accepted pickup of the same item too, potentially clearing an Insufficient elsewhere.
- **Resolve return** — doesn't actually change `quantity_on_hand` today (a waiver is a write-off, not a physical return), so it can't currently un-block an Insufficient pickup, but wired anyway so this doesn't quietly become a trap if Resolve's behavior ever changes.

`npx tsc --noEmit -p tsconfig.json` passes clean.

## Session Handoff — 2026-09-20 (cont. 9): Pending/Countered response SLA widened from 1 week to 1 month

`MAX_LOAN_DAYS` in `loanRequests.ts` (used only by `computeExpiryDate` — the auto-expiry clock on a pending/countered request that Selouna hasn't acted on) changed from `7` to `30`. A request still expires at `min(updated_at + 30 days, from_date)` — capped at its own pickup date so a near-term request still can't outlive its own pickup window — just with a full month's grace instead of a week before that cap kicks in.

This is unrelated to the per-product Lending Interval feature (1 Week/2 Weeks/3 Weeks/1 Month/Indefinite) added earlier this session — that governs how long a staff member can KEEP a borrowed item; this SLA governs how long Selouna has to Approve/Counter/Decline before the request itself goes stale.

`npx tsc --noEmit -p tsconfig.json` passes clean.

## Session Handoff — 2026-09-20 (cont. 10): Optional message on Counter and Decline

New `LoanRequest.admin_message: string | null` field — a note from Selouna, shown to the staff member, sent along with either a counter or a decline. Reused across both (they're mutually exclusive transitions for a given request, so there's never a case where a "counter message" and a "decline reason" both need to be visible for the same request at once).

**Send Counter** (`loan-requests/page.tsx`): the expanded row's editing area got a new "Message to {staff_name} (optional)" `Textarea`, right below the From/To dates. `Draft` gained a `message` field, pre-filled from `r.admin_message` when re-opening an already-countered request (so re-editing shows what staff already saw, not a blank box). `isDirty()` now also treats a message-only change as dirty — typing a note with otherwise-unchanged terms is a deliberate act, not a no-op, and disables "Approve as-is" the same way any other edit would (Approve carries no message of its own).

**Decline**: previously a single-click ghost button with no confirmation at all. Now opens a confirmation dialog — same shape as the Dashboard's existing Resolve/Cancel-pickup dialogs — with its own optional message `Textarea`, and a destructive "Decline" button to confirm. `declineRequest()` gained a `message` parameter between `request` and `actor`.

**`loanRequests.ts`**: `sendCounter()` gained a `message: string | null | undefined` parameter (before `actor`); both it and `declineRequest()` trim and null-coalesce the message, write it to `admin_message` on the request doc, and include it in the audit log's `after` diff only when non-empty (mirroring how `withdrawRequest`'s optional `reason` is handled). `submitLoanRequest()` now explicitly sets `admin_message: null` at creation for consistency with the rest of the doc's nullable fields.

**Portal — `lend/requests/page.tsx`**: `RequestCard` now shows Selouna's message in its own bordered callout ("Message from Selouna") wherever `admin_message` is set — countered, declined, wherever — right after the staff member's own note (now labeled "Your note" for clarity now that there are two messages on the same card).

**Audit Log**: `admin_message` gets a friendly label ("Message to staff") instead of falling through to the generic snake_case-to-title-case fallback.

`npx tsc --noEmit -p tsconfig.json` passes clean.

## Session Handoff — 2026-09-20 (cont. 11): Counter message moved from inline to its own modal

Revised the previous entry per feedback — Send Counter's optional message wasn't wanted inline in the expanded row; both Send Counter and Decline now open a confirmation modal instead, matching each other exactly:

- Clicking **Send Counter** (still only enabled once qty/dates actually differ from the original ask — that check is unchanged) opens "Send counter to {staff}?" with an optional message box, **Close** and **Send Counter** buttons. Confirming calls `sendCounter()` with the row's already-edited draft lines/dates plus whatever was typed in the modal.
- Clicking **Decline** opens "Decline this request?" with an optional message box, **Close** and a destructive **Decline** button. (Renamed its dismiss button from "Cancel" to "Close" to match.)

The inline "Message to {staff}" `Textarea` that used to sit in the expanded row is gone — `Draft` no longer carries a `message` field, and `isDirty()` is back to checking only qty/date changes (a message no longer affects whether Send Counter is enabled; it's decided in the modal at send-time instead). Two new bits of local state carry the modal's own message: `countering`/`counterMessage`/`counterBusy` alongside the existing `declining`/`declineMessage`/`declineBusy`.

Everything from the previous entry underneath this (the `admin_message` field itself, both functions' signatures, the portal display, the audit-log label) is unchanged — only how the message gets typed changed.

`npx tsc --noEmit -p tsconfig.json` passes clean.

## Session Handoff — 2026-09-20 (cont. 12): Sent Counters tab is now read-only, decline-only, with a full audit snapshot

The "Sent Counters" tab (`loan-requests/page.tsx`) previously reused the exact same fully-editable expanded row as "Needs Review" — Selouna could still adjust quantities/dates and re-send another counter, or Approve as-is, on a request she'd already countered. That's gone: expanding a countered row now shows a new read-only `CounteredRow` instead of the editable one, and the only action left is **Decline**.

**`CounteredRow`** shows, in order: the staff member's original message (`r.message`) if any; the countered window (`formatLendWindow(r.from_date, r.to_date)`, with a note underneath if it differs from `r.original_from_date`/`r.original_to_date`); a per-line table of Requested vs. Counter Offer (an item Selouna zeroed out shows as "Removed" instead of a quantity); and her own counter message (`r.admin_message`) if any — then just the Decline button. `toggleExpand()` no longer builds a `Draft`/fetches availability for a 'countered' request at all (nothing there to edit), only for 'pending' ones.

**Audit trail on decline of a counter**: declining wipes out the whole counter offer from the live document the moment status flips to 'declined' — so `declineRequest()` (`loanRequests.ts`) now takes the request's `LoanRequestLine[]` as a new parameter and, only when `request.status === 'countered'` at the moment of decline, freezes `staff_message`, `counter_message` (the admin_message as it stood *before* this decline overwrites it), and `countered_lines` (product name + requested vs. offered qty per line) into the audit entry's `after` payload, alongside the decline's own new `admin_message`. A decline of a still-*pending* request is unaffected — nothing to freeze yet, so none of these extra fields get added.

**Audit Log page**: `LoanRequestSummary` gained a second rich-rendering branch (alongside the existing 'create' entry summary) that fires whenever `after.countered_lines` is an array — rendering staff's message, the requested/offered/removed line list, Selouna's counter message, and her decline message all together, instead of falling through to the generic `FieldDiff` (which would've shown the lines array as unreadable `[object Object]` text). Every other loan_request update entry (accept, expire, no-show, withdraw, decline of a still-pending request) is untouched and still uses `FieldDiff` as before.

`npx tsc --noEmit -p tsconfig.json` passes clean.

## Session Handoff — 2026-09-20 (cont. 13): Comprehensive demo-data seed script

Added `scripts/seed-comprehensive-demo.mjs` (`npm run seed:comprehensive`) — a single script that populates the emulator with essentially every distinct status/badge/label the app can show, so the whole thing can be inspected in one sitting rather than piecing it together from the six narrower `seed:*` scripts:

- **Dashboard**: all Outstanding Returns badges (No Return Date/Overdue/Due Today/Not Due Yet/Partly Resolved/Mixed, plus a still-overdue partial return), all Incoming Pickups badges (On Schedule, Insufficient ×2 — one with a correlated overdue "likely cause", one hitting the fallback message — and Not Picked Up, both a live-transition example and an already-recorded one), and both Low Stock Alerts badges.
- **Loan Requests**: every `LoanRequestStatus` with a realistic audit trail behind it — pending (fresh + near its 30-day expiry), countered (a rich one with a removed line, both sides' optional messages, and a date change; a plain one with none of that), accepted, fulfilled (a full pending → countered → accepted-by-staff → fulfilled history on one request, linked to its Stock Out via `linked_request_id`), declined (by Selouna from pending, by Selouna from an already-sent counter — exercising the decline-of-a-counter rich audit snapshot built earlier this session — and by the staff member themselves via the portal's `declineCounter`), expired, no_show, and withdrawn (staff, no reason; Selouna cancelling an accepted pickup, with one).
- **Reports**: IN/OUT/RETURN/ADJUST transactions (ADJUST has no real UI flow today, seeded directly for the filter dropdown's sake — see below) across ~20 "Demo —" staff members, plus a fully-returned and a partially-returned OUT pair.
- **Audit Log**: at least one entry for every entity_type/action combination any real code path in the app actually produces — product/category/staff create+update+activate+deactivate, transaction create+resolve, and the full loan_request lifecycle above.

Deliberately NOT seeded: `AuditAction` `'delete'` and `AuditEntityType` `'return_waiver'` — both are declared in `types/database.ts` but no button anywhere in the app triggers either one today (no product/category delete flow exists; a resolved return is always logged against the *transaction* it originated from, per `waivers.ts`, never as its own `return_waiver` entity) — there's nothing real to fabricate for them.

Every helper (`recordTxn`, `writeWaiver`, `createLoanRequest`, `writeLoanUpdate`) writes the exact same shape the real `logAudit()` call sites in `loanRequests.ts`/`waivers.ts`/the stock-in/out/returns pages produce, cross-checked line-by-line against those files rather than guessed — including the subtlety that a loan request's `create` audit entry always shows `status: 'pending'` and its *original* dates, even when this script drops the live document straight into a later status. Quantities were hand-traced through `getReservedQuantity`'s actual formula (sums `offered_quantity` across `pending`/`countered`/`accepted` lines, per-window) to make sure the Insufficient-pickup and On-Schedule scenarios land exactly where intended, and the Insufficient-with-cause product's overdue OUT transaction is deliberately the same product as its accepted pickup so the "likely cause" correlation has something real to point at.

Verified with `node --check` and `npx eslint` (both clean) — running it end-to-end against a live emulator wasn't possible from this session (the local `firebase-tools` install is broken/incomplete on this machine, unrelated to this change), so give it a run yourself the first time rather than assuming it's flawless.

## Session Handoff — 2026-09-20 (cont. 14): removed the two unused AuditAction/AuditEntityType values

Following up on the comprehensive seed script above, which needed to explain why it didn't seed examples for `AuditAction`'s `'delete'` and `AuditEntityType`'s `'return_waiver'` — the user asked to just remove both from the app if nothing uses them.

**`'delete'` (AuditAction):** never used anywhere — no product/category/staff/transaction delete flow exists in this app at all, and nothing in the codebase or `handout.md`'s history shows it ever having been wired up. Removed outright.

**`'return_waiver'` (AuditEntityType):** more nuanced — an earlier session (see "resolving a return now logs against the Transaction entity, not a separate 'Return Waiver' one" above) explicitly *kept* this value in the type/`ENTITY_LABEL`/filter dropdown after moving new resolves onto the `transaction` entity, specifically so any historical audit entries already written with `entity_type: 'return_waiver'` would still show a friendly label and stay filterable. Flagged this history to the user before touching it — confirmed there's no real/production data depending on it (dev/emulator only), so removed it too. If that ever turns out to be wrong, the fix is to re-add `'return_waiver'` to the `AuditEntityType` union and the two lookups below — nothing else references it.

**Changes:**
- `types/database.ts` — `AuditAction`/`AuditEntityType` unions no longer include `'delete'`/`'return_waiver'`.
- `audit-log/page.tsx` — removed both from `ACTION_BADGE_CLASS`/`ENTITY_LABEL`, and their entries from the Action/Entity filter dropdowns (both the `Select`'s `items` map and the corresponding `SelectItem`).
- `scripts/seed-comprehensive-demo.mjs` — updated its doc comment and closing summary, which previously explained why these two were deliberately left unseeded (they're gone now, so there's nothing left to explain).

`npx tsc --noEmit -p tsconfig.json` passes clean.

## Session Handoff — 2026-09-20 (cont. 15): seed:comprehensive now provisions Auth logins too

User hit `Firebase: Error (auth/user-not-found)` logging into the BICS login page as `admin@nwu.test` after running only `npm run seed:comprehensive`. Root cause: unlike `seed-emulator.mjs`/`seed-lending-portal.mjs`, the comprehensive script only ever wrote Firestore documents — it never created any Firebase Auth accounts, so there was no login for the app's client-side Firebase Auth to find. Products/categories/staff/loan requests/audit log were never the gap; it was purely the Auth side. Asked to fix this so `npm run seed:comprehensive` alone is sufficient to run the whole app — no other seed script needed first.

**Changes to `scripts/seed-comprehensive-demo.mjs`:**
- Added `FIREBASE_AUTH_EMULATOR_HOST` env default (`127.0.0.1:9099`) alongside the existing Firestore one, and imported/initialized `getAuth(app)`.
- Added an `upsertUser(email, password, uid)` helper (get-or-create against the Auth emulator, same pattern as the other seed scripts).
- New **Section 0: LOGINS**, first thing `main()` does:
  - Creates `admin@nwu.test` / `password123` (uid `seed-admin`) and writes its `profiles/{uid}` doc with `role: 'admin'` — this is the BICS admin login.
  - Creates `demo.portallinked@example.com` / `password123` (uid `seed-demo-portallinked-uid`) — a portal-borrower login with no `profiles` doc, matching the two-role model (a portal borrower is just a `staff` record whose `uid` matches their Auth uid).
- Right after the existing `S.PortalLinked` staff record is set up (Section 2), added `.update({ uid: portalBorrowerUser.uid })` on that staff doc so it's genuinely linked to a real Auth account — previously that scenario's "portal access granted" audit entry recorded a `uid` string that didn't correspond to any real login.
- Console summary now prints both credential sets and their sign-in URLs first, before the existing per-tab walkthrough notes.

Verified with `node --check` and `npx eslint` (both clean) — same live-emulator caveat as cont. 13: this session can't run the emulator itself (broken local `firebase-tools` install, pre-existing and unrelated to this work), so this hasn't been exercised end-to-end. `upsertUser`'s get-or-create means re-running the script is still safe for the Auth accounts themselves, though re-running will add a second batch of ledger/loan-request/audit data same as before.

`node --check scripts/seed-comprehensive-demo.mjs` and `npx eslint scripts/seed-comprehensive-demo.mjs` both pass clean.

## Session Handoff — 2026-09-26: Audit Log — sortable columns, pagination, and CSV export

Long-term goal for this stretch of work: make the Audit Log analysable for a formal audit, per Selouna's needs.

**Sortable columns + pagination** (`audit-log/page.tsx`): added the same TanStack-Table-driven sortable column headers and 10/20/All pagination already used on the Reports page's four tabs (Date, User, Activity, Entity, Entity ID — all sortable). To avoid duplicating that machinery a third time, extracted the shared pieces out of `reports/page.tsx` into a new module, **`src/components/data-table-helpers.tsx`**: `SORTABLE_TABLE_FEATURES`/`sortableColumnHelper` (the TanStack Table instance and column helper — used purely as a sort-order engine, never `FlexRender`; every row still renders through the page's own JSX), `SortableHead` (clickable header, cycles unsorted → asc → desc), `PageSize`/`pageCountFor`/`paginate`/`TablePagination` (10/20/All rows-per-page + Previous/Next), and `ExportCsvButton` (see below). `reports/page.tsx` now imports the same helpers (aliased `SORTABLE_TABLE_FEATURES as REPORT_TABLE_FEATURES`, `sortableColumnHelper as columnHelper`) instead of its own copies.

**CSV export**: added an Export CSV button next to the filters. Since it wasn't obvious from the request alone how much detail Selouna needed in the export, asked her directly — she confirmed she wants the raw Before + After JSON detail, not just a friendly on-screen-style summary, so the exported rows carry the same before/after snapshots the raw-data expand view shows (this shape changed several times over the rest of the day — see below). Uses the existing `downloadCsv()` in `lib/utils.ts` (already-correct RFC-4180-ish escaping, including embedded newlines, so no changes needed there).

`npx tsc --noEmit` clean; `npx eslint` shows only the pre-existing baseline (`@typescript-eslint/no-explicit-any` throughout, 1 pre-existing `react-hooks/set-state-in-effect`) — no new categories.

## Session Handoff — 2026-09-26 (cont. 1): root-caused a demo audit entry that didn't say which item was involved

Selouna noticed a Stock Out audit entry for a single item didn't say anywhere in its After raw data *which* item it was — screenshotted an example. Traced it: the real write paths (Stock In/Out/Returns pages) already freeze the transaction's `lines` (product id/name/quantity) into the audit entry's `after` snapshot as of an earlier commit — but this was a demo entry written by `scripts/seed-comprehensive-demo.mjs`'s *own*, separate `writeAudit()` helper inside `recordTxn()`, which had never been updated to match that change. Confirmed the root cause with the user (yes — bad data from `npm run seed:comprehensive`, not a live-app bug) before fixing it.

**Fix**: `recordTxn()` in `scripts/seed-comprehensive-demo.mjs` now freezes the same `lines: items.map(i => ({ product_id, product_name, quantity }))` (plus `line_count`/`total_qty`) into its `after` payload that the real app writes, so every transaction the comprehensive seed produces matches the real shape going forward. Existing emulator data written before this fix is still wrong (audit_log is append-only — nothing retroactively fixes old entries at the source), which is exactly why the next entry below takes a display-time approach instead.

## Session Handoff — 2026-09-26 (cont. 2): canonical field order for raw before/after JSON, and several rounds of CSV "After" formatting

Selouna compared the raw-data view of a product **update** entry against a product **create** entry and noticed the JSON fields weren't in the same order between the two — asked for that to be fixed everywhere, and to be told which entities had the same inconsistency for the same activity.

**Investigation**: checked every real write path (product/category/staff/transaction/loan_request across the whole app) plus every seed script for what fields each actually writes and in what order. Since `audit_log` is append-only, no amount of fixing write paths could ever retroactively reorder already-written historical/seed data — so rather than rewriting several files, implemented **display-time normalization** instead, which fixes both future and all past data uniformly:

- **`AUDIT_FIELD_ORDER: Record<string, string[]>`** (`audit-log/page.tsx`) — the canonical field order per entity, keyed by `entity_type`, except `staff` and `transaction` which are split further by *action* (`staff:record` / `staff:status` / `staff:access`, `transaction:record` / `transaction:resolve`) because their field vocabulary genuinely differs by action, not just its order.
- **`auditFieldOrderKey(entityType, action)`** — picks the right key above.
- **`reorderForDisplay(entityType, action, obj)`** — rebuilds an object with keys in that canonical order (any field not listed falls back to its original position, so nothing silently disappears if the write path ever adds a new field).

Applied uniformly to both the on-screen raw-data `<pre>` JSON blocks and the CSV export, so the two always read consistently no matter when the underlying entry was written.

**CSV "After" column — several rounds of refinement**, each a direct response to Selouna trying the export and coming back with feedback:
1. Dropped the CSV's **Before** column entirely — she only wants After; with field order now consistent, she can tell what changed between transactions without a separate Before/After diff in the file itself.
2. First pass at "not JSON, one line" formatting: `flattenAfterForCsv()`/`flattenValueForCsv()` (new helpers) turned each entry's After snapshot into `"key: value | key: value | ..."`, reusing the existing `friendlyValue()` formatter for dates/booleans/statuses (array line-items render as `"Product × qty"`, nested objects as `"k: v, k: v"`).
3. Field *labels* switched from the friendly on-screen labels (e.g. "Reference") to the raw JSON key names (`reference_no`) — so the CSV cross-references cleanly against the raw-data JSON view instead of using two different vocabularies for the same field.
4. Asked which of three concrete layouts she wanted for the After cell (single "|"-joined line / one field per line via embedded newlines / a hybrid) — she picked one-field-per-line: `downloadCsv()`'s existing quoting already handles embedded newlines correctly, so this stays one CSV cell that Excel renders as a multi-line "card" with Wrap Text on.
5. Final tweak: keep a trailing `" |"` on every line in addition to the line break, so each line reads `key: value |` — the pipe look she's used to, plus the line break doing the actual visual separation.
6. Renamed the export column header from **"After"** to **"Details"**, since by this point it's a formatted, flattened rendering rather than a literal dump of the `after` field.

**Advisory only, no code** — also walked Selouna through two related questions, in-chat rather than in the app: (a) why a `.csv` she'd already saved and reopened came back corrupted (Excel had re-saved it with a regional semicolon delimiter, splitting Date's internal comma across columns — confirmed the export's own CSV was fine; the corruption happened after the fact in Excel) and how to re-export cleanly and turn it into a proper Excel Table + PivotTable/filters for an audit; (b) whether Excel can do a "pivot with expandable detail rows" — explained PivotTable drill-through and column Grouping/Outline as the closest equivalents, being upfront that Excel has no native per-row expand/collapse toggle.

`npx tsc --noEmit` clean at every step; `npx eslint` never introduced a new warning category beyond the pre-existing baseline.

## Session Handoff — 2026-09-26 (cont. 3): sidebar logo — two attempts, the first didn't work

Replaced the "BICS" bullet + text lockup at the top of `Sidebar.tsx`'s `SidebarHeader` with the actual SmartStock-NWU logo the user supplied.

**First attempt**: downscaled the source artwork (a 2048×2048 JPG — a rounded purple-bordered square containing the "S" icon and the "SmartStock-NWU" wordmark) to 480×480, saved as `public/smartstock-nwu-logo.png`, and rendered it with `next/image` (the first use of `next/image` anywhere in this codebase — every other image reference is a plain `<img>` or absent) directly in the header, in place of the old text.

**That didn't work** — Selouna flagged it looked bad, screenshotted it: the logo's own white background rendered as a plain white square butted directly up against the purple sidebar. Investigated properly before just stripping the white background to transparent: the logo's *darkest* purple turns out to be `#6C3D91` — the exact same NWU brand purple as `--sidebar` in `globals.css`. A transparent-background version was tried first (background keyed to alpha via a min-channel threshold) but made the mark itself nearly disappear into the identically-coloured sidebar rather than fixing anything, confirmed against a rendered preview before touching the component.

**Actual fix**: re-cropped the source artwork tighter (trimmed the large outer white margin around the bordered box, using an eroded near-white pixel mask to ignore JPEG noise in the margin rather than a naive threshold) but *kept* its white background, then wrapped it in a small white rounded card in the sidebar itself — `rounded-xl bg-white p-2.5 shadow-sm` — so the white now reads as a deliberate logo badge rather than an artifact of the source image. `public/smartstock-nwu-logo.png` now holds this re-cropped 640×512 version. Rendered and eyeballed a composite preview (logo over the actual sidebar purple) before committing, to confirm it actually looked right this time rather than guessing again.

`npx tsc --noEmit` clean both times; `npx eslint` unchanged from this file's pre-existing 2 `react-hooks/exhaustive-deps` warnings (both in unrelated `useEffect` dependency arrays this work never touched).

## Session Handoff — 2026-09-28: sign-in "hang" fixed, and the guest cart survives the login detour

Selouna reported sign-in "hanging" after the guest —> cart —> login redirect flow. It wasn't actually hung — dev-server logs showed it completing — the real problem was **`routeSignedInUser`** (`(auth)/login/page.tsx`) doing two Firestore reads (`profiles/{uid}`, then a `staff` query) **sequentially**, which read as a hang on a slower connection. Fixed by running both with `Promise.all`.

While investigating, found a real bug alongside it: a guest who adds items to the portal cart and then has to detour through `/login` (Requests/Profile are gated) lost their cart entirely, because `PortalCartContext` was deliberately in-memory-only (a prior code comment cited `LENDING_PORTAL_SPEC.md` —5.2 for this). Confirmed with Selouna that keeping the cart across that detour was wanted, overriding that comment. **Fix**: `PortalCartContext.tsx` now persists to `sessionStorage` (hydrated on mount behind a `eslint-disable-next-line react-hooks/set-state-in-effect`, justified since it's syncing from an external system and a lazy initializer would risk an SSR/hydration mismatch), and the login page now accepts a `?next=` param (validated to start with `/lend`) so `/lend/cart`'s and `PortalShell`'s guest-redirect effects can send the user back to the exact page they were on — without submitting anything on their behalf.

`npx tsc --noEmit` and `npx eslint` on the touched files both came back clean.

## Session Handoff — 2026-09-28 (cont. 1): portal sign-out now goes to `/`, and the 404 page's button matches true admin status

Two small UX fixes, both explicitly requested:

- **Portal sign-out** (`PortalShell`'s `handleSignOut`, `(portal)/lend/layout.tsx`) now redirects to `/` instead of `/login`. BICS admin sign-out (`Sidebar.tsx`'s `handleLogout`) deliberately still goes to `/login` — that's a different audience and was left alone.
- **404 page** (`not-found.tsx`): the "back" button used to always say "Back to Lending Portal" regardless of who was signed in. It now checks the real signed-in role (`profile?.role === 'admin'`) and shows "Back to Dashboard" `->` `/dashboard` for true admins, "Back to Lending Portal" `->` `/lend` for everyone else (including guests) — the full BICS shell only renders for confirmed admins, so a staff/guest 404 stays lightweight.

## Session Handoff — 2026-09-28 (cont. 2): product image seeding — `npm run seed:comprehensive` now gives every product 1—3 images

Requested: every seeded product should get at least one image, some two, some three. `scripts/seed-comprehensive-demo.mjs` now generates simple placeholder SVGs (`placeholderSvg()`, drawing from a small colour `IMAGE_PALETTE` keyed off the product name) and uploads 1—3 of them per product to the Storage emulator via `seedProductImages(productId, productName)` (cycles `imageSeq % 3 + 1`), wiring the resulting URLs into both the create and update branches of `upsertProduct()`. Needed `getStorage`/`FIREBASE_STORAGE_EMULATOR_HOST` added to the script.

## Session Handoff — 2026-09-28 (cont. 3): Storage emulator startup fix, and root-caused a "cannot log in to any seeded account" bug

**Storage emulator wouldn't start**: `npm run emulators` failed with "Cannot start the Storage emulator without rules file specified in firebase.json." Created **`storage.rules`** (mirrored exactly from the *live* `smartstock-nwu` project's deployed rules via the Firebase MCP server — public read on `products/{productId}/{fileName}`, admin-only write with a role check + 5MB size cap + image-content-type check, admin-only delete, deny-all fallback) and added a `"storage"` key to `firebase.json`.

**Then: still couldn't log in to any emulator-seeded account** (`demo.portallinked@example.com`, `admin@nwu.test`) even after switching to `npm run dev:emulators` and confirming Firestore had all the seeded data. Root-caused with Playwright MCP + the Firebase MCP server's Auth-emulator admin REST endpoints (`accounts:lookup`, etc. — these bypass normal project resolution): the Firebase CLI's **cached "active project" for this directory** had been silently switched to the real `smartstock-nwu` project by earlier (legitimate) `firebase_update_environment` calls made for live-rules-deployment work. In `singleProjectMode`, the Auth emulator's *public* client-facing endpoints (`accounts:signUp`, `accounts:signInWithPassword`) resolve their project from that CLI cache, not from the API key in the request — while Firestore/Storage and the seed script (which set `projectId` explicitly) correctly kept using `demo-smartstock-nwu`. So Auth was silently checking a different, empty project. **Fix**: pinned `package.json`'s `"emulators"` script to `firebase emulators:start --project demo-smartstock-nwu`, which makes local sign-in immune to this going forward regardless of what the Firebase MCP server's active project gets set to later.

## Session Handoff — 2026-09-28 (cont. 4): new Admin Profile page — avatar menu, self-service details, and Selouna's own borrower record

Requested: an Avatar at the bottom of the admin sidebar with Profile/Sign out options; an admin able to update her own email, password, name, surname, department and card UID (so she can take out stock for herself too); admins can still update other staff's details; staff can still only change their own password.

- **`Sidebar.tsx`**: footer replaced with a `DropdownMenu` — an `Avatar`/`AvatarFallback` (initials from `profile.full_name` via new `nameInitials()` in `lib/utils.ts`) plus name and role badge as the trigger, opening **Profile** (`->` `/profile`) and **Sign out**.
- **`(protected)/profile/page.tsx`** (new): "My details" card upserts Selouna's own **`staff`** document (name/surname/department/card UID) — the same collection Stock Out draws borrowers from exclusively, so this is what lets her be selected as a borrower there. Her staff record is flagged `is_admin_account: true` (new field on `StaffMember`) and the Staff management page's `load()` now filters those out, so it doesn't clutter the real staff/borrower list. Also has a "Change email" card and a "Change password" card.
- Since `firestore.rules` blocks all client writes to `profiles` (`allow write: if false`), a new admin-only API route, **`/api/admin/update-name`**, does the Admin-SDK write to keep `profiles/{uid}.full_name` — what the sidebar and every audit-log "operator name" actually display — in sync with what she types on this page. `AuthContext.tsx` gained a `refreshProfile()` method so the change reflects everywhere immediately, without a reload.

`npx tsc --noEmit` and `npx eslint` both pass clean across every file touched by this feature.

## Session Handoff — 2026-09-28 (cont. 5): admin's own email change is now confirmation-first

Follow-up question from Selouna: does an email change get checked for legitimacy before it's applied? Answer was no — both her own self-service change and the Staff-page admin-editing-someone-else's-email flow only validated format + uniqueness (Firebase Auth), with no check that the address actually exists or receives mail. She asked for a confirmation-email step, but **only for her own (admin) email change** — staff email changes made by her on the Staff page stay immediate/unverified, since a staff member who doesn't get an expected email can just tell her.

**`ChangeEmailCard`** (`(protected)/profile/page.tsx`) now calls `verifyBeforeUpdateEmail()` instead of `updateEmail()`. This sends a confirmation link to the *new* address and leaves the account's email untouched until she clicks it — so a typo'd address just never confirms, and she's never locked out of the account itself. The card shows a "confirmation sent" notice plus an "I've clicked the link — check now" button, which calls `auth.currentUser.reload()` and, once the reloaded email matches the pending one, updates the UI and syncs her `staff` doc's email (same as the existing flow).

`npx tsc --noEmit` and `npx eslint` both clean.

## Session Handoff — 2026-09-28 (cont. 6): Products table — a long barcode was stretching the table past the viewport again

Same family of bug as the earlier "Product cell" fix and the September 19 "every table now scrolls instead of growing" work, just a column that hadn't been touched yet: a very long barcode has no spaces at all, and `TableCell` is `whitespace-nowrap` by default, so it rendered as one unbroken line and dragged the whole `Products` table wider than the screen instead of wrapping.

**Fix** (`(protected)/products/page.tsx`, barcode `TableCell`): added `max-w-xs whitespace-normal` on the cell, `break-words` on the barcode text itself, plus `min-w-0` on both the `inline-flex` row and the text span. The `min-w-0` part is the detail that's easy to miss: this cell isn't bare wrapped text like the Product cell, it's an inline-flex row (barcode text + copy-icon button) — a flex item's default `min-width` is `auto`, not `0`, so without `min-w-0` the flex item refuses to shrink no matter what wrapping classes are on the text inside it, and the row (and table) still stretches. Switched the row to `items-start` (was `items-center`) and gave the copy button `shrink-0` so it stays a fixed size and sits next to the first line rather than drifting to the vertical center of a multi-line wrapped barcode.

Asked, again, what else in the app is exposed to the same failure mode — see the reply in-chat; nothing further changed yet, this is a list of what to check the next time it comes up.

`npx tsc --noEmit` and `npx eslint` on the touched file both clean (the file's existing baseline — `@typescript-eslint/no-explicit-any` and one `set-state-in-effect` in its `load()` effects — is untouched and unrelated to this cell).

## Session Handoff — 2026-09-28 (cont. 7): the same table-overflow fix applied everywhere else in the app

Asked what else could hit the same "long unbroken value stretches the table past the viewport" bug as the barcode fix above. Audited every `TableCell` (and a couple of non-table lookalikes) across the whole app for free text with no length cap and no wrap protection, then applied the same treatment — `max-w-xs whitespace-normal break-words` on plain cells, plus `min-w-0` on the container and `shrink-0` on any icon/button for flex-row cells — everywhere it was missing. Deliberately did **not** add `maxLength` to any input; this is a display-only fix.

Files touched: `audit-log/page.tsx` (`user_name`), `categories/page.tsx` (`name` — flex/icon case, `description`), `dashboard/page.tsx` (Outstanding's `product_name`/`staff_name`, Incoming Pickups' `staff_name`+`reference_no`, Low Stock's `name`), `loan-requests/page.tsx` (`product_name` in both `EditableRow` and `CounteredRow` — same JSX duplicated across two functions, not a shared component, so fixed in both places; `staff_name`+`reference_no`), `reports/page.tsx` (all four sub-reports: Stock Levels' and Low Stock's `name`/`category_name`, Issued per Staff's `full_name`/`department`/`reference_no`/`product_name`, the Returns report's `reference_no`/`staff_name`/`linked_txn_ref`), `returns/page.tsx` (Items table's `product_name`/`txn_ref`, plus the "Select Staff Member" search-dialog list), `staff/page.tsx` (`full_name`/`email`, `department`, and the expanded "Currently held by" sub-table's `product_name`), `stock-in/page.tsx` (cart's `product.name`), `stock-out/page.tsx` (cart's `product.name`/barcode, the Confirm step's `product.name`, the "Select Staff Member" dialog list — same JSX duplicated verbatim between `returns/page.tsx` and here, and the two staff-summary `full_name`/`department` lines outside any table).

**One case needed a genuinely different fix, not just the same classes**: the Staff page's Card UID `Badge`. `Badge` is deliberately a fixed-height (`h-5`), `overflow-hidden`, non-wrapping pill (see `components/ui/badge.tsx`) — letting it wrap like a normal text cell would either distort its shape or silently clip the extra lines behind `overflow-hidden`, which is worse than the original bug since the value would just disappear rather than merely stretching the table. Used `max-w-full` + `truncate` (ellipsis) instead, with `title={s.card_uid}` so the full value is still available on hover. Worth remembering as the general rule: **wrap for free-flowing text cells, truncate-with-tooltip for anything that has to stay a fixed-size pill/badge.**

`npx tsc --noEmit` clean; `npx eslint` across all nine files shows zero new error/warning categories beyond the existing baseline (`@typescript-eslint/no-explicit-any` throughout, a handful of pre-existing `set-state-in-effect`/`exhaustive-deps` in each page's `load()` effects, and a few unrelated pre-existing issues — a stale eslint-disable comment in `dashboard.tsx`, a hoisting order issue and two short-circuit-expression lints in `returns`/`stock-in`/`stock-out` — all confirmed to sit on lines this change never touched).

## Session Handoff — 2026-09-28 (cont. 8): the barcode STILL wasn't wrapping — `break-words` was never going to work there, switched the token fields to `break-all`

Selouna tested cont. 6/7's fix with a genuinely long barcode and it still didn't wrap. Real root cause, not just another patch: **`overflow-wrap: break-word` (Tailwind's `break-words`) is explicitly excluded from min-content sizing per the CSS Text spec** — browsers are told to compute a box's intrinsic (min-content) size *as if* `overflow-wrap` were `normal`, even though it still allows the actual line-break at render time. That's invisible for a plain block of wrapped text (the Product name/description cell, Staff's name/department, etc.): `max-w-xs` pins the column's rendered width as a hard constraint regardless of intrinsic sizing, and once that width is resolved, `break-words` wraps inside it just fine. But the barcode and Card UID cells aren't plain text — they're an `inline-flex` row (text + an icon/button), and flex layout has to work out how far each item is *allowed to shrink* before it can even get to a resolved width. `break-words`' min-content for an unbroken token is "however long the whole token is," so the flex row never shrinks in the first place, and wrapping never triggers, no matter how much `min-w-0`/`max-w-xs` surrounds it.

`word-break: break-all` (Tailwind's `break-all`) has no such spec carve-out — it genuinely participates in min-content sizing, so it actually forces the break once a column's width is reached. **Fix**: switched every genuinely spaceless-token field — the ones that can never rely on a natural space to wrap at — from `break-words` to `break-all`: Products' barcode, Staff's Card UID, and (proactively, since they're the same risk class) every `reference_no`/`txn_ref`/`linked_txn_ref` and `email` field touched in cont. 7 (`dashboard`, `loan-requests`, `reports`, `returns`, `stock-out`, `staff`). Natural-language fields (names, departments, categories, descriptions) were left on `break-words`, since normal prose already has spaces to wrap at and `break-all` can produce uglier mid-word breaks with no upside there.

**Staff's Card UID also changed from truncate-with-tooltip to actually wrapping**, per Selouna's preference for consistency with the barcode: `Badge` is a fixed-height (`h-5`), `overflow-hidden` pill by default (`components/ui/badge.tsx`), so this instance now overrides that (`h-auto max-w-full items-start overflow-visible whitespace-normal`) so a long UID wraps onto a second line and the pill grows taller, instead of either clipping it or truncating it away.

**The general rule going forward**: any cell holding a value that can legitimately be one long run with no spaces — barcodes, UIDs, reference numbers, emails, tokens, hashes, URLs — needs `break-all`, not `break-words`, especially if it sits inside a flex row (an icon or button alongside the text). Plain prose keeps `break-words`.

`npx tsc --noEmit` clean; `npx eslint` across all seven touched files shows the same pre-existing baseline as cont. 7, zero new categories.

## Session Handoff — 2026-09-28 (cont. 9): Add/Edit Product dialog — Barcodes moved below Photos, and a long barcode no longer stretches the whole dialog

Two related requests: move the "Barcodes" section to sit below "Photos" in the left column (it was in the right column, alongside "Product availability"), and stop a long barcode chip from giving the *whole dialog* a horizontal scrollbar.

**Reorder**: `(protected)/products/page.tsx`'s Add/Edit dialog is a two-column grid. Moved the entire Barcodes block (heading, the drag-to-reorder chip list, the add-barcode input row) out of the right column and in right after the Photos field group in the left column. The right column now holds only "Product availability" (dates, lending interval, Availability select).

**The scrollbar fix, and why it needed more than a class swap**: each barcode chip is a `flex` row (drag handle + code text + optional "Primary" badge + remove button). The code text was `<span className="flex-1 truncate">` — `truncate` alone doesn't help here for the same reason covered in cont. 6/7/8: a flex item's default `min-width` is `auto` (its content's full width), so without `min-w-0` the item refuses to shrink at all, and the row (and therefore the dialog) stretches to fit the whole barcode regardless of `truncate`. Fixed by adding `min-w-0` -- but rather than truncating the barcode away with an ellipsis, replaced it with a **small scrollable box** (`overflow-x-auto` + `whitespace-nowrap` on an inner span) so a long barcode gets its own tiny horizontal scrollbar local to that one chip, and the dialog itself never needs one. This is what "the whole card doesn't get a horizontal scrollbar" meant in practice: push the overflow handling down to the smallest possible container instead of letting it bubble up.

`npx tsc --noEmit` clean; `npx eslint` shows only the file's existing baseline (`@typescript-eslint/no-explicit-any`, a couple of pre-existing `set-state-in-effect`/`exhaustive-deps` in `load()`, one pre-existing unescaped-apostrophe warning elsewhere in the file) — no new categories.

## Session Handoff — 2026-09-28 (cont. 10): cont. 9's scrollbar fix was incomplete — the whole dialog was still stretching, traced to the shared Dialog component itself

Selouna tested cont. 9 with a genuinely long barcode and the DIALOG (not just the chip) still grew wide enough to give the browser itself a horizontal scrollbar, with content visibly spilling past the card's right edge. The single `min-w-0` added to the chip's text wrapper was necessary but nowhere near sufficient.

**Root cause, traced all the way up**: `min-width: auto` (a flex or grid item's "automatic minimum size," which defaults to its content's own min/max-content) doesn't stop at the nearest flex row — it bubbles up through *every* flex or grid boundary between the overflowing content and the first ancestor that isn't itself a flex/grid item, unless each one explicitly overrides it with `min-w-0`. Missing even one level anywhere in that chain means the content's width still reaches all the way to the top. Traced the actual chain for the barcode chip and found FOUR more missing links above the one already fixed in cont. 9:

1. The chip row itself (`flex items-center gap-2 ...`) — a flex item of the chip list.
2. The chip list (`Droppable`'s own `flex flex-col gap-1.5` div) — a grid item of the Barcodes field wrapper.
3. The Barcodes field wrapper (`<div className="grid gap-1.5">`) — a flex item of the left column.
4. The left column itself (`<div className="flex flex-col gap-3">`) — a grid item of the dialog's two-column layout.

And the one that actually explains why the *whole dialog* was affected, not just the left column: **`components/ui/dialog.tsx`'s `DialogPrimitive.Popup`** (the dialog card itself) is a flex item of its own centering wrapper (`<div className="fixed inset-0 ... flex items-center justify-center p-4">`, a deliberate transform-free centering trick documented in that file). Per the CSS sizing spec, a flex item's automatic minimum size **wins over its `max-width`** when the two conflict — so even with `sm:max-w-[820px]` set, the popup's own `min-width: auto` (fed by the barcode's content bubbling all the way up through the four links above) could still force it wider than 820px. This is a shared component used by every dialog in the app, not something specific to Products, so it's exactly the kind of bug that would eventually resurface anywhere else a dialog holds unbounded content.

**Fix**: added `min-w-0` at all five levels — the four in `(protected)/products/page.tsx` plus `DialogPrimitive.Popup` itself in `components/ui/dialog.tsx` (a genuinely global fix: `min-width: 0` on a `w-full` flex item changes nothing for any dialog that doesn't hit this problem, and closes it off for every dialog that might, going forward). The chip's own `overflow-x-auto` from cont. 9 now actually has a bounded box to compare against, so it finally does what it was meant to: a long barcode gets its own small internal scrollbar, and the dialog itself stays at its intended width.

`npx tsc --noEmit` clean; `npx eslint` on both files shows only the pre-existing baseline, no new issues.

## Session Handoff — 2026-09-28 (cont. 11): Barcodes now spans the full width of the Add/Edit Product dialog

Follow-up to cont. 9/10: instead of living inside the left column (Product details/Photos), Barcodes is now its own top-level section below the two-column grid, spanning the full card width — not confined to half the dialog.

`(protected)/products/page.tsx`: the two-column `grid grid-cols-1 gap-x-8 gap-y-4 md:grid-cols-2` div now holds only "Product details"/Photos (left) and "Product availability" (right); the whole Barcodes block (heading, chip list, add-barcode row) moved out to sit as a direct sibling of that grid, inside the same `<form className="flex flex-col gap-3">`, right before the "Reason for Qty On Hand change" field. Dropped the heading's `mt-2` now that it's spaced by the form's own `gap-3` like every other top-level section, rather than needing extra separation as a sub-section of a column.

The `min-w-0` chain from cont. 10 still applies exactly as before, just one link shorter: the chip's text wrapper, the chip row, and the chip list all still need it (long barcode content still has to not bubble up through those), but the left-column and two-column-grid links are gone since Barcodes no longer nests inside either — it goes straight from its own wrapper into `<form>`, then into the already-fixed `DialogPrimitive.Popup`.

`npx tsc --noEmit` clean; `npx eslint` unchanged from cont. 10's baseline.

---

## Session Handoff — 2026-10-02: Email notifications

Ten more emails now go through the Mailpit mailer (see the Mailpit handoff for how to run it: Docker Desktop, `npm run mailpit`, `npm run dev:emulators`). Spec: `docs/superpowers/specs/2026-10-02-email-notifications-design.md`; plan: `docs/superpowers/plans/2026-10-02-email-notifications.md`.

**What sends, and when** (each is gated by its toggle on Settings → Notifications; only an explicit "off" stops it)
- Staff member: loan request approved, countered, declined; approved pickup cancelled (admin cancels on the Dashboard); counter offer accepted, counter offer declined, request withdrawn (staff, in the portal).
- Admin inbox (the "Admin notification email" on the same Settings page; skipped if blank): new loan request (staff submits), incoming pickup confirmed (request becomes accepted, either approved as-is or after the staff member accepts a counter), low stock (a Stock Out takes a product to or below its reorder threshold or to zero; one email lists all of them).
- **Not built, always off:** loan request expired, overdue return alert, incoming pickup insufficient stock (they need a timer). The Settings page shows "Not implemented yet" and refuses to switch them on.

**How it works**
- Loan-request changes stay client-side as before. After one succeeds, the page calls `notifyLoanRequestEvent()` (`src/lib/firebase/notifyEvent.ts`) in the background; it posts `{ event, requestId, reason? }` to `POST /api/notifications/loan-request`, which re-reads the request, checks who is calling and that the request is in the right state, then sends. A failure shows "Saved, but the email couldn't be sent." and never undoes the action. Low stock is handled by the existing Stock Out route.
- Duplicates are prevented by marker documents in the server-only `sent_notifications` collection (clients cannot read or write it). To make the app resend one email while testing, delete its marker in the emulator UI (http://localhost:4000, Firestore).
- Settings → Notifications has two address cards. "Admin notification address" is where the administrator emails are delivered. "System emails" holds the system sending address: the From header of every email (notifications, Stock Out confirmation, staff login reset), shown as "SmartStock NWU". Until one is saved the field shows the default sender (`no-reply@smartstock.local`, shared by the mailer and the page via `DEFAULT_SYSTEM_EMAIL`); if the stored value is blank or not a plain address, `MAIL_FROM` is used. Stored as `system_from_email`; the administrator address is `admin_notification_email`. A real mail server may reject or spam-filter a From address it is not set up to send for.
- Email buttons link to `APP_BASE_URL` (optional; default `http://localhost:3000`).
- The cancel reason typed on the Dashboard is not stored on the request, so it travels with the notify call.

**Try it** (Docker Desktop running, `npm install` done, `npm run mailpit`, then `npm run dev:emulators`; set the Admin notification address under Settings → Notifications first; read the mail at http://localhost:8025)
1. Portal: submit a request. Admin inbox gets "New loan request".
2. Loan Requests: approve it as-is. Staff gets "approved", admin inbox gets "Pickup confirmed".
3. Submit another and counter it. Staff gets "countered". In the portal accept it: staff gets "counter accepted" and the admin inbox "Pickup confirmed". Do it again and decline the counter: "counter declined".
4. Submit another and decline it as admin: staff gets "declined".
5. Submit another and withdraw it in the portal: "withdrawn".
6. Approve one, then Dashboard, Cancel pickup, with a reason: staff gets "pickup cancelled" with the reason.
7. Stock Out a product down to its reorder threshold: admin inbox gets "Low stock".
8. Turn one toggle off and repeat its action: no email.
9. Try to switch on "Loan request expired": a "not implemented yet" message appears and it stays off.
10. Stop Mailpit and approve a request: the toast "Saved, but the email couldn't be sent." appears and the request is still approved.
11. Under System emails save a sending address, then trigger any email: Mailpit shows it From "SmartStock NWU" at that address, and administrator emails still go to the Admin notification address. Clear the field and Save: it goes back to showing the default sender, and emails come from that.

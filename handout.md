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

### 2. Staff login — resolved auth model (build this before the portal page)
**Decision (resolved, supersedes the earlier open question in this section):** there is no self-service registration. A staff member registers in person at Selouna's office. She adds them via the existing "Add Staff Member" dialog (`src/app/(protected)/staff/page.tsx`), and separately provisions their login on demand via a "Send reset password email" action. Only after they've followed that link and set a password can they log into the lending portal — there's no sign-up form anywhere in this app.

This requires splitting what used to be a single "Add Staff" action into two independent, single-purpose actions, specifically to avoid a partial-failure/retry bug: if "Add Staff" wrote to both Firestore and Firebase Auth in one click, a failure between those two writes would leave an orphaned Auth account, and retrying "Add Staff" would then fail with "email already in use" for a record Selouna believes she's never successfully added. Keeping them separate avoids that entirely, because each action only ever touches one system.

**a. Type change.** Add `uid: string | null` to `StaffMember` in `src/types/database.ts` — the Firebase Auth UID this staff record is linked to, `null` until an account has been provisioned.

**b. "Add Staff Member" stays exactly as it is today** — it only writes the `StaffMember` document to Firestore. Do not create a Firebase Auth account here.

**c. New "Send reset password email" action**, added next to the existing Edit/Deactivate row actions on the Staff page. Must be safely clickable any number of times — clicking it again later (e.g. staff member lost the email, or link expired) should just resend, never error. This has to run server-side via the Admin SDK (the client SDK cannot create an Auth account on behalf of someone else) — add a new route following the same pattern as the existing CAS route (`src/app/api/auth/cas/validate`), e.g. `src/app/api/staff/send-reset-email/route.ts`, taking the staff member's Firestore document ID (not just the email) as input. Logic:

  1. Load the `StaffMember` doc by ID. If its `uid` field is already set, skip straight to step 5 (resend) using that UID's email — this record is already confirmedly linked, no ambiguity.
  2. Otherwise, look up the account by email via the Admin SDK (`getUserByEmail`).
  3. **No account exists for that email:** create one with the Admin SDK (`createUser({ email })`, deliberately no password — the reset email becomes their "set a password" step), write the new UID onto this `StaffMember` document, then go to step 5.
  4. **An account already exists for that email:** query `staff` for `where('uid', '==', <that account's uid>)` before touching anything — this is the check that prevents the edge case below.
     - A *different* staff document already owns that UID → **refuse**. Don't send anything. Surface an error naming the conflicting record, so Selouna can fix the actual data problem (duplicate entry, or an email that's shared/mistyped) instead of a password-reset link going to the wrong person's inbox.
     - *This* staff document owns it, or no staff document owns it yet (an orphaned account) → safe to (re)link: write the UID onto this record if not already set, then go to step 5.
  5. Send the reset email via the client SDK's `sendPasswordResetEmail(auth, email)` (Firebase only auto-sends its built-in template through the client call, not the Admin SDK's link-generation function — the client SDK works fine inside a server route too, it isn't browser-only).

**d. Role separation — don't skip this.** These new Auth accounts are borrowers, not inventory-system operators. They must not end up with an admin/manager/staff `Profile` role or any access to Products, Stock In/Out, Reports, etc. Keep them completely outside the existing RBAC used by the `(protected)` layout — the lending portal (below) needs its own, separate access check, not a reuse of `useRole`/`RoleContext`.

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
3. Staff login provisioning: `uid` field, "Send reset password email" action + API route (section 2 above) — test this thoroughly on its own, including the conflict-refusal path, before building anything that depends on it.
4. Lending portal page, using the login flow from step 3.
5. Stock Out Scan Items integration.
6. Stock Out Confirm prefill + fulfillment write-back.
7. Full walkthrough test: staff logs in and submits a request → Selouna identifies that staff member in Stock Out → sees the requested item in Scan Items → dates prefill in Confirm → confirms → request flips to `fulfilled`.

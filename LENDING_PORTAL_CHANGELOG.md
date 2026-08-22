# Lending Portal — Implementation Changelog

This document details every change made while implementing the staff self-service lending portal, from the initial build through the bug fixes and refinements that followed. It supplements `LENDING_PORTAL_SPEC.md` (the design spec this was built from) with a record of what was actually built, what deviated from the spec and why, and every bug found and fixed along the way.

Branch: `marco`. Commits covered: `547a7d2` through `3e0091f` (7 commits, 31 files, ~7,900 insertions).

---

## Table of contents

1. [Data model](#1-data-model)
2. [Firestore security rules](#2-firestore-security-rules)
3. [Shared logic library — `loanRequests.ts`](#3-shared-logic-library--loanrequeststs)
4. [Role/access control](#4-roleaccess-control)
5. [Selouna's queue — manager-facing review UI](#5-selounas-queue--manager-facing-review-ui)
6. [Staff portal — borrower-facing UI](#6-staff-portal--borrower-facing-ui)
7. [Stock Out integration](#7-stock-out-integration)
8. [Dashboard card](#8-dashboard-card)
9. [Audit log integration](#9-audit-log-integration)
10. [The `AuthContext` bug fix (§2.4)](#10-the-authcontext-bug-fix-24)
11. [Local dev/testing infrastructure](#11-local-devtesting-infrastructure)
12. [Bug fix — Base UI `nativeButton` warning](#12-bug-fix--base-ui-nativebutton-warning)
13. [Feature — clickable product cards / shared preview dialog](#13-feature--clickable-product-cards--shared-preview-dialog)
14. [Bug fix — `storageDownloadUrl` not emulator-aware](#14-bug-fix--storagedownloadurl-not-emulator-aware)
15. [Bug fix — auth loading-state race condition](#15-bug-fix--auth-loading-state-race-condition)
16. [Feature — unified `/login` for both account types](#16-feature--unified-login-for-both-account-types)
17. [Deviations from the original spec](#17-deviations-from-the-original-spec)
18. [What's verified vs. not yet exercised](#18-whats-verified-vs-not-yet-exercised)
19. [Full file list](#19-full-file-list)

---

## 1. Data model

**File:** `src/types/database.ts`

Added the negotiation-workflow types, near the existing `Transaction`/`TransactionLine` interfaces:

```ts
export type LoanRequestStatus =
  | 'pending'    // awaiting Selouna's first review
  | 'countered'  // Selouna proposed changes, awaiting staff accept/decline
  | 'accepted'   // staff accepted (or Selouna approved as-is); awaiting pickup
  | 'declined'   // staff declined a counter — terminal
  | 'expired'    // pending/countered request that blew past its expiry — terminal
  | 'withdrawn'  // staff cancelled a pending/countered/accepted request — terminal
  | 'fulfilled'  // Stock Out issued against it — terminal
  | 'no_show'    // accepted but pickup window passed with nothing issued — terminal

export interface LoanRequest {
  id: string
  staff_id: string
  staff_name: string              // denormalized
  status: LoanRequestStatus
  message: string | null
  from_date: string               // YYYY-MM-DD — mutable, overwritten by Selouna's counter
  to_date: string
  original_from_date: string      // immutable snapshot, set once at submission
  original_to_date: string        // — powers the staff-facing "dates changed" diff view
  created_at: string
  updated_at: string              // expiry is computed FROM this, never stored separately
  fulfilled_txn_id: string | null
}

export interface LoanRequestLine {
  id: string
  request_id: string
  product_id: string              // Product.id.toString() — see note below on Product.id
  product_name: string            // denormalized
  requested_quantity: number      // immutable — what staff originally asked for
  offered_quantity: number        // starts == requested_quantity; Selouna's counter edits this
  created_at: string
}
```

Also:
- Extended `Transaction` with `linked_request_id: string | null` — set when a Stock Out transaction fulfills an accepted loan request.
- Extended `AuditEntityType` from `'product' | 'category' | 'staff' | 'transaction'` to add `'loan_request'`.

**Resolved open question from the spec (§5.5):** the spec explicitly left it open whether `LoanRequest` needs an immutable `original_from_date`/`original_to_date` pair alongside the mutable `from_date`/`to_date`, the same way `requested_quantity`/`offered_quantity` work on lines. Added it — leaving it out would have been inconsistent with the spec's own decision #3 (before/after visibility everywhere in this app). Without it, "My Requests" would have no way to show a staff member that Selouna changed their dates, only that the current dates exist.

**Runtime note discovered during implementation:** `Product.id` and `StaffMember.id` are typed `number` in this codebase, but at runtime they're actually the Firestore string document ID — both collections are created via `addDoc` (random auto-ID), never given an explicit numeric ID. Every place that treats these as numbers goes through `as unknown as X` casts, matching the codebase's existing convention (confirmed in `products/page.tsx`, `staff/page.tsx`). This mattered directly once: the first draft of the Browse page did `Number(d.id)` on a product's Firestore doc ID, which would have produced `NaN` for any product with a non-numeric-looking ID — caught and fixed before it shipped.

---

## 2. Firestore security rules

**New file:** `firestore.rules` (132 lines) — this repo had **no** rules file checked in at all before this work (confirmed via `git log` and `.firebaserc`); `firebase.json` had no `"firestore"` key. Rules were presumably managed via the Firebase Console for whatever real project exists, with no local source of truth. This required drafting rules for every existing collection from scratch, inferred from actual `collection(db, ...)` usage across the codebase, not just the new portal ones.

**`firebase.json`** — added:
```json
"firestore": { "rules": "firestore.rules" }
```

### Rules structure

Helper functions:
- `isSignedIn()` — `request.auth != null`
- `hasBicsRole(roles)` — signed in + has a `profiles/{uid}` doc + its `role` is in the given list
- `isOwnStaffRecord(staffId)` — signed in + the given `staff/{staffId}` doc's `uid` field matches the caller
- `isOwnRequestOwner(requestId)` — the given `loan_requests/{requestId}`'s `staff_id` resolves (via `isOwnStaffRecord`) to the caller
- `affectedKeysOnly(keys)` — used to restrict updates to specific fields only

### Existing BICS collections (rules written from scratch)

| Collection | Read | Write |
|---|---|---|
| `profiles` | own doc only | `false` — Admin SDK only |
| `products` | any signed-in user (BICS **and** portal borrowers — Browse page needs this) | create/delete: admin/manager; update: admin/manager, or staff-role limited to `quantity_on_hand`/`updated_at` only |
| `categories` | admin/manager/staff | admin/manager |
| `staff` | admin/manager/staff, or own record (`uid` match) | admin only (linking itself happens via Admin SDK) |
| `transactions` | admin/manager/staff | create only (admin/manager/staff); update/delete `false` — append-only, confirmed no `updateDoc`/`deleteDoc` anywhere in the app |
| `transaction_lines` | admin/manager/staff | create only, same append-only reasoning |
| `audit_log` | admin only | see below — extended for portal borrowers |

### New portal collections

**`loan_requests`:**
- **Read: any signed-in user**, not scoped to "own requests only." This is a deliberate deviation from a literal reading of spec §2.3 ("a portal borrower can read only requests where staff_id resolves to their own uid") — see [§17](#17-deviations-from-the-original-spec) for why.
- **Create:** only if `staff_id` resolves to the caller's own staff record.
- **Update**, three separate `allow update` blocks (Firestore ORs them):
  1. Admin/manager: unconditional — full transition rights (approve/counter/decline/fulfil/expire/no-show).
  2. BICS staff-role (till operators): narrow — only `accepted→fulfilled` (with `fulfilled_txn_id`), or the lazy `expired`/`no_show` transitions. See [§17](#17-deviations-from-the-original-spec) for why this exists despite spec §2.3 saying staff-role is read-only.
  3. Portal borrower, own request only: only `status`+`updated_at`, only these specific state-machine edges — `countered→accepted/declined`, `pending/countered/accepted→withdrawn`, `pending/countered→expired`, `accepted→no_show`.
- **Delete:** `false`.

**`loan_request_lines`:**
- Read: any signed-in user (same reasoning as `loan_requests`).
- Create: admin/manager, or the request owner (via `isOwnRequestOwner`).
- Update: admin/manager only (`offered_quantity` edits — Selouna's counter).
- Delete: `false`.

**`audit_log`** (extended): create is now `hasBicsRole([...]) || (isSignedIn() && request.resource.data.entity_type == 'loan_request')` — portal borrowers need to write audit entries when their own lazy `expireIfNeeded` call transitions a request (My Requests page triggers this on load, same as Selouna's queue does). Scoped narrowly to `loan_request` entries only — a borrower has no legitimate reason to log anything else.

Catch-all: `match /{document=**} { allow read, write: if false; }`.

No `firestore.indexes.json` was needed — every query in this app (existing and new) is a single-field `where`, consistent with the codebase's "broad read, filter in JS" convention; no composite `where` chains exist anywhere.

---

## 3. Shared logic library — `loanRequests.ts`

**New file:** `src/lib/firebase/loanRequests.ts` (275 lines). This is the one file every UI page depends on.

```ts
getReservedQuantity(productId, fromDate, toDate, excludeRequestId?): Promise<number>
```
Live reservation ledger — no stored "units reserved" counter anywhere (per spec decision #6, a stored counter can drift, a live query can't). Fetches all `loan_requests` with `status in ['pending','countered','accepted']`, fetches all `loan_request_lines` for the given `product_id`, sums `offered_quantity` for lines whose parent request's date range overlaps the candidate range. `excludeRequestId` lets Selouna's own edit-in-progress request not double-count itself.

```ts
validateCartDates(cartItems, fromDate, toDate): Promise<{ valid: boolean; errors: string[] }>
```
Checks: both dates present, `to >= from`, window `<= 7 days`, each product's own `lend_from`/`lend_to` window contains the requested range, and `getReservedQuantity(...) + quantity <= product.quantity_on_hand`. Collects every failing product's error, not just the first.

```ts
computeExpiryDate(request): string | null
isExpired(request): boolean
isNoShowCandidate(request): boolean
expireIfNeeded(request, actor?): Promise<LoanRequestStatus>
```
Implements spec decision #5: expiry = `min(updated_at + 7 days, from_date)`, computed live, only for `pending`/`countered`. `expireIfNeeded` is the "lazy transition" function — every list page (Selouna's queue, My Requests, Dashboard) calls this per request on load; if `isExpired` or `isNoShowCandidate`, it writes the status transition + audit entry and returns the new status, otherwise returns the current status unchanged.

```ts
submitLoanRequest(staffId, staffName, cart, fromDate, toDate, message, actor?): Promise<string>
```
Re-validates via `validateCartDates` immediately before writing (doesn't trust cart-page-cached validation). Writes one `loan_requests` doc + one `loan_request_lines` doc per cart item, `requested_quantity == offered_quantity` at submission. Logs audit.

```ts
approveAsIs(request, lines, actor?): Promise<void>
sendCounter(request, editedLines, newFromDate?, newToDate?, actor?): Promise<void>
declineRequest(request, actor?): Promise<void>
acceptCounter(request, actor?): Promise<void>
declineCounter(request, actor?): Promise<void>
withdrawRequest(request, actor?): Promise<void>
```
The full state machine. `approveAsIs`/`sendCounter` call an internal `assertStillAvailable` helper first, which re-runs the reservation-ledger check against the (possibly edited) offered lines/dates and throws before writing if something's gone unavailable since submission (spec decision #7 — dual conflict check, re-verified at review time).

**Note on API shape:** the spec's own signatures were `approveAsIs(requestId): Promise<void>` etc. (ID-only). The actual implementation takes the already-fetched `LoanRequest`/`LoanRequestLine[]` objects instead, since the calling UI (Selouna's queue) already holds this state and passing objects avoids redundant refetches while still producing correct before/after audit snapshots.

**`src/lib/utils.ts` addition:**
```ts
export function addDaysToDateStr(dateStr: string, days: number): string
```
Placed here per the spec's own instruction (shared, not duplicated in `loanRequests.ts`). Reuses the existing private `dateStrFromDate` for local-date-safe construction, avoiding the classic `new Date('YYYY-MM-DD')` UTC-midnight timezone bug this codebase is otherwise careful about everywhere else.

---

## 4. Role/access control

**`src/context/RoleContext.tsx`** — added `canManageLoanRequests: boolean`, computed as `role === 'admin' || role === 'manager'` (same tier as `canViewReports`).

**`src/app/(protected)/layout.tsx`** — added `/loan-requests` to the `MANAGER_PLUS` route-prefix array (alongside `/reports`), gating the page to admin/manager.

**`src/components/layout/Sidebar.tsx`** — added a "Loan Requests" nav entry (using the `ClipboardList` icon) inside the existing Admin group, right after Reports, gated on `canManageLoanRequests`.

---

## 5. Selouna's queue — manager-facing review UI

**New file:** `src/app/(protected)/loan-requests/page.tsx` (437 lines).

Four tabs: **Needs Review** (pending), **Sent Counters** (countered), **Incoming Pickups** (accepted, sorted by `from_date`, flags `isNoShowCandidate` rows), **History** (all terminal statuses). Pending/countered tabs sort by `computeExpiryDate` ascending (soonest-expiring first), same undated-pushed-to-end comparator as the Dashboard's existing Outstanding Returns sort.

Each pending/countered row expands (via `<Fragment key={...}>`, per the house-style rule the spec explicitly flagged) into an inline line editor:
- Editable `offered_quantity` stepper per line, capped at both `requested_quantity` and a **live availability figure** fetched once on expand via `getReservedQuantity(..., excludeRequestId: request.id)` for each product in the request.
- Editable From/To date inputs, pre-filled with current values.
- A "Remove" action per line sets `offered_quantity` to 0.
- Three actions: **Approve as-is** (disabled once anything's edited), **Send Counter** (enabled only once something differs from the fetched baseline), **Decline**.

Accepted/history rows expand to a read-only summary instead (no editing controls).

---

## 6. Staff portal — borrower-facing UI

**New context files:**

`src/context/StaffPortalContext.tsx` — mirrors `AuthContext`'s shape but resolves a `StaffMember` via `staff` collection query (`where('uid','==', currUser.uid))`) instead of a `Profile`. Explicitly does **not** synthesize a fallback record for an unlinked account (see [§10](#10-the-authcontext-bug-fix-24) — this was written correctly from the start specifically because of the bug found in `AuthContext`).

`src/context/PortalCartContext.tsx` — plain `useState`-backed cart (`addToCart`, `updateQuantity`, `removeFromCart`, `clearCart`), no `localStorage` persistence by design (per spec §5.2 — only needs to survive navigation within a session).

**New route group `src/app/(portal)/lend/`:**

- `layout.tsx` — wraps children in `StaffPortalProvider` → `PortalCartProvider`. Redirects unauthenticated visitors, shows a dead-end "your account isn't linked" screen for an authenticated-but-unlinked account, otherwise renders a minimal header (staff name, Browse/Cart/My Requests nav, Sign out) + children. No `Sidebar`, no `RoleProvider`, no offline gate, no single-tab lock — none of the BICS `(protected)/layout.tsx` machinery applies here. **This file was edited again later** — see [§16](#16-feature--unified-login-for-both-account-types).
- `page.tsx` (Browse) — queries `products where available == true`, filters client-side for `lend_from`/`lend_to` set and `quantity_on_hand > 0`. Card grid with image (or `Package` icon fallback), lend window, quantity stepper, Add to Cart. **Edited again later** to add click-to-preview — see [§13](#13-feature--clickable-product-cards--shared-preview-dialog).
- `cart/page.tsx` — quantity steppers, From/To date pickers (`min`/`max` derived from `todayDateStr()`/`addDaysToDateStr`), live `validateCartDates` on every change rendering each error as its own `Alert`, optional message `Textarea`, submit calls `submitLoanRequest` then redirects to My Requests.
- `requests/page.tsx` — groups into Needs your response (countered) / Awaiting Selouna (pending) / Upcoming (accepted) / History (terminal). Countered requests show a per-line "you asked for N → offered M / Dropped" diff, plus a dates-changed comparison against `original_from_date`/`original_to_date` when they differ. Accept/Decline/Withdraw actions per status.
- `login/page.tsx` — **built, then later deleted** — see [§16](#16-feature--unified-login-for-both-account-types).

---

## 7. Stock Out integration

**File:** `src/app/(protected)/stock-out/page.tsx` (existing 3-step wizard, extended — not rewritten).

- After staff identification (either card-scan or manual search), now also queries `loan_requests where staff_id == staff.id && status == 'accepted' && fulfilled_txn_id == null` and renders matches as selectable cards above the existing barcode-scan input.
- **Selection model:** single-select, since `Transaction.linked_request_id` is a single string, not an array. Selecting a request populates the cart from its `loan_request_lines` using `offered_quantity` (never `requested_quantity`), tagging each line with `sourceRequestId`. Walk-in barcode scans can still be added on top in the same visit (no `sourceRequestId`) — only the request-sourced lines drive the fulfillment write.
- **Confirm-step prefill:** when a request is active, `lendFrom`/`lendTo` prefill from the request's dates (still editable).
- **On confirm:** `linked_request_id` is written directly into the transaction's initial `addDoc` payload (single write — keeps `transactions` genuinely append-only). After the existing per-line writes and `quantity_on_hand` decrements succeed, if a request was active: `updateDoc` it to `status: 'fulfilled', fulfilled_txn_id: <txn id>`, plus an audit entry.
- **Walk-in conflict warning** (spec decision #8): in the Confirm step (not the scan step — real dates don't exist until here for a walk-in), for every cart item with no `sourceRequestId`, checks `getReservedQuantity(...)` against the chosen dates; if it would exceed `quantity_on_hand`, shows a non-blocking, non-`destructive` `Alert` naming the conflict. Confirm stays enabled — Selouna can override.

---

## 8. Dashboard card

**File:** `src/app/(protected)/dashboard/page.tsx`.

Added a new full-width "Outstanding Loan Requests" card **below** the existing `grid-cols-2` row (Outstanding Returns | Low Stock Alerts) — deliberately not squeezed into that row, since Outstanding Returns already has 5 columns and a third card there would crowd everything. Structurally identical to the existing Outstanding Returns card. Shows pending/countered requests (after running `expireIfNeeded` on each), sorted by `computeExpiryDate` ascending. Not role-gated — informational for any dashboard visitor, matching the existing Outstanding Returns/Low Stock cards.

---

## 9. Audit log integration

**File:** `src/app/(protected)/audit-log/page.tsx`.

- `ENTITY_LABEL` map: added `loan_request: 'Loan Request'`.
- Entity-filter `<Select>`: added the matching option (this file duplicates the label in two places, kept in sync).
- New `LOAN_REQUEST_BADGE_CLASS` map (status → color), mirroring the existing `TXN_BADGE_CLASS` pattern.
- `actionBadge()`: added a check before the existing transaction-type check — if `entity_type === 'loan_request'` and `after.status` is a string, renders the status badge instead of the generic create/update/delete badge (since every loan-request audit entry logs `action: 'update'`, which isn't informative on its own — the interesting fact is which status it moved to).
- `FIELD_LABELS`: added `status`, `from_date`, `to_date`, `message`.
- `SKIP_FIELDS`: added `staff_id` (raw join key, `staff_name` already shown), `original_from_date`/`original_to_date` (immutable, would just look like noise duplicating `from_date`/`to_date` on the create entry).
- The date-formatting special case in the value formatter was extended to also cover `from_date`/`to_date` (previously only `lend_from`/`lend_to`).

---

## 10. The `AuthContext` bug fix (§2.4)

The spec flagged (§2.4) that once portal-borrower accounts exist, a pre-existing gap in `AuthContext.tsx` becomes an actually-reachable bug — not just a theoretical one.

**The bug:** `AuthContext.tsx` used to synthesize a default in-memory `Profile` (with `role: 'staff'`) for any authenticated Firebase user with no `profiles/{uid}` doc:
```ts
} else {
  // Default profile if none exists
  setProfile({ id: currUser.uid, full_name: ..., role: 'staff', created_at: ... })
}
```
A portal-only borrower account is *exactly* what "authenticated, no profiles doc" looks like. If such an account ever landed on `/login` (the BICS login) instead of the portal login, this code would silently let them into the real BICS app — Stock In/Out, Returns — with a default `staff` role, just because both apps share one Firebase Auth project.

**Fix applied:**
- `AuthContext.tsx`: the `else` branch now just does `setProfile(null)` instead of synthesizing a fake profile.
- `(protected)/layout.tsx`: the redirect `useEffect` now checks `if (!profile) { router.push('/login?error=no-profile'); return }` after the existing `!user` check, and the loading guard was extended to `if (loading || !user || !profile)` so protected content never flashes before the redirect fires.
- `(auth)/login/page.tsx`: reads `?error=no-profile` and shows an explanatory `Alert`.

**Note:** the spec's own prose pointed at `(protected)/layout.tsx` as the bug's location; the actual bug was in `AuthContext.tsx` — confirmed by direct code read during implementation, and the fix was applied at the correct location. The redirect itself correctly lives in `(protected)/layout.tsx` (not `AuthContext` itself), since `AuthContext` wraps the *entire* app including the portal routes, and every portal borrower is, by design, a Firebase Auth user with no `profiles` doc — redirecting on missing profile from inside `AuthContext` itself would have broken the portal for every borrower.

---

## 11. Local dev/testing infrastructure

Several supporting changes were needed to actually exercise this feature against the local Firebase emulator suite:

- **`firebase.json` / `src/lib/firebase/config.ts`**: the Firestore emulator's default port (8080) is occupied on the dev machine by a pre-existing Oracle TNS listener service. Moved the Firestore emulator to port 8081 everywhere it's referenced (`firebase.json`, `config.ts`, both seed scripts, the `dev:emulators` npm script) — a one-time environment fix, done with explicit user confirmation.
- **`firebase-tools` wasn't actually installed** despite being a declared `devDependency` (`npm run emulators` failed with "command not found"). Fixed by running `npm install`, which also updated `package-lock.json`.
- **`scripts/seed-lending-portal.mjs`** (new) — seeds an admin BICS account, a portal-borrower account already linked to a staff record (skipping the "Send Login Email" provisioning flow for quick testing), and one lendable test product. Wired as `npm run seed:lending`.
- **`scripts/seed-products.mjs`** (new) — seeds five varied test products (a mix of lendable/non-lendable), each with a generated SVG placeholder image uploaded through the Storage emulator. Wired as `npm run seed:products`. Safe to re-run (upserts by barcode).

Full end-to-end verification was performed against this local environment: submit → approve → Stock Out fulfillment (with correct `quantity_on_hand` decrement, `linked_request_id`, audit trail, dashboard/browse quantities updating), and submit → counter → decline, exercising both directions of the negotiation state machine.

---

## 12. Bug fix — Base UI `nativeButton` warning

**Reported by user** as a console error after the initial build.

**Root cause:** Base UI's `Button` primitive defaults `nativeButton` to `true`, which assumes the `render` prop swaps in another native `<button>`-like element. Every `<Button render={<Link/>}>` / `<Button render={<a/>}>` usage in the app — including two pre-existing ones (`not-found.tsx`, `cas-callback/page.tsx`) as well as the new portal nav — was tripping the resulting console warning, because nothing ever set `nativeButton` to `false`.

**Fix:** `src/components/ui/button.tsx` — the shared wrapper now defaults `nativeButton` to `false` whenever a `render` prop is passed, `true` otherwise (matching the prior default for plain `<Button>` usage without `render`). Fixed once at the shared component, not per call site. Callers can still override explicitly.

Verified via a fresh browser tab with zero console errors after login (the console-message tool's history persists across a tab's whole lifetime, which initially made this look unfixed — resolved by testing in a genuinely fresh tab each time).

---

## 13. Feature — clickable product cards / shared preview dialog

**Requested by user:** "if the staff member hovers over the card, then make a click cursor and if clicked use the showmodal of the administrator's view button for a product."

**New file:** `src/components/products/ProductPreviewDialog.tsx` (146 lines) — extracted from the admin Products page's existing read-only preview dialog (photo gallery with a 5-second auto-cycle across multiple photos, name, category/availability badges, location, lend window, description). This was a genuine extraction, not a rewrite — the JSX and the `activeImage` state/effects moved verbatim into a shared component taking `{ product, onClose }` props, so the admin Products page and the portal Browse page share one implementation instead of drifting apart as two copies.

**`src/app/(protected)/products/page.tsx`**: refactored to use the shared component — removed the inline ~140-line dialog block, the now-redundant `activeImage` state and its two `useEffect`s, and the now-unused `Carousel`/`ImageOff`/`formatDateOnly` imports.

**`src/app/(portal)/lend/page.tsx`**: added `previewProduct` state, `cursor-pointer` + hover shadow on each product `Card`, an `onClick` that opens the preview. The quantity stepper and Add to Cart button inside the card call `e.stopPropagation()` on their wrapping div so they keep working without also popping the modal open underneath them.

Verified in the browser: hovering shows a pointer cursor, clicking a card opens the correct product's modal, the inner controls still work independently, and the admin Products page's own Eye-button preview still works unchanged after the refactor.

---

## 14. Bug fix — `storageDownloadUrl` not emulator-aware

Discovered while seeding test products with images (`scripts/seed-products.mjs`) — the images uploaded to the Storage emulator weren't rendering anywhere in the app.

**Root cause:** `src/lib/firebase/storage.ts`'s `storageDownloadUrl()` always built a URL against `firebasestorage.googleapis.com` (the real Firebase Storage domain), regardless of emulator mode. `config.ts` connects the Storage *SDK instance* to the local emulator via `connectStorageEmulator`, but this helper builds its download URL independently, string-templated, with no equivalent emulator check — so any image uploaded to the Storage emulator would 404 (or worse, silently attempt to hit the real bucket) instead of rendering.

**Fix:** added the same `NEXT_PUBLIC_USE_FIREBASE_EMULATORS` check used in `config.ts`, pointing at the emulator's REST host (`127.0.0.1:9199`) when true, keeping the same real bucket name (`config.ts` deliberately doesn't override `storageBucket` for emulator mode — only `projectId` — since the emulator accepts requests for any bucket name and serves them locally).

Verified via `naturalWidth` checks on the rendered `<img>` elements in the browser (confirming actual pixel data loaded, not just a non-erroring `<img>` tag) on both the admin Products page and the portal Browse page.

---

## 15. Bug fix — auth loading-state race condition

**Reported by user** as a raw `FirebaseError` console error: `false for 'list' @ L48, false for 'list' @ L129`. This was the most involved bug of the session — the actual root cause turned out to be unrelated to what the error message suggested.

**Investigation path** (kept here because it explains why the final fix looks the way it does):
1. Initially suspected a Firestore rules problem (the cited line numbers pointed at the `staff` collection rule and the catch-all). Traced through the rules logic — didn't hold up under scrutiny.
2. Reproduced live in the browser and found the actual failing call was `AuthContext`'s `getDoc(profiles/{uid})`, failing with `permission-denied` — theorized this was an ID-token-propagation race (`onAuthStateChanged` firing before Firestore's outgoing requests had picked up the fresh token) and added a `withAuthRaceRetry` helper (`src/lib/firebase/authRace.ts`) that retries once on `permission-denied`.
3. Re-tested — the *exact same symptom* (a "not set up for BICS access" flash) still reproduced, but now with **no console error at all**. This ruled out the permission-denied theory: the read was succeeding, but `docSnap.exists()` was coming back `false` for an account confirmed (via direct Admin SDK query) to actually have a `profiles` doc.
4. Suspected Firestore's persistent local-cache layer resolving `getDoc()` from an empty IndexedDB watch stream before the server round-trip completed. Switched `AuthContext`/`StaffPortalContext` to `getDocFromServer`/`getDocsFromServer`, which force a server round-trip rather than tolerating a cache-ambiguous answer.
5. Re-tested — **still reproduced**. Added temporary debug logging directly into `AuthContext.tsx` and ran the exact failing scenario again: the log showed `getDocFromServer` correctly returning `{exists: true, ...}` with the right data — yet the UI still redirected to `/login?error=no-profile` moments later.
6. This proved the fetch itself was never the problem. The actual bug: **`onAuthStateChanged` can fire more than once during a single sign-in transition** (an initial unauthenticated firing, then the real signed-in one). Both contexts only ever set `loading: false` at the end of *any* firing and never reset it back to `true` when a *later* firing started its own async fetch. A consumer reading `{loading, profile}` between those firings — specifically `(protected)/layout.tsx`'s redirect effect, which re-runs on every render — could see the earlier firing's `loading: false` sitting next to the still-stale `profile: null` from before the real fetch resolved, and redirect immediately, a moment before the correct profile actually arrived.

**Fix:** `setLoading(true)` is now called at the start of every firing that has async work to do (i.e. whenever `currUser` is truthy), not just relying on the `useState(true)` initial default to cover every future async gap. Applied identically to both `AuthContext.tsx` and `StaffPortalContext.tsx`.

**Bundled alongside** (kept since they touch the same code path and the `getDocFromServer` switch was instrumental in isolating the real bug):
- `getDoc`/`getDocs` → `getDocFromServer`/`getDocsFromServer` for these two specific auth-determining reads.
- `withAuthRaceRetry()` (new, `src/lib/firebase/authRace.ts`) — retries once on a genuine `permission-denied`, for the separate (rarer, real) case of an actual ID-token-propagation race.

**Verification:** repeated sign-out/sign-in cycles (3+ each) for both the admin and portal-borrower accounts in an isolated browser tab, confirming no console errors and no error-page flashes on any attempt. (Testing was complicated along the way by the app's own single-admin-tab-lock feature colliding with the many test tabs accumulated during the session — a real feature working as designed, not a bug, but it did produce a red herring "Already open elsewhere" screen during one round of testing that was initially mistaken for a recurrence.)

---

## 16. Feature — unified `/login` for both account types

**Requested by user**, after a design discussion about why two separate login pages existed: *"Can we use a single login page, the BICS one, and just route the user to the correct page based on their role"* — motivated by wanting **one bookmark for everyone**.

**Design:** `/login` now authenticates first via `signInWithEmailAndPassword`, then makes a direct one-shot determination of where to send the account — not by waiting on `AuthContext`/`StaffPortalContext`'s own `onAuthStateChanged`-driven state (which would reintroduce exactly the kind of "wait for async loading flags to settle in the right order" bug just fixed in [§15](#15-bug-fix--auth-loading-state-race-condition)):

```ts
async function routeSignedInUser(uid: string) {
  const profileSnap = await getDocFromServer(doc(db, 'profiles', uid))
  if (profileSnap.exists()) { router.push('/dashboard'); router.refresh(); return }

  const staffSnap = await getDocsFromServer(query(collection(db, 'staff'), where('uid', '==', uid)))
  if (!staffSnap.empty) { router.push('/lend'); return }

  // Neither — sign back out rather than leaving them signed in with nowhere to go.
  await signOut(auth)
  setError("This account isn't set up for BICS or portal access — contact an administrator.")
}
```

**Why this doesn't reopen the §2.4 conflation bug:** `(protected)/layout.tsx` and `(portal)/lend/layout.tsx` still each independently re-verify the signed-in account (via their own contexts) before granting access, regardless of where `/login` guessed. A wrong routing guess here would at worst bounce the user back out to `/login`, not grant the wrong app's access — the actual security boundary was never in the login page's routing logic, it's in each layout's own guard.

**Changes:**
- `src/app/(auth)/login/page.tsx` — added `routeSignedInUser`, softened the branding (dropped the "BICS"-specific heading/icon-letter/placeholder, since the page now also greets portal borrowers who have no reason to know what BICS means) — heading is now "NWU IT Store" / "Potchefstroom Campus", email placeholder `you@nwu.ac.za`.
- `src/app/(portal)/lend/layout.tsx` — the unauthenticated-visitor redirect and the sign-out redirect now both point at `/login` instead of `/lend/login`; removed the now-unnecessary `pathname === '/lend/login'` special case.
- **Deleted** `src/app/(portal)/lend/login/page.tsx` entirely (not left as a redirect shim — this route was never deployed/bookmarked by real users, so a clean removal was preferred over added complexity).
- `cas-callback/page.tsx` (NWU-CAS SSO) was **not** touched — it remains BICS-only and hardcoded to `/dashboard`, consistent with the original spec explicitly excluding CAS from the portal's login flow.

**Verified in the browser:** an unauthenticated visit to `/lend` now redirects to `/login` (not the deleted `/lend/login`); signing in as the admin account lands on `/dashboard`; signing in as the borrower account lands on `/lend`; both through the exact same form.

---

## 17. Deviations from the original spec

Two rules-level deviations from a literal reading of `LENDING_PORTAL_SPEC.md` §2.3, both necessary for the feature to actually function, decided during implementation (Auto Mode, reasonable defaults, documented here for visibility):

1. **`loan_requests`/`loan_request_lines` read access is open to any signed-in user, not scoped to "own requests only."** The spec's own §3.1/§3.2 requires the reservation ledger (`getReservedQuantity`) to run **client-side in the portal itself** (the Cart page, before submission) as a pre-flight conflict check — and that ledger has to scan *every* active request across *all* borrowers for a given product, not just the caller's own, to compute a meaningful "how many are left" figure. A strictly own-requests-only read rule would silently break that check for every borrower. Same posture as `products`, which is also read-open for the identical reason.

2. **BICS staff-role (till operators) get a narrow loan-request *write* right**, not pure read-only as spec §2.3 states. `RoleContext.canManageStock` (which gates Stock Out) is `true` for every role unconditionally — so a literal read-only rule for staff-role would have broken the request-fulfillment write (`accepted → fulfilled`) for any till operator who isn't an admin/manager. Resolved by granting exactly the transitions Stock Out's fulfillment flow needs (`accepted→fulfilled`, plus the lazy `expired`/`no_show` transitions any list page might trigger on load) and nothing else.

One post-spec structural change, made at explicit user request after the initial build:

3. **Single unified `/login`, not the spec's separate `/lend/login`.** See [§16](#16-feature--unified-login-for-both-account-types). This spec document has not been updated to reflect this — `LENDING_PORTAL_SPEC.md` §5.2 still describes a standalone portal login page.

---

## 18. What's verified vs. not yet exercised

**Verified live against the local Firebase emulator**, in-browser, this session:
- Full submit → approve → Stock Out fulfillment path (quantity decrement, `linked_request_id`, audit trail, dashboard/browse availability updates).
- Full submit → counter → staff sees diff → decline path.
- Firestore rules enforcement throughout both paths (portal borrower scoped correctly, BICS admin/manager full access).
- Product images end-to-end (Storage emulator upload → `storageDownloadUrl` → rendered `<img>`) on both the admin Products page and the portal Browse page.
- Clickable product-card preview modal on the portal Browse page, and the admin Products page's own preview after the shared-component refactor.
- Repeated sign-out/sign-in cycles for both account types, post auth-race fix.
- Unified `/login` routing for both account types, and the unauthenticated-redirect target.

**Not yet exercised live** (logic is implemented per spec, just not clicked through end-to-end):
- Expiry lazy-transition on an actually-elapsed request (would need to wait out or backdate a request's `updated_at`/`from_date`).
- No-show lazy-transition on an actually-elapsed pickup window.
- Withdraw, at any of its three valid stages (pending/countered/accepted).
- Cart rejection for two products with non-overlapping `lend_from`/`lend_to` windows.
- The "neither BICS nor portal" rejection branch of the new unified login (verified by code review only — the two working branches it sits alongside share the same tested code path).

---

## 19. Full file list

```
 firebase.json                                    |    5 +-
 firestore.rules                                  |  132 +  (new)
 package-lock.json                                | 5820 ++
 package.json                                     |    4 +-
 scripts/seed-emulator.mjs                         |    2 +-
 scripts/seed-lending-portal.mjs                   |  107 +  (new)
 scripts/seed-products.mjs                         |  174 +  (new)
 src/app/(auth)/login/page.tsx                     |   69 +-
 src/app/(portal)/lend/cart/page.tsx               |  146 +  (new)
 src/app/(portal)/lend/layout.tsx                  |   90 +  (new)
 src/app/(portal)/lend/page.tsx                    |  102 +  (new)
 src/app/(portal)/lend/requests/page.tsx           |  231 +  (new)
 src/app/(portal)/lend/login/page.tsx              |         (new, then deleted)
 src/app/(protected)/audit-log/page.tsx            |   43 +-
 src/app/(protected)/dashboard/page.tsx            |   71 +
 src/app/(protected)/layout.tsx                    |   16 +-
 src/app/(protected)/loan-requests/page.tsx        |  437 +  (new)
 src/app/(protected)/products/page.tsx             |  175 +-
 src/app/(protected)/stock-out/page.tsx            |  137 +-
 src/components/layout/Sidebar.tsx                 |   11 +-
 src/components/products/ProductPreviewDialog.tsx  |  146 +  (new)
 src/components/ui/button.tsx                      |   10 +
 src/context/AuthContext.tsx                       |   57 +-
 src/context/PortalCartContext.tsx                 |   64 +  (new)
 src/context/RoleContext.tsx                       |    3 +
 src/context/StaffPortalContext.tsx                |   76 +  (new)
 src/lib/firebase/authRace.ts                      |   24 +  (new)
 src/lib/firebase/config.ts                        |    2 +-
 src/lib/firebase/loanRequests.ts                  |  275 +  (new)
 src/lib/firebase/storage.ts                       |   16 +-
 src/lib/utils.ts                                  |   11 +
 src/types/database.ts                             |   49 +-
```

**Commits (chronological):**
1. `547a7d2` — Add staff self-service lending portal with negotiation workflow (the full initial build, §§1–9)
2. `e91b913` — Move Firestore emulator off port 8080, add lending-portal seed script (§11)
3. `1eebb10` — Fix Base UI nativeButton warning on every Button using render (§12)
4. `7a05037` — Make storageDownloadUrl emulator-aware, add product+image seed script (§14)
5. `3129db9` — Make lending portal product cards clickable, open shared preview modal (§13)
6. `76002d0` — Fix spurious permission-denied / role-not-set-up flash on sign-in (§15)
7. `3e0091f` — Unify BICS and portal-borrower login into a single /login page (§16)

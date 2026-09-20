# Lending Portal — Implementation Spec

**Status:** Ready to build. This document is the authoritative spec for the staff self-service lending portal (negotiation-based cart requests). It **supersedes Stage B (sections 3–6) of `handout.md`** — that section's single-product, no-negotiation `LoanRequest` sketch was a first draft written before the design was fully worked through with the store manager (Selouna). Stage A and Stage B sections 1–2 in `handout.md` are already built and unaffected; don't redo them.

This spec was produced through several rounds of design review, not written speculatively — every decision below has a stated reason. Read the "Design decisions" section before changing any of them.

---

## 0. Context you need before starting

Read these existing files first — the portal must follow their conventions exactly, not introduce new ones:

- `src/types/database.ts` — existing types (`Product`, `Transaction`, `TransactionLine`, `StaffMember`, `AuditLogEntry`). `Product.lend_from`/`lend_to` and `Product.available` already exist and are what the portal reads to decide what's lendable.
- `src/lib/utils.ts` — `todayDateStr()`, `formatDateOnly()`, `isoToLocalDateStr()`. **Never** parse a date-only (`YYYY-MM-DD`) string with `new Date(...)` — it's parsed as UTC midnight and can render a day off depending on the viewer's timezone. Always compare date-only strings lexicographically (`'2026-08-24' > '2026-08-22'` works correctly as plain string comparison) or via these helpers.
- `src/lib/firebase/audit.ts` — `logAudit(...)`. Every mutating write in this app calls this. The portal is no exception — every status transition on a loan request needs an audit entry (see §6).
- `src/app/(protected)/stock-out/page.tsx` and `src/app/(protected)/returns/page.tsx` — the transaction-header + transaction-lines write pattern, the `Record<originatingId, Record<productId, number>>` scoping pattern (critical — see §3), and the live-derived status-badge pattern (`lineStatus()` in returns/page.tsx, `outstandingStatus()` in dashboard/page.tsx). The loan request negotiation logic reuses both patterns.
- `src/context/RoleContext.tsx`, `src/context/AuthContext.tsx`, `src/app/(protected)/layout.tsx` — the existing role-gating system. The portal needs a **second, separate** auth context (§2) — do not try to reuse `AuthContext`/`RoleContext` for portal borrowers.
- `src/lib/firebase/products.ts` — `findProductByBarcode`. Not used by the portal directly, but Stock Out's barcode flow (§7) still needs to keep working unchanged alongside the new request-based flow.

**House style, non-negotiable:**
- shadcn/ui components only (`Card`, `Table`, `Button`, `Input`, `Label`, `Badge`, `Alert`, `Dialog`), Tailwind utility classes, `lucide-react` icons.
- `sonner`'s `toast` for row-action feedback (already wired app-wide); page-level `Alert`/`error` state for form-submission failures.
- Status badges that are live-computed from today's date vs. a stored date must **never** be persisted as a separate boolean/label that only changes because time passed — recompute at render time. The only exception is a genuine state-machine transition (pending → countered → accepted, etc.), which **is** persisted because it's caused by an explicit action, not the passage of time. Expiry and no-show are the two cases in this feature that blur that line — see §4, they're specified as "compute live for display, lazily persist the transition on next read" to keep list queries (`where('status', '==', 'pending')`) working without a cron job.
- Every list row/table built from a `.map()` that renders more than one element per item (a summary row + a conditional expand row) must use `<Fragment key={...}>`, not shorthand `<>`. Got this wrong once already this session (see `IssuedPerStaffReport` in `reports/page.tsx`) — don't repeat it.
- `quantity_on_hand` bookkeeping happens on the `products` collection only at actual Stock Out/Stock In/Return time. Loan requests, at every stage before fulfillment, must **never** touch `quantity_on_hand` — they only affect the *reservation ledger*, which is a live query, not a stored counter (see §3.1).

---

## 1. Design decisions (read this before changing anything)

These were each explicitly decided after considering alternatives. If an implementer wants to deviate, that's fine, but they should know what they'd be giving up:

1. **One request = one cart, one shared date range, one status.** A request has a single `status` field covering every line in it — not per-line negotiation. This keeps the state machine simple (one transition graph, not N of them) and matches how Selouna actually wants to work: she reviews a whole ask at once.
2. **The shared date range must be valid for every line in the cart.** Before submission, the portal must check the selected `from_date`–`to_date` falls inside the *intersection* of every cart product's own `Product.lend_from`–`lend_to` window. If two products in the cart have non-overlapping windows, they can't be requested together — the UI needs to make this legible while the staff member is building the cart, not just reject at submit.
3. **Selouna edits are captured as a second line-set, not an in-place overwrite.** `requested_quantity` (immutable, what staff asked for) and `offered_quantity` (what Selouna is proposing — starts equal to `requested_quantity`, she can reduce it or zero it out to drop the line) live side by side on `loan_request_lines`. This is so the staff member's accept/decline screen can show "you asked for 4, she's offering 2" rather than silently replacing the ask. Reason: this app already leans on before/after visibility everywhere else (audit log diffs, Returns' outstanding-lines expand) — this is the same idea applied to negotiation.
4. **The whole modified cart goes back as one counter; staff accepts or declines it as one decision.** Not per-line. Simpler build, matches how Selouna described wanting to work.
5. **Expiry: `min(updated_at + 7 days, from_date)`, not a flat 7 days.** A flat 7-day SLA timer that resets on every state change can outlive the request's own point — e.g. submitted 22 Aug for pickup 24 Aug, countered on 23 Aug, a flat reset would let it sit "pending staff response" until 30 Aug, well past the date the loan was supposed to start. Capping the effective expiry at the request's own `from_date` fixes this: for a near-term request, `from_date` is the binding constraint; for a normal request submitted weeks ahead of `from_date`, the 7-day SLA is what binds. One formula, no special-casing. Cutoff is `today > expiry_date` (not `>=`) so same-day resolution still works, consistent with how "Due Today" isn't "Overdue" elsewhere in this app.
6. **No reservation counter field anywhere.** Availability for a candidate date range is always computed live by scanning active (`pending`/`countered`/`accepted`) requests for a product and checking date-range overlap — never a denormalized "units reserved" number on `Product`. Same reasoning as every other live-derived value in this app: a stored counter can drift, a live query can't.
7. **Dual conflict check.** The reservation ledger is checked both when a request is first submitted (client-side, to stop obviously-impossible requests before they're even sent) and again when Selouna reviews it (server-side-equivalent — actually still client Firestore reads, but re-checked at review time, since availability may have changed between submission and review) and *again* if a walk-in Stock Out would eat into stock already promised to an active request.
8. **Walk-in Stock Out gets a warning, not a block.** If issuing stock to a walk-in would cut into what's reserved for an active portal request, Selouna sees a non-blocking alert and can proceed anyway — she has full authority to override, the system just makes sure she's not doing it blind.
9. **No push/email notifications.** Nothing in this app sends email except the one-time Auth password-reset flow. All status changes are surfaced by the affected party pulling up a page (Selouna's queue, staff's "My Requests") — both need a "needs attention" view that's live-queried, not a dismissible/stored notification.

---

## 2. Data model

### 2.1 `src/types/database.ts` additions

Add near the existing `Transaction`/`TransactionLine` interfaces:

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
  id: string                    // Firestore document ID
  staff_id: string               // StaffMember document ID (resolved via StaffMember.uid at submission)
  staff_name: string              // denormalized, same pattern as Transaction.staff_name
  status: LoanRequestStatus
  message: string | null          // optional note from staff at submission
  from_date: string               // YYYY-MM-DD — current shared date range. Mutable: Selouna's
                                   // counter can change it, same field gets overwritten in place
                                   // (unlike quantities, there's no "requested vs offered" date pair —
                                   // simpler because a date range doesn't need a per-line diff view;
                                   // if this turns out to matter, revisit)
  to_date: string                 // YYYY-MM-DD
  created_at: string              // ISO — set once at submission, never changes
  updated_at: string              // ISO — bumped on every status transition. Expiry is computed
                                   // from this (see loanRequests.ts) — never store an expiry date.
  fulfilled_txn_id: string | null // set by Stock Out once issued (see §7)
}

export interface LoanRequestLine {
  id: string                    // Firestore document ID
  request_id: string             // LoanRequest document ID
  product_id: string
  product_name: string            // denormalized
  requested_quantity: number      // set once at submission — never edited after
  offered_quantity: number        // starts equal to requested_quantity. Selouna's counter edits
                                   // this (reduce, or set to 0 to drop the line). This is the
                                   // number Stock Out actually issues against on fulfillment.
  created_at: string
}
```

Extend `Transaction`:

```ts
export interface Transaction {
  // ...existing fields...
  linked_request_id: string | null   // set when this OUT transaction was issued against an
                                      // accepted loan request (see §7). null for walk-ins.
}
```

Nothing changes on `Product` — `lend_from`/`lend_to`/`available`/`quantity_on_hand` already exist and are exactly what's needed.

### 2.2 New Firestore collections

- `loan_requests` — one document per cart-level request, shape above.
- `loan_request_lines` — one document per product line within a request, shape above. Same collection-per-line-item pattern as `transaction_lines` (not an embedded array — this app moved away from embedded arrays specifically so lines are independently queryable; see `handout.md`'s "Embedded Arrays... out of date" note).

### 2.3 Firestore security rules

The current `firestore.rules` (per `handout.md` §5) locks reads/writes to "authenticated users only" — that's not fine-grained enough once there are two distinct identity populations hitting the same project:

- **BICS operators** — authenticated via `profiles/{uid}`, role `admin`/`manager`/`staff`, used by the `(protected)` app.
- **Portal borrowers** — authenticated via a Firebase Auth account linked through `StaffMember.uid`, used only by the new `/lend/*` portal.

Rules need to be added for `loan_requests`/`loan_request_lines`:
- A portal borrower can create a request only for their own `staff_id` (resolved server-side isn't possible with pure Firestore rules without a Cloud Function — the practical rule is: `request.resource.data.staff_id` must match a `staff` document whose `uid == request.auth.uid`, checked via a `get()` inside the rule, mirroring how `staffAdmin.ts` resolves ownership server-side for the Staff API routes).
- A portal borrower can read/update (accept/decline/withdraw) only requests where `resource.data.staff_id` resolves to their own `uid`.
- BICS `admin`/`manager` profiles can read/write all `loan_requests`/`loan_request_lines` (mirrors the existing `canManageProducts`/`canViewReports` split — write access to counters and approvals is admin+manager, same tier as Reports).
- BICS `staff`-role profiles (store-floor operators, not portal borrowers — see the naming collision warning in §2.4) get read access only, needed for Stock Out's request-lookup step (§7) if that page isn't restricted to admin/manager (check current `canManageStock` gating before deciding).

Whoever implements this should write and test these rules against the emulator (`npm run emulators`) before touching production rules, per the existing emulator-testing convention in `handout.md`.

### 2.4 ⚠️ Naming collision — read before touching auth

`Profile.role` includes a value literally named `'staff'` (a BICS store-floor operator who can do Stock In/Out but not manage products/staff/reports). This is a **completely different person/account** from a `StaffMember` document (an NWU staff member who *borrows* equipment, authenticated separately via `StaffMember.uid` for the lending portal). Do not conflate them — a portal borrower should never end up with a `profiles` document, and a BICS `staff`-role operator doesn't need a `StaffMember` record just to operate the till.

**Pre-existing gap worth closing while in this area:** `AuthContext.tsx` currently does this on login —

```ts
if (docSnap.exists()) {
  setProfile(docSnap.data() as Profile)
} else {
  // Default profile if none exists
  setProfile({ id: currUser.uid, full_name: ..., role: 'staff', created_at: ... })
}
```

Any Firebase Auth account with **no** `profiles` document — which is exactly what a portal-only borrower account looks like — silently gets treated as a valid `role: 'staff'` BICS operator if they ever land on `/login` instead of `/lend/login` and authenticate. That would let an equipment-borrower log into the real BICS system (Stock In/Out, Returns) by accident, just because both apps share one Firebase Auth project. Fix while building this: `(protected)/layout.tsx` (or `AuthContext`) should redirect to `/login` with an error instead of synthesizing a default profile when `profiles/{uid}` doesn't exist. This isn't strictly part of the portal feature, but it becomes an actual reachable bug once portal accounts exist, so it shouldn't ship without this fix.

---

## 3. Shared logic library — `src/lib/firebase/loanRequests.ts` (new file)

This is the one file every page below depends on — build and unit-test it first.

### 3.1 Reservation ledger

```
getReservedQuantity(productId: string, fromDate: string, toDate: string, excludeRequestId?: string): Promise<number>
```

Fetch all `loan_requests` where `status in ['pending', 'countered', 'accepted']` (Firestore `in` query, max 10 values — fine, there are only 3). For each, fetch its `loan_request_lines` where `product_id == productId` (or fetch all lines for the matched request IDs in one pass and filter client-side, same "fetch the scoped set, group client-side" pattern used in `returns/page.tsx`'s `returnedByTxn` and `dashboard/page.tsx`'s `linesByTxn` — this app's Firestore usage consistently favors a handful of broader reads filtered in JS over many narrow indexed queries, at this data scale that's the right tradeoff and keeps the query set small enough to avoid needing a composite index on every call site). Skip `excludeRequestId` if given (needed when re-validating a request against itself during Selouna's edit). For every remaining line, if `[fromDate, toDate]` overlaps `[request.from_date, request.to_date]` (`fromDate <= request.to_date && toDate >= request.from_date`), sum `offered_quantity`. Return the sum.

Availability for a candidate range = `product.quantity_on_hand - getReservedQuantity(...)`.

### 3.2 Cart validation

```
validateCartDates(cartItems: { product: Product; quantity: number }[], fromDate: string, toDate: string): { valid: boolean; errors: string[] }
```

For each item: check `fromDate >= product.lend_from && toDate <= product.lend_to` (both must be set on the product — if either is null, that product isn't lendable via the portal at all and shouldn't have been addable to the cart in the first place; treat as a defensive check). Check `toDate - fromDate <= 7 days` (the 1-week max — Selouna can override this manually on her side per decision in §1, but the portal itself enforces it for staff). Check `await getReservedQuantity(product.id, fromDate, toDate) + quantity <= product.quantity_on_hand`. Collect a human-readable error per failing product (e.g. `"Boom Box is only lendable until 20 Aug — outside your selected range"` vs `"Laptop: only 1 unit available for these dates, you requested 2"`), return all of them at once so the UI can show every problem, not just the first.

### 3.3 Expiry (live-computed, lazily persisted)

```
computeExpiryDate(request: LoanRequest): string | null   // null for terminal statuses
isExpired(request: LoanRequest): boolean
```

`computeExpiryDate` only applies to `pending`/`countered`: take `request.updated_at`, add 7 days, convert to a `YYYY-MM-DD` string (reuse the `dateStrFromDate` pattern from `utils.ts` — don't duplicate it, either export it or add a `addDaysToDateStr`/similar helper to `utils.ts` if this file needs it standalone), then return `min(that, request.from_date)` via plain string comparison. `isExpired` returns `today > computeExpiryDate(request)` (using `todayDateStr()`), `false` for non-pending/countered statuses.

```
expireIfNeeded(request: LoanRequest): Promise<LoanRequestStatus>
```

If `isExpired(request)`, `updateDoc` the request to `status: 'expired'`, `updated_at: new Date().toISOString()`, call `logAudit` (action `'update'`, entity type — see §6 for whether to add a new `AuditEntityType`), return `'expired'`. Otherwise return the request's current status unchanged. Every page that lists `loan_requests` (Selouna's queue, staff's My Requests, Dashboard) calls this for each pending/countered request right after fetching, same "check and flip on read" pattern used nowhere else *yet* in this app but consistent with its no-cron philosophy — this is the first feature that actually needs a persisted terminal-status transition driven by time rather than a live-only display label, because `expired` needs to be excludable from `where('status', 'in', [...])` queries elsewhere (the reservation ledger in §3.1 specifically must stop counting an expired request).

### 3.4 No-show (same lazy pattern)

```
isNoShowCandidate(request: LoanRequest): boolean   // accepted, today > from_date, fulfilled_txn_id is null
expireIfNeeded(...)  // extend the same function (or a sibling) to also flip accepted → no_show under this condition
```

Reason for the same lazy-transition treatment as expiry, not pure live-display: `no_show` also needs to be a real status value the reservation ledger and list queries can exclude/include on.

### 3.5 Cart submission

```
submitLoanRequest(staffId: string, staffName: string, cart: {product: Product; quantity: number}[], fromDate: string, toDate: string, message: string | null): Promise<string>
```

Re-run `validateCartDates` server-side-equivalent (still client Firestore, but re-checked right before write, not trusting whatever validation ran when the cart was last edited — availability can change in between). Write one `loan_requests` doc (`status: 'pending'`, `created_at`/`updated_at` both `now`, `fulfilled_txn_id: null`), then one `loan_request_lines` doc per cart item (`requested_quantity` = `offered_quantity` = cart quantity). `logAudit` the creation. Return the new request ID.

### 3.6 Selouna's counter / approve / decline

```
approveAsIs(requestId): Promise<void>          // status -> 'accepted', offered stays == requested
sendCounter(requestId, editedLines: {lineId, offered_quantity}[], newFromDate?, newToDate?): Promise<void>  // status -> 'countered'
declineRequest(requestId): Promise<void>        // status -> 'declined'
```

Each: `updateDoc` on the request (`status`, `updated_at`, and `from_date`/`to_date` if changed), `updateDoc` on each edited line's `offered_quantity`, `logAudit` for the request-level change. Before writing an approval/counter, re-run the §3.1 ledger check against the (possibly edited) offered lines and dates — if something's gone unavailable since the request was submitted, surface that to Selouna rather than silently writing an approval that's already wrong (decision #7 in §1).

### 3.7 Staff response to a counter

```
acceptCounter(requestId): Promise<void>   // status -> 'accepted'
declineCounter(requestId): Promise<void>  // status -> 'declined'
withdrawRequest(requestId): Promise<void> // status -> 'withdrawn' — valid from pending/countered/accepted
```

Same `updateDoc` + `logAudit` shape as §3.6.

---

## 4. `RoleContext` addition

Add `canManageLoanRequests: boolean` (`role === 'admin' || role === 'manager'`, same tier as `canViewReports` — Selouna's queue page is a manager-level tool, not admin-only). Add it in both the context type and the default/provider value in `src/context/RoleContext.tsx`, following the exact pattern already there for `canViewReports`.

Add `/loan-requests` to the `MANAGER_PLUS` array in `src/app/(protected)/layout.tsx` (alongside `/reports`).

---

## 5. Portal auth — new, separate from the BICS `AuthContext`

### 5.1 `src/context/StaffPortalContext.tsx` (new)

Mirrors `AuthContext.tsx`'s shape but resolves a `StaffMember`, not a `Profile`:

```ts
interface StaffPortalContextValue {
  user: User | null              // Firebase Auth user (portal borrower)
  staffMember: StaffMember | null
  loading: boolean
}
```

On `onAuthStateChanged`, if there's a user, query `where('uid', '==', currUser.uid)` against the `staff` collection (same query shape `staffAdmin.ts`'s `findStaffDocOwningUid` already uses server-side — this is the client-side equivalent). If no matching `StaffMember` doc is found for an authenticated Firebase user, **do not** synthesize a fallback record the way `AuthContext` does for `Profile` (see the §2.4 warning — don't repeat that mistake here either); instead leave `staffMember: null` and let the portal layout show an explicit "your account isn't linked to a staff record — contact Selouna" state rather than silently proceeding.

### 5.2 Route structure

**Update, post-implementation:** built as a standalone `/lend/login` per the original text below, then **removed** at explicit user request in favor of a single unified `/login` shared with the BICS app — see `LENDING_PORTAL_CHANGELOG.md` §16/§17.3 for the reasoning and exact implementation. `/login` now does a one-shot post-auth lookup (`profiles/{uid}` exists → `/dashboard`; else `staff` doc with matching `uid` → `/lend`; else sign back out with an error) rather than each app having its own login page. The portal layout's unauthenticated-redirect target is `/login`, not `/lend/login` — that route no longer exists. The rest of this section (route group structure, `StaffPortalProvider`, the "not linked" dead-end state) is otherwise accurate as built.

New route group `src/app/(portal)/lend/` (a route group, not nested under `(protected)` — completely separate layout, separate auth guard, no `Sidebar`):

- `src/app/(portal)/lend/layout.tsx` — wraps children in `StaffPortalProvider`, redirects to `/login` if no `user`, shows the "not linked" state if `user` exists but `staffMember` is `null`, otherwise renders a minimal header (staff name, nav links: Browse / Cart / My Requests, Sign out) + `children`.
- `src/app/(auth)/login/page.tsx` — shared unified login for both BICS operators and portal borrowers (see the update note above). Staff members use their "Send Login Email"-provisioned password here, same as BICS operators (existing provisioning flow, already built — see `handout.md` §2).
- `src/app/(portal)/lend/page.tsx` — browse/catalogue (§5.3).
- `src/app/(portal)/lend/cart/page.tsx` — cart/checkout (§5.4).
- `src/app/(portal)/lend/requests/page.tsx` — My Requests (§5.5).

Cart state itself: a simple `useState` lifted into the portal layout (or a small `CartContext`) so it survives navigation between Browse and Cart within the portal session — no need for persistence beyond that (no `localStorage`, per this app's existing offline/persistence conventions being handled elsewhere via Firestore's own persistent cache, not ad hoc browser storage).

### 5.3 Browse page

Query `products` where `available == true` (client-filter for `lend_from != null && lend_to != null && quantity_on_hand > 0` — three separate conditions can't all go in one Firestore query without a composite index for this exact combination; given the existing pattern of broad-read-then-filter used throughout this app, fetch `available == true` and filter the rest client-side, same tradeoff as §3.1). Render as a card grid (`Card` per product — image if `images[0]` present via the existing `storageDownloadUrl()` helper used in `products/page.tsx`, name, lend window via `formatDateOnly`, a quantity stepper capped at `quantity_on_hand`, "Add to Cart" button). Adding a product with a lend window that doesn't intersect what's already in the cart should be blocked inline (call `validateCartDates` mentally against the *current cart's implied intersection*, or simpler: just let anything be added here, and do the full validation on the Cart page where dates are actually picked — simpler UX, defer the constraint surfacing to §5.4 where the date pickers actually live).

### 5.4 Cart page

List cart items with quantity steppers (remove via `X`, same icon-button pattern as Stock In/Out carts). Two `<Input type="date">` fields, From (`min={todayDateStr()}`) / To (`min={fromDate}`, and cap the picker range at 7 days after `fromDate` per the 1-week max). On every date or cart change, call `validateCartDates` and render each returned error as an inline `Alert` — submit button disabled while any error exists. Optional `message` `Textarea`. Submit calls `submitLoanRequest`, then redirects to `/lend/requests` with a success toast.

### 5.5 My Requests page

Fetch all `loan_requests` for this `staffMember.id`, run `expireIfNeeded` (§3.3/3.4) on each pending/countered/accepted one, group into sections (Needs your response: `countered`; Awaiting Selouna: `pending`; Upcoming: `accepted`; History: everything terminal). For `countered` requests, expand to show a two-column diff per line — "You asked for" (`requested_quantity`) vs "Selouna's offer" (`offered_quantity`, struck-through/omitted rows for lines reduced to 0) plus the current `from_date`/`to_date` (highlight if Selouna changed them from what was originally submitted — note the spec in §2.1 point: since `from_date`/`to_date` are overwritten in place rather than kept as a requested/offered pair, the diff for *dates* specifically has to come from comparing against `created_at`... actually there's no stored "originally requested dates" once overwritten. **Open question for whoever builds this:** if showing a dates-diff matters as much as the quantities-diff, `LoanRequest` needs an `original_from_date`/`original_to_date` pair (set once at creation, immutable) alongside the mutable `from_date`/`to_date`, mirroring exactly how `requested_quantity`/`offered_quantity` work on the line. This wasn't explicitly decided in the design conversation — recommend adding it, since leaving it out is inconsistent with decision #3 in §1). Buttons: Accept / Decline on `countered`; Withdraw on `pending`/`countered`/`accepted`.

---

## 6. Selouna-facing queue — `src/app/(protected)/loan-requests/page.tsx` (new)

Gate on `canManageLoanRequests` (§4), add nav entry to `src/components/layout/Sidebar.tsx`'s "Admin" group (`SidebarMenuItem` + `Link href="/loan-requests"`, icon e.g. `ClipboardList` from `lucide-react`), following the exact JSX pattern already used for Staff/Reports/Audit Log entries in that file.

List `loan_requests`, run `expireIfNeeded` on load, group/tab by status, sort by `computeExpiryDate` ascending within pending/countered (most urgent first — same sort-with-undated-pushed-to-end pattern as `dashboard/page.tsx`'s `outstandingList.sort`). For each pending request: expand to a line editor — a table of lines with an editable `offered_quantity` stepper (capped at `requested_quantity` and at live availability from §3.1) and a remove-line button (sets `offered_quantity` to 0), editable From/To date inputs pre-filled with the current values. Three actions: **Approve as-is** (`approveAsIs`), **Send Counter** (only enabled once something's actually been edited — otherwise it's just approve; `sendCounter`), **Decline** (`declineRequest`). For `accepted` requests, this same page (or a filtered tab) is the "Expected/Incoming Pickups" view — show sorted by `from_date`, flag `isNoShowCandidate` rows visually (no separate page needed, this satisfies the "Incoming pickups" idea from the original design discussion).

**Audit log:** `AuditEntityType` currently is `'product' | 'category' | 'staff' | 'transaction'`. Add `'loan_request'` to that union in `database.ts`, and give `audit-log/page.tsx`'s `TXN_BADGE_CLASS`/badge-rendering logic a parallel path for it (or reuse `FieldDiff` — a loan request's `before`/`after` are plain field snapshots, so the existing generic diff renderer in `audit-log/page.tsx` should handle it with just a `FIELD_LABELS` entries added for `status`, `from_date`, `to_date`, `message` — check `SKIP_FIELDS`/`FIELD_LABELS` in that file before assuming what needs adding).

---

## 7. Stock Out integration — edits to `src/app/(protected)/stock-out/page.tsx`

This is the existing 3-step (`staff` → `items` → `confirm`) wizard — extend it, don't rewrite it.

**After step 1 (staff identified):** query `loan_requests` where `staff_id == staff.id && status == 'accepted' && fulfilled_txn_id == null`. If any exist, show them as selectable cards above the barcode input at the top of step 2 — keep the barcode-scan flow working unchanged below it for walk-ins (this mirrors exactly what the original `handout.md` Stage B section 4 sketch already called for, still correct).

**Selecting a request:** populate `cart` from its `loan_request_lines` (using `offered_quantity`, not `requested_quantity` — that's the number Selouna actually approved), and track which request(s) are the source — extend `CartItem` locally in this file to `CartItem & { sourceRequestId?: string }`, or keep a separate `selectedRequestIds: string[]` state alongside `cart`, whichever reads cleaner once written; either way `handleConfirm` needs to know which request(s) to mark fulfilled.

**Step 3 (confirm) prefill:** when the cart came from a request, prefill `lendFrom`/`lendTo` from the request's `from_date`/`to_date` instead of the existing default-to-today/blank behavior — fields stay editable, Selouna can still change them.

**On confirm (`handleConfirm`):** after the existing transaction + transaction_lines + `quantity_on_hand` writes succeed, additionally set `linked_request_id: txnRef.id` — wait, the other direction: set `transactions/{txnRef.id}.linked_request_id = requestId`, and `updateDoc` each fulfilled `loan_requests/{requestId}` to `status: 'fulfilled', fulfilled_txn_id: txnRef.id, updated_at: now`, with a `logAudit` call for that transition (entity type `'loan_request'`).

**Walk-in conflict warning (decision #8 in §1):** in `lookupBarcode` (the plain barcode-scan path, i.e. cart items with no `sourceRequestId`), after finding the product, call `getReservedQuantity(product.id, lendFrom, lendTo)` — if `reserved + (this item's new cart quantity) > product.quantity_on_hand`, don't block the add, but show a non-dismissed-by-default `Alert` (variant other than `destructive`, e.g. a plain informational one — this is a warning Selouna can override, distinct from the existing hard "out of stock" `destructive` error) naming what it would conflict with. Since `lendFrom`/`lendTo` for a walk-in aren't chosen until step 3, this check has to either re-run when the cart reaches step 3, or use `todayDateStr()`–`lendTo` defaults as a first-pass heuristic in step 2 and a definitive check once real dates are picked in step 3 — recommend doing the real check in step 3, since that's the first point actual dates exist for a walk-in.

---

## 8. Dashboard additions — `src/app/(protected)/dashboard/page.tsx`

Add an "Outstanding Loan Requests" card, following the exact structural pattern of the existing "Outstanding Returns" card (`Card` with header badge showing a count, `Table`, same `.slice(0, 8)` truncation). Rows: pending/countered requests sorted by `computeExpiryDate` ascending (soonest-expiring first), columns Staff / Items (line count) / Status / Expires. This is also the natural home for the "self-clearing notification" idea from the original design discussion — a request that gets resolved (accepted/declined/expired) simply stops appearing next time this query runs, no dismiss-state needed, consistent with decision #9 in §1 and this app's live-derived-status philosophy throughout.

If a more prominent cross-page notification (e.g. a badge on the Sidebar nav item) is wanted later, it's the same query, just also run in `Sidebar.tsx` or a small shared hook — not a separate stored-notification system.

---

## 9. Suggested build order

1. **Data model** — §2.1 type additions, §2.2 collections (nothing to "build" for collections themselves, Firestore creates them on first write), §2.3 rules (write + test against the emulator).
2. **`loanRequests.ts`** (§3) — the shared logic lib. Get the reservation ledger and expiry formula right and tested (manually, against the emulator with seeded data covering the near-term-expiry edge case from decision #5) before building any UI on top of it.
3. **`RoleContext` + layout + Sidebar nav** (§4) — small, unblocks the queue page.
4. **Selouna's queue page** (§6) — build this before the staff portal, since it's the side that needs the most careful state-transition logic, and it's easier to seed test `loan_requests` directly in the emulator UI and exercise the queue than to build the whole staff-side submission flow first just to get test data.
5. **`StaffPortalContext` + portal route group + login** (§5.1–5.2).
6. **Browse → Cart → submit** (§5.3–5.4).
7. **My Requests** (§5.5) — including the accept/decline/withdraw actions.
8. **Stock Out integration** (§7).
9. **Dashboard card** (§8).
10. Full walkthrough test (§10).

Each step gets its own `npx tsc --noEmit` / `npx next build` pass before moving to the next, same sandbox-verify workflow used throughout this project.

---

## 10. Testing checklist

Test these explicitly — each one maps to a specific design decision above, not a generic "test the feature" pass:

- **Expiry formula, near-term case:** submit a request today for pickup 2 days out, counter it — confirm it expires on the pickup date, not 7 days from the counter (decision #5).
- **Expiry formula, normal case:** submit a request for pickup 3+ weeks out — confirm the 7-day SLA is what governs, and confirm it resets on each new state change.
- **Cart date validation across mismatched product windows:** two products with non-overlapping `lend_from`/`lend_to` — confirm the cart correctly refuses a shared range that doesn't fit both.
- **Reservation ledger correctness:** two different requests for overlapping date ranges on the same product where the combined quantity would exceed stock — confirm the second one is refused or flagged, and confirm an `excludeRequestId` self-check doesn't double-count a request's own reservation when Selouna is editing it.
- **Counter diff display:** Selouna reduces one line's quantity and drops another entirely — confirm the staff member's My Requests view shows both the original ask and what's being offered, not just the final state.
- **Withdraw at every valid stage:** pending, countered, and accepted — confirm each transitions correctly and frees up the reservation ledger immediately (i.e. a withdrawn request's lines stop counting in `getReservedQuantity`).
- **No-show:** accept a request, let `from_date` pass with nothing issued against it — confirm it flips to `no_show` on next read and stops counting against the reservation ledger.
- **Fulfillment:** approve a request, issue it via Stock Out's request-selection path — confirm `quantity_on_hand` decrements exactly once (not double-counted against the reservation ledger check), `linked_request_id` is set on the transaction, and the request flips to `fulfilled`.
- **Walk-in conflict warning:** with an active accepted request reserving the last units of a product, do a walk-in Stock Out for that same product/date range — confirm the warning appears and confirm Selouna can still proceed.
- **Auth boundary (§2.4):** confirm a portal-only account (Firebase Auth user with no `profiles` doc) cannot reach any `(protected)` route — this should now redirect to `/login` with an error rather than silently getting a default `staff` profile, once that fix is in.

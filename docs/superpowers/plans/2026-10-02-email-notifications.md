# Email Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send the 10 event-driven loan-request, pickup and low-stock emails through the existing Mailpit mailer, gated by the Settings toggles, deduplicated, and never blocking the user's action.

**Architecture:** Loan-request transitions stay client-side. After each succeeds, the page makes a background call to a new server route `POST /api/notifications/loan-request` with `{ event, requestId, reason? }`. The server re-reads the request, checks caller role and request status, then for each email checks the toggle, finds the recipient, writes a dedupe marker in `sent_notifications`, renders and sends. Low stock rides on the existing Stock Out route.

**Tech Stack:** Next.js 16 route handlers (server-only), Firebase Admin SDK, nodemailer via `src/lib/server/mailer.ts`, TypeScript. Tests are node harness scripts outside the repo in `$HOME/mailtest` (node 22, `--experimental-strip-types`), as in the Mailpit foundation.

**Spec:** `docs/superpowers/specs/2026-10-02-email-notifications-design.md` (read it first; it is authoritative). Branch `email-notifications`.

## Global Constraints

- Server modules start with `import 'server-only'`. Templates are pure (no env, no I/O); they receive `buttonUrl` as an input.
- Every interpolated value in an email is HTML-escaped via the existing `renderEmailLayout`. Plain `paragraphs` are escaped by it; never build raw HTML outside it.
- Only an explicit `false` in `settings/notifications` turns an email off. `loan_request_expired`, `overdue_return_alert`, `insufficient_pickup_alert` are always off, whatever Firestore holds.
- Skip reasons are exactly `mail_disabled | toggle_off | no_email | duplicate | not_implemented`. A skip is HTTP 200, never an error.
- Errors: 400 bad body or unknown event, 401/403 auth, 404 request not found, 409 status does not match the event, 502 `MailUnreachableError` with the text `Mail server not reachable. Is Mailpit running? (npm run mailpit)`, 500 `MailConfigError` or anything unexpected.
- `APP_BASE_URL` defaults to `http://localhost:3000`; trailing slash stripped. Cancel `reason`: trimmed, capped at 500 characters.
- Dedupe marker id: `<toggle>__<requestId>__<updated_at>` for loan-request emails, `low_stock__<transactionId>` for low stock, collection `sent_notifications`, Admin SDK `create()` only. No `firestore.rules` change.
- `src/lib/firebase/loanRequests.ts` is not modified.
- Commits: author via `git -c user.name="Claude" -c user.email="noreply@anthropic.com"`, use `git --no-optional-locks` for reads, end every message with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01VvEEW1uQ6dvrYkrtHvbNuN`.
- **Dirty files:** these already hold the user's unrelated uncommitted edits: `handout.md`, `src/types/database.ts`, `src/app/(portal)/lend/requests/page.tsx`, `src/app/(protected)/dashboard/page.tsx`, `src/app/(protected)/loan-requests/page.tsx`, `src/app/(protected)/settings/notifications/page.tsx`. Never `git add` them directly. Make each edit with a small Python script and run the same script a second time on `git show HEAD:<path>`; write that result as a blob (`git hash-object -w`) and stage it with `git update-index --cacheinfo 100644,<sha>,<path>`. The working file keeps the user's hunks. Read and write CRLF files with `open(..., newline='')`. If an edit cannot be applied to the HEAD version cleanly, leave it uncommitted and list it for the user.
- Run the lint for new/changed files with `npx eslint -f json <files>` and parse the result (`-f unix` is unavailable); `npx tsc --noEmit` may only show the known TS2307 for `nodemailer` until the user runs `npm install`. The 4 existing lint problems in `stock-out/page.tsx` are not ours.
- Harness commands (run from `$HOME/mailtest`; copy the changed source to its `.mts` name first for the pure modules): `node --conditions=react-server --experimental-strip-types check-<name>.mts`; for routes: `PROJECT_DIR=$HOME/mnt/Project_files_Claude_Code/SmartStock-NWU node --no-warnings --experimental-strip-types --import ./route/register.mjs check-<name>.mts`. Existing suites must stay green: check-mailer 7, check-templates 4, check-stockout-route 13, `python3 check-closure.py` from the repo.

## Review Focus

- A borrower triggers an admin event, or an admin triggers a borrower event, on a request whose status happens to match: must be 403, nothing sent (Task 5).
- Another borrower (not the request's owner) calls a borrower event: 403 (Task 5).
- Two near-simultaneous calls for the same transition: exactly one email (Task 4, `duplicate`).
- The send fails after the marker was written: the marker is removed so a retry sends (Task 4).
- A hostile staff name, note or cancel reason (`<script>`, quotes): escaped in HTML (Tasks 2, 3).
- An old request with no `reference_no`, no `to_date`, or a line offered 0: reads sensibly, never "null" or "undefined" (Tasks 2, 3).
- Stock Out where the confirmation skips (no staff email) still sends the low-stock email, and a product already below threshold stays quiet (Task 6).
- A leftover `true` for an unbuilt toggle in Firestore: shown off, never sends (Tasks 1, 4).

## File Map

- Create `src/lib/notificationCatalog.ts` (pure, no server-only): `LoanRequestEvent`, `LOAN_REQUEST_EVENTS`, `UNIMPLEMENTED_NOTIFICATIONS`, `isNotificationImplemented`.
- Create `src/lib/server/notificationDelivery.ts`: toggle check, recipients, dedupe marker, `deliver`, `appBaseUrl`.
- Create `src/app/api/notifications/loan-request/route.ts`.
- Create `src/lib/firebase/notifyEvent.ts` (client helper).
- Modify `src/lib/server/emailTemplates.ts` (new templates), `src/app/api/notifications/stock-out/route.ts` (low stock), `src/lib/firebase/notificationSettings.ts`, `src/types/database.ts` (comments only), the settings page, four call-site pages, `handout.md`.

---

### Task 1: Settings catalog and "not implemented yet"

**Files:**
- Create: `src/lib/notificationCatalog.ts`
- Modify: `src/lib/firebase/notificationSettings.ts`, `src/app/(protected)/settings/notifications/page.tsx`, `src/types/database.ts` (comment text only)
- Test: `$HOME/mailtest/check-catalog.mts` (not in repo)

**Interfaces:**
- Produces:
  - `export type LoanRequestEvent = 'new_loan_request' | 'loan_request_approved' | 'loan_request_countered' | 'loan_request_declined' | 'approved_pickup_cancelled' | 'loan_request_counter_accepted' | 'loan_request_counter_declined' | 'loan_request_withdrawn'`
  - `export const LOAN_REQUEST_EVENTS: readonly LoanRequestEvent[]` (all eight, in that order)
  - `export const UNIMPLEMENTED_NOTIFICATIONS: ReadonlySet<NotificationSettingKey>` (the three keys)
  - `export function isNotificationImplemented(key: NotificationSettingKey): boolean`
  - `NotificationEmailDefinition` gains `implemented?: boolean` (false for the three keys, derived from the set).
- Reason for the separate pure file: `notificationSettings.ts` imports the client Firebase SDK, which server code must not load. This refines the spec's "next to the definitions".

- [ ] **Step 1: Write the failing test** `check-catalog.mts` (copy `notificationCatalog.ts` to `notificationCatalog.mts` in the scratch dir; import `type`-only from database is erased):

```ts
check('three unbuilt keys are not implemented', () => {
  for (const k of ['loan_request_expired','overdue_return_alert','insufficient_pickup_alert'])
    assert.equal(isNotificationImplemented(k), false)
})
check('the other eleven are implemented', () => { assert.equal(['stock_out_confirmation','loan_request_approved','loan_request_countered','loan_request_declined','approved_pickup_cancelled','loan_request_counter_accepted','loan_request_counter_declined','loan_request_withdrawn','new_loan_request','incoming_pickup_confirmed','low_stock_alert'].every(isNotificationImplemented), true) })
check('LOAN_REQUEST_EVENTS lists eight events', () => assert.equal(LOAN_REQUEST_EVENTS.length, 8))
```

- [ ] **Step 2: Run it** (`node --experimental-strip-types check-catalog.mts`). Expected: FAIL, module not found.
- [ ] **Step 3: Create `notificationCatalog.ts`** with the exports above (imports `NotificationSettingKey` as a type from `@/types/database`).
- [ ] **Step 4: Run it.** Expected: 3 ok.
- [ ] **Step 5: Update `notificationSettings.ts`:** definitions for the three keys get `implemented: false` (use `!UNIMPLEMENTED_NOTIFICATIONS.has(key)` when building so the set stays the single source); `DEFAULT_NOTIFICATION_SETTINGS` is `isNotificationImplemented(key)` per key (false for the three, true otherwise); `loadNotificationSettings()` forces the three to `false` after merging Firestore values; fix the comment above the defaults (nothing-sends-yet wording) and the `approved_pickup_cancelled` description (reason is optional, not always asked). Edit the `NotificationSettingKey` comment block in `database.ts` the same way (comment only; use the dirty-file recipe).
- [ ] **Step 6: Update the settings page:** `NotificationRow` shows a "Not implemented yet" badge when `definition.implemented === false`; `handleToggle(key, next)` returns early without calling `setNotificationSetting` when `next` is true and the key is not implemented, and sets the existing `error` state to `` `${label} isn't implemented yet, so it can't be turned on.` ``; the stale "Sending isn't actually wired up" comment is corrected. Dirty-file recipe for the page.
- [ ] **Step 7: Verify:** harness green, `npx tsc --noEmit` (only TS2307), eslint on the three changed/new source files shows no new problems.
- [ ] **Step 8: Commit** `feat: mark unbuilt notification toggles as not implemented`.

### Task 2: Staff email templates

**Files:**
- Modify: `src/lib/server/emailTemplates.ts`
- Test: `$HOME/mailtest/check-templates.mts` (extend; keep the existing 4)

**Interfaces:**
- Produces (all return `RenderedEmail`):
  - `export interface RequestEmailLine { productName: string; requested: number; offered: number }`
  - `export interface RequestEmailBase { staffName: string; reference: string | null; fromDate: string; toDate: string | null; lines: RequestEmailLine[]; buttonUrl: string }`
  - `loanRequestApprovedEmail(i: RequestEmailBase)`, `counterAcceptedEmail(i)`, `counterDeclinedEmail(i)`, `requestWithdrawnEmail(i)`
  - `loanRequestCounteredEmail(i: RequestEmailBase & { originalFromDate: string; originalToDate: string | null; adminMessage: string | null })`
  - `loanRequestDeclinedEmail(i: RequestEmailBase & { adminMessage: string | null })`
  - `pickupCancelledEmail(i: RequestEmailBase & { reason: string | null })`

- [ ] **Step 1: Write the failing tests** (copy `emailTemplates.ts` to `emailTemplates.mts`); one `check` each:
  - approved: `subject === 'Loan request LR-1234ABCD approved'`; text contains `- USB-C Cable 1m × 2` (offered, not requested), the formatted window (`7 October 2026`, `14 October 2026`), and `buttonUrl`; a line with `offered: 0` is absent.
  - reference `null` in any of the seven: subject uses `your loan request` (e.g. `Your loan request was approved`) and the text never contains `null` or `undefined`.
  - `toDate: null`: text contains `No return date set.`.
  - countered: text contains `USB-C Cable 1m: 3 → 2`, a dropped line reads `Wireless Mouse: 1 → removed`, the original and new dates both appear when they differ, `adminMessage` appears when given and nothing like "undefined" when `null`.
  - declined: `adminMessage` present/absent as above. Cancelled: `reason` present/absent; text states the reservation is released.
  - counter accepted / declined / withdrawn: subject names the reference and the action; items listed.
  - escaping: `staffName: '<b>x</b>'`, `adminMessage: '"><script>'`, `reason: "<img src=x>"` never appear raw in `html`.
- [ ] **Step 2: Run.** Expected: FAIL (functions not exported).
- [ ] **Step 3: Implement the seven functions** in `emailTemplates.ts`. Shared private helper `describeWindow(from, to)` (`Pickup from <date>. Return by <date>.` / `No return date set.`) and `refLabel(reference)` (returns `Loan request <ref>` or `Your loan request`). Build on `renderEmailLayout` with `items` (name + offered quantity, offered 0 skipped; the countered email shows its own `requested → offered` lines as paragraphs instead of the items table) and `button: { label: 'View my requests', url: buttonUrl }`. Subjects: `<refLabel> approved | countered | declined | pickup cancelled | counter accepted | counter declined | withdrawn` (when reference is null: `Your loan request was <word>`).
- [ ] **Step 4: Run.** Expected: all ok (existing 4 plus new).
- [ ] **Step 5: Verify** tsc/eslint on the file; **Commit** `feat: add staff loan-request email templates`.

### Task 3: Admin email templates

**Files:** Modify `src/lib/server/emailTemplates.ts`; Test `check-templates.mts` (extend).

**Interfaces:**
- Consumes: `RequestEmailLine`, `renderEmailLayout`, `formatDate` from Task 2/foundation.
- Produces:
  - `newLoanRequestEmail(i: { staffName: string; reference: string | null; fromDate: string; toDate: string | null; lines: RequestEmailLine[]; message: string | null; buttonUrl: string }): RenderedEmail`
  - `incomingPickupConfirmedEmail(i: { staffName: string; reference: string | null; fromDate: string; toDate: string | null; lines: RequestEmailLine[]; viaCounter: boolean; buttonUrl: string }): RenderedEmail`
  - `export interface LowStockProduct { name: string; onHand: number; threshold: number }`
  - `lowStockEmail(i: { products: LowStockProduct[]; buttonUrl: string }): RenderedEmail`

- [ ] **Step 1: Write the failing tests:**
  - new request: subject `New loan request LR-1234ABCD from Jessica Moore`; items use `requested`; requester's note appears (escaped) or is omitted when `null`; button label `Review request`.
  - pickup confirmed: subject `Pickup confirmed: Jessica Moore (LR-1234ABCD)`; items use `offered` (0 skipped); text says `approved as requested` when `viaCounter` is false and `after a counter offer` when true.
  - low stock: one product → subject `Low stock: 1 product at or below its reorder level`; three → `Low stock: 3 products at or below their reorder level`; each product line shows `on hand` and `reorder at`; `onHand <= 0` is marked `OUT OF STOCK`; names escaped.
  - null reference works in the first two (falls back to `a loan request`).
- [ ] **Step 2: Run.** FAIL. **Step 3: Implement** the three functions. **Step 4: Run.** Expect all ok. **Step 5: Verify + Commit** `feat: add admin loan-request and low-stock email templates`.

### Task 4: Delivery helper (toggle, recipient, dedupe)

**Files:**
- Create: `src/lib/server/notificationDelivery.ts`
- Test: `$HOME/mailtest/check-delivery.mts`; extend the in-memory stub `route/stubs/admin.mjs` (harness only) with `doc(id).create(data)` (throws an error with `code: 6` if it exists, and increments a `__CREATED` log), `doc(id).delete()`, and `id` on `where().get()` docs.

**Interfaces:**
- Consumes: `sendMail`, `MailUnreachableError` from `mailer.ts`; `RenderedEmail`; `isNotificationImplemented`, `NotificationSettingKey`.
- Produces:
  - `export type SkipReason = 'mail_disabled' | 'toggle_off' | 'no_email' | 'duplicate' | 'not_implemented'`
  - `export interface DeliveryResult { toggle: NotificationSettingKey; sent: boolean; reason?: SkipReason }`
  - `export function appBaseUrl(env?: NodeJS.ProcessEnv): string`
  - `export async function staffEmailFor(staffId: string): Promise<string>` (trimmed, `''` if none)
  - `export async function adminInboxEmail(): Promise<string>` (trimmed `admin_notification_email`, `''` if none)
  - `export async function deliver(opts: { toggle: NotificationSettingKey; dedupeKey: string; recipient: () => Promise<string>; render: () => Promise<RenderedEmail> }): Promise<DeliveryResult>`
  - `deliver` order: unimplemented -> `not_implemented`; settings read, explicit `false` -> `toggle_off`; empty recipient -> `no_email`; `create()` marker, already exists -> `duplicate`; `render()`; `sendMail`; if render or send throws, delete the marker (a failed delete is logged, the original error is rethrown) and rethrow.

- [ ] **Step 1: Write the failing tests:**
  - `appBaseUrl({})` is `http://localhost:3000`; `{APP_BASE_URL:'https://x.test/'}` is `https://x.test`.
  - unbuilt toggle with `true` in Firestore -> `{sent:false, reason:'not_implemented'}`, no marker created.
  - toggle `false` -> `toggle_off`; missing toggle counts as on; blank recipient -> `no_email` and no marker.
  - happy path -> `{toggle, sent:true}`, one email in the SMTP sink, one marker with the given id.
  - same `dedupeKey` twice -> second is `duplicate`, still one email.
  - send failure (SMTP port closed) -> rejects with `MailUnreachableError` and the marker is gone (a retry with the port open then sends).
  - `adminInboxEmail()` trims, returns `''` when unset.
- [ ] **Step 2: Run.** FAIL. **Step 3: Implement** `notificationDelivery.ts` (settings doc `settings/notifications`; marker doc fields `toggle`, `entity_id` (the part of the key after the first `__`), `created_at` ISO; treat Firestore error code 6 / `ALREADY_EXISTS` as duplicate). **Step 4: Run** (plus the three existing suites). **Step 5: Verify + Commit** `feat: add notification delivery helper with dedupe markers`.

### Task 5: Loan-request notification route

**Files:**
- Create: `src/app/api/notifications/loan-request/route.ts`
- Test: `$HOME/mailtest/check-loanrequest-route.mts` (same style as `check-stockout-route.mts`: `setup()`, `call(body, token)`, sink SMTP on 1026, tokens `tok-admin`, `tok-borrower` (owner of staff `s1`), `tok-other` (a different borrower))

**Interfaces:**
- Consumes: `requireSignedIn`, `requireAdmin`, `ApiError` from `staffAdmin.ts`; `deliver`, `staffEmailFor`, `adminInboxEmail`, `appBaseUrl`, `DeliveryResult` from Task 4; `LoanRequestEvent`, `LOAN_REQUEST_EVENTS` from Task 1; the nine templates from Tasks 2 and 3.
- Produces: `POST` handler. Body `{ event: LoanRequestEvent, requestId: string, reason?: string }`. Response `200 { results: DeliveryResult[] }`, or `{ results: [{ toggle: <first email's toggle>, sent: false, reason: 'mail_disabled' }] }` when mail is off (checked right after body validation, before reading the request).
- Event table (caller, required status, emails): exactly the table in spec section 4. Borrower = signed in and `staff/{request.staff_id}.uid === caller uid`. Both emails of a fan-out event are attempted independently; if one throws, the other still runs, then the first thrown error is mapped to its status.
- Data: request doc `loan_requests/{requestId}`; lines from `loan_request_lines` where `request_id == requestId`; staff name from `request.staff_name`; dedupe key `${toggle}__${requestId}__${request.updated_at}`; button URLs `${appBaseUrl()}/lend/requests` (staff emails), `/loan-requests` (new request), `/dashboard` (pickup confirmed).

- [ ] **Step 1: Write the failing tests** (a test per line):
  - no Authorization -> 401; unknown `event` or missing `requestId` -> 400; unknown request -> 404.
  - mail disabled -> `mail_disabled` result and the request doc is never read (`__READS` counts only the auth lookups).
  - for each of the eight events: happy path sends the expected email(s) to the right address (staff email trimmed from `staff/s1.email`; admin mail to `settings/notifications.admin_notification_email`) with subject containing the reference.
  - `loan_request_approved` and `loan_request_counter_accepted` send two emails; with `incoming_pickup_confirmed:false` only the staff email goes out; with the staff email blank the admin one still goes out (`no_email` for the other).
  - wrong status for each event (e.g. `loan_request_approved` on a `pending` request) -> 409, nothing sent.
  - borrower calls `loan_request_approved` -> 403; admin calls `loan_request_counter_accepted` -> 403; `tok-other` calls `loan_request_withdrawn` on `s1`'s request -> 403.
  - `declined` + admin caller sends the declined email; `declined` + borrower caller sends the counter-declined email (event name decides, caller role must match it).
  - cancel `reason` of 600 characters is cut to 500 in the delivered email; `reason` ignored for other events.
  - blank admin inbox -> `no_email` for admin emails, 200.
  - same call twice -> second result `duplicate`, one email in the sink.
  - SMTP down -> 502 with the Mailpit text, and the marker is gone.
  - unbuilt toggle values never matter here (no event maps to them).
- [ ] **Step 2: Run.** FAIL (route missing).
- [ ] **Step 3: Implement the route.** Order: `requireSignedIn` -> parse and validate body -> `isMailEnabled()` -> read request -> role check (`requireAdmin` for admin events, owner check for borrower events, 403) -> status check (409) -> load lines -> `deliver` per email. The same error mapping as the Stock Out route (copy its `catch` block shape).
- [ ] **Step 4: Run** the new suite and the existing four. Expected: all ok.
- [ ] **Step 5: Verify** tsc/eslint on the route; `python3 check-closure.py` passes (nothing imports untracked files).
- [ ] **Step 6: Commit** `feat: add loan-request notification route`.

### Task 6: Low-stock email from Stock Out

**Files:**
- Modify: `src/app/api/notifications/stock-out/route.ts`
- Test: extend `$HOME/mailtest/check-stockout-route.mts` (add `products` to `baseDb()`: `p1 {name:'USB-C Cable 1m', quantity_on_hand: 4, reorder_threshold: 5}`, `p2 {name:'Wireless Mouse', quantity_on_hand: 10, reorder_threshold: 5}`; add `admin_notification_email` to the happy-path settings)

**Interfaces:**
- Consumes: `deliver`, `adminInboxEmail`, `appBaseUrl` (Task 4); `lowStockEmail`, `LowStockProduct` (Task 3).
- Produces: the success response becomes `{ sent, reason?, lowStock: { sent: boolean, reason?: SkipReason } }`. Early returns for `mail_disabled`, `not_out` keep their current shape (no `lowStock`); confirmation skips (`toggle_off`, `no_email`) still run the low-stock step and report `{ sent:false, reason, lowStock }`.
- Rule: per product on the transaction, `issued` = summed line quantity, `after` = product's current `quantity_on_hand`, `before = after + issued`; crossed when `before > reorder_threshold && after <= reorder_threshold`. One email lists all crossed products; dedupe key `low_stock__<transactionId>`; toggle `low_stock_alert`; recipient `adminInboxEmail()`.

- [ ] **Step 1: Write the failing tests:** t1 issues 3 of `p1` (on hand now 4, threshold 5, before 7): crossed -> one low-stock email to the admin inbox listing `USB-C Cable 1m`, not the mouse; `p1` on hand 0 after issuing 3 -> marked `OUT OF STOCK`; both products crossed -> one email with two products; a product already at its threshold before the Stock Out (override the lines so t1 issues 1 of `p1`: on hand 4 after, 5 before, threshold 5) -> no crossing, `lowStock: { sent:false }` and no email; confirmation `no_email` (staff `s2`) still sends low stock; `low_stock_alert:false` -> `toggle_off`; blank admin inbox -> `no_email`; repeat call -> `lowStock.reason === 'duplicate'`; all 13 existing tests still pass (adjust only their expected bodies where `lowStock` is now present).
- [ ] **Step 2: Run.** FAIL. **Step 3: Implement:** extract the existing confirmation steps into a private `sendConfirmation(...)` returning `{ sent, reason? }`, then call a private `sendLowStock(transactionId, lines)`. Missing product doc -> skip that product.
- [ ] **Step 4: Run** all suites. **Step 5: Verify** tsc/eslint, closure. **Step 6: Commit** `feat: send a low stock email after Stock Out`.

### Task 7: Client helper and call sites

**Files:**
- Create: `src/lib/firebase/notifyEvent.ts`
- Modify: `src/app/(portal)/lend/cart/page.tsx`, `src/app/(portal)/lend/requests/page.tsx`, `src/app/(protected)/loan-requests/page.tsx`, `src/app/(protected)/dashboard/page.tsx`
- Test: `$HOME/mailtest/check-notify-event.mts` (stub `sonner` and `@/lib/firebase/staff` via the route hooks pattern)

**Interfaces:**
- Consumes: `postStaffAdmin` from `src/lib/firebase/staff.ts`; `LoanRequestEvent` from Task 1.
- Produces: `export function notifyLoanRequestEvent(user: User | null | undefined, event: LoanRequestEvent, requestId: string, extra?: { reason?: string | null }): void` (fire-and-forget; never throws; no-op when `user` is null; on a rejected call shows `toast.error("Saved, but the email couldn't be sent.")`; successful skips are silent).

- [ ] **Step 1: Write the failing tests:** posts to `/api/notifications/loan-request` with `{ event, requestId }` (and `reason` only when given and non-empty); a rejected post produces exactly one toast with the text above and no throw; a null user posts nothing.
- [ ] **Step 2: Run.** FAIL. **Step 3: Implement the helper.**
- [ ] **Step 4: Wire the call sites** (each directly after the transition's `await` resolves, before UI refresh; the call must not be awaited):
  - cart page: `const id = await submitLoanRequest(...)`, then `notifyLoanRequestEvent(user, 'new_loan_request', id)`.
  - portal requests page: `handleAccept` -> `loan_request_counter_accepted`, `handleDecline` -> `loan_request_counter_declined`, `handleWithdraw` -> `loan_request_withdrawn` (id `r.id`).
  - admin loan-requests page: `handleApprove` -> `loan_request_approved`, `confirmSendCounter` -> `loan_request_countered`, `confirmDecline` -> `loan_request_declined` (id `r.id`).
  - dashboard `confirmCancelPickup` -> `approved_pickup_cancelled` with `{ reason: cancelReason.trim() || null }`, id `cancelling.id`.
  Add the import and, where `user` is not already in scope, take it from `useAuth()`. Use the dirty-file recipe for the three dirty pages (the cart page is clean).
- [ ] **Step 5: Run the harness; tsc (only TS2307); eslint on the new helper and the four pages: no new problems** (lint `git show HEAD:<path>` saved to a temp file for the three dirty pages and compare problem counts; the new helper must be 0/0).
- [ ] **Step 6: Commit** `feat: trigger loan-request emails from the app` (only our hunks).

### Task 8: Docs, manual checklist and final verification

**Files:** Modify `handout.md` (dirty-file recipe; append a section "Email notifications (2026-10-02)"); Create nothing else.

- [ ] **Step 1: Write the handout section:** the 10 emails and their triggers, `APP_BASE_URL` (optional, default `http://localhost:3000`), the `sent_notifications` collection (server-only; delete a marker to resend), the three unbuilt toggles, and the manual checklist below.
- [ ] **Step 2: Manual checklist for the user** (Windows, Docker Desktop running, `npm install`, `npm run mailpit`, `npm run dev:emulators`; set the admin notification email on Settings → Notifications first; inbox at http://localhost:8025): (1) submit a request from the portal -> "New loan request" to the admin inbox; (2) approve as-is -> staff "approved" and admin "pickup confirmed"; (3) a second request: counter it -> staff "countered"; accept it in the portal -> staff "counter accepted" and admin "pickup confirmed"; (4) a third: counter, then decline in the portal -> "counter declined"; (5) a fourth: decline as admin -> "declined"; (6) withdraw one in the portal -> "withdrawn"; (7) approve one, then Dashboard Cancel pickup with a reason -> "pickup cancelled"; (8) Stock Out taking a product down to its reorder threshold -> "Low stock"; (9) switch one toggle off and repeat its action -> no email; (10) try to switch on "Loan request expired" -> inline "isn't implemented yet" message and the toggle stays off; (11) stop Mailpit and approve a request -> the "Saved, but the email couldn't be sent." toast, request still approved.
- [ ] **Step 3: Final verification:** all harness suites green (existing four plus catalog, delivery, loan-request route, notify-event), `python3 check-closure.py` from the repo, `npx tsc --noEmit`, eslint on every new/changed source file; `git --no-optional-locks status` lists the left-uncommitted files for the user.
- [ ] **Step 4: Commit** the handout hunk if the recipe applies cleanly, otherwise leave it and report: `docs: document email notifications`.

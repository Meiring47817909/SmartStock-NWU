# Email notifications — design

Date: 2026-10-02
Branch: `email-notifications` (off `mailpit-foundation`)
Builds on: `2026-10-02-mailpit-foundation-design.md` (mailer, templates, Stock Out confirmation, Docker Mailpit).

## 1. Goal

Send the remaining event-driven emails listed on Settings → Notifications, so that doing the action in the app puts the right email in Mailpit, with the toggle respected, no duplicates, and a failed email never blocking the action.

Success looks like:

- Each action below produces exactly one email per recipient, with correct content, when its toggle is on and mail is enabled.
- Switching a toggle off stops exactly that email.
- Repeating or replaying a call never sends a second copy.
- If sending fails, the loan request / Stock Out is already saved and unchanged; the user sees a toast.

## 2. Scope

Built (10 toggles):

| Toggle key | Recipient | Triggered by |
| --- | --- | --- |
| `loan_request_approved` | Staff member | Admin approves as-is |
| `loan_request_countered` | Staff member | Admin sends a counter |
| `loan_request_declined` | Staff member | Admin declines |
| `approved_pickup_cancelled` | Staff member | Admin cancels an accepted pickup (Dashboard) |
| `loan_request_counter_accepted` | Staff member | Staff accepts a counter |
| `loan_request_counter_declined` | Staff member | Staff declines a counter |
| `loan_request_withdrawn` | Staff member | Staff withdraws their own request |
| `new_loan_request` | Admin inbox | Staff submits a request |
| `incoming_pickup_confirmed` | Admin inbox | A request becomes `accepted` (as-is or counter accepted) |
| `low_stock_alert` | Admin inbox | A Stock Out takes a product to or below its reorder threshold |

Already done: `stock_out_confirmation`, the login email.

NOT built now: `loan_request_expired`, `overdue_return_alert`, `insufficient_pickup_alert` (they need a timer). They default to off, show "Not implemented yet" in Settings, cannot be switched on, and the server never sends them (section 8).

Out of scope: retries/queues, delivery to a real SMTP provider, emails for manual stock edits on the Products page, Stock In and Returns, audit-log entries for sent emails.

## 3. Approach

Loan-request transitions stay client-side exactly as today (`loanRequests.ts`, audited, covered by `firestore.rules`). After a transition succeeds, the page makes a background call to a server route with `{ event, requestId }`. The server re-reads the request, checks who is calling and that the request's state matches the event, checks the toggle, finds the recipient, builds the email and sends. This is the same pattern as the Stock Out confirmation.

Rejected: moving the transitions into server routes (rewrites working audited code and rules), and Cloud Functions (none in the project; needs a paid plan).

## 4. Server route: `POST /api/notifications/loan-request`

File: `src/app/api/notifications/loan-request/route.ts` (server-only).

Body: `{ event: LoanRequestEvent, requestId: string, reason?: string }`.
Response: always `{ results: { toggle: NotificationSettingKey, sent: boolean, reason?: SkipReason }[] }`, one entry per email the event can send (one or two, section 5).

Events and their checks (all require a signed-in caller; the request must exist, else 404):

| Event | Caller must be | Request status must be | Emails sent |
| --- | --- | --- | --- |
| `new_loan_request` | borrower of the request | `pending` | `new_loan_request` (admin inbox) |
| `loan_request_approved` | admin | `accepted` | `loan_request_approved` (staff) + `incoming_pickup_confirmed` (admin inbox) |
| `loan_request_countered` | admin | `countered` | `loan_request_countered` (staff) |
| `loan_request_declined` | admin | `declined` | `loan_request_declined` (staff) |
| `approved_pickup_cancelled` | admin | `withdrawn` | `approved_pickup_cancelled` (staff) |
| `loan_request_counter_accepted` | borrower | `accepted` | `loan_request_counter_accepted` (staff) + `incoming_pickup_confirmed` (admin inbox) |
| `loan_request_counter_declined` | borrower | `declined` | `loan_request_counter_declined` (staff) |
| `loan_request_withdrawn` | borrower | `withdrawn` | `loan_request_withdrawn` (staff) |

- "Admin" is `requireAdmin`. "Borrower" is `requireSignedIn` plus: the `staff` document named by `request.staff_id` has `uid` equal to the caller's uid.
- Both an admin decline and a staff counter-decline end as `declined`, and both an admin cancel and a staff withdraw end as `withdrawn`. The caller's role is what tells them apart, so an admin cannot trigger a staff-side event and vice versa.
- An admin could trigger `loan_request_approved` for a request that was in fact accepted via a counter. This is accepted: it is an admin, the dedupe key (section 6) still allows only one send per transition, and the effect is one extra confirmation email.
- Check order, cheapest first: caller auth, body validation, `isMailEnabled()` (returns `mail_disabled` before any read of the request), request read, caller/status checks, then per email: toggle, recipient, dedupe, build, send.
- `reason` is only used by `approved_pickup_cancelled`. The cancel reason is not stored on the request (only in the audit entry), so the Dashboard passes it. It is trimmed, capped at 500 characters, treated as untrusted text and HTML-escaped by the template.

Skip reasons: `mail_disabled`, `toggle_off`, `no_email`, `duplicate`, `not_implemented`. A skip is a normal 200 response, never an error. Errors: 400 bad body or unknown event, 401/403 auth, 404 request not found, 409 state mismatch (status does not match the event), 502 `MailUnreachableError` ("Mail server not reachable. Is Mailpit running? (npm run mailpit)"), 500 `MailConfigError` or anything unexpected.

Recipients:

- Staff emails: `staff/{request.staff_id}.email`, trimmed. Empty means `no_email`.
- Admin emails: `settings/notifications.admin_notification_email`, trimmed. Empty means `no_email`.
- Toggle test: only an explicit `false` is off (matches `DEFAULT_NOTIFICATION_SETTINGS`), except the three unbuilt toggles, which are always off (section 8).

## 5. Fan-out and low stock

- `loan_request_approved` and `loan_request_counter_accepted` each send two emails (staff + admin inbox). Each is checked, deduped and sent independently, so one toggle being off or one failing does not stop the other. If either send throws, the route reports the failure (502/500) after attempting both.
- Low stock lives in the existing `POST /api/notifications/stock-out` route. After the confirmation step (which may skip for any reason), the route computes the products that crossed: for each product on the transaction, `issued` is the summed line quantity, `after` is the product's current `quantity_on_hand`, `before = after + issued`. A product crossed if `before > reorder_threshold && after <= reorder_threshold`. If any crossed, one email lists all of them (name, on hand, reorder threshold, "OUT OF STOCK" when `after <= 0`), sent to the admin inbox if `low_stock_alert` is on.
- Low stock is independent of the confirmation: a skipped confirmation (no staff email, toggle off) does not skip it, and vice versa. The response gains `lowStock: { sent, reason? }` next to the existing fields; the Stock Out page keeps ignoring skips.
- Known limit: `after` is read when the route runs, so a second Stock Out landing in between could make a product look like it crossed later than it did. At most this shifts the email by one Stock Out; accepted.

## 6. No duplicates: `sent_notifications`

New collection, written only by the server via Admin SDK `create()`. `firestore.rules` already ends with `match /{document=**} { allow read, write: if false }`, so clients cannot read or write it; no rule change.

- Document id: `<toggle>__<requestId>__<updated_at>` for loan-request emails (every transition changes `updated_at`, so a later transition of the same request is a new key, while a repeat of the same one is not), and `low_stock__<transactionId>` for low stock. Fields: `toggle`, `entity_id`, `created_at`.
- Flow: `create()` before sending. If it fails with already-exists, skip with `duplicate`. If the send then throws, delete the marker so a retry can send. If the delete itself fails, log it and surface the original send error.
- Markers are never read back by the app and are not cleaned up (tiny, append-only).

## 7. Emails (templates)

All in `src/lib/server/emailTemplates.ts`, pure functions returning `RenderedEmail`, built on `renderEmailLayout` (purple header, everything escaped). Subjects start with the reference where one exists (`reference_no`, falling back to "your loan request" when an old request has none).

Staff emails (button "View my requests" → `${APP_BASE_URL}/lend/requests`):

- Approved: reference, items with `offered_quantity`, pickup window.
- Countered: per line "requested → offered" (a line offered 0 is marked "removed"), original vs new dates when they differ, the admin's note (`admin_message`) if any.
- Declined: reference, items, the admin's note if any.
- Pickup cancelled: reference, items, the cancel reason if given; states the reservation is released.
- Counter accepted / declined / withdrawn: short confirmations with reference, items and dates, as a record.

Admin emails:

- New loan request (button → `${APP_BASE_URL}/loan-requests`): requester name, reference, items and requested quantities, dates, their note if any.
- Incoming pickup confirmed (button → `${APP_BASE_URL}/dashboard`): requester name, reference, items with offered quantities, pickup window, and whether it was approved as-is or after a counter.
- Low stock (button → `${APP_BASE_URL}/products`): one list of every crossed product with on-hand vs reorder threshold; out-of-stock products are called out. Subject names the count.

Dates use the existing `formatDate`; a null `to_date` reads "No return date set." Items come from `loan_request_lines` for the request, with lines whose offered quantity is 0 omitted from approved/pickup emails.

`APP_BASE_URL`: new optional env var, default `http://localhost:3000`, read in the route and passed to templates (templates stay pure). Trailing slash stripped. Documented in the handout; not added to `dev:emulators` since the default matches.

## 8. Settings → Notifications changes

- `NotificationEmailDefinition` gains an optional `implemented?: boolean` (default true); the three unbuilt toggles set `implemented: false`. This flag is the single source of truth for the page and the defaults; the server uses the exported `isNotificationImplemented(key)` helper next to the definitions.
- `DEFAULT_NOTIFICATION_SETTINGS` is `false` for those three, `true` for the rest. `loadNotificationSettings()` forces them to `false` even if Firestore holds `true`.
- The page shows a "Not implemented yet" badge on those rows. `handleToggle(key, true)` for one of them does not call `setNotificationSetting`; it shows an inline message ("<label> isn't implemented yet, so it can't be turned on.") and the toggle stays off. Switching off is a no-op.
- The server's toggle check treats those three as off regardless of Firestore (belt and braces for the `not_implemented` skip).
- Text fixes: the comment above `DEFAULT_NOTIFICATION_SETTINGS` and the `NotificationSettingKey` comments no longer say nothing is wired up; the `approved_pickup_cancelled` description no longer says the admin is always asked for a message.

## 9. Client wiring

- New helper `src/lib/firebase/notifyEvent.ts`: `notifyLoanRequestEvent(user, event, requestId, extra?)` calls `postStaffAdmin('/api/notifications/loan-request', user, ...)` fire-and-forget. On a thrown error it shows `toast.error("Saved, but the email couldn't be sent.")`. Skips are silent. It never throws.
- Call sites, each placed after the transition's `await` succeeds and before/independent of any UI refresh:
  - `(portal)/lend/cart/page.tsx` after `submitLoanRequest` (event `new_loan_request`, id returned by it).
  - `(portal)/lend/requests/page.tsx` after `acceptCounter`, `declineCounter`, `withdrawRequest`.
  - `(protected)/loan-requests/page.tsx` after `approveAsIs`, `sendCounter`, `declineRequest`.
  - `(protected)/dashboard/page.tsx` after `withdrawRequest` in `confirmCancelPickup` (event `approved_pickup_cancelled`, with the optional `reason`).
- `src/lib/firebase/loanRequests.ts` is not changed.
- Stock Out page: no change (it already calls the Stock Out route; low stock rides on it).

## 10. Testing

Harness outside the repo, same approach as the foundation (`$HOME/mailtest`, stubs for `next/server`, admin SDK and `server-only`):

- Templates: one check per email for subject, key content, escaping (a hostile note/name/reason), null date, a request with no reference, a zero-offered line.
- Loan-request route: for each event, a happy path; wrong caller role (staff calling an admin event, admin calling a borrower event, a different borrower); wrong status (409); toggle off; no recipient email; blank admin inbox; duplicate marker; send failure deletes the marker; mail disabled reads nothing; unbuilt toggles never send; fan-out sends both and one failing does not hide the other; missing/invalid body.
- Stock Out route: low stock crossing (above to at threshold, to zero, already below stays quiet, several products in one email), independence from the confirmation's skip, toggle off, blank admin inbox, duplicate.
- Settings: pure check that the three unbuilt keys default off, are forced off on load, and the toggle handler logic refuses to enable them.
- Static: `tsc` (only the known `nodemailer` TS2307 until `npm install`) and `eslint` on the new files.
- Manual (the user, Windows + Docker): a checklist in the plan that walks each action in the UI and checks the email in Mailpit at http://localhost:8025, plus the toggle-off and Settings "not implemented" behaviour.

## 11. Files

New: `src/app/api/notifications/loan-request/route.ts`, `src/lib/firebase/notifyEvent.ts`, and `src/lib/server/notificationDelivery.ts` (toggle check, recipient lookup, dedupe marker, shared by both routes).
Changed: `src/lib/server/emailTemplates.ts`, `src/app/api/notifications/stock-out/route.ts`, `src/lib/firebase/notificationSettings.ts`, `src/types/database.ts` (comments), `src/app/(protected)/settings/notifications/page.tsx`, the four call-site pages in section 9, `handout.md`.

## 12. Risks and notes

- Several of those pages and `handout.md` already have the user's uncommitted edits; commits will include only the hunks this work adds (same blob technique as the foundation), and anything that cannot be separated cleanly is left uncommitted and listed.
- The client-side call means a closed tab between the transition and the call loses the email. Accepted for a local/demo setup; the alternative (approach B) is out of scope.
- Real SMTP, a production domain for `APP_BASE_URL`, and the three timer emails are future work.

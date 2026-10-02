# Mailpit Foundation — Design

Date: 2026-10-02
Status: Draft for review
Scope: Step 1 of 3 of the email-notifications work (see "Out of scope").

## Purpose

Let the developer (and the sales/spin video) see the app's emails in a local
inbox, with nothing ever delivered to a real address. Success: clicking
**Send Login Email** on the Staff page, or completing a **Stock Out**, makes a
branded message appear in Mailpit's web inbox at http://localhost:8025.

## Background (what exists today)

- The app has no mailer: no nodemailer, no SMTP settings.
- The only email sent today is the Staff page's Send/Resend Login Email, which
  calls Firebase Auth's `sendPasswordResetEmail` from
  `src/app/api/staff/send-reset-email/route.ts`. The Auth emulator never
  delivers that message; it only records the link.
- Settings → Notifications lists 14 emails as toggles
  (`NOTIFICATION_EMAIL_DEFINITIONS` in `src/lib/firebase/notificationSettings.ts`).
  None are sent yet.
- Stock Out saves `transactions` and `transaction_lines` from the browser in
  `handleConfirm` (`src/app/(protected)/stock-out/page.tsx`).
- Server routes already have `requireSignedIn` / `requireAdmin`
  (`src/lib/server/staffAdmin.ts`). The repo has lint only, no test framework.

## Decisions made

- Scope: the foundation plus login emails plus one proof notification (Stock Out
  confirmation). The remaining 13 notification emails are later steps.
- Approach: own server-side mailer (nodemailer) switched by an environment
  variable; Mailpit run via Docker. Rejected: relaying Firebase's emulator
  email (not reusable for the 14 notifications).
- Platform: Windows / PowerShell; Docker Desktop is the Mailpit runtime.

## Design

### 1. Mailpit via Docker
`scripts/mailpit.mjs`, exposed as `npm run mailpit` and `npm run mailpit:stop`.
Runs `axllent/mailpit` as a container named `mailpit`, SMTP on 1025, web UI on
8025. Idempotent: running it twice replaces the container. Plain Node, so it
behaves the same in PowerShell.

### 2. Mailer — `src/lib/server/mailer.ts` (server-only)
`sendMail({ to, subject, html, text })` on `nodemailer`.
Environment: `MAIL_TRANSPORT` (only `smtp` enables sending), `SMTP_HOST`
(default `127.0.0.1`), `SMTP_PORT` (default `1025`), `MAIL_FROM` (default
`SmartStock NWU <no-reply@smartstock.local>`).
`isMailEnabled()` is true only when `MAIL_TRANSPORT=smtp`. With it unset the
mailer sends nothing and production behaviour is unchanged.

### 3. Local-only guard
If `FIREBASE_AUTH_EMULATOR_HOST` or `FIRESTORE_EMULATOR_HOST` is set, the mailer
refuses any `SMTP_HOST` other than `127.0.0.1`, `localhost` or `::1`, and throws
a clear error. Seeded gmail addresses can therefore never receive real mail.

### 4. Templates — `src/lib/server/emailTemplates.ts`
One shared SmartStock NWU layout (app purple, heading, paragraphs, optional
button, footer) rendered as HTML plus plain text. Two emails on top of it:
- **Login email** — greeting, "Set your password" button, short note.
- **Stock Out confirmation** — items, quantities, return date (or "no return
  date"), staff member's name.
Templates are pure functions of their inputs.

### 5. Login route change
`send-reset-email` keeps its decision tree unchanged. Only the final send step
is wrapped in one helper: when `isMailEnabled()`, call
`adminAuth.generatePasswordResetLink(email)` and send the Login email through the
mailer; otherwise call `sendPasswordResetEmail(clientAuth, email)` as today.
The response shape (`linked`, `email`, `uid`) is unchanged. If the SMTP
connection is refused the route returns 502 with the message "Mail server not
reachable. Is Mailpit running? (npm run mailpit)".

### 6. Stock Out confirmation
After `handleConfirm` saves the transaction and its lines, the page makes one
background `POST /api/notifications/stock-out` with `{ transactionId }` and the
caller's ID token.
Server (`requireSignedIn`): load the transaction, lines and staff via `adminDb`;
read `settings/notifications` (missing or non-boolean means on, matching
`DEFAULT_NOTIFICATION_SETTINGS`); then send. It skips, logging the reason on the
server, when the toggle is off, the staff member has no email, or the mailer is
disabled. Response: `{ sent: boolean, reason?: string }`.
The transaction document is not modified (transactions are append-only). The
email is sent once per save; no dedupe store.

### 7. Switching it on
`MAIL_TRANSPORT=smtp`, `SMTP_HOST=127.0.0.1`, `SMTP_PORT=1025` are added to the
`dev:emulators` script alongside the existing emulator variables. Plain
`npm run dev` is unaffected.

### Error handling
- Stock Out is never blocked by email. On a failed or errored background call the
  page shows a toast: "Stock Out saved, but the confirmation email couldn't be
  sent."
- Skips (toggle off, no email, mailer off) are silent to the user.
- Login email failures surface through the existing toast with the message above.

### Verification (manual; no test framework is added)
1. Start Docker Desktop, run `npm run mailpit` and `npm run dev:emulators`.
2. Click Send Login Email for a portal staff member; the message appears at
   http://localhost:8025 with a working set-password link.
3. Complete a Stock Out; a confirmation with the right items arrives.
4. Turn Stock Out confirmation off in Settings → Notifications; repeat; nothing
   arrives and the server log says why.
5. Set `SMTP_HOST` to a non-local host with the emulators running; the mailer
   refuses to send.
6. Stop Mailpit and click Send Login Email; the toast names Mailpit.
7. `npm run lint` passes.

### Setup the user must do
`npm install` (adds `nodemailer` and `@types/nodemailer`) and have Docker
Desktop running.

## Out of scope
- The other 13 notification emails (step 2: staff-facing; step 3: administrator
  emails, including the timer-based overdue and expiry alerts).
- New Audit Log entries, retry queues, and any production SMTP provider.
- Adding a test framework.

## Files touched
New: `scripts/mailpit.mjs`, `src/lib/server/mailer.ts`,
`src/lib/server/emailTemplates.ts`, `src/app/api/notifications/stock-out/route.ts`.
Changed: `package.json` (scripts, dependency), `package-lock.json`,
`src/app/api/staff/send-reset-email/route.ts`,
`src/app/(protected)/stock-out/page.tsx`, `handout.md` (short Mailpit section).

# Mailpit Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send the Staff page's login email and a Stock Out confirmation through an env-switched SMTP mailer into a local Mailpit inbox, with nothing ever delivered to a real address.

**Architecture:** One server-only mailer (`nodemailer`) enabled only by `MAIL_TRANSPORT=smtp`, a shared HTML/text email layout with two emails on top of it, the existing `send-reset-email` route switched to it when enabled, and one new notification route called in the background after a Stock Out is saved. Mailpit runs in Docker via a small Node script.

**Tech Stack:** Next.js 16.3 route handlers, TypeScript, `nodemailer`, Firebase Admin SDK (emulators), Docker (`axllent/mailpit`), PowerShell on the user's Windows machine.

**Spec:** `docs/superpowers/specs/2026-10-02-mailpit-foundation-design.md`

## Global Constraints

- Mailer env vars: `MAIL_TRANSPORT` (only the value `smtp` enables sending), `SMTP_HOST` (default `127.0.0.1`), `SMTP_PORT` (default `1025`), `MAIL_FROM` (default `SmartStock NWU <no-reply@smartstock.local>`). With `MAIL_TRANSPORT` unset nothing is sent and production behaviour is unchanged.
- Local-only guard: if `FIREBASE_AUTH_EMULATOR_HOST` or `FIRESTORE_EMULATOR_HOST` is set, `SMTP_HOST` must be `127.0.0.1`, `localhost` or `::1`, otherwise the mailer refuses and throws.
- Mailpit: image `axllent/mailpit`, container name `mailpit`, SMTP port 1025, web UI port 8025 (http://localhost:8025). `npm run mailpit` and `npm run mailpit:stop`; running start twice replaces the container.
- Mail env vars are added only to the `dev:emulators` script. Plain `npm run dev` must stay unaffected.
- Unreachable-server message, exactly: `Mail server not reachable. Is Mailpit running? (npm run mailpit)` (HTTP 502 from the login route).
- Stock Out toast on failure, exactly: `Stock Out saved, but the confirmation email couldn't be sent.` Stock Out is never blocked by email. The transaction document is never modified.
- Toggle semantics: `settings/notifications.stock_out_confirmation` missing or any non-`false` value means on.
- No test framework, no new Audit Log entries, no retry queue, no other notification emails.
- Every server module starts with `import 'server-only'`. New route handlers follow the shape of `src/app/api/staff/send-reset-email/route.ts`. `AGENTS.md` warns this is Next 16 with breaking changes: skim the route-handler guide in `node_modules/next/dist/docs/` before writing the new route.
- The user's machine is Windows/PowerShell. Never install packages from the Linux device shell into the project's `node_modules`; edit `package.json` and let the user run `npm install`.
- Work on a branch named `mailpit-foundation` created from the current branch. Commit messages end with:
  `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01VvEEW1uQ6dvrYkrtHvbNuN`

## Review Focus

- A staff or product name containing `<`, `>`, `&` or quotes must be HTML-escaped in every email (tested in Task 3).
- Stock Out with no return date (`lend_to` null) must read "No return date set", never "null" or "Invalid Date" (Task 3).
- A non-local `SMTP_HOST` while the emulators are active must be refused, including when only `FIRESTORE_EMULATOR_HOST` is set (Task 2).
- Mailpit not running must fail fast (within about 5 seconds) with the clear message, not hang the Staff page (Tasks 2 and 4).
- A product scanned under two barcodes must appear as one line with the summed quantity (Task 5).

## Scratch verification harness (used by Tasks 2 and 3)

The repo has lint only, so the pure modules are checked with throwaway scripts that are **not committed**. Create `$HOME/mailtest` outside the project, run `npm init -y && npm install nodemailer smtp-server server-only` there, and copy the module under test into it as `.mts` (for example `cp <project>/src/lib/server/mailer.ts $HOME/mailtest/mailer.mts`). Check scripts import `./mailer.mts` and use `node:assert/strict`. Run with:
`node --conditions=react-server --experimental-strip-types check-mailer.mts` (the `react-server` condition makes `server-only` a no-op). Re-copy the module before every run.

---

### Task 1: Dependency, Mailpit runner and dev script

**Files:**
- Create: `scripts/mailpit.mjs`
- Modify: `package.json` (dependencies, devDependencies, scripts `mailpit`, `mailpit:stop`, `dev:emulators`)
- Commit also: `docs/superpowers/specs/2026-10-02-mailpit-foundation-design.md`, this plan

**Interfaces:**
- Produces: `npm run mailpit`, `npm run mailpit:stop`; Mailpit listening on 1025/8025; env `MAIL_TRANSPORT=smtp SMTP_HOST=127.0.0.1 SMTP_PORT=1025` set by `npm run dev:emulators`.

- [ ] **Step 1: Create the branch**: `git checkout -b mailpit-foundation`.
- [ ] **Step 2: Confirm the failure first.** Run `node scripts/mailpit.mjs`. Expected: `Cannot find module` (script does not exist yet).
- [ ] **Step 3: Implement `scripts/mailpit.mjs`.** Plain Node, no dependencies. First CLI argument is `start` (default) or `stop`. `start`: `docker rm -f mailpit` (output ignored), then `docker run -d --name mailpit -p 1025:1025 -p 8025:8025 axllent/mailpit`, then print `Mailpit running: inbox http://localhost:8025, SMTP 127.0.0.1:1025`. `stop`: `docker rm -f mailpit`. Use `spawnSync('docker', args)`. If the spawn error code is `ENOENT`, or the exit status is non-zero, print `Docker was not found or is not running. Start Docker Desktop and try again.` and exit 1.
- [ ] **Step 4: Verify.** On the Linux device shell (no Docker): `node scripts/mailpit.mjs` prints the Docker message and exits 1; `node scripts/mailpit.mjs stop` does the same.
- [ ] **Step 5: Edit `package.json`.** Add scripts `"mailpit": "node scripts/mailpit.mjs start"` and `"mailpit:stop": "node scripts/mailpit.mjs stop"`. In `dev:emulators`, add `MAIL_TRANSPORT=smtp SMTP_HOST=127.0.0.1 SMTP_PORT=1025` after `FIREBASE_ADMIN_PROJECT_ID=demo-smartstock-nwu` and before `next dev`. Add `nodemailer` to dependencies and `@types/nodemailer` to devDependencies using caret ranges of the current versions (find them with `npm view nodemailer version` and `npm view @types/nodemailer version` in the scratch directory). Do not run `npm install` in the project.
- [ ] **Step 6: Verify `package.json` is valid JSON:** `node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log('ok')"` prints `ok`.
- [ ] **Step 7: Commit** (`feat: add Mailpit runner script and mail dependency`).
- [ ] **Step 8: User action (Windows):** run `npm install` so `nodemailer` and the lockfile entry exist, and start Docker Desktop. Later tasks can proceed without it; Task 6 needs it.

### Task 2: Mailer with local-only guard

**Files:**
- Create: `src/lib/server/mailer.ts`
- Scratch (uncommitted): `$HOME/mailtest/check-mailer.mts`

**Interfaces:**
- Produces (exact, used by Tasks 4 and 5):
  - `export interface MailMessage { to: string; subject: string; html: string; text: string }`
  - `export interface SmtpConfig { host: string; port: number; from: string }`
  - `export class MailConfigError extends Error {}` (bad port, or guard refusal)
  - `export class MailUnreachableError extends Error {}` (connection refused or timed out)
  - `export function isMailEnabled(env?: NodeJS.ProcessEnv): boolean`
  - `export function resolveSmtpConfig(env?: NodeJS.ProcessEnv): SmtpConfig` (throws `MailConfigError`)
  - `export async function sendMail(msg: MailMessage, env?: NodeJS.ProcessEnv): Promise<boolean>` (`false` when mail is disabled and nothing was sent, `true` when delivered to the SMTP server). `env` defaults to `process.env`. The module must have no `@/` imports so it can be copied into the scratch harness.

- [ ] **Step 1: Write the failing check `check-mailer.mts`** (it imports `./mailer.mts`, which has not been copied into the harness yet). Assertions, using `assert.deepEqual`, `assert.throws`, `assert.rejects`:
  - `isMailEnabled({})` is `false`; `isMailEnabled({ MAIL_TRANSPORT: 'smtp' })` is `true`; `'SMTP'` or `'true'` is `false`.
  - `resolveSmtpConfig({ MAIL_TRANSPORT: 'smtp' })` deep-equals `{ host: '127.0.0.1', port: 1025, from: 'SmartStock NWU <no-reply@smartstock.local>' }`.
  - `{ MAIL_TRANSPORT: 'smtp', SMTP_HOST: 'smtp.gmail.com', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' }` throws `MailConfigError`; the same with `FIRESTORE_EMULATOR_HOST` instead also throws; the same host with neither emulator variable returns a config; hosts `localhost` and `::1` pass with the emulator variable set.
  - `{ MAIL_TRANSPORT: 'smtp', SMTP_PORT: 'abc' }` throws `MailConfigError`.
  - `await sendMail(msg, {})` resolves `false` (no connection attempted).
  - With an `smtp-server` sink on port 1026 (`authOptional: true`, `disabledCommands: ['STARTTLS']`, collecting `rcptTo` and the message stream), `await sendMail(msg, { MAIL_TRANSPORT: 'smtp', SMTP_PORT: '1026' })` resolves `true` and the sink saw the recipient and the subject.
  - With nothing listening on 1027, `sendMail(msg, { MAIL_TRANSPORT: 'smtp', SMTP_PORT: '1027' })` rejects with `MailUnreachableError` in under 5000 ms.
- [ ] **Step 2: Run it** (harness command). Expected: FAIL, cannot import `./mailer.mts`.
- [ ] **Step 3: Implement `src/lib/server/mailer.ts`** to the signatures above. Use `nodemailer.createTransport({ host, port, secure: false, ignoreTLS: true, connectionTimeout: 4000, greetingTimeout: 4000 })` per send. Map nodemailer errors with `code` `ECONNECTION`, `ETIMEDOUT` or `ESOCKET` to `MailUnreachableError`; rethrow anything else. Guard hosts: `127.0.0.1`, `localhost`, `::1`.
- [ ] **Step 4: Copy the module into the harness and run the check.** Expected: all assertions pass, exit 0.
- [ ] **Step 5: Type check** `npx tsc --noEmit` in the project. Expected: no errors (before the user's `npm install`, the only acceptable error is TS2307 for `'nodemailer'`).
- [ ] **Step 6: Commit** (`feat: add env-switched SMTP mailer with emulator local-only guard`).

### Task 3: Email layout and the two emails

**Files:**
- Create: `src/lib/server/emailTemplates.ts`
- Scratch (uncommitted): `$HOME/mailtest/check-templates.mts`

**Interfaces:**
- Produces (exact, used by Tasks 4 and 5). The module has no imports:
  - `export interface RenderedEmail { subject: string; html: string; text: string }`
  - `export function renderEmailLayout(opts: { heading: string; paragraphs: string[]; button?: { label: string; url: string }; footer?: string }): { html: string; text: string }`
  - `export function loginEmail(input: { name: string; link: string }): RenderedEmail`
  - `export interface StockOutEmailLine { productName: string; quantity: number }`
  - `export function stockOutConfirmationEmail(input: { staffName: string; reference: string; lines: StockOutEmailLine[]; lendFrom: string | null; lendTo: string | null }): RenderedEmail` (dates are `YYYY-MM-DD` strings or null)

- [ ] **Step 1: Write the failing check `check-templates.mts`:**
  - `loginEmail({ name: "Tom <b>O'Brien</b> & Co", link: 'https://x.test/y?a=1&b=2' })`: `html` contains `&lt;b&gt;` and does not contain `<b>O'Brien`; `html` contains `href="https://x.test/y?a=1&amp;b=2"`; `text` contains the raw `https://x.test/y?a=1&b=2`; `subject` is non-empty.
  - `stockOutConfirmationEmail` with one line `{ productName: 'USB-C Cable 1m', quantity: 2 }`, reference `OUT-123`, `lendTo: '2026-10-14'`: both `html` and `text` contain `USB-C Cable 1m`, `OUT-123` and `14 October 2026`.
  - Same call with `lendTo: null`: `html` and `text` contain `No return date set` and do not contain `null` or `Invalid Date`.
  - A product named `Cable <script>alert(1)</script> & "Co"` renders escaped in `html` (no literal `<script>`).
- [ ] **Step 2: Run it** (`node --experimental-strip-types check-templates.mts`). Expected: FAIL, cannot import.
- [ ] **Step 3: Implement `emailTemplates.ts`.** A private `escapeHtml` applied to every interpolated value (including the `href`). Layout: white card on a light background, SmartStock NWU wordmark header in purple `#8046B5`, body text colour `#1a1a1a`, button as a purple `<a>` styled inline (email clients ignore stylesheets), footer line "Sent by SmartStock NWU". The plain-text version mirrors the content and prints the URL after the button label. Format dates with `new Date(y, m - 1, d).toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' })`. Login email: greeting "Hi <name>", one paragraph saying an administrator set up their SmartStock NWU lending portal login, button "Set your password", a short ignore-if-unexpected note. Stock Out email: heading "Stock Out confirmation", reference, an HTML table (plain text: one `- name × qty` line each) and the return-date line.
- [ ] **Step 4: Copy into the harness and run.** Expected: all assertions pass.
- [ ] **Step 5: Commit** (`feat: add shared email layout with login and Stock Out confirmation emails`).

### Task 4: Login email through the mailer

**Files:**
- Modify: `src/app/api/staff/send-reset-email/route.ts` (the three `sendPasswordResetEmail(clientAuth, ...)` call sites)

**Interfaces:**
- Consumes: `isMailEnabled`, `sendMail`, `MailUnreachableError`, `MailConfigError` (Task 2); `loginEmail` (Task 3).
- Produces: unchanged response shape `{ linked, email, uid }`; on SMTP refusal HTTP 502 with the exact unreachable message; on a guard or port error HTTP 500 with the error's message.

- [ ] **Step 1: Add a module-private** `async function deliverLoginEmail(email: string, name: string): Promise<void>` (not exported; Next route files may only export handlers). When `isMailEnabled()`: `const link = await adminAuth.generatePasswordResetLink(email)`, build `loginEmail({ name, link })`, `sendMail({ to: email, ... })`, mapping `MailUnreachableError` to `ApiError(502, <exact message>)` and `MailConfigError` to `ApiError(500, err.message)`. Otherwise: `await sendPasswordResetEmail(clientAuth, email)` exactly as today.
- [ ] **Step 2: Replace the three call sites** with `deliverLoginEmail(email, staffData.name || staffData.full_name || 'there')` (use the linked user's email in branch 1). The decision tree, response bodies and status codes stay as they are.
- [ ] **Step 3: Type check** `npx tsc --noEmit` and `npm run lint`. Expected: no new errors (same TS2307 allowance as Task 2 until `npm install`).
- [ ] **Step 4: Review the diff** (`git diff`): only the helper and the three call sites changed.
- [ ] **Step 5: Commit** (`feat: send staff login email through the mailer when MAIL_TRANSPORT=smtp`).

### Task 5: Stock Out confirmation

**Files:**
- Create: `src/app/api/notifications/stock-out/route.ts`
- Modify: `src/app/(protected)/stock-out/page.tsx` (`handleConfirm`, imports)

**Interfaces:**
- Consumes: `requireSignedIn`, `ApiError` from `@/lib/server/staffAdmin`; `adminDb` from `@/lib/firebase/admin`; `isMailEnabled`, `sendMail`, `MailUnreachableError`, `MailConfigError` (Task 2); `stockOutConfirmationEmail` (Task 3); `postStaffAdmin` from `@/lib/firebase/staff` (already attaches the ID token).
- Produces: `POST /api/notifications/stock-out` with body `{ transactionId: string }`, response `{ sent: boolean, reason?: 'mail_disabled' | 'toggle_off' | 'no_email' | 'not_out' }`; 400 missing id, 401 from `requireSignedIn`, 404 unknown transaction, 502 unreachable (exact message), 500 config error.

- [ ] **Step 1: Implement the route.** Order: `requireSignedIn`; parse body; if `!isMailEnabled()` return `{ sent: false, reason: 'mail_disabled' }` before any database read; load `transactions/{id}` (404 if absent; `transaction_type !== 'OUT'` returns `not_out`); read `settings/notifications` and return `toggle_off` when `stock_out_confirmation === false`; load `staff/{String(txn.staff_id)}` and return `no_email` when `email` is empty after trimming; load `transaction_lines` where `transaction_id == id`; collapse to one `StockOutEmailLine` per `product_id` with summed `quantity` and `product_name` (reuse `collapseLinesByProduct` from `src/lib/transactionLines.ts` if it is importable server-side, otherwise a private equivalent in the route); send with `stockOutConfirmationEmail({ staffName: txn.staff_name, reference: txn.reference_no, lines, lendFrom: txn.lend_from, lendTo: txn.lend_to })`. Log each skip reason with `console.info`. Map mail errors as in Task 4. Never write to Firestore.
- [ ] **Step 2: Edit `handleConfirm`.** Add imports `toast` from `sonner` and `postStaffAdmin` from `@/lib/firebase/staff`. After the `if (activeRequest) { ... }` block and before `setReference(ref)`, add a non-awaited call: when `user` is set, `postStaffAdmin('/api/notifications/stock-out', user, { transactionId: txnRef.id }).catch(() => toast.error("Stock Out saved, but the confirmation email couldn't be sent."))`. `{ sent: false }` responses are silent. The surrounding try/catch, `setStep('done')` and everything else stay as they are.
- [ ] **Step 3: Type check and lint.** `npx tsc --noEmit` and `npm run lint`. Expected: no new errors.
- [ ] **Step 4: Review the diff**: the page change is the two imports plus one statement; the route never writes to Firestore.
- [ ] **Step 5: Commit** (`feat: email a Stock Out confirmation after each Stock Out`).

### Task 6: Handout and end-to-end verification

**Files:**
- Modify: `handout.md` (append a short "Mailpit (local email testing)" section: what it is, `npm run mailpit` / `npm run mailpit:stop`, inbox URL, the three env vars, the local-only guard, that only login and Stock Out confirmation are wired, and that the other 13 notifications are later steps)

- [ ] **Step 1: Append the handout section** and commit (`docs: document Mailpit local email testing`).
- [ ] **Step 2: User, on Windows:** `npm install`, Docker Desktop running, then `npm run mailpit` and `npm run dev:emulators`; clear and re-seed (`npm run seed:comprehensive`) if the emulator data is empty. Check the inbox is empty: `Invoke-RestMethod http://localhost:8025/api/v1/messages | Select-Object -ExpandProperty total` prints `0`.
- [ ] **Step 3: Login email.** In the app, Staff page, click Send Login Email on a portal staff member. Expected: success toast; http://localhost:8025 shows "SmartStock NWU" mail addressed to that staff gmail address with a working "Set your password" link.
- [ ] **Step 4: Stock Out.** Complete a Stock Out to a staff member with an email, including one product scanned under two barcodes (A4 Copy Paper). Expected: a confirmation arrives with that product on one line and the summed quantity, and the return date as `14 October 2026` style, or "No return date set" when left blank.
- [ ] **Step 5: Toggle off.** Settings, Notifications, switch Stock Out confirmation off; repeat Step 4. Expected: no new message; the dev server log shows `toggle_off`.
- [ ] **Step 6: Guard.** Stop the dev server, run it with `SMTP_HOST` set to a non-local host while the emulators are active (PowerShell: `$env:SMTP_HOST='smtp.example.com'; npm run dev:emulators`), click Send Login Email. Expected: error toast naming the refusal; nothing sent. Clear the variable afterwards (`Remove-Item Env:SMTP_HOST`).
- [ ] **Step 7: Mailpit down.** `npm run mailpit:stop`, click Send Login Email. Expected: toast `Mail server not reachable. Is Mailpit running? (npm run mailpit)` within about 5 seconds.
- [ ] **Step 8: Production path unchanged.** Run plain `npm run dev` (no mail env vars) with the real project config, or inspect: `MAIL_TRANSPORT` is not set, so `deliverLoginEmail` takes the `sendPasswordResetEmail` branch and the Stock Out route returns `{ sent: false, reason: 'mail_disabled' }`.
- [ ] **Step 9: Final lint:** `npm run lint` passes.

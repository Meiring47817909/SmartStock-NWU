# SmartStock-NWU: Handout
**Last updated:** October 19, 2026

> **What this is.** How SmartStock-NWU is set up, run and deployed: PostgreSQL (Cloud SQL in production) for all data, Firebase only for sign-in (Auth) and product photos (Storage). For how to use the app, see the User Manual; for how the code is put together, see the Developer Manual.

## Current setup

**What runs where**
- Data (products, staff, stock, loan requests, audit log, settings): PostgreSQL 17, reached only from server code through `DATABASE_URL`. The browser never opens a database connection; it calls the `/api/*` routes with its Firebase ID token.
- Sign-in, password reset and email change: Firebase Auth.
- Product photos: Firebase Storage. Only the server uploads and deletes them (`POST /api/products/images`, administrator only, through the Admin SDK); `storage.rules` lets anyone read a photo and refuses every write from a browser.

**Local setup, first time**
> **PowerShell:** the `npm` command in PowerShell drops a bare `--`, so `npm run seed:demo -- --reset` fails with "Unknown cli flag: --reset". Use `npm.cmd` for any command with `-- ...` in it, for example `npm.cmd run seed:demo -- --reset`.
>
> **Port 5432 already in use:** if `npm run db` says port 5432 is not available, another PostgreSQL is running on this machine (`Get-Service *postgres*`). Stop it while you work on SmartStock (`Stop-Service <name>` in an Administrator PowerShell; `Start-Service <name>` afterwards).

1. `npm install`.
2. Start PostgreSQL 17, either:
   - `npm run db` (Docker Desktop must be running). It creates or reuses the container `smartstock-postgres` (image `postgres:17`) on `127.0.0.1:5432`, user and password `postgres`, with two databases: `smartstock` (the app) and `smartstock_test` (the tests). Stop it with `npm run db:stop`; the data is kept in the `smartstock-pg` volume. Or
   - any local PostgreSQL 17 you already have: create the databases `smartstock` and `smartstock_test` yourself.
3. Set `DATABASE_URL` for the app, for example `postgres://postgres:postgres@127.0.0.1:5432/smartstock`, in `.env.local` (`npm run dev:emulators` already sets this value for itself). The Firebase public settings (`NEXT_PUBLIC_FIREBASE_*`) and, for the real project, `FIREBASE_ADMIN_PROJECT_ID`, `FIREBASE_ADMIN_CLIENT_EMAIL` and `FIREBASE_ADMIN_PRIVATE_KEY` also live in `.env.local`.
4. `npm run db:migrate` applies the schema (`drizzle/`). `npm run db:reset` drops and recreates the schema (the `public` and `drizzle` schemas) and then re-runs every migration, which removes all data in that database; use it only for the local database when you want a clean start. It refuses a host other than this machine and any database not named `smartstock` or `smartstock_test` unless you add `-- --force`.
   - These scripts (`db:migrate`, `db:reset` and the seeds) read `DATABASE_URL` from the shell environment, not from `.env.local`. Only Next.js (`npm run dev`, `npm run build`) reads `.env.local`. Without `DATABASE_URL` in the shell they use the local `smartstock` database.
5. Seed data (the seeds need the Firebase Auth and Storage emulators running first: `npm run emulators` in its own terminal, see step 6; the seeds find them on 127.0.0.1:9099 and 9199 by themselves):
   - `npm run seed:comprehensive` fills every status, badge and label the app can show: 31 scenario staff, 25 products, both logins.
   - `npm run seed:demo` is the smaller client demo: the 20 NWU staff, the administrator and Meiring as a portal borrower.
   - Both refuse to run on a database that already has data. Run `npm run db:reset` first, or add `--reset`: `npm run seed:comprehensive -- --reset`, `npm run seed:demo -- --reset`. Like `db:reset`, `--reset` refuses a database not named `smartstock` or `smartstock_test` unless `--force` is added too.
   - Both refuse a database that is not on this machine and emulators that are not local. `-- --dry-auth` seeds only the database (no logins, no photos) and needs no emulators.
6. Run the app against the emulators: `npm run emulators` in one terminal (Auth on 9099, Storage on 9199, Emulator UI on http://127.0.0.1:4000), then `npm run dev:emulators` in another. `dev:emulators` sets `NEXT_PUBLIC_USE_FIREBASE_EMULATORS`, `FIREBASE_AUTH_EMULATOR_HOST`, the Mailpit SMTP settings and `DATABASE_URL` for the local `smartstock` database. Sign in at `/login` as:
   - after `seed:comprehensive`: `jonathan.pritchard@nwu.ac.za` / `password123` (administrator) or `jessica.moore@gmail.com` / `password123` (portal borrower);
   - after `seed:demo`: `selouna.visser@nwu.ac.za` / `password123` (administrator) or `47817909@mynwu.ac.za` / `password123` (Meiring, portal borrower).
7. Email goes to Mailpit: `npm run mailpit` (Docker), inbox at http://localhost:8025. See "Email locally (Mailpit)" and "Email notifications" below.

**Other commands**
- `npm test` runs the automated tests (Vitest) against `smartstock_test`; start PostgreSQL first. They need no Firebase emulators.
- `npx tsc --noEmit` and `npx eslint <files>`.
- `npm run build` needs the Firebase public settings and `DATABASE_URL` in the environment. A build on a machine with no real credentials can use placeholder values for the build only (for the Admin SDK, setting `FIREBASE_AUTH_EMULATOR_HOST` is enough; do not commit placeholders).
- `npm run db:check` is a read-only check of the database the shell's `DATABASE_URL` points at (the local `smartstock` without it): which server and database, how many app tables, and which migrations have been applied.

## Pointing the app at Cloud SQL

In Vercel (Project Settings, Environment Variables) set, for **Production only** (keep Preview deployments off the production database; see "Deployment notes" below):
- `DATABASE_URL`: `postgres://<user>:<password>@<address>:5432/smartstock`, where `<address>` is how your setup reaches the instance (for example its public IP with Vercel's outgoing addresses in the instance's authorised networks; see the pool note below). Do **not** add `sslmode=require`: with the `pg` version in this repo it means full certificate and host-name verification, which fails against Cloud SQL's instance certificate on an IP address. Leave `sslmode` out of the URL altogether when `DATABASE_SSL_CA` is set (the app ignores it then anyway).
- `DATABASE_SSL_CA`: the instance's server CA certificate, as PEM text. Download `server-ca.pem` from the Cloud SQL instance (check the console: Connections, Security, or the instance's SSL/TLS certificates page) and paste the whole file, `-----BEGIN CERTIFICATE-----` to `-----END CERTIFICATE-----`. A single line with `\n` in place of the line breaks also works. With it set, the app connects with TLS and checks the server certificate against this CA (but not the host name, like libpq's `verify-ca`). Check that the instance's SSL setting allows connections without client certificates (encrypted-only), because the app does not send one.
- `DATABASE_POOL_MAX` (optional, default 5): connections per running server instance (see the pool note below).

Then redeploy; these values are read when the server starts, so a redeploy is needed for a changed value to take effect. After the redeploy, sign in and open the Dashboard and Products pages as a smoke test.

## Running commands against Cloud SQL

Command-line work on the production database (`db:migrate`, `db:check`, `psql`, loading the demo data) goes through the Cloud SQL Auth Proxy. Install `cloud-sql-proxy` and sign in with an account that may connect to the instance (check the proxy's documentation for the role it needs, for example Cloud SQL Client). Start it in its own terminal and leave it running while you work (port 5433, so it cannot be confused with a local PostgreSQL on 5432):
```bash
cloud-sql-proxy <PROJECT>:<REGION>:<INSTANCE> --port 5433
```
(Check the flags with `cloud-sql-proxy --help` for your version.) Then, in a second terminal, `DATABASE_URL` is `postgres://<user>:<password>@127.0.0.1:5433/smartstock`, with no `sslmode`: the proxy encrypts the connection to Cloud SQL itself, and the local hop to it is plain.

Before you change anything, confirm which database you are connected to: check that the proxy's startup output names the intended instance, and run `psql "postgres://<user>:<password>@127.0.0.1:5433/smartstock" -c "select current_database(), inet_server_addr()"`.

```powershell
$env:DATABASE_URL = 'postgres://<user>:<password>@127.0.0.1:5433/smartstock'
npm run db:migrate
# always, when done
Remove-Item Env:DATABASE_URL
```
> **Warning.** While `DATABASE_URL` points at Cloud SQL in your shell, or while the Auth Proxy is running, do not run `npm run db:reset` or the seeds against it. Through the proxy the target looks like `127.0.0.1`, so their "local database only" host guards do not stop them. `db:reset` and the seeds' `--reset` also refuse any database not named `smartstock` or `smartstock_test` (without `--force`), but a Cloud SQL database named `smartstock` passes that check, so it is not a protection here. Unset the variable (or close that terminal) and stop the proxy as soon as you are done.

Tip: naming the production database something other than `smartstock` (for example `smartstock_prod`) makes `db:reset` and the seeds' `--reset` refuse it outright. If you do, use that name in every `DATABASE_URL` above.

## Loading the demo data onto the live site

`seed:demo` can fill Cloud SQL instead of the local database, replacing everything in it (products, staff, requests, audit log) with the demo data: the 20 NWU staff, Selouna Visser as administrator, Meiring as portal borrower, the scenario products and Bostik Glu Dots.

- Logins: it only looks up the existing live Firebase accounts by email (Selouna's and Meiring's) and links them. It never creates an account and never changes a password; if either account is missing it stops before writing anything (create it in the Firebase console under Authentication, Add user, then run again).
- Photos: the product photos are uploaded to the live Storage bucket (`NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` in `.env.local`) as new files.
- It refuses to run if any emulator variable is set, and `--reset=` must name the target database exactly.

First make an on-demand backup in the Cloud SQL console (Backups, Create backup). Then, with the Auth Proxy running on port 5433:
```powershell
$env:DATABASE_URL = 'postgres://smartstock_app:<password>@127.0.0.1:5433/smartstock'
npm.cmd run seed:demo -- --target live --reset=smartstock
npm run db:check
Remove-Item Env:DATABASE_URL
```
Sign in on the live site with each account's own password (not `password123`).

## PostgreSQL pool on Vercel

`src/server/db/client.ts` creates one `pg` pool per server process with `DATABASE_POOL_MAX` connections (default 5) and a 10-second idle timeout, so idle connections are closed when an instance goes quiet. On Vercel every running function instance is its own process with its own pool, so the number of database connections is roughly (instances running at the same time) x (up to `DATABASE_POOL_MAX`). A burst of traffic that starts many instances can therefore open many connections at once, and Cloud SQL accepts only as many as its `max_connections` allows. Things to check, none of which are verified here:
- Look up the `max_connections` of the Cloud SQL instance (it depends on the instance tier and can be changed with a database flag) and compare it with your expected peak concurrency x `DATABASE_POOL_MAX` (5 by default), leaving room for migrations, the Auth Proxy session you use for admin work and Cloud SQL's own reserved connections.
- If that margin is thin, lower `DATABASE_POOL_MAX` in Vercel's environment variables (for example to 2 or 3; a redeploy applies it) or put a connection pooler in front of Cloud SQL (for example PgBouncer, or Cloud SQL's managed connection pooling if your edition offers it). Test the app against a pooler in transaction mode before relying on it, because every data change runs inside a database transaction.
- Check Vercel's current documentation on running a `pg` pool in functions (how long idle connections are kept and how the platform reuses instances). The pool's idle timeout is 10 seconds (`idleTimeoutMillis` in `client.ts`).
- Check how Vercel connects to Cloud SQL. The Cloud SQL Auth Proxy is a process you run next to the app, which a Vercel function cannot do. Options to compare in the Cloud SQL and Vercel documentation: a public IP with TLS (`DATABASE_SSL_CA`, see "Pointing the app at Cloud SQL") and an authorised-networks list (Vercel's outgoing addresses may not be fixed on every plan, so check whether you need a static-IP option), or the Cloud SQL Node.js connector library (a code change in `client.ts`). Whichever you pick, keep the database user's password in Vercel's encrypted environment variables only.
- Put Cloud SQL in the region closest to the Vercel region in `vercel.json` (`cpt1`, Cape Town) that Cloud SQL offers; each page action makes several short queries, so latency adds up.
- Use `DATABASE_SSL_CA` for TLS rather than `sslmode` in the connection string, and keep automated backups on and point-in-time recovery enabled on the instance (check the option names in the console).

## Deployment notes

- **Migrations go first.** Before deploying code that adds a migration (a new file in `drizzle/`), run `npm run db:migrate` against Cloud SQL through the Auth Proxy (see "Running commands against Cloud SQL"), then deploy. The app does not migrate on start, and new code against an old schema fails.
- **Keep Vercel Preview deployments off the production `DATABASE_URL`.** Set `DATABASE_URL` (and `DATABASE_SSL_CA`) for the Production environment only. A Preview build runs unreviewed branch code, and it would write to live data. Give Preview its own throwaway database, or leave it unset so preview deployments cannot reach the database.
- **Pool settings:** `DATABASE_POOL_MAX` (default 5) per running instance; see "PostgreSQL pool on Vercel" above. `DATABASE_SSL_CA` is the Cloud SQL server CA (see "Pointing the app at Cloud SQL").

## Manual check list

The automated checks (`npm test`, `npx tsc --noEmit`, eslint, `npm run build`) cover the server rules. The walkthrough below needs Docker, the Firebase emulators and a browser; run it after larger changes and note anything unexpected next to the step.

Setup
- [ ] `npm run db`, then `npm run db:reset && npm run seed:demo` (start `npm run emulators` first; the seed needs Auth and Storage). It should print the demo summary.
- [ ] `npm run mailpit` (inbox at http://localhost:8025), then `npm run dev:emulators`.

Mailpit check list
- [ ] Run steps 1 to 15 of the "Try it" list in "Email notifications" below (it was written for `seed:comprehensive`, which also saves the Admin notification address and System email; after `seed:demo`, check Settings, Notifications first and set the Admin notification address if it is empty). Tick each step here as you go: 1 [ ] 2 [ ] 3 [ ] 4 [ ] 5 [ ] 6 [ ] 7 [ ] 8 [ ] 9 [ ] 10 [ ] 11 [ ] 12 [ ] 13 [ ] 14 [ ] 15 [ ].

Demo walkthrough (as `selouna.visser@nwu.ac.za`, then the portal as `47817909@mynwu.ac.za`)
- [ ] Dashboard: Outstanding Returns, Incoming Pickups, Low Stock tabs and their count badges load; a "Not picked up" badge appears after the first load once a pickup's day has passed.
- [ ] Products: list, search, add a product, edit it, upload a photo (Storage emulator), add a barcode that another product already uses (expect the friendly "already used by ..." message, not an error page).
- [ ] Delete a product that has stock history: it is refused with a message and you can mark it unavailable instead. Delete a brand-new product with no history: it works.
- [ ] Stock In (existing and new product), Stock Out to a staff member (with and without lend dates), Returns (scan the barcode, partial return, resolve an item).
- [ ] Loan Requests: submit one in the portal, approve, counter, decline and withdraw it; cancel an approved pickup on the Dashboard.
- [ ] Staff: add, edit, deactivate and activate; Send Login Email; the Status, Card UID and Portal Access badges.
- [ ] Audit Log: every action above appears once, with operator names; sort, page and export CSV.
- [ ] Reports: tables, CSV and PDF export.
- [ ] Settings, Notifications: toggles and the two address cards save, and the audit log records the change.
- [ ] Profile (administrator and portal): change name, change password, change email (confirmation email in Mailpit).
- [ ] Sign out and reload `/lend` while signed out: Browse and Cart work as a guest.
- [ ] `npm run db:reset` then `npm run seed:comprehensive` works as well (Grace Thornton and Samuel Prescott show 7-day loan windows).

## Email locally (Mailpit)

Emails sent while developing against the emulators land in a local inbox. Nothing can reach a real address.

**Run it**
1. Start Docker Desktop, then `npm run mailpit` (stop it with `npm run mailpit:stop`). Inbox: http://localhost:8025. SMTP: `127.0.0.1:1025`.
2. `npm run dev:emulators` as usual (with PostgreSQL running and seeded, see "Current setup").

**How it works**
- `src/lib/server/mailer.ts` — one `sendMail()` on `nodemailer`. It only sends when `MAIL_TRANSPORT=smtp`; with it unset it does nothing, so production is unchanged. Other vars: `SMTP_HOST` (default `127.0.0.1`), `SMTP_PORT` (default `1025`), `MAIL_FROM` (default `SmartStock NWU <no-reply@smartstock.local>`). `dev:emulators` sets the first three; plain `npm run dev` sets none.
- **Local-only guard:** while the Firebase Auth emulator variable (`FIREBASE_AUTH_EMULATOR_HOST`) is set, the mailer refuses any `SMTP_HOST` other than `127.0.0.1`, `localhost` or `::1`, so the seeded gmail addresses can never get real mail.
- `src/lib/server/emailTemplates.ts` — shared SmartStock NWU layout (HTML + plain text, everything escaped) plus the two emails below.
- **Login email:** `send-reset-email` calls `deliverLoginEmail()`. With the mailer on it generates the reset link (`adminAuth.generatePasswordResetLink`) and sends our own email; otherwise it calls Firebase's `sendPasswordResetEmail`. If Mailpit is down the toast says "Mail server not reachable. Is Mailpit running? (npm run mailpit)".
- **Stock Out confirmation:** after a Stock Out saves, the page calls `POST /api/notifications/stock-out` in the background. It honours the Settings → Notifications "Stock Out confirmation" toggle, skips staff with no email, and never blocks the Stock Out (failure shows a toast). It does not modify the transaction.

**Other emails:** the loan-request, pickup and low-stock emails are covered in "Email notifications" below. Only the three timer-based ones (expired, overdue, insufficient pickup stock) are not built.

Design and plan: `docs/superpowers/specs/2026-10-02-mailpit-foundation-design.md`, `docs/superpowers/plans/2026-10-02-mailpit-foundation.md`.

## Email notifications

Ten more emails go through the same mailer (see "Email locally (Mailpit)" for how to run it locally: Docker Desktop, `npm run mailpit`, `npm run dev:emulators`). Spec: `docs/superpowers/specs/2026-10-02-email-notifications-design.md`; plan: `docs/superpowers/plans/2026-10-02-email-notifications.md`.

**What sends, and when** (each is gated by its toggle on Settings → Notifications; only an explicit "off" stops it)
- Staff member: loan request approved, countered, declined; approved pickup cancelled (admin cancels on the Dashboard); counter offer accepted, counter offer declined, request withdrawn (staff, in the portal).
- Admin inbox (the "Admin notification email" on the same Settings page; skipped if blank): new loan request (staff submits), incoming pickup confirmed (request becomes accepted, either approved as-is or after the staff member accepts a counter), low stock (a Stock Out takes a product to or below its reorder threshold or to zero, one email listing all of them; or an edit on the Products page does the same, via `POST /api/notifications/product-stock`, one product per email). Both send only when the product was above its threshold before, so a product that is already low is not emailed again.
- **Not built, always off:** loan request expired, overdue return alert, incoming pickup insufficient stock (they need a timer). The Settings page shows "Not implemented yet" with a line saying what each still needs (a separate scheduled service, a cron job, because nothing in the app runs when nobody is signed in), and refuses to switch them on. To build them: one protected daily sweep route, started by Vercel cron (Hobby plan: once a day only, within the hour) or a Firebase scheduled function (Blaze plan), plus a manual "run now" for the demo.

**How it works**
- Loan-request changes are saved through the `/api/loan-requests` routes. After one succeeds, the page calls `notifyLoanRequestEvent()` (`src/lib/firebase/notifyEvent.ts`) in the background; it posts `{ event, requestId, reason? }` to `POST /api/notifications/loan-request`, which re-reads the request, checks who is calling and that the request is in the right state, then sends. A failure shows "Saved, but the email couldn't be sent." and never undoes the action. Low stock is handled by the existing Stock Out route.
- Duplicates are prevented by marker rows in the `sent_notifications` table (written by the server only; the browser has no access to the database). To make the app resend one email while testing, delete its row from that table (for example `psql postgres://postgres:postgres@127.0.0.1:5432/smartstock -c "delete from sent_notifications where key = '<key>'"`; `select * from sent_notifications` lists the keys).
- Settings → Notifications has two address cards. "Admin notification address" is where the administrator emails are delivered. "System emails" holds the system sending address: the From header of every email (notifications, Stock Out confirmation, staff login reset), shown as "SmartStock NWU". Until one is saved the field shows the default sender (`no-reply@smartstock.local`, shared by the mailer and the page via `DEFAULT_SYSTEM_EMAIL`); if the stored value is blank or not a plain address, `MAIL_FROM` is used. Stored as `system_from_email`; the administrator address is `admin_notification_email`. A real mail server may reject or spam-filter a From address it is not set up to send for.
- The contact email shown on the login error messages and in the lending portal (home, policy, profile, deactivated-account screen) is the Admin notification address, read through the public `GET /api/contact` (settings are admin-only, so signed-out visitors and borrowers cannot read them directly). Only the address is shown, never a name. It is read on every page load, so a change in Settings shows on the next load; if none is saved it falls back to `jonathan.pritchard@nwu.ac.za` (`src/lib/contactEmail.ts`). "The IT Store" in sentences such as "the IT Store will review it" is fixed text in the pages and does not follow the setting.
- Account emails go through the same mailer, from the System emails address: "Forgot password?" (login page and portal profile) via `POST /api/auth/forgot-password`, and the administrator's change-email confirmation via `POST /api/auth/change-email`. They are sign-in security emails, so they have no toggle in Settings. When `MAIL_TRANSPORT` is not `smtp` the pages fall back to Firebase's own emails. Forgot password always answers "sent" (it never says whether an address has an account) and sends at most one email per address per minute. Change email needs the current password re-entered (a sign-in within the last 5 minutes) and sends the confirmation link to the NEW address; the login email only changes once the link is clicked, and the administrator's `staff` record email follows when "Check again" is pressed on My Profile. Every portal user sees the normal Change password card. Send Login Email on the Staff page goes through the same mailer. The buttons in all of these emails (Reset password, Set your password, Confirm new email) open the app's own page `/auth/action` on `APP_BASE_URL` instead of Firebase's handler page (which in the emulator is only plain text); Firebase still checks and applies the one-time code there. On the live project, also set Firebase Console → Authentication → Templates → "Customize action URL" to `<APP_BASE_URL>/auth/action`, so Firebase's own fallback emails (mail off) open the same page.
- Email buttons link to `APP_BASE_URL` (optional; default `http://localhost:3000`).
- Hosted demo (Vercel + Mailtrap Email Sandbox): in Vercel's environment variables set `MAIL_TRANSPORT=smtp`, `SMTP_HOST=sandbox.smtp.mailtrap.io`, `SMTP_PORT=587`, `MAIL_USERNAME` and `MAIL_PASSWORD` (from the sandbox's Integration tab) and `APP_BASE_URL=https://smart-stock-nwu.vercel.app`, then redeploy. Every email lands in the sandbox inbox whatever the recipient, so nothing reaches real people. Any non-local SMTP server must support STARTTLS (or TLS on port 465): the mailer refuses to log in or send unencrypted except to a local Mailpit. The same variables work for the client's own server later.
- The cancel reason typed on the Dashboard is not stored on the request, so it travels with the notify call.

**Try it** (Docker Desktop running, `npm install` done, `npm run db`, `npm run db:migrate`, a seed (`npm run seed:demo` or `npm run seed:comprehensive`, with `npm run emulators` running), `npm run mailpit`, then `npm run dev:emulators`; `npm run seed:comprehensive` already sets the Admin notification address (the admin login's email, `jonathan.pritchard@nwu.ac.za`) and the System email (`noreply@smartstock-nwu.com`), and gives the administrator their own staff record (so My Profile shows name, surname and department); without that seed, set the Admin notification address under Settings → Notifications first; read the mail at http://localhost:8025)
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
12. Products, edit a product that is above its reorder threshold and set Qty On Hand to its threshold (or lower), Save: the admin inbox gets "Low stock". Edit it again while it is still low: no second email.
13. Change the Admin notification address under Settings, then reload the portal's Policy page (Enquiries) and try a deactivated login: they show the new address, with no person's name.
14. Login page: type an existing staff email and click "Reset it". Mailpit shows "Reset your SmartStock NWU password" from the System email address, and its button opens SmartStock's "Choose a new password" page; save a new password there and sign in with it. Opening the same link again says it has already been used. Try an address with no account: the page still says it was sent and Mailpit shows nothing. Click "Reset it" again within a minute for the same address: still one email.
15. My Profile (administrator), Change email: enter a new address and the current password. Mailpit shows "Confirm your new SmartStock NWU email" sent to the NEW address. Its button opens SmartStock's "Confirm your new email" page; press "Confirm new email", then go back to My Profile and press "Check again": the login email updates. The portal profile's "Forgot password?" sends the same reset email as step 14.

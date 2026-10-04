# SmartStock-NWU: move from Firestore to PostgreSQL (Cloud SQL)

Date: 2026-10-04 · Branch: `postgres` (from `seed-demo` at 2f021e2) · Status: design, awaiting review

## 1. Why and what

The client requires a relational Cloud SQL database. SmartStock-NWU currently stores
everything in Firestore and reads/writes it directly from the browser (27 files, about
110 client calls, 16 pages/components), protected by `firestore.rules`.

This change moves all application data to **PostgreSQL**, accessed only on the server
through **Drizzle**. It is built and tested **locally first** (PostgreSQL in Docker), as a
**full switch on the `postgres` branch**. The current Firestore app on `email-notifications`
/ `seed-demo` stays untouched and demo-able until cut-over.

Decisions (agreed 2026-10-04):

| Topic | Decision |
|---|---|
| Engine | PostgreSQL (major version 17 unless changed before set-up) |
| Data access | Drizzle ORM + `pg` driver, Drizzle migrations (plain SQL files) |
| Approach | Full switch on a branch, not area-by-area dual running |
| Seeds | `seed:comprehensive` and `seed:demo` rewritten for PostgreSQL; other seeds retired unless asked for |
| Live data | One-off importer copies live Firestore into PostgreSQL at cut-over, keeping IDs |
| Stays on Firebase | Firebase Auth (logins, reset, email change) and Firebase Storage (product photos) |

Out of scope: Cloud SQL instance sizing, Vercel-to-Cloud SQL connection pooling and region
(decided at cut-over); the three unbuilt timer emails; any UI redesign.

## 2. Architecture

- **Local:** `npm run db` starts PostgreSQL in Docker (same pattern as `npm run mailpit`),
  port 5432, named volume. `DATABASE_URL` is the only connection setting; `dev:emulators`
  sets it for local work. Firebase Auth and Storage keep running in the emulators.
- **Server-only database access.** New `src/server/db/` holds the Drizzle schema, the
  connection pool (one pool per server instance, small max size for serverless) and
  migrations. New `src/server/data/<area>.ts` modules hold every query and save, one per
  area: products & categories, staff, stock movements (in/out/returns/waivers), loan
  requests, audit log, dashboard & reports, settings & notifications, profiles.
- **Pages call the server, never the database.** Each area gets route handlers under
  `src/app/api/...` and a small typed client helper (same pattern as `postStaffAdmin`:
  `Authorization: Bearer <Firebase ID token>`). Pages swap their Firestore calls for these
  helpers and keep their existing data shapes (the `src/types/database.ts` interfaces), so
  UI changes stay small.
- **Identity:** every route verifies the Firebase ID token with the Admin SDK
  (`requireSignedIn` / `requireAdmin`, extended), then reads the caller's role from
  `profiles` and, for portal users, their linked `staff` row.
- **Firestore removed** from the app at the end: `firebase/firestore` imports,
  `firestore.rules`, `firestore.indexes.json`, Firestore emulator config.

## 3. Data model

All keys are `text` (existing Firestore IDs are kept on import; new rows get 20-character
random IDs in the same style). Timestamps are `timestamptz`; day-only values are `date`.
The data layer converts to and from the same ISO / `YYYY-MM-DD` strings the app uses today.
Fixed value lists are enforced with `CHECK` constraints.

| Table | Columns (key points) |
|---|---|
| `profiles` | `uid` PK (Firebase Auth uid), `full_name`, `role` ∈ {admin, staff}, `created_at` |
| `categories` | `id` PK, `name` UNIQUE, `description`, `created_at` |
| `products` | `id` PK, `category_id` FK → categories (null), `category_name` (kept for compatibility), `name`, `description`, `quantity_on_hand` int CHECK ≥ 0, `reorder_threshold` int, `available` bool, `location`, `lend_from` date, `lend_to` date, `lending_interval` (null or one of week_1/week_2/week_3/month_1/indefinite), `images` text[], `created_at`, `updated_at` |
| `product_barcodes` | `barcode` PK, `product_id` FK → products ON DELETE CASCADE, `position` int (keeps order). A barcode can belong to one product only. |
| `staff` | `id` PK, `name`, `surname`, `full_name`, `email` (UNIQUE on lower(email), null allowed), `department`, `card_uid` UNIQUE null, `is_active`, `uid` UNIQUE null, `is_admin_account` bool, `created_at`, `updated_at` |
| `transactions` | `id` PK, `transaction_type` ∈ {IN, OUT, RETURN, ADJUST}, `reference_no` UNIQUE, `staff_id` FK → staff null, `staff_name` (frozen), `user_id`, `operator_name` (frozen), `notes`, `return_date` date, `linked_txn_id` FK → transactions null, `manual_override` bool null, `lend_from` date, `lend_to` date, `linked_request_id` FK → loan_requests null, `linked_request_ref`, `created_at` |
| `transaction_lines` | `id` PK, `transaction_id` FK, `product_id` FK, `product_name` (frozen), `barcode`, `issued_barcode`, `quantity` int > 0, `unit_cost` numeric, `created_at` |
| `return_waivers` | `id` PK, `transaction_id` FK, `product_id` FK, `product_name`, `staff_id` FK null, `staff_name`, `quantity` int > 0, `reason`, `created_at`, `resolved_by_uid`, `resolved_by_name` |
| `loan_requests` | `id` PK, `reference_no` UNIQUE, `staff_id` FK, `staff_name` (frozen), `status` ∈ {pending, countered, accepted, declined, expired, withdrawn, fulfilled, no_show}, `message`, `admin_message`, `from_date` date, `to_date` date null, `original_from_date`, `original_to_date`, `fulfilled_txn_id` FK → transactions null, `created_at`, `updated_at` |
| `loan_request_lines` | `id` PK, `request_id` FK, `product_id` FK, `product_name`, `requested_quantity`, `offered_quantity`, `created_at` |
| `audit_log` | `id` PK, `user_id`, `user_name`, `action` ∈ AuditAction, `entity_type` ∈ AuditEntityType, `entity_id`, `before` jsonb, `after` jsonb, `created_at`; indexes on (`created_at` desc) and (`entity_type`, `entity_id`) |
| `settings` | `key` PK (e.g. `notifications`), `value` jsonb, `updated_at` |
| `sent_notifications` | `key` PK (dedupe key), `toggle`, `entity_id`, `created_at`. Insert with `ON CONFLICT DO NOTHING` replaces Firestore `create()`. |

Frozen names (`staff_name`, `product_name`, `operator_name`) stay as historical snapshots by
design. Indexes are added for the app's actual filters (staff by uid/email/card,
transactions by staff/date/type, requests by staff/status, lines by parent).

## 4. Permissions (replacing `firestore.rules`)

| Data | Read | Write |
|---|---|---|
| profiles | own row | server only (seed / Admin) |
| products, barcodes | anyone, as today (portal Browse included) | admin |
| categories, staff, transactions, lines, waivers, audit log, settings | admin (staff: own `staff` row only) | admin; transactions, lines, waivers and audit entries are append-only (no update or delete route exists) |
| loan requests + lines | admin all; staff own only | staff: create own; staff transitions only: countered→accepted/declined, pending/countered/accepted→withdrawn; expiry/no-show are system transitions; everything else admin |

`products` is readable without signing in today (`allow read: if true`) and stays that way,
so behaviour doesn't change; requiring a sign-in is listed as an open point.

## 5. Saves that must be all-or-nothing

Each runs in one database transaction, locking the product rows it changes
(`SELECT … FOR UPDATE`) and failing if any stock would drop below zero:

- Stock In, Stock Out (incl. fulfilling a loan request), Return, Adjust: transaction + lines
  + `quantity_on_hand` changes + audit entry (+ request status for a fulfilled pickup).
- Return write-off (waiver) + audit entry.
- Product create/edit (+ barcodes), category, staff create/edit/activate/deactivate/access:
  row(s) + audit entry.
- Every loan request transition (+ line edits for a counter) + audit entry, including the
  lazy expiry / no-show transitions (`expireIfNeeded`), which become idempotent server-side
  updates guarded by the current status.

Emails are sent **after** the database commit, as today (fire-and-forget routes), so a mail
failure never rolls back a save.

## 6. Reports and Dashboard

Dashboard counts, outstanding returns, incoming pickups, low-stock alerts and the Reports
pages are computed with SQL on the server (joins and sums) and returned ready to display,
replacing whole-collection downloads in the browser. Outputs must match today's numbers on
the seeded data (checked in tests).

## 7. Seeds, importer, tooling

- `npm run db` / `db:stop` (Docker), `db:migrate` (apply migrations), `db:reset` (drop,
  re-create, migrate).
- `seed:comprehensive` and `seed:demo` rewritten to write through the server data layer into
  PostgreSQL (logins → Auth emulator, photos → Storage emulator). Same scenarios, staff,
  products, Bostik Glu Dots and audit history as today. Other seed scripts are retired.
- `db:import-firestore` copies every Firestore collection into PostgreSQL:
  `--source emulator|live`, `--dry-run` (default) prints counts per collection and every
  record that doesn't fit (missing product, unknown status, duplicate barcode …);
  `--write` imports in one transaction. IDs preserved; Firestore `barcodes` arrays become
  `product_barcodes` rows; `settings/notifications` becomes `settings.notifications`;
  `sent_notifications` copied as-is.

## 8. Testing

- Data-layer and route tests run against a real PostgreSQL in Docker (a separate test
  database reset per run), so locking, constraints and transactions are exercised for real.
- Permission tests per area (staff can't read others' requests, can't make admin
  transitions, can't touch stock; append-only tables reject edits).
- Concurrency test: two simultaneous Stock Outs of the last unit, exactly one succeeds.
- Existing email/route suites moved onto the new data layer.
- Seed tests: after `db:reset` + `seed:demo`, the same assertions as today's seed:demo
  check (NWU staff only, Selouna admin, Meiring's history, Bostik + audit entry).
- Importer test: seed the Firestore emulator with `seed:comprehensive` (Firestore version),
  import, compare row counts and spot-check records.
- Final manual pass: Mailpit checklist (handout steps 1–15) and the demo walkthrough on the
  local PostgreSQL version.

## 9. Order of work (each step committed and testable)

1. Foundation: Docker DB, Drizzle schema + first migration, pool, `db:*` scripts, auth
   helpers, test harness against PostgreSQL.
2. Reading: products & categories, staff, Dashboard, Reports, Audit Log, portal Browse /
   My Requests, profiles/contexts.
3. Saving, area by area: products & categories → staff (incl. login routes) → stock
   movements & waivers → loan requests (admin + portal, expiry/no-show) → settings &
   notification routes (`sent_notifications`).
4. Seeds: `seed:comprehensive` and `seed:demo` on PostgreSQL.
5. Importer: emulator test, then a dry run against live (read-only).
6. Remove Firestore from the app; update handout and README.

## 10. Cut-over checklist (later, separate)

Create the Cloud SQL instance (Google's South African region) → run migrations → import
live Firestore (`--source live --write`) → choose and set up the Vercel connection
(pooler/connector) and `DATABASE_URL` → deploy → smoke test → keep Firestore untouched,
read-only in practice, as a fallback for a period.

## 11. Risks and open points

- **Size of the page rewrite** (16 pages): mitigated by keeping the existing data shapes
  and moving one area at a time with tests.
- **Signed-out product reads:** the catalogue stays public as today; decide whether to
  require a sign-in once it's confirmed no signed-out page needs it.
- **Serverless connections:** the local pool is small; the production pooler is chosen at
  cut-over.
- **Merging later work:** changes made on `email-notifications` / `seed-demo` after the
  branch point must be merged into `postgres` and ported.

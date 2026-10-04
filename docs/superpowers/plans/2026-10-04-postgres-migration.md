# Firestore → PostgreSQL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every Firestore read and write in SmartStock-NWU with server-side PostgreSQL access through Drizzle, keeping Firebase Auth and Storage, and ship seeds and a Firestore importer for it.

**Architecture:** A server data layer (`src/server/data/<area>.ts`) owns every query and save and runs multi-row saves in one database transaction. Thin route handlers (`src/app/api/...`) verify the Firebase ID token and call it. Pages call small typed client modules (`src/lib/api/<area>.ts`) that keep the names and return shapes of today's `src/lib/firebase/*.ts` functions, so page changes stay small.

**Tech Stack:** Next.js 16.3 (TypeScript), PostgreSQL 17 (Docker locally), Drizzle ORM + `pg`, drizzle-kit migrations, Vitest, tsx (seeds/importer), Firebase Admin (Auth + Storage only).

**Spec:** `docs/superpowers/specs/2026-10-04-postgres-migration-design.md`

## Global Constraints

- Branch: all work on `postgres` (created from `seed-demo` at 2f021e2).
- PostgreSQL major version 17; local container `smartstock-postgres`, image `postgres:17`, port 5432, user/password `postgres`/`postgres`, databases `smartstock` (dev) and `smartstock_test` (tests).
- Connection only through `DATABASE_URL` (tests: `TEST_DATABASE_URL`, default `postgres://postgres:postgres@127.0.0.1:5432/smartstock_test`).
- The browser never opens a database connection; no `pg`/Drizzle import may reach a client component (`import 'server-only'` in every `src/server/**` file).
- Primary keys are `text`; new IDs are 20-character `[A-Za-z0-9]` strings from `newId()`; imported Firestore IDs are kept verbatim.
- Timestamps `timestamptz`, day-only fields `date`; the data layer returns ISO strings (`toISOString()`) and `YYYY-MM-DD` strings exactly as the app's `src/types/database.ts` types expect today.
- Firebase Auth (logins, reset, email change) and Firebase Storage (product photos) are unchanged.
- Transactions, transaction lines, return waivers and audit entries are append-only: no update/delete function or route exists for them.
- Emails are sent after the database commit, never inside it; a mail failure never rolls back a save.
- Products stay readable without signing in (as `allow read: if true` today).
- All on-screen text, toasts and error messages stay as they are unless a task names a change.
- Preserve each file's existing line endings when editing (`send-reset-email/route.ts` is CRLF).
- Commits end with the session's `Co-Authored-By` / `Claude-Session` lines.

## Review Focus

- **Dates shifting a day:** `pg` turns `date` columns into JS Dates at local midnight, so `2026-10-01` can come back as `2026-09-30` in UTC. Expected: every `date` round-trips unchanged → test in Task 2.
- **A barcode already used by another product** on product create/edit or Stock In of a new product. Expected: the existing friendly "already used by …" message, not a 500 from the unique constraint → test in Task 5.
- **Two people opening an expired request at the same moment** (lazy expiry / no-show). Expected: one status change and one audit entry, not two → test in Task 10.
- **An expired or missing sign-in** calling any non-public route. Expected: 401 with "Invalid or expired session — please sign in again.", and pages show their normal signed-out behaviour → test in Task 3.
- **Running the importer twice, or into a database that already has data.** Expected: it refuses unless `--replace` is given; a failed write leaves the database unchanged → test in Task 17.

---

## File Structure

| Path | Responsibility |
|---|---|
| `scripts/db.mjs` | Start/stop the Docker PostgreSQL (`npm run db`, `db:stop`), same style as `scripts/mailpit.mjs` |
| `drizzle.config.ts`, `drizzle/` | drizzle-kit config and generated SQL migrations |
| `vitest.config.ts`, `tests/` | Test runner config; `tests/helpers/` (test DB, fixtures, fake token verifier), `tests/server/*.test.ts`, `tests/api/*.test.ts` |
| `src/server/db/schema.ts` | Drizzle table definitions (spec §3) |
| `src/server/db/client.ts` | Pool + `getDb()`, type parsers, `Db` / `Tx` types |
| `src/server/db/ids.ts` | `newId()` |
| `src/server/context.ts` | `Caller`, `Ctx`, `DataError`, `assertAdmin`, `assertStaffSelf` |
| `src/server/http.ts` | `route()` wrapper: token → `Caller`, JSON errors |
| `src/server/data/*.ts` | One module per area (profiles, catalog, staff, stock, loanRequests, dashboard, reports, audit, settings, notifications) |
| `src/lib/api/client.ts` | `api()` fetch helper with the Firebase ID token |
| `src/lib/api/*.ts` | Client modules mirroring today's `src/lib/firebase/*` function names |
| `src/lib/loanRequestRules.ts` | Pure loan-request helpers moved out of `src/lib/firebase/loanRequests.ts` (shared client/server) |
| `scripts/seed/*.ts` | PostgreSQL seeds (`seed:comprehensive`, `seed:demo`) and shared seed helpers |
| `scripts/import-firestore.ts` | Firestore → PostgreSQL importer |

---

### Task 1: Local PostgreSQL, test runner and tooling

**Files:**
- Create: `scripts/db.mjs`, `vitest.config.ts`, `tests/helpers/empty.ts`, `tests/smoke.test.ts`, `drizzle.config.ts`
- Modify: `package.json` (scripts + dependencies), `.gitignore` (nothing new expected), `handout.md` (short "PostgreSQL locally" section)

**Interfaces:**
- Produces: `npm run db` / `db:stop` / `db:migrate` / `db:reset` / `test`; env `DATABASE_URL`, `TEST_DATABASE_URL`.

- [ ] **Step 1: Add dependencies** — `drizzle-orm`, `pg`; dev: `drizzle-kit`, `vitest`, `@types/pg`, `tsx`. Scripts: `"db": "node scripts/db.mjs start"`, `"db:stop": "node scripts/db.mjs stop"`, `"db:migrate": "drizzle-kit migrate"`, `"db:reset": "tsx scripts/db-reset.ts"` (created in Task 2), `"test": "vitest run"`. Append `DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/smartstock` to the `dev:emulators` cross-env list.
- [ ] **Step 2: `scripts/db.mjs`** — `start`: `docker run -d --name smartstock-postgres -e POSTGRES_PASSWORD=postgres -p 5432:5432 -v smartstock-pg:/var/lib/postgresql/data postgres:17` (reuse/`docker start` if the container exists), wait until `pg_isready` succeeds, then create databases `smartstock` and `smartstock_test` if missing. `stop`: `docker stop smartstock-postgres`. Same messages/exit-code style as `scripts/mailpit.mjs`.
- [ ] **Step 3: `vitest.config.ts`** — alias `@` → `src`, alias `server-only` → `tests/helpers/empty.ts`, `environment: 'node'`, `fileParallelism: false` (tests share one test database).
- [ ] **Step 4: Write `tests/smoke.test.ts`** — `it('reaches the test database', ...)`: connect with `TEST_DATABASE_URL` via `pg.Client`, `select 1 as ok` → `ok === 1`.
- [ ] **Step 5: Run** `npm run db` then `npm test` → 1 passed. Without the container running: fails with a connection error naming `TEST_DATABASE_URL` (check once).
- [ ] **Step 6: Commit** `chore: local PostgreSQL, Vitest and Drizzle tooling`.

### Task 2: Schema, migration and database client

**Files:**
- Create: `src/server/db/schema.ts`, `src/server/db/client.ts`, `src/server/db/ids.ts`, `scripts/db-reset.ts`, `drizzle/0000_*.sql` (generated), `tests/helpers/db.ts`, `tests/server/schema.test.ts`

**Interfaces:**
- Produces:
  - `schema.ts`: Drizzle tables `profiles, categories, products, productBarcodes, staff, transactions, transactionLines, returnWaivers, loanRequests, loanRequestLines, auditLog, settings, sentNotifications` with exactly the columns, uniques, FKs and CHECKs in spec §3 (TS property names = the snake_case column names, so rows already match `src/types/database.ts`). Indexes: `staff(uid)`, `staff(card_uid)`, unique `lower(email)`; `transactions(staff_id, created_at)`, `transactions(transaction_type, created_at)`; `transaction_lines(transaction_id)`, `(product_id)`; `loan_requests(staff_id, status)`, `(status)`; `loan_request_lines(request_id)`; `audit_log(created_at desc)`, `(entity_type, entity_id)`; `return_waivers(transaction_id)`.
  - `client.ts`: `getDb(url?: string): Db` (one `pg.Pool` per URL, `max: 5`), `type Db`, `type Tx`, `withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T>`, `toIso(d: Date | string | null): string | null`. Registers `pg` type parsers: `date` (OID 1082) → raw string; `numeric` (1700) → `Number`.
  - `ids.ts`: `newId(): string` (20 chars, `crypto.randomInt` over `[A-Za-z0-9]`).
  - `tests/helpers/db.ts`: `resetTestDb(): Promise<Db>` (drop + recreate schema `public`, run migrations from `drizzle/`), `closeTestDb()`.
  - `scripts/db-reset.ts`: same reset against `DATABASE_URL`, refuses when the host is not `127.0.0.1`/`localhost` unless `--force`.

- [ ] **Step 1: Write `tests/server/schema.test.ts`** with these tests (each on a fresh `resetTestDb()`):
  - `rejects stock below zero` — insert product with `quantity_on_hand: -1` → rejects.
  - `a barcode belongs to one product` — two products, same `product_barcodes.barcode` → rejects.
  - `staff email is unique regardless of capitals` — `A@x.com` then `a@x.com` → rejects.
  - `request status must be a known value` — `status: 'archived'` → rejects.
  - `dates round-trip unchanged` — insert `lend_from: '2026-10-01'`, select → exactly `'2026-10-01'` (string). *(Review Focus)*
  - `numerics come back as numbers` — `unit_cost: '12.50'` → `12.5`.
  - `newId is 20 alphanumeric characters and unique over 10 000 calls`.
- [ ] **Step 2: Run** `npm test -- schema` → fails (no schema).
- [ ] **Step 3: Implement** `schema.ts`, `client.ts`, `ids.ts`, `tests/helpers/db.ts`, `scripts/db-reset.ts`; run `npx drizzle-kit generate --name init` and commit the SQL in `drizzle/`.
- [ ] **Step 4: Run** `npm test -- schema` → 7 passed; `npm run db:reset` on the dev database → "Database reset and migrated".
- [ ] **Step 5: Commit** `feat(db): schema, first migration and database client`.

### Task 3: Caller context, route wrapper and client fetch helper

**Files:**
- Create: `src/server/context.ts`, `src/server/http.ts`, `src/lib/api/client.ts`, `tests/helpers/auth.ts`, `tests/server/http.test.ts`, `tests/api/client.test.ts`
- Modify: `src/lib/server/staffAdmin.ts` (keep `ApiError`; `requireSignedIn/requireRecentSignIn/requireAdmin/assertAdmin` read the role from PostgreSQL `profiles` via the new context)

**Interfaces:**
- Produces (`context.ts`):
  - `type Role = 'admin' | 'staff' | 'system'`
  - `interface Caller { uid: string | null; name: string | null; role: Role; staffId: string | null }` — `staffId` = the `staff.id` whose `uid` is the caller's uid.
  - `interface Ctx { db: Db | Tx; caller: Caller; now: () => Date }` — `now` is overridable (seeds/tests write history).
  - `class DataError extends Error { status: 400 | 401 | 403 | 404 | 409 }`
  - `assertAdmin(ctx: Ctx): void` (403 "Only admins can do this."), `assertStaffSelf(ctx: Ctx, staffId: string): void` (403 unless admin or `caller.staffId === staffId`).
  - `SYSTEM_CALLER: Caller` (`role: 'system'`, uid/name null) for lazy expiry and seeds.
- Produces (`http.ts`): `route<B, R>(access: 'public' | 'signed-in' | 'admin', handler: (ctx: Ctx, body: B, req: NextRequest) => Promise<R>)` → `(req: NextRequest) => Promise<NextResponse>`. Reads `Authorization: Bearer`, verifies with `adminAuth.verifyIdToken` (replaceable through `setTokenVerifier(fn)` for tests), loads profile + linked staff, maps `DataError`/`ApiError` to `{ error }` with its status, anything else to 500 `{ error: 'Something went wrong.' }` and `console.error`. GET handlers receive the query params object as `body`.
- Produces (`src/lib/api/client.ts`): `api<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T>` — attaches `await auth.currentUser?.getIdToken()` when signed in, GET bodies become query params, throws `Error(data.error)` with `.status` on non-2xx.

- [ ] **Step 1: Write `tests/server/http.test.ts`**: `public route works signed out`; `signed-in route without a token → 401 "Missing Authorization header."`; `expired token → 401 "Invalid or expired session — please sign in again."` *(Review Focus)*; `staff caller on an admin route → 403`; `caller carries role from profiles and staffId from staff.uid`; `DataError(409) keeps its status and message`; `unexpected error → 500 generic message`.
- [ ] **Step 2: Write `tests/api/client.test.ts`** (fetch stubbed): sends Bearer token when signed in, none when signed out; GET body → query string; non-2xx throws with server message and `.status`.
- [ ] **Step 3: Run** → both files fail.
- [ ] **Step 4: Implement** the three modules and switch `staffAdmin.ts` role lookups to PostgreSQL.
- [ ] **Step 5: Run** → all pass; existing route tests that use `requireAdmin` still pass once their stubs read `profiles` from the test DB (update `tests` stubs accordingly).
- [ ] **Step 6: Commit** `feat(server): caller context, route wrapper and API client`.

### Task 4: Profiles and sign-in contexts

**Files:**
- Create: `src/server/data/profiles.ts`, `src/app/api/me/route.ts`, `src/lib/api/me.ts`, `tests/server/profiles.test.ts`
- Modify: `src/context/AuthContext.tsx`, `src/context/StaffPortalContext.tsx`, `src/app/(auth)/login/page.tsx`

**Interfaces:**
- Produces: `getMe(ctx): Promise<{ profile: Profile | null; staff: StaffMember | null }>` (own profile; own staff row by uid); `GET /api/me` (signed-in); client `loadMe(): Promise<{ profile, staff }>`.

- [ ] **Step 1: Test** `getMe` returns own profile and linked staff; another user's rows never; no profile → `profile: null`.
- [ ] **Step 2: Run** → fail. **Step 3: Implement**; contexts and login page call `loadMe()` instead of `getDocFromServer`/`getDocsFromServer` (keep the `withAuthRaceRetry` retry around the call; keep every existing message such as "This account isn't set up for BICS or portal access — contact an administrator.").
- [ ] **Step 4: Run** tests → pass; `npx tsc --noEmit` → 0 errors.
- [ ] **Step 5: Commit** `feat(profiles): sign-in contexts read from PostgreSQL`.

### Task 5: Catalog data layer (categories, products, barcodes)

**Files:**
- Create: `src/server/data/catalog.ts`, `src/server/data/audit.ts` (`writeAudit`), `src/app/api/categories/route.ts`, `src/app/api/products/route.ts`, `src/app/api/products/[id]/route.ts`, `src/app/api/products/lookup/route.ts`, `src/lib/api/catalog.ts`, `tests/server/catalog.test.ts`

**Interfaces:**
- Produces (`audit.ts`): `writeAudit(ctx, { action, entityType, entityId, before, after }): Promise<string>` — `user_id/user_name` from `ctx.caller`, `created_at = ctx.now()`.
- Produces (`catalog.ts`), all saves in one `withTx` with their audit entry:
  - `listCategories(ctx)`, `createCategory(ctx, { name, description })`, `updateCategory(ctx, id, { name, description })`, `deleteCategory(ctx, id)` (409 when products use it, same message as the page today).
  - `listProducts(ctx, opts?: { availableOnly?: boolean })` → `Product[]` with `barcodes` (ordered by `position`) and `category_name`; `getProduct(ctx, id)`; `findProductByBarcode(ctx, code)`; `findBarcodeConflict(ctx, codes: string[], excludeId?: string): Promise<string | null>` (same message text as `src/lib/firebase/products.ts` today).
  - `createProduct(ctx, input)`, `updateProduct(ctx, id, input)`, `deleteProduct(ctx, id)` — input = today's product form fields incl. `barcodes: string[]`, `images: string[]`.
  - `getOutstandingHolders(ctx, productId)`, `getBarcodeUnitCounts(ctx, productId)`, `getProductDeleteBlockers(ctx, productId)` — same return types as today.
- Routes: products GET public; everything else admin. Client `src/lib/api/catalog.ts` exports the same names (minus `ctx`) and `productDeleteBlockReason` re-exported unchanged.

- [ ] **Step 1: Tests**: `product with barcodes round-trips in order`; `createProduct with a barcode another product uses → 409 with the friendly conflict message` *(Review Focus)*; `updateProduct writes one audit entry with before/after`; `deleteCategory in use → 409`; `deleteProduct with outstanding stock → blocked with today's reason`; `listProducts works without a caller (public)`; `staff caller cannot createProduct → 403`.
- [ ] **Step 2: Run** → fail. **Step 3: Implement.** **Step 4: Run** → pass.
- [ ] **Step 5: Commit** `feat(catalog): categories and products on PostgreSQL`.

### Task 6: Wire Products, Categories, Browse and product preview

**Files:**
- Modify: `src/app/(protected)/products/page.tsx`, `src/app/(protected)/categories/page.tsx`, `src/app/(portal)/lend/page.tsx`, `src/components/products/ProductPreviewDialog.tsx`, `src/app/api/notifications/product-stock/route.ts` (read product from PostgreSQL)
- Delete: `src/lib/firebase/products.ts`

**Interfaces:**
- Consumes: `src/lib/api/catalog.ts` (Task 5).

- [ ] **Step 1: Replace** every Firestore call in those files with the catalog client functions; keep `notifyProductStockChange` and `logAudit` behaviour (audit now written server-side, remove the client `logAudit` calls).
- [ ] **Step 2: Update** `tests/api/productstock-route.test.ts` (moved from the scratch harness) to read the product from the test DB; run → pass.
- [ ] **Step 3: Verify** `grep -n "firebase/firestore" <the five files>` → nothing; `npx tsc --noEmit` and `npx eslint <files>` → clean.
- [ ] **Step 4: Commit** `refactor(catalog): pages use the catalog API`.

### Task 7: Staff and My Profile

**Files:**
- Create: `src/server/data/staff.ts`, `src/app/api/staff/route.ts`, `src/app/api/staff/[id]/route.ts`, `src/lib/api/staff.ts`, `tests/server/staff.test.ts`
- Modify: `src/app/(protected)/staff/page.tsx`, `src/app/(protected)/profile/page.tsx`, `src/app/api/staff/update-email/route.ts`, `src/app/api/staff/send-reset-email/route.ts` (CRLF), `src/app/api/admin/update-name/route.ts`, `src/lib/server/staffAdmin.ts` (`findStaffDocOwningUid`), `src/lib/firebase/staff.ts` (keep `normalizeEmail`, `postStaffAdmin`; drop Firestore code)

**Interfaces:**
- Produces: `listStaff(ctx, { includeAdminAccount?: boolean })`, `getStaff(ctx, id)`, `createStaff(ctx, input)`, `updateStaff(ctx, id, input)`, `setStaffActive(ctx, id, active: boolean)` (audit `activate`/`deactivate`), `findStaffEmailConflict(ctx, email, excludeId?)`, `linkStaffLogin(ctx, id, uid)` (audit `grant_access`), `logResendAccess(ctx, id)` (audit `resend_access`), `updateOwnDetails(ctx, { name, surname, department })` (caller's own row; also updates `profiles.full_name`), `syncOwnEmail(ctx, email)`.
- Produces: staff page holder counts via `getStaffHoldings(ctx): Promise<Record<staffId, { outstanding: number }>>` (replaces its transactions/lines/waivers reads).

- [ ] **Step 1: Tests**: create/update write audit entries; duplicate email (any case) → 409 with today's message; staff caller can update only own details; `linkStaffLogin` to a uid already linked to another staff row → 409 with today's message; deactivate writes `deactivate` audit with the same before/after shape as today.
- [ ] **Step 2–4:** Run → fail; implement; wire pages and the three routes; run tests, `tsc`, eslint → clean.
- [ ] **Step 5: Commit** `feat(staff): staff and My Profile on PostgreSQL`.

### Task 8: Stock movements data layer

**Files:**
- Create: `src/server/data/stock.ts`, `src/app/api/stock/in/route.ts`, `src/app/api/stock/out/route.ts`, `src/app/api/stock/return/route.ts`, `src/app/api/stock/waivers/route.ts`, `src/app/api/stock/outstanding/route.ts`, `src/lib/api/stock.ts`, `tests/server/stock.test.ts`
- Delete: `src/lib/firebase/waivers.ts` (after Task 9 wiring)

**Interfaces:**
- Produces (each one `withTx`, locks affected `products` rows with `FOR UPDATE` in id order, writes transaction + lines + quantity changes + one `create` audit entry with the frozen `after.lines` shape used today):
  - `recordStockIn(ctx, { items: { productId, quantity, barcodes?: string[], unitCost? }[], notes }): Promise<{ id, reference_no }>`
  - `recordStockOut(ctx, { staffId, items, lendFrom, lendTo, manualOverride, notes, linkedRequestId? }): Promise<{ id, reference_no }>` — with `linkedRequestId`, also sets the request `fulfilled` + `fulfilled_txn_id` and writes its `update` audit entry in the same transaction; 409 "Not enough stock for <product>." when any line would go below zero.
  - `recordReturn(ctx, { staffId, linkedTxnId, items, returnDate, notes })` — only barcodes issued on the linked OUT, never more than still out (same rules as the seed's `recordTxn`).
  - `recordAdjust(ctx, { direction: 1 | -1, items, notes })`
  - `createReturnWaiver(ctx, { transactionId, productId, quantity, reason }): Promise<string>` (+ `resolve` audit)
  - `loadWaivedByTxn(ctx): Promise<WaivedByTxn>`, `loadWaivers(ctx)`, `listOutstandingForStaff(ctx, staffId)` (Returns page), `waivedQty` stays a pure helper in `src/lib/stockRules.ts`.
  - `reference_no` via `TXN-` + 8 chars from `[A-Z0-9]` (same as today).

- [ ] **Step 1: Tests**: stock out lowers quantities and writes txn + lines + audit atomically; `stock out of more than on hand → 409, nothing written`; `two concurrent stock outs of the last unit → exactly one succeeds, quantity 0` (two pool connections, `Promise.allSettled`); return of a barcode never issued → 400; return beyond outstanding → 400; fulfilling a request sets status, `fulfilled_txn_id` and its audit entry in the same transaction; waiver writes `resolve` audit; staff caller → 403 on every save.
- [ ] **Step 2–4:** Run → fail; implement; run → pass.
- [ ] **Step 5: Commit** `feat(stock): atomic stock movements on PostgreSQL`.

### Task 9: Wire Stock In, Stock Out and Returns

**Files:**
- Modify: `src/app/(protected)/stock-in/page.tsx`, `src/app/(protected)/stock-out/page.tsx`, `src/app/(protected)/returns/page.tsx`, `src/app/api/notifications/stock-out/route.ts`

- [ ] **Step 1: Replace** Firestore reads/writes with `src/lib/api/stock.ts`, `catalog.ts`, `staff.ts`; the pages stop writing audit entries themselves; the Stock Out notification call stays after a successful save.
- [ ] **Step 2: Move** the Stock Out route test into `tests/api/stockout-route.test.ts` against the test DB; run → pass.
- [ ] **Step 3: Verify** no `firebase/firestore` in the four files; `tsc`, eslint clean.
- [ ] **Step 4: Commit** `refactor(stock): Stock In, Stock Out and Returns use the stock API`.

### Task 10: Loan requests data layer

**Files:**
- Create: `src/lib/loanRequestRules.ts`, `src/server/data/loanRequests.ts`, `src/app/api/loan-requests/route.ts`, `src/app/api/loan-requests/[id]/route.ts`, `src/app/api/loan-requests/[id]/transition/route.ts`, `src/lib/api/loanRequests.ts`, `tests/server/loanRequests.test.ts`
- Modify: `src/lib/server/availability.ts` (PostgreSQL), `src/app/api/products/expected-return-dates/route.ts`

**Interfaces:**
- `loanRequestRules.ts` (pure, moved verbatim from `src/lib/firebase/loanRequests.ts`): `ACTIVE_STATUSES, OPEN_ENDED_TO, ALL_TIME_FROM, LENDING_INTERVALS, lendingIntervalDays, lendingIntervalLabel, effectiveToDate, reservationStatusLabel, resolutionInstruction, reservedQuantityInRange, tightestLendingCap, computeExpiryDate, isExpired, isNoShowCandidate, RequestSnapshotLine`.
- `loanRequests.ts` (server), same names as today with `ctx` first: `getReservationHolders, findQuantityReductionConflicts, getReservedQuantity, getReservationIntervals, validateCartDates, getRequestLines, listRequests(ctx, { staffId?, statuses? })` (staff: own only), `expireIfNeeded(ctx, requestId)`, `submitLoanRequest(ctx, input)` (staff: own staff row only), `approveAsIs, sendCounter, declineRequest` (admin), `acceptCounter, declineCounter` (staff own, from `countered` only), `withdrawRequest` (staff own from pending/countered/accepted, or admin with reason), `loadLoanRequestsAlertCount` (admin), `loadMyRequestsAlertCount(ctx)` (caller's own). Every transition: one `withTx`, `UPDATE … WHERE id = $1 AND status = $expected` (0 rows → 409 "This request has already changed — reload to see its current state."), plus the `update` audit entry with today's full snapshot shape (`requestAuditSnapshot`).
- `expireIfNeeded` runs as `SYSTEM_CALLER` (blank actor in the audit entry, as today).

- [ ] **Step 1: Tests**: submit writes request + lines + `create` audit (status pending, original dates); `staff cannot read another staff member's request → 404`; `staff cannot approve → 403`; `acceptCounter only from countered`; `counter edits offered quantities and dates in one transaction`; `two simultaneous expireIfNeeded calls on an expired request → one status change, one audit entry` *(Review Focus)*; no-show transition likewise; `validateCartDates` returns today's messages for an over-reserved range; availability route returns the same expected-return dates as before on a fixture.
- [ ] **Step 2–4:** Run → fail; implement; run → pass.
- [ ] **Step 5: Commit** `feat(loan-requests): loan requests on PostgreSQL`.

### Task 11: Wire loan request pages

**Files:**
- Modify: `src/app/(protected)/loan-requests/page.tsx`, `src/app/(portal)/lend/cart/page.tsx`, `src/app/(portal)/lend/requests/page.tsx`, `src/app/(portal)/lend/layout.tsx`, `src/components/layout/Sidebar.tsx`, `src/app/(protected)/stock-out/page.tsx` (pickup lookup), `src/app/api/notifications/loan-request/route.ts`
- Delete: `src/lib/firebase/loanRequests.ts`

- [ ] **Step 1: Replace** imports with `src/lib/loanRequestRules.ts` (pure) and `src/lib/api/loanRequests.ts`; `notifyLoanRequestEvent` calls stay after each successful transition.
- [ ] **Step 2: Move** the loan-request route test to `tests/api/loanrequest-route.test.ts` on the test DB; run → pass.
- [ ] **Step 3: Verify** no `firebase/firestore` or `lib/firebase/loanRequests` imports remain (`grep -rn`); `tsc`, eslint clean.
- [ ] **Step 4: Commit** `refactor(loan-requests): admin and portal pages use the loan request API`.

### Task 12: Dashboard

**Files:**
- Create: `src/server/data/dashboard.ts`, `src/app/api/dashboard/route.ts`, `src/lib/api/dashboard.ts`, `tests/server/dashboard.test.ts`
- Modify: `src/app/(protected)/dashboard/page.tsx`
- Delete: `src/lib/firebase/dashboardAlerts.ts`

**Interfaces:**
- Produces: `loadDashboardAlertCounts(ctx): Promise<DashboardAlertCounts>` (same type), `loadDashboard(ctx): Promise<{ outstandingReturns, incomingPickups, lowStock }>` returning the exact row shapes the page renders today (badge state per row computed in SQL or the server, not the browser).

- [ ] **Step 1: Tests** on a fixture with one row per badge (no date, overdue, due today, not due yet, partly resolved, mixed holder; on schedule, insufficient with cause, insufficient without, not picked up; low, out of stock) → each appears once with the right badge and counts match `loadDashboardAlertCounts`.
- [ ] **Step 2–4:** Run → fail; implement; wire page; run → pass; `tsc`, eslint clean.
- [ ] **Step 5: Commit** `feat(dashboard): dashboard computed on the server`.

### Task 13: Reports and Audit Log

**Files:**
- Create: `src/server/data/reports.ts`, `src/server/data/auditLog.ts` (read side), `src/app/api/reports/route.ts`, `src/app/api/audit-log/route.ts`, `src/lib/api/reports.ts`, `src/lib/api/auditLog.ts`, `tests/server/reports.test.ts`
- Modify: `src/app/(protected)/reports/page.tsx`, `src/app/(protected)/audit-log/page.tsx`

**Interfaces:**
- Produces: `loadReport(ctx, { report: 'stock-levels' | 'low-stock' | 'issued-per-staff' | 'transactions' | 'returns', from?, to?, staffId?, categoryId? })` returning the row shapes each report tab renders today; `listAuditLog(ctx, { from?, to?, entityType?, action?, userId? })` → `AuditLogEntry[]` newest first plus the line lookups the page uses (`transaction_lines`, `loan_request_lines` for listed entities).

- [ ] **Step 1: Tests**: each report on a fixture returns the expected rows and totals; issued-per-staff groups multi-barcode lines as today; audit log filters by entity and date; admin only (staff → 403).
- [ ] **Step 2–4:** Run → fail; implement; wire pages (CSV/PDF export keep working from the returned rows); run → pass.
- [ ] **Step 5: Commit** `feat(reports): reports and audit log from PostgreSQL`.

### Task 14: Settings and email notifications

**Files:**
- Create: `src/server/data/settings.ts`, `src/app/api/settings/notifications/route.ts`, `src/lib/api/settings.ts`, `tests/server/settings.test.ts`
- Modify: `src/lib/firebase/notificationSettings.ts` (keep definitions/defaults; load/save via the API), `src/lib/server/notificationDelivery.ts` (`deliver` marker → `INSERT … ON CONFLICT DO NOTHING` on `sent_notifications`; settings from `settings`), `src/app/api/contact/route.ts`, `src/app/api/auth/forgot-password/route.ts` (cooldown marker in `sent_notifications`), `src/app/(protected)/settings/notifications/page.tsx`
- Move: remaining scratch-harness suites (`delivery`, `contact`, `account-emails`, `notify-event`, `templates`, `mailer`) into `tests/` against the test DB.

**Interfaces:**
- Produces: `loadNotificationSettings(ctx)`, `setNotificationSetting(ctx, key, value)`, `saveAddress(ctx, 'admin_notification_email' | 'system_from_email', value)` (same validation and audit as today), `getSettingsRow(db, key)`.

- [ ] **Step 1: Tests**: duplicate delivery → second call `duplicate`, one email; failed send removes the marker; contact route returns the saved admin address; refusing to enable an unbuilt email keeps today's message.
- [ ] **Step 2–4:** Run → fail; implement; run the whole suite → pass.
- [ ] **Step 5: Commit** `feat(settings): settings and notification markers on PostgreSQL`.

### Task 15: Seed foundation and `seed:comprehensive`

**Files:**
- Create: `scripts/seed/context.ts` (`seedCtx(db, at: Date, caller)`, Auth emulator user helpers, Storage upload helpers moved from the old seed), `scripts/seed/comprehensive.ts`, `tests/seed/comprehensive.test.ts`
- Modify: `package.json` (`"seed:comprehensive": "tsx scripts/seed/comprehensive.ts"`)
- Delete: `scripts/seed-comprehensive-demo.mjs` (after the test passes)

**Interfaces:**
- Consumes: all `src/server/data/*` save functions with `ctx.now` set to the scenario's historical time (`isoAt(dayOffset)` semantics kept: `addDays(TODAY, offset)` at 09:00 local).
- Produces: `seedComprehensive(deps: { db: Db; auth: SeedAuth; bucket: SeedBucket }): Promise<SeedSummary>` (`SeedAuth`/`SeedBucket` are the two methods the seed uses, so tests pass fakes); the CLI wires the emulators and prints today's summary text.

- [ ] **Step 1: Test** (fake auth/bucket, fresh test DB): admin Jonathan Pritchard + Jessica Moore logins; 31 scenario staff; every request status; every Dashboard badge from Task 12's fixture list; Jessica's History > 10; transactions/lines/audit counts equal the Firestore seed's (record the counts from the current seed run on the emulator once and pin them).
- [ ] **Step 2–4:** Run → fail; port scenario by scenario through the data layer (no raw inserts except where the app has no save path, e.g. settings and historical system expiries); run → pass.
- [ ] **Step 5: Commit** `feat(seed): seed:comprehensive on PostgreSQL`.

### Task 16: `seed:demo`

**Files:**
- Create: `scripts/seed/demo.ts`, `tests/seed/demo.test.ts`
- Modify: `package.json` (`"seed:demo": "tsx scripts/seed/demo.ts"`)
- Delete: `scripts/seed-demo.mjs`, and the retired seeds `seed-emulator.mjs`, `seed-lending-portal.mjs`, `seed-staff-roster.mjs`, `seed-conflict-scenarios.mjs`, `seed-outstanding.mjs`, `seed-products.mjs`, `seed-product-catalog.mjs`, `seed-real-production.mjs`, `cleanup-borrower-test-data.mjs` with their npm scripts (`images:*` stay).

**Interfaces:**
- Produces: `seedDemo(deps)` built on `seedComprehensive` with the cast/admin/Bostik options from today's `scripts/seed-demo.mjs` header (same 20 NWU mappings, same 10 dropped scenarios, Selouna admin `admin-selouna-visser`, Meiring portal login, Bostik Glu Dots + its audit entry at `2026-09-29T08:17:02.407Z`).

- [ ] **Step 1: Test**: port the 11 assertions of the scratch `check-seed-demo.mjs` to Vitest on the test DB.
- [ ] **Step 2–4:** Run → fail; implement (parameterise `seedComprehensive` with a cast/options object rather than copying it); run → pass.
- [ ] **Step 5: Commit** `feat(seed): seed:demo on PostgreSQL; retire one-feature seeds`.

### Task 17: Firestore importer

**Files:**
- Create: `scripts/import-firestore.ts`, `src/server/import/mapFirestore.ts`, `tests/import/importer.test.ts`, `tests/import/fixtures/*.json`
- Modify: `package.json` (`"db:import-firestore": "tsx scripts/import-firestore.ts"`)

**Interfaces:**
- Produces: `interface FirestoreSource { list(collection: string): Promise<{ id: string; data: Record<string, unknown> }[]> }`; `planImport(source): Promise<ImportPlan>` (rows per table + `problems: { collection, id, problem }[]`); `runImport(db, plan, { replace: boolean }): Promise<ImportCounts>` (one transaction).
- CLI: `--source emulator|live` (emulator: `FIRESTORE_EMULATOR_HOST` + project `demo-smartstock-nwu`; live: `.env.local` Admin credentials), default dry run printing counts and problems, `--write` to import, `--replace` to empty the tables first.
- Mapping per spec §7: IDs verbatim; `products.barcodes[]` → `product_barcodes` with `position`; `settings/notifications` → `settings` key `notifications`; ISO strings → timestamptz; `YYYY-MM-DD` → date; collections the app no longer has → reported, not imported.

- [ ] **Step 1: Tests** (in-memory `FirestoreSource` from fixtures): round-trip of one record per collection with IDs kept; a line pointing at a missing product → listed in `problems`, nothing written with `--write` until fixed; unknown status → problem; duplicate barcode across products → problem; `runImport` into a non-empty database without `replace` → refuses, database unchanged *(Review Focus)*; a failing insert mid-way → rolled back.
- [ ] **Step 2–4:** Run → fail; implement; run → pass.
- [ ] **Step 5: Manual check:** on the old `seed-demo` branch seed the Firestore emulator with `seed:comprehensive`, then on `postgres` run `db:import-firestore --source emulator` (dry run → 0 problems) and `--write`; counts match the Firestore collections. Then `--source live` dry run only (read-only) and save its report in the handout.
- [ ] **Step 6: Commit** `feat(import): Firestore to PostgreSQL importer`.

### Task 18: Remove Firestore and finish

**Files:**
- Delete: `src/lib/firebase/firestore.ts`, `src/lib/firebase/freshDocs.ts`, `src/lib/firebase/audit.ts`, `firestore.rules`, `firestore.indexes.json`
- Modify: `src/lib/firebase/config.ts` (no Firestore init/emulator), `src/lib/firebase/admin.ts` (no `adminDb`), `firebase.json` (emulators: auth + storage only; drop Firestore rules), `package.json` (`dev:emulators` drops `FIRESTORE_EMULATOR_HOST`), `src/lib/server/mailer.ts` (emulator guard keys on `FIREBASE_AUTH_EMULATOR_HOST` only), `handout.md`, `README.md`

- [ ] **Step 1: Verify nothing still uses Firestore**: `grep -rnE "firebase/firestore|firebase-admin/firestore|adminDb" src scripts` → only the importer.
- [ ] **Step 2: Run** `npm test`, `npx tsc --noEmit`, `npx eslint` on changed files, `npm run build` → all clean.
- [ ] **Step 3: Manual pass**: `npm run db:reset && npm run seed:demo`, then the Mailpit checklist (handout steps 1–15) and the demo walkthrough on `dev:emulators`; note results in the handout.
- [ ] **Step 4: Commit** `chore: remove Firestore; PostgreSQL is the only database`.

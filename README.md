# SmartStock-NWU

Stock and loan management for the NWU BICS store, built with Next.js 16 (App Router), TypeScript, Drizzle ORM and PostgreSQL 17.

- **Data:** PostgreSQL, reached only from server code through `DATABASE_URL`. The browser calls the `/api/*` routes.
- **Sign-in:** Firebase Auth. **Product photos:** Firebase Storage.
- Firestore is no longer used. The one-off importer `npm run db:import-firestore` is the only code that still reads it.

The full handout (setup, cut-over runbook, behaviour changes, manual check list and the dated history) is in [`handout.md`](./handout.md).

## Local setup

```bash
npm install
npm run db            # PostgreSQL 17 in Docker on 127.0.0.1:5432 (user/password postgres); or use any local PostgreSQL 17
npm run db:migrate    # create the tables (DATABASE_URL, default postgres://postgres:postgres@127.0.0.1:5432/smartstock)
npm run emulators     # Firebase Auth + Storage emulators (own terminal)
npm run seed:demo     # or: npm run seed:comprehensive. Add "-- --reset" to clear the app tables first
npm run mailpit       # optional local inbox at http://localhost:8025 (Docker, own terminal)
npm run dev:emulators # the app on http://localhost:3000, against the emulators and the local database
```

If you do not use `npm run db`, create the databases `smartstock` (the app) and `smartstock_test` (the tests) yourself and set `DATABASE_URL` (and `TEST_DATABASE_URL` for the tests, default `postgres://postgres:postgres@127.0.0.1:5432/smartstock_test`).

Sign in after `seed:demo` as `selouna.visser@nwu.ac.za` / `password123` (administrator), or after `seed:comprehensive` as `jonathan.pritchard@nwu.ac.za` / `password123`. The portal borrower logins are listed in the handout.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Next.js dev server against the real Firebase project (needs `.env.local`) |
| `npm run dev:emulators` | Dev server against the Auth and Storage emulators, Mailpit and the local database |
| `npm run build` / `npm start` | Production build and server (needs the Firebase public settings and `DATABASE_URL`) |
| `npm test` | Automated tests (Vitest) against `smartstock_test`; PostgreSQL must be running |
| `npm run db` / `db:stop` | Start / stop the Docker PostgreSQL |
| `npm run db:migrate` / `db:reset` | Apply the schema / empty the app tables |
| `npm run seed:comprehensive` / `seed:demo` | Seed every scenario / the client demo (`-- --reset` to start clean) |
| `npm run emulators` | Firebase Auth + Storage emulators (Emulator UI on http://127.0.0.1:4000) |
| `npm run db:import-firestore` | One-off Firestore to PostgreSQL import (see "Cut-over to Cloud SQL" in the handout) |

## Deploying

The app deploys to Vercel. Set `DATABASE_URL` (the Cloud SQL connection string) and the Firebase settings in the project's environment variables. The handout covers moving the live data over, and the PostgreSQL connection pool on Vercel.

Next.js in this repo has breaking changes from older versions: read the guides in `node_modules/next/dist/docs/` before changing routes or build settings.

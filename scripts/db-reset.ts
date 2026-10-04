// Empty a database and run every migration. Usage: npm run db:reset [-- --force]
// Uses pg and Drizzle directly (not src/server/db/client.ts) because that module imports `server-only`,
// which throws outside a Next.js build.
// Refuses (without --force) a host other than this machine, and any database not named smartstock or smartstock_test:
// Cloud SQL through the Auth Proxy looks local, so the host check alone would not stop a reset of it.
import path from 'node:path'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { assertResettableDatabase } from './dbGuard'

async function main() {
  const url = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/smartstock'
  const force = process.argv.includes('--force')
  const host = new URL(url).hostname
  if (!force && host !== '127.0.0.1' && host !== 'localhost') {
    console.error(`Refusing to reset a database on "${host}". Pass --force if you really mean it.`)
    process.exit(1)
  }

  const pool = new pg.Pool({ connectionString: url, max: 1 })
  try {
    try {
      await assertResettableDatabase(pool, force, 'reset')
    } catch (err) {
      console.error((err as Error).message)
      process.exitCode = 1
      return
    }
    await pool.query('drop schema if exists drizzle cascade')
    await pool.query('drop schema if exists public cascade')
    await pool.query('create schema public')
    await migrate(drizzle(pool), { migrationsFolder: path.resolve(process.cwd(), 'drizzle') })
    console.log('Database reset and migrated')
  } finally {
    await pool.end()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

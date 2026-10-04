import 'server-only'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import * as schema from './schema'

// Applied to every pool, as soon as this module loads.
// date (OID 1082): keep the raw 'YYYY-MM-DD' string; pg's default turns it into a Date at local midnight,
//   which can land on the previous day in UTC.
// numeric (OID 1700): a JS number, as the app's types expect (unit_cost etc.).
// timestamptz stays a Date; the data layer converts it with toIso().
pg.types.setTypeParser(1082, (value: string) => value)
pg.types.setTypeParser(1700, (value: string) => Number(value))

export type Db = NodePgDatabase<typeof schema> & { $client: pg.Pool }
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

// One pool per URL. Kept on globalThis so Next.js hot reloads in development don't open a new pool each time.
const globalForPools = globalThis as unknown as { __smartstockPools?: Map<string, Db> }
const pools = (globalForPools.__smartstockPools ??= new Map<string, Db>())

export function getDb(url: string | undefined = process.env.DATABASE_URL): Db {
  if (!url) throw new Error('DATABASE_URL is not set.')
  let db = pools.get(url)
  if (!db) {
    const pool = new pg.Pool({ connectionString: url, max: 5 })
    // An idle connection dropping must not crash the process.
    pool.on('error', (err) => console.error('PostgreSQL pool error:', err.message))
    db = drizzle(pool, { schema }) as Db
    pools.set(url, db)
  }
  return db
}

/** Close the pool for a URL (default DATABASE_URL). Used by tests and scripts so the process can exit. */
export async function closeDb(url: string | undefined = process.env.DATABASE_URL): Promise<void> {
  if (!url) return
  const db = pools.get(url)
  if (!db) return
  pools.delete(url)
  await db.$client.end()
}

export function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(fn)
}

/** timestamptz value (Date, or already a string) to an ISO string; null stays null. */
export function toIso(d: Date | string | null): string | null {
  if (d === null) return null
  return (d instanceof Date ? d : new Date(d)).toISOString()
}

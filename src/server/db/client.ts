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

// Query-string keys through which a connection string configures TLS. pg reads them in pg-connection-string and the
// result REPLACES an explicit `ssl` pool option (connection-parameters.js: Object.assign(config, parse(url))), so with
// DATABASE_SSL_CA set they are removed from the URL and the CA-pinned `ssl` option below is what applies.
const URL_SSL_KEYS = ['ssl', 'sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'sslnegotiation', 'uselibpqcompat']

/** Drop the TLS query parameters (URL_SSL_KEYS) from a connection string; everything else is kept verbatim. */
export function stripUrlSsl(url: string): string {
  const q = url.indexOf('?')
  if (q === -1) return url
  const params = new URLSearchParams(url.slice(q + 1))
  for (const key of URL_SSL_KEYS) params.delete(key)
  const rest = params.toString()
  return rest ? `${url.slice(0, q)}?${rest}` : url.slice(0, q)
}

/**
 * Pool options for a connection string, from the environment:
 * - `DATABASE_POOL_MAX`: connections per server instance (default 5). Keep it small on Vercel, where every function
 *   instance has its own pool.
 * - `DATABASE_SSL_CA`: the server's CA certificate as PEM text (Cloud SQL: the instance's server-ca.pem). A single line
 *   with `\n` escapes, as Vercel env vars are often pasted, is accepted too. When set, the connection is TLS with the
 *   certificate checked against this CA but not the host name (libpq's `verify-ca`): Cloud SQL's instance certificate
 *   does not name the IP address you connect to, so pg's default (`sslmode=require` means verify-full in pg 8) fails.
 *   Any sslmode/ssl/sslrootcert in the URL is ignored in that case, because pg would let it override this option.
 * Without DATABASE_SSL_CA the URL decides, as before (e.g. no TLS through the Cloud SQL Auth Proxy or locally).
 */
export function buildPoolConfig(url: string, env: Record<string, string | undefined> = process.env): pg.PoolConfig {
  const rawMax = env.DATABASE_POOL_MAX?.trim()
  const max = rawMax ? Number(rawMax) : 5
  if (!Number.isInteger(max) || max < 1) throw new Error('DATABASE_POOL_MAX must be a whole number of at least 1.')
  const config: pg.PoolConfig = { connectionString: url, max, idleTimeoutMillis: 10_000 }

  const rawCa = env.DATABASE_SSL_CA?.trim()
  if (rawCa) {
    const ca = rawCa.replace(/\\r\\n|\\n/g, '\n').replace(/\r\n/g, '\n')
    if (!ca.includes('-----BEGIN CERTIFICATE-----')) {
      throw new Error('DATABASE_SSL_CA must be the PEM text of the server CA certificate (-----BEGIN CERTIFICATE-----…).')
    }
    config.connectionString = stripUrlSsl(url)
    config.ssl = { ca, rejectUnauthorized: true, checkServerIdentity: () => undefined }
  }
  return config
}

// One pool per URL. Kept on globalThis so Next.js hot reloads in development don't open a new pool each time.
const globalForPools = globalThis as unknown as { __smartstockPools?: Map<string, Db> }
const pools = (globalForPools.__smartstockPools ??= new Map<string, Db>())

export function getDb(url: string | undefined = process.env.DATABASE_URL): Db {
  if (!url) throw new Error('DATABASE_URL is not set.')
  let db = pools.get(url)
  if (!db) {
    const pool = new pg.Pool(buildPoolConfig(url))
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

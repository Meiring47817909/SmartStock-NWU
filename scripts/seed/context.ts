// Shared foundation for the PostgreSQL seeds (seed:comprehensive now, seed:demo next).
//
// What lives here, so a second seed script only has to describe its own cast and scenarios:
//   - the seed clock: `isoAt(dayOffset)` is `addDays(TODAY, offset)` at 09:00 Africa/Johannesburg, worked out with
//     APP_TIME_ZONE (never the machine's zone), and `seedCtx` runs a data-layer save "as of" that moment, so audit
//     entries, created_at/updated_at and the lazy-expiry decisions are all historical;
//   - the callers a save runs as (the administrator, a staff member on the portal, the system);
//   - the Auth emulator user helper and the Storage emulator photo uploader (taking the two small interfaces below, so
//     tests pass fakes), plus the firebase-admin wiring that only ever talks to the emulators;
//   - the safety rails: the seed only runs against a local PostgreSQL and against the emulators, and refuses a database
//     that already holds data.
//
// Server modules import 'server-only': run these scripts with `tsx --conditions=react-server` (see package.json).
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { count, getTableName, is, sql } from 'drizzle-orm'
import { PgTable } from 'drizzle-orm/pg-core'
import { SYSTEM_CALLER, type Caller, type Ctx } from '@/server/context'
import type { Db } from '@/server/db/client'
import * as schema from '@/server/db/schema'
import { addDaysToDateStr, APP_TIME_ZONE, appCalendarDay } from '@/lib/utils'

export { SYSTEM_CALLER }

/** Every seeded login uses this password (printed in the summary). */
export const SEED_PASSWORD = 'password123'
export const SEED_PROJECT_ID = 'demo-smartstock-nwu'
/** Must match NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET in .env.local. */
export const SEED_BUCKET_NAME = 'smartstock-nwu.firebasestorage.app'

// --- Clock and context --------------------------------------------------------------------------------------------

/** The UTC instant at which `day` (YYYY-MM-DD) reads `hour`:00 on the wall clock of `timeZone`. */
function zonedInstant(day: string, hour: number, timeZone: string): Date {
  const [y, m, d] = day.split('-').map(Number)
  const guess = Date.UTC(y, m - 1, d, hour)
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  // How far the zone's wall clock is ahead of UTC at a given instant.
  const offsetAt = (ms: number): number => {
    const p = Object.fromEntries(parts.formatToParts(new Date(ms)).map((x) => [x.type, x.value]))
    return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)) - ms
  }
  // Second pass settles the answer when the offset differs between the guess and the real instant (a DST edge).
  const first = guess - offsetAt(guess)
  return new Date(guess - offsetAt(first))
}

export interface SeedClock {
  /** The calendar day in APP_TIME_ZONE the seed was started on. */
  today: string
  /** `today` shifted by whole days, as YYYY-MM-DD. */
  addDays(dayOffset: number): string
  /** 09:00 in APP_TIME_ZONE on `addDays(dayOffset)`, plus optional minutes to order two saves on one day. */
  at(dayOffset: number, minutes?: number): Date
  isoAt(dayOffset: number, minutes?: number): string
}

export function seedClock(now: Date = new Date()): SeedClock {
  const today = appCalendarDay(now)
  const addDays = (dayOffset: number) => addDaysToDateStr(today, dayOffset)
  const at = (dayOffset: number, minutes = 0) =>
    new Date(zonedInstant(addDays(dayOffset), 9, APP_TIME_ZONE).getTime() + minutes * 60_000)
  return { today, addDays, at, isoAt: (dayOffset, minutes) => at(dayOffset, minutes).toISOString() }
}

/** A data-layer context whose clock is stopped at `at`: every save made with it is stamped with that instant. */
export function seedCtx(db: Db, at: Date, caller: Caller): Ctx {
  return { db, caller, now: () => at }
}

export function adminCaller(uid: string, name: string, staffId: string | null): Caller {
  return { uid, name, role: 'admin', staffId }
}

/**
 * A staff member acting on the lending portal. Seeded staff who have no login still act in some scenarios (the audit trail
 * has always shown them as the actor), so their staff id stands in for the Firebase uid, as the old seeds did.
 */
export function staffCaller(member: { id: string; uid: string | null; full_name: string }): Caller {
  return { uid: member.uid ?? member.id, name: member.full_name, role: 'staff', staffId: member.id }
}

/** Card UID spread evenly over a roster (8 hex digits, like a real card). */
export function cardUidFor(index: number): string {
  return (0x04a00000 + (index + 1) * 0x1f3b7).toString(16).toUpperCase().padStart(8, '0')
}

// --- Safety rails ---------------------------------------------------------------------------------------------------

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

export function isLocalHost(host: string): boolean {
  return LOCAL_HOSTS.has(host.toLowerCase())
}

/** Throws unless `url` points at this machine (or `allowNonLocal` was given explicitly). */
export function assertLocalDatabaseUrl(url: string, allowNonLocal = false): void {
  let host = ''
  try {
    host = new URL(url).hostname
  } catch {
    // An unparseable URL is treated as "not known to be local".
  }
  if (!allowNonLocal && !isLocalHost(host)) {
    throw new Error(
      `Refusing to seed a database on "${host || 'an unknown host'}": the seeds only run against a local PostgreSQL ` +
        '(127.0.0.1 or localhost). Pass --allow-non-local-db only if you really mean it.',
    )
  }
}

/** The same check on an open connection (what the seed function itself uses, so no caller can skip it). */
export function assertLocalDatabase(db: Db, allowNonLocal = false): void {
  const options = db.$client.options
  const host = options.connectionString ? safeHost(options.connectionString) : (options.host ?? '')
  if (!allowNonLocal && !isLocalHost(host)) {
    throw new Error(
      `Refusing to seed a database on "${host || 'an unknown host'}": the seeds only run against a local PostgreSQL ` +
        '(127.0.0.1 or localhost). Pass --allow-non-local-db only if you really mean it.',
    )
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

/**
 * The Auth and Storage helpers below only ever talk to the emulators: both hosts must be set and local, or this throws
 * before anything is created. (firebase-admin reads these variables and then never contacts the live project.)
 */
export function assertEmulatorEnv(env: Record<string, string | undefined> = process.env): void {
  for (const name of ['FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_STORAGE_EMULATOR_HOST'] as const) {
    const value = env[name]
    if (!value) throw new Error(`${name} is not set: the seed only talks to the Firebase emulators. Start them with "npm run emulators".`)
    const host = value.replace(/^\w+:\/\//, '').replace(/:\d+$/, '')
    if (!isLocalHost(host)) throw new Error(`${name} is "${value}": the seed only talks to emulators on this machine.`)
  }
}

function appTables(): PgTable[] {
  return (Object.values(schema) as unknown[]).filter((t): t is PgTable => is(t, PgTable))
}

/** Throws unless every app table is empty (the seed's ledger data is append-only, so it never merges into old data). */
export async function assertEmptyDatabase(db: Db): Promise<void> {
  const filled: string[] = []
  for (const table of appTables()) {
    const [row] = await db.select({ n: count() }).from(table)
    if (row.n > 0) filled.push(`${getTableName(table)} (${row.n})`)
  }
  if (filled.length > 0) {
    throw new Error(
      `The database already has data: ${filled.join(', ')}. Run "npm run db:reset" for a clean database, ` +
        'or run the seed with --reset to clear the app tables first.',
    )
  }
}

/** Empty every app table (keeps the schema and the migration history). The seed's --reset. */
export async function resetAppTables(db: Db): Promise<void> {
  const names = appTables().map((t) => `"${getTableName(t)}"`)
  await db.execute(sql.raw(`truncate table ${names.join(', ')} restart identity cascade`))
}

// --- Firebase Auth emulator -----------------------------------------------------------------------------------------

/** The slice of the Admin SDK's Auth the seed uses. */
export interface SeedAuth {
  getUserByEmail(email: string): Promise<{ uid: string }>
  updateUser(uid: string, props: { email: string; emailVerified: boolean }): Promise<{ uid: string }>
  createUser(props: { uid: string; email: string; password: string; emailVerified: boolean }): Promise<{ uid: string }>
}

/**
 * Get-or-create an Auth account with a known password. A login that already exists under this email is reused; the
 * same account left over under an old email (the emulators keep their data while they stay up) is adopted.
 */
export async function upsertSeedUser(auth: SeedAuth, email: string, password: string, uid: string): Promise<{ uid: string }> {
  try {
    return await auth.getUserByEmail(email)
  } catch {
    try {
      return await auth.updateUser(uid, { email, emailVerified: true })
    } catch {
      return await auth.createUser({ uid, email, password, emailVerified: true })
    }
  }
}

// --- Product photos (Firebase Storage emulator) -----------------------------------------------------------------------

/** The slice of a Storage bucket the seed uses. */
export interface SeedBucket {
  save(filePath: string, data: Buffer, options: { contentType: string; cacheControl: string }): Promise<void>
}

const IMAGE_PALETTE = [
  { color: '#2563eb', glyph: '\u{1F4BB}' },
  { color: '#7c3aed', glyph: '\u{1F4E6}' },
  { color: '#059669', glyph: '\u{1F50C}' },
  { color: '#d97706', glyph: '\u{1F5A5}️' },
  { color: '#db2777', glyph: '\u{1F4F7}' },
  { color: '#0891b2', glyph: '⚙️' },
]

function placeholderSvg(name: string, angleLabel: string, bgColor: string, glyph: string): string {
  const escapedName = name.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640" viewBox="0 0 640 640">
  <rect width="640" height="640" fill="${bgColor}"/>
  <text x="320" y="280" font-size="200" text-anchor="middle" font-family="system-ui, sans-serif">${glyph}</text>
  <text x="320" y="400" font-size="36" font-weight="700" fill="white" text-anchor="middle" font-family="system-ui, sans-serif">${escapedName}</text>
  <text x="320" y="450" font-size="26" fill="rgba(255,255,255,0.85)" text-anchor="middle" font-family="system-ui, sans-serif">${angleLabel}</text>
</svg>`
}

/** Real product photos (AI-generated, see scripts/generate-product-images.mjs) live in scripts/catalog-images/<slug>/. */
export function catalogImagesDir(): string {
  return path.resolve(process.cwd(), 'scripts', 'catalog-images')
}

export type ProductImageSeeder = (productId: string, productName: string, imageSlug?: string | null) => Promise<string[]>

/**
 * Uploads 1-3 photos per product and returns their Storage paths, ready to save on the product. Real photos when
 * scripts/catalog-images/<slug>/1.jpg, 2.jpg ... exist; otherwise generated placeholders whose count cycles 1/2/3 across
 * calls (so Browse and the Products gallery show a visible mix of 1-, 2- and 3-image products). The cycle belongs to one
 * seeder, so call order decides which product gets how many.
 */
export function createProductImageSeeder(bucket: SeedBucket, imagesDir: string = catalogImagesDir()): ProductImageSeeder {
  let imageSeq = 0
  return async (productId, productName, imageSlug = null) => {
    if (imageSlug) {
      const real: { n: number; file: string }[] = []
      for (let n = 1; n <= 3; n++) {
        const file = path.join(imagesDir, imageSlug, `${n}.jpg`)
        if (existsSync(file)) real.push({ n, file })
      }
      if (real.length > 0) {
        const paths: string[] = []
        for (const { n, file } of real) {
          const storagePath = `products/${productId}/${imageSlug}-${n}.jpg`
          await bucket.save(storagePath, readFileSync(file), { contentType: 'image/jpeg', cacheControl: 'public, max-age=3600' })
          paths.push(storagePath)
        }
        return paths
      }
    }
    const imageCount = (imageSeq % 3) + 1
    imageSeq += 1
    const angleLabels = ['Front', 'Side', 'In case']
    const paths: string[] = []
    for (let i = 0; i < imageCount; i++) {
      const swatch = IMAGE_PALETTE[(imageSeq + i) % IMAGE_PALETTE.length]
      const storagePath = `products/${productId}/placeholder-${i}.svg`
      const svg = placeholderSvg(productName, angleLabels[i], swatch.color, swatch.glyph)
      await bucket.save(storagePath, Buffer.from(svg, 'utf8'), { contentType: 'image/svg+xml', cacheControl: 'public, max-age=3600' })
      paths.push(storagePath)
    }
    return paths
  }
}

// --- Emulator wiring (CLI only) -------------------------------------------------------------------------------------------

/** firebase-admin loads on demand, so tests that pass fakes never initialise it. Checks the emulator hosts first. */
export async function createEmulatorAuthAndBucket(): Promise<{ auth: SeedAuth; bucket: SeedBucket }> {
  assertEmulatorEnv()
  const { initializeApp } = await import('firebase-admin/app')
  const { getAuth } = await import('firebase-admin/auth')
  const { getStorage } = await import('firebase-admin/storage')
  const app = initializeApp({ projectId: SEED_PROJECT_ID, storageBucket: SEED_BUCKET_NAME })
  const auth = getAuth(app)
  const bucket = getStorage(app).bucket()
  return {
    auth: {
      getUserByEmail: (email) => auth.getUserByEmail(email),
      updateUser: (uid, props) => auth.updateUser(uid, props),
      createUser: (props) => auth.createUser(props),
    },
    bucket: {
      save: (filePath, data, options) =>
        bucket.file(filePath).save(data, { contentType: options.contentType, metadata: { cacheControl: options.cacheControl } }),
    },
  }
}

/** In-memory stand-ins for `--dry-auth` and tests: nothing leaves the process. */
export function createFakeAuthAndBucket(): { auth: SeedAuth; bucket: SeedBucket; users: Map<string, { uid: string; email: string; password: string }>; files: Map<string, Buffer> } {
  const users = new Map<string, { uid: string; email: string; password: string }>()
  const files = new Map<string, Buffer>()
  const notFound = () => Object.assign(new Error('There is no user record corresponding to the provided identifier.'), { code: 'auth/user-not-found' })
  const auth: SeedAuth = {
    async getUserByEmail(email) {
      const found = [...users.values()].find((u) => u.email === email)
      if (!found) throw notFound()
      return { uid: found.uid }
    },
    async updateUser(uid, props) {
      const found = users.get(uid)
      if (!found) throw notFound()
      users.set(uid, { ...found, email: props.email })
      return { uid }
    },
    async createUser(props) {
      users.set(props.uid, { uid: props.uid, email: props.email, password: props.password })
      return { uid: props.uid }
    },
  }
  const bucket: SeedBucket = {
    async save(filePath, data) {
      files.set(filePath, data)
    },
  }
  return { auth, bucket, users, files }
}

import 'server-only'
import {
  AUDIT_ACTIONS,
  AUDIT_ENTITY_TYPES,
  LENDING_INTERVALS,
  LOAN_REQUEST_STATUSES,
  ROLES,
  TXN_TYPES,
  type auditLog,
  type categories,
  type loanRequestLines,
  type loanRequests,
  type productBarcodes,
  type products,
  type profiles,
  type returnWaivers,
  type sentNotifications,
  type settings,
  type staff,
  type transactionLines,
  type transactions,
} from '@/server/db/schema'
import { DEFAULT_LOCATION } from '@/server/data/catalog'

// The read-and-check half of the one-off Firestore -> PostgreSQL importer (spec section 7). planImport() reads every
// collection the app had through a FirestoreSource, maps each document to the row(s) it becomes, and lists every
// document that would not fit the PostgreSQL schema as a `problem` (a missing product, an unknown status, a duplicate
// barcode, an unparseable timestamp ...). Nothing here writes anywhere: runImport.ts does the write, and refuses a
// plan that has any problem.
//
// Rules (the full mapping table is in the Task 17 report):
//   - Firestore document ids are kept verbatim as primary keys.
//   - Append-only data (transactions, their lines, waivers, the audit log) is copied as stored; nothing is recomputed.
//     The one exception is a line or waiver written before `product_name` was copied onto it (the column is NOT NULL):
//     it gets the product's name (or the name in the product's delete entry), with a warning.
//   - quantity_on_hand is copied as stored.
//   - `line_no` (no Firestore counterpart) is each parent's scan / cart order: created_at, then document id, which is
//     the order Firestore itself returns documents with equal created_at in.
//   - Timestamps may be ISO strings with a zone (what the app wrote), Admin SDK Timestamps, Dates, or
//     {_seconds,_nanoseconds} / {seconds,nanoseconds} maps (emulator exports). Anything else is a problem.
//   - Day-only fields must be 'YYYY-MM-DD' strings and stay exactly that (never through a Date).
//   - A NOT NULL field a legacy document lacks gets the value the old app read a missing one as, everywhere it read it
//     (`p.location ?? DEFAULT_LOCATION`, `p.available ?? true`, ...), with a warning (orOldReading). Where the old app
//     had no such reading, a missing value is a problem: guessing at stock, status or people data is not safe here.
//   - Text and JSON values containing NUL, and whole numbers beyond the int4 range, are problems (PostgreSQL can't
//     store them), never raw database errors at write time.
//   - History pointing at a product Firestore no longer has is one problem per product id; with restoreDeletedProducts
//     the product is rebuilt from its `delete` audit entry instead.
//   - Every settings document is copied under its own key. Collections the app no longer has and fields without a
//     column are reported as warnings and not imported.

// --- Sources -----------------------------------------------------------------------------------------------------------

export type FirestoreData = Record<string, unknown>
export interface FirestoreDoc {
  id: string
  data: FirestoreData
}

/** Where planImport reads Firestore from. Read-only by construction: listing is all it can do. */
export interface FirestoreSource {
  list(collection: string): Promise<FirestoreDoc[]>
  /** Every top-level collection name, so collections the app no longer has can be reported. Optional. */
  listCollections?(): Promise<string[]>
}

/** A whole Firestore database as JSON: { <collection>: { <docId>: data } } (the shape of the test fixtures). */
export type FirestoreState = Record<string, Record<string, FirestoreData>>

/** An in-memory source (tests, fixture runs). Each list() returns fresh copies, so mapping can never alter the state. */
export function memorySource(state: FirestoreState): FirestoreSource {
  return {
    async list(collection) {
      return Object.entries(state[collection] ?? {}).map(([id, data]) => ({ id, data: structuredClone(data) }))
    },
    async listCollections() {
      return Object.keys(state)
    },
  }
}

/** A collection reference, as far as the importer is concerned: something a read-only transaction can get(). */
export interface ReadOnlyCollection {
  get(): Promise<{ docs: { id: string; data(): FirestoreData }[] }>
}

/** What a read-only transaction offers the importer: reading a whole collection, nothing else. */
export interface ReadOnlyTransaction {
  get(query: ReadOnlyCollection): Promise<{ docs: { id: string; data(): FirestoreData }[] }>
}

/**
 * The only Firestore calls the importer ever makes: list the top-level collection names, name a collection, and read
 * collections inside ONE read-only transaction. Typed this narrowly on purpose: no write method (add, set, update,
 * delete, batch ...) is reachable through it, and the transaction it opens is `readOnly: true`, which the server itself
 * refuses to write in. The Admin SDK's Firestore satisfies this interface.
 */
export interface ReadOnlyFirestore {
  listCollections(): Promise<{ id: string }[]>
  collection(name: string): ReadOnlyCollection
  runTransaction<T>(fn: (tx: ReadOnlyTransaction) => Promise<T>, options: { readOnly: true }): Promise<T>
}

/** A source over already-read documents, handed out as they are (no copy): the Admin SDK's own values stay intact. */
function snapshotSource(state: Map<string, FirestoreDoc[]>): FirestoreSource {
  return {
    async list(collection) {
      return [...(state.get(collection) ?? [])]
    },
    async listCollections() {
      return [...state.keys()]
    },
  }
}

/**
 * Reads every collection the importer needs (the app's, plus any other top-level collection so it can be reported) in one
 * read-only transaction, so all of them come from the same consistent snapshot: a Stock Out saved while the import reads
 * can't appear with only half of its lines. Collection names are listed first (that call is not part of a transaction;
 * a collection created in between is simply read as well, inside the snapshot). Returns an in-memory source.
 */
export async function readFirestoreSnapshot(firestore: ReadOnlyFirestore): Promise<FirestoreSource> {
  const names = new Set<string>([...IMPORTED_COLLECTIONS, ...(await firestore.listCollections()).map((c) => c.id)])
  const state = await firestore.runTransaction(
    async (tx) => {
      const out = new Map<string, FirestoreDoc[]>()
      for (const name of names) {
        const snap = await tx.get(firestore.collection(name))
        if (snap.docs.length > 0 || (IMPORTED_COLLECTIONS as readonly string[]).includes(name)) {
          out.set(name, snap.docs.map((d) => ({ id: d.id, data: d.data() })))
        }
      }
      return out
    },
    { readOnly: true },
  )
  return snapshotSource(state)
}

// --- The plan ----------------------------------------------------------------------------------------------------------

/** The Firestore collections the app had (firestore.rules + the notification markers), in the order they are read. */
export const IMPORTED_COLLECTIONS = [
  'profiles',
  'settings',
  'sent_notifications',
  'staff',
  'categories',
  'products',
  'loan_requests',
  'loan_request_lines',
  'transactions',
  'transaction_lines',
  'return_waivers',
  'audit_log',
] as const
export type ImportedCollection = (typeof IMPORTED_COLLECTIONS)[number]

export interface ImportRows {
  profiles: (typeof profiles.$inferInsert)[]
  categories: (typeof categories.$inferInsert)[]
  products: (typeof products.$inferInsert)[]
  product_barcodes: (typeof productBarcodes.$inferInsert)[]
  staff: (typeof staff.$inferInsert)[]
  loan_requests: (typeof loanRequests.$inferInsert)[]
  transactions: (typeof transactions.$inferInsert)[]
  transaction_lines: (typeof transactionLines.$inferInsert)[]
  return_waivers: (typeof returnWaivers.$inferInsert)[]
  loan_request_lines: (typeof loanRequestLines.$inferInsert)[]
  audit_log: (typeof auditLog.$inferInsert)[]
  settings: (typeof settings.$inferInsert)[]
  sent_notifications: (typeof sentNotifications.$inferInsert)[]
}
export type ImportTableName = keyof ImportRows

/** One document that does not fit (`problem`, blocks the write) or that loses or changes something (`warning`). */
export interface ImportIssue {
  collection: string
  /** The Firestore document id, or '*' for a summary over a whole collection. */
  id: string
  problem: string
}

export interface ImportPlan {
  rows: ImportRows
  /** Must be empty before anything is written. */
  problems: ImportIssue[]
  /** Reported, never blocking. */
  warnings: ImportIssue[]
  /** Documents read per imported collection. */
  sourceCounts: Record<ImportedCollection, number>
  /** Collections the app no longer has: reported, not imported. */
  notImported: { collection: string; documents: number }[]
  /** Products that history points at but Firestore no longer has, one entry per product id. */
  missingProducts: MissingProduct[]
  /** The ids of missing products rebuilt from their delete audit entry (only with restoreDeletedProducts). */
  restoredProducts: string[]
}

export interface MissingProduct {
  id: string
  /** The frozen product_name values on the lines and waivers that point at it. */
  names: string[]
  transactionLines: number
  requestLines: number
  waivers: number
  /** The newest product `delete` audit entry for it, if any. */
  deleted: { auditId: string; at: string | null; by: string | null } | null
  restored: boolean
}

// --- Value readers -----------------------------------------------------------------------------------------------------

const describe = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'a list' : typeof v === 'object' ? 'a map' : typeof v)
const isBlank = (v: unknown): boolean => typeof v === 'string' && v.trim() === ''
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|([+-])(\d{2}):?(\d{2}))$/i
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/

function validDay(y: number, m: number, d: number): boolean {
  return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m)
}

function fromSecondsNanos(seconds: unknown, nanos: unknown): Date | null {
  if (typeof seconds !== 'number' || typeof nanos !== 'number') return null
  if (!Number.isInteger(seconds) || !Number.isInteger(nanos) || nanos < 0 || nanos > 999_999_999) return null
  const d = new Date(seconds * 1000 + Math.floor(nanos / 1_000_000))
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * A Firestore timestamp in any of the shapes it reaches us in, as a Date (millisecond precision, like the ISO strings the
 * app wrote), or null when it is not one. A string must be a full ISO date-time with a zone: anything looser ('2026-09-01',
 * 'yesterday', an epoch number) is ambiguous and is refused rather than guessed at.
 */
export function parseTimestamp(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v
  if (typeof v === 'string') {
    const m = ISO_TIMESTAMP.exec(v.trim())
    if (!m) return null
    const [y, mo, d, h, mi] = [m[1], m[2], m[3], m[4], m[5]].map(Number)
    const s = m[6] ? Number(m[6]) : 0
    const ms = m[7] ? Number(m[7].padEnd(3, '0').slice(0, 3)) : 0
    if (!validDay(y, mo, d) || h > 23 || mi > 59 || s > 59) return null
    let offsetMin = 0
    if (m[8].toUpperCase() !== 'Z') {
      const oh = Number(m[10])
      const om = Number(m[11])
      if (oh > 23 || om > 59) return null
      offsetMin = (m[9] === '-' ? -1 : 1) * (oh * 60 + om)
    }
    return new Date(Date.UTC(y, mo - 1, d, h, mi, s, ms) - offsetMin * 60_000)
  }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    // The Admin SDK's Timestamp (and the client SDK's).
    if (typeof o.toDate === 'function') {
      try {
        const d = (o.toDate as () => unknown)()
        return d instanceof Date && !Number.isNaN(d.getTime()) ? d : null
      } catch {
        return null
      }
    }
    const keys = Object.keys(o).sort().join(',')
    if (keys === '_nanoseconds,_seconds') return fromSecondsNanos(o._seconds, o._nanoseconds)
    if (keys === 'nanoseconds,seconds') return fromSecondsNanos(o.seconds, o.nanoseconds)
  }
  return null
}

/** A day-only value: a real calendar day written as 'YYYY-MM-DD', returned unchanged; null otherwise. */
export function parseDay(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const m = DAY.exec(v)
  if (!m) return null
  return validDay(Number(m[1]), Number(m[2]), Number(m[3])) ? v : null
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}
const looksLikeTimestamp = (v: unknown): boolean => {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  if (typeof o.toDate === 'function') return true
  const keys = Object.keys(o).sort().join(',')
  return keys === '_nanoseconds,_seconds' || keys === 'nanoseconds,seconds'
}

/** A Firestore map/array/value as plain JSON (timestamps become ISO strings), or the path of the first value that can't be. */
/** PostgreSQL text and jsonb cannot hold U+0000. */
const NUL = '\u0000'
/** The largest value of an `integer` column (int4); every whole-number column in the schema is one. */
export const INT4_MAX = 2_147_483_647

function toJson(v: unknown, path: string): { value: unknown } | { bad: string } {
  if (typeof v === 'string' && v.includes(NUL)) return { bad: `${path} contains a NUL character, which PostgreSQL cannot store` }
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return { value: v }
  if (typeof v === 'number') return Number.isFinite(v) ? { value: v } : { bad: `${path} is ${v}, which JSON cannot hold` }
  if (v instanceof Date || looksLikeTimestamp(v)) {
    const d = parseTimestamp(v)
    return d ? { value: d.toISOString() } : { bad: `${path} is not a valid timestamp` }
  }
  if (Array.isArray(v)) {
    const out: unknown[] = []
    for (let i = 0; i < v.length; i++) {
      const r = toJson(v[i], `${path}[${i}]`)
      if ('bad' in r) return r
      out.push(r.value)
    }
    return { value: out }
  }
  if (isPlainObject(v)) {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) {
      if (x === undefined) continue
      if (k.includes(NUL)) return { bad: `${path} has a key with a NUL character, which PostgreSQL cannot store` }
      const r = toJson(x, `${path}.${k}`)
      if ('bad' in r) return r
      out[k] = r.value
    }
    return { value: out }
  }
  const kind = (v as { constructor?: { name?: string } })?.constructor?.name ?? typeof v
  return { bad: `${path} holds a ${kind} value, which cannot be stored as JSON` }
}

// --- Issue collection --------------------------------------------------------------------------------------------------

class Issues {
  problems: ImportIssue[] = []
  warnings: ImportIssue[] = []
  /** Documents with at least one problem: their rows are left out of the plan. */
  flagged = new Set<string>()
  /** collection -> field -> documents carrying a field that has no column. */
  unmapped = new Map<string, Map<string, number>>()

  problem(collection: string, id: string, problem: string) {
    this.problems.push({ collection, id, problem })
    this.flagged.add(`${collection}/${id}`)
  }
  warn(collection: string, id: string, problem: string) {
    this.warnings.push({ collection, id, problem })
  }
  isFlagged(collection: string, id: string) {
    return this.flagged.has(`${collection}/${id}`)
  }
}

/** Reads one document's fields, recording a problem for every field that does not fit and which fields were used. */
class DocReader {
  private used = new Set<string>()

  constructor(
    readonly collection: string,
    readonly id: string,
    readonly data: FirestoreData,
    private issues: Issues,
  ) {}

  problem(message: string) {
    this.issues.problem(this.collection, this.id, message)
  }
  warn(message: string) {
    this.issues.warn(this.collection, this.id, message)
  }
  raw(field: string): unknown {
    this.used.add(field)
    return this.data[field]
  }

  /** Required text. */
  text(field: string): string {
    const v = this.raw(field)
    if (v === undefined || v === null) this.problem(`${field} is missing`)
    else if (typeof v !== 'string') this.problem(`${field} should be text, found ${describe(v)}`)
    else if (v.includes(NUL)) this.problem(`${field} contains a NUL character, which PostgreSQL cannot store`)
    else return v
    return ''
  }
  /** Optional text: missing or null -> null. */
  optText(field: string): string | null {
    const v = this.raw(field)
    if (v === undefined || v === null) return null
    if (typeof v !== 'string') {
      this.problem(`${field} should be text or null, found ${describe(v)}`)
      return null
    }
    if (v.includes(NUL)) {
      this.problem(`${field} contains a NUL character, which PostgreSQL cannot store`)
      return null
    }
    return v
  }
  /** Optional text where a blank string means "none" (unique columns, where two blanks would collide). */
  optKey(field: string): string | null {
    const v = this.optText(field)
    if (v !== null && v.trim() === '') {
      this.warn(`${field} was blank; imported as none`)
      return null
    }
    return v
  }
  int(field: string, min: number): number {
    const v = this.raw(field)
    if (v === undefined || v === null) this.problem(`${field} is missing`)
    else if (typeof v !== 'number' || !Number.isInteger(v)) this.problem(`${field} should be a whole number, found ${typeof v === 'number' ? v : describe(v)}`)
    else if (v < min) this.problem(`${field} should be at least ${min}, found ${v}`)
    else if (v > INT4_MAX) this.problem(`${field} is ${v}, more than the column can hold (${INT4_MAX})`)
    else return v
    return 0
  }
  /**
   * A NOT NULL field that legacy documents may lack, where the old app read a missing value one way everywhere (e.g.
   * `p.location ?? DEFAULT_LOCATION`): missing or null -> that reading, with a warning; present -> read normally.
   */
  orOldReading<T>(field: string, reading: T, readPresent: () => T): T {
    const v = this.data[field]
    if (v === undefined || v === null) {
      this.used.add(field)
      this.warn(`${field} is missing; imported as ${JSON.stringify(reading)}, as the old app read it`)
      return reading
    }
    return readPresent()
  }
  bool(field: string): boolean {
    const v = this.raw(field)
    if (v === undefined || v === null) this.problem(`${field} is missing`)
    else if (typeof v !== 'boolean') this.problem(`${field} should be true or false, found ${describe(v)}`)
    else return v
    return false
  }
  /** Optional boolean: missing or null -> `fallback`. */
  optBool<T extends boolean | null>(field: string, fallback: T): boolean | T {
    const v = this.raw(field)
    if (v === undefined || v === null) return fallback
    if (typeof v !== 'boolean') {
      this.problem(`${field} should be true or false, found ${describe(v)}`)
      return fallback
    }
    return v
  }
  timestamp(field: string): Date {
    const v = this.raw(field)
    if (v === undefined || v === null) this.problem(`${field} is missing`)
    else {
      const d = parseTimestamp(v)
      if (d) return d
      this.problem(`${field} is not a timestamp (${JSON.stringify(v) ?? String(v)})`)
    }
    return new Date(0)
  }
  /** Optional timestamp: missing or null -> `fallback`. */
  optTimestamp(field: string, fallback: Date): Date {
    const v = this.raw(field)
    if (v === undefined || v === null) return fallback
    return this.timestamp(field)
  }
  day(field: string): string {
    const v = this.raw(field)
    if (v === undefined || v === null) {
      this.problem(`${field} is missing`)
      return ''
    }
    const d = parseDay(v)
    if (d === null) this.problem(`${field} is not a YYYY-MM-DD date (${JSON.stringify(v)})`)
    return d ?? ''
  }
  /** Optional day: missing, null or '' -> null. */
  optDay(field: string): string | null {
    const v = this.raw(field)
    if (v === undefined || v === null) return null
    if (isBlank(v)) {
      this.warn(`${field} was an empty string; imported as no date`)
      return null
    }
    return this.day(field) || null
  }
  oneOf<T extends string>(field: string, values: readonly T[]): T {
    const v = this.raw(field)
    if (v === undefined || v === null) this.problem(`${field} is missing`)
    else if (typeof v !== 'string' || !(values as readonly string[]).includes(v)) this.problem(`${field} "${String(v)}" is not one of ${values.join(', ')}`)
    else return v as T
    return values[0]
  }
  optOneOf<T extends string>(field: string, values: readonly T[]): T | null {
    const v = this.raw(field)
    if (v === undefined || v === null) return null
    return this.oneOf(field, values)
  }
  textList(field: string): string[] {
    const v = this.raw(field)
    if (v === undefined || v === null) return []
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
      this.problem(`${field} should be a list of text, found ${describe(v)}`)
      return []
    }
    if (v.some((x: string) => x.includes(NUL))) {
      this.problem(`${field} contains a NUL character, which PostgreSQL cannot store`)
      return []
    }
    return v as string[]
  }
  /** A map (or null) stored as jsonb. */
  json(field: string): Record<string, unknown> | null {
    const v = this.raw(field)
    if (v === undefined || v === null) return null
    if (!isPlainObject(v) && !looksLikeTimestamp(v)) {
      this.problem(`${field} should be a map or null, found ${describe(v)}`)
      return null
    }
    const r = toJson(v, field)
    if ('bad' in r) {
      this.problem(r.bad)
      return null
    }
    return r.value as Record<string, unknown>
  }

  /** Count every field this document has that no column took (reported once per collection and field). */
  finish() {
    let fields = this.issues.unmapped.get(this.collection)
    for (const field of Object.keys(this.data)) {
      if (this.used.has(field) || this.data[field] === undefined) continue
      if (!fields) this.issues.unmapped.set(this.collection, (fields = new Map()))
      fields.set(field, (fields.get(field) ?? 0) + 1)
    }
  }
}

// --- planImport --------------------------------------------------------------------------------------------------------

/** JavaScript string order (UTF-16 code units): the same as Firestore's document id order for the ASCII ids it generates. */
const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

export interface PlanOptions {
  /** Stamps a settings row that has no updated_at (default: now). */
  now?: Date
  /**
   * Rebuild products that history still points at but that were deleted in Firestore, from the `before` snapshot of their
   * product `delete` audit entry: unavailable, 0 in stock, no photos, created_at = the delete entry's time. Off by default.
   */
  restoreDeletedProducts?: boolean
}

export async function planImport(source: FirestoreSource, opts: PlanOptions = {}): Promise<ImportPlan> {
  const now = opts.now ?? new Date()
  const issues = new Issues()

  const docs = {} as Record<ImportedCollection, FirestoreDoc[]>
  for (const c of IMPORTED_COLLECTIONS) docs[c] = (await source.list(c)).sort(byId)
  const sourceCounts = Object.fromEntries(IMPORTED_COLLECTIONS.map((c) => [c, docs[c].length])) as Record<ImportedCollection, number>

  const notImported: ImportPlan['notImported'] = []
  if (source.listCollections) {
    const known = new Set<string>(IMPORTED_COLLECTIONS)
    for (const name of (await source.listCollections()).sort()) {
      if (!known.has(name)) notImported.push({ collection: name, documents: (await source.list(name)).length })
    }
  }

  // Every document id that exists in Firestore, per collection: a reference is checked against these (not against the
  // rows that came out clean), so one bad product doesn't also report every line that points at it.
  const ids = Object.fromEntries(IMPORTED_COLLECTIONS.map((c) => [c, new Set(docs[c].map((d) => d.id))])) as Record<ImportedCollection, Set<string>>
  const productNames = new Map(docs.products.map((d) => [d.id, d.data.name]))

  const read = <T>(collection: ImportedCollection, map: (r: DocReader) => T): { id: string; row: T }[] =>
    docs[collection].map((d) => {
      if (d.id.includes(NUL)) issues.problem(collection, d.id, 'the document id contains a NUL character, which PostgreSQL cannot store')
      const r = new DocReader(collection, d.id, d.data, issues)
      const row = map(r)
      r.finish()
      return { id: d.id, row }
    })
  const ref = (r: DocReader, field: string, value: string | null, target: ImportedCollection) => {
    if (value !== null && !ids[target].has(value)) r.problem(`${field} "${value}" is not in ${target}`)
  }

  // The newest product `delete` audit entry per product id (the old Products page wrote one, with the product as it was
  // in `before`, every time it deleted a product).
  const deleteEntries = new Map<string, { auditId: string; at: Date | null; by: string | null; before: unknown }>()
  for (const d of docs.audit_log) {
    if (d.data.entity_type !== 'product' || d.data.action !== 'delete' || typeof d.data.entity_id !== 'string') continue
    const at = parseTimestamp(d.data.created_at)
    const prev = deleteEntries.get(d.data.entity_id)
    if (prev && (!at || (prev.at && prev.at >= at))) continue
    const by = typeof d.data.user_name === 'string' ? d.data.user_name : typeof d.data.user_id === 'string' ? d.data.user_id : null
    deleteEntries.set(d.data.entity_id, { auditId: d.id, at, by, before: d.data.before })
  }

  // History that points at a product Firestore no longer has (the old app let a product with finished history be
  // deleted). Collected per product id and reported once per product below, not once per line.
  const missing = new Map<string, { transactionLines: number; requestLines: number; waivers: number; names: Set<string>; dependents: string[] }>()
  const productRef = (r: DocReader, productId: string, kind: 'transactionLines' | 'requestLines' | 'waivers') => {
    if (!productId || ids.products.has(productId)) return
    let m = missing.get(productId)
    if (!m) missing.set(productId, (m = { transactionLines: 0, requestLines: 0, waivers: 0, names: new Set(), dependents: [] }))
    m[kind]++
    if (typeof r.data.product_name === 'string' && r.data.product_name) m.names.add(r.data.product_name)
    m.dependents.push(`${r.collection}/${r.id}`)
  }

  // product_name on a line or waiver (NOT NULL). Documents from before it was copied onto them get the product's name
  // (or, for a deleted product, the name in its delete entry), with a warning.
  const snapshotName = (productId: string): string | undefined => {
    const before = deleteEntries.get(productId)?.before
    return isPlainObject(before) && typeof before.name === 'string' && before.name.trim() !== '' && !before.name.includes(NUL) ? before.name : undefined
  }
  const frozenProductName = (r: DocReader, productId: string): string => {
    const stored = r.optText('product_name')
    if (stored !== null) return stored
    const current = productNames.get(productId)
    const name = typeof current === 'string' && !current.includes(NUL) ? current : snapshotName(productId)
    if (name === undefined) {
      r.problem('product_name is missing')
      return ''
    }
    r.warn(`product_name was missing; filled with the product's name "${name}"`)
    return name
  }

  // profiles/{uid}: the role behind each BICS login (portal borrowers usually have none).
  const profileRows = read('profiles', (r) => {
    const own = r.raw('id') // the old seeds stored the uid inside the document as well
    if (own !== undefined && own !== r.id) r.warn(`id field ${JSON.stringify(own)} differs from the document id; the document id is the uid`)
    return {
      uid: r.id,
      full_name: r.text('full_name'),
      role: r.orOldReading('role', 'staff' as const, () => r.oneOf('role', ROLES)), // the old app: profile?.role ?? 'staff'
      created_at: r.timestamp('created_at'),
    }
  })

  // settings/{key} -> settings row `key` (the app reads 'notifications'; any other document is copied the same way).
  // updated_at moves to the row's own column, as the app's own saves keep it; every other field is the stored value.
  const settingRows: ImportRows['settings'] = []
  for (const d of docs.settings) {
    if (d.id.includes(NUL)) {
      issues.problem('settings', d.id, 'the document id contains a NUL character, which PostgreSQL cannot store')
      continue
    }
    const { updated_at: rawUpdated, ...rest } = d.data
    let updatedAt = now
    if (rawUpdated === undefined || rawUpdated === null) issues.warn('settings', d.id, 'updated_at is missing; set to the time of the import')
    else {
      const parsed = parseTimestamp(rawUpdated)
      if (parsed) updatedAt = parsed
      else issues.problem('settings', d.id, `updated_at is not a timestamp (${JSON.stringify(rawUpdated)})`)
    }
    const value = toJson(rest, 'value')
    if ('bad' in value) issues.problem('settings', d.id, value.bad)
    else if (!issues.isFlagged('settings', d.id)) settingRows.push({ key: d.id, value: value.value as Record<string, unknown>, updated_at: updatedAt })
  }

  // sent_notifications/{dedupeKey}: "this email was already sent" markers, so cut-over doesn't send them again.
  const markerRows = read('sent_notifications', (r) => ({
    key: r.id,
    toggle: r.text('toggle'),
    entity_id: r.optText('entity_id'),
    created_at: r.timestamp('created_at'),
  }))

  const staffRows = read('staff', (r) => {
    const createdAt = r.timestamp('created_at')
    return {
      id: r.id,
      name: r.text('name'),
      surname: r.text('surname'),
      full_name: r.text('full_name'),
      email: r.optKey('email'),
      department: r.optText('department'),
      card_uid: r.optKey('card_uid'),
      // Missing read as inactive: Stock Out / Returns only list is_active == true, the Staff page shows "Deactivated",
      // and the portal turns a staff member without it away.
      is_active: r.orOldReading('is_active', false, () => r.bool('is_active')),
      uid: r.optKey('uid'),
      // Absent by design (the type: "Never set on an ordinary staff member's record"), read as false: no warning.
      is_admin_account: r.optBool('is_admin_account', false),
      created_at: createdAt,
      updated_at: r.timestamp('updated_at'),
    }
  })

  const categoryRows = read('categories', (r) => ({
    id: r.id,
    name: r.text('name'),
    description: r.optText('description'),
    created_at: r.timestamp('created_at'),
  }))

  const barcodeRows: { id: string; row: ImportRows['product_barcodes'][number] }[] = []
  const productRows = read('products', (r) => {
    const createdAt = r.timestamp('created_at')
    const categoryId = r.optText('category_id')
    ref(r, 'category_id', categoryId, 'categories')

    // barcodes[] (in saved order; [0] is the primary), or the pre-multi-barcode single `barcode` field. When both exist
    // the old app showed and saved barcodes[] only (productBarcodes() on the Products page), so that list wins.
    const legacy = r.raw('barcode')
    const list = r.raw('barcodes')
    let codes: string[] = []
    if (list !== undefined && list !== null) {
      codes = r.textList('barcodes')
      if (typeof legacy === 'string' && legacy.trim() !== '' && !codes.includes(legacy)) {
        r.warn(`legacy barcode "${legacy}" ignored: the product has barcodes[], which the old app showed and saved instead`)
      }
    } else if (legacy !== undefined && legacy !== null) {
      if (typeof legacy !== 'string') r.problem(`barcode should be text, found ${describe(legacy)}`)
      else codes = [legacy]
    }
    const seen = new Set<string>()
    for (const code of codes) {
      if (code.trim() === '') r.warn('a blank barcode was skipped')
      else if (seen.has(code)) r.warn(`barcode "${code}" is listed twice on this product; imported once`)
      else {
        seen.add(code)
        barcodeRows.push({ id: r.id, row: { barcode: code, product_id: r.id, position: seen.size - 1 } })
      }
    }
    if (seen.size === 0) r.warn('the product has no barcode')

    return {
      id: r.id,
      category_id: categoryId,
      category_name: r.optText('category_name'),
      name: r.text('name'),
      description: r.optText('description'),
      // As stored, never recomputed. The old app read a missing count / threshold as 0, a missing `available` as true
      // and a missing location as DEFAULT_LOCATION (Products page, Dashboard, alerts).
      quantity_on_hand: r.orOldReading('quantity_on_hand', 0, () => r.int('quantity_on_hand', 0)),
      reorder_threshold: r.orOldReading('reorder_threshold', 0, () => r.int('reorder_threshold', 0)),
      available: r.orOldReading('available', true, () => r.bool('available')),
      location: r.orOldReading('location', DEFAULT_LOCATION, () => r.text('location')),
      lend_from: r.optDay('lend_from'),
      lend_to: r.optDay('lend_to'),
      lending_interval: r.optOneOf('lending_interval', LENDING_INTERVALS), // absent on old products; the app reads null as week_1
      images: r.orOldReading('images', [] as string[], () => r.textList('images')),
      created_at: createdAt,
      updated_at: r.timestamp('updated_at'),
    }
  })

  const requestRows = read('loan_requests', (r) => {
    const staffId = r.text('staff_id')
    ref(r, 'staff_id', staffId || null, 'staff')
    const fulfilled = r.optText('fulfilled_txn_id')
    ref(r, 'fulfilled_txn_id', fulfilled, 'transactions')
    const fromDate = r.day('from_date')
    return {
      id: r.id,
      reference_no: r.optKey('reference_no'), // optional: requests from before LR- references have none
      staff_id: staffId,
      staff_name: r.text('staff_name'),
      status: r.oneOf('status', LOAN_REQUEST_STATUSES),
      message: r.optText('message'),
      admin_message: r.optText('admin_message'),
      from_date: fromDate,
      to_date: r.optDay('to_date'),
      // the old counter email: request.original_from_date ?? fromDate
      original_from_date: r.orOldReading('original_from_date', fromDate, () => r.day('original_from_date')),
      original_to_date: r.optDay('original_to_date'),
      fulfilled_txn_id: fulfilled,
      created_at: r.timestamp('created_at'),
      updated_at: r.timestamp('updated_at'), // expiry is computed from it: never guessed
    }
  })

  const requestLineRows = read('loan_request_lines', (r) => {
    const requestId = r.text('request_id')
    ref(r, 'request_id', requestId || null, 'loan_requests')
    const productId = r.text('product_id')
    productRef(r, productId, 'requestLines')
    return {
      id: r.id,
      request_id: requestId,
      product_id: productId,
      product_name: frozenProductName(r, productId),
      line_no: 0, // set below
      // the old Dashboard / Audit Log: `?? 0` (0 offered = the line was dropped in a counter)
      requested_quantity: r.orOldReading('requested_quantity', 0, () => r.int('requested_quantity', 0)),
      offered_quantity: r.orOldReading('offered_quantity', 0, () => r.int('offered_quantity', 0)),
      created_at: r.timestamp('created_at'),
    }
  })

  const txnRows = read('transactions', (r) => {
    const staffId = r.optText('staff_id')
    ref(r, 'staff_id', staffId, 'staff')
    const linkedTxn = r.optText('linked_txn_id')
    ref(r, 'linked_txn_id', linkedTxn, 'transactions')
    const linkedRequest = r.optText('linked_request_id')
    ref(r, 'linked_request_id', linkedRequest, 'loan_requests')
    return {
      id: r.id,
      transaction_type: r.oneOf('transaction_type', TXN_TYPES),
      reference_no: r.text('reference_no'),
      staff_id: staffId,
      staff_name: r.optText('staff_name'),
      user_id: r.optText('user_id'),
      operator_name: r.optText('operator_name'),
      notes: r.optText('notes'),
      return_date: r.optDay('return_date'),
      linked_txn_id: linkedTxn,
      manual_override: r.optBool('manual_override', null), // absent on Stock In / Adjust documents: stays absent (null)
      lend_from: r.optDay('lend_from'),
      lend_to: r.optDay('lend_to'),
      linked_request_id: linkedRequest,
      linked_request_ref: r.optText('linked_request_ref'),
      created_at: r.timestamp('created_at'),
    }
  })

  const lineRows = read('transaction_lines', (r) => {
    const txnId = r.text('transaction_id')
    ref(r, 'transaction_id', txnId || null, 'transactions')
    const productId = r.text('product_id')
    productRef(r, productId, 'transactionLines')
    const productName = frozenProductName(r, productId)
    // Every writer stored unit_cost (always 0) and nothing read it, so there is no old reading to fall back on.
    const unitCost = r.raw('unit_cost')
    if (unitCost === undefined || unitCost === null) r.problem('unit_cost is missing')
    else if (typeof unitCost !== 'number' || !Number.isFinite(unitCost)) r.problem(`unit_cost should be a number, found ${describe(unitCost)}`)
    return {
      id: r.id,
      transaction_id: txnId,
      product_id: productId,
      product_name: productName,
      barcode: r.optText('barcode'), // absent on lines from before barcode capture
      issued_barcode: r.optText('issued_barcode'),
      line_no: 0, // set below
      quantity: r.int('quantity', 1),
      unit_cost: typeof unitCost === 'number' && Number.isFinite(unitCost) ? unitCost : 0,
      created_at: r.timestamp('created_at'),
    }
  })

  const waiverRows = read('return_waivers', (r) => {
    const txnId = r.text('transaction_id')
    ref(r, 'transaction_id', txnId || null, 'transactions')
    const productId = r.text('product_id')
    productRef(r, productId, 'waivers')
    const staffId = r.optText('staff_id')
    ref(r, 'staff_id', staffId, 'staff')
    return {
      id: r.id,
      transaction_id: txnId,
      product_id: productId,
      product_name: frozenProductName(r, productId),
      staff_id: staffId,
      staff_name: r.optText('staff_name'),
      quantity: r.int('quantity', 1),
      reason: r.optText('reason'),
      created_at: r.timestamp('created_at'),
      resolved_by_uid: r.optText('resolved_by_uid'),
      resolved_by_name: r.optText('resolved_by_name'),
    }
  })

  const auditRows = read('audit_log', (r) => ({
    id: r.id,
    user_id: r.optText('user_id'),
    user_name: r.optText('user_name'),
    action: r.oneOf('action', AUDIT_ACTIONS),
    entity_type: r.oneOf('entity_type', AUDIT_ENTITY_TYPES),
    entity_id: r.text('entity_id'),
    before: r.json('before'),
    after: r.json('after'),
    created_at: r.timestamp('created_at'),
  }))

  // --- Unique columns Firestore never enforced: the first document in id order keeps the value. A document that already
  // has a problem is left out of these checks (its values may be placeholders), but one duplicate doesn't hide another.
  const flaggedBefore = new Set(issues.flagged)
  const skip = (collection: string, id: string) => flaggedBefore.has(`${collection}/${id}`)
  const unique = <T>(
    collection: ImportedCollection,
    rows: { id: string; row: T }[],
    keyOf: (row: T) => string | null | undefined,
    message: (value: string, firstId: string) => string,
    shown: (row: T) => string = (row) => keyOf(row) as string,
  ) => {
    const firstBy = new Map<string, string>()
    for (const { id, row } of rows) {
      const key = keyOf(row)
      if (key === null || key === undefined || skip(collection, id)) continue
      const first = firstBy.get(key)
      if (first === undefined) firstBy.set(key, id)
      else issues.problem(collection, id, message(shown(row), first))
    }
  }
  unique('categories', categoryRows, (c) => c.name, (v, first) => `name "${v}" is also used by category ${first}`)
  unique('staff', staffRows, (s) => s.email?.toLowerCase(), (v, first) => `email "${v}" is also used by staff ${first} (emails are unique in any letter case)`, (s) => s.email as string)
  unique('staff', staffRows, (s) => s.card_uid, (v, first) => `card_uid "${v}" is also used by staff ${first}`)
  unique('staff', staffRows, (s) => s.uid, (v, first) => `uid "${v}" is also used by staff ${first}`)
  unique('transactions', txnRows, (t) => t.reference_no, (v, first) => `reference_no "${v}" is also used by transaction ${first}`)
  unique('loan_requests', requestRows, (q) => q.reference_no, (v, first) => `reference_no "${v}" is also used by loan request ${first}`)
  const productName = new Map<string, string>(productRows.map((p) => [p.id, p.row.name]))
  const barcodeOwner = new Map<string, string>()
  for (const { id, row } of barcodeRows) {
    if (skip('products', id)) continue
    const owner = barcodeOwner.get(row.barcode)
    if (owner === undefined) barcodeOwner.set(row.barcode, id)
    else if (owner !== id) issues.problem('products', id, `barcode "${row.barcode}" is also on product ${owner} (${productName.get(owner)})`)
  }

  // --- Deleted products that history still points at: one grouped problem each, or (opt-in) restored. ---
  const restoredProducts: string[] = []
  const restoredRows: ImportRows['products'] = []
  const missingProducts: MissingProduct[] = []
  const text = (v: unknown): string | null => (typeof v === 'string' && !v.includes(NUL) ? v : null)
  for (const id of [...missing.keys()].sort()) {
    const m = missing.get(id)!
    const del = deleteEntries.get(id)
    const deleted = del ? { auditId: del.auditId, at: del.at?.toISOString() ?? null, by: del.by } : null
    let refusal: string | null = null
    if (opts.restoreDeletedProducts && del) {
      const before = del.before
      if (!isPlainObject(before)) refusal = `its delete entry ${del.auditId} has no product snapshot`
      else if (!del.at) refusal = `its delete entry ${del.auditId} has no valid created_at`
      else {
        const name = snapshotName(id) ?? [...m.names][0]
        const categoryId = text(before.category_id)
        if (categoryId !== null && !ids.categories.has(categoryId)) {
          issues.warn('products', id, `category_id "${categoryId}" of the deleted product no longer exists; restored without a category`)
        }
        const threshold = before.reorder_threshold
        restoredRows.push({
          id,
          category_id: categoryId !== null && ids.categories.has(categoryId) ? categoryId : null,
          category_name: text(before.category_name),
          name: name ?? id,
          description: text(before.description),
          quantity_on_hand: 0,
          reorder_threshold: typeof threshold === 'number' && Number.isInteger(threshold) && threshold >= 0 && threshold <= INT4_MAX ? threshold : 0,
          available: false,
          location: text(before.location) ?? DEFAULT_LOCATION,
          lend_from: null,
          lend_to: null,
          lending_interval: null,
          images: [], // its photos were deleted from Storage with it
          created_at: del.at,
          updated_at: del.at,
        })
        const codes = Array.isArray(before.barcodes) ? before.barcodes : []
        let position = 0
        for (const code of codes) {
          if (typeof code !== 'string' || code.trim() === '' || code.includes(NUL)) continue
          const owner = barcodeOwner.get(code)
          if (owner !== undefined) {
            issues.warn('products', id, `barcode "${code}" of the deleted product is now on product ${owner} (${productName.get(owner) ?? 'restored'}); not restored`)
            continue
          }
          barcodeOwner.set(code, id)
          barcodeRows.push({ id, row: { barcode: code, product_id: id, position: position++ } })
        }
        restoredProducts.push(id)
        issues.warn(
          'products',
          id,
          `RESTORED from delete audit entry ${del.auditId} (deleted ${del.at.toISOString()} by ${del.by ?? 'unknown'}): "${name ?? id}", unavailable, 0 in stock, no photos`,
        )
      }
    }
    const restored = restoredProducts.includes(id)
    missingProducts.push({ id, names: [...m.names], transactionLines: m.transactionLines, requestLines: m.requestLines, waivers: m.waivers, deleted, restored })
    if (restored) continue
    const names = m.names.size > 0 ? [...m.names].map((n) => `"${n}"`).join(', ') : 'no name on the lines'
    const refs = `${plural(m.transactionLines, 'transaction line')}, ${plural(m.requestLines, 'loan request line')} and ${plural(m.waivers, 'waiver')}`
    const how = !deleted
      ? 'there is no delete entry for it in the audit log, so it cannot be restored automatically'
      : refusal
        ? `deleted ${deleted.at ?? '(unknown time)'} by ${deleted.by ?? 'unknown'}, but it cannot be restored: ${refusal}`
        : `deleted ${deleted.at ?? '(unknown time)'} by ${deleted.by ?? 'unknown'} (audit entry ${deleted.auditId}); --restore-deleted-products would restore it as an unavailable product with 0 in stock`
    issues.problem('products', id, `missing product (${names}) is still referenced by ${refs}; ${how}`)
    for (const dep of m.dependents) issues.flagged.add(dep) // already counted in this one problem
  }

  // --- linked_txn_id must not loop (the self-reference is not deferrable: parents are inserted before children). ---
  const linkOf = new Map(txnRows.map((t) => [t.id, t.row.linked_txn_id ?? null]))
  const reportedLoops = new Set<string>()
  for (const start of linkOf.keys()) {
    const path: string[] = []
    const onPath = new Set<string>()
    let cur: string | null = start
    while (cur !== null && linkOf.has(cur) && !onPath.has(cur)) {
      path.push(cur)
      onPath.add(cur)
      cur = linkOf.get(cur) ?? null
    }
    if (cur === null || !onPath.has(cur)) continue
    const loop = path.slice(path.indexOf(cur))
    const first = [...loop].sort()[0]
    if (reportedLoops.has(first)) continue
    reportedLoops.add(first)
    const from = loop.indexOf(first)
    const ordered = [...loop.slice(from), ...loop.slice(0, from), first]
    issues.problem('transactions', first, `linked_txn_id makes a loop (${ordered.join(' -> ')})`)
  }

  // --- line_no: each parent's lines in created_at, then id order. ---
  const numberLines = <T extends { created_at: Date; line_no: number }>(rows: { id: string; row: T }[], parentOf: (row: T) => string) => {
    const byParent = new Map<string, { id: string; row: T }[]>()
    for (const entry of rows) {
      const list = byParent.get(parentOf(entry.row)) ?? []
      list.push(entry)
      byParent.set(parentOf(entry.row), list)
    }
    for (const list of byParent.values()) {
      list.sort((a, b) => a.row.created_at.getTime() - b.row.created_at.getTime() || byId(a, b))
      list.forEach((entry, i) => (entry.row.line_no = i))
    }
  }
  numberLines(lineRows, (l) => l.transaction_id)
  numberLines(requestLineRows, (l) => l.request_id)

  // --- fields without a column: one warning per collection and field ---
  for (const [collection, fields] of issues.unmapped) {
    for (const [field, n] of fields) {
      issues.warn(collection, '*', `field "${field}" (${plural(n, 'document')}) has no column; not imported`)
    }
  }

  const clean = <T>(collection: ImportedCollection, rows: { id: string; row: T }[]): T[] =>
    rows.filter((r) => !issues.isFlagged(collection, r.id)).map((r) => r.row)

  return {
    rows: {
      profiles: clean('profiles', profileRows),
      categories: clean('categories', categoryRows),
      products: [...clean('products', productRows), ...restoredRows],
      product_barcodes: clean('products', barcodeRows),
      staff: clean('staff', staffRows),
      loan_requests: clean('loan_requests', requestRows),
      transactions: clean('transactions', txnRows),
      transaction_lines: clean('transaction_lines', lineRows),
      return_waivers: clean('return_waivers', waiverRows),
      loan_request_lines: clean('loan_request_lines', requestLineRows),
      audit_log: clean('audit_log', auditRows),
      settings: settingRows,
      sent_notifications: clean('sent_notifications', markerRows),
    },
    problems: issues.problems,
    warnings: issues.warnings,
    sourceCounts,
    notImported,
    missingProducts,
    restoredProducts,
  }
}

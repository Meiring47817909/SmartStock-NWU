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
import { NOTIFICATION_SETTINGS_KEY } from '@/lib/notificationSettingsRules'

// The read-and-check half of the one-off Firestore -> PostgreSQL importer (spec section 7). planImport() reads every
// collection the app had through a FirestoreSource, maps each document to the row(s) it becomes, and lists every
// document that would not fit the PostgreSQL schema as a `problem` (a missing product, an unknown status, a duplicate
// barcode, an unparseable timestamp ...). Nothing here writes anywhere: runImport.ts does the write, and refuses a
// plan that has any problem.
//
// Rules (the full mapping table is in the Task 17 report):
//   - Firestore document ids are kept verbatim as primary keys.
//   - Append-only data (transactions, their lines, waivers, the audit log) is copied as stored; nothing is recomputed.
//     The one exception is a transaction line written before lines carried `product_name` (the type marks it optional,
//     the column is NOT NULL): it gets the product's name, with a warning.
//   - quantity_on_hand is copied as stored.
//   - `line_no` (no Firestore counterpart) is each parent's scan / cart order: created_at, then document id, which is
//     the order Firestore itself returns documents with equal created_at in.
//   - Timestamps may be ISO strings with a zone (what the app wrote), Admin SDK Timestamps, Dates, or
//     {_seconds,_nanoseconds} / {seconds,nanoseconds} maps (emulator exports). Anything else is a problem.
//   - Day-only fields must be 'YYYY-MM-DD' strings and stay exactly that (never through a Date).
//   - A field the old app's types marked optional gets the default the app reads it as (documented per field below);
//     a field it required that is missing is a problem: guessing at stock, status or people data is not safe here.
//   - Collections the app no longer has, settings documents it does not read and fields without a column are reported
//     as warnings and not imported.

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

/**
 * The only two Firestore calls the importer ever makes: list the top-level collections, and get() a whole collection.
 * Typed this narrowly on purpose: no write method (add, set, update, delete, batch, runTransaction ...) is reachable
 * through it, so the live source is read-only by construction, not by convention. The Admin SDK's Firestore satisfies
 * this interface.
 */
export interface ReadOnlyFirestore {
  listCollections(): Promise<{ id: string }[]>
  collection(name: string): { get(): Promise<{ docs: { id: string; data(): FirestoreData }[] }> }
}

export function firestoreSource(firestore: ReadOnlyFirestore): FirestoreSource {
  return {
    async list(collection) {
      const snap = await firestore.collection(collection).get()
      return snap.docs.map((d) => ({ id: d.id, data: d.data() }))
    },
    async listCollections() {
      return (await firestore.listCollections()).map((c) => c.id)
    },
  }
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
function toJson(v: unknown, path: string): { value: unknown } | { bad: string } {
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
    else return v
    return 0
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

export async function planImport(source: FirestoreSource, opts: { now?: Date } = {}): Promise<ImportPlan> {
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
      const r = new DocReader(collection, d.id, d.data, issues)
      const row = map(r)
      r.finish()
      return { id: d.id, row }
    })
  const ref = (r: DocReader, field: string, value: string | null, target: ImportedCollection) => {
    if (value !== null && !ids[target].has(value)) r.problem(`${field} "${value}" is not in ${target}`)
  }

  // profiles/{uid}: the role behind each BICS login (portal borrowers usually have none).
  const profileRows = read('profiles', (r) => {
    const own = r.raw('id') // the old seeds stored the uid inside the document as well
    if (own !== undefined && own !== r.id) r.warn(`id field ${JSON.stringify(own)} differs from the document id; the document id is the uid`)
    return { uid: r.id, full_name: r.text('full_name'), role: r.oneOf('role', ROLES), created_at: r.timestamp('created_at') }
  })

  // settings/notifications -> settings key 'notifications' (the only settings document the app reads). updated_at moves
  // to the row's own column, as the app's own saves keep it; every other field is the stored value, as it was.
  const settingRows: ImportRows['settings'] = []
  for (const d of docs.settings) {
    if (d.id !== NOTIFICATION_SETTINGS_KEY) {
      issues.warn('settings', d.id, `settings document "${d.id}" is not read by the app; not imported`)
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
      is_active: r.bool('is_active'),
      uid: r.optKey('uid'),
      is_admin_account: r.optBool('is_admin_account', false), // optional in the type: only the admin's own record has it
      created_at: createdAt,
      updated_at: r.optTimestamp('updated_at', createdAt),
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
      quantity_on_hand: r.int('quantity_on_hand', 0), // as stored, never recomputed
      reorder_threshold: r.int('reorder_threshold', 0),
      available: r.bool('available'),
      location: r.optText('location') ?? '',
      lend_from: r.optDay('lend_from'),
      lend_to: r.optDay('lend_to'),
      lending_interval: r.optOneOf('lending_interval', LENDING_INTERVALS), // absent on old products; the app reads null as week_1
      images: r.textList('images'),
      created_at: createdAt,
      updated_at: r.optTimestamp('updated_at', createdAt),
    }
  })

  const requestRows = read('loan_requests', (r) => {
    const staffId = r.text('staff_id')
    ref(r, 'staff_id', staffId || null, 'staff')
    const fulfilled = r.optText('fulfilled_txn_id')
    ref(r, 'fulfilled_txn_id', fulfilled, 'transactions')
    return {
      id: r.id,
      reference_no: r.optKey('reference_no'), // optional: requests from before LR- references have none
      staff_id: staffId,
      staff_name: r.text('staff_name'),
      status: r.oneOf('status', LOAN_REQUEST_STATUSES),
      message: r.optText('message'),
      admin_message: r.optText('admin_message'),
      from_date: r.day('from_date'),
      to_date: r.optDay('to_date'),
      original_from_date: r.day('original_from_date'),
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
    ref(r, 'product_id', productId || null, 'products')
    return {
      id: r.id,
      request_id: requestId,
      product_id: productId,
      product_name: r.text('product_name'),
      line_no: 0, // set below
      requested_quantity: r.int('requested_quantity', 0),
      offered_quantity: r.int('offered_quantity', 0), // 0 = the line was dropped in a counter
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
    ref(r, 'product_id', productId || null, 'products')
    let productName = r.optText('product_name')
    if (productName === null) {
      // Lines from before product_name was denormalised onto them: the name the old app looked up to show them.
      const current = productNames.get(productId)
      if (typeof current === 'string') {
        productName = current
        r.warn(`product_name was missing; filled with the product's name "${current}"`)
      } else {
        r.problem('product_name is missing')
      }
    }
    const unitCost = r.raw('unit_cost')
    if (unitCost !== undefined && unitCost !== null && (typeof unitCost !== 'number' || !Number.isFinite(unitCost))) {
      r.problem(`unit_cost should be a number, found ${describe(unitCost)}`)
    }
    return {
      id: r.id,
      transaction_id: txnId,
      product_id: productId,
      product_name: productName ?? '',
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
    ref(r, 'product_id', productId || null, 'products')
    const staffId = r.optText('staff_id')
    ref(r, 'staff_id', staffId, 'staff')
    return {
      id: r.id,
      transaction_id: txnId,
      product_id: productId,
      product_name: r.text('product_name'),
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
  const productName = new Map(productRows.map((p) => [p.id, p.row.name]))
  const barcodeOwner = new Map<string, string>()
  for (const { id, row } of barcodeRows) {
    if (skip('products', id)) continue
    const owner = barcodeOwner.get(row.barcode)
    if (owner === undefined) barcodeOwner.set(row.barcode, id)
    else if (owner !== id) issues.problem('products', id, `barcode "${row.barcode}" is also on product ${owner} (${productName.get(owner)})`)
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
      products: clean('products', productRows),
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
  }
}

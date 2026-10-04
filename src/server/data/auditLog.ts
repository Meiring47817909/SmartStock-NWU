import 'server-only'
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { assertAdmin, DataError, type Ctx } from '@/server/context'
import { toIso } from '@/server/db/client'
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES, auditLog, loanRequestLines, transactionLines } from '@/server/db/schema'
import { appDayBetween, parseDay } from '@/server/data/dayRange'
import type { AuditLogPage, AuditLogParams } from '@/lib/reportRules'
import type { AuditAction, AuditEntityType, AuditLogEntry, LoanRequestLine, TransactionLine } from '@/types/database'

// The read side of the audit log (the write side is audit.ts, called inside each save's transaction). Admin only.
//
// Newest first, in pages of AUDIT_PAGE_SIZE entries (a response with every entry's before/after JSON is unbounded, and a
// serverless response is capped at a few MB). A page ends with a cursor on (created_at, id), the sort key, so the next page
// starts exactly after the last entry sent: nothing is repeated or skipped, even when entries share a timestamp or are
// written between two requests. The cursor carries the timestamp at the database's microsecond precision. Filters apply in
// every page. A date filter picks calendar days in Africa/Johannesburg, both ends inclusive: an entry written at 23:30
// UTC belongs to the next day (dayRange.ts). Names (`user_name`) are kept as stored on the entry, never looked up again.
//
// The page shows a transaction's items, and a loan request's items on its 'create' entry, from the entry's own frozen
// copy when there is one. Older entries have none, so their lines are looked up here, in one query per kind, instead of
// one request per row the admin opens.

/** Entries per page of GET /api/audit-log. */
export const AUDIT_PAGE_SIZE = 500

const CHUNK = 5000
const CURSOR_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/

function encodeCursor(ts: string, id: string): string {
  return Buffer.from(JSON.stringify([ts, id])).toString('base64url')
}

function decodeCursor(cursor: string): { ts: string; id: string } {
  try {
    const [ts, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown[]
    if (typeof ts === 'string' && CURSOR_TS.test(ts) && typeof id === 'string' && id) return { ts, id }
  } catch {
    // fall through
  }
  throw new DataError(400, 'Invalid cursor.')
}

function list(value: string | string[] | undefined): string[] {
  if (value === undefined || value === '') return []
  return (Array.isArray(value) ? value : value.split(',')).map((v) => v.trim()).filter(Boolean)
}

function checked<T extends string>(values: string[], allowed: readonly T[], label: string): T[] {
  for (const v of values) if (!(allowed as readonly string[]).includes(v)) throw new DataError(400, `Unknown ${label}.`)
  return values as T[]
}

async function inChunks<T>(ids: string[], read: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = []
  for (let i = 0; i < ids.length; i += CHUNK) out.push(...(await read(ids.slice(i, i + CHUNK))))
  return out
}

/** One page of the log (`limit` entries; the default is the API's page size, a smaller one is for tests). */
export async function listAuditLog(ctx: Ctx, opts: AuditLogParams = {}, limit: number = AUDIT_PAGE_SIZE): Promise<AuditLogPage> {
  assertAdmin(ctx)
  const from = parseDay(opts.from, 'From')
  const to = parseDay(opts.to, 'To')
  const entityTypes = checked<AuditEntityType>(list(opts.entityType), AUDIT_ENTITY_TYPES, 'entity type')
  const actions = checked<AuditAction>(list(opts.action), AUDIT_ACTIONS, 'action')
  const start = opts.cursor ? decodeCursor(opts.cursor) : null

  const fetched = await ctx.db
    .select({
      row: auditLog,
      ts: sql<string>`to_char(${auditLog.created_at} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    })
    .from(auditLog)
    .where(
      and(
        start ? sql`(${auditLog.created_at}, ${auditLog.id}) < (${start.ts}::timestamptz, ${start.id})` : undefined,
        appDayBetween(auditLog.created_at, from, to),
        entityTypes.length > 0 ? inArray(auditLog.entity_type, entityTypes) : undefined,
        actions.length > 0 ? inArray(auditLog.action, actions) : undefined,
        opts.userId ? eq(auditLog.user_id, opts.userId) : undefined,
      ),
    )
    .orderBy(desc(auditLog.created_at), desc(auditLog.id))
    .limit(limit + 1)

  const more = fetched.length > limit
  const pageRows = more ? fetched.slice(0, limit) : fetched
  const rows = pageRows.map((f) => f.row)
  const last = pageRows[pageRows.length - 1]
  const nextCursor = more ? encodeCursor(last.ts, last.row.id) : null

  const entries: AuditLogEntry[] = rows.map((r) => ({
    id: r.id,
    user_id: r.user_id,
    user_name: r.user_name,
    action: r.action,
    entity_type: r.entity_type,
    entity_id: r.entity_id,
    before: r.before,
    after: r.after,
    created_at: toIso(r.created_at) as string,
  }))

  // Which entries of this page the browser will ask for lines. A resolve entry carries the waiver's fields, not a transaction's, so it
  // shows none; an entry whose payload froze its `lines` needs no lookup.
  const hasFrozenLines = (e: AuditLogEntry) => Array.isArray(e.after?.lines)
  const txnIds = [...new Set(entries.filter((e) => e.entity_type === 'transaction' && e.action !== 'resolve' && !hasFrozenLines(e)).map((e) => e.entity_id))]
  const requestIds = [...new Set(entries.filter((e) => e.entity_type === 'loan_request' && e.before === null && !hasFrozenLines(e)).map((e) => e.entity_id))]

  const transactionLinesById: Record<string, TransactionLine[]> = Object.fromEntries(txnIds.map((id) => [id, []]))
  const txnLines = await inChunks(txnIds, (chunk) =>
    ctx.db
      .select()
      .from(transactionLines)
      .where(inArray(transactionLines.transaction_id, chunk))
      .orderBy(asc(transactionLines.transaction_id), asc(transactionLines.line_no), asc(transactionLines.id)),
  )
  for (const l of txnLines) {
    transactionLinesById[l.transaction_id].push({
      id: l.id,
      transaction_id: l.transaction_id,
      product_id: l.product_id,
      product_name: l.product_name,
      barcode: l.barcode,
      issued_barcode: l.issued_barcode,
      quantity: l.quantity,
      unit_cost: l.unit_cost,
      created_at: toIso(l.created_at) as string,
    })
  }

  const loanRequestLinesById: Record<string, LoanRequestLine[]> = Object.fromEntries(requestIds.map((id) => [id, []]))
  const reqLines = await inChunks(requestIds, (chunk) =>
    ctx.db
      .select()
      .from(loanRequestLines)
      .where(inArray(loanRequestLines.request_id, chunk))
      .orderBy(asc(loanRequestLines.request_id), asc(loanRequestLines.line_no), asc(loanRequestLines.id)),
  )
  for (const l of reqLines) {
    loanRequestLinesById[l.request_id].push({
      id: l.id,
      request_id: l.request_id,
      product_id: l.product_id,
      product_name: l.product_name,
      requested_quantity: l.requested_quantity,
      offered_quantity: l.offered_quantity,
      created_at: toIso(l.created_at) as string,
    })
  }

  return { entries, transactionLines: transactionLinesById, loanRequestLines: loanRequestLinesById, nextCursor }
}

import 'server-only'
import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import { assertAdmin, DataError, type Ctx } from '@/server/context'
import { toIso } from '@/server/db/client'
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES, auditLog, loanRequestLines, transactionLines } from '@/server/db/schema'
import { appDayBetween, parseDay } from '@/server/data/dayRange'
import type { AuditLogParams, AuditLogResult } from '@/lib/reportRules'
import type { AuditAction, AuditEntityType, AuditLogEntry, LoanRequestLine, TransactionLine } from '@/types/database'

// The read side of the audit log (the write side is audit.ts, called inside each save's transaction). Admin only.
//
// Newest first. A date filter picks calendar days in Africa/Johannesburg, both ends inclusive: an entry written at 23:30
// UTC belongs to the next day (dayRange.ts). Names (`user_name`) are kept as stored on the entry, never looked up again.
//
// The page shows a transaction's items, and a loan request's items on its 'create' entry, from the entry's own frozen
// copy when there is one. Older entries have none, so their lines are looked up here, in one query per kind, instead of
// one request per row the admin opens.

const CHUNK = 5000

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

export async function listAuditLog(ctx: Ctx, opts: AuditLogParams = {}): Promise<AuditLogResult> {
  assertAdmin(ctx)
  const from = parseDay(opts.from, 'From')
  const to = parseDay(opts.to, 'To')
  const entityTypes = checked<AuditEntityType>(list(opts.entityType), AUDIT_ENTITY_TYPES, 'entity type')
  const actions = checked<AuditAction>(list(opts.action), AUDIT_ACTIONS, 'action')

  const rows = await ctx.db
    .select()
    .from(auditLog)
    .where(
      and(
        appDayBetween(auditLog.created_at, from, to),
        entityTypes.length > 0 ? inArray(auditLog.entity_type, entityTypes) : undefined,
        actions.length > 0 ? inArray(auditLog.action, actions) : undefined,
        opts.userId ? eq(auditLog.user_id, opts.userId) : undefined,
      ),
    )
    .orderBy(desc(auditLog.created_at), desc(auditLog.id))

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

  // Which entries the page will ask for lines. A resolve entry carries the waiver's fields, not a transaction's, so it
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

  return { entries, transactionLines: transactionLinesById, loanRequestLines: loanRequestLinesById }
}

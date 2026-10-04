// Browser client for the Audit Log API (admin), newest entry first.
//   GET /api/audit-log[?from=…][&to=…][&entityType=a,b][&action=a,b][&userId=…][&cursor=…]
// The API answers one page at a time (entries plus `nextCursor`); loadAuditLog follows the cursor until the last page and
// returns every page combined, so callers see the whole filtered log as before.
import { api } from '@/lib/api/client'
import type { AuditLogPage, AuditLogParams, AuditLogResult } from '@/lib/reportRules'

export type { AuditLogParams, AuditLogResult } from '@/lib/reportRules'

/** The entries (from/to are YYYY-MM-DD calendar days, both ends inclusive) and the item lines of the entries that need them. */
export async function loadAuditLog(params: AuditLogParams = {}): Promise<AuditLogResult> {
  const list = (v: string | string[] | undefined) => (Array.isArray(v) ? v.join(',') : v) || undefined
  const result: AuditLogResult = { entries: [], transactionLines: {}, loanRequestLines: {} }
  let cursor: string | undefined = params.cursor || undefined
  do {
    const page: AuditLogPage = await api<AuditLogPage>('GET', '/api/audit-log', {
      from: params.from || undefined,
      to: params.to || undefined,
      entityType: list(params.entityType),
      action: list(params.action),
      userId: params.userId || undefined,
      cursor,
    })
    result.entries.push(...page.entries)
    Object.assign(result.transactionLines, page.transactionLines)
    Object.assign(result.loanRequestLines, page.loanRequestLines)
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  return result
}

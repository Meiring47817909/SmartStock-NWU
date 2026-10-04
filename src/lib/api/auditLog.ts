// Browser client for the Audit Log API (admin), newest entry first.
//   GET /api/audit-log[?from=…][&to=…][&entityType=a,b][&action=a,b][&userId=…]
import { api } from '@/lib/api/client'
import type { AuditLogParams, AuditLogResult } from '@/lib/reportRules'

export type { AuditLogParams, AuditLogResult } from '@/lib/reportRules'

/** The entries (from/to are YYYY-MM-DD calendar days, both ends inclusive) and the item lines of the entries that need them. */
export function loadAuditLog(params: AuditLogParams = {}): Promise<AuditLogResult> {
  const list = (v: string | string[] | undefined) => (Array.isArray(v) ? v.join(',') : v) || undefined
  return api<AuditLogResult>('GET', '/api/audit-log', {
    from: params.from || undefined,
    to: params.to || undefined,
    entityType: list(params.entityType),
    action: list(params.action),
    userId: params.userId || undefined,
  })
}

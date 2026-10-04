import 'server-only'
import type { Ctx } from '@/server/context'
import { auditLog } from '@/server/db/schema'
import { newId } from '@/server/db/ids'
import type { AuditAction, AuditEntityType } from '@/types/database'

export interface AuditEntry {
  action: AuditAction
  entityType: AuditEntityType
  entityId: string
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
}

// Same as logAudit in src/lib/firebase/audit.ts: values that are `undefined` are dropped from the snapshots.
function stripUndefined(value: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!value) return null
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined))
}

/**
 * Append one audit entry as `ctx.caller` at `ctx.now()`. Returns its id.
 * Unlike the Firestore logAudit it does not swallow errors: callers run it inside the same transaction as the change
 * it describes, so a failed audit write rolls the change back too.
 */
export async function writeAudit(ctx: Ctx, entry: AuditEntry): Promise<string> {
  const id = newId()
  await ctx.db.insert(auditLog).values({
    id,
    user_id: ctx.caller.uid,
    user_name: ctx.caller.name,
    action: entry.action,
    entity_type: entry.entityType,
    entity_id: entry.entityId,
    before: stripUndefined(entry.before),
    after: stripUndefined(entry.after),
    created_at: ctx.now(),
  })
  return id
}

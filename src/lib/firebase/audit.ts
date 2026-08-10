import { db } from './config'
import { collection, addDoc } from 'firebase/firestore'
import type { AuditAction, AuditEntityType } from '@/types/database'

interface LogAuditParams {
  userId: string | null | undefined
  userName: string | null | undefined
  action: AuditAction
  entityType: AuditEntityType
  entityId: string
  before?: Record<string, unknown> | null
  after?: Record<string, unknown> | null
}

// Firestore rejects `undefined` field values outright (addDoc throws
// synchronously rather than silently dropping them). Before/after snapshots
// are assembled from records that may predate a given field — e.g. a legacy
// product doc missing `available` or `location` — so any caller can
// accidentally hand us an undefined value. Rather than rely on every call
// site remembering a `?? fallback` for every field, strip undefined values
// here as a last line of defense.
function stripUndefined(value: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!value) return value
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined))
}

/**
 * Writes an entry to the `audit_log` collection. Every mutating action in
 * the app (product/category/staff create+edit, transaction creation) should
 * call this alongside its own write.
 *
 * Deliberately swallows its own errors — a failed audit write must never
 * block or roll back the primary user action it's describing.
 */
export async function logAudit(params: LogAuditParams) {
  try {
    await addDoc(collection(db, 'audit_log'), {
      user_id: params.userId ?? null,
      user_name: params.userName ?? null,
      action: params.action,
      entity_type: params.entityType,
      entity_id: params.entityId,
      before: stripUndefined(params.before ?? null),
      after: stripUndefined(params.after ?? null),
      created_at: new Date().toISOString(),
    })
  } catch (err) {
    console.error('Failed to write audit log entry:', err)
  }
}

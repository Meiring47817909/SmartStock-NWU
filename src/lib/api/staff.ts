// Browser client for the staff API. Each function calls the matching route in src/app/api; the server-side `ctx` is
// built there from the caller's token.
//
// Routes (all JSON; the Firebase ID token is attached by api()):
//   GET  /api/staff[?includeAdminAccount=true]                admin    list
//   GET  /api/staff?kind=emailConflict|holdings               admin
//   POST /api/staff { action: create|updateOwn|syncOwnEmail } create is admin; the others are the caller's own row
//   GET  /api/staff/<id>                                      admin, or the record's owner (404 → null here)
//   POST /api/staff/<id> { action: update|setActive|resolve } admin
// Login emails are sent through POST /api/staff/send-reset-email (see postStaffAdmin in src/lib/firebase/staff.ts),
// which also writes their audit entries.
import { api, ClientApiError } from '@/lib/api/client'
import type { StaffMember } from '@/types/database'
import type { OwnDetailsInput, ResolveHeldItemInput, StaffHoldings, StaffInput } from '@/lib/staffRules'

export type { HeldItem, OwnDetailsInput, ResolveHeldItemInput, StaffHolding, StaffHoldings, StaffInput } from '@/lib/staffRules'

export function listStaff(opts: { includeAdminAccount?: boolean } = {}): Promise<StaffMember[]> {
  return api<StaffMember[]>('GET', '/api/staff', opts.includeAdminAccount ? { includeAdminAccount: true } : undefined)
}

/** The record, or null when it doesn't exist. */
export async function getStaff(id: string): Promise<StaffMember | null> {
  try {
    return await api<StaffMember>('GET', `/api/staff/${encodeURIComponent(id)}`)
  } catch (err) {
    if (err instanceof ClientApiError && err.status === 404) return null
    throw err
  }
}

export function createStaff(input: StaffInput): Promise<StaffMember> {
  return api<StaffMember>('POST', '/api/staff', { action: 'create', ...input })
}

export function updateStaff(id: string, input: StaffInput): Promise<StaffMember> {
  return api<StaffMember>('POST', `/api/staff/${encodeURIComponent(id)}`, { action: 'update', staff: input })
}

export function setStaffActive(id: string, active: boolean): Promise<StaffMember> {
  return api<StaffMember>('POST', `/api/staff/${encodeURIComponent(id)}`, { action: 'setActive', active })
}

// Checks whether any *other* staff record already has this email. Returns the conflicting record (id + display name),
// or null if there's no conflict. Pass excludeId (the record being edited, if any) so saving a record without touching
// its email doesn't flag itself.
export async function findStaffEmailConflict(
  email: string,
  excludeId?: string,
): Promise<{ id: string; full_name: string } | null> {
  if (!email.trim()) return null
  return api<{ id: string; full_name: string } | null>('GET', '/api/staff', { kind: 'emailConflict', email, excludeId })
}

/** What each staff member holds, keyed by staff id (only those holding or having had written off something). */
export function loadStaffHoldings(): Promise<StaffHoldings> {
  return api<StaffHoldings>('GET', '/api/staff', { kind: 'holdings' })
}

/** Records that a held item doesn't need to come back (a return waiver). Resolves to the waiver id. */
export async function resolveHeldItem(staffId: string, input: ResolveHeldItemInput): Promise<string> {
  const res = await api<{ id: string }>('POST', `/api/staff/${encodeURIComponent(staffId)}`, { action: 'resolve', ...input })
  return res.id
}

/** My Profile: save the caller's own details (creates the admin's own borrower record the first time). */
export function updateOwnDetails(input: OwnDetailsInput): Promise<StaffMember> {
  return api<StaffMember>('POST', '/api/staff', { action: 'updateOwn', ...input })
}

/** My Profile: after a confirmed email change, keep the caller's own staff record's email in step. */
export function syncOwnEmail(email: string): Promise<StaffMember | null> {
  return api<StaffMember | null>('POST', '/api/staff', { action: 'syncOwnEmail', email })
}

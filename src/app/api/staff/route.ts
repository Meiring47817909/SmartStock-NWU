import { route } from '@/server/http'
import { DataError } from '@/server/context'
import {
  createStaff,
  findStaffEmailConflict,
  getStaffHoldings,
  listStaff,
  syncOwnEmail,
  updateOwnDetails,
} from '@/server/data/staff'
import type { OwnDetailsInput, StaffInput } from '@/lib/staffRules'

// Staff. The data functions enforce who may do what (the staff table is admin-only except a caller's own row), so the
// routes only need a signed-in caller.
//   GET  /api/staff[?includeAdminAccount=true]                    → StaffMember[] by name          (admin)
//   GET  /api/staff?kind=emailConflict&email=…[&excludeId=…]      → { id, full_name } | null       (admin)
//   GET  /api/staff?kind=holdings                                 → { [staffId]: { outstanding, items } }  (admin)
//   POST /api/staff { action: 'create', ...StaffInput }           → StaffMember                    (admin)
//   POST /api/staff { action: 'updateOwn', ...OwnDetailsInput }   → StaffMember   (the caller's own row; creates it for an admin)
//   POST /api/staff { action: 'syncOwnEmail', email }             → StaffMember | null   (403 unless it is the caller's Firebase Auth email)
// The account's real email from Firebase Auth. Loaded on demand so importing this route never initialises Firebase Admin.
async function authEmailOf(uid: string): Promise<string | null> {
  const { adminAuth } = await import('@/lib/firebase/admin')
  return (await adminAuth.getUser(uid)).email ?? null
}

type Query = { kind?: string; includeAdminAccount?: string; email?: string; excludeId?: string }
type Body = { action?: string; email?: string } & Partial<StaffInput> & Partial<OwnDetailsInput>

export const GET = route<Query>('signed-in', async (ctx, query) => {
  switch (query.kind) {
    case undefined:
    case '':
      return listStaff(ctx, { includeAdminAccount: query.includeAdminAccount === 'true' })
    case 'emailConflict':
      return findStaffEmailConflict(ctx, query.email ?? '', query.excludeId || undefined)
    case 'holdings':
      return getStaffHoldings(ctx)
    default:
      throw new DataError(400, 'Unknown request.')
  }
})

export const POST = route<Body>('signed-in', async (ctx, body) => {
  const { action, ...input } = body
  switch (action) {
    case 'create':
      return createStaff(ctx, input as StaffInput)
    case 'updateOwn':
      return updateOwnDetails(ctx, input as OwnDetailsInput)
    case 'syncOwnEmail':
      return syncOwnEmail(ctx, String(input.email ?? ''), authEmailOf)
    default:
      throw new DataError(400, 'Unknown action.')
  }
})

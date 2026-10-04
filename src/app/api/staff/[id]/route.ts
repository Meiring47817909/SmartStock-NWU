import { route } from '@/server/http'
import { DataError } from '@/server/context'
import { getStaff, resolveHeldItem, setStaffActive, updateStaff } from '@/server/data/staff'
import type { ResolveHeldItemInput, StaffInput } from '@/lib/staffRules'

// One staff record. The data functions enforce who may do what, so the routes only need a signed-in caller.
//   GET  /api/staff/<id>                                                   → StaffMember (404 when missing; admin or the record's owner)
//   POST /api/staff/<id> { action: 'update', staff: StaffInput }           → StaffMember (admin)
//   POST /api/staff/<id> { action: 'setActive', active: boolean }          → StaffMember (admin)
//   POST /api/staff/<id> { action: 'resolve', ...ResolveHeldItemInput }    → { id }  the waiver id (admin)
export const GET = route('signed-in', async (ctx, _query, _req, params) => {
  const row = await getStaff(ctx, params.id)
  if (!row) throw new DataError(404, 'Staff record not found.')
  return row
})

type Body = { action?: string; staff?: StaffInput; active?: boolean } & Partial<ResolveHeldItemInput>

export const POST = route<Body>('signed-in', async (ctx, body, _req, params) => {
  switch (body.action) {
    case 'update':
      return updateStaff(ctx, params.id, body.staff as StaffInput)
    case 'setActive':
      return setStaffActive(ctx, params.id, body.active === true)
    case 'resolve':
      return { id: await resolveHeldItem(ctx, params.id, body as ResolveHeldItemInput) }
    default:
      throw new DataError(400, 'Unknown action.')
  }
})

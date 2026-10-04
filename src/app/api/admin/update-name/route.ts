import 'server-only'
import { NextRequest, NextResponse } from 'next/server'
import { ApiError, requireSignedIn, routeCtx } from '@/lib/server/staffAdmin'
import { setOwnProfileName } from '@/server/data/profiles'

/**
 * Updates the caller's own `profiles` row's full_name -- the browser has no
 * database access, so a BICS admin editing her own display name has to go
 * through this route. (My Profile's save now does this inside
 * updateOwnDetails; the route stays for any other caller.)
 *
 * Self-service only: this always writes to the CALLER's own profile doc,
 * never a target id passed in the body, so there's no separate admin-role
 * check needed beyond "is this a real signed-in profiles/{uid} owner" --
 * requireSignedIn already covers that.
 *
 * Body: { fullName: string }
 */
export async function POST(request: NextRequest) {
  try {
    const { uid } = await requireSignedIn(request)

    const body = await request.json().catch(() => null)
    const fullName = typeof body?.fullName === 'string' ? body.fullName.trim() : null
    if (!fullName) {
      throw new ApiError(400, 'Missing fullName.')
    }

    const updated = await setOwnProfileName(await routeCtx(uid), fullName)
    if (updated === null) {
      // Only a BICS admin has a profiles row at all (see the Profile
      // type's own doc comment in types/database.ts) -- a portal borrower
      // hitting this route has nothing to update.
      throw new ApiError(404, 'No BICS profile found for this account.')
    }

    return NextResponse.json({ full_name: fullName })
  } catch (err) {
    if (err instanceof ApiError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    console.error('update-name failed:', err)
    return NextResponse.json({ error: 'Failed to update name.' }, { status: 500 })
  }
}

import 'server-only'
import { NextRequest, NextResponse } from 'next/server'
import { adminDb } from '@/lib/firebase/admin'
import { ApiError, requireSignedIn } from '@/lib/server/staffAdmin'

/**
 * Updates the caller's own profiles/{uid}.full_name -- firestore.rules
 * blocks every client write to `profiles` (`allow write: if false`, see
 * that file), so a BICS admin editing her own display name on
 * (protected)/profile has to go through the Admin SDK here instead.
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

    const profileRef = adminDb.collection('profiles').doc(uid)
    const snap = await profileRef.get()
    if (!snap.exists) {
      // Only a BICS admin has a profiles/{uid} doc at all (see the Profile
      // type's own doc comment in types/database.ts) -- a portal borrower
      // hitting this route has nothing to update.
      throw new ApiError(404, 'No BICS profile found for this account.')
    }

    await profileRef.set({ full_name: fullName }, { merge: true })

    return NextResponse.json({ full_name: fullName })
  } catch (err) {
    if (err instanceof ApiError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    console.error('update-name failed:', err)
    return NextResponse.json({ error: 'Failed to update name.' }, { status: 500 })
  }
}

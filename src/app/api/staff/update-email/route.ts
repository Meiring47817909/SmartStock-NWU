import 'server-only'
import { NextRequest, NextResponse } from 'next/server'
import { adminAuth, adminDb } from '@/lib/firebase/admin'
import { ApiError, requireAdmin } from '@/lib/server/staffAdmin'

/**
 * Syncs a staff member's linked Firebase Auth account to a new email —
 * same account, same UID, just its email attribute changes. Never creates
 * a second account and never deletes the old one.
 *
 * Deliberately does NOT touch Firestore. The Staff page calls this first
 * and only writes the new email into the `staff` document (as part of its
 * normal edit-save) if this succeeds — see the handout, Stage B section 2d.
 *
 * Body: { staffId: string, newEmail: string }
 */
export async function POST(request: NextRequest) {
  try {
    await requireAdmin(request)

    const body = await request.json().catch(() => null)
    const staffId = typeof body?.staffId === 'string' ? body.staffId : null
    const rawEmail = typeof body?.newEmail === 'string' ? body.newEmail : null
    if (!staffId || !rawEmail) {
      throw new ApiError(400, 'Missing staffId or newEmail.')
    }
    const newEmail = rawEmail.trim().toLowerCase()

    const staffSnap = await adminDb.collection('staff').doc(staffId).get()
    if (!staffSnap.exists) {
      throw new ApiError(404, 'Staff record not found.')
    }
    const uid: string | undefined = staffSnap.data()?.uid || undefined
    if (!uid) {
      // Nothing to sync — this record has no linked Auth account yet, so
      // the caller should have just written Firestore directly instead of
      // calling this route at all.
      throw new ApiError(400, 'This staff member has no linked login account to update.')
    }

    try {
      await adminAuth.updateUser(uid, { email: newEmail })
    } catch (err: any) {
      if (err?.code === 'auth/email-already-exists') {
        throw new ApiError(409, 'This email is already used by a different account.')
      }
      if (err?.code === 'auth/invalid-email') {
        throw new ApiError(400, 'That email address is not valid.')
      }
      throw err
    }

    return NextResponse.json({ email: newEmail })
  } catch (err) {
    if (err instanceof ApiError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    console.error('update-email failed:', err)
    return NextResponse.json({ error: 'Failed to update login email.' }, { status: 500 })
  }
}

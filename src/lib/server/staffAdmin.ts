import 'server-only'
import type { NextRequest } from 'next/server'
import { adminAuth, adminDb } from '@/lib/firebase/admin'

// Shared helpers for the /api/staff/* routes (send-reset-email,
// update-email). Both need to (a) confirm the caller is actually a signed-in
// admin before doing anything privileged, and (b) check whether a given
// Firebase Auth UID is already claimed by a *different* staff record — see
// the handout's Stage B, section 2 for why that check exists.

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

// Verifies the request's `Authorization: Bearer <idToken>` header and that
// the signed-in user has the admin role (matches useRole()'s
// canManageStaff, which is admin-only). Throws ApiError on any failure —
// callers should catch it and turn it into a NextResponse.
export async function requireAdmin(request: NextRequest): Promise<{ uid: string }> {
  const authHeader = request.headers.get('authorization') ?? ''
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
  if (!idToken) {
    throw new ApiError(401, 'Missing Authorization header.')
  }

  let decoded
  try {
    decoded = await adminAuth.verifyIdToken(idToken)
  } catch {
    throw new ApiError(401, 'Invalid or expired session — please sign in again.')
  }

  const profileSnap = await adminDb.collection('profiles').doc(decoded.uid).get()
  const role = profileSnap.exists ? profileSnap.data()?.role : null
  if (role !== 'admin') {
    throw new ApiError(403, 'Only admins can manage staff logins.')
  }

  return { uid: decoded.uid }
}

// Does any `staff` document already have this Firebase Auth UID linked?
// Excludes `excludeStaffId` (the record currently being acted on) so a
// record checking against its own already-linked UID doesn't flag itself.
export async function findStaffDocOwningUid(
  uid: string,
  excludeStaffId?: string,
): Promise<{ id: string; full_name: string } | null> {
  const snap = await adminDb.collection('staff').where('uid', '==', uid).get()
  for (const d of snap.docs) {
    if (d.id === excludeStaffId) continue
    return { id: d.id, full_name: (d.data().full_name as string) ?? 'Unknown' }
  }
  return null
}

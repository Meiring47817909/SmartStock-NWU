import 'server-only'
import type { NextRequest } from 'next/server'
import { eq } from 'drizzle-orm'
import { VerifierUnavailableError, getRouteDb, verifyToken, type VerifiedToken } from '@/server/context'
import { profiles } from '@/server/db/schema'

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

// Verifies the request's `Authorization: Bearer <idToken>` header belongs
// to SOME signed-in Firebase Auth user — BICS admin or portal borrower,
// no role check. For routes that need admin data access (bypassing
// firestore.rules via adminDb) but are called from portal pages a
// borrower's own client can't read directly — e.g. computing another
// staff member's expected-return date, which touches `transactions` and
// is admin-only in firestore.rules for good reason (it's every staff
// member's full borrow history, not just the caller's own). Throws
// ApiError on any failure — callers should catch it and turn it into a
// NextResponse.
async function verifyBearer(request: NextRequest): Promise<VerifiedToken> {
  const authHeader = request.headers.get('authorization') ?? ''
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
  if (!idToken) {
    throw new ApiError(401, 'Missing Authorization header.')
  }
  try {
    return await verifyToken(idToken)
  } catch (err) {
    if (err instanceof VerifierUnavailableError) throw err
    throw new ApiError(401, 'Invalid or expired session — please sign in again.')
  }
}

export async function requireSignedIn(request: NextRequest): Promise<{ uid: string }> {
  const decoded = await verifyBearer(request)
  return { uid: decoded.uid }
}

// Like requireSignedIn, but the user must also have signed in (or re-entered
// their password) within the last `maxAgeSeconds`, for changes to the login
// itself such as the email address.
export async function requireRecentSignIn(request: NextRequest, maxAgeSeconds: number): Promise<{ uid: string }> {
  const decoded = await verifyBearer(request)
  const signedInAt = typeof decoded.auth_time === 'number' ? decoded.auth_time : 0
  if (Date.now() / 1000 - signedInAt > maxAgeSeconds) {
    throw new ApiError(401, 'For security, enter your current password again and retry.')
  }
  return { uid: decoded.uid }
}

// Verifies the request's `Authorization: Bearer <idToken>` header and that
// the signed-in user has the admin role (matches useRole()'s
// canManageStaff, which is admin-only). Throws ApiError on any failure —
// callers should catch it and turn it into a NextResponse.
export async function requireAdmin(request: NextRequest): Promise<{ uid: string }> {
  const { uid } = await requireSignedIn(request)
  await assertAdmin(uid)
  return { uid }
}

// Throws a 403 unless this user's profile has the admin role.
export async function assertAdmin(uid: string, message = 'Only admins can manage staff logins.'): Promise<void> {
  const [profile] = await getRouteDb().select({ role: profiles.role }).from(profiles).where(eq(profiles.uid, uid)).limit(1)
  if (profile?.role !== 'admin') {
    throw new ApiError(403, message)
  }
}

// Does any `staff` document already have this Firebase Auth UID linked?
// Excludes `excludeStaffId` (the record currently being acted on) so a
// record checking against its own already-linked UID doesn't flag itself.
export async function findStaffDocOwningUid(
  uid: string,
  excludeStaffId?: string,
): Promise<{ id: string; full_name: string } | null> {
  // Loaded on demand so importing this module never initialises Firebase Admin (Task 7 moves this lookup to PostgreSQL).
  const { adminDb } = await import('@/lib/firebase/admin')
  const snap = await adminDb.collection('staff').where('uid', '==', uid).get()
  for (const d of snap.docs) {
    if (d.id === excludeStaffId) continue
    return { id: d.id, full_name: (d.data().full_name as string) ?? 'Unknown' }
  }
  return null
}

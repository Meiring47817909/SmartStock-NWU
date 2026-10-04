import 'server-only'
import { eq } from 'drizzle-orm'
import { getDb, type Db, type Tx } from '@/server/db/client'
import { profiles, staff } from '@/server/db/schema'

export type Role = 'admin' | 'staff' | 'system'

/** Who is making the call. `staffId` is the `staff.id` whose `uid` is the caller's Firebase uid. */
export interface Caller {
  uid: string | null
  name: string | null
  role: Role
  staffId: string | null
}

export interface Ctx {
  db: Db | Tx
  caller: Caller
  /** Overridable so seeds and tests can write history. */
  now: () => Date
}

export class DataError extends Error {
  status: 400 | 401 | 403 | 404 | 409
  constructor(status: 400 | 401 | 403 | 404 | 409, message: string) {
    super(message)
    this.status = status
  }
}

/** For lazy expiry and seeds: no signed-in user. */
export const SYSTEM_CALLER: Caller = { uid: null, name: null, role: 'system', staffId: null }

/** Nobody signed in (public routes). Never admin. */
export const ANONYMOUS_CALLER: Caller = { uid: null, name: null, role: 'staff', staffId: null }

export function assertAdmin(ctx: Ctx): void {
  if (ctx.caller.role !== 'admin') throw new DataError(403, 'Only admins can do this.')
}

export function assertStaffSelf(ctx: Ctx, staffId: string): void {
  if (ctx.caller.role === 'admin') return
  if (ctx.caller.staffId !== null && ctx.caller.staffId === staffId) return
  throw new DataError(403, 'You can only do this for your own staff record.')
}

// --- Token verification -----------------------------------------------------

export interface VerifiedToken {
  uid: string
  auth_time?: number
}
export type TokenVerifier = (token: string) => Promise<VerifiedToken>

/** The verifier could not run at all (e.g. Firebase Admin is not configured). Not the caller's fault: a 500, not a 401. */
export class VerifierUnavailableError extends Error {}

// Firebase Admin is loaded on first use, so tests that replace the verifier never initialise it
// (it throws without credentials).
const firebaseVerifier: TokenVerifier = async (token) => {
  let adminAuth: typeof import('@/lib/firebase/admin').adminAuth
  try {
    ;({ adminAuth } = await import('@/lib/firebase/admin'))
  } catch (err) {
    throw new VerifierUnavailableError(`Firebase Admin could not be loaded: ${(err as Error).message}`)
  }
  const decoded = await adminAuth.verifyIdToken(token)
  return { uid: decoded.uid, auth_time: decoded.auth_time }
}

let verifier: TokenVerifier = firebaseVerifier
let dbOverride: Db | null = null

/** Test hook: replace the Firebase token check. Pass null to restore the real one. */
export function setTokenVerifier(fn: TokenVerifier | null): void {
  verifier = fn ?? firebaseVerifier
}

/** Test hook: the database `route()` and the staffAdmin helpers use instead of DATABASE_URL. Pass null to restore. */
export function setDbForTests(db: Db | null): void {
  dbOverride = db
}

export function getRouteDb(): Db {
  return dbOverride ?? getDb()
}

export function verifyToken(token: string): Promise<VerifiedToken> {
  return verifier(token)
}

/** Profile role and linked staff record for a verified Firebase uid. Portal borrowers usually have no profile, so they are 'staff'. */
export async function loadCaller(db: Db | Tx, uid: string): Promise<Caller> {
  const [profile] = await db.select().from(profiles).where(eq(profiles.uid, uid)).limit(1)
  const [staffRow] = await db.select().from(staff).where(eq(staff.uid, uid)).limit(1)
  return {
    uid,
    name: profile?.full_name ?? staffRow?.full_name ?? null,
    role: profile?.role === 'admin' ? 'admin' : 'staff',
    staffId: staffRow?.id ?? null,
  }
}

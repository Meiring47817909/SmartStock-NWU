import 'server-only'
import { NextResponse, type NextRequest } from 'next/server'
import { ApiError } from '@/lib/server/staffAdmin'
import {
  ANONYMOUS_CALLER,
  DataError,
  VerifierUnavailableError,
  assertAdmin,
  getRouteDb,
  loadCaller,
  verifyToken,
  type Caller,
  type Ctx,
} from '@/server/context'

export { setDbForTests, setTokenVerifier } from '@/server/context'

export type Access = 'public' | 'signed-in' | 'admin'

function bearerToken(req: NextRequest): string | null {
  const header = req.headers.get('authorization') ?? ''
  return header.startsWith('Bearer ') ? header.slice(7) || null : null
}

async function resolveCaller(req: NextRequest, access: Access, ctxDb: Ctx['db']): Promise<Caller> {
  const token = bearerToken(req)
  if (access === 'public') {
    // Public routes work signed out; a valid token still identifies the caller, a bad one is ignored.
    if (!token) return ANONYMOUS_CALLER
    try {
      const { uid } = await verifyToken(token)
      return await loadCaller(ctxDb, uid)
    } catch (err) {
      if (err instanceof VerifierUnavailableError) throw err
      return ANONYMOUS_CALLER
    }
  }
  if (!token) throw new DataError(401, 'Missing Authorization header.')
  let uid: string
  try {
    ;({ uid } = await verifyToken(token))
  } catch (err) {
    if (err instanceof VerifierUnavailableError) throw err
    throw new DataError(401, 'Invalid or expired session — please sign in again.')
  }
  return loadCaller(ctxDb, uid)
}

async function readBody(req: NextRequest): Promise<unknown> {
  if (req.method === 'GET' || req.method === 'HEAD') return Object.fromEntries(req.nextUrl.searchParams)
  return req.json().catch(() => ({}))
}

/** Next's second route-handler argument: `{ params }` is a promise of the dynamic segments (`[id]`, `[...slug]`). */
export type RouteSegment = { params: Promise<Record<string, string | string[]>> }

async function readParams(segment: RouteSegment | undefined): Promise<Record<string, string>> {
  const raw = (await segment?.params) ?? {}
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Array.isArray(v) ? v.join('/') : v]))
}

/**
 * Wrap a route handler: check the Firebase ID token, load the caller (role from `profiles`, staff link from
 * `staff.uid`), enforce `access`, and turn errors into `{ error }` JSON. GET handlers get the query params as `body`;
 * dynamic-segment params (catch-all joined with '/') arrive as the 4th argument.
 */
export function route<B = unknown, R = unknown>(
  access: Access,
  handler: (ctx: Ctx, body: B, req: NextRequest, params: Record<string, string>) => Promise<R>,
): (req: NextRequest, segment?: RouteSegment) => Promise<NextResponse> {
  return async (req, segment) => {
    try {
      const db = getRouteDb()
      const caller = await resolveCaller(req, access, db)
      const ctx: Ctx = { db, caller, now: () => new Date() }
      if (access === 'admin') assertAdmin(ctx)
      const body = (await readBody(req)) as B
      const params = await readParams(segment)
      const result = await handler(ctx, body, req, params)
      return NextResponse.json(result)
    } catch (err) {
      if (err instanceof DataError || err instanceof ApiError) {
        return NextResponse.json({ error: err.message }, { status: err.status })
      }
      console.error('Route failed:', err)
      return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 })
    }
  }
}

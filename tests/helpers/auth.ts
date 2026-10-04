import { setDbForTests, setTokenVerifier } from '@/server/context'
import type { Db } from '@/server/db/client'

/** Token string a test sends for a given Firebase uid (`Authorization: Bearer <token>`). */
export const tokenFor = (uid: string) => `test-token:${uid}`

/**
 * Replace the Firebase token check with a fake and point `route()` at the test database.
 * Tokens made by `tokenFor(uid)` verify as that uid; every other token is rejected like an expired one.
 * Pass `authTime` (seconds since epoch) to simulate how recently the user signed in.
 * Returns a function that restores the real verifier and database.
 */
export function installFakeAuth(db: Db, opts: { authTime?: () => number } = {}): () => void {
  setTokenVerifier(async (token) => {
    if (!token.startsWith('test-token:')) throw new Error('auth/id-token-expired')
    return { uid: token.slice('test-token:'.length), auth_time: (opts.authTime ?? (() => Math.floor(Date.now() / 1000)))() }
  })
  setDbForTests(db)
  return () => {
    setTokenVerifier(null)
    setDbForTests(null)
  }
}

// Port of the scratch harness check-reauth.mts (4 checks), same assertions. The Firebase client SDK and the app's auth
// object are replaced with fakes that record what was called.
import assert from 'node:assert/strict'
import { beforeEach, describe, it, vi } from 'vitest'

const fb = vi.hoisted(() => ({
  calls: [] as unknown[][],
  reauthError: null as string | null,
  auth: { currentUser: null as unknown },
}))

vi.mock('@/lib/firebase/config', () => ({ auth: fb.auth }))
vi.mock('firebase/auth', () => ({
  EmailAuthProvider: { credential: (email: string, password: string) => ({ email, password }) },
  async reauthenticateWithCredential(user: { uid?: string }, cred: { email: string; password: string }) {
    fb.calls.push(['reauthenticate', user?.uid, cred.email, cred.password])
    if (fb.reauthError) throw Object.assign(new Error('fb'), { code: fb.reauthError })
  },
}))

import { confirmCurrentPassword } from '@/lib/firebase/reauth'

beforeEach(() => {
  fb.calls = []
  fb.reauthError = null
})

const rejects = async (p: Promise<unknown>) => {
  try {
    await p
  } catch (e) {
    return e as Error & { code?: string }
  }
  throw new Error('expected a rejection')
}
const makeUser = (email: string, fresh: string, reloadErr?: string) => ({
  uid: 'u1',
  email,
  async reload() {
    if (reloadErr) throw Object.assign(new Error('r'), { code: reloadErr })
    this.email = fresh
  },
})

describe('confirmCurrentPassword', () => {
  it('re-checks the password against the login email as it is NOW (after a change made elsewhere)', async () => {
    fb.auth.currentUser = makeUser('old@x.com', 'new@x.com')
    const u = await confirmCurrentPassword('password123')
    assert.equal(u, fb.auth.currentUser)
    assert.deepEqual(fb.calls, [['reauthenticate', 'u1', 'new@x.com', 'password123']])
  })

  it('signed out -> clear error, nothing checked', async () => {
    fb.auth.currentUser = null
    const e = await rejects(confirmCurrentPassword('x'))
    assert.equal(e.code, 'auth/no-current-user')
    assert.ok(/sign in again/i.test(e.message), e.message)
    assert.deepEqual(fb.calls, [])
  })

  it('session ended by the login change -> tells them to sign in again, nothing checked', async () => {
    fb.auth.currentUser = makeUser('old@x.com', 'new@x.com', 'auth/user-token-expired')
    const e = await rejects(confirmCurrentPassword('x'))
    assert.equal(e.code, 'auth/user-token-expired')
    assert.ok(/sign out and sign in again/i.test(e.message), e.message)
    assert.deepEqual(fb.calls, [])
  })

  it("wrong password keeps Firebase's code for the page to show", async () => {
    fb.auth.currentUser = makeUser('a@x.com', 'a@x.com')
    fb.reauthError = 'auth/invalid-credential'
    assert.equal((await rejects(confirmCurrentPassword('nope'))).code, 'auth/invalid-credential')
  })
})

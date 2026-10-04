// Port of the scratch harness check-account-emails-client.mts (10 checks), same assertions. fetch and the Firebase client
// SDK are replaced with fakes that record what was called.
import assert from 'node:assert/strict'
import type { User } from 'firebase/auth'
import { beforeEach, describe, it, vi } from 'vitest'

const fb = vi.hoisted(() => ({ calls: [] as unknown[][], error: null as string | null }))

vi.mock('@/lib/firebase/config', () => ({ auth: { stub: 'auth' } }))
// Records the Firebase client SDK calls the account-email helper may fall back to.
vi.mock('firebase/auth', () => ({
  async sendPasswordResetEmail(_auth: unknown, email: string) {
    fb.calls.push(['reset', email])
    if (fb.error) throw Object.assign(new Error('fb'), { code: fb.error })
  },
  async verifyBeforeUpdateEmail(user: { uid?: string }, email: string) {
    fb.calls.push(['verifyBeforeUpdateEmail', user?.uid, email])
    if (fb.error) throw Object.assign(new Error('fb'), { code: fb.error })
  },
}))

import { requestEmailChange, requestPasswordReset } from '@/lib/firebase/accountEmails'

interface Call { url: string; init: { method: string; headers: Record<string, string>; body: string } }
let calls: Call[] = []
let tokenForced: boolean | undefined

function fetchStub(status: number, body: unknown, opts: { throws?: boolean } = {}) {
  vi.stubGlobal('fetch', async (url: string, init: Call['init']) => {
    calls.push({ url, init })
    if (opts.throws) throw new TypeError('network down')
    return { ok: status >= 200 && status < 300, status, json: async () => body }
  })
}
const user = {
  uid: 'u1',
  getIdToken: async (force?: boolean) => {
    tokenForced = force
    return 'ID-TOKEN'
  },
} as unknown as User

beforeEach(() => {
  calls = []
  fb.calls = []
  fb.error = null
  tokenForced = undefined
  vi.unstubAllGlobals()
})

const rejects = async (p: Promise<unknown>) => {
  try {
    await p
  } catch (e) {
    return e as Error & { code?: string }
  }
  throw new Error('expected a rejection')
}

describe('account emails (browser side)', () => {
  it('reset: posts the email as JSON and, when the server sent it, never touches Firebase', async () => {
    fetchStub(200, { sent: true })
    await requestPasswordReset('a@b.com')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, '/api/auth/forgot-password')
    assert.equal(calls[0].init.method, 'POST')
    assert.deepEqual(JSON.parse(calls[0].init.body), { email: 'a@b.com' })
    assert.deepEqual(fb.calls, [])
  })

  it('reset: mail_disabled -> falls back to Firebase sendPasswordResetEmail once', async () => {
    fetchStub(200, { sent: false, reason: 'mail_disabled' })
    await requestPasswordReset('a@b.com')
    assert.deepEqual(fb.calls, [['reset', 'a@b.com']])
  })

  it('reset: Firebase fallback errors keep their code', async () => {
    fetchStub(200, { sent: false, reason: 'mail_disabled' })
    fb.error = 'auth/too-many-requests'
    assert.equal((await rejects(requestPasswordReset('a@b.com'))).code, 'auth/too-many-requests')
  })

  it('reset: 400 -> error coded auth/invalid-email', async () => {
    fetchStub(400, { error: 'Enter a valid email address.' })
    assert.equal((await rejects(requestPasswordReset('x'))).code, 'auth/invalid-email')
  })

  it('reset: 502 -> Error carrying the server message, no Firebase fallback', async () => {
    fetchStub(502, { error: 'Mail server not reachable. Is Mailpit running? (npm run mailpit)' })
    const e = await rejects(requestPasswordReset('a@b.com'))
    assert.ok(/Mailpit/.test(e.message))
    assert.deepEqual(fb.calls, [])
  })

  it('reset: network failure -> generic error, no Firebase fallback', async () => {
    fetchStub(0, null, { throws: true })
    const e = await rejects(requestPasswordReset('a@b.com'))
    assert.ok(/Failed to send reset email/.test(e.message))
    assert.deepEqual(fb.calls, [])
  })

  it('change: force-refreshes the ID token, sends it as Bearer with { newEmail }; sent -> no Firebase call', async () => {
    fetchStub(200, { sent: true })
    await requestEmailChange(user, 'new@x.com')
    assert.equal(tokenForced, true)
    assert.equal(calls[0].url, '/api/auth/change-email')
    assert.equal(calls[0].init.headers.Authorization, 'Bearer ID-TOKEN')
    assert.deepEqual(JSON.parse(calls[0].init.body), { newEmail: 'new@x.com' })
    assert.deepEqual(fb.calls, [])
  })

  it('change: mail_disabled -> falls back to verifyBeforeUpdateEmail', async () => {
    fetchStub(200, { sent: false, reason: 'mail_disabled' })
    await requestEmailChange(user, 'new@x.com')
    assert.deepEqual(fb.calls, [['verifyBeforeUpdateEmail', 'u1', 'new@x.com']])
  })

  it('change: 409 -> auth/email-already-in-use, 400 -> auth/invalid-email', async () => {
    fetchStub(409, { error: 'This email is already used by another account.' })
    assert.equal((await rejects(requestEmailChange(user, 'a@b.com'))).code, 'auth/email-already-in-use')
    fetchStub(400, { error: 'x' })
    assert.equal((await rejects(requestEmailChange(user, 'a@b.com'))).code, 'auth/invalid-email')
  })

  it('change: 401 / 502 -> Error carrying the server message', async () => {
    fetchStub(401, { error: 'For security, enter your current password again.' })
    assert.ok(/current password/.test((await rejects(requestEmailChange(user, 'a@b.com'))).message))
    fetchStub(502, { error: 'Mail server not reachable. Is Mailpit running? (npm run mailpit)' })
    assert.ok(/Mailpit/.test((await rejects(requestEmailChange(user, 'a@b.com'))).message))
  })
})

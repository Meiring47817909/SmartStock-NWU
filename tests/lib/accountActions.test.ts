// Port of the scratch harness check-account-actions.mts (10 checks), same assertions. The Firebase client SDK is
// replaced with a fake that records what was called (and plays the Auth emulator, which has no password policy lookup).
import assert from 'node:assert/strict'
import { beforeEach, describe, it, vi } from 'vitest'

const fb = vi.hoisted(() => ({
  calls: [] as unknown[][],
  error: null as string | null,
  resetEmail: undefined as string | undefined,
  actionInfo: undefined as unknown,
  vp: undefined as unknown,
}))
const fail = () => {
  if (fb.error) throw Object.assign(new Error('fb'), { code: fb.error })
}

vi.mock('@/lib/firebase/config', () => ({ auth: { stub: 'auth' } }))
vi.mock('firebase/auth', () => ({
  async validatePassword() {
    const vp = fb.vp as { throws?: string } | undefined
    if (vp?.throws) throw Object.assign(new Error(vp.throws), { code: vp.throws })
    return vp
  },
  async verifyPasswordResetCode(_auth: unknown, code: string) { fb.calls.push(['verifyPasswordResetCode', code]); fail(); return fb.resetEmail },
  async confirmPasswordReset(_auth: unknown, code: string, pw: string) { fb.calls.push(['confirmPasswordReset', code, pw]); fail() },
  async checkActionCode(_auth: unknown, code: string) { fb.calls.push(['checkActionCode', code]); fail(); return fb.actionInfo },
  async applyActionCode(_auth: unknown, code: string) { fb.calls.push(['applyActionCode', code]); fail() },
}))

import * as A from '@/lib/firebase/accountActions'

const EMU = { throws: 'auth/identitytoolkit.getpasswordpolicy-is-not-implemented-in-the-auth-emulator.' }
beforeEach(() => {
  fb.calls = []
  fb.error = null
  fb.vp = EMU
})

const qs = (s: string) => new URLSearchParams(s)
const rejects = async (p: Promise<unknown>) => {
  try {
    await p
  } catch (e) {
    return e as Error & { code?: string }
  }
  throw new Error('expected a rejection')
}

describe('account actions (/auth/action page helpers)', () => {
  it('parseAction: the three supported modes with a code', () => {
    assert.deepEqual(A.parseAction(qs('mode=resetPassword&oobCode=abc')), { mode: 'resetPassword', oobCode: 'abc' })
    assert.deepEqual(A.parseAction(qs('mode=verifyAndChangeEmail&oobCode=x&apiKey=k&lang=en')), { mode: 'verifyAndChangeEmail', oobCode: 'x' })
    assert.deepEqual(A.parseAction(qs('mode=recoverEmail&oobCode=y')), { mode: 'recoverEmail', oobCode: 'y' })
  })

  it('parseAction: missing code, empty code, unknown mode -> null', () => {
    for (const s of ['mode=resetPassword', 'mode=resetPassword&oobCode=', 'mode=signIn&oobCode=a', 'oobCode=a', '']) {
      assert.equal(A.parseAction(qs(s)), null, s)
    }
  })

  it('startPasswordReset: returns the account email from the code', async () => {
    fb.resetEmail = 'jessica@example.com'
    assert.equal(await A.startPasswordReset('c1'), 'jessica@example.com')
    assert.deepEqual(fb.calls, [['verifyPasswordResetCode', 'c1']])
  })

  it('finishPasswordReset: mismatch -> message, nothing saved', async () => {
    assert.equal(await A.finishPasswordReset('c1', 'abcdef', 'abcdeg'), "New password and confirmation don't match.")
    assert.deepEqual(fb.calls, [])
  })

  it('finishPasswordReset: too short / too long under the emulator -> rule message, nothing saved', async () => {
    assert.equal(await A.finishPasswordReset('c1', 'abc', 'abc'), 'New password needs at least 6 characters.')
    assert.equal(await A.finishPasswordReset('c1', 'x'.repeat(21), 'x'.repeat(21)), 'New password needs at most 20 characters.')
    assert.deepEqual(fb.calls, [])
  })

  it('finishPasswordReset: valid -> confirmPasswordReset with the code and password, returns null', async () => {
    assert.equal(await A.finishPasswordReset('c1', 'newpass1', 'newpass1'), null)
    assert.deepEqual(fb.calls, [['confirmPasswordReset', 'c1', 'newpass1']])
  })

  it('finishPasswordReset: Firebase errors propagate (expired link)', async () => {
    fb.error = 'auth/expired-action-code'
    assert.equal((await rejects(A.finishPasswordReset('c1', 'newpass1', 'newpass1'))).code, 'auth/expired-action-code')
  })

  it('describeEmailAction: new and previous address from checkActionCode', async () => {
    fb.actionInfo = { operation: 'VERIFY_AND_CHANGE_EMAIL', data: { email: 'new@x.com', previousEmail: 'old@x.com' } }
    assert.deepEqual(await A.describeEmailAction('c2'), { email: 'new@x.com', previousEmail: 'old@x.com' })
    assert.deepEqual(fb.calls, [['checkActionCode', 'c2']])
  })

  it('applyEmailAction: applies the code once', async () => {
    await A.applyEmailAction('c2')
    assert.deepEqual(fb.calls, [['applyActionCode', 'c2']])
  })

  it('actionErrorMessage: plain messages for each case', () => {
    const used = 'This link has expired or has already been used. Request a new one from the sign-in page.'
    assert.equal(A.actionErrorMessage({ code: 'auth/expired-action-code' }), used)
    assert.equal(A.actionErrorMessage({ code: 'auth/invalid-action-code' }), used)
    assert.equal(A.actionErrorMessage({ code: 'auth/user-disabled' }), 'This account has been disabled.')
    assert.equal(A.actionErrorMessage({ code: 'auth/user-not-found' }), 'This account no longer exists.')
    assert.equal(A.actionErrorMessage({ code: 'auth/weak-password' }), 'That password is too weak. Use 6 to 20 characters.')
    assert.equal(A.actionErrorMessage({ code: 'auth/email-already-in-use' }), 'That email address is already used by another account.')
    assert.equal(A.actionErrorMessage(new Error('boom')), 'Something went wrong. Please try again.')
  })
})

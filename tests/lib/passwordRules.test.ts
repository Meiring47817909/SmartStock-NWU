// Port of the scratch harness check-password-rules.mts (4 checks), same assertions. firebase/auth is replaced by a fake
// validatePassword so no Firebase runs.
import assert from 'node:assert/strict'
import { beforeEach, describe, it, vi } from 'vitest'

const fb = vi.hoisted(() => ({
  vp: undefined as unknown,
  calls: [] as string[],
}))

vi.mock('firebase/auth', () => ({
  // fb.vp: { throws: code } or a PasswordValidationStatus-like object.
  async validatePassword(_auth: unknown, password: string) {
    fb.calls.push(password)
    const vp = fb.vp as { throws?: string } | undefined
    if (vp?.throws) throw Object.assign(new Error(vp.throws), { code: vp.throws })
    return vp
  },
}))

import type { Auth } from 'firebase/auth'
import { newPasswordProblem } from '@/lib/firebase/passwordRules'

const auth = { stub: 'auth' } as unknown as Auth
const EMU = { throws: 'auth/identitytoolkit.getpasswordpolicy-is-not-implemented-in-the-auth-emulator.' }

beforeEach(() => {
  fb.calls = []
})

describe('newPasswordProblem', () => {
  it('emulator (no password policy endpoint): does not throw, applies 6-20 locally', async () => {
    fb.vp = EMU
    assert.equal(await newPasswordProblem(auth, 'abc'), 'New password needs at least 6 characters.')
    assert.equal(await newPasswordProblem(auth, 'abcdef'), null)
    assert.equal(await newPasswordProblem(auth, 'x'.repeat(20)), null)
    assert.equal(await newPasswordProblem(auth, 'x'.repeat(21)), 'New password needs at most 20 characters.')
  })

  it('any other policy lookup failure also falls back to the local rule', async () => {
    fb.vp = { throws: 'auth/network-request-failed' }
    assert.equal(await newPasswordProblem(auth, 'abcdef'), null)
    assert.equal(await newPasswordProblem(auth, 'ab'), 'New password needs at least 6 characters.')
  })

  it('live policy, valid password -> null', async () => {
    fb.vp = { isValid: true, passwordPolicy: { customStrengthOptions: { minPasswordLength: 6, maxPasswordLength: 20 } } }
    assert.equal(await newPasswordProblem(auth, 'whatever'), null)
    assert.deepEqual(fb.calls, ['whatever'])
  })

  it('live policy, invalid -> lists exactly what is missing, with the live numbers', async () => {
    fb.vp = {
      isValid: false,
      passwordPolicy: { customStrengthOptions: { minPasswordLength: 8, maxPasswordLength: 30 } },
      meetsMinPasswordLength: false, containsUppercaseLetter: false, containsNumericCharacter: true,
    }
    assert.equal(await newPasswordProblem(auth, 'abc'), 'New password needs at least 8 characters, an uppercase letter.')
  })
})

// Checks for newPasswordProblem (FR-002 rule). firebase/auth is replaced by a fake
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
import { localPasswordMissing, newPasswordProblem, PASSWORD_MIN_LENGTH, PASSWORD_RULE_TEXT } from '@/lib/firebase/passwordRules'

const auth = { stub: 'auth' } as unknown as Auth
const EMU = { throws: 'auth/identitytoolkit.getpasswordpolicy-is-not-implemented-in-the-auth-emulator.' }

beforeEach(() => {
  fb.calls = []
})

describe('newPasswordProblem', () => {
  it('emulator (no password policy endpoint): does not throw, applies the FR-002 rule locally', async () => {
    fb.vp = EMU
    assert.equal(
      await newPasswordProblem(auth, 'abc'),
      'New password needs at least 12 characters, an uppercase letter, a number, a symbol.',
    )
    assert.equal(await newPasswordProblem(auth, 'password123'), 'New password needs at least 12 characters, an uppercase letter, a symbol.')
    assert.equal(await newPasswordProblem(auth, 'Password1234'), 'New password needs a symbol.')
    assert.equal(await newPasswordProblem(auth, 'PASSWORD123!'), 'New password needs a lowercase letter.')
    assert.equal(await newPasswordProblem(auth, 'Password123!'), null)
    // No upper limit any more (the old rule capped at 20).
    assert.equal(await newPasswordProblem(auth, 'Aa1!' + 'x'.repeat(40)), null)
  })

  it('any other policy lookup failure also falls back to the local rule', async () => {
    fb.vp = { throws: 'auth/network-request-failed' }
    assert.equal(await newPasswordProblem(auth, 'Password123!'), null)
    assert.equal(await newPasswordProblem(auth, 'Pass1!'), 'New password needs at least 12 characters.')
  })

  it('FR-002 rule text and helper agree', () => {
    assert.equal(PASSWORD_MIN_LENGTH, 12)
    assert.equal(PASSWORD_RULE_TEXT, 'at least 12 characters, with an uppercase letter, a lowercase letter, a number and a symbol')
    assert.deepEqual(localPasswordMissing('Password123!'), [])
    assert.deepEqual(localPasswordMissing('my password!'), ['an uppercase letter', 'a number'])
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

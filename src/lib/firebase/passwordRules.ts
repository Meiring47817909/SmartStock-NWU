import { validatePassword, type Auth } from 'firebase/auth'

// FR-002, the same rule scripts/set-password-policy.mjs sets on the live
// Firebase project: at least 12 characters, with an uppercase letter, a
// lowercase letter, a number and a symbol.
export const PASSWORD_MIN_LENGTH = 12
export const PASSWORD_RULE_TEXT =
  `at least ${PASSWORD_MIN_LENGTH} characters, with an uppercase letter, a lowercase letter, a number and a symbol`

// What `password` is missing under the FR-002 rule (empty when it is fine).
export function localPasswordMissing(password: string): string[] {
  const missing: string[] = []
  if (password.length < PASSWORD_MIN_LENGTH) missing.push(`at least ${PASSWORD_MIN_LENGTH} characters`)
  if (!/[A-Z]/.test(password)) missing.push('an uppercase letter')
  if (!/[a-z]/.test(password)) missing.push('a lowercase letter')
  if (!/[0-9]/.test(password)) missing.push('a number')
  if (!/[^A-Za-z0-9]/.test(password)) missing.push('a symbol')
  return missing
}

// Returns what is wrong with a new password, or null when it is fine.
//
// Normally this checks against the live Firebase Auth password policy, so
// the form always matches what the server enforces. The Firebase Auth
// emulator does not implement the password policy lookup (validatePassword
// always throws there), so when the lookup fails the same FR-002 rule is
// checked here instead. Firebase still enforces its own policy when the
// password is saved.
export async function newPasswordProblem(auth: Auth, password: string): Promise<string | null> {
  let status: Awaited<ReturnType<typeof validatePassword>>
  try {
    status = await validatePassword(auth, password)
  } catch {
    const missing = localPasswordMissing(password)
    return missing.length > 0 ? `New password needs ${missing.join(', ')}.` : null
  }
  if (status.isValid) return null

  const missing: string[] = []
  const opts = status.passwordPolicy.customStrengthOptions
  if (status.meetsMinPasswordLength === false) missing.push(`at least ${opts.minPasswordLength} characters`)
  if (status.meetsMaxPasswordLength === false) missing.push(`at most ${opts.maxPasswordLength} characters`)
  if (status.containsUppercaseLetter === false) missing.push('an uppercase letter')
  if (status.containsLowercaseLetter === false) missing.push('a lowercase letter')
  if (status.containsNumericCharacter === false) missing.push('a number')
  if (status.containsNonAlphanumericCharacter === false) missing.push('a symbol')
  return `New password needs ${missing.join(', ')}.`
}

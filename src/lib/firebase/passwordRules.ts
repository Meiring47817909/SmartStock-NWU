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
// The FR-002 rule is always checked here first, so the form never accepts a
// password the rule refuses, even before the live Firebase policy has been
// updated (scripts/set-password-policy.mjs). The live Firebase Auth policy is
// then checked as well, in case it is ever stricter. The Firebase Auth
// emulator does not implement the policy lookup (validatePassword always
// throws there), so a failed lookup leaves the FR-002 check as the answer.
// Firebase still enforces its own policy when the password is saved.
export async function newPasswordProblem(auth: Auth, password: string): Promise<string | null> {
  const localMissing = localPasswordMissing(password)
  if (localMissing.length > 0) return `New password needs ${localMissing.join(', ')}.`

  let status: Awaited<ReturnType<typeof validatePassword>>
  try {
    status = await validatePassword(auth, password)
  } catch {
    return null
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

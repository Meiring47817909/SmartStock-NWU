import { validatePassword, type Auth } from 'firebase/auth'

// The same rule scripts/set-password-policy.mjs sets on the live Firebase
// project: 6-20 characters, no character-type requirements.
const LOCAL_MIN_LENGTH = 6
const LOCAL_MAX_LENGTH = 20

// Returns what is wrong with a new password, or null when it is fine.
//
// Normally this checks against the live Firebase Auth password policy, so
// the form always matches what the server enforces. The Firebase Auth
// emulator does not implement the password policy lookup (validatePassword
// always throws there), so when the lookup fails the same 6-20 rule is
// checked here instead. Firebase still enforces its own policy when the
// password is saved.
export async function newPasswordProblem(auth: Auth, password: string): Promise<string | null> {
  let status: Awaited<ReturnType<typeof validatePassword>>
  try {
    status = await validatePassword(auth, password)
  } catch {
    if (password.length < LOCAL_MIN_LENGTH) return `New password needs at least ${LOCAL_MIN_LENGTH} characters.`
    if (password.length > LOCAL_MAX_LENGTH) return `New password needs at most ${LOCAL_MAX_LENGTH} characters.`
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
  if (status.containsNonAlphanumericCharacter === false) missing.push('a special character')
  return `New password needs ${missing.join(', ')}.`
}

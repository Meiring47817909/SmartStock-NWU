import { applyActionCode, checkActionCode, confirmPasswordReset, verifyPasswordResetCode } from 'firebase/auth'
import { auth } from '@/lib/firebase/config'
import { newPasswordProblem } from '@/lib/firebase/passwordRules'

// Helpers for the /auth/action page, which handles the links in the account
// emails (reset password, confirm new email, restore email). Firebase still
// checks and applies every one-time code; this page only replaces Firebase's
// own handler page with one in the app's style.

export type AccountActionMode = 'resetPassword' | 'verifyAndChangeEmail' | 'recoverEmail'

const MODES: readonly AccountActionMode[] = ['resetPassword', 'verifyAndChangeEmail', 'recoverEmail']

export interface AccountAction {
  mode: AccountActionMode
  oobCode: string
}

// Reads the action and its code from the link; null for anything else.
export function parseAction(params: { get(name: string): string | null }): AccountAction | null {
  const mode = params.get('mode')
  const oobCode = params.get('oobCode')
  if (!oobCode || !mode || !(MODES as readonly string[]).includes(mode)) return null
  return { mode: mode as AccountActionMode, oobCode }
}

// Checks a reset link is still valid and returns the account's email.
export async function startPasswordReset(oobCode: string): Promise<string> {
  return verifyPasswordResetCode(auth, oobCode)
}

// Saves the new password. Returns what is wrong with it (nothing saved), or
// null once saved. Firebase errors such as an expired link are thrown.
export async function finishPasswordReset(oobCode: string, password: string, confirmation: string): Promise<string | null> {
  if (password !== confirmation) return "New password and confirmation don't match."
  const problem = await newPasswordProblem(auth, password)
  if (problem) return problem
  await confirmPasswordReset(auth, oobCode, password)
  return null
}

// For an email link: the address it will set, and the one it replaces.
export async function describeEmailAction(oobCode: string): Promise<{ email: string | null; previousEmail: string | null }> {
  const info = await checkActionCode(auth, oobCode)
  return { email: info.data.email ?? null, previousEmail: info.data.previousEmail ?? null }
}

export async function applyEmailAction(oobCode: string): Promise<void> {
  await applyActionCode(auth, oobCode)
}

export function actionErrorMessage(err: unknown): string {
  switch ((err as { code?: unknown })?.code) {
    case 'auth/expired-action-code':
    case 'auth/invalid-action-code':
      return 'This link has expired or has already been used. Request a new one from the sign-in page.'
    case 'auth/user-disabled':
      return 'This account has been disabled.'
    case 'auth/user-not-found':
      return 'This account no longer exists.'
    case 'auth/weak-password':
      return 'That password is too weak. Use 6 to 20 characters.'
    case 'auth/email-already-in-use':
      return 'That email address is already used by another account.'
    default:
      return 'Something went wrong. Please try again.'
  }
}

import { EmailAuthProvider, reauthenticateWithCredential, type User } from 'firebase/auth'
import { auth } from '@/lib/firebase/config'

function failure(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}

// Re-checks the current password of the account that is signed in, as
// Firebase requires before a password or email change. The email is read
// fresh from Firebase (reload) rather than from what the page showed when
// it opened: after an email change confirmed in another tab, the page still
// holds the old address, and re-checking with it fails (auth/user-mismatch).
export async function confirmCurrentPassword(password: string): Promise<User> {
  const user = auth.currentUser
  if (!user) throw failure('auth/no-current-user', 'You are signed out. Sign in again and retry.')
  try {
    await user.reload()
  } catch (err) {
    const code = (err as { code?: unknown })?.code
    if (code === 'auth/user-token-expired' || code === 'auth/user-not-found' || code === 'auth/user-disabled') {
      throw failure(String(code), 'Your session has ended because your login changed. Sign out and sign in again with your current email.')
    }
    throw err
  }
  if (!user.email) throw failure('auth/no-current-user', 'This account has no login email. Sign in again and retry.')
  await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, password))
  return user
}

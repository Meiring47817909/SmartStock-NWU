import { sendPasswordResetEmail, verifyBeforeUpdateEmail, type User } from 'firebase/auth'
import { auth } from '@/lib/firebase/config'

// Client side of the account emails (forgot password, change email). Each
// asks the server to send the email through the mailer (Mailpit). When the
// server says mail is off ('mail_disabled') it falls back to Firebase's own
// email, exactly as before. Errors carry a Firebase-style `code` where the
// pages already branch on one.

type CodedError = Error & { code?: string }

function failure(message: string, code?: string): CodedError {
  const err: CodedError = new Error(message)
  if (code) err.code = code
  return err
}

interface ServerAnswer {
  error?: string
  sent?: boolean
  reason?: string
}

async function post(path: string, body: unknown, token?: string): Promise<{ status: number; data: ServerAnswer } | null> {
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    })
    return { status: res.status, data: (await res.json().catch(() => ({}))) as ServerAnswer }
  } catch {
    return null
  }
}

export async function requestPasswordReset(email: string): Promise<void> {
  const res = await post('/api/auth/forgot-password', { email })
  if (!res) throw failure('Failed to send reset email. Please try again.')
  if (res.status === 400) throw failure(res.data?.error ?? 'Enter a valid email address.', 'auth/invalid-email')
  if (res.status < 200 || res.status >= 300) throw failure(res.data?.error ?? 'Failed to send reset email.')
  if (res.data?.sent) return
  await sendPasswordResetEmail(auth, email)
}

// Re-check the current password first (reauthenticateWithCredential), so the
// token fetched here carries a fresh sign-in time.
export async function requestEmailChange(user: User, newEmail: string): Promise<void> {
  const token = await user.getIdToken(true)
  const res = await post('/api/auth/change-email', { newEmail }, token)
  if (!res) throw failure('Failed to send confirmation email.')
  if (res.status === 409) throw failure(res.data?.error ?? 'This email is already used by another account.', 'auth/email-already-in-use')
  if (res.status === 400) throw failure(res.data?.error ?? 'Enter a valid email address.', 'auth/invalid-email')
  if (res.status < 200 || res.status >= 300) throw failure(res.data?.error ?? 'Failed to send confirmation email.')
  if (res.data?.sent) return
  await verifyBeforeUpdateEmail(user, newEmail)
}

// A fetch wrapper for the admin-only /api/staff/* routes that call Firebase
// Auth (which need a Firebase ID token to prove the caller is actually signed
// in as an admin — see src/lib/server/staffAdmin.ts). Staff records
// themselves are read and written through src/lib/api/staff.ts; the shared
// email normalizer is normalizeEmail in src/lib/staffRules.ts.

import type { User } from 'firebase/auth'

// Calls one of the admin-only /api/staff/* routes with the caller's
// Firebase ID token attached, and throws with the server's error message
// on failure so callers can just try/catch.
export async function postStaffAdmin<T>(
  path: string,
  user: User,
  body: Record<string, unknown>,
): Promise<T> {
  const idToken = await user.getIdToken()
  const res = await fetch(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data.error ?? `Request to ${path} failed (${res.status}).`)
  }
  return data as T
}

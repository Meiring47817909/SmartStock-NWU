// Client-side helpers for the Staff page: email-uniqueness checks against
// the `staff` collection, and a small fetch wrapper for the admin-only
// /api/staff/* routes (which need a Firebase ID token to prove the caller
// is actually signed in as an admin — see src/lib/server/staffAdmin.ts).

import { db } from './config'
import { collection, getDocs, query, where } from 'firebase/firestore'
import type { User } from 'firebase/auth'

// Firebase Auth treats email as case-insensitive, so every place that
// stores or compares a staff email needs to agree on the same normalized
// form, or a duplicate could slip past the check below by casing alone.
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

// Checks whether any *other* staff document already has this email.
// Returns the conflicting record (id + display name), or null if there's
// no conflict. Pass excludeId (the document being edited, if any) so
// saving a record without touching its email doesn't flag itself.
export async function findStaffEmailConflict(
  email: string,
  excludeId?: string,
): Promise<{ id: string; full_name: string } | null> {
  const normalized = normalizeEmail(email)
  if (!normalized) return null

  const snap = await getDocs(
    query(collection(db, 'staff'), where('email', '==', normalized)),
  )
  for (const d of snap.docs) {
    if (d.id === excludeId) continue
    return { id: d.id, full_name: (d.data().full_name as string) ?? 'Unknown' }
  }
  return null
}

// Calls one of the admin-only /api/staff/* routes with the caller's
// Firebase ID token attached, and throws with the server's error message
// on failure so callers can just try/catch like any other Firestore call.
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

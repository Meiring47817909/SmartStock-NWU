'use client'

import { createContext, useContext, useEffect, useState } from 'react'
import { auth } from '@/lib/firebase/config'
import { onAuthStateChanged, User } from 'firebase/auth'
import { withAuthRaceRetry } from '@/lib/firebase/authRace'
import { loadMe } from '@/lib/api/me'
import type { Profile } from '@/types/database'

interface AuthContextValue {
  user: User | null
  profile: Profile | null
  loading: boolean
  // Re-reads the signed-in user's profile without waiting for another onAuthStateChanged
  // firing. Needed after (protected)/profile updates full_name via the
  // Admin SDK (the browser can't write `profiles` directly), which otherwise leaves this context's cached profile
  // showing the old name until the next sign-in. A no-op while signed out.
  refreshProfile: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  profile: null,
  loading: true,
  refreshProfile: async () => {},
})

async function fetchProfile(setProfile: (p: Profile | null) => void) {
  try {
    // GET /api/me reads PostgreSQL through the server, so there is no
    // local cache to be stale. This read decides BICS-vs-portal routing.
    // withAuthRaceRetry absorbs a 401 from the brief window right after
    // sign-in when the fresh ID token is not yet accepted.
    const me = await withAuthRaceRetry(() => loadMe())
    if (me.profile) {
      setProfile(me.profile)
    } else {
      // No profile row — this is exactly what a lending-portal
      // borrower account looks like (see StaffPortalContext), among
      // other cases. Do NOT synthesize a default role:'staff' Profile
      // here: this app's Firebase Auth project is shared between BICS
      // operators and portal borrowers, and a portal-only account
      // must never be treated as a valid BICS user just because it
      // authenticated successfully. (protected)/layout.tsx redirects
      // to /login with an error when profile is null.
      setProfile(null)
    }
  } catch (e) {
    console.error("Error fetching profile", e)
    setProfile(null)
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currUser) => {
      setUser(currUser)
      if (!currUser) {
        setProfile(null)
        setLoading(false)
        return
      }

      // onAuthStateChanged can fire more than once during a sign-in
      // transition (e.g. an initial unauthenticated firing that already
      // settled loading to false, followed by the real signed-in firing).
      // Re-opening the loading gap here for every firing that has async
      // work to do — not just the first one ever — matters: without it, a
      // consumer that reads {loading, profile} mid-fetch on a LATER firing
      // sees loading:false (left over from an earlier firing) next to a
      // still-stale profile, and acts on that inconsistent snapshot before
      // this fetch resolves — e.g. (protected)/layout.tsx redirecting to
      // /login?error=no-profile a moment before the real profile arrives.
      setLoading(true)
      await fetchProfile(setProfile)
      setLoading(false)
    })
    return () => unsubscribe()
  }, [])

  async function refreshProfile() {
    if (auth.currentUser) await fetchProfile(setProfile)
  }

  return (
    <AuthContext.Provider value={{ user, profile, loading, refreshProfile }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}

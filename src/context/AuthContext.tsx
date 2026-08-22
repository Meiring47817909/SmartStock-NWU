'use client'

import { createContext, useContext, useEffect, useState } from 'react'
import { auth, db } from '@/lib/firebase/config'
import { onAuthStateChanged, User } from 'firebase/auth'
import { doc, getDocFromServer } from 'firebase/firestore'
import { withAuthRaceRetry } from '@/lib/firebase/authRace'
import type { Profile } from '@/types/database'

interface AuthContextValue {
  user: User | null
  profile: Profile | null
  loading: boolean
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  profile: null,
  loading: true,
})

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
      try {
        const docRef = doc(db, 'profiles', currUser.uid)
        // getDocFromServer, not getDoc: right after a fresh sign-in the
        // persistent local-cache layer has no watch stream established for
        // this path yet, and plain getDoc() can resolve from that empty
        // cache before the server round-trip finishes — silently returning
        // "does not exist" for an account that has a profile. This read
        // decides BICS-vs-portal routing, so it needs the authoritative
        // server answer, not a cache-tolerant one.
        const docSnap = await withAuthRaceRetry(() => getDocFromServer(docRef))
        if (docSnap.exists()) {
          setProfile(docSnap.data() as Profile)
        } else {
          // No profiles/{uid} doc — this is exactly what a lending-portal
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
      setLoading(false)
    })
    return () => unsubscribe()
  }, [])

  return (
    <AuthContext.Provider value={{ user, profile, loading }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}

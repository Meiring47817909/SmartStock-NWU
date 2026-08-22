'use client'

import { createContext, useContext, useEffect, useState } from 'react'
import { auth, db } from '@/lib/firebase/config'
import { onAuthStateChanged, User } from 'firebase/auth'
import { doc, getDoc } from 'firebase/firestore'
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
      if (currUser) {
        try {
          const docRef = doc(db, 'profiles', currUser.uid)
          const docSnap = await getDoc(docRef)
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
        }
      } else {
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

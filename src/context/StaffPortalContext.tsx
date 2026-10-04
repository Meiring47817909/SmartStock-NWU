'use client'

import { createContext, useContext, useEffect, useState } from 'react'
import { auth } from '@/lib/firebase/config'
import { onAuthStateChanged, User } from 'firebase/auth'
import { withAuthRaceRetry } from '@/lib/firebase/authRace'
import { loadMe } from '@/lib/api/me'
import type { StaffMember } from '@/types/database'

interface StaffPortalContextValue {
  user: User | null
  staffMember: StaffMember | null
  loading: boolean
}

const StaffPortalContext = createContext<StaffPortalContextValue>({
  user: null,
  staffMember: null,
  loading: true,
})

export function StaffPortalProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [staffMember, setStaffMember] = useState<StaffMember | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currUser) => {
      setUser(currUser)
      if (!currUser) {
        // No account signed in — the portal now allows browsing Browse/Cart
        // as a guest (see firestore.rules' public `products` read and
        // (portal)/lend/layout.tsx's isGuest handling); there's simply no
        // staff record to look up for a guest.
        setStaffMember(null)
        setLoading(false)
        return
      }

      // Re-open the loading gap for every firing that has async work to
      // do, not just the first one ever — see the identical comment in
      // AuthContext.tsx for why: onAuthStateChanged can fire more than
      // once during a sign-in transition, and without this a consumer
      // mounting between firings sees a stale loading:false next to a
      // not-yet-updated staffMember.
      setLoading(true)
      try {
        // GET /api/me reads PostgreSQL through the server (same call as
        // AuthContext's profile lookup), wrapped in withAuthRaceRetry to
        // absorb a 401 right after a fresh sign-in.
        const me = await withAuthRaceRetry(() => loadMe())
        // No staff row links to this Firebase Auth user — this is
        // NOT the same situation as AuthContext's BICS profile lookup
        // synthesizing a fallback (which was the bug fixed there). Never
        // synthesize a fallback StaffMember either: an unlinked account
        // must show the portal layout's "not linked" dead-end, not
        // silently proceed as some default borrower.
        setStaffMember(me.staff)
      } catch (e) {
        console.error('Error fetching staff record', e)
        setStaffMember(null)
      }
      setLoading(false)
    })
    return () => unsubscribe()
  }, [])

  return (
    <StaffPortalContext.Provider value={{ user, staffMember, loading }}>
      {children}
    </StaffPortalContext.Provider>
  )
}

export function useStaffPortal() {
  return useContext(StaffPortalContext)
}

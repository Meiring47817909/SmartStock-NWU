'use client'

import { createContext, useContext, useEffect, useState } from 'react'
import { auth, db } from '@/lib/firebase/config'
import { onAuthStateChanged, User } from 'firebase/auth'
import { collection, query, where, getDocsFromServer } from 'firebase/firestore'
import { withAuthRaceRetry } from '@/lib/firebase/authRace'
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
        // getDocsFromServer, not getDocs — same reasoning as AuthContext's
        // profile lookup: right after a fresh sign-in this can otherwise
        // resolve from an empty local cache before the server round-trip
        // finishes, falsely reporting no linked staff record.
        const snap = await withAuthRaceRetry(() =>
          getDocsFromServer(query(collection(db, 'staff'), where('uid', '==', currUser.uid))),
        )
        // No StaffMember doc links to this Firebase Auth user — this is
        // NOT the same situation as AuthContext's BICS profile lookup
        // synthesizing a fallback (which was the bug fixed there). Never
        // synthesize a fallback StaffMember either: an unlinked account
        // must show the portal layout's "not linked" dead-end, not
        // silently proceed as some default borrower.
        setStaffMember(snap.empty ? null : ({ id: snap.docs[0].id, ...snap.docs[0].data() } as unknown as StaffMember))
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

'use client'

import { createContext, useContext, useEffect, useState } from 'react'
import { auth, db } from '@/lib/firebase/config'
import { onAuthStateChanged, User } from 'firebase/auth'
import { collection, query, where, getDocs } from 'firebase/firestore'
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
      if (currUser) {
        try {
          const snap = await getDocs(query(collection(db, 'staff'), where('uid', '==', currUser.uid)))
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
      } else {
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

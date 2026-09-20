'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Sidebar from '@/components/layout/Sidebar'
import { SidebarProvider } from '@/components/ui/sidebar'
import { RoleProvider } from '@/context/RoleContext'
import { useAuth } from '@/context/AuthContext'
import type { Profile, Role } from '@/types/database'

// Every route under (protected) is BICS, and BICS is admin-only — the
// 'staff' role's entire surface is the lending portal at /lend. There's no
// per-route list any more because there's nothing left to differentiate:
// if you're not an admin you don't belong anywhere in this tree.

export default function ProtectedLayout({ children }: { children: React.ReactNode }) {
  const { user, profile, loading } = useAuth()
  const router = useRouter()

  const role = (profile?.role ?? 'staff') as Role

  useEffect(() => {
    if (!loading) {
      if (!user) {
        router.push('/login')
        return
      }

      // Two ways to be a non-admin, both meaning the same thing: no
      // profiles/{uid} doc at all (the ordinary portal-borrower shape — see
      // StaffPortalContext), or a profile explicitly carrying role 'staff'.
      // Either way BICS is not theirs, so send them to the portal rather
      // than bouncing them back to /login with an error — /lend has its own
      // "your account isn't linked" dead-end screen for the case where they
      // have no staff record either, which is a far clearer answer than a
      // login-page error string.
      if (!profile || role !== 'admin') {
        router.push('/lend')
        return
      }
    }
  }, [user, profile, role, loading, router])

  if (loading || !user || !profile || role !== 'admin') {
    return <div style={{ display: 'flex', height: '100vh', alignItems: 'center', justifyContent: 'center' }}>Loading...</div>
  }

  return (
    <RoleProvider role={role}>
      <SidebarProvider style={{ minHeight: '100vh', height: '100vh', overflow: 'hidden' } as React.CSSProperties}>
        <Sidebar profile={profile as Profile | null} />
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <main style={{ flex: 1, display: 'flex', flexDirection: 'column', overflowY: 'auto', padding: '1.5rem 2rem' }}>
            {children}
          </main>
        </div>
      </SidebarProvider>
    </RoleProvider>
  )
}

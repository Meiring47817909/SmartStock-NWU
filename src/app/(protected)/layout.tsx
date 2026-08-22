'use client'

import { useEffect } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { WifiOff } from 'lucide-react'
import Sidebar from '@/components/layout/Sidebar'
import OfflineBanner from '@/components/layout/OfflineBanner'
import TabConflictScreen from '@/components/layout/TabConflictScreen'
import { SidebarProvider } from '@/components/ui/sidebar'
import { RoleProvider } from '@/context/RoleContext'
import { useAuth } from '@/context/AuthContext'
import { useOnlineStatus } from '@/hooks/useOnlineStatus'
import { useSingleTabLock } from '@/hooks/useSingleTabLock'
import type { Profile, Role } from '@/types/database'

// Routes restricted to admin only
const ADMIN_ONLY = ['/staff', '/audit-log']
// Routes restricted to admin + manager
const MANAGER_PLUS = ['/reports', '/loan-requests']

export default function ProtectedLayout({ children }: { children: React.ReactNode }) {
  const { user, profile, loading } = useAuth()
  const router = useRouter()
  const pathname = usePathname()
  const isOnline = useOnlineStatus()

  // Derived before any early return so hook order stays stable across
  // renders (useSingleTabLock must always be called, loading or not).
  const role = (profile?.role ?? 'staff') as Role
  const isAdmin = role === 'admin'

  // Enforced for admins only — staff/manager can open as many tabs as they
  // like. Prevents an admin from accidentally working out of two tabs at
  // once (e.g. one stale, one current) and confusing themselves about which
  // is authoritative.
  const tabLock = useSingleTabLock(isAdmin)

  useEffect(() => {
    if (!loading) {
      if (!user) {
        router.push('/login')
        return
      }

      // A Firebase Auth user with no profiles/{uid} doc is exactly what a
      // lending-portal borrower account looks like (see StaffPortalContext) —
      // AuthContext no longer synthesizes a fake role:'staff' Profile for
      // this case, so treat it as an auth error rather than letting them
      // fall through to BICS with a default role.
      if (!profile) {
        router.push('/login?error=no-profile')
        return
      }

      if (ADMIN_ONLY.some(p => pathname.startsWith(p)) && role !== 'admin') {
        router.push('/dashboard')
      }
      if (MANAGER_PLUS.some(p => pathname.startsWith(p)) && role === 'staff') {
        router.push('/dashboard')
      }
    }
  }, [user, profile, role, loading, pathname, router])

  if (loading || !user || !profile) {
    return <div style={{ display: 'flex', height: '100vh', alignItems: 'center', justifyContent: 'center' }}>Loading...</div>
  }

  if (tabLock.status === 'checking') {
    return <div style={{ display: 'flex', height: '100vh', alignItems: 'center', justifyContent: 'center' }}>Loading...</div>
  }

  if (tabLock.status === 'blocked') {
    return <TabConflictScreen onRetry={tabLock.retry} />
  }

  // Only admins are allowed to keep working while offline (per NWU BICS
  // policy — stock movements from other roles need a live connection so
  // they aren't recorded against stale local data). Everyone else sees a
  // reconnect screen instead of a broken/half-functional app.
  if (!isOnline && !isAdmin) {
    return (
      <div style={{ display: 'flex', height: '100vh', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: '0.75rem', padding: '2rem', textAlign: 'center' }}>
        <WifiOff size={40} color="var(--nwu-grey-light)" />
        <h1 style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--nwu-black)', margin: 0 }}>You&apos;re offline</h1>
        <p style={{ color: 'var(--nwu-grey)', fontSize: '0.9rem', maxWidth: 360, margin: 0 }}>
          An internet connection is required for your account to continue. Please reconnect and try again.
        </p>
      </div>
    )
  }

  return (
    <RoleProvider role={role}>
      <SidebarProvider style={{ minHeight: '100vh', height: '100vh', overflow: 'hidden' } as React.CSSProperties}>
        <Sidebar profile={profile as Profile | null} />
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {!isOnline && <OfflineBanner />}
          <main style={{ flex: 1, overflowY: 'auto', padding: '1.5rem 2rem' }}>
            {children}
          </main>
        </div>
      </SidebarProvider>
    </RoleProvider>
  )
}

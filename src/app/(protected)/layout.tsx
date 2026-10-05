'use client'

import { useEffect } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import Sidebar from '@/components/layout/Sidebar'
import AdminTopBar from '@/components/layout/AdminTopBar'
import { useAdminNavCounts } from '@/components/layout/adminNav'
import { SidebarProvider } from '@/components/ui/sidebar'
import { RoleProvider } from '@/context/RoleContext'
import { useAuth } from '@/context/AuthContext'
import { consumeLoggingOut } from '@/lib/authTransition'
import type { Profile, Role } from '@/types/database'

// Every route under (protected) is BICS, and BICS is admin-only — the
// 'staff' role's entire surface is the lending portal at /lend. There's no
// per-route list any more because there's nothing left to differentiate:
// if you're not an admin you don't belong anywhere in this tree.

export default function ProtectedLayout({ children }: { children: React.ReactNode }) {
  const { user, profile, loading } = useAuth()
  const router = useRouter()
  const pathname = usePathname()

  const role = (profile?.role ?? 'staff') as Role
  // Nav badge counts, shared by the Sidebar and the narrow-screen top bar.
  // Only fetched once an admin is signed in.
  const navCounts = useAdminNavCounts(pathname, role === 'admin' && !!user)

  // Route-specific NWU-purple-tinted canvas gradients (per the design
  // refresh) -- everything not listed here keeps the plain --nwu-bg
  // background main already had.
  const PAGE_BACKGROUNDS: Record<string, string> = {
    '/dashboard': 'linear-gradient(180deg, #E2DBEC 0%, #D4C8E2 100%)',
    '/loan-requests': 'linear-gradient(180deg, #E4DCF0 0%, #D5CCE4 100%)',
    '/staff': 'linear-gradient(180deg, #E4DCF0 0%, #D5CCE4 100%)',
    '/products': 'linear-gradient(135deg, #E6DFEE 0%, #DCD3E7 50%, #D2C7DF 100%)',
    // Same inventory-operations family as Products -- these four pages are
    // all transaction/list screens over the same stock data.
    '/categories': 'linear-gradient(135deg, #E6DFEE 0%, #DCD3E7 50%, #D2C7DF 100%)',
    '/returns': 'linear-gradient(135deg, #E6DFEE 0%, #DCD3E7 50%, #D2C7DF 100%)',
    '/stock-in': 'linear-gradient(135deg, #E6DFEE 0%, #DCD3E7 50%, #D2C7DF 100%)',
    '/stock-out': 'linear-gradient(135deg, #E6DFEE 0%, #DCD3E7 50%, #D2C7DF 100%)',
    // Same family as Dashboard -- another overview/monitoring screen.
    '/audit-log': 'linear-gradient(180deg, #E2DBEC 0%, #D4C8E2 100%)',
    // Reports' own NWU-Stitch mockup gradient (diagonal, 3-stop).
    '/reports': 'linear-gradient(135deg, #E6E0EE 0%, #DDD3E7 50%, #D5C9E2 100%)',
    '/profile': 'linear-gradient(180deg, #E4DCF0 0%, #D5CCE4 100%)',
    '/settings/notifications': 'linear-gradient(180deg, #E4DCF0 0%, #D5CCE4 100%)',
  }
  const pageBackground = PAGE_BACKGROUNDS[pathname]

  useEffect(() => {
    if (!loading) {
      if (!user) {
        // An intentional sign-out (Sidebar's handleLogout) already knows
        // where it wants to land — don't fight it by also redirecting to
        // /login for the same user:null transition. See authTransition.ts.
        if (consumeLoggingOut()) return
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
      <SidebarProvider
        style={{
          minHeight: '100vh',
          height: '100vh',
          overflow: 'hidden',
          // Wider than the shadcn default (3rem) — see Sidebar.tsx's
          // SIDEBAR_ICON_BUTTON_CLASS/SIDEBAR_ICON_BADGE_CLASS, which size
          // the collapsed nav icons and their badges to fit this rail.
          '--sidebar-width-icon': '6.5rem',
        } as React.CSSProperties}
      >
        <Sidebar profile={profile as Profile | null} counts={navCounts} />
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {/* Below md the Sidebar is hidden; this horizontal bar replaces it. */}
          <AdminTopBar profile={profile as Profile | null} counts={navCounts} />
          <main className="flex flex-1 flex-col overflow-y-auto px-4 py-4 sm:px-6 md:px-8 md:py-6" style={{ background: pageBackground }}>
            {children}
          </main>
        </div>
      </SidebarProvider>
    </RoleProvider>
  )
}

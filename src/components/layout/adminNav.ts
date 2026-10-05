'use client'

import { useEffect, useState } from 'react'
import type { useRouter } from 'next/navigation'
import type { LucideIcon } from 'lucide-react'
import {
  LayoutDashboard, Package, ArrowUpFromLine, ArrowDownToLine,
  Users, RotateCcw, BarChart2, ScrollText, Tag, ClipboardList, Settings,
} from 'lucide-react'
import { signOut } from 'firebase/auth'
import { auth } from '@/lib/firebase/config'
import { markLoggingOut } from '@/lib/authTransition'
import { loadDashboardAlertCounts } from '@/lib/api/dashboard'
import { loadLoanRequestsAlertCount } from '@/lib/api/loanRequests'
import { subscribeToAlertsChanged } from '@/lib/alertsBus'
import type { useRole } from '@/context/RoleContext'

// The admin navigation, shared by the desktop Sidebar and the narrow-screen
// AdminTopBar so both always list the same pages, in the same groups.

type Permissions = ReturnType<typeof useRole>

export type AdminNavBadge = 'alerts' | 'loanRequests'

export interface AdminNavItem {
  href: string
  label: string
  icon: LucideIcon
  /** Hidden when this returns false. Omitted = always shown. */
  visible?: (p: Permissions) => boolean
  badge?: AdminNavBadge
}

export interface AdminNavGroup {
  /** Section heading; the first group (Dashboard) has none. */
  label?: string
  items: AdminNavItem[]
}

export const ADMIN_NAV: AdminNavGroup[] = [
  { items: [{ href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, badge: 'alerts' }] },
  {
    label: 'Stock',
    items: [
      { href: '/stock-out', label: 'Stock Out', icon: ArrowUpFromLine },
      { href: '/stock-in', label: 'Stock In', icon: ArrowDownToLine },
      { href: '/returns', label: 'Returns', icon: RotateCcw },
    ],
  },
  {
    label: 'Catalogue',
    items: [
      { href: '/products', label: 'Products', icon: Package, visible: (p) => p.canManageProducts },
      { href: '/categories', label: 'Categories', icon: Tag, visible: (p) => p.canManageProducts },
    ],
  },
  {
    label: 'Admin',
    items: [
      { href: '/staff', label: 'Staff', icon: Users, visible: (p) => p.canManageStaff },
      { href: '/reports', label: 'Reports', icon: BarChart2, visible: (p) => p.canViewReports },
      { href: '/loan-requests', label: 'Loan Requests', icon: ClipboardList, visible: (p) => p.canManageLoanRequests, badge: 'loanRequests' },
      { href: '/audit-log', label: 'Audit Log', icon: ScrollText, visible: (p) => p.canManageStaff },
      { href: '/settings/notifications', label: 'Notifications', icon: Settings, visible: (p) => p.canManageSettings },
    ],
  },
]

/** The groups and items this admin may see; groups left empty are dropped. */
export function visibleAdminNav(p: Permissions): AdminNavGroup[] {
  return ADMIN_NAV
    .map((g) => ({ ...g, items: g.items.filter((i) => !i.visible || i.visible(p)) }))
    .filter((g) => g.items.length > 0)
}

export function isAdminNavActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(href + '/')
}

export interface AdminNavCounts {
  /** Dashboard's four "needs attention" widgets combined. */
  alerts: number | null
  /** Loan Requests' actionable tabs combined (History excluded). */
  loanRequests: number | null
}

/**
 * The two nav badge counts. Loaded on mount, again when the admin navigates
 * back to the page the count belongs to, whenever a page announces a change
 * on the alerts bus, when the tab regains focus, and every minute while it
 * is open (staff can change requests from their own devices at any time).
 * Called once in (protected)/layout.tsx and passed to both navs, so the
 * counts are only fetched once. Nothing is fetched until `enabled` (an
 * admin is signed in); both counts are admin-only.
 */
export function useAdminNavCounts(pathname: string, enabled: boolean): AdminNavCounts {
  const [alerts, setAlerts] = useState<number | null>(null)
  const [loanRequests, setLoanRequests] = useState<number | null>(null)
  const onDashboard = pathname === '/dashboard'
  const onLoanRequests = pathname === '/loan-requests'

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    loadDashboardAlertCounts().then((c) => { if (!cancelled) setAlerts(c.total) }).catch(() => {
      // Best-effort: the badge just stays hidden; the Dashboard is the source of truth.
    })
    return () => { cancelled = true }
  }, [onDashboard, enabled])

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    loadLoanRequestsAlertCount().then((n) => { if (!cancelled) setLoanRequests(n) }).catch(() => {})
    return () => { cancelled = true }
  }, [onLoanRequests, enabled])

  useEffect(() => {
    if (!enabled) return
    function refresh() {
      loadDashboardAlertCounts().then((c) => setAlerts(c.total)).catch(() => {})
      loadLoanRequestsAlertCount().then(setLoanRequests).catch(() => {})
    }
    function refreshIfVisible() {
      if (document.visibilityState !== 'hidden') refresh()
    }
    const unsubscribe = subscribeToAlertsChanged(refresh)
    const timer = window.setInterval(refreshIfVisible, 60_000)
    window.addEventListener('focus', refreshIfVisible)
    document.addEventListener('visibilitychange', refreshIfVisible)
    return () => {
      unsubscribe()
      window.clearInterval(timer)
      window.removeEventListener('focus', refreshIfVisible)
      document.removeEventListener('visibilitychange', refreshIfVisible)
    }
  }, [enabled])

  return { alerts, loanRequests }
}

/**
 * Signs the admin out and lands them on the public home page. markLoggingOut()
 * must run before signOut() (see authTransition.ts), or the layout's own
 * "no user, go to /login" redirect wins the race.
 */
export async function signOutAdmin(router: ReturnType<typeof useRouter>): Promise<void> {
  markLoggingOut()
  await signOut(auth)
  router.push('/')
}

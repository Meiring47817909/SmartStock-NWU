'use client'

import { useEffect, useState } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import {
  LayoutDashboard, Package, LogOut, ArrowUpFromLine, ArrowDownToLine,
  Users, RotateCcw, BarChart2, ScrollText, Tag, ClipboardList,
} from 'lucide-react'
import { signOut } from 'firebase/auth'
import { auth } from '@/lib/firebase/config'
import { loadDashboardAlertCounts } from '@/lib/firebase/dashboardAlerts'
import { loadLoanRequestsAlertCount } from '@/lib/firebase/loanRequests'
import { subscribeToAlertsChanged } from '@/lib/alertsBus'
import { useRole } from '@/context/RoleContext'
import {
  Sidebar as SidebarPrimitive, SidebarContent, SidebarFooter, SidebarGroup,
  SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarMenu,
  SidebarMenuButton, SidebarMenuItem,
} from '@/components/ui/sidebar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { Profile } from '@/types/database'

// Role badges use NWU brand colours: purple (admin) / grey (staff). A
// 'staff' badge should never actually render here — the portal has its own
// shell and non-admins never reach this sidebar — but the entry is kept so
// the lookup can't come back undefined.
const ROLE_BADGE_CLASS: Record<string, string> = {
  admin: 'bg-[#EDE3F2] text-[#522E6E]',
  staff: 'bg-white/15 text-white',
}

export default function Sidebar({ profile }: { profile: Profile | null }) {
  const pathname = usePathname()
  const router = useRouter()
  const { canManageProducts, canManageStaff, canViewReports, canManageLoanRequests } = useRole()
  // Combined total of the Dashboard's four "needs attention" widgets
  // (Outstanding Returns, Low Stock Alerts, Outstanding Loan Requests,
  // Incoming Pickups) - see lib/firebase/dashboardAlerts.ts. Loaded once
  // on mount (the Sidebar stays mounted across the whole protected app) and
  // refreshed whenever the admin navigates back to the Dashboard itself,
  // so resolving something there updates the badge without a full reload.
  const [alertCount, setAlertCount] = useState<number | null>(null)
  // Combined total of Loan Requests' three actionable tabs (Needs Review,
  // Sent Counters, Incoming Pickups) — History is excluded, see
  // lib/firebase/loanRequests.ts's loadLoanRequestsAlertCount().
  const [loanRequestCount, setLoanRequestCount] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    loadDashboardAlertCounts().then(counts => {
      if (!cancelled) setAlertCount(counts.total)
    }).catch(() => {
      // Best-effort: the badge just stays hidden if this fails, the
      // Dashboard page itself is still the source of truth.
    })
    return () => { cancelled = true }
  }, [pathname === '/dashboard'])

  useEffect(() => {
    if (!canManageLoanRequests) return
    let cancelled = false
    loadLoanRequestsAlertCount().then(count => {
      if (!cancelled) setLoanRequestCount(count)
    }).catch(() => {
      // Best-effort, same reasoning as the Dashboard badge above.
    })
    return () => { cancelled = true }
  }, [pathname === '/loan-requests', canManageLoanRequests])

  // Catches a count-changing mutation made in place on the Dashboard or
  // Loan Requests page itself (e.g. resolving an Outstanding Return),
  // where the pathname never changes so the two effects above never
  // re-fire on their own — see alertsBus.ts for why this is needed
  // alongside them rather than instead of them.
  useEffect(() => {
    return subscribeToAlertsChanged(() => {
      loadDashboardAlertCounts().then(counts => setAlertCount(counts.total)).catch(() => {})
      if (canManageLoanRequests) {
        loadLoanRequestsAlertCount().then(setLoanRequestCount).catch(() => {})
      }
    })
  }, [canManageLoanRequests])

  async function handleLogout() {
    await signOut(auth)
    router.push('/login')
  }

  const isActive = (href: string) =>
    pathname === href || pathname.startsWith(href + '/')

  const role = profile?.role ?? 'staff'

  return (
    <SidebarPrimitive collapsible="none" className="h-screen">
      <SidebarHeader className="border-b border-sidebar-border px-4 py-4">
        {/* SmartStock-NWU logo replaces the old "BICS" text lockup — the
            logo's own white rounded-square badge already carries the brand
            colours, so it sits directly on the purple sidebar background
            with no extra wrapper needed. */}
        <Image
          src="/smartstock-nwu-logo.png"
          alt="SmartStock-NWU"
          width={480}
          height={480}
          priority
          className="mx-auto h-auto w-[168px]"
        />
        <div className="mt-1.5 text-center text-[0.7rem] text-white/65">NWU IT Store · Potch</div>
      </SidebarHeader>

      <SidebarContent className="px-1.5 py-2">
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton render={<Link href="/dashboard" />} isActive={isActive('/dashboard')}>
                  <LayoutDashboard className="size-4" />
                  Dashboard
                  {!!alertCount && (
                    <Badge className="ml-auto bg-(--nwu-turquoise) text-white">{alertCount}</Badge>
                  )}
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel className="text-white/50">Stock</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton render={<Link href="/stock-out" />} isActive={isActive('/stock-out')}>
                  <ArrowUpFromLine className="size-4" /> Stock Out
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton render={<Link href="/stock-in" />} isActive={isActive('/stock-in')}>
                  <ArrowDownToLine className="size-4" /> Stock In
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton render={<Link href="/returns" />} isActive={isActive('/returns')}>
                  <RotateCcw className="size-4" /> Returns
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {canManageProducts && (
          <SidebarGroup>
            <SidebarGroupLabel className="text-white/50">Catalogue</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton render={<Link href="/products" />} isActive={isActive('/products')}>
                    <Package className="size-4" /> Products
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton render={<Link href="/categories" />} isActive={isActive('/categories')}>
                    <Tag className="size-4" /> Categories
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}

        {(canViewReports || canManageStaff) && (
          <SidebarGroup>
            <SidebarGroupLabel className="text-white/50">Admin</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {canManageStaff && (
                  <SidebarMenuItem>
                    <SidebarMenuButton render={<Link href="/staff" />} isActive={isActive('/staff')}>
                      <Users className="size-4" /> Staff
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )}
                {canViewReports && (
                  <SidebarMenuItem>
                    <SidebarMenuButton render={<Link href="/reports" />} isActive={isActive('/reports')}>
                      <BarChart2 className="size-4" /> Reports
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )}
                {canManageLoanRequests && (
                  <SidebarMenuItem>
                    <SidebarMenuButton render={<Link href="/loan-requests" />} isActive={isActive('/loan-requests')}>
                      <ClipboardList className="size-4" /> Loan Requests
                      {!!loanRequestCount && (
                        <Badge className="ml-auto bg-(--nwu-turquoise) text-white">{loanRequestCount}</Badge>
                      )}
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )}
                {canManageStaff && (
                  <SidebarMenuItem>
                    <SidebarMenuButton render={<Link href="/audit-log" />} isActive={isActive('/audit-log')}>
                      <ScrollText className="size-4" /> Audit Log
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border p-4">
        <div className="mb-1 truncate text-xs text-white/75">
          {profile?.full_name ?? profile?.id ?? 'User'}
        </div>
        <Badge className={`mb-3 ${ROLE_BADGE_CLASS[role] ?? ROLE_BADGE_CLASS.staff}`}>
          {role}
        </Badge>
        <Button
          onClick={handleLogout}
          className="mt-2 w-full justify-start gap-2 bg-(--nwu-btn-primary) text-white hover:bg-(--nwu-btn-primary-hover)"
        >
          <LogOut className="size-4" />
          Sign out
        </Button>
      </SidebarFooter>
    </SidebarPrimitive>
  )
}

'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import {
  LayoutDashboard, Package, LogOut, ArrowUpFromLine, ArrowDownToLine,
  Users, RotateCcw, BarChart2, ScrollText, Tag,
} from 'lucide-react'
import { signOut } from 'firebase/auth'
import { auth } from '@/lib/firebase/config'
import { useRole } from '@/context/RoleContext'
import {
  Sidebar as SidebarPrimitive, SidebarContent, SidebarFooter, SidebarGroup,
  SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarMenu,
  SidebarMenuButton, SidebarMenuItem,
} from '@/components/ui/sidebar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import InstallAppButton from './InstallAppButton'
import type { Profile } from '@/types/database'

// Role badges use NWU brand colours: purple (admin) / turquoise (manager) / grey (staff)
const ROLE_BADGE_CLASS: Record<string, string> = {
  admin: 'bg-[#EDE3F2] text-[#522E6E]',
  manager: 'bg-[#DFF3F6] text-[#026A79]',
  staff: 'bg-white/15 text-white',
}

export default function Sidebar({ profile }: { profile: Profile | null }) {
  const pathname = usePathname()
  const router = useRouter()
  const { canManageProducts, canManageStaff, canViewReports } = useRole()

  async function handleLogout() {
    await signOut(auth)
    router.push('/login')
  }

  const isActive = (href: string) =>
    pathname === href || pathname.startsWith(href + '/')

  const role = profile?.role ?? 'staff'

  return (
    <SidebarPrimitive collapsible="none" className="h-screen">
      <SidebarHeader className="border-b border-sidebar-border px-4 py-5">
        <div className="flex items-center gap-1.5 text-[1.1rem] font-bold tracking-tight text-white">
          <span className="size-2 shrink-0 rounded-full bg-(--nwu-turquoise)" />
          BICS
        </div>
        <div className="mt-0.5 text-[0.7rem] text-white/65">NWU IT Store · Potch</div>
      </SidebarHeader>

      <SidebarContent className="px-1.5 py-2">
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton render={<Link href="/dashboard" />} isActive={isActive('/dashboard')}>
                  <LayoutDashboard className="size-4" />
                  Dashboard
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
        <InstallAppButton />
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

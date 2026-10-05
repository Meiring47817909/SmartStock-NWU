'use client'

import Image from 'next/image'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { LogOut, User as UserIcon, ChevronLeft, ChevronRight } from 'lucide-react'
import { useRole } from '@/context/RoleContext'
import { isAdminNavActive, signOutAdmin, visibleAdminNav, type AdminNavCounts } from '@/components/layout/adminNav'
import {
  Sidebar as SidebarPrimitive, SidebarContent, SidebarFooter, SidebarGroup,
  SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarMenu,
  SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem, useSidebar,
} from '@/components/ui/sidebar'
import { Badge } from '@/components/ui/badge'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { nameInitials, avatarColorClass } from '@/lib/utils'
import type { Profile } from '@/types/database'

// Role badges use NWU brand colours: purple (admin) / grey (staff). A
// 'staff' badge should never actually render here — the portal has its own
// shell and non-admins never reach this sidebar — but the entry is kept so
// the lookup can't come back undefined.
const ROLE_BADGE_CLASS: Record<string, string> = {
  admin: 'bg-white/20 text-purple-100',
  staff: 'bg-white/15 text-white',
}

// Sampled off Improved_Sidebar.jpg (the reference mock) — a deep indigo top
// fading through the brand purple (--nwu-purple, #6C3D91) to a dustier
// magenta at the bottom, replacing the old flat --sidebar purple. Applied
// on a wrapper div rather than --sidebar itself: that CSS variable is
// consumed elsewhere as a plain background-color, which can't hold a
// gradient, and this wrapper also gives the collapse/expand toggle and
// logo below a single flex column to lay out in.
const SIDEBAR_GRADIENT = 'bg-gradient-to-b from-[#4A2467] via-[#401C5B] to-[#34164B]'

// Collapsed rail overrides for the nav buttons, plus a responsive, tighter
// row height for expanded mode (32px below the lg breakpoint, 40px at/above
// it — see the icon/label/logo responsive sizing alongside this) — the shadcn primitive's
// default collapsed size (size-8, 16px icon) reads as cramped once the rail
// itself is widened (see --sidebar-width-icon in (protected)/layout.tsx):
// bump the button to a centred 48px square. Both classes
// share the primitive's own 'group-data-[collapsible=icon]:' modifier, so
// tailwind-merge drops the primitive's smaller size in favour of this one
// rather than stacking two conflicting rules.
const SIDEBAR_ICON_BUTTON_CLASS =
  'h-8 lg:h-10 py-1 rounded-lg text-purple-100/80 data-active:bg-white/15 data-active:text-white data-active:shadow-inner data-active:font-semibold '
  + 'group-data-[collapsible=icon]:size-12! group-data-[collapsible=icon]:mx-auto group-data-[collapsible=icon]:justify-center'

// Collapsed-rail badge override — the primitive hides SidebarMenuBadge
// entirely once collapsed (no room next to a 32px icon). With the wider
// rail there's space to keep it visible: re-enable it, size it up slightly,
// and centre it vertically so it reads as "next to the icon" rather than a
// notification dot pinned to the button's corner.
const SIDEBAR_ICON_BADGE_CLASS =
  'group-data-[collapsible=icon]:flex group-data-[collapsible=icon]:h-6 group-data-[collapsible=icon]:min-w-6'

function SidebarCollapseToggle() {
  const { state, toggleSidebar } = useSidebar()
  const collapsed = state === 'collapsed'
  return (
    <button
      type="button"
      onClick={toggleSidebar}
      aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      className="flex size-7 shrink-0 items-center justify-center self-end rounded-md bg-white/15 text-white transition-colors hover:bg-white/25 focus-visible:outline-2 focus-visible:outline-white/60 group-data-[collapsible=icon]:self-center"
    >
      {collapsed ? <ChevronRight className="size-4" /> : <ChevronLeft className="size-4" />}
    </button>
  )
}

export default function Sidebar({ profile, counts }: { profile: Profile | null; counts: AdminNavCounts }) {
  const pathname = usePathname()
  const router = useRouter()
  const { state: sidebarState } = useSidebar()
  const railCollapsed = sidebarState === 'collapsed'
  // Pulls the badge in next to the icon instead of the far right edge of
  // the (now much wider) collapsed rail -- see the comment above this
  // component's other collapsed-only overrides for why this is inline
  // style rather than a class.
  const collapsedBadgeStyle = railCollapsed ? { left: '3rem', right: 'auto' } : undefined
  // The page list lives in adminNav.ts (shared with AdminTopBar, the
  // narrow-screen nav); the badge counts come from (protected)/layout.tsx.
  const groups = visibleAdminNav(useRole())

  const role = profile?.role ?? 'staff'

  return (
    // collapsible="icon" replaces the old collapsible="none" — the sidebar
    // can now shrink to an icon-only rail (SidebarCollapseToggle above
    // toggles it, and the shadcn primitive persists the choice in a cookie
    // and wires up the existing Cmd/Ctrl+B shortcut for free). See
    // Improved_Sidebar.jpg's "Collapsed State" column for the target look.
    <SidebarPrimitive collapsible="icon">
      <div className={`flex min-h-0 flex-1 flex-col ${SIDEBAR_GRADIENT}`}>
        <SidebarHeader className="gap-3 border-b border-white/10 px-3 py-4 lg:px-5 lg:pt-6 lg:pb-4">
          <SidebarCollapseToggle />

          {/* Full icon+wordmark lockup, expanded only. No more white card
              behind it (compare the old comment here) — the master SVG's
              navy/purple text reads at under 2:1 contrast directly on this
              gradient (WCAG AA needs 4.5:1), so this is a dedicated light
              variant (public/smartstock-nwu-logo-light.svg — same icon
              colours, recoloured text/hairlines) rather than the plain
              logo used on the login page and the lending portal header,
              both of which sit on light backgrounds. */}
          <div className="max-w-[117px] group-data-[collapsible=icon]:hidden lg:max-w-[176px]">
            {/* Scales to the header's full width at lg and up (SidebarHeader
                is a flex-col, so this wrapper stretches to it); capped
                narrower below that so its aspect-ratio-driven height doesn't
                eat into the vertical space smaller screens can't spare --
                width={920}/height={410} still give next/image the aspect
                ratio to size height from. */}
            <Image
              src="/smartstock-nwu-logo-light.svg"
              alt="SmartStock"
              width={360}
              height={120}
              priority
              unoptimized
              className="h-auto w-full"
            />
          </div>
          {/* Icon-only mark, collapsed only — a separate crop of the same
              artwork/colours (public/smartstock-nwu-icon.svg), not a resize
              of the full lockup, since the wordmark would be illegible at
              rail width anyway. */}
          <div className="hidden justify-center group-data-[collapsible=icon]:flex">
            <Image
              src="/smartstock-nwu-icon.svg"
              alt="SmartStock"
              width={100}
              height={100}
              priority
              unoptimized
              className="h-14 w-auto"
            />
          </div>

          <div className="text-[0.7rem] text-white/65 group-data-[collapsible=icon]:hidden lg:text-[0.8rem]">NWU IT Store · Potch</div>
        </SidebarHeader>

        <SidebarContent className="px-1.5 py-2 group-data-[collapsible=icon]:overflow-x-hidden group-data-[collapsible=icon]:overflow-y-auto">
          {groups.map((group) => (
            <SidebarGroup key={group.label ?? 'home'}>
              {group.label && (
                <SidebarGroupLabel className="text-[11px] font-bold tracking-wider text-purple-200/50 uppercase lg:text-xs">{group.label}</SidebarGroupLabel>
              )}
              <SidebarGroupContent>
                <SidebarMenu>
                  {group.items.map((item) => {
                    const Icon = item.icon
                    const badge = item.badge ? counts[item.badge] : null
                    return (
                      <SidebarMenuItem key={item.href}>
                        <SidebarMenuButton render={<Link href={item.href} />} isActive={isAdminNavActive(pathname, item.href)} className={SIDEBAR_ICON_BUTTON_CLASS} size="lg" tooltip={item.label}>
                          <Icon className="size-5 lg:size-7" />
                          <span className="text-sm lg:text-base group-data-[collapsible=icon]:hidden">{item.label}</span>
                        </SidebarMenuButton>
                        {!!badge && (
                          <SidebarMenuBadge className={`bg-(--nwu-turquoise) text-white text-sm ${SIDEBAR_ICON_BADGE_CLASS}`} style={collapsedBadgeStyle}>{badge}</SidebarMenuBadge>
                        )}
                      </SidebarMenuItem>
                    )
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
        </SidebarContent>

        <SidebarFooter className="border-t border-white/10 bg-[#2E1242]/70 p-3">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  className="flex w-full items-center gap-2.5 rounded-lg p-2 text-left outline-none hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-white/40 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0"
                />
              }
              aria-label={`Account menu for ${profile?.full_name ?? 'User'}`}
            >
              <Avatar className="size-9 shrink-0 ring-2 ring-white/20">
                <AvatarFallback className={`text-sm font-semibold text-white ${avatarColorClass(profile?.full_name ?? '')}`}>
                  {nameInitials(profile?.full_name ?? '')}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1 group-data-[collapsible=icon]:hidden">
                <div className="truncate text-sm font-medium text-white">
                  {profile?.full_name ?? profile?.id ?? 'User'}
                </div>
                <Badge className={`mt-0.5 ${ROLE_BADGE_CLASS[role] ?? ROLE_BADGE_CLASS.staff}`}>
                  {role}
                </Badge>
              </div>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="top" className="w-44">
              <DropdownMenuItem render={<Link href="/profile" />}>
                <UserIcon className="size-3.5" /> Profile
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => signOutAdmin(router)}>
                <LogOut className="size-3.5" /> Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarFooter>
      </div>
    </SidebarPrimitive>
  )
}

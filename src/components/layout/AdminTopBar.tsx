'use client'

import { Fragment } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { LogOut, Menu, User as UserIcon } from 'lucide-react'
import { useRole } from '@/context/RoleContext'
import { Badge } from '@/components/ui/badge'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { nameInitials, avatarColorClass } from '@/lib/utils'
import { isAdminNavActive, signOutAdmin, visibleAdminNav, type AdminNavCounts } from '@/components/layout/adminNav'
import type { Profile } from '@/types/database'

/**
 * The admin navigation on phones: narrower than 768px, or shorter than
 * 500px (a phone turned sideways). The shadcn Sidebar turns into a hidden
 * off-canvas panel there (see hooks/use-mobile.ts), so this horizontal bar
 * takes over, laid out like the lending portal's mobile header: a menu
 * button listing every page, the SmartStock logo, and the account menu.
 * Hidden on "roomy" screens (globals.css), where the Sidebar is back.
 */
export default function AdminTopBar({ profile, counts }: { profile: Profile | null; counts: AdminNavCounts }) {
  const pathname = usePathname()
  const router = useRouter()
  const groups = visibleAdminNav(useRole())
  const name = profile?.full_name ?? 'User'
  const totalBadge = (counts.alerts ?? 0) + (counts.loanRequests ?? 0)

  return (
    <header className="shrink-0 border-b bg-card roomy:hidden">
      <div className="flex items-center justify-between gap-3 px-4 py-2.5">
        <div className="flex items-center gap-3">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<button type="button" className="relative rounded-lg p-2 text-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring" />}
              aria-label="Open menu"
            >
              <Menu className="size-5" />
              {totalBadge > 0 && (
                <Badge className="absolute -top-1 -right-1 bg-(--nwu-turquoise) px-1 text-[10px] text-white">{totalBadge}</Badge>
              )}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-[75vh] w-56 overflow-y-auto">
              {groups.map((group, gi) => (
                <Fragment key={group.label ?? 'home'}>
                  {gi > 0 && <DropdownMenuSeparator />}
                  <DropdownMenuGroup>
                    {group.label && (
                      <DropdownMenuLabel className="text-[11px] font-bold tracking-wider text-muted-foreground uppercase">{group.label}</DropdownMenuLabel>
                    )}
                    {group.items.map((item) => {
                      const Icon = item.icon
                      const badge = item.badge ? counts[item.badge] : null
                      const active = isAdminNavActive(pathname, item.href)
                      return (
                        <DropdownMenuItem
                          key={item.href}
                          render={<Link href={item.href} />}
                          className={active ? 'bg-(--nwu-purple)/10 font-semibold text-(--nwu-purple)' : undefined}
                        >
                          <Icon className="size-3.5" /> {item.label}
                          {!!badge && <Badge className="ml-auto bg-(--nwu-turquoise) text-xs text-white">{badge}</Badge>}
                        </DropdownMenuItem>
                      )
                    })}
                  </DropdownMenuGroup>
                </Fragment>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Full lockup where it fits; just the icon mark below 500px,
              same as the lending portal header. */}
          <Link href="/dashboard" className="flex items-center">
            <Image src="/smartstock-nwu-logo.svg" alt="SmartStock" width={360} height={120} priority unoptimized className="h-12 w-auto max-dlg:hidden" />
            <Image src="/smartstock-nwu-icon.svg" alt="SmartStock" width={100} height={100} priority unoptimized className="hidden size-10 max-dlg:block" />
          </Link>
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger
            render={<button type="button" className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring" />}
            aria-label={`Account menu for ${name}`}
          >
            <Avatar className="size-10">
              <AvatarFallback className={`text-sm font-semibold text-white ${avatarColorClass(profile?.full_name ?? '')}`}>
                {nameInitials(profile?.full_name ?? '')}
              </AvatarFallback>
            </Avatar>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem render={<Link href="/profile" />}>
              <UserIcon className="size-3.5" /> Profile
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => signOutAdmin(router)}>
              <LogOut className="size-3.5" /> Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}

'use client'

import { useEffect, useState } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { useRouter, usePathname } from 'next/navigation'
import { signOut } from 'firebase/auth'
import { auth } from '@/lib/firebase/config'
import { markLoggingOut, consumeLoggingOut } from '@/lib/authTransition'
import { StaffPortalProvider, useStaffPortal } from '@/context/StaffPortalContext'
import { PortalCartProvider, usePortalCart } from '@/context/PortalCartContext'
import { PortalMobileSearchProvider, usePortalMobileSearch } from '@/context/PortalMobileSearchContext'
import { loadMyRequestsAlertCount } from '@/lib/api/loanRequests'
import { subscribeToAlertsChanged } from '@/lib/alertsBus'
import CookieNotice from '@/components/portal/CookieNotice'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { avatarInitials, avatarColorClass } from '@/lib/utils'
import { ContactEmailLink } from '@/components/ContactEmailLink'
import { LogOut, Package, ShoppingCart, ClipboardList, User as UserIcon, Menu, Search } from 'lucide-react'

function PortalShell({ children }: { children: React.ReactNode }) {
  const { user, staffMember, loading } = useStaffPortal()
  const { cart } = usePortalCart()
  const router = useRouter()
  const pathname = usePathname()
  // Total units across every line, not line count — a staff member with 2
  // laptops + 3 cables in their cart should see "5", the same convention
  // the admin sidebar's own alert badges use for counts that matter by
  // quantity rather than by row.
  const cartQty = cart.reduce((sum, i) => sum + i.quantity, 0)
  const { mobileSearchOpen, setMobileSearchOpen, toggleMobileSearch } = usePortalMobileSearch()

  // Combined total of My Requests' three actionable tabs (Needs your
  // response, Awaiting Jonathan, Upcoming) -- History is excluded, see
  // lib/api/loanRequests.ts's loadMyRequestsAlertCount().
  const [myRequestsCount, setMyRequestsCount] = useState<number | null>(null)

  // Guest = nobody signed in. Browse and Cart both work without an
  // account (products are readable without signing in; the cart
  // itself is local, in-memory state) — everything else in the portal
  // still needs a real, linked sign-in.
  const isGuest = !user

  useEffect(() => {
    if (!staffMember) return
    let cancelled = false
    loadMyRequestsAlertCount().then(count => {
      if (!cancelled) setMyRequestsCount(count)
    }).catch(() => {
      // Best-effort: the badge just stays hidden if this fails, the My
      // Requests page itself is still the source of truth.
    })
    return () => { cancelled = true }
  }, [staffMember, pathname === '/lend/requests'])

  // Catches a status change made in place on My Requests itself (accept/
  // decline/withdraw), where the pathname never changes so the effect
  // above never re-fires on its own -- see alertsBus.ts.
  useEffect(() => {
    if (!staffMember) return
    return subscribeToAlertsChanged(() => {
      loadMyRequestsAlertCount().then(setMyRequestsCount).catch(() => {})
    })
  }, [staffMember])

  // Collapse the mobile search/filter panel whenever the route changes —
  // otherwise it stays expanded after navigating away from Browse and
  // back, or leaves the header's search icon looking stuck "active".
  useEffect(() => {
    setMobileSearchOpen(false)
  }, [pathname, setMobileSearchOpen])

  useEffect(() => {
    if (loading) return
    // My Requests and Profile are both entirely a staff member's own
    // data — there's nothing to show a guest, so visiting either sends
    // them to sign in rather than rendering an empty/broken page. Browse
    // and Cart stay open (adding to cart works with no account at all;
    // Cart's own Submit Request button is what actually gates on sign-in).
    const needsAccount = pathname === '/lend/requests' || pathname.startsWith('/lend/requests/') || pathname === '/lend/profile'
    if (isGuest && needsAccount) {
      // An intentional sign-out from this very page (handleSignOut below)
      // already knows it wants '/' — don't also bounce to /login for the
      // same user:null transition. See authTransition.ts.
      if (consumeLoggingOut()) return
      router.push(`/login?next=${encodeURIComponent(pathname)}`)
    }
  }, [loading, isGuest, pathname, router])

  async function handleSignOut() {
    // markLoggingOut() has to run before signOut() — see authTransition.ts —
    // or the guard effect above can win the race and redirect to /login
    // instead (only reachable in practice from /lend/requests or
    // /lend/profile, but harmless to always set).
    markLoggingOut()
    await signOut(auth)
    // Home ('/') rather than /login — the portal is fully browsable signed
    // out (see isGuest above), so a straight sign-out drops them back on
    // the site's normal landing point instead of forcing a login screen.
    router.push('/')
  }

  if (loading) {
    return <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">Loading…</div>
  }

  // A Firebase Auth account with no linked StaffMember record — see
  // StaffPortalContext. Dead-end screen, no redirect: this account genuinely
  // has nowhere else in the portal to go. Never true for a guest (isGuest
  // already means no staffMember, but that's expected, not an error).
  if (!isGuest && !staffMember) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 px-6 text-center">
        <h1 className="text-lg font-bold text-foreground">Your account isn&apos;t linked</h1>
        <p className="max-w-[360px] text-sm text-muted-foreground">
          This sign-in isn&apos;t linked to an NWU staff record yet. Contact the IT Store to have your account set up for lending.
        </p>
        <Button variant="outline" onClick={handleSignOut}>Sign out</Button>
      </div>
    )
  }

  // Deactivated on the Staff page (Deactivate button) — locked out of the
  // portal the same way they're already locked out of Stock Out's staff
  // picker. Every sign-in path ends up here
  // before reaching Browse/Cart/My Requests, so this is the one place that
  // needs to enforce it to cover both. login/page.tsx also checks this up
  // front for the password path, purely so that one gets an immediate,
  // specific error on the login form itself instead of a moment on
  // "Loading…" before landing here — this check is what actually keeps
  // them out either way.
  if (!isGuest && staffMember && !staffMember.is_active) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 px-6 text-center">
        <h1 className="text-lg font-bold text-foreground">Your account has been deactivated</h1>
        <p className="max-w-[360px] text-sm text-muted-foreground">
          Please contact <ContactEmailLink />{' '}
          for more information.
        </p>
        <Button variant="outline" onClick={handleSignOut}>Sign out</Button>
      </div>
    )
  }

  const isActive = (href: string) => pathname === href || pathname.startsWith(href + '/')
  // Browse, Cart, My Requests, Profile, and the Lending Policy page all
  // share the wide, spacious width so the navbar lines up identically
  // across the whole portal (same idea as takealot.com's header and
  // product grid sharing one gutter) — the margin never differs between
  // pages that are supposed to feel like the same "wide" section of the
  // portal.
  const isWide = pathname === '/lend' || pathname === '/lend/cart' || pathname === '/lend/requests' || pathname === '/lend/profile' || pathname === '/lend/policy'
  const CONTENT_MAX_WIDTH = isWide ? 'max-w-[1600px]' : 'max-w-[1000px]'
  // staffMember/user.email are both unavailable for a guest — the
  // account-menu branch below never actually renders this for one, but
  // the fallback keeps the computation safe either way.
  const avatarEmail = staffMember?.email ?? user?.email ?? ''

  // Every portal page now shares the same fixed, brand-tinted canvas
  // gradient (design refresh) -- all five routes are the same shell, so
  // Cart/My Requests/Profile/Lending Policy all get Browse Equipment's
  // gradient too.
  const PORTAL_BACKGROUND: React.CSSProperties = {
    background: 'linear-gradient(180deg, #E6DCF1 0%, #D8CAE8 100%)',
    backgroundAttachment: 'fixed',
  }
  const mainStyle: React.CSSProperties | undefined =
    pathname === '/lend' || pathname === '/lend/cart' || pathname === '/lend/requests' || pathname === '/lend/profile' || pathname === '/lend/policy'
      ? PORTAL_BACKGROUND
      : undefined

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="border-b bg-card">
        <div className={`mx-auto flex items-center justify-between px-5 sm:px-6 md:px-8 lg:px-10 xl:px-14 py-4 ${CONTENT_MAX_WIDTH}`}>
          <div className="flex items-center gap-6">
            {/* Mobile nav menu — collapses Browse / My Requests / Profile
                into a single expandable button on small screens, where the
                desktop <nav> below (hidden until md:) has no room. Same
                DropdownMenu component the account button already uses. */}
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<button type="button" className="rounded-lg p-2 text-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring md:hidden" />}
                aria-label="Open menu"
              >
                <Menu className="size-5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-48">
                <DropdownMenuItem render={<Link href="/lend" />}>
                  <Package className="size-3.5" /> Browse
                </DropdownMenuItem>
                <DropdownMenuItem render={<Link href="/lend/requests" />}>
                  <ClipboardList className="size-3.5" /> My Requests
                  {!!myRequestsCount && (
                    <Badge className="ml-auto bg-(--nwu-turquoise) text-xs text-white">{myRequestsCount}</Badge>
                  )}
                </DropdownMenuItem>
                <DropdownMenuItem render={<Link href="/lend/profile" />}>
                  <UserIcon className="size-3.5" /> Profile
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Same SmartStock lockup as the login page and the admin
                sidebar, swapped in for the old plain-text "NWU Lending"
                wordmark — fixed height/auto width so it sits naturally in
                this horizontal header, next to the nav buttons, rather than
                the tall fixed-width sizing those two vertical layouts use. */}
            <Link href="/lend" className="flex items-center">
              {/* Below 500px there's no room for the wordmark next to the
                  menu/search/cart/avatar buttons, so only the standalone
                  icon mark is shown (same artwork as the full lockup's
                  icon -- see public/smartstock-nwu-icon.svg). */}
              <Image
                src="/smartstock-nwu-logo.svg"
                alt="SmartStock"
                width={360}
                height={120}
                priority
                unoptimized
                className="h-16 w-auto max-dlg:hidden"
              />
              <Image
                src="/smartstock-nwu-icon.svg"
                alt="SmartStock"
                width={100}
                height={100}
                priority
                unoptimized
                className="hidden size-11 max-dlg:block"
              />
            </Link>
            <nav className="hidden items-center gap-1.5 md:flex">
              <Button
                variant={isActive('/lend') && pathname === '/lend' ? 'default' : 'ghost'}
                render={<Link href="/lend" />}
                className="h-10 gap-2 px-4 text-base"
              >
                <Package className="size-4.5" /> Browse
              </Button>
              <Button
                variant={isActive('/lend/cart') ? 'default' : 'ghost'}
                render={<Link href="/lend/cart" />}
                className="h-10 gap-2 px-4 text-base"
              >
                <ShoppingCart className="size-4.5" /> Cart
                {cartQty > 0 && (
                  <Badge className="bg-(--nwu-turquoise) text-sm text-white">{cartQty}</Badge>
                )}
              </Button>
              <Button
                variant={isActive('/lend/requests') ? 'default' : 'ghost'}
                render={<Link href="/lend/requests" />}
                className="h-10 gap-2 px-4 text-base"
              >
                <ClipboardList className="size-4.5" /> My Requests
                {!!myRequestsCount && (
                  <Badge className="bg-(--nwu-turquoise) text-sm text-white">{myRequestsCount}</Badge>
                )}
              </Button>
            </nav>
          </div>
          <div className="flex items-center gap-3">
            {/* Mobile-only search + cart icon buttons — the desktop nav's
                Cart button and Browse page's own search/filter card cover
                these on md and up, so both only render below that
                breakpoint. Search only appears on Browse itself, the only
                page with anything for it to expand. */}
            {pathname === '/lend' && (
              <Button
                variant="ghost"
                size="icon"
                className="md:hidden"
                aria-label="Search equipment"
                aria-pressed={mobileSearchOpen}
                onClick={toggleMobileSearch}
              >
                <Search className="size-5" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              render={<Link href="/lend/cart" />}
              className="relative md:hidden"
              aria-label="Cart"
            >
              <ShoppingCart className="size-5" />
              {cartQty > 0 && (
                <Badge className="absolute -top-1 -right-1 bg-(--nwu-turquoise) px-1 text-[10px] text-white">{cartQty}</Badge>
              )}
            </Button>
            {/* Replaces the plain "Firstname Surname" text that used to sit
                here — same info (and more) is one click away on Profile now,
                so the header itself just needs something identifiable and
                compact. Initials/color are derived from the email, not
                stored anywhere, so there's nothing to keep in sync. */}
            {isGuest ? (
              <Link href="/login" className="text-base font-semibold text-primary underline-offset-2 hover:underline">
                Sign In
              </Link>
            ) : (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={<button type="button" className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring" />}
                  aria-label={`Account menu for ${staffMember?.full_name}`}
                >
                  <Avatar className="size-10">
                    <AvatarFallback className={`text-sm font-semibold text-white ${avatarColorClass(avatarEmail)}`}>
                      {avatarInitials(avatarEmail)}
                    </AvatarFallback>
                  </Avatar>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-44">
                  <DropdownMenuItem render={<Link href="/lend/profile" />}>
                    <UserIcon className="size-3.5" /> Profile
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={handleSignOut}>
                    <LogOut className="size-3.5" /> Sign out
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>
      </header>
      <div className="flex-1" style={mainStyle}>
        <main className={`mx-auto px-5 sm:px-6 md:px-8 lg:px-10 xl:px-14 py-6 ${CONTENT_MAX_WIDTH}`}>{children}</main>
      </div>
      {/* Bottom padding tracks the device's safe-area inset, guarding
          against mobile browsers' bottom gesture-nav bar / auto-hiding
          toolbar overlapping the very last pixels of the page when
          scrolled all the way down -- costs nothing on desktop (that
          inset is 0 there). Written as a literal CSS value below (not
          Tailwind's bracket shorthand in a comment) because Tailwind's
          class scanner matches candidate utilities anywhere in the file,
          comments included, and a bare "env(...)" isn't valid CSS. */}
      <footer className="border-t bg-card pb-[env(safe-area-inset-bottom)]">
        <div className={`mx-auto flex flex-col items-center justify-between gap-4 px-5 sm:px-6 md:px-8 lg:px-10 xl:px-14 py-8 sm:flex-row ${CONTENT_MAX_WIDTH}`}>
          <div className="flex flex-col items-center gap-2 text-center sm:flex-row sm:gap-4 sm:text-left">
            <div className="flex items-center gap-2">
              <span className="text-base font-semibold text-foreground">SmartStock</span>
              {/* NWU's own acronym wordmark (supplied by the user from NWU's
                  brand assets), cropped to its visible artwork so it sits at
                  a natural size next to the SmartStock text. */}
              <Image
                src="/nwu-wordmark.png"
                alt="North-West University"
                width={1572}
                height={423}
                unoptimized
                className="h-5 w-auto"
              />
            </div>
            <span className="hidden text-muted-foreground/40 sm:inline">·</span>
            <span className="text-base text-muted-foreground">
              © {new Date().getFullYear()} North-West University IT Store · Potchefstroom Campus (BICS). All rights reserved.
            </span>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-base">
            <Link href="/lend/policy" className="text-base font-semibold text-primary underline-offset-2 hover:underline">Lending Policy</Link>
          </div>
        </div>
      </footer>
      <CookieNotice />
    </div>
  )
}

export default function LendLayout({ children }: { children: React.ReactNode }) {
  return (
    <StaffPortalProvider>
      <PortalCartProvider>
        <PortalMobileSearchProvider>
          <PortalShell>{children}</PortalShell>
        </PortalMobileSearchProvider>
      </PortalCartProvider>
    </StaffPortalProvider>
  )
}

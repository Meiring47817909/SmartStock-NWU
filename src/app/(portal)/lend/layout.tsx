'use client'

import { useEffect } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { useRouter, usePathname } from 'next/navigation'
import { signOut } from 'firebase/auth'
import { auth } from '@/lib/firebase/config'
import { markLoggingOut, consumeLoggingOut } from '@/lib/authTransition'
import { StaffPortalProvider, useStaffPortal } from '@/context/StaffPortalContext'
import { PortalCartProvider, usePortalCart } from '@/context/PortalCartContext'
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
import { LogOut, Package, ShoppingCart, ClipboardList, User as UserIcon } from 'lucide-react'

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

  // Guest = nobody signed in. Browse and Cart both work without an
  // account (firestore.rules allows a public read of `products`; the cart
  // itself is local, in-memory state) — everything else in the portal
  // still needs a real, linked sign-in.
  const isGuest = !user

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
  // picker. Every sign-in path (password login, NWU-CAS) ends up here
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
          Please contact Selouna Visser at{' '}
          <a href="mailto:Selouna.Visser@nwu.ac.za" className="underline">Selouna.Visser@nwu.ac.za</a>{' '}
          for more information.
        </p>
        <Button variant="outline" onClick={handleSignOut}>Sign out</Button>
      </div>
    )
  }

  const isActive = (href: string) => pathname === href || pathname.startsWith(href + '/')
  // Browse and Cart share the wide, spacious width; My Requests stays at
  // the narrower reading width its stacked request cards were designed
  // for. Either way it's a bounded, centered width with its own side
  // margins, not edge-to-edge, and always matching the navbar's own width
  // below so the two visually line up (same idea as takealot.com's header
  // and product grid sharing one gutter) — the margin never differs
  // between pages that are supposed to feel like the same "wide" section
  // of the portal.
  const isWide = pathname === '/lend' || pathname === '/lend/cart' || pathname === '/lend/requests' || pathname === '/lend/profile'
  const CONTENT_MAX_WIDTH = isWide ? 'max-w-[1600px]' : 'max-w-[1000px]'
  // staffMember/user.email are both unavailable for a guest — the
  // account-menu branch below never actually renders this for one, but
  // the fallback keeps the computation safe either way.
  const avatarEmail = staffMember?.email ?? user?.email ?? ''

  // Every portal page now shares the same fixed, brand-tinted canvas
  // gradient (design refresh) -- all four routes are the same shell,
  // so Cart/My Requests/Profile get Browse Equipment's gradient too.
  const PORTAL_BACKGROUND: React.CSSProperties = {
    background: 'linear-gradient(180deg, #E6DCF1 0%, #D8CAE8 100%)',
    backgroundAttachment: 'fixed',
  }
  const mainStyle: React.CSSProperties | undefined =
    pathname === '/lend' || pathname === '/lend/cart' || pathname === '/lend/requests' || pathname === '/lend/profile'
      ? PORTAL_BACKGROUND
      : undefined

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card">
        <div className={`mx-auto flex items-center justify-between px-5 py-3 ${CONTENT_MAX_WIDTH}`}>
          <div className="flex items-center gap-6">
            {/* Same SmartStock-NWU lockup as the login page and the admin
                sidebar, swapped in for the old plain-text "NWU Lending"
                wordmark — fixed height/auto width so it sits naturally in
                this horizontal header, next to the nav buttons, rather than
                the tall fixed-width sizing those two vertical layouts use. */}
            <Link href="/lend" className="flex items-center">
              <Image
                src="/smartstock-nwu-logo.svg"
                alt="SmartStock-NWU"
                width={920}
                height={410}
                priority
                unoptimized
                className="h-9 w-auto"
              />
            </Link>
            <nav className="flex items-center gap-1">
              <Button variant={isActive('/lend') && pathname === '/lend' ? 'secondary' : 'ghost'} size="sm" render={<Link href="/lend" />}>
                <Package className="size-3.5" /> Browse
              </Button>
              <Button variant={isActive('/lend/cart') ? 'secondary' : 'ghost'} size="sm" render={<Link href="/lend/cart" />}>
                <ShoppingCart className="size-3.5" /> Cart
                {cartQty > 0 && (
                  <Badge className="bg-(--nwu-turquoise) text-white">{cartQty}</Badge>
                )}
              </Button>
              <Button variant={isActive('/lend/requests') ? 'secondary' : 'ghost'} size="sm" render={<Link href="/lend/requests" />}>
                <ClipboardList className="size-3.5" /> My Requests
              </Button>
            </nav>
          </div>
          <div className="flex items-center gap-3">
            {/* Replaces the plain "Firstname Surname" text that used to sit
                here — same info (and more) is one click away on Profile now,
                so the header itself just needs something identifiable and
                compact. Initials/color are derived from the email, not
                stored anywhere, so there's nothing to keep in sync. */}
            {isGuest ? (
              <Link href="/login" className="text-sm font-medium text-primary underline-offset-2 hover:underline">
                Sign In
              </Link>
            ) : (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={<button type="button" className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring" />}
                  aria-label={`Account menu for ${staffMember?.full_name}`}
                >
                  <Avatar>
                    <AvatarFallback className={`text-xs font-semibold text-white ${avatarColorClass(avatarEmail)}`}>
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
      <main className={`mx-auto px-5 py-6 ${CONTENT_MAX_WIDTH}`} style={mainStyle}>{children}</main>
    </div>
  )
}

export default function LendLayout({ children }: { children: React.ReactNode }) {
  return (
    <StaffPortalProvider>
      <PortalCartProvider>
        <PortalShell>{children}</PortalShell>
      </PortalCartProvider>
    </StaffPortalProvider>
  )
}

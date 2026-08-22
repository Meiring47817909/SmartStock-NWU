'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import { useRouter, usePathname } from 'next/navigation'
import { signOut } from 'firebase/auth'
import { auth } from '@/lib/firebase/config'
import { StaffPortalProvider, useStaffPortal } from '@/context/StaffPortalContext'
import { PortalCartProvider } from '@/context/PortalCartContext'
import { Button } from '@/components/ui/button'
import { LogOut, Package, ShoppingCart, ClipboardList } from 'lucide-react'

function PortalShell({ children }: { children: React.ReactNode }) {
  const { user, staffMember, loading } = useStaffPortal()
  const router = useRouter()
  const pathname = usePathname()

  useEffect(() => {
    if (!loading && !user) {
      router.push('/login')
    }
  }, [loading, user, router])

  async function handleSignOut() {
    await signOut(auth)
    router.push('/login')
  }

  if (loading || !user) {
    return <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">Loading…</div>
  }

  // A Firebase Auth account with no linked StaffMember record — see
  // StaffPortalContext. Dead-end screen, no redirect: this account genuinely
  // has nowhere else in the portal to go.
  if (!staffMember) {
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

  const isActive = (href: string) => pathname === href || pathname.startsWith(href + '/')

  return (
    <div className="min-h-screen bg-background">
      <header className="flex items-center justify-between border-b bg-card px-5 py-3">
        <div className="flex items-center gap-6">
          <Link href="/lend" className="flex items-center gap-1.5 text-[1.05rem] font-bold tracking-tight text-foreground">
            <span className="size-2 rounded-full bg-(--nwu-turquoise)" />
            NWU Lending
          </Link>
          <nav className="flex items-center gap-1">
            <Button variant={isActive('/lend') && pathname === '/lend' ? 'secondary' : 'ghost'} size="sm" render={<Link href="/lend" />}>
              <Package className="size-3.5" /> Browse
            </Button>
            <Button variant={isActive('/lend/cart') ? 'secondary' : 'ghost'} size="sm" render={<Link href="/lend/cart" />}>
              <ShoppingCart className="size-3.5" /> Cart
            </Button>
            <Button variant={isActive('/lend/requests') ? 'secondary' : 'ghost'} size="sm" render={<Link href="/lend/requests" />}>
              <ClipboardList className="size-3.5" /> My Requests
            </Button>
          </nav>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">{staffMember.full_name}</span>
          <Button variant="ghost" size="sm" onClick={handleSignOut}>
            <LogOut className="size-3.5" /> Sign out
          </Button>
        </div>
      </header>
      <main className="mx-auto max-w-[1000px] px-5 py-6">{children}</main>
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

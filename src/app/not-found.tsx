'use client'

import Link from 'next/link'
import { FileQuestion } from 'lucide-react'
import { useAuth } from '@/context/AuthContext'
import { RoleProvider } from '@/context/RoleContext'
import Sidebar from '@/components/layout/Sidebar'
import { SidebarProvider } from '@/components/ui/sidebar'
import { Button } from '@/components/ui/button'
import type { Profile, Role } from '@/types/database'

/**
 * Global 404. Route groups like (protected) don't wrap arbitrary unmatched
 * URLs, so this has to rebuild the authenticated shell (sidebar + nav)
 * itself — otherwise a logged-in user lands on a bare page with no way
 * back, which is a dead end in the installed PWA (no browser chrome there).
 */
export default function NotFound() {
  const { user, profile, loading } = useAuth()

  const message = (
    <div className="flex h-full min-h-screen flex-col items-center justify-center gap-3 p-8 text-center">
      <FileQuestion className="size-10 text-muted-foreground" />
      <h1 className="text-xl font-bold text-foreground">Page not found</h1>
      <p className="max-w-[380px] text-sm text-muted-foreground">
        The page you&apos;re looking for doesn&apos;t exist, or may have been removed.
      </p>
      <Button render={<Link href={user ? '/dashboard' : '/login'} />} className="mt-2">
        {user ? 'Back to Dashboard' : 'Go to Login'}
      </Button>
    </div>
  )

  if (loading) {
    return <div className="flex h-screen items-center justify-center">Loading...</div>
  }

  if (!user) {
    return message
  }

  const role = (profile?.role ?? 'staff') as Role

  return (
    <RoleProvider role={role}>
      <SidebarProvider style={{ minHeight: '100vh', height: '100vh', overflow: 'hidden' } as React.CSSProperties}>
        <Sidebar profile={profile as Profile | null} />
        <main className="flex-1 overflow-y-auto">
          {message}
        </main>
      </SidebarProvider>
    </RoleProvider>
  )
}

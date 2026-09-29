'use client'

// Staff-portal-only cookie notice -- mounted from (portal)/lend/layout.tsx's
// PortalShell, never from the admin (protected) layout, since only the
// lending portal is public-facing to staff who haven't seen a disclosure
// yet. Dismissal is remembered per-browser via localStorage, matching the
// simple accept-and-forget pattern used by other NWU-adjacent portals --
// see the Privacy & Cookies section on /lend/policy for what's disclosed.
// The visibility check runs inside a setTimeout (rather than calling
// setState synchronously in the effect body) both to let the page settle
// first and to satisfy this project's react-hooks/set-state-in-effect rule.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'

const STORAGE_KEY = 'smartstock-nwu-cookie-notice'

export default function CookieNotice() {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        if (!window.localStorage.getItem(STORAGE_KEY)) {
          setVisible(true)
        }
      } catch {
        // Private/blocked storage -- just skip the notice rather than fail
        // the page over it.
      }
    }, 800)
    return () => clearTimeout(timer)
  }, [])

  function handleAccept() {
    try {
      window.localStorage.setItem(STORAGE_KEY, 'accepted')
    } catch {
      // Best-effort only -- worst case it shows again next visit.
    }
    setVisible(false)
  }

  if (!visible) return null

  return (
    <div className="fixed inset-x-4 bottom-4 z-50 flex justify-center sm:inset-x-auto sm:right-4">
      <div className="flex w-full max-w-md flex-col gap-3 rounded-xl border border-[#E2D8E9] bg-white p-4 text-sm shadow-lg">
        <p className="text-[#5B4F67]">
          This portal uses essential cookies to keep you signed in and remember your
          preferences, and handles your information in line with South Africa&apos;s
          Protection of Personal Information Act (POPIA). See our{' '}
          <Link
            href="/lend/policy#privacy-cookies"
            className="font-medium text-primary underline underline-offset-2 hover:text-(--nwu-purple-dark)"
          >
            Lending Policy
          </Link>{' '}
          for details.
        </p>
        <div className="flex justify-end">
          <Button
            onClick={handleAccept}
            className="h-9 rounded-lg bg-primary px-4 text-sm font-medium text-white shadow-sm hover:bg-[#582e78]"
          >
            Got it
          </Button>
        </div>
      </div>
    </div>
  )
}

'use client'

import { Suspense, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { signInWithCustomToken } from 'firebase/auth'
import { auth } from '@/lib/firebase/config'
import { Button } from '@/components/ui/button'

function CasCallbackInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [error, setError] = useState('')

  useEffect(() => {
    const ticket = searchParams.get('ticket')
    if (!ticket) {
      router.push('/login')
      return
    }

    const service = window.location.origin + '/cas-callback'
    let casRole: string | undefined

    fetch(`/api/auth/cas/validate?ticket=${encodeURIComponent(ticket)}&service=${encodeURIComponent(service)}`)
      .then(async res => {
        const data = await res.json()
        if (!res.ok) throw new Error(data.error || 'NWU-CAS login failed.')
        casRole = data.role
        return signInWithCustomToken(auth, data.token)
      })
      // Route by the role the allowlist gave them, the same split the
      // password login makes: only an admin has anywhere to go in BICS.
      // A 'staff' CAS account is a lending-portal borrower, and pushing it
      // to /dashboard would just bounce straight back out via the
      // (protected) layout's admin gate.
      .then(() => router.push(casRole === 'admin' ? '/dashboard' : '/lend'))
      .catch((err: Error) => setError(err.message || 'NWU-CAS login failed.'))
    // Only ever run once per mount — re-running with the same ticket would
    // fail anyway (CAS tickets are single-use).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (error) {
    return (
      <div className="flex max-w-[380px] flex-col items-center gap-3 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <Button render={<a href="/login" />}>Back to Login</Button>
      </div>
    )
  }

  return <p className="text-sm text-muted-foreground">Validating NWU-CAS login…</p>
}

export default function CasCallbackPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <Suspense fallback={<p className="text-sm text-muted-foreground">Validating NWU-CAS login…</p>}>
        <CasCallbackInner />
      </Suspense>
    </div>
  )
}

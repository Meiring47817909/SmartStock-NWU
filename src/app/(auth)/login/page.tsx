'use client'

import { Suspense, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Image from 'next/image'
import { signInWithEmailAndPassword, signOut } from 'firebase/auth'
import { auth } from '@/lib/firebase/config'
import { requestPasswordReset } from '@/lib/firebase/accountEmails'
import { withAuthRaceRetry } from '@/lib/firebase/authRace'
import { loadMe } from '@/lib/api/me'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { toast } from 'sonner'
import { fetchContactEmail } from '@/lib/contactEmail'

function LoginPageInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(
    searchParams.get('error') === 'no-profile'
      ? "Your account isn't set up for BICS access — contact an administrator."
      : '',
  )
  const [loading, setLoading] = useState(false)
  const [sendingReset, setSendingReset] = useState(false)

  // Where a signed-in portal borrower (not an admin — see routeSignedInUser)
  // lands, when they were bounced here from somewhere specific, e.g. Cart's
  // Submit Request button sends '/login?next=/lend/cart'. Restricted to
  // '/lend' paths so this can't be turned into an open redirect via a
  // crafted login link.
  const nextParam = searchParams.get('next')
  const next = nextParam && nextParam.startsWith('/lend') ? nextParam : null

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await signInWithEmailAndPassword(auth, email, password)
      await routeSignedInUser()
    } catch (err) {
      // Firebase's own error.message ("Firebase: Error (auth/wrong-password).")
      // is raw SDK text, not something to show a staff member — map the
      // codes we actually see here to plain sentences instead.
      const code = (err as { code?: string })?.code
      if (code === 'auth/wrong-password' || code === 'auth/invalid-credential' || code === 'auth/user-not-found') {
        setError('Incorrect email or password.')
      } else if (code === 'auth/invalid-email') {
        setError('Enter a valid email address.')
      } else if (code === 'auth/user-disabled') {
        setError(`This account has been disabled. Please contact ${await fetchContactEmail()} for more information.`)
      } else if (code === 'auth/too-many-requests') {
        setError('Too many attempts — please wait a moment and try again.')
      } else {
        setError('Something went wrong signing you in. Please try again.')
      }
      setLoading(false)
    }
  }

  // One shared login, two possible destinations — this account is either a
  // BICS operator (has a profile row) or a lending-portal borrower
  // (linked via staff.uid). Resolved with a direct one-shot check right
  // here, not by waiting on AuthContext/StaffPortalContext's own
  // onAuthStateChanged-driven state — those still independently re-verify
  // once the destination layout mounts (defense in depth), but routing
  // decisions shouldn't depend on two separate contexts' async loading
  // flags settling in the right order.
  async function routeSignedInUser() {
    // Only an admin profile means BICS. A profile carrying role 'staff' is
    // a lending-portal borrower like any other, so it falls through to the
    // staff-record lookup below rather than being pushed at /dashboard and
    // immediately bounced back out by the (protected) layout's admin gate —
    // that round trip shows the user a visible flash of the BICS shell they
    // aren't allowed into. One GET /api/me returns both the profile and the
    // linked staff record, so there is a single round trip. withAuthRaceRetry
    // absorbs a 401 from the brief window right after sign-in when the fresh
    // ID token is not yet accepted.
    const { profile, staff } = await withAuthRaceRetry(() => loadMe())
    if (profile?.role === 'admin') {
      router.push('/dashboard')
      router.refresh()
      return
    }

    if (staff) {
      // Deactivated (Staff page → Deactivate) — the portal layout itself
      // also blocks this (see lend/layout.tsx's PortalShell), which is what
      // actually enforces it for every sign-in path. This
      // check is purely so the password-login path gets an immediate,
      // specific error right here instead of a "Loading…" flash before
      // landing on that dead-end screen.
      if (staff.is_active === false) {
        await signOut(auth)
        setError(`Your account has been deactivated. Please contact ${await fetchContactEmail()} for more information.`)
        setLoading(false)
        return
      }
      router.push(next ?? '/lend')
      return
    }

    // Neither an admin profile nor a linked staff record — this account
    // isn't provisioned for anything in this app. Note this now also catches
    // a legacy profile with role 'staff' (or the old 'manager') that has no
    // staff record to go with it: under the two-role model that account has
    // BICS access revoked and no portal identity, so there's genuinely
    // nowhere to send it. Sign back out rather than leaving them signed in
    // with nowhere to go.
    await signOut(auth)
    setError("This account isn't set up for BICS or portal access — contact an administrator.")
    setLoading(false)
  }

  async function handleForgotPassword() {
    if (!email) {
      setError('Enter your email address above, then click "Reset it".')
      return
    }
    setError('')
    setSendingReset(true)
    try {
      await requestPasswordReset(email)
      toast.success(`Password reset email sent to ${email}.`)
    } catch (err) {
      const code = (err as { code?: string })?.code
      if (code === 'auth/invalid-email') {
        setError('Enter a valid email address.')
      } else if (code === 'auth/too-many-requests') {
        setError('Too many attempts — please wait a moment and try again.')
      } else {
        toast.error('Failed to send reset email. Please try again.')
      }
    }
    setSendingReset(false)
  }

  return (
    <div className="flex min-h-screen items-center justify-center" style={{ background: 'radial-gradient(circle, #E5DCF0 0%, #D1C0E2 60%, #BBA4D1 100%)' }}>
      <Card className="w-full max-w-[400px] border-t-4 border-t-(--nwu-purple) py-0 shadow-[0_4px_24px_rgba(0,0,0,0.06)]">
        <CardContent className="p-6">
          {/* Header */}
          <div className="mb-8 text-center">
            <Image
              src="/smartstock-nwu-logo.svg"
              alt="SmartStock-NWU"
              width={460}
              height={120}
              priority
              unoptimized
              className="mx-auto mb-4 h-auto w-[300px]"
            />
            {/* North-West University's own official badge (holding-shape
                lockup, supplied by the user from NWU's brand assets) --
                sits to the left of the "NWU IT Store" wordmark, per the
                Stitch mockup. Boxed off from the SmartStock-NWU lockup
                above it, per the user's mockup, to read as the
                institution's own identity block. */}
            <div className="rounded-xl border border-border bg-muted/40 px-4 py-3.5">
              <div className="flex items-center justify-center gap-2.5">
                <Image
                  src="/nwu-logo.png"
                  alt="North-West University"
                  width={247}
                  height={247}
                  unoptimized
                  className="h-16 w-16 shrink-0"
                />
                <h1 className="text-xl font-bold text-foreground">NWU IT Store</h1>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">Potchefstroom Campus</p>
            </div>
          </div>

          <form onSubmit={handleLogin} className="flex flex-col gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="email">Email address</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="you@nwu.ac.za"
                required
                autoFocus
              />
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="••••••••"
                required
              />
            </div>

            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <Button type="submit" disabled={loading} className="mt-1 w-full justify-center">
              {loading ? 'Signing in…' : 'Sign in'}
            </Button>

            <p className="text-center text-sm text-muted-foreground">
              Forgot password?{' '}
              <button
                type="button"
                onClick={handleForgotPassword}
                disabled={sendingReset}
                className="font-medium text-primary underline-offset-2 hover:underline disabled:opacity-60"
              >
                {sendingReset ? 'Sending…' : 'Reset it'}
              </button>
            </p>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="flex min-h-screen items-center justify-center" style={{ background: 'radial-gradient(circle, #E5DCF0 0%, #D1C0E2 60%, #BBA4D1 100%)' }} />}>
      <LoginPageInner />
    </Suspense>
  )
}

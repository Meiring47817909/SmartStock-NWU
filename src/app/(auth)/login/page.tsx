'use client'

import { Suspense, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { signInWithEmailAndPassword, signOut } from 'firebase/auth'
import { auth, db } from '@/lib/firebase/config'
import { doc, getDocFromServer, collection, query, where, getDocsFromServer } from 'firebase/firestore'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Separator } from '@/components/ui/separator'

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

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const cred = await signInWithEmailAndPassword(auth, email, password)
      await routeSignedInUser(cred.user.uid)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid email or password')
      setLoading(false)
    }
  }

  // One shared login, two possible destinations — this account is either a
  // BICS operator (has a profiles/{uid} doc) or a lending-portal borrower
  // (linked via staff.uid). Resolved with a direct one-shot check right
  // here, not by waiting on AuthContext/StaffPortalContext's own
  // onAuthStateChanged-driven state — those still independently re-verify
  // once the destination layout mounts (defense in depth), but routing
  // decisions shouldn't depend on two separate contexts' async loading
  // flags settling in the right order.
  async function routeSignedInUser(uid: string) {
    const profileSnap = await getDocFromServer(doc(db, 'profiles', uid))
    if (profileSnap.exists()) {
      router.push('/dashboard')
      router.refresh()
      return
    }

    const staffSnap = await getDocsFromServer(query(collection(db, 'staff'), where('uid', '==', uid)))
    if (!staffSnap.empty) {
      router.push('/lend')
      return
    }

    // Neither a BICS profile nor a linked staff record — this account
    // isn't provisioned for anything in this app. Sign back out rather
    // than leaving them signed in with nowhere to go.
    await signOut(auth)
    setError("This account isn't set up for BICS or portal access — contact an administrator.")
    setLoading(false)
  }

  function handleCasLogin() {
    const service = window.location.origin + '/cas-callback'
    window.location.href = `https://casprd.nwu.ac.za/cas/login?service=${encodeURIComponent(service)}`
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <Card className="w-full max-w-[400px] border-t-4 border-t-(--nwu-purple) shadow-[0_4px_24px_rgba(0,0,0,0.06)]">
        <CardContent className="p-10 pt-6">
          {/* Header */}
          <div className="mb-8 text-center">
            <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-xl bg-gradient-to-br from-(--nwu-purple) to-(--nwu-turquoise)">
              <span className="size-2.5 rounded-full bg-white" />
            </div>
            <h1 className="text-xl font-bold text-foreground">NWU IT Store</h1>
            <p className="mt-1 text-sm text-muted-foreground">Potchefstroom Campus</p>
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
          </form>

          <div className="my-5 flex items-center gap-3">
            <Separator className="flex-1" />
            <span className="text-[0.72rem] tracking-wide text-muted-foreground uppercase">or</span>
            <Separator className="flex-1" />
          </div>

          <Button type="button" variant="outline" onClick={handleCasLogin} className="w-full justify-center">
            Use NWU-CAS
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="flex min-h-screen items-center justify-center bg-background" />}>
      <LoginPageInner />
    </Suspense>
  )
}

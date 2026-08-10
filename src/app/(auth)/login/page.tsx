'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { signInWithEmailAndPassword } from 'firebase/auth'
import { auth } from '@/lib/firebase/config'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Separator } from '@/components/ui/separator'

export default function LoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await signInWithEmailAndPassword(auth, email, password)
      router.push('/dashboard')
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid email or password')
    }
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
              <span className="text-[1.1rem] font-extrabold text-white">B</span>
            </div>
            <h1 className="text-xl font-bold text-foreground">BICS</h1>
            <p className="mt-1 text-sm text-muted-foreground">NWU IT Store · Potchefstroom</p>
          </div>

          <form onSubmit={handleLogin} className="flex flex-col gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="email">Email address</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="admin@nwu.ac.za"
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

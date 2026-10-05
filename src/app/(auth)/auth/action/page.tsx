'use client'

import { Suspense, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Image from 'next/image'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { PASSWORD_RULE_TEXT } from '@/lib/firebase/passwordRules'
import {
  actionErrorMessage,
  applyEmailAction,
  describeEmailAction,
  finishPasswordReset,
  parseAction,
  startPasswordReset,
  type AccountActionMode,
} from '@/lib/firebase/accountActions'

// Where the links in the account emails land: "Reset password" / "Set your
// password", "Confirm new email" and "Restore email". Replaces Firebase's own
// handler page (plain text in the emulator) with one in the app's style;
// Firebase still checks and applies the one-time code.

const BACKGROUND = { background: 'radial-gradient(circle, #E5DCF0 0%, #D1C0E2 60%, #BBA4D1 100%)' }
const INVALID_LINK = 'This link is not valid. Open the whole link from the email, or request a new one from the sign-in page.'

type View =
  | { kind: 'checking' }
  | { kind: 'invalid'; message: string }
  | { kind: 'reset'; email: string }
  | { kind: 'email'; mode: AccountActionMode; email: string | null; previousEmail: string | null }
  | { kind: 'done'; title: string; message: string }

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center px-4" style={BACKGROUND}>
      <Card className="w-full max-w-[400px] border-t-4 border-t-(--nwu-purple) py-0 shadow-[0_4px_24px_rgba(0,0,0,0.06)]">
        <CardContent className="p-6">
          <Image
            src="/smartstock-nwu-logo.svg"
            alt="SmartStock"
            width={360}
            height={120}
            priority
            unoptimized
            className="mx-auto mb-6 h-auto w-[188px]"
          />
          {children}
        </CardContent>
      </Card>
    </div>
  )
}

function Heading({ children }: { children: React.ReactNode }) {
  return <h1 className="mb-2 text-center text-xl font-bold text-foreground">{children}</h1>
}

function BackToSignIn({ variant = 'default' }: { variant?: 'default' | 'outline' }) {
  const router = useRouter()
  return (
    <Button type="button" variant={variant} className="mt-4 w-full justify-center" onClick={() => router.push('/login')}>
      Go to sign in
    </Button>
  )
}

function ResetPasswordForm({ oobCode, email, onDone }: { oobCode: string; email: string; onDone: (v: View) => void }) {
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setSaving(true)
    try {
      const problem = await finishPasswordReset(oobCode, password, confirmation)
      if (problem) {
        setError(problem)
      } else {
        onDone({ kind: 'done', title: 'Password saved', message: `You can now sign in as ${email} with your new password.` })
        return
      }
    } catch (err) {
      setError(actionErrorMessage(err))
    }
    setSaving(false)
  }

  return (
    <>
      <Heading>Choose a new password</Heading>
      <p className="mb-5 text-center text-sm text-muted-foreground">For {email}. Use {PASSWORD_RULE_TEXT}.</p>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div className="grid gap-1.5">
          <Label htmlFor="new-password">New password</Label>
          <Input
            id="new-password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoFocus
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="confirm-password">Confirm new password</Label>
          <Input
            id="confirm-password"
            type="password"
            autoComplete="new-password"
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
            required
          />
        </div>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <Button type="submit" disabled={saving} className="mt-1 w-full justify-center">
          {saving ? 'Saving…' : 'Save password'}
        </Button>
      </form>
    </>
  )
}

function EmailActionConfirm({
  oobCode,
  mode,
  email,
  previousEmail,
  onDone,
}: {
  oobCode: string
  mode: AccountActionMode
  email: string | null
  previousEmail: string | null
  onDone: (v: View) => void
}) {
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const restoring = mode === 'recoverEmail'

  async function handleConfirm() {
    setError('')
    setSaving(true)
    try {
      await applyEmailAction(oobCode)
      onDone(
        restoring
          ? {
              kind: 'done',
              title: 'Email restored',
              message: `Your login email is ${email ?? 'your previous address'} again. If you didn't change it yourself, reset your password from the sign-in page.`,
            }
          : {
              kind: 'done',
              title: 'Email changed',
              message: `Your login email is now ${email ?? 'your new address'}. Use it the next time you sign in.`,
            },
      )
      return
    } catch (err) {
      setError(actionErrorMessage(err))
    }
    setSaving(false)
  }

  return (
    <>
      <Heading>{restoring ? 'Restore your login email' : 'Confirm your new email'}</Heading>
      <p className="mb-5 text-center text-sm text-muted-foreground">
        {restoring
          ? `Change your SmartStock login email back to ${email ?? 'your previous address'}?`
          : previousEmail
            ? `Change your SmartStock login email from ${previousEmail} to ${email ?? 'the new address'}?`
            : `Change your SmartStock login email to ${email ?? 'the new address'}?`}
      </p>
      {error && (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Button type="button" disabled={saving} onClick={handleConfirm} className="w-full justify-center">
        {saving ? 'Saving…' : restoring ? 'Restore email' : 'Confirm new email'}
      </Button>
    </>
  )
}

function AccountActionInner() {
  const params = useSearchParams()
  const action = parseAction(params)
  const mode = action?.mode
  const oobCode = action?.oobCode
  const [view, setView] = useState<View>(() => (action ? { kind: 'checking' } : { kind: 'invalid', message: INVALID_LINK }))

  useEffect(() => {
    if (!mode || !oobCode) return
    let cancelled = false
    const check = async (): Promise<View> => {
      try {
        if (mode === 'resetPassword') return { kind: 'reset', email: await startPasswordReset(oobCode) }
        const info = await describeEmailAction(oobCode)
        return { kind: 'email', mode, email: info.email, previousEmail: info.previousEmail }
      } catch (err) {
        return { kind: 'invalid', message: actionErrorMessage(err) }
      }
    }
    void check().then((next) => {
      if (!cancelled) setView(next)
    })
    return () => {
      cancelled = true
    }
  }, [mode, oobCode])

  return (
    <Shell>
      {view.kind === 'checking' && <p className="text-center text-sm text-muted-foreground">Checking your link…</p>}

      {view.kind === 'invalid' && (
        <>
          <Heading>This link can&apos;t be used</Heading>
          <Alert variant="destructive" className="mt-3">
            <AlertDescription>{view.message}</AlertDescription>
          </Alert>
          <BackToSignIn variant="outline" />
        </>
      )}

      {view.kind === 'reset' && oobCode && <ResetPasswordForm oobCode={oobCode} email={view.email} onDone={setView} />}

      {view.kind === 'email' && oobCode && (
        <EmailActionConfirm
          oobCode={oobCode}
          mode={view.mode}
          email={view.email}
          previousEmail={view.previousEmail}
          onDone={setView}
        />
      )}

      {view.kind === 'done' && (
        <>
          <Heading>{view.title}</Heading>
          <p className="text-center text-sm text-muted-foreground">{view.message}</p>
          <BackToSignIn />
        </>
      )}
    </Shell>
  )
}

export default function AccountActionPage() {
  return (
    <Suspense fallback={<div className="min-h-screen" style={BACKGROUND} />}>
      <AccountActionInner />
    </Suspense>
  )
}

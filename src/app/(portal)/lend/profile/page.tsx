'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import {
  EmailAuthProvider,
  reauthenticateWithCredential,
  updatePassword,
  sendPasswordResetEmail,
  validatePassword,
} from 'firebase/auth'
import { auth } from '@/lib/firebase/config'
import { useStaffPortal } from '@/context/StaffPortalContext'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { avatarInitials, avatarColorClass } from '@/lib/utils'

// Only an account that actually has an email/password credential can
// change one here — an NWU-CAS-only sign-in has no password to update
// (see (auth)/cas-callback/page.tsx: it signs in with a custom token, no
// password provider attached), so that case gets a "set one up" email
// instead of a form asking for a current password that doesn't exist.
function hasPasswordProvider(user: { providerData: { providerId: string }[] } | null): boolean {
  return !!user?.providerData.some((p) => p.providerId === 'password')
}

function ChangePasswordCard({ email }: { email: string }) {
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [sendingReset, setSendingReset] = useState(false)

  async function handleForgotPassword() {
    setSendingReset(true)
    try {
      await sendPasswordResetEmail(auth, email)
      toast.success(`Password reset email sent to ${email}.`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to send reset email.')
    }
    setSendingReset(false)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    // Checks the new password against the live Firebase Auth password
    // policy (Console: Authentication -> Settings -> Password policy) so
    // this form always matches whatever's actually enforced server-side,
    // rather than hard-coding the rules a second time here.
    const status = await validatePassword(auth, newPassword)
    if (!status.isValid) {
      const missing: string[] = []
      const opts = status.passwordPolicy.customStrengthOptions
      if (status.meetsMinPasswordLength === false) missing.push(`at least ${opts.minPasswordLength} characters`)
      if (status.meetsMaxPasswordLength === false) missing.push(`at most ${opts.maxPasswordLength} characters`)
      if (status.containsUppercaseLetter === false) missing.push('an uppercase letter')
      if (status.containsLowercaseLetter === false) missing.push('a lowercase letter')
      if (status.containsNumericCharacter === false) missing.push('a number')
      if (status.containsNonAlphanumericCharacter === false) missing.push('a special character')
      setError(`New password needs ${missing.join(', ')}.`)
      return
    }
    if (newPassword !== confirmPassword) {
      setError("New password and confirmation don't match.")
      return
    }
    if (!auth.currentUser) return
    setSaving(true)
    try {
      // Firebase requires a recent sign-in before it'll let the account
      // change its own password — reauthenticating with the current
      // password right here is what satisfies that, rather than sending
      // the staff member back through the login page first.
      await reauthenticateWithCredential(auth.currentUser, EmailAuthProvider.credential(email, currentPassword))
      await updatePassword(auth.currentUser, newPassword)
      toast.success('Password updated.')
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
    } catch (err) {
      const code = (err as { code?: string })?.code
      if (code === 'auth/wrong-password' || code === 'auth/invalid-credential') {
        setError('Current password is incorrect.')
      } else if (code === 'auth/weak-password' || code === 'auth/password-does-not-meet-requirements') {
        setError("That new password doesn't meet the requirements — use 6-20 characters with an uppercase letter, a lowercase letter, a number and a special character.")
      } else if (code === 'auth/too-many-requests') {
        setError('Too many attempts — please wait a moment and try again.')
      } else {
        setError(err instanceof Error ? err.message : 'Failed to update password.')
      }
    }
    setSaving(false)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Change password</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="current-password">Current password</Label>
            <Input
              id="current-password"
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              placeholder="••••••••"
              required
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="new-password">New password</Label>
            <Input
              id="new-password"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="6-20 chars, upper/lower/number/symbol"
              minLength={6}
              maxLength={20}
              required
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="confirm-password">Confirm new password</Label>
            <Input
              id="confirm-password"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="••••••••"
              required
            />
          </div>

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <Button type="submit" disabled={saving} className="mt-1 w-full justify-center">
            {saving ? 'Updating…' : 'Update password'}
          </Button>
          {/* Same blue as the admin sidebar's own Sign out button
              (--nwu-btn-primary) — NWU's secondary brand blue, distinct
              from the purple/turquoise used everywhere else on this page. */}
          <Button
            type="button"
            disabled={sendingReset}
            onClick={handleForgotPassword}
            className="w-full justify-center bg-(--nwu-btn-primary) text-white hover:bg-(--nwu-btn-primary-hover)"
          >
            {sendingReset ? 'Sending…' : 'Forgot password?'}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}

// The NWU-CAS-only case — no password provider to change, so this offers
// the same "set your password" email the admin's Send Login Email button
// sends, just triggered by the staff member themselves instead of Selouna.
function SetUpPasswordCard({ email }: { email: string }) {
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)

  async function handleSend() {
    setSending(true)
    try {
      await sendPasswordResetEmail(auth, email)
      setSent(true)
      toast.success('Password setup email sent.')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to send email.')
    }
    setSending(false)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Change password</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">
          You sign in with NWU-CAS, which doesn&apos;t use a password. Set one up to also be able to sign in with your email and a password.
        </p>
        <Button type="button" variant="outline" disabled={sending || sent} onClick={handleSend} className="w-full justify-center">
          {sent ? 'Email sent' : sending ? 'Sending…' : 'Send me a password setup email'}
        </Button>
      </CardContent>
    </Card>
  )
}

export default function ProfilePage() {
  const { user, staffMember } = useStaffPortal()

  if (!staffMember) return null

  const email = staffMember.email ?? user?.email ?? ''

  return (
    // Same wide layout + centered, 1000px-wide content column as Cart and
    // My Requests (see (portal)/lend/layout.tsx) rather than sitting
    // flush-left in the full-width main.
    <div className="mx-auto flex max-w-[1000px] flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Profile</h1>
        <p className="mt-1 text-sm text-muted-foreground">Your NWU staff record, as Selouna has it on file.</p>
      </div>

      {/* Left column (identity + details cards, stacked) and right column
          (the password card) sit side by side so the password card's
          height roughly matches the other two combined, instead of a
          single tall stack of three same-width cards. */}
      <div className="flex flex-col gap-6 md:flex-row md:items-start">
        <div className="flex flex-col gap-6 md:w-[480px]">
          <Card>
            <CardContent className="flex items-center gap-4">
              <Avatar className="size-14">
                <AvatarFallback className={`text-lg font-semibold text-white ${avatarColorClass(email)}`}>
                  {avatarInitials(email)}
                </AvatarFallback>
              </Avatar>
              <div>
                <div className="text-lg font-semibold text-foreground">{staffMember.full_name}</div>
                <div className="text-sm text-muted-foreground">{email || '—'}</div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="flex flex-col gap-3">
              <div>
                <div className="text-xs font-medium text-muted-foreground">Department</div>
                <div className="text-sm text-foreground">{staffMember.department || '—'}</div>
              </div>
              <div>
                <div className="text-xs font-medium text-muted-foreground">Card UID</div>
                <div className="text-sm text-foreground">{staffMember.card_uid || '—'}</div>
              </div>
              <div>
                <div className="text-xs font-medium text-muted-foreground">Portal access</div>
                <div className="text-sm text-foreground">{staffMember.uid ? 'Granted' : 'Not set up'}</div>
              </div>
            </CardContent>
          </Card>

          <p className="text-xs text-muted-foreground">
            Something here out of date? Contact Selouna Visser at{' '}
            <a href="mailto:Selouna.Visser@nwu.ac.za" className="underline">Selouna.Visser@nwu.ac.za</a> to have it updated.
          </p>
        </div>

        <div className="md:w-[480px]">
          {email && (hasPasswordProvider(user) ? <ChangePasswordCard email={email} /> : <SetUpPasswordCard email={email} />)}
        </div>
      </div>
    </div>
  )
}

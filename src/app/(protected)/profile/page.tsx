'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import {
  EmailAuthProvider,
  reauthenticateWithCredential,
  updatePassword,
  validatePassword,
  verifyBeforeUpdateEmail,
} from 'firebase/auth'
import { auth, db } from '@/lib/firebase/config'
import { collection, query, where, getDocs, addDoc, updateDoc, doc, limit } from 'firebase/firestore'
import { useAuth } from '@/context/AuthContext'
import { postStaffAdmin } from '@/lib/firebase/staff'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { nameInitials, avatarColorClass } from '@/lib/utils'
import type { StaffMember } from '@/types/database'

// Selouna's own record in the `staff` collection -- not a "real" staff
// member, just what lets her show up as a borrower in Stock Out (which
// reads exclusively from `staff`, see stock-out/page.tsx). Marked
// is_admin_account so the Staff management page filters it back out.
function MyDetailsCard({
  uid,
  authEmail,
  onNameSynced,
}: {
  uid: string
  authEmail: string
  onNameSynced: () => void
}) {
  const [staffDoc, setStaffDoc] = useState<StaffMember | null>(null)
  const [loadingDoc, setLoadingDoc] = useState(true)
  const [name, setName] = useState('')
  const [surname, setSurname] = useState('')
  const [department, setDepartment] = useState('')
  const [cardUid, setCardUid] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  async function load() {
    setLoadingDoc(true)
    const snap = await getDocs(query(collection(db, 'staff'), where('uid', '==', uid), limit(1)))
    if (!snap.empty) {
      const d = { id: snap.docs[0].id, ...snap.docs[0].data() } as unknown as StaffMember
      setStaffDoc(d)
      setName(d.name ?? '')
      setSurname(d.surname ?? '')
      setDepartment(d.department ?? '')
      setCardUid(d.card_uid ?? '')
    }
    setLoadingDoc(false)
  }

  useEffect(() => {
    // Loads this admin's own `staff` record from Firestore on mount -- an
    // external system read, not state derivable from props, so it can't be
    // a lazy useState initializer.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    const trimmedName = name.trim()
    const trimmedSurname = surname.trim()
    if (!trimmedName || !trimmedSurname) {
      setError('Name and surname are required.')
      return
    }
    setSaving(true)
    try {
      const fullName = `${trimmedName} ${trimmedSurname}`.trim()
      const payload = {
        name: trimmedName,
        surname: trimmedSurname,
        full_name: fullName,
        department: department.trim() || null,
        card_uid: cardUid.trim() || null,
        updated_at: new Date().toISOString(),
      }
      if (staffDoc) {
        await updateDoc(doc(db, 'staff', staffDoc.id.toString()), payload)
      } else {
        await addDoc(collection(db, 'staff'), {
          ...payload,
          email: authEmail || null,
          uid,
          is_admin_account: true,
          is_active: true,
          created_at: new Date().toISOString(),
        })
      }
      // profiles/{uid}.full_name is what the sidebar footer and every
      // transaction/audit-log entry attribute to her as "operator name" --
      // firestore.rules blocks writing it from the client entirely, so this
      // Admin SDK route keeps it in sync with what she just typed here.
      if (auth.currentUser) {
        await postStaffAdmin('/api/admin/update-name', auth.currentUser, { fullName })
        onNameSynced()
      }
      await load()
      toast.success('Details updated.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update details.')
    }
    setSaving(false)
  }

  if (loadingDoc) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">Loading…</CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>My details</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="admin-name">Name</Label>
              <Input id="admin-name" value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="admin-surname">Surname</Label>
              <Input id="admin-surname" value={surname} onChange={(e) => setSurname(e.target.value)} required />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="admin-department">Department</Label>
            <Input id="admin-department" value={department} onChange={(e) => setDepartment(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="admin-card-uid">Card UID</Label>
            <Input id="admin-card-uid" value={cardUid} onChange={(e) => setCardUid(e.target.value)} placeholder="Tap card, or leave blank" />
          </div>

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <Button type="submit" disabled={saving} className="mt-1 w-full justify-center">
            {saving ? 'Saving…' : 'Save details'}
          </Button>
          {!staffDoc && (
            <p className="text-xs text-muted-foreground">
              Saving this creates your own borrower record, so you can be picked as staff in Stock Out.
            </p>
          )}
        </form>
      </CardContent>
    </Card>
  )
}

function ChangeEmailCard({ currentEmail, onEmailChanged }: { currentEmail: string; onEmailChanged: (email: string) => void }) {
  const [newEmail, setNewEmail] = useState('')
  const [currentPassword, setCurrentPassword] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  // Set once a confirmation link has been sent to a new address -- the
  // account's email does NOT change until she clicks it (verifyBeforeUpdateEmail,
  // not updateEmail), so this is the address we're waiting to be confirmed,
  // not the current one. This is deliberately admin-only: staff email changes
  // (made by Selouna on the Staff page) stay immediate/unverified -- a staff
  // member who doesn't get an expected email can just tell her.
  const [pendingEmail, setPendingEmail] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (!auth.currentUser) return
    const normalized = newEmail.trim().toLowerCase()
    setSaving(true)
    try {
      // Firebase requires a recent sign-in before it'll let the account
      // change its own email, same as the password change below.
      await reauthenticateWithCredential(auth.currentUser, EmailAuthProvider.credential(currentEmail, currentPassword))
      await verifyBeforeUpdateEmail(auth.currentUser, normalized)
      setPendingEmail(normalized)
      toast.success(`Confirmation link sent to ${normalized}.`)
      setNewEmail('')
      setCurrentPassword('')
    } catch (err) {
      const code = (err as { code?: string })?.code
      if (code === 'auth/wrong-password' || code === 'auth/invalid-credential') {
        setError('Current password is incorrect.')
      } else if (code === 'auth/email-already-in-use') {
        setError('This email is already used by another account.')
      } else if (code === 'auth/invalid-email') {
        setError('Enter a valid email address.')
      } else if (code === 'auth/requires-recent-login') {
        setError('Please sign out and sign back in, then try again.')
      } else if (code === 'auth/operation-not-allowed') {
        setError('Email changes are not enabled for this project.')
      } else {
        setError(err instanceof Error ? err.message : 'Failed to send confirmation email.')
      }
    }
    setSaving(false)
  }

  async function handleCheckConfirmed() {
    if (!auth.currentUser || !pendingEmail) return
    setChecking(true)
    setError('')
    try {
      // reload() re-fetches this account's record from Auth -- if she's
      // clicked the link in the confirmation email, its `email` field has
      // already changed server-side, and this is what picks that up here.
      await auth.currentUser.reload()
      if (auth.currentUser.email === pendingEmail) {
        onEmailChanged(pendingEmail)
        setPendingEmail(null)
        toast.success('Email confirmed and updated.')
      } else {
        setError('Not confirmed yet. Click the link in the email we sent, then check again.')
      }
    } catch {
      setError('Could not check confirmation status. Try again in a moment.')
    }
    setChecking(false)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Change email</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {pendingEmail && (
          <Alert>
            <AlertDescription>
              We sent a confirmation link to <strong>{pendingEmail}</strong>. Your
              login email stays <strong>{currentEmail}</strong> until you click it.
            </AlertDescription>
          </Alert>
        )}

        {pendingEmail && (
          <Button
            type="button"
            variant="outline"
            disabled={checking}
            onClick={handleCheckConfirmed}
            className="w-full justify-center"
          >
            {checking ? 'Checking…' : "I've clicked the link — check now"}
          </Button>
        )}

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="new-email">New email</Label>
            <Input
              id="new-email"
              type="email"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              placeholder={currentEmail}
              required
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="email-current-password">Current password</Label>
            <Input
              id="email-current-password"
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
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
            {saving ? 'Sending…' : 'Send confirmation link'}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}

function ChangePasswordCard({ email }: { email: string }) {
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    // Checks the new password against the live Firebase Auth password
    // policy (Console: Authentication -> Settings -> Password policy) so
    // this form always matches whatever's actually enforced server-side,
    // rather than hard-coding the rules a second time here -- same check
    // as the lending portal's own ChangePasswordCard.
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
        </form>
      </CardContent>
    </Card>
  )
}

export default function AdminProfilePage() {
  const { user, profile, refreshProfile } = useAuth()
  const [email, setEmail] = useState('')

  useEffect(() => {
    // `user` resolves asynchronously from AuthContext -- this component's
    // hooks run before the `!user` guard below, so a lazy useState
    // initializer would miss the value once auth actually resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setEmail(user?.email ?? '')
  }, [user?.email])

  if (!user || !profile) return null

  async function handleEmailChanged(newEmail: string) {
    setEmail(newEmail)
    // Keep her own `staff` record's email in sync too, same "Auth first,
    // then Firestore" ordering the Staff page uses when an admin changes
    // someone ELSE's linked email (see /api/staff/update-email) -- here
    // it's her own account, so the client SDK update above already
    // succeeded before this Firestore write runs.
    const snap = await getDocs(query(collection(db, 'staff'), where('uid', '==', user!.uid), limit(1)))
    if (!snap.empty) {
      await updateDoc(doc(db, 'staff', snap.docs[0].id), { email: newEmail, updated_at: new Date().toISOString() })
    }
  }

  return (
    <div className="mx-auto flex max-w-[1000px] flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">My Profile</h1>
        <p className="mt-1 text-sm text-muted-foreground">Your BICS account, and your own borrower details for Stock Out.</p>
      </div>

      <div className="flex flex-col gap-6 md:flex-row md:items-start">
        <div className="flex flex-col gap-6 md:w-[480px]">
          <Card>
            <CardContent className="flex items-center gap-4">
              <Avatar className="size-14">
                <AvatarFallback className={`text-lg font-semibold text-white ${avatarColorClass(profile.full_name)}`}>
                  {nameInitials(profile.full_name)}
                </AvatarFallback>
              </Avatar>
              <div>
                <div className="text-lg font-semibold text-foreground">{profile.full_name}</div>
                <div className="text-sm text-muted-foreground">{email || '—'}</div>
              </div>
            </CardContent>
          </Card>

          <MyDetailsCard uid={user.uid} authEmail={email} onNameSynced={refreshProfile} />
        </div>

        <div className="flex flex-col gap-6 md:w-[480px]">
          <ChangeEmailCard currentEmail={email} onEmailChanged={handleEmailChanged} />
          {email && <ChangePasswordCard email={email} />}
        </div>
      </div>
    </div>
  )
}

'use client'

import { useEffect, useState } from 'react'
import { useAuth } from '@/context/AuthContext'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import {
  NOTIFICATION_EMAIL_DEFINITIONS,
  loadNotificationSettings,
  setNotificationSetting,
  loadAdminNotificationEmail,
  saveAdminNotificationEmail,
  type NotificationEmailDefinition,
} from '@/lib/firebase/notificationSettings'
import type { NotificationSettingKey } from '@/types/database'

function NotificationRow({
  definition, checked, disabled, onToggle,
}: {
  definition: NotificationEmailDefinition
  checked: boolean
  disabled: boolean
  onToggle: (next: boolean) => void
}) {
  return (
    <div className="flex items-start justify-between gap-6 border-b border-[#E5DBEC] py-4 last:border-b-0">
      <div className="flex-1">
        <div className="text-sm font-semibold text-[#22162B]">{definition.label}</div>
        <p className="mt-1 text-sm font-normal text-[#5B4F67]">{definition.description}</p>
      </div>
      <Switch
        checked={checked}
        onCheckedChange={onToggle}
        disabled={disabled}
        aria-label={definition.label}
        className="mt-0.5 shrink-0"
      />
    </div>
  )
}

// Sending isn't actually wired up anywhere yet (see the email-notifications
// review) — this page just gives Selouna a place to decide, ahead of time,
// which of these she wants once each one is built. Every toggle here saves
// itself immediately, same as the Staff page's Activate/Deactivate button —
// there's no separate "Save" step to forget.
export default function NotificationSettingsPage() {
  const { user, profile } = useAuth()
  const [settings, setSettings] = useState<Record<NotificationSettingKey, boolean> | null>(null)
  const [pendingKey, setPendingKey] = useState<NotificationSettingKey | null>(null)
  const [error, setError] = useState('')

  // The address the five "Emails to Selouna" below are actually sent to --
  // savedAdminEmail is what's in Firestore right now, adminEmail is the
  // (possibly-being-edited) form value, so the Save button can tell them
  // apart and disable itself once they match again.
  const [adminEmail, setAdminEmail] = useState('')
  const [savedAdminEmail, setSavedAdminEmail] = useState('')
  const [savingEmail, setSavingEmail] = useState(false)
  const [emailError, setEmailError] = useState('')

  useEffect(() => {
    // External read (Firestore), not state derivable from props.
    Promise.all([loadNotificationSettings(), loadAdminNotificationEmail()])
      .then(([toggles, email]) => {
        setSettings(toggles)
        setAdminEmail(email)
        setSavedAdminEmail(email)
      })
      .catch(() => setError('Could not load notification settings.'))
  }, [])

  async function handleSaveEmail(e: React.FormEvent) {
    e.preventDefault()
    setEmailError('')
    setSavingEmail(true)
    try {
      const trimmed = adminEmail.trim()
      await saveAdminNotificationEmail(trimmed, savedAdminEmail, {
        uid: user?.uid,
        name: profile?.full_name ?? user?.email,
      })
      setAdminEmail(trimmed)
      setSavedAdminEmail(trimmed)
    } catch (err) {
      setEmailError(err instanceof Error ? err.message : 'Failed to save that change — try again.')
    }
    setSavingEmail(false)
  }

  async function handleToggle(key: NotificationSettingKey, next: boolean) {
    if (!settings) return
    setError('')
    const previous = settings[key]
    setSettings({ ...settings, [key]: next }) // optimistic
    setPendingKey(key)
    try {
      await setNotificationSetting(key, next, previous, {
        uid: user?.uid,
        name: profile?.full_name ?? user?.email,
      })
    } catch (e) {
      console.error(e)
      setSettings((curr) => (curr ? { ...curr, [key]: previous } : curr)) // revert
      setError('Failed to save that change — try again.')
    }
    setPendingKey(null)
  }

  const staffEmails = NOTIFICATION_EMAIL_DEFINITIONS.filter((d) => d.recipient === 'Staff member')
  const adminEmails = NOTIFICATION_EMAIL_DEFINITIONS.filter((d) => d.recipient === 'Administrators')

  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <div>
        <h1 className="text-3xl font-extrabold tracking-tight text-[#22162B]">Notification Settings</h1>
        <p className="text-sm text-[#5B4F67]">
          Turn individual email notifications on or off. Switching one off only stops that one email —
          every other setting here keeps working independently of it.
        </p>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {!settings ? (
        <Card className="rounded-xl border border-[#E2D8E9] bg-white shadow-sm ring-0">
          <CardContent className="py-8 text-center text-sm text-[#5B4F67]">Loading…</CardContent>
        </Card>
      ) : (
        <>
          <Card className="rounded-xl border border-[#E2D8E9] bg-white shadow-sm ring-0">
            <CardHeader>
              <CardTitle>Admin notification address</CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSaveEmail} className="flex flex-col gap-2">
                <p className="text-sm text-[#5B4F67]">
                  Where the five &quot;Emails to Administrators&quot; below are actually delivered. Change this if
                  administration duties move to someone else — nothing here needs the toggles below touched.
                </p>
                <div className="flex items-end gap-3">
                  <div className="grid flex-1 gap-1.5">
                    <Label htmlFor="admin-notification-email">Email address</Label>
                    <Input
                      id="admin-notification-email"
                      type="email"
                      className="border-slate-300 bg-white text-slate-700 focus-visible:border-[#8046B5] focus-visible:ring-[#8046B5]/50"
                      value={adminEmail}
                      onChange={(e) => setAdminEmail(e.target.value)}
                      placeholder={user?.email ?? 'admin@nwu.ac.za'}
                    />
                  </div>
                  <Button type="submit" disabled={savingEmail || adminEmail.trim() === savedAdminEmail.trim()} className="h-8 rounded-lg bg-primary px-5 text-sm font-medium text-white shadow-sm hover:bg-[#582e78]">
                    {savingEmail ? 'Saving…' : 'Save'}
                  </Button>
                </div>
                {emailError && <p className="text-sm text-red-600">{emailError}</p>}
                {!savedAdminEmail && !emailError && (
                  <p className="text-sm text-[#5B4F67]">
                    Not set yet — the five emails below have nowhere to go until an address is saved here.
                  </p>
                )}
              </form>
            </CardContent>
          </Card>

          <Card className="rounded-xl border border-[#E2D8E9] bg-white shadow-sm ring-0">
            <CardHeader>
              <CardTitle>Emails to staff members</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col">
              {staffEmails.map((d) => (
                <NotificationRow
                  key={d.key}
                  definition={d}
                  checked={settings[d.key]}
                  disabled={pendingKey === d.key}
                  onToggle={(next) => handleToggle(d.key, next)}
                />
              ))}
            </CardContent>
          </Card>

          <Card className="rounded-xl border border-[#E2D8E9] bg-white shadow-sm ring-0">
            <CardHeader>
              <CardTitle>Emails to Administrators</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col">
              {adminEmails.map((d) => (
                <NotificationRow
                  key={d.key}
                  definition={d}
                  checked={settings[d.key]}
                  disabled={pendingKey === d.key}
                  onToggle={(next) => handleToggle(d.key, next)}
                />
              ))}
            </CardContent>
          </Card>

          <p className="text-sm text-[#5B4F67]">
            Password-reset emails (&quot;Send/Resend Login Email&quot; on the Staff page) aren&apos;t listed here —
            they already go out through Firebase&apos;s own built-in email flow, separate from these settings.
          </p>
        </>
      )}
    </div>
  )
}

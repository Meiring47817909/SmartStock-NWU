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
  loadSystemFromEmail,
  saveSystemFromEmail,
  type NotificationEmailDefinition,
} from '@/lib/api/settings'
import { DEFAULT_SYSTEM_EMAIL } from '@/lib/notificationCatalog'
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
        <div className="flex items-center gap-2 text-sm font-semibold text-[#22162B]">
          {definition.label}
          {definition.implemented === false && (
            <span className="rounded-full bg-[#F0EBF5] px-2 py-0.5 text-xs font-medium text-[#5B4F67]">
              Not implemented yet
            </span>
          )}
        </div>
        <p className="mt-1 text-sm font-normal text-[#5B4F67]">{definition.description}</p>
        {definition.implemented === false && definition.requirement && (
          <p className="mt-1.5 text-sm font-normal text-[#5B4F67]">{definition.requirement}</p>
        )}
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

// Turn individual notification emails on or off. Every toggle here saves
// itself immediately, same as the Staff page's Activate/Deactivate button —
// there's no separate "Save" step to forget. The three emails that still
// need a timer can't be turned on yet (see lib/notificationCatalog.ts).
export default function NotificationSettingsPage() {
  const { user } = useAuth()
  const [settings, setSettings] = useState<Record<NotificationSettingKey, boolean> | null>(null)
  const [pendingKey, setPendingKey] = useState<NotificationSettingKey | null>(null)
  const [error, setError] = useState('')

  // The address the five "Emails to Selouna" below are actually sent to --
  // savedAdminEmail is what's saved right now, adminEmail is the
  // (possibly-being-edited) form value, so the Save button can tell them
  // apart and disable itself once they match again.
  const [adminEmail, setAdminEmail] = useState('')
  const [savedAdminEmail, setSavedAdminEmail] = useState('')
  const [savingEmail, setSavingEmail] = useState(false)
  const [emailError, setEmailError] = useState('')

  // The address every system email is sent From -- same save pattern as the
  // administrator address above, but a separate field and a separate card.
  const [systemEmail, setSystemEmail] = useState('')
  const [savedSystemEmail, setSavedSystemEmail] = useState('')
  const [savingSystem, setSavingSystem] = useState(false)
  const [systemError, setSystemError] = useState('')

  useEffect(() => {
    // External read (the settings API), not state derivable from props.
    Promise.all([loadNotificationSettings(), loadAdminNotificationEmail(), loadSystemFromEmail()])
      .then(([toggles, email, systemFrom]) => {
        setSettings(toggles)
        setAdminEmail(email)
        setSavedAdminEmail(email)
        // Nothing saved -> show the default sender, which is what emails use.
        setSystemEmail(systemFrom || DEFAULT_SYSTEM_EMAIL)
        setSavedSystemEmail(systemFrom || DEFAULT_SYSTEM_EMAIL)
      })
      .catch(() => setError('Could not load notification settings.'))
  }, [])

  async function handleSaveEmail(e: React.FormEvent) {
    e.preventDefault()
    setEmailError('')
    setSavingEmail(true)
    try {
      const trimmed = adminEmail.trim()
      await saveAdminNotificationEmail(trimmed)
      setAdminEmail(trimmed)
      setSavedAdminEmail(trimmed)
    } catch (err) {
      setEmailError(err instanceof Error ? err.message : 'Failed to save that change — try again.')
    }
    setSavingEmail(false)
  }

  async function handleSaveSystemEmail(e: React.FormEvent) {
    e.preventDefault()
    setSystemError('')
    setSavingSystem(true)
    try {
      const trimmed = systemEmail.trim()
      await saveSystemFromEmail(trimmed)
      // Clearing the field and saving goes back to the default sender.
      setSystemEmail(trimmed || DEFAULT_SYSTEM_EMAIL)
      setSavedSystemEmail(trimmed || DEFAULT_SYSTEM_EMAIL)
    } catch (err) {
      setSystemError(err instanceof Error ? err.message : 'Failed to save that change — try again.')
    }
    setSavingSystem(false)
  }

  async function handleToggle(key: NotificationSettingKey, next: boolean) {
    if (!settings) return
    const definition = NOTIFICATION_EMAIL_DEFINITIONS.find((d) => d.key === key)
    if (next && definition?.implemented === false) {
      setError(`${definition.label} isn't implemented yet, so it can't be turned on.`)
      return
    }
    setError('')
    const previous = settings[key]
    setSettings({ ...settings, [key]: next }) // optimistic
    setPendingKey(key)
    try {
      await setNotificationSetting(key, next)
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
              {/* Save sits beside the address field; on phones it moves underneath. */}
              <form onSubmit={handleSaveEmail} className="flex flex-col gap-2">
                <p className="text-sm text-[#5B4F67]">
                  Where the five &quot;Emails to Administrators&quot; below are delivered. Change this if
                  administration duties move to someone else — the toggles below stay as they are and will send
                  to the new address.
                </p>
                <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-end">
                  <div className="grid w-full flex-1 gap-1.5">
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
              <CardTitle>System emails</CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSaveSystemEmail} className="flex flex-col gap-2">
                <p className="text-sm text-[#5B4F67]">
                  The address SmartStock sends every email from — loan request emails, Stock Out
                  confirmations and staff login emails.
                </p>
                <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-end">
                  <div className="grid w-full flex-1 gap-1.5">
                    <Label htmlFor="system-from-email">System sending address</Label>
                    <Input
                      id="system-from-email"
                      type="email"
                      className="border-slate-300 bg-white text-slate-700 focus-visible:border-[#8046B5] focus-visible:ring-[#8046B5]/50"
                      value={systemEmail}
                      onChange={(e) => setSystemEmail(e.target.value)}
                      placeholder={DEFAULT_SYSTEM_EMAIL}
                    />
                  </div>
                  <Button type="submit" disabled={savingSystem || systemEmail.trim() === savedSystemEmail.trim()} className="h-8 rounded-lg bg-primary px-5 text-sm font-medium text-white shadow-sm hover:bg-[#582e78]">
                    {savingSystem ? 'Saving…' : 'Save'}
                  </Button>
                </div>
                {systemError && <p className="text-sm text-red-600">{systemError}</p>}
              </form>
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

          <p className="text-sm text-[#5B4F67]">
            Password-reset emails (&quot;Send/Resend Login Email&quot; on the Staff page) aren&apos;t listed here —
            they already go out through Firebase&apos;s own built-in email flow, separate from these settings.
          </p>
        </>
      )}
    </div>
  )
}

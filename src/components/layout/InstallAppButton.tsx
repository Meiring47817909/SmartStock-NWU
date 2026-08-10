'use client'

import { useState } from 'react'
import { Download, X } from 'lucide-react'
import { useRole } from '@/context/RoleContext'
import { useInstallPrompt } from '@/context/InstallPromptContext'
import { Button } from '@/components/ui/button'

const IOS_HINT_DISMISSED_KEY = 'smartstock-ios-install-hint-dismissed'

function readIOSHintDismissed() {
  if (typeof window === 'undefined') return true // hidden until we can check, on the server
  return localStorage.getItem(IOS_HINT_DISMISSED_KEY) === '1'
}

/**
 * "Install App" call-to-action, visible only to admins. Everyone else never
 * sees an invitation to install — see (protected)/layout.tsx for why offline
 * use is admin-only.
 */
export default function InstallAppButton() {
  const { isAdmin } = useRole()
  const { canInstall, isInstalled, isIOS, promptInstall } = useInstallPrompt()
  const [installing, setInstalling] = useState(false)
  const [iosHintDismissed, setIosHintDismissed] = useState(readIOSHintDismissed)

  if (!isAdmin || isInstalled) return null

  async function handleClick() {
    setInstalling(true)
    await promptInstall()
    setInstalling(false)
  }

  function dismissIOSHint() {
    localStorage.setItem(IOS_HINT_DISMISSED_KEY, '1')
    setIosHintDismissed(true)
  }

  if (canInstall) {
    return (
      <Button
        onClick={handleClick}
        disabled={installing}
        className="mb-2 w-full justify-center bg-(--nwu-btn-primary) text-white hover:bg-(--nwu-btn-primary-hover)"
      >
        <Download className="size-3.5" />
        {installing ? 'Installing…' : 'Install App'}
      </Button>
    )
  }

  if (isIOS && !iosHintDismissed) {
    return (
      <div className="mb-2 flex items-start gap-1.5 rounded-md border border-white/20 bg-white/10 px-2.5 py-2 text-xs text-white/85">
        <span className="flex-1">Install: tap Share, then &quot;Add to Home Screen&quot;.</span>
        <Button variant="ghost" size="icon-xs" onClick={dismissIOSHint} className="text-white/70 hover:bg-white/10 hover:text-white">
          <X className="size-3.5" />
        </Button>
      </div>
    )
  }

  return null
}

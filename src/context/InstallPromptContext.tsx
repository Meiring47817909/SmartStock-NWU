'use client'

import { createContext, useCallback, useContext, useEffect, useState } from 'react'

// `beforeinstallprompt` is a real, widely-supported browser event, but it
// isn't part of TypeScript's bundled DOM types yet — declare it ourselves.
interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[]
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
  prompt(): Promise<void>
}

declare global {
  interface WindowEventMap {
    beforeinstallprompt: BeforeInstallPromptEvent
    appinstalled: Event
  }
}

interface InstallPromptContextValue {
  /** True once the browser has told us this app can be installed and we're holding a usable prompt. */
  canInstall: boolean
  /** True if the app is already running as an installed/standalone app. */
  isInstalled: boolean
  /** True on iOS, where there's no programmatic install prompt — only the manual Share sheet. */
  isIOS: boolean
  /** Shows the native install prompt. Resolves once the user has responded to it. */
  promptInstall: () => Promise<'accepted' | 'dismissed' | 'unavailable'>
}

const InstallPromptContext = createContext<InstallPromptContextValue>({
  canInstall: false,
  isInstalled: false,
  isIOS: false,
  promptInstall: async () => 'unavailable',
})

function detectStandalone() {
  if (typeof window === 'undefined') return false
  const nav = window.navigator as Navigator & { standalone?: boolean }
  return window.matchMedia?.('(display-mode: standalone)').matches || nav.standalone === true
}

function detectIOS() {
  if (typeof window === 'undefined') return false
  const ua = window.navigator.userAgent
  const isClassicIOS = /iPhone|iPad|iPod/.test(ua)
  // iPadOS 13+ reports itself as "Macintosh" unless "Request Desktop Site" is
  // off — the touch-point check disambiguates it from an actual Mac.
  const isIPadOS13Plus = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1
  return isClassicIOS || isIPadOS13Plus
}

export function InstallPromptProvider({ children }: { children: React.ReactNode }) {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null)
  const [isInstalled, setIsInstalled] = useState(detectStandalone)
  const [isIOS] = useState(detectIOS)

  useEffect(() => {
    const handleBeforeInstallPrompt = (e: BeforeInstallPromptEvent) => {
      e.preventDefault()
      setDeferredPrompt(e)
    }
    const handleAppInstalled = () => {
      setDeferredPrompt(null)
      setIsInstalled(true)
    }

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt)
    window.addEventListener('appinstalled', handleAppInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt)
      window.removeEventListener('appinstalled', handleAppInstalled)
    }
  }, [])

  const promptInstall = useCallback(async (): Promise<'accepted' | 'dismissed' | 'unavailable'> => {
    if (!deferredPrompt) return 'unavailable'
    await deferredPrompt.prompt()
    const { outcome } = await deferredPrompt.userChoice
    // A captured prompt event can only be used once.
    setDeferredPrompt(null)
    if (outcome === 'accepted') setIsInstalled(true)
    return outcome
  }, [deferredPrompt])

  return (
    <InstallPromptContext.Provider
      value={{ canInstall: !!deferredPrompt && !isInstalled, isInstalled, isIOS, promptInstall }}
    >
      {children}
    </InstallPromptContext.Provider>
  )
}

export function useInstallPrompt() {
  return useContext(InstallPromptContext)
}

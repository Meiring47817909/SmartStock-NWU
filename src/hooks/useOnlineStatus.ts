'use client'

import { useEffect, useState } from 'react'

/**
 * Tracks browser connectivity via navigator.onLine + the online/offline
 * events. Starts as `true` (online) on the server/first render to avoid
 * hydration mismatches; the real state is picked up immediately on mount.
 */
export function useOnlineStatus(): boolean {
  // Lazy initializer reads the real connectivity state on first client
  // render (and safely defaults to `true` during SSR, where `navigator`
  // doesn't exist).
  const [isOnline, setIsOnline] = useState(() =>
    typeof navigator !== 'undefined' ? navigator.onLine : true
  )

  useEffect(() => {
    const handleOnline = () => setIsOnline(true)
    const handleOffline = () => setIsOnline(false)

    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)
    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [])

  return isOnline
}

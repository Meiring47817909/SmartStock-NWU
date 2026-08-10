'use client'

import { useEffect, useRef, useState } from 'react'

const LOCK_NAME = 'smartstock-nwu-single-instance'

export type TabLockStatus = 'checking' | 'held' | 'blocked' | 'unsupported'

/**
 * Uses the Web Locks API to detect whether another tab/window of this app
 * (on the same browser profile) already holds an exclusive lock. When
 * `enabled` is true and no other tab holds it, this tab acquires the lock
 * and keeps it until it closes or navigates away — the browser releases it
 * automatically at that point, no manual cleanup required.
 *
 * `enabled` should only be true for roles that need this enforced (admin) —
 * pass `false` to skip acquiring/checking entirely, e.g. for staff.
 */
function locksSupported() {
  return typeof navigator !== 'undefined' && !!navigator.locks
}

export function useSingleTabLock(enabled: boolean): { status: TabLockStatus; retry: () => void } {
  const [status, setStatus] = useState<TabLockStatus>(() => {
    if (!enabled) return 'held'
    return locksSupported() ? 'checking' : 'unsupported'
  })
  const [attempt, setAttempt] = useState(0)
  const releaseRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    if (!enabled || !locksSupported()) return

    let cancelled = false

    navigator.locks.request(LOCK_NAME, { ifAvailable: true }, lock => {
      if (cancelled) return undefined
      if (!lock) {
        setStatus('blocked')
        return undefined
      }
      setStatus('held')
      // Hold the lock open until the component unmounts or the tab closes.
      return new Promise<void>(resolve => {
        releaseRef.current = resolve
      })
    })

    return () => {
      cancelled = true
      releaseRef.current?.()
      releaseRef.current = null
    }
  }, [enabled, attempt])

  function retry() {
    setStatus('checking')
    setAttempt(a => a + 1)
  }

  return { status, retry }
}

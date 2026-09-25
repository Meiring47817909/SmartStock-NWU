import { useCallback, useState } from 'react'

/**
 * Tracks which table rows are expanded, allowing any number at once.
 *
 * Every expandable table in this app used to hold a single
 * `useState<string | null>`, so opening one row silently closed another —
 * which makes comparing two entries impossible. A Set keeps them
 * independent, and putting it here means the seven tables that need it
 * behave identically rather than each re-implementing the toggle.
 */
export function useExpandedRows() {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())

  const isExpanded = useCallback((id: string) => expanded.has(id), [expanded])

  /** Flips one row. Returns true if it is now open — callers that fetch
   *  on expand need to know which way it went. */
  const toggle = useCallback((id: string) => {
    // Read the answer off the current snapshot before queueing the update,
    // since setExpanded is asynchronous and callers act on the result
    // immediately (fetch-on-expand).
    const willOpen = !expanded.has(id)
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    return willOpen
  }, [expanded])

  /** Closes one row, e.g. after an action removes it from the list. */
  const collapse = useCallback((id: string) => {
    setExpanded((prev) => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }, [])

  const collapseAll = useCallback(() => setExpanded(new Set()), [])

  return { isExpanded, toggle, collapse, collapseAll }
}

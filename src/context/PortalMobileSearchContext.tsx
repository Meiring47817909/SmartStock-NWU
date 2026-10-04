'use client'

import { createContext, useContext, useState, type ReactNode } from 'react'

// Bridges the header's mobile-only search icon (lend/layout.tsx) to the
// Browse page's own search/filter card (lend/page.tsx) — the two live in
// separate components (shell header vs. routed page), so a plain prop
// can't pass between them. On desktop this state is never read: the
// filter card there is always visible regardless of `mobileSearchOpen`
// (see its md:flex override).
interface PortalMobileSearchContextValue {
  mobileSearchOpen: boolean
  setMobileSearchOpen: (open: boolean) => void
  toggleMobileSearch: () => void
}

const PortalMobileSearchContext = createContext<PortalMobileSearchContextValue | null>(null)

export function PortalMobileSearchProvider({ children }: { children: ReactNode }) {
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false)
  const toggleMobileSearch = () => setMobileSearchOpen((v) => !v)
  return (
    <PortalMobileSearchContext.Provider value={{ mobileSearchOpen, setMobileSearchOpen, toggleMobileSearch }}>
      {children}
    </PortalMobileSearchContext.Provider>
  )
}

export function usePortalMobileSearch() {
  const ctx = useContext(PortalMobileSearchContext)
  if (!ctx) throw new Error('usePortalMobileSearch must be used within PortalMobileSearchProvider')
  return ctx
}

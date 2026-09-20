'use client'

import { createContext, useContext } from 'react'
import type { Role } from '@/types/database'

// Every capability is admin-only: the 'staff' role exists solely for the
// lending portal, which lives outside this provider entirely. The flags are
// kept as separate named booleans rather than collapsed into a single
// `isAdmin` check at each call site so that re-introducing a middle role
// later is one edit here instead of a hunt through every page — and so the
// Sidebar keeps reading as a description of what each section needs.
//
// This is defense in depth, not the primary gate: (protected)/layout.tsx
// redirects any non-admin out of the whole tree before these are consulted.
interface RoleContextValue {
  role: Role
  isAdmin: boolean
  canManageStock: boolean        // admin only — Stock Out / Stock In / Returns
  canManageProducts: boolean     // admin only
  canManageStaff: boolean        // admin only
  canViewReports: boolean        // admin only
  canViewAuditLog: boolean       // admin only
  canManageLoanRequests: boolean // admin only — Selouna's loan-requests queue
}

// Default is the fully-locked-down shape — a consumer rendered outside a
// RoleProvider gets nothing, never BICS access by accident.
const RoleContext = createContext<RoleContextValue>({
  role: 'staff',
  isAdmin: false,
  canManageStock: false,
  canManageProducts: false,
  canManageStaff: false,
  canViewReports: false,
  canViewAuditLog: false,
  canManageLoanRequests: false,
})

export function RoleProvider({ role, children }: { role: Role; children: React.ReactNode }) {
  const isAdmin = role === 'admin'
  const value: RoleContextValue = {
    role,
    isAdmin,
    canManageStock: isAdmin,
    canManageProducts: isAdmin,
    canManageStaff: isAdmin,
    canViewReports: isAdmin,
    canViewAuditLog: isAdmin,
    canManageLoanRequests: isAdmin,
  }
  return <RoleContext.Provider value={value}>{children}</RoleContext.Provider>
}

export function useRole() {
  return useContext(RoleContext)
}

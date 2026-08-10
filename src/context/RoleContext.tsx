'use client'

import { createContext, useContext } from 'react'
import type { Role } from '@/types/database'

interface RoleContextValue {
  role: Role
  isAdmin: boolean
  isManager: boolean
  canManageStock: boolean   // admin + manager + staff
  canManageProducts: boolean // admin + manager
  canManageStaff: boolean   // admin only
  canViewReports: boolean   // admin + manager
  canViewAuditLog: boolean  // admin only
  canWorkOffline: boolean   // admin only — see (protected)/layout.tsx offline gate
}

const RoleContext = createContext<RoleContextValue>({
  role: 'staff',
  isAdmin: false,
  isManager: false,
  canManageStock: true,
  canManageProducts: false,
  canManageStaff: false,
  canViewReports: false,
  canViewAuditLog: false,
  canWorkOffline: false,
})

export function RoleProvider({ role, children }: { role: Role; children: React.ReactNode }) {
  const value: RoleContextValue = {
    role,
    isAdmin: role === 'admin',
    isManager: role === 'manager',
    canManageStock: true,
    canManageProducts: role === 'admin' || role === 'manager',
    canManageStaff: role === 'admin',
    canViewReports: role === 'admin' || role === 'manager',
    canViewAuditLog: role === 'admin',
    canWorkOffline: role === 'admin',
  }
  return <RoleContext.Provider value={value}>{children}</RoleContext.Provider>
}

export function useRole() {
  return useContext(RoleContext)
}

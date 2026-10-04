// Pure catalog types and helpers shared by the server data layer (src/server/data/catalog.ts) and the browser
// client (src/lib/api/catalog.ts). No server-only or Firebase imports: both sides load this file.
import type { LendingInterval, LoanRequestStatus } from '@/types/database'

/** The product form's fields, as sent to create/update. */
export interface ProductInput {
  /** Optional 20-character [A-Za-z0-9] id chosen by the caller (so photos can be uploaded under products/<id>/ before the save). */
  id?: string
  name: string
  barcodes: string[]
  category_id: string | null
  description: string
  quantity_on_hand: number
  reorder_threshold: number
  available: boolean
  location: string
  lend_from: string | null
  lend_to: string | null
  lending_interval: LendingInterval
  /** Firebase Storage paths. */
  images: string[]
  /** Update only: why Qty On Hand changed. Goes into the audit entry's `after`, never onto the product. */
  quantity_reason?: string
}

export interface CategoryInput {
  name: string
  description: string
}

export interface OutstandingHolder {
  txnId: string
  staffName: string
  quantity: number
  txnRef: string
}

export interface BarcodeUnitCount {
  inStock: number
  outstanding: number
  total: number
}

export interface ReservationHolder {
  requestId: string
  staffId: string
  staffName: string
  quantity: number
  fromDate: string
  toDate: string | null // null = indefinite loan, no return date
  status: LoanRequestStatus
}

export interface ProductDeleteBlockers {
  outstanding: OutstandingHolder[]
  reservations: ReservationHolder[]
}

// Same wording as reservationStatusLabel in src/lib/firebase/loanRequests.ts (which stays until the loan-request
// task moves it into loanRequestRules.ts).
function reservationStatusLabel(status: LoanRequestStatus): string {
  switch (status) {
    case 'accepted': return 'approved pickup'
    case 'countered': return 'countered offer'
    default: return 'pending request'
  }
}

// A short, specific reason the product can't be deleted right now, or null once it's clear — names exactly
// who/what, same convention as formatQuantityConflictError on the Products page.
export function productDeleteBlockReason(blockers: ProductDeleteBlockers): string | null {
  const parts: string[] = []
  if (blockers.outstanding.length > 0) {
    parts.push(
      blockers.outstanding
        .map(h => `${h.quantity} unit(s) checked out with ${h.staffName}${h.txnRef ? ` (${h.txnRef})` : ''}`)
        .join(', '),
    )
  }
  if (blockers.reservations.length > 0) {
    parts.push(
      blockers.reservations
        .map(h => `${h.quantity} unit(s) on a ${reservationStatusLabel(h.status)} for ${h.staffName}`)
        .join(', '),
    )
  }
  if (parts.length === 0) return null
  return `Still in use — ${parts.join('; ')}. Resolve or cancel these first.`
}

/** The message shown when a barcode belongs to another product. */
export function barcodeConflictMessage(code: string): string {
  return `Barcode "${code}" is already used by another product.`
}

/** The message shown when a category still has products. */
export function categoryInUseMessage(count: number): string {
  return `${count} product${count === 1 ? '' : 's'} still ${count === 1 ? 'uses' : 'use'} this category. Move or delete ${count === 1 ? 'it' : 'them'} first.`
}

// Barcode lookup/validation helpers shared by Stock In, Stock Out, and the
// Products page. A product can carry multiple barcode values (see the
// `barcodes` comment in src/types/database.ts), so any code lookup needs to
// match against the whole array rather than a single field.
//
// Legacy fallback: products created before the multi-barcode change may
// still have the old single `barcode: string` field instead of `barcodes`.
// Every lookup here also checks that legacy field so old records keep
// working until they're next edited and migrated over.

import { db } from './config'
import { collection, doc, getDoc, getDocs, query, where } from 'firebase/firestore'
import type { Product } from '@/types/database'
import {
  ALL_TIME_FROM, OPEN_ENDED_TO, getReservationHolders, reservationStatusLabel,
  type ReservationHolder,
} from './loanRequests'
import { loadWaivedByTxn, waivedQty } from './waivers'

export async function findProductByBarcode(code: string): Promise<(Product & { id: string }) | null> {
  const trimmed = code.trim()
  if (!trimmed) return null

  const productsRef = collection(db, 'products')

  const arraySnap = await getDocs(query(productsRef, where('barcodes', 'array-contains', trimmed)))
  if (!arraySnap.empty) {
    const d = arraySnap.docs[0]
    return { id: d.id, ...d.data() } as Product & { id: string }
  }

  // Legacy single-field fallback.
  const legacySnap = await getDocs(query(productsRef, where('barcode', '==', trimmed)))
  if (!legacySnap.empty) {
    const d = legacySnap.docs[0]
    return { id: d.id, ...d.data() } as Product & { id: string }
  }

  return null
}

// Checks whether any barcode in `codes` is already in use by a product
// other than `excludeId` (the product currently being edited, if any).
// Returns the conflicting code, or null if there's no conflict.
export async function findBarcodeConflict(codes: string[], excludeId?: string): Promise<string | null> {
  const trimmed = codes.map(c => c.trim()).filter(Boolean)
  if (trimmed.length === 0) return null

  const productsRef = collection(db, 'products')

  // array-contains-any accepts at most 10 values — comfortably covers a
  // single product's barcode list in practice.
  const arraySnap = await getDocs(query(productsRef, where('barcodes', 'array-contains-any', trimmed.slice(0, 10))))
  for (const d of arraySnap.docs) {
    if (d.id === excludeId) continue
    const existing: string[] = (d.data().barcodes as string[] | undefined) ?? []
    const hit = trimmed.find(c => existing.includes(c))
    if (hit) return hit
  }

  // Legacy single-field fallback.
  const legacySnap = await getDocs(query(productsRef, where('barcode', 'in', trimmed.slice(0, 10))))
  for (const d of legacySnap.docs) {
    if (d.id === excludeId) continue
    const existing = d.data().barcode as string | undefined
    if (existing && trimmed.includes(existing)) return existing
  }

  return null
}
// ---------------------------------------------------------------------------
// Delete guard — a product can only be deleted once nothing currently ties
// it up: no unreturned OUT stock, and no not-yet-fulfilled loan request
// (pending/countered/accepted) still promising it to someone. Both checks
// are scoped to this one product's own records rather than the Dashboard's
// app-wide scan for its Outstanding Returns / Incoming Pickups tables.

export interface OutstandingHolder {
  txnId: string
  staffName: string
  quantity: number
  txnRef: string
}

// Same "issued − returned − waived" ledger the Dashboard's Outstanding
// Returns table computes for every product at once — this walks only the
// transaction_lines for THIS product, then resolves just their parent
// transactions, rather than fetching every OUT/RETURN transaction that
// exists.
export async function getOutstandingHolders(productId: string): Promise<OutstandingHolder[]> {
  const linesSnap = await getDocs(query(collection(db, 'transaction_lines'), where('product_id', '==', productId)))
  const lines = linesSnap.docs.map(d => d.data() as { transaction_id: string; quantity: number })
  if (lines.length === 0) return []

  const qtyByTxn: Record<string, number> = {}
  lines.forEach(l => { qtyByTxn[l.transaction_id] = (qtyByTxn[l.transaction_id] ?? 0) + (l.quantity || 0) })

  const txnSnaps = await Promise.all(
    Object.keys(qtyByTxn).map(id => getDoc(doc(db, 'transactions', id))),
  )
  const txns = txnSnaps.filter(s => s.exists()).map(s => ({ id: s.id, ...s.data() }) as any)

  const returnedByOutTxn: Record<string, number> = {}
  txns.forEach(t => {
    if (t.transaction_type === 'RETURN' && t.linked_txn_id) {
      returnedByOutTxn[t.linked_txn_id] = (returnedByOutTxn[t.linked_txn_id] ?? 0) + (qtyByTxn[t.id] ?? 0)
    }
  })

  const waivedByTxn = await loadWaivedByTxn()

  const holders: OutstandingHolder[] = []
  txns.forEach(t => {
    if (t.transaction_type !== 'OUT') return
    const issued = qtyByTxn[t.id] ?? 0
    const returned = returnedByOutTxn[t.id] ?? 0
    const waived = waivedQty(waivedByTxn, t.id, productId)
    const remaining = issued - returned - waived
    if (remaining > 0) {
      holders.push({ txnId: t.id, staffName: t.staff_name ?? '\u2014', quantity: remaining, txnRef: t.reference_no ?? '' })
    }
  })
  return holders
}

export interface ProductDeleteBlockers {
  outstanding: OutstandingHolder[]
  reservations: ReservationHolder[]
}

export async function getProductDeleteBlockers(productId: string): Promise<ProductDeleteBlockers> {
  const [outstanding, reservations] = await Promise.all([
    getOutstandingHolders(productId),
    // All-time window — a delete has no date range of its own to check
    // against, unlike Stock Out or a portal submission, so this asks about
    // every active reservation regardless of when it falls (same sentinel
    // findQuantityReductionConflicts uses for the same reason).
    getReservationHolders(productId, ALL_TIME_FROM, OPEN_ENDED_TO),
  ])
  return { outstanding, reservations }
}

// A short, specific reason the product can't be deleted right now, or null
// once it's clear — names exactly who/what, same convention as
// formatQuantityConflictError on the Products page.
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

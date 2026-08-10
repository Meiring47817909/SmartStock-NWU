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
import { collection, getDocs, query, where } from 'firebase/firestore'
import type { Product } from '@/types/database'

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

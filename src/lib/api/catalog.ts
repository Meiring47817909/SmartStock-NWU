// Browser client for the catalog API (categories, products, barcodes). Same function names as the Firestore
// helpers in src/lib/firebase/products.ts, minus the server-side `ctx`.
//
// Routes (all JSON; the Firebase ID token is attached by api()):
//   GET  /api/categories                              admin    list
//   POST /api/categories { action: create|update|delete, ... }  admin
//   GET  /api/products[?availableOnly=true]           public   list
//   POST /api/products <ProductInput>                 admin    create
//   GET  /api/products/<id>                           public   one (404 → null here)
//   POST /api/products/<id> { action: update|delete } admin
//   GET  /api/products/lookup?kind=…                  admin    barcode / conflict / holders / unitCounts / deleteBlockers
import { api, ClientApiError } from '@/lib/api/client'
import type { Category, Product } from '@/types/database'
import type {
  BarcodeUnitCount,
  CategoryInput,
  OutstandingHolder,
  ProductDeleteBlockers,
  ProductInput,
} from '@/lib/catalogRules'

export { productDeleteBlockReason } from '@/lib/catalogRules'
export type {
  BarcodeUnitCount,
  CategoryInput,
  OutstandingHolder,
  ProductDeleteBlockers,
  ProductInput,
  ReservationHolder,
} from '@/lib/catalogRules'

// --- Categories --------------------------------------------------------------

export function listCategories(): Promise<Category[]> {
  return api<Category[]>('GET', '/api/categories')
}

export function createCategory(input: CategoryInput): Promise<Category> {
  return api<Category>('POST', '/api/categories', { action: 'create', ...input })
}

export function updateCategory(id: string, input: CategoryInput): Promise<Category> {
  return api<Category>('POST', '/api/categories', { action: 'update', id, ...input })
}

/** Rejects with a 409 ClientApiError ("N product(s) still use this category…") while products use it. */
export async function deleteCategory(id: string): Promise<void> {
  await api<{ ok: true }>('POST', '/api/categories', { action: 'delete', id })
}

// --- Products ----------------------------------------------------------------

export function listProducts(opts: { availableOnly?: boolean } = {}): Promise<Product[]> {
  return api<Product[]>('GET', '/api/products', opts.availableOnly ? { availableOnly: true } : undefined)
}

/** The product, or null when it doesn't exist. */
export async function getProduct(id: string): Promise<Product | null> {
  try {
    return await api<Product>('GET', `/api/products/${encodeURIComponent(id)}`)
  } catch (err) {
    if (err instanceof ClientApiError && err.status === 404) return null
    throw err
  }
}

/** A fresh 20-character id for `ProductInput.id`, so photos can be uploaded under products/<id>/ before the save. */
export function newProductId(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let id = ''
  while (id.length < 20) {
    for (const b of crypto.getRandomValues(new Uint8Array(32))) {
      // 62 does not divide 256: skip the top few byte values so every character is equally likely.
      if (b < 248 && id.length < 20) id += alphabet[b % 62]
    }
  }
  return id
}

/** 409 with "Barcode "X" is already used by another product." when a barcode belongs to another product. */
export function createProduct(input: ProductInput): Promise<Product> {
  return api<Product>('POST', '/api/products', input)
}

export function updateProduct(id: string, input: ProductInput): Promise<Product> {
  return api<Product>('POST', `/api/products/${encodeURIComponent(id)}`, { action: 'update', product: input })
}

/** 409 with the "Still in use — …" reason while stock is out or reserved. */
export async function deleteProduct(id: string): Promise<void> {
  await api<{ ok: true }>('POST', `/api/products/${encodeURIComponent(id)}`, { action: 'delete' })
}

// --- Barcode and ledger lookups ----------------------------------------------

export function findProductByBarcode(code: string): Promise<Product | null> {
  return api<Product | null>('GET', '/api/products/lookup', { kind: 'barcode', code })
}

/** The first code another product already uses, or null. */
export function findBarcodeConflict(codes: string[], excludeId?: string): Promise<string | null> {
  return api<string | null>('GET', '/api/products/lookup', { kind: 'conflict', codes: JSON.stringify(codes), excludeId })
}

export function getOutstandingHolders(productId: string): Promise<OutstandingHolder[]> {
  return api<OutstandingHolder[]>('GET', '/api/products/lookup', { kind: 'holders', productId })
}

export function getBarcodeUnitCounts(productId: string): Promise<Record<string, BarcodeUnitCount>> {
  return api<Record<string, BarcodeUnitCount>>('GET', '/api/products/lookup', { kind: 'unitCounts', productId })
}

export function getProductDeleteBlockers(productId: string): Promise<ProductDeleteBlockers> {
  return api<ProductDeleteBlockers>('GET', '/api/products/lookup', { kind: 'deleteBlockers', productId })
}

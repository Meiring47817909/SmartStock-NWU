import { route } from '@/server/http'
import { DataError } from '@/server/context'
import {
  findBarcodeConflict,
  findProductByBarcode,
  getBarcodeUnitCounts,
  getOutstandingHolders,
  getProductDeleteBlockers,
} from '@/server/data/catalog'

// Admin lookups for the Products / Stock screens, picked with `?kind=`:
//   barcode        &code=…                       → Product | null
//   conflict       &codes=<JSON array>[&excludeId=…] → the first barcode another product already uses, or null
//   holders        &productId=…                  → OutstandingHolder[]
//   unitCounts     &productId=…                  → Record<barcode, { inStock, outstanding, total }>
//   deleteBlockers &productId=…                  → { outstanding, reservations }
type Query = { kind?: string; code?: string; codes?: string; excludeId?: string; productId?: string }

function parseCodes(raw: string | undefined): string[] {
  try {
    const parsed: unknown = JSON.parse(raw ?? '[]')
    if (Array.isArray(parsed) && parsed.every((c) => typeof c === 'string')) return parsed
  } catch {
    // fall through
  }
  throw new DataError(400, 'codes must be a JSON array of strings.')
}

export const GET = route<Query>('admin', async (ctx, q) => {
  switch (q.kind) {
    case 'barcode':
      return findProductByBarcode(ctx, q.code ?? '')
    case 'conflict':
      return findBarcodeConflict(ctx, parseCodes(q.codes), q.excludeId || undefined)
    case 'holders':
      return getOutstandingHolders(ctx, q.productId ?? '')
    case 'unitCounts':
      return getBarcodeUnitCounts(ctx, q.productId ?? '')
    case 'deleteBlockers':
      return getProductDeleteBlockers(ctx, q.productId ?? '')
    default:
      throw new DataError(400, 'Unknown lookup.')
  }
})

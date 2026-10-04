import type { Product } from '@/types/database'

// The scanned-items table on Stock Out / Stock In (and, for Returns, the
// scanned list) has one ROW PER (product, barcode): scanning a product via
// two different barcodes gives two rows for it, each with its own quantity.
// Each row becomes one transaction_lines document. The stock counters, the
// stock-availability caps and the audit-log summary work per PRODUCT though,
// so these helpers give that per-product view of the rows.
export interface ScanRow {
  product: Product
  quantity: number
  // null only on a Stock Out row that came from a loan request and has not
  // been scanned yet ("awaiting scan"); every persisted line has a barcode.
  barcode: string | null
}

export interface ProductGroup {
  product: Product
  quantity: number
  // Distinct barcodes across the product's scanned rows, first-scanned first.
  barcodes: string[]
  // How many units were scanned under each of those barcodes.
  barcodeQuantities: { barcode: string; quantity: number }[]
}

export function totalForProduct(rows: ScanRow[], productId: Product['id']): number {
  return rows.reduce((s, r) => (r.product.id === productId ? s + r.quantity : s), 0)
}

export function groupRowsByProduct(rows: ScanRow[]): ProductGroup[] {
  const groups = new Map<string, ProductGroup>()
  for (const r of rows) {
    const key = String(r.product.id)
    let g = groups.get(key)
    if (!g) { g = { product: r.product, quantity: 0, barcodes: [], barcodeQuantities: [] }; groups.set(key, g) }
    g.quantity += r.quantity
    if (r.barcode) {
      if (!g.barcodes.includes(r.barcode)) g.barcodes.push(r.barcode)
      const bq = g.barcodeQuantities.find(b => b.barcode === r.barcode)
      if (bq) bq.quantity += r.quantity
      else g.barcodeQuantities.push({ barcode: r.barcode, quantity: r.quantity })
    }
  }
  return [...groups.values()]
}

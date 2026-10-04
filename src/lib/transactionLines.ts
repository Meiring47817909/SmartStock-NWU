// A transaction can carry more than one transaction_lines document for the
// same product: Stock Out / Stock In / Returns write one line per (product,
// barcode) scanned, so a product scanned via two barcodes is two lines. Every
// outstanding-return calculation is keyed by [transaction][product] though
// (returned and waived quantities are per-product totals), so it has to work
// from a per-product view of an OUT transaction's lines. Iterating the raw
// lines instead would subtract the same per-product returned/waived total
// once per barcode line and understate what is still owed.

export interface CollapsedLine {
  product_id: string
  product_name?: string
  quantity: number
  // Every distinct barcode scanned for this product on the transaction, in
  // the order first scanned. Empty when none was recorded.
  barcodes: string[]
  // Units per barcode, same order as `barcodes`.
  barcodeQuantities: { barcode: string; quantity: number }[]
  // Same counts, labelled for display. A Return line for a unit whose label
  // was lost reads "ISSUED → RETURNED AS"; every other line is just its barcode.
  barcodeLabels: { label: string; quantity: number }[]
}

export function formatBarcodeLabels(bl: { label: string; quantity: number }[]): string[] {
  return bl.map(b => `${b.label} ×${b.quantity}`)
}

// Barcodes still outstanding on ONE product of an OUT transaction: issued per
// barcode, minus what came back against that barcode (a lost-label return
// counts against its issued_barcode), in issue order. Units that can't be
// pinned to a barcode -- written-off (waived) units and returns recorded
// without one -- are taken off the earliest open barcodes first, the same
// first-fit the Returns screen uses.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function openBarcodeQuantities(outLines: any[], returnLines: any[], waived: number): { barcode: string; quantity: number }[] {
  const issued = new Map<string, number>()
  let legacyIssued = 0
  for (const l of outLines) {
    const q = l.quantity || 0
    if (typeof l.barcode === 'string' && l.barcode) issued.set(l.barcode, (issued.get(l.barcode) ?? 0) + q)
    else legacyIssued += q
  }
  const returned = new Map<string, number>()
  let legacyReturned = 0
  for (const l of returnLines) {
    const q = l.quantity || 0
    const relieves = (typeof l.issued_barcode === 'string' && l.issued_barcode) ? l.issued_barcode : l.barcode
    if (typeof relieves === 'string' && relieves) returned.set(relieves, (returned.get(relieves) ?? 0) + q)
    else legacyReturned += q
  }
  const legacyOpen = Math.max(0, legacyIssued - legacyReturned)
  const waivedOnLegacy = Math.min(Math.max(0, waived), legacyOpen)
  let surplus = Math.max(0, legacyReturned - legacyIssued) + (Math.max(0, waived) - waivedOnLegacy)
  const out: { barcode: string; quantity: number }[] = []
  issued.forEach((qty, code) => {
    const open = Math.max(0, qty - (returned.get(code) ?? 0))
    const take = Math.min(surplus, open)
    surplus -= take
    if (open - take > 0) out.push({ barcode: code, quantity: open - take })
  })
  return out
}

// "A ×2", "B ×1" -- every barcode is shown with its count, including ×1.
export function formatBarcodeQuantities(bq: { barcode: string; quantity: number }[]): string[] {
  return bq.map(b => `${b.barcode} ×${b.quantity}`)
}

// Collapses lines to one entry per product, summing quantity and collecting
// the distinct barcodes. Order follows each product's first appearance.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function collapseLinesByProduct(lines: any[]): CollapsedLine[] {
  const byProduct = new Map<string, CollapsedLine>()
  for (const l of lines) {
    const key = String(l.product_id)
    let entry = byProduct.get(key)
    if (!entry) {
      entry = { product_id: l.product_id, product_name: l.product_name, quantity: 0, barcodes: [], barcodeQuantities: [], barcodeLabels: [] }
      byProduct.set(key, entry)
    }
    entry.quantity += l.quantity || 0
    if (typeof l.barcode === 'string' && l.barcode) {
      if (!entry.barcodes.includes(l.barcode)) entry.barcodes.push(l.barcode)
      const bq = entry.barcodeQuantities.find(b => b.barcode === l.barcode)
      if (bq) bq.quantity += l.quantity || 0
      else entry.barcodeQuantities.push({ barcode: l.barcode, quantity: l.quantity || 0 })
      const label = typeof l.issued_barcode === 'string' && l.issued_barcode && l.issued_barcode !== l.barcode
        ? `${l.issued_barcode} → ${l.barcode}` : l.barcode
      const bl = entry.barcodeLabels.find(b => b.label === label)
      if (bl) bl.quantity += l.quantity || 0
      else entry.barcodeLabels.push({ label, quantity: l.quantity || 0 })
    }
  }
  return [...byProduct.values()]
}

// Pure stock-movement helpers and shapes shared by the server (src/server/data/stock.ts) and the browser client
// (src/lib/api/stock.ts). No Firebase, no database.

// Outstanding stock is never stored: it is replayed from the append-only ledger as (issued on an OUT line) - (returned
// against that same OUT transaction). A waiver is the third term: the item is written off without a RETURN ever
// happening. Keyed [OUT transaction id][product_id], like the returned-quantity maps the Dashboard, Returns, Staff and
// Reports pages build: the same staff member can hold the same product from two loans, and writing one off must not
// cancel the other.
export type WaivedByTxn = Record<string, Record<string, number>>

export function waivedQty(map: WaivedByTxn, txnId: string, productId: string | number): number {
  return map[txnId]?.[String(productId)] ?? 0
}

/**
 * One row of a stock movement, as the pages' scan tables have them: a product, how many units, and the barcode(s) they
 * were scanned under. Send one item per (product, barcode) row; several items for the same product are fine.
 */
export interface StockItemInput {
  productId: string
  /** Whole units, above zero. */
  quantity: number
  /**
   * Barcodes the units were scanned under, each registered to the product. One barcode: every unit is under it. Several:
   * the quantity is spread across them. Left out: the product's own registered barcodes (a product with none gets a
   * line without a barcode). Ignored on an adjustment.
   */
  barcodes?: string[]
  /**
   * Returns only: the barcode the unit LEFT with, when it lost its label. `barcodes` is then the single registered
   * barcode now on it, and the return is counted against `issuedBarcode`.
   */
  issuedBarcode?: string | null
  /** Stock In only; defaults to 0. */
  unitCost?: number
}

export interface StockInInput {
  items: StockItemInput[]
  notes?: string | null
}

export interface StockOutInput {
  staffId: string
  items: StockItemInput[]
  /** YYYY-MM-DD. */
  lendFrom?: string | null
  /** YYYY-MM-DD; blank means no return date agreed. */
  lendTo?: string | null
  /** The staff member was picked from a list instead of scanning their card. */
  manualOverride?: boolean
  notes?: string | null
  /** An accepted loan request this Stock Out fulfils: it is marked fulfilled in the same transaction. */
  linkedRequestId?: string | null
}

export interface ReturnInput {
  staffId: string
  /** The OUT transaction the units come back against. One return transaction settles one OUT. */
  linkedTxnId: string
  items: StockItemInput[]
  /** YYYY-MM-DD. */
  returnDate?: string | null
  manualOverride?: boolean
  notes?: string | null
}

export interface AdjustInput {
  /** 1 adds the quantities to stock, -1 removes them. */
  direction: 1 | -1
  items: StockItemInput[]
  notes?: string | null
}

export interface StockMovementResult {
  id: string
  reference_no: string
}

export interface CreateReturnWaiverInput {
  transactionId: string
  productId: string
  quantity: number
  reason?: string | null
  /** Optional extra check for the Staff page: the transaction must belong to this staff member. */
  staffId?: string
}

/** One (Stock Out, product, barcode) with units still to come back: what a scan on the Returns page is matched against. */
export interface OutstandingLine {
  txn_id: string
  txn_ref: string
  /** ISO timestamp of the Stock Out. */
  txn_date: string
  /** `${txn_id}|${product_id}|${barcode}` */
  line_id: string
  product_id: string
  product_name: string
  barcode: string
  issued_qty: number
  already_returned: number
  returnable: number
  /** The Stock Out's Lend To date (YYYY-MM-DD), null when none was agreed. */
  expected_date: string | null
  linked_request_id: string | null
  linked_request_ref: string | null
}

/** Units issued with no recorded barcode (legacy Stock Outs): nothing to match a scan against. */
export interface UnscannableLine {
  txn_ref: string
  product_name: string
  quantity: number
}

export interface OutstandingForStaff {
  /** Oldest Stock Out first. */
  lines: OutstandingLine[]
  unscannable: UnscannableLine[]
}

export interface BarcodeBalance {
  barcode: string
  issued: number
  returned: number
  /** Units still out under this barcode (never below zero). */
  open: number
}

export interface ProductBalance {
  /** In issue order. */
  barcodes: BarcodeBalance[]
  /** Units issued without a barcode that have not come back. */
  legacyOpen: number
}

/**
 * Where one product stands on ONE Stock Out: per barcode, issued minus returned, ignoring waivers (a written-off item
 * can still turn up and must remain returnable). A return counts against the barcode the unit LEFT with
 * (`issued_barcode` on a lost-label return, else its own barcode). Returns recorded without a barcode cancel barcode-less
 * issues first; any surplus comes off the barcodes in issue order.
 */
export function productBalance(
  outLines: { barcode: string | null; quantity: number }[],
  returnLines: { barcode: string | null; issued_barcode: string | null; quantity: number }[],
): ProductBalance {
  const issued = new Map<string, number>()
  let legacyIssued = 0
  for (const l of outLines) {
    if (l.barcode) issued.set(l.barcode, (issued.get(l.barcode) ?? 0) + l.quantity)
    else legacyIssued += l.quantity
  }
  const returnedExact = new Map<string, number>()
  let legacyReturned = 0
  for (const l of returnLines) {
    const relieves = l.issued_barcode || l.barcode
    if (relieves) returnedExact.set(relieves, (returnedExact.get(relieves) ?? 0) + l.quantity)
    else legacyReturned += l.quantity
  }
  let surplus = Math.max(0, legacyReturned - legacyIssued)
  const barcodes: BarcodeBalance[] = []
  issued.forEach((qty, barcode) => {
    const exact = returnedExact.get(barcode) ?? 0
    const fromSurplus = Math.min(surplus, Math.max(0, qty - exact))
    surplus -= fromSurplus
    const returned = exact + fromSurplus
    barcodes.push({ barcode, issued: qty, returned, open: Math.max(0, qty - returned) })
  })
  return { barcodes, legacyOpen: Math.max(0, legacyIssued - legacyReturned) }
}

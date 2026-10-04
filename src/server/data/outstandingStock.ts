import 'server-only'
import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import type { Db, Tx } from '@/server/db/client'
import { returnWaivers, transactionLines, transactions } from '@/server/db/schema'

// The one place that answers "what is still out, per Stock Out and product": issued on the OUT transaction, minus what
// came back against that same transaction (RETURN transactions linked to it), minus what was written off (return
// waivers). A product's several lines on one Stock Out (one per barcode) add up first, because returned and waived
// quantities are per-product totals. Shared by the Dashboard (rows and Sidebar badge) and the expected-return dates, so
// they can't drift apart; the per-barcode view the Returns page needs is listOutstandingForStaff in stock.ts.

export interface OutstandingTxnProduct {
  txnId: string
  productId: string
  /** The name on the product's first line of the Stock Out (frozen at write time). */
  productName: string
  staffId: string | null
  staffName: string | null
  referenceNo: string
  /** The Stock Out's Lend To (YYYY-MM-DD); null when no return date was agreed. */
  lendTo: string | null
  /** When the Stock Out was recorded. */
  issuedAt: Date
  issued: number
  returned: number
  waived: number
  /** issued - returned - waived, always above zero here. */
  outstanding: number
}

export interface OutstandingOptions {
  /** Only these products. */
  productIds?: string[]
  /** Only Stock Outs with a Lend To (an open-ended issue has no due date to show). */
  datedOnly?: boolean
}

/**
 * Every (Stock Out, product) with units still to come back, oldest due date first (undated last), then oldest Stock Out,
 * then the product's position on it.
 */
export async function listOutstandingTxnProducts(db: Db | Tx, opts: OutstandingOptions = {}): Promise<OutstandingTxnProduct[]> {
  if (opts.productIds && opts.productIds.length === 0) return []

  const issuedSq = db
    .select({
      txnId: transactions.id,
      productId: transactionLines.product_id,
      productName: sql<string>`(array_agg(${transactionLines.product_name} order by ${transactionLines.created_at}, ${transactionLines.line_no}, ${transactionLines.id}))[1]`.as('product_name'),
      staffId: transactions.staff_id,
      staffName: transactions.staff_name,
      referenceNo: transactions.reference_no,
      lendTo: transactions.lend_to,
      issuedAt: transactions.created_at,
      firstLineNo: sql<number>`min(${transactionLines.line_no})::int`.as('first_line_no'),
      issued: sql<number>`sum(${transactionLines.quantity})::int`.as('issued'),
    })
    .from(transactions)
    .innerJoin(transactionLines, eq(transactionLines.transaction_id, transactions.id))
    .where(
      and(
        eq(transactions.transaction_type, 'OUT'),
        opts.datedOnly ? isNotNull(transactions.lend_to) : undefined,
        opts.productIds ? inArray(transactionLines.product_id, opts.productIds) : undefined,
      ),
    )
    .groupBy(transactions.id, transactionLines.product_id)
    .as('issued_sq')

  const returnedSq = db
    .select({
      txnId: transactions.linked_txn_id,
      productId: transactionLines.product_id,
      returned: sql<number>`sum(${transactionLines.quantity})::int`.as('returned'),
    })
    .from(transactions)
    .innerJoin(transactionLines, eq(transactionLines.transaction_id, transactions.id))
    .where(
      and(
        eq(transactions.transaction_type, 'RETURN'),
        isNotNull(transactions.linked_txn_id),
        opts.productIds ? inArray(transactionLines.product_id, opts.productIds) : undefined,
      ),
    )
    .groupBy(transactions.linked_txn_id, transactionLines.product_id)
    .as('returned_sq')

  const waivedSq = db
    .select({
      txnId: returnWaivers.transaction_id,
      productId: returnWaivers.product_id,
      waived: sql<number>`sum(${returnWaivers.quantity})::int`.as('waived'),
    })
    .from(returnWaivers)
    .where(opts.productIds ? inArray(returnWaivers.product_id, opts.productIds) : undefined)
    .groupBy(returnWaivers.transaction_id, returnWaivers.product_id)
    .as('waived_sq')

  const returned = sql<number>`coalesce(${returnedSq.returned}, 0)::int`
  const waived = sql<number>`coalesce(${waivedSq.waived}, 0)::int`
  const rows = await db
    .select({
      txnId: issuedSq.txnId,
      productId: issuedSq.productId,
      productName: issuedSq.productName,
      staffId: issuedSq.staffId,
      staffName: issuedSq.staffName,
      referenceNo: issuedSq.referenceNo,
      lendTo: issuedSq.lendTo,
      issuedAt: issuedSq.issuedAt,
      issued: issuedSq.issued,
      returned,
      waived,
    })
    .from(issuedSq)
    .leftJoin(returnedSq, and(eq(returnedSq.txnId, issuedSq.txnId), eq(returnedSq.productId, issuedSq.productId)))
    .leftJoin(waivedSq, and(eq(waivedSq.txnId, issuedSq.txnId), eq(waivedSq.productId, issuedSq.productId)))
    .where(sql`${issuedSq.issued} - ${returned} - ${waived} > 0`)
    .orderBy(sql`${issuedSq.lendTo} asc nulls last`, asc(issuedSq.issuedAt), asc(issuedSq.txnId), asc(issuedSq.firstLineNo), asc(issuedSq.productId))

  return rows.map((r) => ({ ...r, outstanding: r.issued - r.returned - r.waived }))
}

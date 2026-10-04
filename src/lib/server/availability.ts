import 'server-only'
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import type { Db, Tx } from '@/server/db/client'
import { returnWaivers, transactionLines, transactions } from '@/server/db/schema'

// Server-only: for a product that's fully checked out (quantity_on_hand === 0), this answers "when is it expected back"
// by replaying the same issued/returned/waived math the Dashboard, Returns and Staff pages use, scoped to a set of
// product ids, and taking the earliest outstanding OUT line's lend_to for each. It runs behind
// /api/products/expected-return-dates, which any signed-in user (BICS or portal) can call even though transactions are
// admin-only elsewhere: the route only ever returns one date per product, never the underlying transactions or staff.
// Kept in sync with that same math — if it changes there, mirror the change here too.
export async function getExpectedReturnDates(
  db: Db | Tx,
  productIds: string[],
): Promise<Record<string, string | null>> {
  const result: Record<string, string | null> = {}
  productIds.forEach((id) => { result[id] = null })
  if (productIds.length === 0) return result

  // What each OUT transaction issued of these products. An open-ended issue (no lend_to) has no due date to show, so it
  // never matters here whether it is still outstanding. A transaction's several lines for one product add up.
  const issued = await db
    .select({
      txnId: transactions.id,
      productId: transactionLines.product_id,
      dueDate: transactions.lend_to,
      quantity: sql<number>`sum(${transactionLines.quantity})::int`,
    })
    .from(transactions)
    .innerJoin(transactionLines, eq(transactionLines.transaction_id, transactions.id))
    .where(
      and(
        eq(transactions.transaction_type, 'OUT'),
        isNotNull(transactions.lend_to),
        inArray(transactionLines.product_id, productIds),
      ),
    )
    .groupBy(transactions.id, transactionLines.product_id, transactions.lend_to)
  if (issued.length === 0) return result
  const outIds = [...new Set(issued.map((i) => i.txnId))]

  const returned = await db
    .select({
      txnId: transactions.linked_txn_id,
      productId: transactionLines.product_id,
      quantity: sql<number>`sum(${transactionLines.quantity})::int`,
    })
    .from(transactions)
    .innerJoin(transactionLines, eq(transactionLines.transaction_id, transactions.id))
    .where(
      and(
        eq(transactions.transaction_type, 'RETURN'),
        inArray(transactions.linked_txn_id, outIds),
        inArray(transactionLines.product_id, productIds),
      ),
    )
    .groupBy(transactions.linked_txn_id, transactionLines.product_id)

  const waived = await db
    .select({
      txnId: returnWaivers.transaction_id,
      productId: returnWaivers.product_id,
      quantity: sql<number>`sum(${returnWaivers.quantity})::int`,
    })
    .from(returnWaivers)
    .where(and(inArray(returnWaivers.transaction_id, outIds), inArray(returnWaivers.product_id, productIds)))
    .groupBy(returnWaivers.transaction_id, returnWaivers.product_id)

  const key = (txnId: string | null, productId: string) => `${txnId}\u0000${productId}`
  const returnedBy = new Map(returned.map((r) => [key(r.txnId, r.productId), r.quantity]))
  const waivedBy = new Map(waived.map((w) => [key(w.txnId, w.productId), w.quantity]))

  for (const line of issued) {
    const outstanding = line.quantity - (returnedBy.get(key(line.txnId, line.productId)) ?? 0) - (waivedBy.get(key(line.txnId, line.productId)) ?? 0)
    if (outstanding <= 0 || !line.dueDate) continue
    const current = result[line.productId]
    if (!current || line.dueDate < current) result[line.productId] = line.dueDate
  }

  return result
}

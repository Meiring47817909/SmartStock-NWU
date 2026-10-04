import 'server-only'
import type { Db, Tx } from '@/server/db/client'
import { listOutstandingTxnProducts } from '@/server/data/outstandingStock'

// Server-only: for a product that's fully checked out (quantity_on_hand === 0), this answers "when is it expected back"
// by replaying the same issued/returned/waived math the Dashboard, Returns and Staff pages use (the shared
// listOutstandingTxnProducts), scoped to a set of product ids, and taking the earliest outstanding OUT line's lend_to
// for each. It runs behind /api/products/expected-return-dates, which any signed-in user (BICS or portal) can call even
// though transactions are admin-only elsewhere: the route only ever returns one date per product, never the underlying
// transactions or staff.
export async function getExpectedReturnDates(
  db: Db | Tx,
  productIds: string[],
): Promise<Record<string, string | null>> {
  const result: Record<string, string | null> = {}
  productIds.forEach((id) => { result[id] = null })
  if (productIds.length === 0) return result

  // An open-ended issue (no lend_to) has no due date to show, so it never matters here whether it is still outstanding.
  for (const line of await listOutstandingTxnProducts(db, { productIds, datedOnly: true })) {
    if (!line.lendTo) continue
    const current = result[line.productId]
    if (!current || line.lendTo < current) result[line.productId] = line.lendTo
  }

  return result
}

import 'server-only'
import { adminDb } from '@/lib/firebase/admin'

// Server-only twin of what used to live in lib/firebase/availability.ts —
// moved here after the portal Browse page tripped a firestore.rules
// evaluation error trying to run this client-side. `transactions`,
// `transaction_lines`, and `return_waivers` are admin-only reads in
// firestore.rules (transactions in particular is every staff member's full
// borrow history, not something a portal borrower should be able to query
// broadly just to find out when one product is back) — so this now runs
// with the Admin SDK behind /api/products/expected-return-dates, which any
// signed-in user (BICS or portal) can call, rather than as a direct
// client-side Firestore query.
//
// For a product that's fully checked out (quantity_on_hand === 0), this
// answers "when is it expected back" by replaying the same issued/returned/
// waived math dashboardAlerts.ts uses, scoped to a set of product ids, and
// taking the earliest outstanding OUT line's lend_to for each. Kept in sync
// with that same math — if it changes there, mirror the change here too.
export async function getExpectedReturnDates(
  productIds: string[],
): Promise<Record<string, string | null>> {
  const result: Record<string, string | null> = {}
  productIds.forEach((id) => { result[id] = null })
  if (productIds.length === 0) return result

  const idSet = new Set(productIds)

  const [outSnap, returnSnap, linesSnap, waiversSnap] = await Promise.all([
    adminDb.collection('transactions').where('transaction_type', '==', 'OUT').get(),
    adminDb.collection('transactions').where('transaction_type', '==', 'RETURN').get(),
    adminDb.collection('transaction_lines').get(),
    adminDb.collection('return_waivers').get(),
  ])

  const outTxns = outSnap.docs.map((d) => ({ id: d.id, ...d.data() })) as any[]
  const returnTxns = returnSnap.docs.map((d) => ({ id: d.id, ...d.data() })) as any[]

  const linesByTxn: Record<string, any[]> = {}
  linesSnap.forEach((d) => {
    const l = d.data()
    ;(linesByTxn[l.transaction_id] ??= []).push(l)
  })

  const returnedByTxn: Record<string, Record<string, number>> = {}
  returnTxns.forEach((t) => {
    if (!t.linked_txn_id) return
    const bucket = (returnedByTxn[t.linked_txn_id] ??= {})
    ;(linesByTxn[t.id] || []).forEach((l: any) => {
      bucket[l.product_id] = (bucket[l.product_id] ?? 0) + (l.quantity || 0)
    })
  })

  const waivedByTxn: Record<string, Record<string, number>> = {}
  waiversSnap.forEach((d) => {
    const w = d.data() as any
    if (!w.transaction_id) return
    const bucket = (waivedByTxn[w.transaction_id] ??= {})
    const pid = String(w.product_id)
    bucket[pid] = (bucket[pid] ?? 0) + (w.quantity || 0)
  })

  outTxns.forEach((t) => {
    ;(linesByTxn[t.id] || []).forEach((l: any) => {
      if (!idSet.has(l.product_id)) return
      const issued = l.quantity || 0
      const returned = returnedByTxn[t.id]?.[l.product_id] ?? 0
      const waived = waivedByTxn[t.id]?.[String(l.product_id)] ?? 0
      if (issued - returned - waived <= 0) return
      const dueDate: string | null = t.lend_to || null
      if (!dueDate) return // open-ended issue — no due date to show
      const current = result[l.product_id]
      if (!current || dueDate < current) result[l.product_id] = dueDate
    })
  })

  return result
}

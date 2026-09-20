import { db } from './config'
import { collection, getDocs, addDoc } from 'firebase/firestore'
import { logAudit } from './audit'
import type { ReturnWaiver } from '@/types/database'

// Outstanding stock is never stored — it's replayed every time from the
// append-only ledger as (issued on an OUT line) − (returned against that
// same OUT transaction). A waiver is the third term in that subtraction:
// Selouna has agreed the staff member keeps the item, so the remaining
// balance is written off without a RETURN ever happening.
//
// Keyed [OUT transaction id][product_id], exactly like the `returnedByTxn`
// maps the Dashboard / Returns / Staff / Reports pages already build — a
// waiver has to be scoped to its specific originating OUT transaction for
// the same reason a return does: the same staff member can hold the same
// product from two different loans, and writing one off must not silently
// cancel the other.
export type WaivedByTxn = Record<string, Record<string, number>>

export async function loadWaivedByTxn(): Promise<WaivedByTxn> {
  const snap = await getDocs(collection(db, 'return_waivers'))
  const map: WaivedByTxn = {}
  snap.forEach((d) => {
    const w = d.data() as ReturnWaiver
    if (!w.transaction_id) return
    const bucket = (map[w.transaction_id] ??= {})
    const pid = String(w.product_id)
    bucket[pid] = (bucket[pid] ?? 0) + (w.quantity || 0)
  })
  return map
}

// Convenience for the two call sites that want the whole waiver documents
// rather than just the totals (the Staff page's expanded row, which still
// displays written-off items so Selouna has a record of who kept what).
export async function loadWaivers(): Promise<ReturnWaiver[]> {
  const snap = await getDocs(collection(db, 'return_waivers'))
  return snap.docs.map((d) => ({ id: d.id, ...d.data() })) as ReturnWaiver[]
}

export function waivedQty(map: WaivedByTxn, txnId: string, productId: string | number): number {
  return map[txnId]?.[String(productId)] ?? 0
}

interface CreateWaiverInput {
  transactionId: string
  productId: string | number
  productName: string
  staffId: number | null
  staffName: string | null
  quantity: number
  reason?: string | null
  actorUid?: string | null
  actorName?: string | null
}

// Writes the waiver and its audit entry. Deliberately does NOT touch
// Product.quantity_on_hand: the stock left the shelf when it was issued and
// isn't coming back, so on-hand is already correct.
//
// Logged against the ORIGINATING transaction's own entity_type/entity_id
// (not a separate 'return_waiver' entity) — a resolve is conceptually
// something that happened to that Stock Out, and Selouna wants to find it
// there in the Audit Log (filter to Transaction, or expand that same
// transaction) rather than in an unrelated-looking bucket of its own. The
// 'resolve' action is what actually distinguishes it from the transaction's
// own 'create' entry — see ACTION_BADGE_CLASS/ResolveSummary in
// audit-log/page.tsx.
export async function createReturnWaiver(input: CreateWaiverInput): Promise<string> {
  const payload: Omit<ReturnWaiver, 'id'> = {
    transaction_id: input.transactionId,
    product_id: String(input.productId),
    product_name: input.productName,
    staff_id: input.staffId,
    staff_name: input.staffName,
    quantity: input.quantity,
    reason: input.reason ?? null,
    created_at: new Date().toISOString(),
    resolved_by_uid: input.actorUid ?? null,
    resolved_by_name: input.actorName ?? null,
  }
  const ref = await addDoc(collection(db, 'return_waivers'), payload)
  logAudit({
    userId: input.actorUid,
    userName: input.actorName,
    action: 'resolve',
    entityType: 'transaction',
    entityId: input.transactionId,
    before: null,
    after: payload as unknown as Record<string, unknown>,
  })
  return ref.id
}

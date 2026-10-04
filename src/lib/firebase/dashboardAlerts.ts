// A lean, counts-only version of the Dashboard's three "needs attention"
// tabs (Outstanding Returns, Incoming Pickups, Low Stock Alerts). Used by
// the Sidebar to show a combined badge next to the Dashboard nav item, so
// admins can tell there's something to look at without opening the page
// first.
//
// Pending/countered loan requests are deliberately NOT counted here — the
// Dashboard page itself has no tab for them (that's the Loan Requests
// page's job, see loanRequests.ts's loadLoanRequestsAlertCount()) — only
// accepted ones count, as Incoming Pickups. An earlier version of this
// file counted pending/countered too, which inflated the Sidebar's
// Dashboard badge above the sum of the Dashboard's own visible tabs.
//
// Deliberately kept in sync with dashboard/page.tsx's own logic (same
// remaining = issued - returned - waived math for Outstanding Returns,
// same quantity_on_hand <= reorder_threshold check for Low Stock, same
// expireIfNeeded() lazy-transition pass for Incoming Pickups) so the
// Sidebar's total always agrees with what the Dashboard tabs show. If the
// Dashboard's counting logic changes, mirror the change here too.
import { db } from './config'
import { collection, query, where } from 'firebase/firestore'
import { getDocsFresh } from './freshDocs'
import { loadWaivedByTxn, waivedQty } from './waivers'
import { expireIfDue } from '@/lib/api/loanRequests'
import type { LoanRequest } from '@/types/database'
import { collapseLinesByProduct } from '@/lib/transactionLines'

export interface DashboardAlertCounts {
  outstandingReturns: number
  lowStock: number
  incomingPickups: number
  total: number
}

export async function loadDashboardAlertCounts(): Promise<DashboardAlertCounts> {
  const transactionsRef = collection(db, 'transactions')

  const [productsSnap, outSnap, returnSnap, linesSnap, waivedByTxn, loanReqSnap] = await Promise.all([
    getDocsFresh(collection(db, 'products')),
    getDocsFresh(query(transactionsRef, where('transaction_type', '==', 'OUT'))),
    getDocsFresh(query(transactionsRef, where('transaction_type', '==', 'RETURN'))),
    getDocsFresh(collection(db, 'transaction_lines')),
    loadWaivedByTxn(),
    getDocsFresh(collection(db, 'loan_requests')),
  ])

  let lowStock = 0
  productsSnap.forEach(doc => {
    const p = doc.data() as any
    if ((p.quantity_on_hand ?? 0) <= (p.reorder_threshold ?? 0)) lowStock++
  })

  const outTxns = outSnap.docs.map(d => ({ id: d.id, ...d.data() })) as any[]
  const returnTxns = returnSnap.docs.map(d => ({ id: d.id, ...d.data() })) as any[]
  const linesByTxn: Record<string, any[]> = {}
  linesSnap.forEach(d => {
    const l = d.data()
    ;(linesByTxn[l.transaction_id] ??= []).push(l)
  })
  const returnedByTxn: Record<string, Record<string, number>> = {}
  returnTxns.forEach(t => {
    if (!t.linked_txn_id) return
    const bucket = (returnedByTxn[t.linked_txn_id] ??= {})
    ;(linesByTxn[t.id] || []).forEach((l: any) => {
      bucket[l.product_id] = (bucket[l.product_id] ?? 0) + (l.quantity || 0)
    })
  })
  let outstandingReturns = 0
  outTxns.forEach(t => {
    collapseLinesByProduct(linesByTxn[t.id] || []).forEach((l: any) => {
      const issued = l.quantity || 0
      const returned = returnedByTxn[t.id]?.[l.product_id] ?? 0
      const waived = waivedQty(waivedByTxn, t.id, l.product_id)
      if (issued - returned - waived > 0) outstandingReturns++
    })
  })

  let loanReqs = loanReqSnap.docs.map(d => ({ id: d.id, ...d.data() })) as LoanRequest[]
  loanReqs = await Promise.all(loanReqs.map(async (r) => {
    if (r.status !== 'pending' && r.status !== 'countered' && r.status !== 'accepted') return r
    const next = await expireIfDue(r)
    return next !== r.status ? { ...r, status: next } : r
  }))
  const incomingPickups = loanReqs.filter(r => r.status === 'accepted').length

  return {
    outstandingReturns,
    lowStock,
    incomingPickups,
    total: outstandingReturns + lowStock + incomingPickups,
  }
}

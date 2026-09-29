'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import { genRef, formatDateOnly, sentenceCase, todayDateStr } from '@/lib/utils'
import { CreditCard, CheckCircle, Users, Search, RotateCcw } from 'lucide-react'
import { db } from '@/lib/firebase/config'
import { collection, query, where, getDocs, addDoc, updateDoc, doc, getDoc, orderBy } from 'firebase/firestore'
import { logAudit } from '@/lib/firebase/audit'
import { useAuth } from '@/context/AuthContext'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import type { StaffMember } from '@/types/database'

interface OpenLine {
  txn_id: string
  txn_ref: string
  txn_date: string
  line_id: string
  product_id: string
  product_name: string
  barcode: string
  issued_qty: number
  already_returned: number
  returnable: number
  returning: number
  // The originating Stock Out transaction's Lend To date (Stage A) — null
  // for transactions created before that field existed.
  expected_date: string | null
  // The loan request that Stock Out was issued against, inherited so the
  // RETURN can record it directly. A return of a walk-in issue has none.
  linked_request_id: string | null
  linked_request_ref: string | null
}

// Partial takes priority over timing: if some of this line has already come
// back, what matters is that a balance is still owed, not whether today
// happens to be before/on/after the due date. Only computed for lines with
// nothing returned yet and a known expected_date — legacy transactions from
// before Stage A have no lend_to to compare against.
//
// Labels describe urgency of the still-open balance, not a judgement on a
// completed action — nothing has been returned yet at this point, so
// "Early/On time/Late" (which reads naturally in the Reports Returns tab,
// describing an actual past return) would misleadingly imply the return
// already happened.
function lineStatus(l: OpenLine): { label: string; className: string } | null {
  if (l.already_returned > 0) return { label: 'Partial', className: 'bg-amber-100 text-amber-800 border-amber-200/60 px-2.5 font-semibold' }
  if (!l.expected_date) return null
  const today = todayDateStr()
  if (today > l.expected_date) return { label: 'Overdue', className: 'bg-red-100 text-red-800 border-red-200/60 px-2.5 font-semibold' }
  if (today === l.expected_date) return { label: 'Due Today', className: 'bg-amber-100 text-amber-800 border-amber-200/60 px-2.5 font-semibold' }
  return { label: 'Not Due Yet', className: 'bg-emerald-100 text-emerald-800 border-emerald-200/60 px-2.5 font-semibold' }
}

type Step = 'staff' | 'items' | 'done'

export default function ReturnsPage() {
  const { user, profile } = useAuth()
  const [step, setStep] = useState<Step>('staff')
  const [staff, setStaff] = useState<StaffMember | null>(null)
  const [manualOverride, setManualOverride] = useState(false)
  const [uidInput, setUidInput] = useState('')
  const [lines, setLines] = useState<OpenLine[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [references, setReferences] = useState<string[]>([])

  // Manual staff selection
  const [showStaffSearch, setShowStaffSearch] = useState(false)
  const [staffList, setStaffList] = useState<StaffMember[]>([])
  const [staffSearch, setStaffSearch] = useState('')
  const [staffLoading, setStaffLoading] = useState(false)

  // HID card reader
  const hidBuf = useRef({ buf: '', t: 0 })
  const handleHID = useCallback((raw: string) => {
    if (step === 'staff') lookupUID(raw)
  }, [step])

  useEffect(() => {
    const GAP = 80, MIN = 6
    function onKey(e: KeyboardEvent) {
      if (e.ctrlKey || e.altKey || e.metaKey) return
      if (e.key.length > 1 && e.key !== 'Enter') return
      const tag = (document.activeElement as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      const now = Date.now()
      if (now - hidBuf.current.t > GAP) hidBuf.current.buf = ''
      hidBuf.current.t = now
      if (e.key === 'Enter') {
        if (hidBuf.current.buf.length >= MIN) { handleHID(hidBuf.current.buf); hidBuf.current.buf = '' }
        return
      }
      hidBuf.current.buf += e.key
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [handleHID])

  async function lookupUID(uid: string) {
    setError(''); setLoading(true)
    const snap = await getDocs(query(collection(db, 'staff'), where('card_uid', '==', uid), where('is_active', '==', true)))
    if (snap.empty) { setError('Card not registered. Use "Select manually".'); setLoading(false); return }
    const data = { id: snap.docs[0].id, ...snap.docs[0].data() } as unknown as StaffMember
    await loadOpenItems(data, false)
    setLoading(false)
  }

  async function loadOpenItems(s: StaffMember, manual: boolean) {
    setStaff(s)
    setManualOverride(manual)
    setLoading(true)
    setError('')

    const outTxnsSnap = await getDocs(query(
      collection(db, 'transactions'),
      where('staff_id', '==', s.id),
      where('transaction_type', '==', 'OUT')
    ))

    if (outTxnsSnap.empty) {
      setLines([])
      setStep('items')
      setLoading(false)
      return
    }

    const returnTxnsSnap = await getDocs(query(
      collection(db, 'transactions'),
      where('staff_id', '==', s.id),
      where('transaction_type', '==', 'RETURN')
    ))

    // transaction_lines is its own collection now (not an embedded array) —
    // fetch it once and group by transaction_id.
    const relevantTxnIds = new Set([
      ...outTxnsSnap.docs.map(d => d.id),
      ...returnTxnsSnap.docs.map(d => d.id),
    ])
    const linesSnap = await getDocs(collection(db, 'transaction_lines'))
    const linesByTxn: Record<string, any[]> = {}
    linesSnap.forEach(d => {
      const l = d.data()
      if (relevantTxnIds.has(l.transaction_id)) {
        (linesByTxn[l.transaction_id] ??= []).push(l)
      }
    })

    // Keyed by [originating OUT transaction id][product_id] — NOT a flat
    // per-product total. A RETURN transaction always records which OUT
    // transaction it was returning against, via linked_txn_id (see
    // handleConfirm below). Scoping it this way matters: a staff member can
    // have more than one OUT transaction for the same product over time, and
    // a return against one of them must not reduce the returnable quantity
    // on an unrelated, later OUT transaction for that same product — a flat
    // per-product map here previously caused exactly that, incorrectly
    // shrinking (or entirely hiding, once it hit zero) products on a fresh
    // Stock Out because of an unrelated return from a past transaction.
    const returnedByTxn: Record<string, Record<string, number>> = {}
    returnTxnsSnap.forEach(doc => {
      const txn = doc.data()
      const linkedTxnId = txn.linked_txn_id as string | undefined
      if (!linkedTxnId) return
      const lines = linesByTxn[doc.id] || []
      lines.forEach((l: any) => {
        const bucket = (returnedByTxn[linkedTxnId] ??= {})
        bucket[l.product_id] = (bucket[l.product_id] ?? 0) + (l.quantity || 0)
      })
    })

    // Lines Selouna has written off (Dashboard → Resolve) are NOT
    // excluded here. A write-off just means she's stopped chasing the
    // item and it's no longer flagged as outstanding elsewhere (Dashboard,
    // Staff page) — it doesn't mean the item can never physically come
    // back. If it does turn up, it must still be processable as a normal
    // return, so this page deliberately ignores waived quantity and bases
    // returnable purely on what hasn't actually been returned yet.
    const openLines: OpenLine[] = []
    outTxnsSnap.forEach(doc => {
      const txn = doc.data()
      const lines = linesByTxn[doc.id] || []

      lines.forEach((l: any, idx: number) => {
        const issued = l.quantity || 0
        const alreadyReturned = returnedByTxn[doc.id]?.[l.product_id] ?? 0
        const returnable = issued - alreadyReturned
        if (returnable <= 0) return

        openLines.push({
          txn_id: doc.id,
          txn_ref: txn.reference_no ?? '',
          linked_request_id: (txn.linked_request_id as string | null) ?? null,
          linked_request_ref: (txn.linked_request_ref as string | null) ?? null,
          txn_date: txn.created_at ?? '',
          line_id: `${doc.id}_${idx}`,
          product_id: l.product_id,
          product_name: l.product_name ?? 'Unknown',
          barcode: '', // not strictly needed for UI here
          issued_qty: issued,
          already_returned: alreadyReturned,
          returnable,
          returning: 0,
          expected_date: txn.lend_to ?? null,
        })
      })
    })

    setLines(openLines)
    setStep('items')
    setLoading(false)
  }

  // Fetched once per dialog-open, not per keystroke — previously this
  // re-queried Firestore with `limit(20)` on every character typed, so a
  // staff member outside the first 20 active staff (alphabetically) could
  // never be found by typing their name. Now the full active roster is
  // fetched once and every keystroke just filters that in-memory list, so
  // no one can be searched into invisibility as the roster grows.
  const [staffAll, setStaffAll] = useState<StaffMember[]>([])

  async function loadAllStaff() {
    setStaffLoading(true)
    const snap = await getDocs(query(collection(db, 'staff'), where('is_active', '==', true), orderBy('full_name')))
    const data = snap.docs.map(d => ({ id: d.id, ...d.data() })) as unknown as StaffMember[]
    setStaffAll(data)
    setStaffList(data)
    setStaffLoading(false)
  }

  function filterStaffList(qStr: string) {
    if (!qStr) { setStaffList(staffAll); return }
    const s = qStr.toLowerCase()
    setStaffList(staffAll.filter(st =>
      (st.full_name && st.full_name.toLowerCase().includes(s)) ||
      (st.email && st.email.toLowerCase().includes(s))
    ))
  }

  function openStaffSearch() {
    setStaffSearch('')
    loadAllStaff()
    setShowStaffSearch(true)
  }

  function updateReturning(lineId: string, val: number) {
    setLines(prev => prev.map(l => l.line_id === lineId ? { ...l, returning: Math.max(0, Math.min(val, l.returnable)) } : l))
  }

  async function handleConfirm() {
    const toReturn = lines.filter(l => l.returning > 0)
    if (toReturn.length === 0) return
    setLoading(true); setError('')

    // Group by originating transaction
    const byTxn = toReturn.reduce<Record<string, OpenLine[]>>((acc, l) => {
      ;(acc[l.txn_id] = acc[l.txn_id] ?? []).push(l); return acc
    }, {})

    const refs: string[] = []
    try {
      for (const [txnId, items] of Object.entries(byTxn)) {
        const ref = genRef()

        // Transaction header + one transaction_lines doc per line item —
        // see stock-out/page.tsx for why this replaced the old embedded array.
        const txnPayload = {
          transaction_type: 'RETURN',
          reference_no: ref,
          staff_id: staff!.id,
          staff_name: staff!.full_name,
          // Who performed this movement. staff_id/staff_name is the
          // borrower; this is the operator, and on a Stock In it is the
          // only person involved at all.
          user_id: user?.uid ?? null,
          operator_name: profile?.full_name ?? user?.email ?? null,
          linked_txn_id: txnId,
          // Inherited from the Stock Out being returned against, so a
          // return row reaches its loan request directly instead of
          // requiring a second hop through the originating transaction.
          linked_request_id: items[0]?.linked_request_id ?? null,
          linked_request_ref: items[0]?.linked_request_ref ?? null,
          manual_override: manualOverride,
          notes: `Return of ${items.map(i => i.product_name).join(', ')}`,
          created_at: new Date().toISOString()
        }
        const txnRef = await addDoc(collection(db, 'transactions'), txnPayload)
        logAudit({
          userId: user?.uid, userName: profile?.full_name ?? user?.email,
          action: 'create', entityType: 'transaction', entityId: txnRef.id,
          before: null,
          // Product lines are frozen into the audit entry, not just counted.
          // They live in transaction_lines, which the audit log has to join
          // to at display time - and a CSV export can't join. Without this a
          // stock movement exports as "3 lines - 7 units" with no products,
          // making any product-level audit question unanswerable. Frozen
          // rather than joined so the entry also stays true to the names and
          // quantities as they were at the time.
          after: {
            ...txnPayload,
            line_count: items.length,
            total_qty: items.reduce((s, i) => s + i.returning, 0),
            lines: items.map((i) => ({
              product_id: i.product_id,
              product_name: i.product_name,
              quantity: i.returning,
            })),
          },
        })

        for (const item of items) {
          await addDoc(collection(db, 'transaction_lines'), {
            transaction_id: txnRef.id,
            product_id: item.product_id,
            quantity: item.returning,
            unit_cost: 0,
            product_name: item.product_name,
            created_at: new Date().toISOString()
          })
        }

        refs.push(ref)
      }

      // Update stock quantities — fetch each product doc directly by ID
      // rather than scanning the whole products collection per item.
      for (const item of toReturn) {
        const pRef = doc(db, 'products', item.product_id)
        const pSnap = await getDoc(pRef)
        if (pSnap.exists()) {
          await updateDoc(pRef, {
            quantity_on_hand: (pSnap.data().quantity_on_hand || 0) + item.returning,
            updated_at: new Date().toISOString()
          })
        }
      }

      setReferences(refs)
      setStep('done')
    } catch (err: any) {
      setError('Failed: ' + err.message)
    }
    setLoading(false)
  }

  function reset() { setStep('staff'); setStaff(null); setLines([]); setError(''); setUidInput(''); setManualOverride(false) }

  const toReturn = lines.filter(l => l.returning > 0)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-6 space-y-1">
        <h1 className="text-3xl font-extrabold tracking-tight text-[#22162B]">Returns</h1>
        <p className="text-sm text-[#5B4F67]">Process equipment returns from NWU staff</p>
      </div>

      {error && (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Step: Staff */}
      {step === 'staff' && (
        <Card className="max-w-[700px] rounded-xl border border-[#E2D8E9] bg-white shadow-sm ring-0">
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><CreditCard className="size-4" /> Identify Staff Member</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="mb-4 text-sm text-muted-foreground">Tap the staff member&apos;s NWU card on the reader.</p>
            <div className="mb-4 flex gap-2">
              <Input className="bg-muted" placeholder="Card UID"
                value={uidInput} onChange={e => setUidInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && uidInput && lookupUID(uidInput)} />
              <Button disabled={!uidInput || loading} onClick={() => lookupUID(uidInput)}>
                {loading ? '…' : 'Lookup'}
              </Button>
            </div>
            <div className="border-t pt-4">
              <p className="mb-2 text-sm text-muted-foreground">Card not available?</p>
              <Button variant="ghost" onClick={openStaffSearch}>
                <Users className="size-3.5" /> Select staff manually
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Step: Items */}
      {step === 'items' && staff && (
        <div className="flex min-h-0 flex-1 flex-col gap-4">
          <Card className="rounded-xl border border-[#E2D8E9] bg-white shadow-sm ring-0">
            <CardContent className="flex items-center gap-4">
              <div className="flex size-10 items-center justify-center rounded-full bg-accent">
                <RotateCcw className="size-5 text-accent-foreground" />
              </div>
              <div>
                <div className="font-semibold">{staff.full_name}</div>
                <div className="text-xs text-muted-foreground">{staff.department ?? 'No department'}</div>
              </div>
              {manualOverride && <Badge className="ml-auto bg-amber-100 text-amber-800">Manual</Badge>}
            </CardContent>
          </Card>

          <Card className="flex min-h-0 flex-1 flex-col rounded-xl border border-[#E2D8E9] bg-white py-0 shadow-sm ring-0">
            <CardHeader className="flex-row items-center justify-between border-b pt-4">
              <CardTitle>Items Currently Issued</CardTitle>
              <span className="text-sm text-muted-foreground">Set quantity to return (0 = keep)</span>
            </CardHeader>
            <div className="min-h-0 flex-1 overflow-y-auto overflow-x-auto">
              {lines.length === 0 ? (
                <div className="p-8 text-center text-sm text-muted-foreground">
                  No outstanding items found for this staff member.
                </div>
              ) : (
                <Table>
                  <TableHeader className="sticky top-0 z-10 bg-[#F0EBF5]">
                    <TableRow className="border-b border-[#E0D5E7] hover:bg-[#F0EBF5]">
                      <TableHead className="text-base font-bold text-[#2D203A]">Product</TableHead>
                      <TableHead className="text-base font-bold text-[#2D203A]">Ref</TableHead>
                      <TableHead className="text-base font-bold text-[#2D203A]">Issued</TableHead>
                      <TableHead className="text-base font-bold text-[#2D203A]">Returnable</TableHead>
                      <TableHead className="text-base font-bold text-[#2D203A]">Expected</TableHead>
                      <TableHead className="text-base font-bold text-[#2D203A]">Status</TableHead>
                      <TableHead className="text-base font-bold text-[#2D203A]">Returning</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {lines.map(l => {
                      const status = lineStatus(l)
                      return (
                        <TableRow key={l.line_id}>
                          <TableCell className="max-w-xs whitespace-normal">
                            <div className="break-words font-medium">{l.product_name}</div>
                          </TableCell>
                          <TableCell className="max-w-xs font-mono text-xs whitespace-normal break-all text-muted-foreground">{l.txn_ref}</TableCell>
                          <TableCell className="text-muted-foreground">{l.issued_qty}</TableCell>
                          <TableCell className="font-semibold">{l.returnable}</TableCell>
                          <TableCell className="text-muted-foreground">{formatDateOnly(l.expected_date)}</TableCell>
                          <TableCell>
                            {status && <Badge className={status.className}>{sentenceCase(status.label)}</Badge>}
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-1.5">
                              <Button variant="ghost" size="icon-sm" onClick={() => updateReturning(l.line_id, l.returning - 1)}>−</Button>
                              <span className={`min-w-6 text-center font-bold ${l.returning > 0 ? 'text-primary' : 'text-muted-foreground'}`}>{l.returning}</span>
                              <Button variant="ghost" size="icon-sm" onClick={() => updateReturning(l.line_id, l.returning + 1)}>+</Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              )}
            </div>
            {toReturn.length > 0 && (
              <div className="flex items-center justify-between border-t p-4">
                <span className="text-sm text-muted-foreground">
                  {toReturn.reduce((s, l) => s + l.returning, 0)} units · {toReturn.length} product{toReturn.length !== 1 ? 's' : ''}
                </span>
                <Button disabled={loading} onClick={handleConfirm}>
                  {loading ? 'Processing…' : 'Confirm Return'}
                </Button>
              </div>
            )}
          </Card>
        </div>
      )}

      {/* Done */}
      {step === 'done' && (
        <Card className="max-w-[700px] rounded-xl border border-[#E2D8E9] bg-white shadow-sm ring-0">
          <CardContent className="py-10 text-center">
            <CheckCircle className="mx-auto mb-4 size-12 text-emerald-500" />
            <h2 className="mb-2 text-xl font-bold">Return Processed Successfully</h2>
            <div className="mb-6 font-mono text-sm text-muted-foreground">
              {references.map(r => <div key={r}>Reference: <strong className="text-foreground">{r}</strong></div>)}
            </div>
            <Button onClick={reset}>New Return</Button>
          </CardContent>
        </Card>
      )}

      {/* Manual staff search modal */}
      <Dialog open={showStaffSearch} onOpenChange={setShowStaffSearch}>
        <DialogContent className="flex max-h-[80vh] flex-col sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Users className="size-4" /> Select Staff Member</DialogTitle>
          </DialogHeader>
          <div className="relative">
            <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input className="pl-8" placeholder="Search name, email…"
              value={staffSearch} autoFocus
              onChange={e => { setStaffSearch(e.target.value); filterStaffList(e.target.value) }} />
          </div>
          <div className="-mx-6 flex-1 overflow-y-auto border-t">
            {staffLoading && <div className="p-6 text-center text-sm text-muted-foreground">Loading…</div>}
            {!staffLoading && staffList.length === 0 && <div className="p-6 text-center text-sm text-muted-foreground">No staff found</div>}
            {staffList.map(s => (
              <button key={s.id} onClick={() => { setShowStaffSearch(false); loadOpenItems(s, true) }}
                className="block w-full border-b px-6 py-3 text-left hover:bg-muted">
                <div className="font-medium text-foreground break-words">
                  {s.full_name}
                  {s.email && <span className="font-normal text-muted-foreground break-all"> - {s.email}</span>}
                </div>
                <div className="text-xs break-words text-muted-foreground">{s.department ?? 'No department'}</div>
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

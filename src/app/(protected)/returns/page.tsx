'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import { genRef, formatDateOnly, todayDateStr } from '@/lib/utils'
import { CreditCard, CheckCircle, Users, Search, RotateCcw } from 'lucide-react'
import { db } from '@/lib/firebase/config'
import { collection, query, where, getDocs, addDoc, updateDoc, doc, getDoc, orderBy, limit } from 'firebase/firestore'
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
  if (l.already_returned > 0) return { label: 'Partial', className: 'bg-amber-100 text-amber-800' }
  if (!l.expected_date) return null
  const today = todayDateStr()
  if (today > l.expected_date) return { label: 'Overdue', className: 'bg-red-100 text-red-800' }
  if (today === l.expected_date) return { label: 'Due Today', className: 'bg-amber-100 text-amber-800' }
  return { label: 'Not Due Yet', className: 'bg-emerald-100 text-emerald-800' }
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

  async function loadStaffList(qStr: string) {
    setStaffLoading(true)
    const snap = await getDocs(query(collection(db, 'staff'), where('is_active', '==', true), orderBy('full_name'), limit(20)))
    let data = snap.docs.map(d => ({ id: d.id, ...d.data() })) as unknown as StaffMember[]
    if (qStr) {
      const s = qStr.toLowerCase()
      data = data.filter(st =>
        (st.full_name && st.full_name.toLowerCase().includes(s))
      )
    }
    setStaffList(data)
    setStaffLoading(false)
  }

  function openStaffSearch() {
    setStaffSearch(''); loadStaffList(''); setShowStaffSearch(true)
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
          linked_txn_id: txnId,
          manual_override: manualOverride,
          notes: `Return of ${items.map(i => i.product_name).join(', ')}`,
          created_at: new Date().toISOString()
        }
        const txnRef = await addDoc(collection(db, 'transactions'), txnPayload)
        logAudit({
          userId: user?.uid, userName: profile?.full_name ?? user?.email,
          action: 'create', entityType: 'transaction', entityId: txnRef.id,
          before: null,
          after: { ...txnPayload, line_count: items.length, total_qty: items.reduce((s, i) => s + i.returning, 0) },
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
    <div className="max-w-[700px]">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-foreground">Returns</h1>
        <p className="mt-1 text-sm text-muted-foreground">Process equipment returns from NWU staff</p>
      </div>

      {error && (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Step: Staff */}
      {step === 'staff' && (
        <Card>
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
        <div className="flex flex-col gap-4">
          <Card>
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

          <Card className="py-0">
            <CardHeader className="flex-row items-center justify-between border-b pt-4">
              <CardTitle>Items Currently Issued</CardTitle>
              <span className="text-sm text-muted-foreground">Set quantity to return (0 = keep)</span>
            </CardHeader>
            <div className="overflow-x-auto">
              {lines.length === 0 ? (
                <div className="p-8 text-center text-sm text-muted-foreground">
                  No outstanding items found for this staff member.
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Product</TableHead>
                      <TableHead>Ref</TableHead>
                      <TableHead>Issued</TableHead>
                      <TableHead>Returnable</TableHead>
                      <TableHead>Expected</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Returning</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {lines.map(l => {
                      const status = lineStatus(l)
                      return (
                        <TableRow key={l.line_id}>
                          <TableCell>
                            <div className="font-medium">{l.product_name}</div>
                          </TableCell>
                          <TableCell className="font-mono text-xs text-muted-foreground">{l.txn_ref}</TableCell>
                          <TableCell className="text-muted-foreground">{l.issued_qty}</TableCell>
                          <TableCell className="font-semibold">{l.returnable}</TableCell>
                          <TableCell className="text-muted-foreground">{formatDateOnly(l.expected_date)}</TableCell>
                          <TableCell>
                            {status && <Badge className={status.className}>{status.label}</Badge>}
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
        <Card>
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
            <Input className="pl-8" placeholder="Search name, department…"
              value={staffSearch} autoFocus
              onChange={e => { setStaffSearch(e.target.value); loadStaffList(e.target.value) }} />
          </div>
          <div className="-mx-6 flex-1 overflow-y-auto border-t">
            {staffLoading && <div className="p-6 text-center text-sm text-muted-foreground">Loading…</div>}
            {!staffLoading && staffList.length === 0 && <div className="p-6 text-center text-sm text-muted-foreground">No staff found</div>}
            {staffList.map(s => (
              <button key={s.id} onClick={() => { setShowStaffSearch(false); loadOpenItems(s, true) }}
                className="block w-full border-b px-6 py-3 text-left hover:bg-muted">
                <div className="font-medium text-foreground">{s.full_name}</div>
                <div className="text-xs text-muted-foreground">{s.department ?? 'No department'}</div>
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

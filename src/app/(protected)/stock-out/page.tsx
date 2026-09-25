'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import { genRef, cn, todayDateStr, formatDateOnly, formatLendWindow } from '@/lib/utils'
import { CreditCard, Barcode, CheckCircle, X, Plus, Minus, Users, Search, Info } from 'lucide-react'
import { db } from '@/lib/firebase/config'
import { collection, query, where, getDocs, getDoc, addDoc, updateDoc, doc, orderBy } from 'firebase/firestore'
import { logAudit } from '@/lib/firebase/audit'
import { findProductByBarcode } from '@/lib/firebase/products'
import { getReservationHolders, reservationStatusLabel, resolutionInstruction, requestAuditSnapshot, OPEN_ENDED_TO, type ReservationHolder } from '@/lib/firebase/loanRequests'
import { useAuth } from '@/context/AuthContext'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { ClipboardList } from 'lucide-react'
import type { StaffMember, Product, CartItem, LoanRequest, LoanRequestLine } from '@/types/database'

// A cart line sourced from an accepted loan request carries the id of the
// request it fulfils, so handleConfirm knows which request(s) to mark
// fulfilled. Walk-in barcode-scanned lines have no sourceRequestId.
type StockOutCartItem = CartItem & { sourceRequestId?: string }

// Falls back to the pre-multi-barcode singular `barcode` field for products
// that haven't been edited since (see productBarcodes() in products/page.tsx
// for the same logic — kept local here to avoid a cross-page import).
function primaryBarcode(p: { barcodes?: string[]; barcode?: string }): string {
  return p.barcodes?.[0] ?? p.barcode ?? '—'
}

type Step = 'staff' | 'items' | 'confirm' | 'done'

const STEPS: Step[] = ['staff', 'items', 'confirm']
const STEP_LABELS = ['Identify Staff', 'Scan Items', 'Confirm']

export default function StockOutPage() {
  const { user, profile } = useAuth()
  const [step, setStep] = useState<Step>('staff')
  const [staff, setStaff] = useState<StaffMember | null>(null)
  const [manualOverride, setManualOverride] = useState(false)
  const [cart, setCart] = useState<StockOutCartItem[]>([])
  const [barcodeInput, setBarcodeInput] = useState('')
  const [uidInput, setUidInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [reference, setReference] = useState('')
  const [lendFrom, setLendFrom] = useState(todayDateStr())
  const [lendTo, setLendTo] = useState('')

  // Accepted, not-yet-fulfilled loan requests for the identified staff
  // member (§7 of LENDING_PORTAL_SPEC.md) — selectable above the barcode
  // input in step 2. Single-select: Transaction.linked_request_id is a
  // single id, so one active request per confirm, walk-ins layered on top.
  const [pendingPickups, setPendingPickups] = useState<LoanRequest[]>([])
  const [activeRequest, setActiveRequest] = useState<LoanRequest | null>(null)
  // Hard blocks (2026-09-20 request, widened 2026-09-20 follow-up): a
  // walk-in issue that would eat into another staff member's ACTIVE
  // reservation — pending, countered, or accepted — for the same
  // product/date window. Originally only accepted (already-approved)
  // pickups blocked and pending/countered were just an advisory warning,
  // but that let a walk-in silently strip a pending request's stock with
  // no way to recover it later. Now all three block identically, disabling
  // the Confirm button entirely rather than just flagging the issue.
  const [blockingConflicts, setBlockingConflicts] = useState<{ product: string; holders: ReservationHolder[] }[]>([])
  // FYI only, never blocks — other staff with an active reservation
  // (of any status) overlapping this window for a product in the current
  // cart, surfaced even when there's enough stock for everyone, so Selouna
  // isn't caught by surprise later.
  const [incomingPickups, setIncomingPickups] = useState<{ product: string; holders: ReservationHolder[] }[]>([])

  // Manual staff selection state
  const [showStaffSearch, setShowStaffSearch] = useState(false)
  const [staffList, setStaffList] = useState<StaffMember[]>([])
  const [staffSearch, setStaffSearch] = useState('')
  const [staffLoading, setStaffLoading] = useState(false)

  const barcodeRef = useRef<HTMLInputElement>(null)

  // HID keyboard-wedge detection
  const hidBuf = useRef({ buf: '', t: 0 })
  const handleHID = useCallback((raw: string) => {
    if (step === 'staff') lookupUID(raw)
    else if (step === 'items') lookupBarcode(raw)
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

  // Walk-in conflict check (decision #8 in LENDING_PORTAL_SPEC.md §1,
  // widened 2026-09-20) — checked at step 3 rather than in lookupBarcode,
  // since real lend dates don't exist for a walk-in until here. A walk-in
  // that would eat into another staff member's active reservation of any
  // status (pending/countered/accepted) hard-blocks Confirm; one that
  // doesn't cause a shortfall just gets a non-blocking FYI so Selouna isn't
  // caught by surprise later.
  useEffect(() => {
    if (step !== 'confirm') {
      setBlockingConflicts([]); setIncomingPickups([])
      return
    }
    let cancelled = false
    async function checkConflicts() {
      const blocking: { product: string; holders: ReservationHolder[] }[] = []
      const fyi: { product: string; holders: ReservationHolder[] }[] = []
      for (const item of cart) {
        if (item.sourceRequestId) continue
        // An open-ended loan (no Lend To) has no upper bound, so it
        // overlaps every future reservation — check it against an effective
        // infinity rather than skipping the check entirely, which would let
        // an indefinite issue silently strip a reserved unit.
        const effectiveTo = lendTo || OPEN_ENDED_TO
        const holders = await getReservationHolders(item.product.id.toString(), lendFrom, effectiveTo)
        // Only someone else's active reservation is grounds to block — a
        // staff member never blocks against their own request (that's what
        // "Select from Accepted Loan Requests" above is for).
        const otherHolders = holders.filter((h) => h.staffId !== staff?.id.toString())
        const otherReserved = otherHolders.reduce((sum, h) => sum + h.quantity, 0)
        if (otherReserved + item.quantity > item.product.quantity_on_hand) {
          blocking.push({ product: item.product.name, holders: otherHolders })
        } else if (otherHolders.length > 0) {
          // Plenty of stock for everyone — not a conflict — but still worth
          // naming who else has a stake in this product during the window.
          fyi.push({ product: item.product.name, holders: otherHolders })
        }
      }
      if (!cancelled) { setBlockingConflicts(blocking); setIncomingPickups(fyi) }
    }
    checkConflicts()
    return () => { cancelled = true }
  }, [step, cart, lendFrom, lendTo, staff])

  async function lookupUID(uid: string) {
    setError(''); setLoading(true)
    const snap = await getDocs(query(collection(db, 'staff'), where('card_uid', '==', uid), where('is_active', '==', true)))
    if (snap.empty) { setError('Card not registered. Use "Select manually" to find this staff member.'); setLoading(false); return }
    const data = { id: snap.docs[0].id, ...snap.docs[0].data() } as unknown as StaffMember
    setStaff(data)
    setManualOverride(false)
    await loadPendingPickups(data)
    setStep('items')
    setLoading(false)
  }

  // Broad read + client-side filter, same convention as the rest of this
  // app's Firestore usage (see loanRequests.ts's getReservedQuantity).
  async function loadPendingPickups(s: StaffMember) {
    const snap = await getDocs(query(collection(db, 'loan_requests'), where('staff_id', '==', s.id.toString())))
    const requests = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }) as LoanRequest)
      .filter((r) => r.status === 'accepted' && r.fulfilled_txn_id === null)
    setPendingPickups(requests)
  }

  // Selecting a request populates the cart from its lines using
  // offered_quantity — what Selouna actually approved, never
  // requested_quantity. Walk-in barcode scans can still be layered on top
  // (they simply have no sourceRequestId) — only the request-sourced lines
  // drive the fulfillment write in handleConfirm.
  async function selectRequest(r: LoanRequest) {
    setError(''); setLoading(true)
    const linesSnap = await getDocs(query(collection(db, 'loan_request_lines'), where('request_id', '==', r.id)))
    const lines = linesSnap.docs.map((d) => d.data() as LoanRequestLine).filter((l) => l.offered_quantity > 0)

    const missing: string[] = []
    const items: StockOutCartItem[] = []
    for (const line of lines) {
      const productSnap = await getDoc(doc(db, 'products', line.product_id))
      if (!productSnap.exists()) { missing.push(line.product_name); continue }
      const product = { id: productSnap.id, ...productSnap.data() } as unknown as Product
      items.push({ product, quantity: Math.min(line.offered_quantity, product.quantity_on_hand), sourceRequestId: r.id })
    }
    if (missing.length > 0) setError(`Some items on this request no longer exist: ${missing.join(', ')}.`)

    setActiveRequest(r)
    setCart(items)
    setLendFrom(r.from_date)
    setLendTo(r.to_date ?? '')
    setLoading(false)
  }

  function deselectRequest() {
    setActiveRequest(null)
    setCart((prev) => prev.filter((i) => !i.sourceRequestId))
    setLendFrom(todayDateStr())
    setLendTo('')
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

  async function selectStaffManually(s: StaffMember) {
    setStaff(s)
    setManualOverride(true)
    setShowStaffSearch(false)
    await loadPendingPickups(s)
    setStep('items')
  }

  async function lookupBarcode(barcode: string) {
    setError(''); setLoading(true)
    const product = await findProductByBarcode(barcode) as unknown as Product | null
    if (!product) { setError(`Barcode "${barcode}" not found.`); setLoading(false); return }
    if (product.quantity_on_hand <= 0) {
      setError(`${product.name} is out of stock.`)
      setBarcodeInput('')
      setLoading(false)
      return
    }
    let capped = false
    setCart(prev => {
      const existing = prev.find(i => i.product.id === product.id)
      if (existing) {
        if (existing.quantity >= product.quantity_on_hand) { capped = true; return prev }
        return prev.map(i => i.product.id === product.id ? { ...i, quantity: i.quantity + 1 } : i)
      }
      return [...prev, { product, quantity: 1 }]
    })
    if (capped) setError(`Only ${product.quantity_on_hand} of "${product.name}" in stock — already at the max in the cart.`)
    setBarcodeInput('')
    setLoading(false)
  }

  async function handleConfirm() {
    if (!staff || cart.length === 0) return
    // Lend To is optional — blank means "no return date agreed", which is a
    // deliberate choice Selouna makes, not a missing field. Every date
    // comparison below has to be guarded, because '' sorts BEFORE any real
    // YYYY-MM-DD string: an unguarded `lendTo < lendFrom` reads an empty
    // value as "before the from date" and blocks the issue.
    if (lendTo && lendTo < lendFrom) { setError("Return (To) date can't be before the From date."); return }
    setLoading(true); setError('')
    const ref = genRef()
    try {
      // Create the transaction header first, then one transaction_lines
      // document per line item (mirrors the original relational schema —
      // a real flat, joinable table rather than an embedded array, which
      // is what external BI tools like Looker Studio need).
      const txnPayload = {
        transaction_type: 'OUT',
        reference_no: ref,
        staff_id: staff.id,
        staff_name: staff.full_name,
        // Who performed this movement. staff_id/staff_name is the
        // borrower; this is the operator, and on a Stock In it is the
        // only person involved at all.
        user_id: user?.uid ?? null,
        operator_name: profile?.full_name ?? user?.email ?? null,
        manual_override: manualOverride,
        notes: manualOverride ? 'Staff selected manually (no card scan)' : '',
        lend_from: lendFrom,
        lend_to: lendTo || null,
        linked_request_id: activeRequest?.id ?? null,
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
          line_count: cart.length,
          total_qty: cart.reduce((s, i) => s + i.quantity, 0),
          lines: cart.map((i) => ({
            product_id: i.product.id,
            product_name: i.product.name,
            quantity: i.quantity,
          })),
          // The other half of the fulfilment join, in a form a person can
          // read. txnPayload already carries linked_request_id, but that's
          // a Firestore id; this is the LR-... someone can actually search
          // for. Audit payload only — the transactions collection keeps
          // the id, as it always has.
          linked_request_ref: activeRequest?.reference_no ?? null,
        },
      })

      for (const item of cart) {
        await addDoc(collection(db, 'transaction_lines'), {
          transaction_id: txnRef.id,
          product_id: item.product.id,
          quantity: item.quantity,
          unit_cost: 0,
          product_name: item.product.name,
          created_at: new Date().toISOString()
        })
        await updateDoc(doc(db, 'products', item.product.id.toString()), {
          quantity_on_hand: item.product.quantity_on_hand - item.quantity,
          updated_at: new Date().toISOString()
        })
      }

      if (activeRequest) {
        const now = new Date().toISOString()
        await updateDoc(doc(db, 'loan_requests', activeRequest.id), {
          status: 'fulfilled', fulfilled_txn_id: txnRef.id, updated_at: now,
        })
        logAudit({
          userId: user?.uid, userName: profile?.full_name ?? user?.email,
          action: 'update', entityType: 'loan_request', entityId: activeRequest.id,
          // Same full snapshot every other loan_request transition writes,
          // so the fulfilled row lines up with the rest in the CSV export.
          before: await requestAuditSnapshot(activeRequest),
          after: await requestAuditSnapshot(activeRequest, {
            status: 'fulfilled',
            fulfilled_txn_id: txnRef.id,
            // The transaction's own reference too: fulfilled_txn_id is a
            // Firestore id, which is not something anyone can look up by
            // eye. This is the half of the join a person can actually use.
            fulfilled_txn_ref: ref,
          }),
        })
      }

      setReference(ref)
      setStep('done')
    } catch (err: any) {
      setError('Failed to create transaction. ' + err.message)
    }
    setLoading(false)
  }

  function reset() {
    setStep('staff'); setStaff(null); setCart([]); setError(''); setReference(''); setManualOverride(false)
    setLendFrom(todayDateStr()); setLendTo('')
    setPendingPickups([]); setActiveRequest(null)
  }

  const stepIndex = STEPS.indexOf(step) === -1 ? 3 : STEPS.indexOf(step)

  return (
    <div className="max-w-[700px]">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-foreground">Stock Out</h1>
        <p className="mt-1 text-sm text-muted-foreground">Issue equipment to NWU staff</p>
      </div>

      {/* Step indicator */}
      <div className="mb-6 flex gap-2">
        {STEPS.map((s, i) => {
          const done = stepIndex > i
          const active = step === s
          return (
            <div key={s} className="flex items-center gap-2">
              <div className={cn(
                'flex size-7 items-center justify-center rounded-full text-xs font-bold',
                active ? 'bg-primary text-white' : done ? 'bg-emerald-500 text-white' : 'bg-muted text-muted-foreground'
              )}>
                {i + 1}
              </div>
              <span className={cn('text-sm', active ? 'font-semibold text-primary' : 'text-muted-foreground')}>
                {STEP_LABELS[i]}
              </span>
              {i < 2 && <div className="h-px w-8 bg-border" />}
            </div>
          )
        })}
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
            <CardTitle className="flex items-center gap-2"><CreditCard className="size-4" /> Step 1 — Identify Staff Member</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="mb-4 text-sm text-muted-foreground">
              Tap the staff member&apos;s NWU card on the ZKTeco CR20M reader, or enter the card UID manually below.
            </p>
            <div className="mb-4 flex gap-2">
              <Input className="bg-muted" placeholder="Card UID (e.g. A1B2C3D4E5)"
                value={uidInput} onChange={e => setUidInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && uidInput && lookupUID(uidInput)} />
              <Button disabled={!uidInput || loading} onClick={() => lookupUID(uidInput)}>
                {loading ? '…' : 'Lookup'}
              </Button>
            </div>
            <div className="border-t pt-4">
              <p className="mb-2 text-sm text-muted-foreground">
                Card not available or not registered?
              </p>
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
              <div className="flex size-10 items-center justify-center rounded-full bg-emerald-100">
                <CheckCircle className="size-5 text-emerald-800" />
              </div>
              <div>
                <div className="font-semibold">{staff.full_name}</div>
                <div className="text-xs text-muted-foreground">{staff.department ?? 'No department'}</div>
              </div>
              {manualOverride && (
                <Badge className="ml-auto bg-amber-100 text-amber-800">Manual selection</Badge>
              )}
            </CardContent>
          </Card>

          {pendingPickups.length > 0 && (
            <Card className="py-0">
              <CardHeader className="border-b pt-4">
                <CardTitle className="flex items-center gap-2"><ClipboardList className="size-4" /> Accepted Loan Requests</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-2 py-4">
                {pendingPickups.map((r) => (
                  <button key={r.id} onClick={() => (activeRequest?.id === r.id ? deselectRequest() : selectRequest(r))}
                    className={cn(
                      'flex items-center justify-between rounded-lg border p-3 text-left transition-colors',
                      activeRequest?.id === r.id ? 'border-primary bg-accent' : 'hover:bg-muted',
                    )}>
                    <div>
                      <div className="flex flex-wrap items-baseline gap-2 text-sm font-medium">
                        Pickup {formatLendWindow(r.from_date, r.to_date)}
                        {/* The reference Selouna will see again on the
                            resulting transaction's audit entry. */}
                        {r.reference_no && (
                          <span className="font-mono text-xs font-normal text-muted-foreground">
                            {r.reference_no}
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground">Requested via lending portal</div>
                    </div>
                    {activeRequest?.id === r.id && <Badge className="bg-primary text-primary-foreground">Selected</Badge>}
                  </button>
                ))}
              </CardContent>
            </Card>
          )}

          <Card className="py-0">
            <CardHeader className="border-b pt-4">
              <CardTitle className="flex items-center gap-2"><Barcode className="size-4" /> Step 2 — Scan Items</CardTitle>
            </CardHeader>
            <CardContent className="py-4">
              <div className="mb-4">
                <Input ref={barcodeRef} placeholder="Scan or type barcode, then press Enter…"
                  value={barcodeInput} onChange={e => setBarcodeInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); barcodeInput && !loading && lookupBarcode(barcodeInput) } }}
                  autoFocus />
              </div>
              {cart.length > 0 && (
                <div className="max-h-96 overflow-y-auto">
                <Table>
                  <TableHeader className="sticky top-0 z-10 bg-card">
                    <TableRow>
                      <TableHead>Product</TableHead>
                      <TableHead>Barcode</TableHead>
                      <TableHead>Qty</TableHead>
                      <TableHead></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {cart.map(item => (
                      <TableRow key={item.product.id}>
                        <TableCell className="font-medium">{item.product.name}</TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">{primaryBarcode(item.product)}</TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1.5">
                            <Button variant="ghost" size="icon-sm"
                              onClick={() => setCart(c => c.map(i => i.product.id === item.product.id ? { ...i, quantity: Math.max(1, i.quantity - 1) } : i))}>
                              <Minus className="size-3" />
                            </Button>
                            <span className="min-w-6 text-center font-semibold">{item.quantity}</span>
                            <Button variant="ghost" size="icon-sm"
                              disabled={item.quantity >= item.product.quantity_on_hand}
                              title={item.quantity >= item.product.quantity_on_hand ? `Only ${item.product.quantity_on_hand} in stock` : undefined}
                              onClick={() => setCart(c => c.map(i => i.product.id === item.product.id ? { ...i, quantity: Math.min(i.product.quantity_on_hand, i.quantity + 1) } : i))}>
                              <Plus className="size-3" />
                            </Button>
                          </div>
                          {item.quantity >= item.product.quantity_on_hand && (
                            <p className="mt-0.5 text-[0.7rem] text-muted-foreground">Max in stock</p>
                          )}
                        </TableCell>
                        <TableCell>
                          <Button variant="ghost" size="icon-sm" className="text-red-600 hover:text-red-700"
                            onClick={() => setCart(c => c.filter(i => i.product.id !== item.product.id))}>
                            <X className="size-3.5" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                </div>
              )}
              {cart.length > 0 && (
                <div className="mt-4 flex justify-end">
                  <Button onClick={() => setStep('confirm')}>Review &amp; Confirm →</Button>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* Step: Confirm */}
      {step === 'confirm' && staff && (
        <Card>
          <CardHeader>
            <CardTitle>Step 3 — Confirm Issue</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="mb-4 rounded-lg bg-muted p-3">
              <div className="text-xs text-muted-foreground">
                Issuing to {manualOverride && <span className="text-amber-600">(manual selection — will be flagged)</span>}
              </div>
              <div className="font-semibold">{staff.full_name} <span className="font-normal text-muted-foreground">({staff.department})</span></div>
            </div>
            <div className="mb-4 max-h-96 overflow-y-auto">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-card">
                <TableRow>
                  <TableHead>Product</TableHead>
                  <TableHead>Qty</TableHead>
                  <TableHead>Available</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {cart.map(item => {
                  const insufficient = item.product.quantity_on_hand < item.quantity
                  return (
                    <TableRow key={item.product.id} className={insufficient ? 'text-red-600' : ''}>
                      <TableCell>{item.product.name}</TableCell>
                      <TableCell className="font-semibold">{item.quantity}</TableCell>
                      <TableCell className={cn('font-semibold', insufficient ? 'text-red-600' : 'text-emerald-600')}>
                        {item.product.quantity_on_hand}
                        {insufficient && ' ⚠ insufficient'}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
            </div>
            {blockingConflicts.length > 0 && (
              <div className="mb-4 flex flex-col gap-2">
                {blockingConflicts.map((b) => (
                  <Alert key={b.product} variant="destructive">
                    <X className="size-4" />
                    <AlertDescription>
                      <strong>{b.product}</strong> can&apos;t be issued — it&apos;s fully reserved by{' '}
                      {b.holders.map((h, i) => (
                        <span key={h.requestId}>
                          {i > 0 && ', '}
                          {h.staffName}&apos;s {reservationStatusLabel(h.status)} ({formatDateOnly(h.fromDate)}–{formatDateOnly(h.toDate)}, {h.quantity} unit(s))
                        </span>
                      ))}
                      . Resolve {b.holders.length > 1 ? 'these' : 'this'} first — {resolutionInstruction(b.holders)} — before this issue can go ahead.
                    </AlertDescription>
                  </Alert>
                ))}
              </div>
            )}
            {incomingPickups.length > 0 && (
              <div className="mb-4 flex flex-col gap-2">
                {incomingPickups.map((f) => (
                  <Alert key={f.product} className="border-sky-200 bg-sky-50 text-sky-900">
                    <Info className="size-4" />
                    <AlertDescription className="text-sky-900/90">
                      Heads up — <strong>{f.product}</strong> also has {f.holders.length > 1 ? 'other active loan requests' : 'an active loan request'} during this window for{' '}
                      {f.holders.map((h, i) => (
                        <span key={h.requestId}>
                          {i > 0 && ', '}
                          {h.staffName} ({reservationStatusLabel(h.status)}, {formatDateOnly(h.fromDate)}–{formatDateOnly(h.toDate)}, {h.quantity} unit(s))
                        </span>
                      ))}
                      . There&apos;s enough stock for everyone right now.
                    </AlertDescription>
                  </Alert>
                ))}
              </div>
            )}
            {activeRequest && !lendTo && (
              <Alert className="mb-4">
                <AlertDescription>
                  This issue fulfils {activeRequest.staff_name}&apos;s accepted request, which agreed a
                  return by {formatDateOnly(activeRequest.to_date)}. Leaving Lend To blank overrides
                  that — the item won&apos;t appear in Outstanding Returns.
                </AlertDescription>
              </Alert>
            )}
            <div className="mb-4 grid grid-cols-2 items-start gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="lend-from">Lend From</Label>
                <Input id="lend-from" type="date" value={lendFrom} min={todayDateStr()}
                  onChange={e => setLendFrom(e.target.value)} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="lend-to">Lend To</Label>
                <Input id="lend-to" type="date" value={lendTo} min={lendFrom || todayDateStr()}
                  onChange={e => setLendTo(e.target.value)} />
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs text-muted-foreground">
                    {lendTo
                      ? 'Clear this if the item does not need to come back.'
                      : 'No return date — this item will not be chased on the Dashboard.'}
                  </p>
                  {lendTo && (
                    <button type="button" onClick={() => setLendTo('')}
                      className="shrink-0 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground">
                      Clear
                    </button>
                  )}
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setStep('items')}>← Back</Button>
              <Button
                disabled={loading || blockingConflicts.length > 0 || (!!lendTo && lendTo < lendFrom) || cart.some(i => i.product.quantity_on_hand < i.quantity)}
                onClick={handleConfirm}
              >
                {loading ? 'Processing…' : 'Confirm Issue'}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Done */}
      {step === 'done' && (
        <Card>
          <CardContent className="py-10 text-center">
            <CheckCircle className="mx-auto mb-4 size-12 text-emerald-500" />
            <h2 className="mb-2 text-xl font-bold">Stock Issued Successfully</h2>
            <div className="mb-6 font-mono text-sm text-muted-foreground">
              Reference: <strong className="text-foreground">{reference}</strong>
            </div>
            <Button onClick={reset}>New Transaction</Button>
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
            {!staffLoading && staffList.length === 0 && <div className="p-6 text-center text-sm text-muted-foreground">No active staff found</div>}
            {staffList.map(s => (
              <button key={s.id} onClick={() => selectStaffManually(s)}
                className="block w-full border-b px-6 py-3 text-left hover:bg-muted">
                <div className="font-medium text-foreground">
                  {s.full_name}
                  {s.email && <span className="font-normal text-muted-foreground"> - {s.email}</span>}
                </div>
                <div className="text-xs text-muted-foreground">{s.department ?? 'No department'}</div>
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

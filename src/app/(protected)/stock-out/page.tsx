'use client'

import { Fragment, useEffect, useState, useRef, useCallback } from 'react'
import { cn, todayDateStr, formatDateOnly, formatLendWindow } from '@/lib/utils'
import { CreditCard, Barcode, CheckCircle, X, Plus, Minus, Users, Search, Info } from 'lucide-react'
import { notifyAlertsChanged } from '@/lib/alertsBus'
import { findProductByBarcode, getProduct } from '@/lib/api/catalog'
import { listStaff } from '@/lib/api/staff'
import { recordStockOut } from '@/lib/api/stock'
import { postStaffAdmin } from '@/lib/firebase/staff'
import { toast } from 'sonner'
import { getReservationHolders, getAcceptedPickups, getRequestLines } from '@/lib/api/loanRequests'
import { reservationStatusLabel, resolutionInstruction, OPEN_ENDED_TO, type ReservationHolder } from '@/lib/loanRequestRules'
import { useAuth } from '@/context/AuthContext'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { AvailabilityDatePicker } from '@/components/portal/AvailabilityDatePicker'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { ClipboardList } from 'lucide-react'
import type { StaffMember, Product, CartItem, LoanRequest } from '@/types/database'
import { totalForProduct, groupRowsByProduct } from '@/lib/scanCart'

// One row per (product, barcode) -- scanning a product via two different
// barcodes gives two rows, each with its own quantity, and each becomes one
// transaction_lines row. A row sourced from an accepted loan request
// carries the id of the request it fulfils, so handleConfirm knows which
// request to mark fulfilled. Those rows start with barcode null ("awaiting
// scan") holding the offered quantity: every unit still has to be scanned, and
// each scan moves one unit from that placeholder onto a real (product,
// barcode) row that inherits the sourceRequestId. Confirm stays blocked until
// no placeholder is left, so every persisted line carries the exact barcode
// that Returns will later have to match.
type StockOutCartItem = CartItem & { sourceRequestId?: string; barcode: string | null }

function rowKey(i: StockOutCartItem): string {
  return `${i.product.id}|${i.barcode ?? ''}|${i.sourceRequestId ?? ''}`
}

type Step = 'staff' | 'items' | 'confirm' | 'done'

const STEPS: Step[] = ['staff', 'items', 'confirm']
const STEP_LABELS = ['Identify Staff', 'Scan Items', 'Confirm']

export default function StockOutPage() {
  const { user } = useAuth()
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
      // Walk-in units only, summed per product: a product scanned via two
      // barcodes is two cart rows but one reservation question.
      const walkIn = groupRowsByProduct(cart.filter((i) => !i.sourceRequestId))
      for (const item of walkIn) {
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
    // The admin's own borrower record is included: she can be picked here.
    const data = (await listStaff({ includeAdminAccount: true })).find(s => s.card_uid === uid && s.is_active)
    if (!data) { setError('Card not registered. Use "Select manually" to find this staff member.'); setLoading(false); return }
    setStaff(data)
    setManualOverride(false)
    await loadPendingPickups(data)
    setStep('items')
    setLoading(false)
  }

  async function loadPendingPickups(s: StaffMember) {
    setPendingPickups(await getAcceptedPickups(s.id.toString()))
  }

  // Selecting a request populates the cart from its lines using
  // offered_quantity — what Selouna actually approved, never
  // requested_quantity. Walk-in barcode scans can still be layered on top
  // (they simply have no sourceRequestId) — only the request-sourced lines
  // drive the fulfillment write in handleConfirm.
  async function selectRequest(r: LoanRequest) {
    setError(''); setLoading(true)
    const lines = (await getRequestLines(r.id)).filter((l) => l.offered_quantity > 0)

    const missing: string[] = []
    const items: StockOutCartItem[] = []
    for (const line of lines) {
      const product = await getProduct(line.product_id)
      if (!product) { missing.push(line.product_name); continue }
      items.push({ product, quantity: Math.min(line.offered_quantity, product.quantity_on_hand), sourceRequestId: r.id, barcode: null })
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
  // re-queried the database with `limit(20)` on every character typed, so a
  // staff member outside the first 20 active staff (alphabetically) could
  // never be found by typing their name. Now the full active roster is
  // fetched once and every keystroke just filters that in-memory list, so
  // no one can be searched into invisibility as the roster grows.
  const [staffAll, setStaffAll] = useState<StaffMember[]>([])

  async function loadAllStaff() {
    setStaffLoading(true)
    const data = (await listStaff({ includeAdminAccount: true })).filter(st => st.is_active)
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
    const trimmedBarcode = barcode.trim()
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
      // A loan-request row still awaiting scan for this product takes the
      // scan first: one unit moves from the placeholder onto a real
      // (product, barcode) row that keeps the request link.
      const placeholder = prev.find(i => i.product.id === product.id && i.barcode === null && i.sourceRequestId)
      if (placeholder) {
        const sourceRequestId = placeholder.sourceRequestId
        const next = prev
          .map(i => i === placeholder ? { ...i, quantity: i.quantity - 1 } : i)
          .filter(i => i.quantity > 0)
        const existing = next.find(i => i.product.id === product.id && i.barcode === trimmedBarcode && i.sourceRequestId === sourceRequestId)
        if (existing) return next.map(i => i === existing ? { ...i, quantity: i.quantity + 1 } : i)
        return [...next, { product, quantity: 1, barcode: trimmedBarcode, sourceRequestId }]
      }
      // Walk-in scan: capped by stock across every row for the product.
      if (totalForProduct(prev, product.id) >= product.quantity_on_hand) { capped = true; return prev }
      const existing = prev.find(i => i.product.id === product.id && i.barcode === trimmedBarcode && !i.sourceRequestId)
      if (existing) return prev.map(i => i === existing ? { ...i, quantity: i.quantity + 1 } : i)
      return [...prev, { product, quantity: 1, barcode: trimmedBarcode }]
    })
    if (capped) setError(`Only ${product.quantity_on_hand} of "${product.name}" in stock — already at the max in the cart.`)
    setBarcodeInput('')
    setLoading(false)
  }

  async function handleConfirm() {
    if (!staff || cart.length === 0) return
    if (cart.some(i => i.barcode === null)) { setError('Scan every item on the request before confirming.'); return }
    // Lend To is optional — blank means "no return date agreed", which is a
    // deliberate choice Selouna makes, not a missing field. Every date
    // comparison below has to be guarded, because '' sorts BEFORE any real
    // YYYY-MM-DD string: an unguarded `lendTo < lendFrom` reads an empty
    // value as "before the from date" and blocks the issue.
    if (lendTo && lendTo < lendFrom) { setError("Return (To) date can't be before the From date."); return }
    setLoading(true); setError('')
    try {
      // The server writes the transaction header, one transaction_lines row
      // per (product, barcode) row, the stock decrements, the audit entry
      // and, when this Stock Out fulfils a loan request, marks that request
      // fulfilled with its own audit entry, all in one database transaction
      // (see src/server/data/stock.ts). Nothing is saved if any step fails,
      // e.g. "Not enough stock for X." if the stock was taken meanwhile.
      const result = await recordStockOut({
        staffId: staff.id.toString(),
        // Every row has been scanned (checked above), so barcode is set.
        items: cart.map(item => ({ productId: String(item.product.id), quantity: item.quantity, barcodes: [item.barcode as string] })),
        lendFrom,
        lendTo: lendTo || null,
        manualOverride,
        notes: manualOverride ? 'Staff selected manually (no card scan)' : '',
        linkedRequestId: activeRequest?.id ?? null,
      })

      // Notification emails: a confirmation to the staff member and, when a product
      // dropped to or below its reorder threshold, a low-stock alert to the admin
      // inbox. Background and best-effort: it never blocks or fails the Stock Out,
      // which is already saved above.
      if (user) {
        postStaffAdmin('/api/notifications/stock-out', user, { transactionId: result.id })
          .catch(() => toast.error("Stock Out saved, but the notification emails couldn't be sent."))
      }

      setReference(result.reference_no)
      notifyAlertsChanged()
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

  // Lets the step bubbles above jump back to an already-visited step — only
  // backward (i < stepIndex): stepping ahead would land on a screen with
  // nothing filled in yet, and once the transaction is 'done' there's
  // nothing left to revise. Jumping all the way back to Identify Staff
  // clears everything gathered since (cart, the loan request it was tied
  // to, the lend dates) — a different person might be picked, so none of
  // that can be assumed to still apply. Jumping back to Scan Items from
  // Confirm keeps the cart as-is, same as the existing "← Back" button on
  // that screen (below), which this now shares its behaviour with.
  function goToStep(i: number) {
    if (step === 'done' || i >= stepIndex) return
    if (i === 0) {
      setStaff(null); setManualOverride(false); setPendingPickups([])
      setActiveRequest(null); setCart([])
      setLendFrom(todayDateStr()); setLendTo('')
    }
    setError('')
    setStep(STEPS[i])
  }

  return (
    <div className="max-w-[700px]">
      <div className="mb-6 space-y-1">
        <h1 className="text-3xl font-extrabold tracking-tight text-[#22162B]">Stock Out</h1>
        <p className="text-sm text-[#5B4F67]">Issue equipment to NWU staff</p>
      </div>

      {/* Step indicator — spread across the full card width, each bubble
          clickable to jump back to a step already visited (see goToStep). */}
      <div className="mb-6 flex w-full items-center">
        {STEPS.map((s, i) => {
          const done = stepIndex > i
          const active = step === s
          const clickable = i < stepIndex && step !== 'done'
          return (
            <Fragment key={s}>
              <button
                type="button"
                disabled={!clickable}
                onClick={() => goToStep(i)}
                aria-current={active ? 'step' : undefined}
                className={cn(
                  // Every step keeps the same padding + (transparent) border so
                  // nothing shifts when a step becomes clickable; a clickable
                  // one gets a visible rectangular outline so it reads as a button.
                  'flex shrink-0 items-center gap-2 rounded-lg border-2 px-3 py-1.5 transition-colors',
                  clickable
                    ? 'cursor-pointer border-primary/50 bg-white/60 hover:border-primary hover:bg-primary/10'
                    : 'cursor-default border-transparent',
                )}
              >
                <span className={cn(
                  'flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-bold transition-transform',
                  active ? 'bg-primary text-white' : done ? 'bg-emerald-500 text-white' : 'bg-muted text-muted-foreground',
                  clickable && 'hover:scale-110 hover:ring-2 hover:ring-primary/40',
                )}>
                  {i + 1}
                </span>
                <span className={cn('text-sm whitespace-nowrap', active ? 'font-semibold text-primary' : 'text-muted-foreground')}>
                  {STEP_LABELS[i]}
                </span>
              </button>
              {i < STEPS.length - 1 && <div className="mx-3 h-px flex-1 bg-border" />}
            </Fragment>
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
        <Card className="rounded-xl border border-[#E2D8E9] bg-white shadow-sm ring-0">
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
          <Card className="rounded-xl border border-[#E2D8E9] bg-white shadow-sm ring-0">
            <CardContent className="flex items-center gap-4">
              <div className="flex size-10 items-center justify-center rounded-full bg-emerald-100">
                <CheckCircle className="size-5 text-emerald-800" />
              </div>
              <div className="min-w-0">
                <div className="break-words font-semibold">{staff.full_name}</div>
                <div className="text-xs break-words text-muted-foreground">{staff.department ?? 'No department'}</div>
              </div>
              {manualOverride && (
                <Badge className="ml-auto bg-amber-100 text-amber-800">Manual selection</Badge>
              )}
            </CardContent>
          </Card>

          {pendingPickups.length > 0 && (
            <Card className="rounded-xl border border-[#E2D8E9] bg-white py-0 shadow-sm ring-0">
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

          <Card className="rounded-xl border border-[#E2D8E9] bg-white py-0 shadow-sm ring-0">
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
                  <TableHeader className="sticky top-0 z-10 bg-[#F0EBF5]">
                    <TableRow className="border-b border-[#E0D5E7] hover:bg-[#F0EBF5]">
                      <TableHead className="text-base font-bold text-[#2D203A]">Product</TableHead>
                      <TableHead className="text-base font-bold text-[#2D203A]">Barcode</TableHead>
                      <TableHead className="text-base font-bold text-[#2D203A]">Qty</TableHead>
                      <TableHead></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {cart.map(item => {
                      const key = rowKey(item)
                      const atMax = totalForProduct(cart, item.product.id) >= item.product.quantity_on_hand
                      // Loan-request rows are fixed to what was offered and
                      // moved along by scanning, so only walk-in rows get +/-.
                      const adjustable = !item.sourceRequestId
                      return (
                      <TableRow key={key}>
                        <TableCell className="max-w-xs font-medium whitespace-normal break-words">{item.product.name}</TableCell>
                        <TableCell className="max-w-xs font-mono text-xs whitespace-normal break-all text-muted-foreground">
                          {item.barcode ?? <span className="font-sans italic text-amber-700">Awaiting scan</span>}
                        </TableCell>
                        <TableCell>
                          {adjustable ? (
                            <>
                              <div className="flex items-center gap-1.5">
                                <Button variant="ghost" size="icon-sm"
                                  onClick={() => setCart(c => c.map(i => rowKey(i) === key ? { ...i, quantity: Math.max(1, i.quantity - 1) } : i))}>
                                  <Minus className="size-3" />
                                </Button>
                                <span className="min-w-6 text-center font-semibold">{item.quantity}</span>
                                <Button variant="ghost" size="icon-sm"
                                  disabled={atMax}
                                  title={atMax ? `Only ${item.product.quantity_on_hand} in stock` : undefined}
                                  onClick={() => setCart(c => totalForProduct(c, item.product.id) >= item.product.quantity_on_hand ? c : c.map(i => rowKey(i) === key ? { ...i, quantity: i.quantity + 1 } : i))}>
                                  <Plus className="size-3" />
                                </Button>
                              </div>
                              {atMax && (
                                <p className="mt-0.5 text-[0.7rem] text-muted-foreground">Max in stock</p>
                              )}
                            </>
                          ) : (
                            <span className="font-semibold">{item.quantity}</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <Button variant="outline" size="icon-sm" className="border-[#D5C6E0] bg-[#F0EBF5] text-red-600 hover:bg-[#E4D9EE] hover:text-red-700"
                            onClick={() => setCart(c => {
                              const rest = c.filter(i => rowKey(i) !== key)
                              // Removing a scanned loan-request row puts its
                              // units back on the request's awaiting-scan row.
                              if (!item.sourceRequestId || item.barcode === null) return rest
                              const back = rest.find(i => i.product.id === item.product.id && i.barcode === null && i.sourceRequestId === item.sourceRequestId)
                              if (back) return rest.map(i => i === back ? { ...i, quantity: i.quantity + item.quantity } : i)
                              return [...rest, { product: item.product, quantity: item.quantity, barcode: null, sourceRequestId: item.sourceRequestId }]
                            })}>
                            <X className="size-3.5" />
                          </Button>
                        </TableCell>
                      </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
                </div>
              )}
              {cart.length > 0 && (
                <div className="mt-4 flex items-center justify-end gap-3">
                  {cart.some(i => i.barcode === null) && (
                    <p className="text-xs text-amber-700">
                      Scan the {cart.filter(i => i.barcode === null).reduce((s, i) => s + i.quantity, 0)} remaining item(s) on the request to continue.
                    </p>
                  )}
                  <Button disabled={cart.some(i => i.barcode === null)} onClick={() => setStep('confirm')}>Review &amp; Confirm →</Button>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* Step: Confirm */}
      {step === 'confirm' && staff && (
        <Card className="rounded-xl border border-[#E2D8E9] bg-white shadow-sm ring-0">
          <CardHeader>
            <CardTitle>Step 3 — Confirm Issue</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="mb-4 rounded-lg bg-muted p-3">
              <div className="text-xs text-muted-foreground">
                Issuing to {manualOverride && <span className="text-amber-600">(manual selection — will be flagged)</span>}
              </div>
              <div className="break-words font-semibold">{staff.full_name} <span className="font-normal text-muted-foreground">({staff.department})</span></div>
            </div>
            <div className="mb-4 max-h-96 overflow-y-auto">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-[#F0EBF5]">
                <TableRow className="border-b border-[#E0D5E7] hover:bg-[#F0EBF5]">
                  <TableHead className="text-base font-bold text-[#2D203A]">Product</TableHead>
                  <TableHead className="text-base font-bold text-[#2D203A]">Barcode</TableHead>
                  <TableHead className="text-base font-bold text-[#2D203A]">Qty</TableHead>
                  <TableHead className="text-base font-bold text-[#2D203A]">Available</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {cart.map(item => {
                  const insufficient = item.product.quantity_on_hand < totalForProduct(cart, item.product.id)
                  return (
                    <TableRow key={rowKey(item)} className={insufficient ? 'text-red-600' : ''}>
                      <TableCell className="max-w-xs whitespace-normal break-words">{item.product.name}</TableCell>
                      <TableCell className="max-w-xs font-mono text-xs whitespace-normal break-all text-muted-foreground">{item.barcode}</TableCell>
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
                <AvailabilityDatePicker id="lend-from" className="w-full" value={lendFrom} min={todayDateStr()}
                  onChange={setLendFrom} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="lend-to">Lend To</Label>
                <AvailabilityDatePicker id="lend-to" className="w-full" value={lendTo} min={lendFrom || todayDateStr()}
                  onChange={setLendTo} />
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
              <Button variant="outline" onClick={() => goToStep(1)}>← Back</Button>
              <Button
                disabled={loading || blockingConflicts.length > 0 || (!!lendTo && lendTo < lendFrom) || cart.some(i => i.product.quantity_on_hand < totalForProduct(cart, i.product.id))}
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
        <Card className="rounded-xl border border-[#E2D8E9] bg-white shadow-sm ring-0">
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

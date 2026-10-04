'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import { formatDateOnly, sentenceCase, todayDateStr } from '@/lib/utils'
import { CreditCard, CheckCircle, Users, Search, RotateCcw, Barcode, Minus, Plus, AlertTriangle } from 'lucide-react'
import { notifyAlertsChanged } from '@/lib/alertsBus'
import { findProductByBarcode } from '@/lib/api/catalog'
import { listStaff } from '@/lib/api/staff'
import { listOutstandingForStaff, recordReturn } from '@/lib/api/stock'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import type { StaffMember } from '@/types/database'

// One row per (Stock Out transaction, product, barcode) -- the same product
// issued under two different barcodes is two rows. A return must be scanned
// with exactly the barcode the item left with, so this is the unit the scanner
// matches against. `returning` is how many units of THIS barcode have been
// scanned back so far in this session.
interface OpenLine {
  txn_id: string
  txn_ref: string
  txn_date: string
  line_id: string // `${txn_id}|${product_id}|${barcode}`
  product_id: string
  product_name: string
  barcode: string
  issued_qty: number
  already_returned: number
  returnable: number
  returning: number
  // One entry per returning unit whose barcode was lost: the registered
  // barcode now on it instead (the same code may repeat -- barcodes identify
  // the product, not the unit). Each must already be registered to this
  // product (added under Products → Edit beforehand); Returns never creates
  // barcodes. Every entry counts toward `returning`.
  relabels: string[]
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

// Units issued with no recorded barcode (legacy Stock Outs). Nothing to match
// a scan against, so they can't be returned through this screen.
interface UnscannableLine {
  txn_ref: string
  product_name: string
  quantity: number
}

type Step = 'staff' | 'items' | 'done'

// What actually gets written: one entry per (product, barcode) that comes back.
// A unit with a replacement barcode is its own entry (barcode = the new one,
// issued_barcode = the one it left with); the rest of the row keeps the
// issued barcode.
interface ReturnEntry {
  product_id: string
  product_name: string
  barcode: string
  issued_barcode: string | null
  quantity: number
}

function entriesOf(rows: OpenLine[]): ReturnEntry[] {
  const out: ReturnEntry[] = []
  for (const r of rows) {
    const normal = r.returning - r.relabels.length
    if (normal > 0) out.push({ product_id: r.product_id, product_name: r.product_name, barcode: r.barcode, issued_barcode: null, quantity: normal })
    // One entry per distinct replacement barcode, with how many units carry it.
    const counts = new Map<string, number>()
    r.relabels.forEach(code => counts.set(code, (counts.get(code) ?? 0) + 1))
    counts.forEach((qty, code) => out.push({ product_id: r.product_id, product_name: r.product_name, barcode: code, issued_barcode: r.barcode, quantity: qty }))
  }
  return out
}

// Collapses entries to one per product: total units plus every distinct
// barcode in first-seen order, and any barcode replacements.
function groupByProduct(entries: ReturnEntry[]): { product_id: string; product_name: string; quantity: number; barcodes: string[]; barcodeQuantities: { barcode: string; quantity: number }[]; relabelled: { from: string; to: string; quantity: number }[] }[] {
  const m = new Map<string, { product_id: string; product_name: string; quantity: number; barcodes: string[]; barcodeQuantities: { barcode: string; quantity: number }[]; relabelled: { from: string; to: string; quantity: number }[] }>()
  for (const e of entries) {
    const g = m.get(e.product_id) ?? { product_id: e.product_id, product_name: e.product_name, quantity: 0, barcodes: [], barcodeQuantities: [], relabelled: [] }
    g.quantity += e.quantity
    if (e.barcode && !g.barcodes.includes(e.barcode)) g.barcodes.push(e.barcode)
    const bq = g.barcodeQuantities.find(b => b.barcode === e.barcode)
    if (bq) bq.quantity += e.quantity
    else g.barcodeQuantities.push({ barcode: e.barcode, quantity: e.quantity })
    if (e.issued_barcode) g.relabelled.push({ from: e.issued_barcode, to: e.barcode, quantity: e.quantity })
    m.set(e.product_id, g)
  }
  return [...m.values()]
}

export default function ReturnsPage() {
  const [step, setStep] = useState<Step>('staff')
  const [staff, setStaff] = useState<StaffMember | null>(null)
  const [manualOverride, setManualOverride] = useState(false)
  const [uidInput, setUidInput] = useState('')
  const [lines, setLines] = useState<OpenLine[]>([])
  const [unscannable, setUnscannable] = useState<UnscannableLine[]>([])
  const [barcodeInput, setBarcodeInput] = useState('')
  // Mirrors `lines` so scans that arrive from the HID handler (a stale
  // closure) or in rapid succession always see the latest rows.
  const linesRef = useRef<OpenLine[]>([])
  const barcodeRef = useRef<HTMLInputElement>(null)

  // "Lost barcode" flow: the + on a row that has nothing scanned yet.
  const [relabelTarget, setRelabelTarget] = useState<OpenLine | null>(null)
  const [relabelInput, setRelabelInput] = useState('')
  const [relabelError, setRelabelError] = useState('')
  const [relabelChecking, setRelabelChecking] = useState(false)
  const [confirmRestart, setConfirmRestart] = useState(false)
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
    else if (step === 'items') lookupBarcode(raw)
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    // The admin's own borrower record is included: she can be picked here.
    const data = (await listStaff({ includeAdminAccount: true })).find(s => s.card_uid === uid && s.is_active)
    if (!data) { setError('Card not registered. Use "Select manually".'); setLoading(false); return }
    await loadOpenItems(data, false)
    setLoading(false)
  }

  async function loadOpenItems(s: StaffMember, manual: boolean) {
    setStaff(s)
    setManualOverride(manual)
    setLoading(true)
    setError('')

    // What this staff member still has out, per Stock Out, product and barcode,
    // oldest Stock Out first (so a scan of a barcode held on two transactions
    // settles the oldest one first). The server replays the ledger: issued on
    // an OUT line minus returned against that same OUT, per barcode, with
    // barcode-less (legacy) units reported separately as `unscannable`.
    // Written-off (waived) quantity is deliberately NOT excluded: a write-off
    // (Dashboard -> Resolve) only means Selouna has stopped chasing the item;
    // if it does turn up it must still be processable as a normal return.
    const { lines: outstanding, unscannable: noBarcode } = await listOutstandingForStaff(s.id.toString())
    const openLines: OpenLine[] = outstanding.map(l => ({ ...l, returning: 0, relabels: [] }))
    setLines(openLines); linesRef.current = openLines
    setUnscannable(noBarcode)
    setBarcodeInput('')
    setStep('items')
    setLoading(false)
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

  // A scan returns ONE unit and must match, exactly, a barcode that was
  // scanned when this staff member's items were issued. Nothing else is
  // accepted: no quantity typing, no "close enough" product match.
  async function lookupBarcode(raw: string) {
    const code = raw.trim()
    if (!code) return
    setError('')
    const current = linesRef.current
    const target = current.find(l => l.barcode === code && l.returning < l.returnable)
    if (target) {
      const next = current.map(l => l.line_id === target.line_id ? { ...l, returning: l.returning + 1 } : l)
      linesRef.current = next
      setLines(next)
      setBarcodeInput('')
      return
    }
    setBarcodeInput('')
    if (current.some(l => l.barcode === code)) {
      setError(`Every unit issued under barcode "${code}" has already been scanned for return.`)
      return
    }
    // Not an exact match: say why, so the operator can tell a wrong item from
    // a right item carrying a different barcode than the one used at Stock Out.
    const product = await findProductByBarcode(code) as unknown as { id: string; name: string } | null
    if (!product) { setError(`Barcode "${code}" is not a known product barcode.`); return }
    const issuedCodes = [...new Set(current.filter(l => l.product_id === product.id).map(l => l.barcode))]
    if (issuedCodes.length > 0) {
      setError(`"${code}" is a barcode for ${product.name}, but it was issued under ${issuedCodes.map(b => `"${b}"`).join(', ')}. Scan the exact barcode that was scanned at Stock Out.`)
    } else {
      setError(`${product.name} (barcode "${code}") is not currently issued to this staff member.`)
    }
  }

  // Scanned units come off first; a replacement-barcode unit is the last to go
  // (most recently added first).
  function decrementScanned(lineId: string) {
    const next = linesRef.current.map(l => {
      if (l.line_id !== lineId || l.returning === 0) return l
      const normal = l.returning - l.relabels.length
      if (normal > 0) return { ...l, returning: l.returning - 1 }
      return { ...l, returning: l.returning - 1, relabels: l.relabels.slice(0, -1) }
    })
    linesRef.current = next
    setLines(next)
  }

  function openRelabel(line: OpenLine) {
    setRelabelTarget(line)
    setRelabelInput('')
    setRelabelError('')
  }

  // The replacement barcode must already be one of THIS product's registered
  // barcodes. Returns never registers barcodes: a brand-new one has to be added
  // under Products → Edit first, so the product catalogue stays the only place
  // barcodes are created.
  async function submitRelabel() {
    const code = relabelInput.trim()
    if (!relabelTarget || !code) return
    setRelabelError(''); setRelabelChecking(true)
    try {
      if (code === relabelTarget.barcode) {
        setRelabelError(`"${code}" is the barcode this item was issued under. If it is readable, scan it with the scanner instead.`)
        return
      }
      const found = await findProductByBarcode(code) as unknown as { id: string; name: string } | null
      if (!found) {
        setRelabelError(`"${code}" is not registered to any product. Add it to ${relabelTarget.product_name} under Products → Edit first, then scan or enter it here again.`)
        return
      }
      if (String(found.id) !== String(relabelTarget.product_id)) {
        setRelabelError(`"${code}" belongs to ${found.name}, not ${relabelTarget.product_name}. Use a barcode registered to ${relabelTarget.product_name}.`)
        return
      }
      const next = linesRef.current.map(l =>
        l.line_id === relabelTarget.line_id && l.returning < l.returnable ? { ...l, returning: l.returning + 1, relabels: [...l.relabels, code] } : l)
      linesRef.current = next
      setLines(next)
      setRelabelTarget(null)
    } finally {
      setRelabelChecking(false)
    }
  }

  async function handleConfirm() {
    const toReturn = lines.filter(l => l.returning > 0)
    if (toReturn.length === 0) return
    setLoading(true); setError('')

    // Group by originating transaction
    // Re-check each replacement barcode is still registered to its product
    // (it could have been edited off since it was entered).
    try {
      for (const l of toReturn) {
        for (const code of new Set(l.relabels)) {
          const still = await findProductByBarcode(code) as unknown as { id: string } | null
          if (!still || String(still.id) !== String(l.product_id)) {
            setError(`Barcode "${code}" is no longer registered to ${l.product_name}. Remove that unit and enter a registered barcode.`)
            setLoading(false)
            return
          }
        }
      }
    } catch (err: any) {
      setError('Failed: ' + err.message); setLoading(false); return
    }

    const byTxn = toReturn.reduce<Record<string, OpenLine[]>>((acc, l) => {
      ;(acc[l.txn_id] = acc[l.txn_id] ?? []).push(l); return acc
    }, {})

    const refs: string[] = []
    try {
      // One RETURN per originating Stock Out, saved one after the other. The
      // server writes each one's transaction, lines, stock increments and
      // audit entry in one database transaction, so every RETURN is saved whole
      // or not at all; if a later one fails, the earlier ones stay saved and
      // the error is shown (see src/server/data/stock.ts).
      for (const [txnId, items] of Object.entries(byTxn)) {
        const result = await recordReturn({
          staffId: staff!.id.toString(),
          linkedTxnId: txnId,
          // One item per (product, barcode) that comes back. A unit with a
          // replacement barcode is its own item (barcodes = the replacement,
          // issuedBarcode = the one it left with).
          items: entriesOf(items).map(e => ({
            productId: e.product_id,
            quantity: e.quantity,
            barcodes: [e.barcode],
            ...(e.issued_barcode ? { issuedBarcode: e.issued_barcode } : {}),
          })),
          manualOverride,
          notes: `Return of ${[...new Set(items.map(i => i.product_name))].join(', ')}` +
            (() => {
              const swaps = entriesOf(items).filter(e => e.issued_barcode).map(e => `${e.issued_barcode} → ${e.barcode} ×${e.quantity}`)
              return swaps.length > 0 ? `. Barcode lost, returned as: ${swaps.join(', ')}` : ''
            })(),
        })
        refs.push(result.reference_no)
      }

      setReferences(refs)
      notifyAlertsChanged()
      setStep('done')
    } catch (err: any) {
      setError('Failed: ' + err.message)
    }
    setLoading(false)
  }

  function reset() { setRelabelTarget(null); setStep('staff'); setStaff(null); setLines([]); linesRef.current = []; setUnscannable([]); setBarcodeInput(''); setError(''); setUidInput(''); setManualOverride(false) }

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
              {/* Back to "Identify Staff Member" to pick someone else. Anything
                  already scanned is thrown away, so ask first if there is any. */}
              <Button type="button" variant="outline" size="sm" className={manualOverride ? '' : 'ml-auto'} disabled={loading}
                onClick={() => lines.some(l => l.returning > 0) ? setConfirmRestart(true) : reset()}>
                <RotateCcw className="size-3.5" /> Restart
              </Button>
            </CardContent>
          </Card>

          <Card className="rounded-xl border border-[#E2D8E9] bg-white py-0 shadow-sm ring-0">
            <CardHeader className="border-b pt-4">
              <CardTitle className="flex items-center gap-2"><Barcode className="size-4" /> Scan Items to Return</CardTitle>
            </CardHeader>
            <CardContent className="py-4">
              <Input ref={barcodeRef} placeholder="Scan or type barcode, then press Enter…"
                value={barcodeInput} onChange={e => setBarcodeInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); barcodeInput && !loading && lookupBarcode(barcodeInput) } }}
                autoFocus />
              <p className="mt-2 text-xs text-muted-foreground">
                Each scan returns one unit. The barcode must match exactly what was scanned when the item was issued.
              </p>
            </CardContent>
          </Card>

          {unscannable.length > 0 && (
            <Alert className="border-amber-200 bg-amber-50 text-amber-900">
              <AlertDescription>
                <div className="font-semibold">Issued without a recorded barcode — cannot be returned by scan</div>
                <ul className="mt-1 list-disc pl-5 text-sm">
                  {unscannable.map((u, i) => (
                    <li key={i}>{u.quantity} × {u.product_name} <span className="font-mono text-xs">({u.txn_ref})</span></li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}

          <Card className="flex min-h-0 flex-1 flex-col rounded-xl border border-[#E2D8E9] bg-white py-0 shadow-sm ring-0">
            <CardHeader className="flex-row items-center justify-between border-b pt-4">
              <CardTitle>Items Currently Issued</CardTitle>
              <span className="text-sm text-muted-foreground">One row per barcode issued</span>
            </CardHeader>
            {/* The table sits inside the card with its own padded, rounded border
                (same look as the Loan Requests expanded-row table) instead of
                running edge to edge. */}
            <div className="flex min-h-0 flex-1 flex-col p-4">
            <div className="min-h-0 overflow-auto rounded-lg border border-[#E5DBEC] bg-white shadow-xs">
              {lines.length === 0 ? (
                <div className="p-8 text-center text-sm text-muted-foreground">
                  No outstanding items found for this staff member.
                </div>
              ) : (
                <Table>
                  <TableHeader className="sticky top-0 z-10 bg-[#F6F2F9]">
                    <TableRow className="border-b border-[#E5DBEC] hover:bg-[#F6F2F9]">
                      <TableHead className="text-base font-bold text-[#2D203A]">Product</TableHead>
                      <TableHead className="text-base font-bold text-[#2D203A]">Barcode</TableHead>
                      <TableHead className="text-base font-bold text-[#2D203A]">Ref</TableHead>
                      <TableHead className="text-base font-bold text-[#2D203A]">Issued</TableHead>
                      <TableHead className="text-base font-bold text-[#2D203A]">Returnable</TableHead>
                      <TableHead className="text-base font-bold text-[#2D203A]">Expected</TableHead>
                      <TableHead className="text-base font-bold text-[#2D203A]">Status</TableHead>
                      <TableHead className="text-base font-bold text-[#2D203A]">Returns<br />Scanned</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {lines.map(l => {
                      const status = lineStatus(l)
                      return (
                        <TableRow key={l.line_id} className="border-slate-100 hover:bg-[#FDFCFE]">
                          <TableCell className="max-w-xs whitespace-normal">
                            <div className="break-words font-medium">{l.product_name}</div>
                          </TableCell>
                          <TableCell className="max-w-xs font-mono text-xs whitespace-normal break-all text-muted-foreground">
                            {l.barcode}
                            {l.relabels.length > 0 && (
                              <div className="mt-0.5 font-sans font-semibold text-amber-700">
                                Label lost, returned as:
                                {[...new Set(l.relabels)].map(code => {
                                  const n = l.relabels.filter(r => r === code).length
                                  return <div key={code} className="font-mono">{code} ×{n}</div>
                                })}
                              </div>
                            )}
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
                              {/* − only once something on this row has been scanned. */}
                              {l.returning > 0 && (
                                <Button type="button" variant="ghost" size="icon-sm" aria-label={`Reduce scanned ${l.product_name}`} onClick={() => decrementScanned(l.line_id)}>
                                  <Minus className="size-3.5" />
                                </Button>
                              )}
                              <span className={`min-w-6 text-center font-bold ${l.returning > 0 ? 'text-primary' : 'text-muted-foreground'}`}>{l.returning}</span>
                              <span className="text-xs text-muted-foreground">/ {l.returnable}</span>
                              {/* + while units on this row are still unscanned: the
                                  lost-barcode route, gated by a registered replacement barcode. */}
                              {l.returning < l.returnable && (
                                <Button type="button" variant="ghost" size="icon-sm" title="Barcode lost? Return this item under another registered barcode" aria-label={`Return ${l.product_name} under another registered barcode`} onClick={() => openRelabel(l)}>
                                  <Plus className="size-3.5" />
                                </Button>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              )}
            </div>
            </div>
            {toReturn.length > 0 && (
              <div className="flex items-center justify-between border-t p-4">
                <span className="text-sm text-muted-foreground">
                  {toReturn.reduce((s, l) => s + l.returning, 0)} units · {groupByProduct(entriesOf(toReturn)).length} product{groupByProduct(entriesOf(toReturn)).length !== 1 ? 's' : ''}
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

      <Dialog open={confirmRestart} onOpenChange={setConfirmRestart}>
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle>Restart and choose another staff member?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Items already scanned for <strong className="text-foreground">{staff?.full_name}</strong> have not been confirmed and will be discarded.
          </p>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setConfirmRestart(false)}>Keep scanning</Button>
            <Button type="button" onClick={() => { setConfirmRestart(false); reset() }}>Restart</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Lost-barcode dialog: a registered barcode is mandatory before the unit counts. */}
      <Dialog open={relabelTarget !== null} onOpenChange={open => { if (!open) setRelabelTarget(null) }}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><AlertTriangle className="size-4 text-amber-600" /> Barcode lost</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This indicates that <strong className="text-foreground">{relabelTarget?.product_name}</strong> being returned has lost its barcode.
            Please apply one of this product&apos;s registered barcodes to it, then provide that barcode below by scanning or entering its value manually.
          </p>
          <div className="grid gap-1.5">
            <Label htmlFor="relabel-barcode">Barcode now on the product</Label>
            <Input id="relabel-barcode" autoFocus placeholder="Scan or type the barcode now on the product, then press Enter…"
              value={relabelInput} onChange={e => { setRelabelInput(e.target.value); setRelabelError('') }}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); submitRelabel() } }} />
            {relabelError && <p className="text-sm text-red-600">{relabelError}</p>}
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setRelabelTarget(null)}>Cancel</Button>
            <Button type="button" disabled={!relabelInput.trim() || relabelChecking} onClick={submitRelabel}>
              {relabelChecking ? 'Checking…' : 'Use this barcode'}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">Only barcodes already registered to this product are accepted. To use a brand-new barcode, add it under Products → Edit first.</p>
        </DialogContent>
      </Dialog>

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

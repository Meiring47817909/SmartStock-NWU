'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import { genRef, cn } from '@/lib/utils'
import { CreditCard, Barcode, CheckCircle, X, Plus, Minus, Users, Search } from 'lucide-react'
import { db } from '@/lib/firebase/config'
import { collection, query, where, getDocs, addDoc, updateDoc, doc, orderBy, limit } from 'firebase/firestore'
import { logAudit } from '@/lib/firebase/audit'
import { findProductByBarcode } from '@/lib/firebase/products'
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
import type { StaffMember, Product, CartItem } from '@/types/database'

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
  const [cart, setCart] = useState<CartItem[]>([])
  const [barcodeInput, setBarcodeInput] = useState('')
  const [uidInput, setUidInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [reference, setReference] = useState('')

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

  async function lookupUID(uid: string) {
    setError(''); setLoading(true)
    const snap = await getDocs(query(collection(db, 'staff'), where('card_uid', '==', uid), where('is_active', '==', true)))
    if (snap.empty) { setError('Card not registered. Use "Select manually" to find this staff member.'); setLoading(false); return }
    const data = { id: snap.docs[0].id, ...snap.docs[0].data() } as unknown as StaffMember
    setStaff(data)
    setManualOverride(false)
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
        (st.full_name && st.full_name.toLowerCase().includes(s)) ||
        (st.department && st.department.toLowerCase().includes(s))
      )
    }
    setStaffList(data)
    setStaffLoading(false)
  }

  function openStaffSearch() {
    setStaffSearch('')
    loadStaffList('')
    setShowStaffSearch(true)
  }

  function selectStaffManually(s: StaffMember) {
    setStaff(s)
    setManualOverride(true)
    setShowStaffSearch(false)
    setStep('items')
  }

  async function lookupBarcode(barcode: string) {
    setError(''); setLoading(true)
    const product = await findProductByBarcode(barcode) as unknown as Product | null
    if (!product) { setError(`Barcode "${barcode}" not found.`); setLoading(false); return }
    setCart(prev => {
      const existing = prev.find(i => i.product.id === product.id)
      if (existing) return prev.map(i => i.product.id === product.id ? { ...i, quantity: i.quantity + 1 } : i)
      return [...prev, { product, quantity: 1 }]
    })
    setBarcodeInput('')
    setLoading(false)
  }

  async function handleConfirm() {
    if (!staff || cart.length === 0) return
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
        manual_override: manualOverride,
        notes: manualOverride ? 'Staff selected manually (no card scan)' : '',
        created_at: new Date().toISOString()
      }
      const txnRef = await addDoc(collection(db, 'transactions'), txnPayload)
      logAudit({
        userId: user?.uid, userName: profile?.full_name ?? user?.email,
        action: 'create', entityType: 'transaction', entityId: txnRef.id,
        before: null,
        after: { ...txnPayload, line_count: cart.length, total_qty: cart.reduce((s, i) => s + i.quantity, 0) },
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

      setReference(ref)
      setStep('done')
    } catch (err: any) {
      setError('Failed to create transaction. ' + err.message)
    }
    setLoading(false)
  }

  function reset() { setStep('staff'); setStaff(null); setCart([]); setError(''); setReference(''); setManualOverride(false) }

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

          <Card className="py-0">
            <CardHeader className="border-b pt-4">
              <CardTitle className="flex items-center gap-2"><Barcode className="size-4" /> Step 2 — Scan Items</CardTitle>
            </CardHeader>
            <CardContent className="py-4">
              <div className="mb-4 flex gap-2">
                <Input ref={barcodeRef} placeholder="Scan or type barcode…"
                  value={barcodeInput} onChange={e => setBarcodeInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && barcodeInput && lookupBarcode(barcodeInput)} autoFocus />
                <Button disabled={!barcodeInput || loading} onClick={() => lookupBarcode(barcodeInput)}>
                  {loading ? '…' : 'Add'}
                </Button>
              </div>
              {cart.length > 0 && (
                <Table>
                  <TableHeader>
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
                              onClick={() => setCart(c => c.map(i => i.product.id === item.product.id ? { ...i, quantity: i.quantity + 1 } : i))}>
                              <Plus className="size-3" />
                            </Button>
                          </div>
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
            <Table className="mb-4">
              <TableHeader>
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
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setStep('items')}>← Back</Button>
              <Button disabled={loading || cart.some(i => i.product.quantity_on_hand < i.quantity)} onClick={handleConfirm}>
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
            <Input className="pl-8" placeholder="Search name, department…"
              value={staffSearch} autoFocus
              onChange={e => { setStaffSearch(e.target.value); loadStaffList(e.target.value) }} />
          </div>
          <div className="-mx-6 flex-1 overflow-y-auto border-t">
            {staffLoading && <div className="p-6 text-center text-sm text-muted-foreground">Loading…</div>}
            {!staffLoading && staffList.length === 0 && <div className="p-6 text-center text-sm text-muted-foreground">No active staff found</div>}
            {staffList.map(s => (
              <button key={s.id} onClick={() => selectStaffManually(s)}
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

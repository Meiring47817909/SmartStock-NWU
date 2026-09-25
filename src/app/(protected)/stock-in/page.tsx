'use client'

import { useState } from 'react'
import { genRef } from '@/lib/utils'
import { CheckCircle, X, Minus, Plus, Barcode } from 'lucide-react'
import { db } from '@/lib/firebase/config'
import { collection, addDoc, updateDoc, doc } from 'firebase/firestore'
import { logAudit } from '@/lib/firebase/audit'
import { findProductByBarcode } from '@/lib/firebase/products'
import { useAuth } from '@/context/AuthContext'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'
import type { Product, CartItem } from '@/types/database'

export default function StockInPage() {
  const { user, profile } = useAuth()
  const [cart, setCart] = useState<CartItem[]>([])
  const [barcodeInput, setBarcodeInput] = useState('')
  const [notes, setNotes] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [reference, setReference] = useState('')
  const [done, setDone] = useState(false)

  async function lookupBarcode(barcode: string) {
    setError('')
    const product = await findProductByBarcode(barcode) as unknown as Product | null
    if (!product) { setError(`Barcode "${barcode}" not found`); return }
    setCart(prev => {
      const existing = prev.find(i => i.product.id === product.id)
      if (existing) return prev.map(i => i.product.id === product.id ? { ...i, quantity: i.quantity + 1 } : i)
      return [...prev, { product, quantity: 1 }]
    })
    setBarcodeInput('')
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (cart.length === 0) return
    setLoading(true); setError('')
    const ref = genRef()
    try {
      // Transaction header + one transaction_lines doc per line item — see
      // stock-out/page.tsx for why this replaced the old embedded array.
      const txnPayload = {
        transaction_type: 'IN',
        reference_no: ref,
        // Who performed this movement. staff_id/staff_name is the
        // borrower; this is the operator, and on a Stock In it is the
        // only person involved at all.
        user_id: user?.uid ?? null,
        operator_name: profile?.full_name ?? user?.email ?? null,
        // Stock arriving on the shelf is never against a loan request.
        // Written explicitly so the field exists on every transaction and
        // an empty CSV cell means "not applicable", not "not recorded".
        linked_request_id: null,
        linked_request_ref: null,
        notes,
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
          quantity_on_hand: item.product.quantity_on_hand + item.quantity,
          updated_at: new Date().toISOString()
        })
      }
      setReference(ref)
      setDone(true)
    } catch (err: any) {
      setError('Failed to create transaction. ' + err.message)
    }
    setLoading(false)
  }

  function reset() { setCart([]); setNotes(''); setError(''); setDone(false); setReference('') }

  if (done) return (
    <div className="max-w-[500px]">
      <Card>
        <CardContent className="py-10 text-center">
          <CheckCircle className="mx-auto mb-4 size-12 text-emerald-500" />
          <h2 className="mb-2 text-xl font-bold">Stock Received Successfully</h2>
          <div className="mb-6 font-mono text-sm text-muted-foreground">
            Reference: <strong className="text-foreground">{reference}</strong>
          </div>
          <Button onClick={reset}>New Stock-In</Button>
        </CardContent>
      </Card>
    </div>
  )

  return (
    <div className="max-w-[680px]">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-foreground">Stock In</h1>
        <p className="mt-1 text-sm text-muted-foreground">Receive new stock into the store</p>
      </div>

      {error && (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <Card className="py-0">
          <CardHeader className="border-b pt-4">
            <CardTitle className="flex items-center gap-2"><Barcode className="size-4" /> Scan Items</CardTitle>
          </CardHeader>
          <CardContent className="py-4">
            <div className="mb-4">
              <Input placeholder="Scan or type barcode, then press Enter…"
                value={barcodeInput} onChange={e => setBarcodeInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); barcodeInput && lookupBarcode(barcodeInput) } }}
                autoFocus />
            </div>

            {cart.length === 0 && (
              <div className="rounded-lg border-2 border-dashed p-6 text-center text-sm text-muted-foreground">
                Scan a barcode to add items
              </div>
            )}

            {cart.length > 0 && (
              <div className="max-h-96 overflow-y-auto">
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-card">
                  <TableRow>
                    <TableHead>Product</TableHead>
                    <TableHead>Current Stock</TableHead>
                    <TableHead>Receiving</TableHead>
                    <TableHead>After</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {cart.map(item => (
                    <TableRow key={item.product.id}>
                      <TableCell>
                        <div className="font-medium">{item.product.name}</div>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{item.product.quantity_on_hand}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1.5">
                          <Button type="button" variant="ghost" size="icon-sm"
                            onClick={() => setCart(c => c.map(i => i.product.id === item.product.id ? { ...i, quantity: Math.max(1, i.quantity - 1) } : i))}>
                            <Minus className="size-3" />
                          </Button>
                          <span className="min-w-7 text-center font-bold">{item.quantity}</span>
                          <Button type="button" variant="ghost" size="icon-sm"
                            onClick={() => setCart(c => c.map(i => i.product.id === item.product.id ? { ...i, quantity: i.quantity + 1 } : i))}>
                            <Plus className="size-3" />
                          </Button>
                        </div>
                      </TableCell>
                      <TableCell className="font-semibold text-emerald-600">
                        {item.product.quantity_on_hand + item.quantity}
                      </TableCell>
                      <TableCell>
                        <Button type="button" variant="ghost" size="icon-sm" className="text-red-600 hover:text-red-700"
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
          </CardContent>
        </Card>

        {cart.length > 0 && (
          <Card>
            <CardContent>
              <div className="mb-4 grid gap-1.5">
                <Label htmlFor="si-notes">Notes (optional)</Label>
                <Input id="si-notes" placeholder="Supplier, delivery note, PO number…"
                  value={notes} onChange={e => setNotes(e.target.value)} />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">
                  {cart.reduce((s, i) => s + i.quantity, 0)} units · {cart.length} product{cart.length !== 1 ? 's' : ''}
                </span>
                <Button type="submit" disabled={loading}>
                  {loading ? 'Processing…' : 'Confirm Receipt'}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
      </form>
    </div>
  )
}

'use client'

import { useState } from 'react'
import { CheckCircle, X, Minus, Plus, Barcode } from 'lucide-react'
import { notifyAlertsChanged } from '@/lib/alertsBus'
import { findProductByBarcode } from '@/lib/api/catalog'
import { recordStockIn } from '@/lib/api/stock'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'
import type { Product } from '@/types/database'
import { groupRowsByProduct, totalForProduct, type ScanRow } from '@/lib/scanCart'

// One row per (product, barcode): the same product scanned via two different
// barcodes is two rows, each becoming its own transaction_lines row.
type StockInRow = ScanRow & { barcode: string }

function rowKey(i: StockInRow): string {
  return `${i.product.id}|${i.barcode}`
}

export default function StockInPage() {
  const [cart, setCart] = useState<StockInRow[]>([])
  const [barcodeInput, setBarcodeInput] = useState('')
  const [notes, setNotes] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [reference, setReference] = useState('')
  const [done, setDone] = useState(false)

  async function lookupBarcode(barcode: string) {
    setError('')
    const trimmedBarcode = barcode.trim()
    const product = await findProductByBarcode(barcode) as unknown as Product | null
    if (!product) { setError(`Barcode "${barcode}" not found`); return }
    setCart(prev => {
      const existing = prev.find(i => i.product.id === product.id && i.barcode === trimmedBarcode)
      if (existing) return prev.map(i => i === existing ? { ...i, quantity: i.quantity + 1 } : i)
      return [...prev, { product, quantity: 1, barcode: trimmedBarcode }]
    })
    setBarcodeInput('')
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (cart.length === 0) return
    setLoading(true); setError('')
    try {
      // The server writes the transaction, its lines, the stock increments and
      // the audit entry in one go (see src/server/data/stock.ts), and says who
      // the operator is from the signed-in admin. One item per (product,
      // barcode) row.
      const result = await recordStockIn({
        items: cart.map(item => ({ productId: String(item.product.id), quantity: item.quantity, barcodes: [item.barcode] })),
        notes,
      })
      setReference(result.reference_no)
      notifyAlertsChanged()
      setDone(true)
    } catch (err: any) {
      setError('Failed to create transaction. ' + err.message)
    }
    setLoading(false)
  }

  function reset() { setCart([]); setNotes(''); setError(''); setDone(false); setReference('') }

  if (done) return (
    <div className="max-w-[500px]">
      <Card className="rounded-xl border border-[#E2D8E9] bg-white shadow-sm ring-0">
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

  // Narrow while empty; once the first item is scanned the page uses the full
  // width/height like Returns, and the table scrolls inside the card. Removing
  // every item drops it back to the narrow layout.
  const expanded = cart.length > 0

  return (
    <div className={expanded ? 'flex h-full min-h-0 flex-col' : 'max-w-[680px]'}>
      <div className="mb-6 space-y-1">
        <h1 className="text-3xl font-extrabold tracking-tight text-[#22162B]">Stock In</h1>
        <p className="text-sm text-[#5B4F67]">Receive new stock into the store</p>
      </div>

      {error && (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <form onSubmit={handleSubmit} className={expanded ? 'flex min-h-0 flex-1 flex-col gap-4' : 'flex flex-col gap-4'}>
        <Card className={`rounded-xl border border-[#E2D8E9] bg-white py-0 shadow-sm ring-0 ${expanded ? 'flex min-h-0 flex-1 flex-col' : ''}`}>
          <CardHeader className="border-b pt-4">
            <CardTitle className="flex items-center gap-2"><Barcode className="size-4" /> Scan Items</CardTitle>
          </CardHeader>
          <CardContent className={`py-4 ${expanded ? 'flex min-h-0 flex-1 flex-col' : ''}`}>
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
              <div className="min-h-0 flex-1 overflow-y-auto overflow-x-auto">
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-[#6C3D91] [&_th]:border-b [&_th]:border-[#522E6E] [&_th]:!text-white [&_th_*]:!text-white [&_th_svg]:!text-white/75">
                  <TableRow className="border-b border-[#522E6E] hover:bg-[#6C3D91]">
                    <TableHead className="text-base font-bold text-[#2D203A]">Product</TableHead>
                    <TableHead className="text-base font-bold text-[#2D203A]">Barcode</TableHead>
                    <TableHead className="text-base font-bold text-[#2D203A]">Current Stock</TableHead>
                    <TableHead className="text-base font-bold text-[#2D203A]">Receiving</TableHead>
                    <TableHead className="text-base font-bold text-[#2D203A]">After</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {cart.map(item => (
                    <TableRow key={rowKey(item)}>
                      <TableCell className="max-w-xs whitespace-normal">
                        <div className="break-words font-medium">{item.product.name}</div>
                      </TableCell>
                      <TableCell className="max-w-xs font-mono text-xs whitespace-normal break-all text-muted-foreground">{item.barcode}</TableCell>
                      <TableCell className="text-muted-foreground">{item.product.quantity_on_hand}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1.5">
                          <Button type="button" variant="ghost" size="icon-sm"
                            onClick={() => setCart(c => c.map(i => rowKey(i) === rowKey(item) ? { ...i, quantity: Math.max(1, i.quantity - 1) } : i))}>
                            <Minus className="size-3" />
                          </Button>
                          <span className="min-w-7 text-center font-bold">{item.quantity}</span>
                          <Button type="button" variant="ghost" size="icon-sm"
                            onClick={() => setCart(c => c.map(i => rowKey(i) === rowKey(item) ? { ...i, quantity: i.quantity + 1 } : i))}>
                            <Plus className="size-3" />
                          </Button>
                        </div>
                      </TableCell>
                      <TableCell className="font-semibold text-emerald-600">
                        {item.product.quantity_on_hand + totalForProduct(cart, item.product.id)}
                      </TableCell>
                      <TableCell>
                        <Button type="button" variant="outline" size="icon-sm" className="border-[#D5C6E0] bg-[#F0EBF5] text-red-600 hover:bg-[#E4D9EE] hover:text-red-700"
                          onClick={() => setCart(c => c.filter(i => rowKey(i) !== rowKey(item)))}>
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
          <Card className="rounded-xl border border-[#E2D8E9] bg-white shadow-sm ring-0">
            <CardContent>
              <div className="mb-4 grid gap-1.5">
                <Label htmlFor="si-notes">Notes (optional)</Label>
                <Input id="si-notes" placeholder="Supplier, delivery note, PO number…"
                  value={notes} onChange={e => setNotes(e.target.value)} />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">
                  {cart.reduce((s, i) => s + i.quantity, 0)} units · {groupRowsByProduct(cart).length} product{groupRowsByProduct(cart).length !== 1 ? 's' : ''}
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

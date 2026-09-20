'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { usePortalCart } from '@/context/PortalCartContext'
import { useStaffPortal } from '@/context/StaffPortalContext'
import { submitLoanRequest, validateCartDates, tightestLendingCap, lendingIntervalLabel } from '@/lib/firebase/loanRequests'
import { todayDateStr, addDaysToDateStr, formatLendWindow } from '@/lib/utils'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { X, ShoppingCart } from 'lucide-react'

export default function LendCartPage() {
  const router = useRouter()
  const { cart, updateQuantity, removeFromCart, clearCart } = usePortalCart()
  const { user, staffMember } = useStaffPortal()
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [message, setMessage] = useState('')
  const [errors, setErrors] = useState<string[]>([])
  const [checking, setChecking] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  // A To date is only required while at least one cart item has a finite
  // lending interval — validateCartDates itself decides that (and re-checks
  // it here too since the cart's contents, not just the dates, can change
  // which item is tightest), so the effect must still run on a blank toDate
  // rather than skipping validation entirely the way it used to.
  useEffect(() => {
    if (cart.length === 0 || !fromDate) { setErrors([]); return }
    let cancelled = false
    setChecking(true)
    validateCartDates(cart, fromDate, toDate).then((result) => {
      if (!cancelled) { setErrors(result.errors); setChecking(false) }
    })
    return () => { cancelled = true }
  }, [cart, fromDate, toDate])

  const tightestCap = tightestLendingCap(cart)

  async function handleSubmit() {
    if (!staffMember || cart.length === 0 || !fromDate || (!toDate && tightestCap)) return
    setSubmitting(true)
    try {
      await submitLoanRequest(
        staffMember.id.toString(), staffMember.full_name, cart, fromDate, toDate,
        message.trim() || null, { userId: user?.uid, userName: staffMember.full_name },
      )
      toast.success('Request submitted — Selouna will review it soon.')
      clearCart()
      router.push('/lend/requests')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to submit request.')
    }
    setSubmitting(false)
  }

  if (cart.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center">
        <ShoppingCart className="size-10 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">Your cart is empty. Browse equipment to add items.</p>
        <Button render={<a href="/lend" />}>Browse Equipment</Button>
      </div>
    )
  }

  const canSubmit = fromDate && (toDate || !tightestCap) && errors.length === 0 && !checking

  return (
    <div className="max-w-[700px]">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-foreground">Your Cart</h1>
        <p className="mt-1 text-sm text-muted-foreground">Choose your pickup dates, then submit your request.</p>
      </div>

      <Card className="mb-4 py-0">
        <div className="max-h-96 overflow-y-auto">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-card">
            <TableRow>
              <TableHead>Product</TableHead>
              <TableHead>Lendable</TableHead>
              <TableHead>Max loan</TableHead>
              <TableHead>Quantity</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {cart.map((item) => (
              <TableRow key={item.product.id}>
                <TableCell className="font-medium">{item.product.name}</TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {formatLendWindow(item.product.lend_from, item.product.lend_to)}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {lendingIntervalLabel(item.product.lending_interval)}
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-1.5">
                    <Button variant="ghost" size="icon-sm" onClick={() => updateQuantity(item.product.id, item.quantity - 1)}>−</Button>
                    <span className="min-w-6 text-center font-bold text-primary">{item.quantity}</span>
                    <Button variant="ghost" size="icon-sm" onClick={() => updateQuantity(item.product.id, item.quantity + 1)}>+</Button>
                  </div>
                </TableCell>
                <TableCell>
                  <Button variant="ghost" size="icon-sm" onClick={() => removeFromCart(item.product.id)}>
                    <X className="size-3.5" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        </div>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Pickup dates</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="from-date">From</Label>
              <Input id="from-date" type="date" className="w-44" value={fromDate} min={todayDateStr()}
                onChange={(e) => { setFromDate(e.target.value); if (toDate && toDate < e.target.value) setToDate('') }} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="to-date">To {!tightestCap && <span className="font-normal text-muted-foreground">(optional)</span>}</Label>
              <Input id="to-date" type="date" className="w-44" value={toDate}
                min={fromDate || todayDateStr()}
                max={fromDate && tightestCap ? addDaysToDateStr(fromDate, tightestCap.days) : undefined}
                disabled={!fromDate}
                onChange={(e) => setToDate(e.target.value)} />
            </div>
          </div>

          {fromDate && (
            <p className="text-xs text-muted-foreground">
              {tightestCap
                ? `Based on the items in your cart, this loan can run for up to ${tightestCap.label.toLowerCase()}.`
                : "Every item in your cart can be borrowed indefinitely — you don't need to set a To date unless you want one."}
            </p>
          )}

          <div className="grid gap-1.5">
            <Label htmlFor="message">Message (optional)</Label>
            <Textarea id="message" value={message} onChange={(e) => setMessage(e.target.value)}
              placeholder="Anything Selouna should know about this request…" rows={3} />
          </div>

          {errors.map((e) => (
            <Alert variant="destructive" key={e}>
              <AlertDescription>{e}</AlertDescription>
            </Alert>
          ))}

          <Button disabled={!canSubmit || submitting} onClick={handleSubmit} className="w-fit">
            {submitting ? 'Submitting…' : 'Submit Request'}
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}

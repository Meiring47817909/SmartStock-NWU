'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { notifyLoanRequestEvent } from '@/lib/firebase/notifyEvent'
import { usePortalCart } from '@/context/PortalCartContext'
import { useStaffPortal } from '@/context/StaffPortalContext'
import {
  submitLoanRequest, validateCartDates, tightestLendingCap, lendingIntervalLabel,
  getReservationIntervals, reservedQuantityInRange, type ReservationInterval,
} from '@/lib/firebase/loanRequests'
import { todayDateStr, addDaysToDateStr, formatLendWindow } from '@/lib/utils'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { AvailabilityDatePicker } from '@/components/portal/AvailabilityDatePicker'
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
    // loan_requests/loan_request_lines (read inside validateCartDates, for
    // the live availability check) stay signed-in-only in firestore.rules —
    // unlike `products`, that wasn't opened up to guests. A guest can still
    // fill in dates and see errors clear, but the actual conflict check
    // only runs once there's a real linked account to run it against; it
    // re-runs on its own once they sign in (staffMember becomes truthy).
    if (!staffMember || cart.length === 0 || !fromDate) { setErrors([]); return }
    let cancelled = false
    setChecking(true)
    validateCartDates(cart, fromDate, toDate).then((result) => {
      if (!cancelled) { setErrors(result.errors); setChecking(false) }
    })
    return () => { cancelled = true }
  }, [staffMember, cart, fromDate, toDate])

  const tightestCap = tightestLendingCap(cart)

  // Reservation windows for every product in the cart, fetched once (not
  // once per calendar day) so the From/To date pickers below can color
  // each visible day green/red without a network round trip per day. Same
  // signed-in-only gate as the validateCartDates effect above — a guest
  // sees an uncolored calendar until they sign in.
  const [intervals, setIntervals] = useState<Map<string, ReservationInterval[]> | null>(null)
  useEffect(() => {
    // No setIntervals(null) on the early-out branch (unlike the errors
    // effect above) — deliberately, so this never calls setState
    // synchronously within the effect body. Guests and an empty cart are
    // both already excluded from ever seeing colored days by the
    // `!staffMember` check inside fromDayStatus/toDayStatus themselves, so
    // there's nothing for a stale `intervals` value to leak into meanwhile.
    if (!staffMember || cart.length === 0) return
    let cancelled = false
    getReservationIntervals(cart.map(({ product }) => product.id.toString())).then((result) => {
      if (!cancelled) setIntervals(result)
    }).catch((err) => {
      // Surfaced rather than left as a silently-rejected promise — without
      // this, a rules/permission problem here would leave the From/To
      // calendars stuck uncolored forever with nothing in the UI or
      // console to explain why.
      console.error('Failed to load reservation data for the availability calendar', err)
    })
    return () => { cancelled = true }
  }, [staffMember, cart])

  // A single day is "available" for the From picker when every cart item
  // falls inside its own lendable window that day AND has enough unreserved
  // stock for just that one day — a full-range check isn't possible yet
  // since the To date (and therefore the actual loan length) hasn't been
  // chosen. Colors green/red only; a red From date stays clickable, same as
  // any other, and validateCartDates' own errors below still catch it
  // either way once picked.
  function fromDayStatus(day: string): 'available' | 'unavailable' | null {
    if (!staffMember || !intervals) return null
    return cart.every(({ product, quantity }) => {
      if (!product.lend_from || day < product.lend_from) return false
      if (product.lend_to && day > product.lend_to) return false
      const reserved = reservedQuantityInRange(intervals.get(product.id.toString()) ?? [], day, day)
      return product.quantity_on_hand - reserved >= quantity
    }) ? 'available' : 'unavailable'
  }

  // Once a From date is chosen, a candidate To date is "available" when the
  // FULL [From, To] window still has enough stock for every item — the
  // already-enforced min/max bounds (the tightest lending-interval cap,
  // each product's own lend_to) keep genuinely out-of-window dates disabled
  // exactly as before; this only colors the days still selectable within
  // them.
  function toDayStatus(day: string): 'available' | 'unavailable' | null {
    if (!staffMember || !intervals || !fromDate) return null
    return cart.every(({ product, quantity }) => {
      const reserved = reservedQuantityInRange(intervals.get(product.id.toString()) ?? [], fromDate, day)
      return product.quantity_on_hand - reserved >= quantity
    }) ? 'available' : 'unavailable'
  }

  async function handleSubmit() {
    // No linked staff account (guest browsing, or a signed-out visitor who
    // built a cart before ever signing in) — send them to sign in first
    // rather than silently doing nothing, regardless of whether the dates
    // below are even filled in yet. `next` brings them straight back here
    // (cart items survive the trip — see PortalCartContext) instead of
    // dropping them on Browse; the login page still requires a manual
    // Submit Request click, it never auto-submits on their behalf.
    if (!staffMember) {
      router.push('/login?next=/lend/cart')
      return
    }
    if (cart.length === 0 || !fromDate || (!toDate && tightestCap)) return
    setSubmitting(true)
    try {
      const requestId = await submitLoanRequest(
        staffMember.id.toString(), staffMember.full_name, cart, fromDate, toDate,
        message.trim() || null, { userId: user?.uid, userName: staffMember.full_name },
      )
      notifyLoanRequestEvent(user, 'new_loan_request', requestId)
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
    // Centered within the now-wider Browse/Cart layout (see (portal)/lend/layout.tsx)
    // rather than sitting flush-left in the extra space, and as wide as the
    // whole page used to be before that layout widened, not just the 700px
    // this content itself used to claim.
    <div className="mx-auto max-w-[1000px]">
      <div className="mb-6 space-y-1">
        <h1 className="text-3xl font-extrabold tracking-tight text-[#22162B]">Your Cart</h1>
        <p className="text-sm text-[#5B4F67]">Choose your pickup dates, then submit your request.</p>
      </div>

      <Card className="mb-4 rounded-xl border border-[#E2D8E9] bg-white py-0 shadow-sm ring-0">
        <div className="max-h-96 overflow-y-auto">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-[#F0EBF5]">
            <TableRow className="border-b border-[#E0D5E7] hover:bg-[#F0EBF5]">
              <TableHead className="h-auto py-3.5 text-base font-bold text-[#2D203A]">Product</TableHead>
              <TableHead className="h-auto py-3.5 text-base font-bold text-[#2D203A]">Lendable</TableHead>
              <TableHead className="h-auto py-3.5 text-base font-bold text-[#2D203A]">Max loan</TableHead>
              <TableHead className="h-auto py-3.5 text-base font-bold text-[#2D203A]">Quantity</TableHead>
              <TableHead className="h-auto py-3.5"></TableHead>
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
                  <Button variant="outline" size="icon-sm" className="border-[#D5C6E0] bg-[#F0EBF5] text-red-600 hover:bg-[#E4D9EE] hover:text-red-700" onClick={() => removeFromCart(item.product.id)}>
                    <X className="size-3.5" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        </div>
      </Card>

      <Card className="rounded-xl border border-[#E2D8E9] bg-white shadow-sm ring-0">
        <CardHeader>
          <CardTitle>Pickup dates</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="from-date">From</Label>
              <AvailabilityDatePicker
                id="from-date"
                value={fromDate}
                min={todayDateStr()}
                dayStatus={fromDayStatus}
                onChange={(next) => { setFromDate(next); if (toDate && toDate < next) setToDate('') }}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="to-date">To {!tightestCap && <span className="font-normal text-muted-foreground">(optional)</span>}</Label>
              <AvailabilityDatePicker
                id="to-date"
                value={toDate}
                min={fromDate || todayDateStr()}
                max={fromDate && tightestCap ? addDaysToDateStr(fromDate, tightestCap.days) : undefined}
                disabled={!fromDate}
                dayStatus={toDayStatus}
                onChange={setToDate}
              />
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

          {/* A guest can always click this — it just sends them to sign in — so
              the date/validation gating below only applies once there's a
              real account to actually submit against. */}
          <Button disabled={staffMember ? (!canSubmit || submitting) : false} onClick={handleSubmit} className="w-fit">
            {submitting ? 'Submitting…' : 'Submit Request'}
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}

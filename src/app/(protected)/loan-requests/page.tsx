'use client'

import { Fragment, useEffect, useState } from 'react'
import { useExpandedRows } from '@/hooks/useExpandedRows'
import { toast } from 'sonner'
import { db } from '@/lib/firebase/config'
import { collection, doc, getDoc, getDocs } from 'firebase/firestore'
import { useAuth } from '@/context/AuthContext'
import {
  approveAsIs, sendCounter, declineRequest, expireIfNeeded,
  computeExpiryDate, getReservedQuantity, effectiveToDate,
} from '@/lib/firebase/loanRequests'
import { formatDateOnly, formatLendWindow, todayDateStr } from '@/lib/utils'
import { notifyAlertsChanged } from '@/lib/alertsBus'
import { Card } from '@/components/ui/card'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import type { LoanRequest, LoanRequestLine, LoanRequestStatus } from '@/types/database'

const STATUS_BADGE_CLASS: Record<LoanRequestStatus, string> = {
  pending: 'bg-amber-100 text-amber-800',
  countered: 'bg-sky-100 text-sky-800',
  accepted: 'bg-emerald-100 text-emerald-800',
  fulfilled: 'bg-accent text-accent-foreground',
  declined: 'bg-red-100 text-red-800',
  expired: 'bg-muted text-muted-foreground',
  withdrawn: 'bg-muted text-muted-foreground',
  no_show: 'bg-red-100 text-red-800',
}

interface DraftLine {
  id: string
  product_id: string
  product_name: string
  requested_quantity: number
  offered_quantity: number
}

interface Draft {
  lines: DraftLine[]
  fromDate: string
  toDate: string
}

// Undated-pushed-to-end comparator — same shape as dashboard/page.tsx's
// outstandingList.sort.
function byExpirySoonestFirst(a: LoanRequest, b: LoanRequest) {
  const ea = computeExpiryDate(a)
  const eb = computeExpiryDate(b)
  if (!ea && !eb) return 0
  if (!ea) return 1
  if (!eb) return -1
  return ea.localeCompare(eb)
}

export default function LoanRequestsPage() {
  const { user, profile } = useAuth()
  const actor = { userId: user?.uid, userName: profile?.full_name ?? user?.email }

  const [requests, setRequests] = useState<LoanRequest[]>([])
  const [linesByRequest, setLinesByRequest] = useState<Record<string, LoanRequestLine[]>>({})
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'pending' | 'countered'>('pending')
  const { isExpanded, toggle: toggleRow, collapse: collapseRow } = useExpandedRows()
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [availability, setAvailability] = useState<Record<string, Record<string, number>>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})
  // The request Selouna has clicked Send Counter or Decline on, held
  // while that action's own confirmation modal (with an optional message)
  // is open — same pattern as the Dashboard's Resolve/Cancel-pickup
  // dialogs. Only one of the two is ever non-null at a time.
  const [countering, setCountering] = useState<LoanRequest | null>(null)
  const [counterMessage, setCounterMessage] = useState('')
  const [counterBusy, setCounterBusy] = useState(false)
  const [declining, setDeclining] = useState<LoanRequest | null>(null)
  const [declineMessage, setDeclineMessage] = useState('')
  const [declineBusy, setDeclineBusy] = useState(false)

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    const reqSnap = await getDocs(collection(db, 'loan_requests'))
    let reqs = reqSnap.docs.map(d => ({ id: d.id, ...d.data() })) as LoanRequest[]

    // Lazily flip expiry/no-show transitions before rendering, so a stale
    // pending/countered/accepted status never lingers in the list — see
    // LENDING_PORTAL_SPEC.md §3.3/3.4.
    reqs = await Promise.all(reqs.map(async (r) => {
      if (r.status !== 'pending' && r.status !== 'countered' && r.status !== 'accepted') return r
      const next = await expireIfNeeded(r)
      return next !== r.status ? { ...r, status: next, updated_at: new Date().toISOString() } : r
    }))

    const linesSnap = await getDocs(collection(db, 'loan_request_lines'))
    const byRequest: Record<string, LoanRequestLine[]> = {}
    linesSnap.forEach((d) => {
      const l = { id: d.id, ...d.data() } as LoanRequestLine
      ;(byRequest[l.request_id] ??= []).push(l)
    })

    setRequests(reqs)
    setLinesByRequest(byRequest)
    setLoading(false)
  }

  async function refreshAvailability(requestId: string, lines: DraftLine[], fromDate: string, toDate: string) {
    const uniqueProductIds = Array.from(new Set(lines.map((l) => l.product_id)))
    const entries = await Promise.all(uniqueProductIds.map(async (pid) => {
      const productSnap = await getDoc(doc(db, 'products', pid))
      const onHand = (productSnap.data() as { quantity_on_hand?: number } | undefined)?.quantity_on_hand ?? 0
      const reserved = await getReservedQuantity(pid, fromDate, effectiveToDate(toDate), requestId)
      return [pid, Math.max(0, onHand - reserved)] as const
    }))
    const availabilityMap = Object.fromEntries(entries)
    setAvailability((prev) => ({ ...prev, [requestId]: availabilityMap }))

    // Stock can have moved since this line's offered_quantity was last set
    // (a walk-in Stock Out issue, another request getting approved, etc.) —
    // if what's actually available now is less than what's currently
    // offered, pull the offered quantity down to match rather than leaving
    // it showing a number that's no longer real. This is exactly what
    // "Approve as-is" would otherwise fail on (assertStillAvailable checks
    // the stored offered_quantity, not the draft), so clamping here also
    // correctly nudges staff toward Send Counter with the reduced amount.
    setDrafts((prev) => {
      const draft = prev[requestId]
      if (!draft) return prev
      let changed = false
      const nextLines = draft.lines.map((l) => {
        const cap = Math.min(l.requested_quantity, availabilityMap[l.product_id] ?? l.requested_quantity)
        if (l.offered_quantity > cap) { changed = true; return { ...l, offered_quantity: Math.max(0, cap) } }
        return l
      })
      return changed ? { ...prev, [requestId]: { ...draft, lines: nextLines } } : prev
    })
  }

  function toggleExpand(r: LoanRequest) {
    // toggle() reports whether the row just opened; collapsing needs no
    // draft built.
    if (!toggleRow(r.id)) return
    // Only a 'pending' request gets an editable draft — a 'countered' one
    // renders read-only (CounteredRow below) straight from linesByRequest,
    // since she can no longer re-edit or re-send it.
    if (r.status !== 'pending') return
    if (drafts[r.id]) return
    const lines: DraftLine[] = (linesByRequest[r.id] ?? []).map((l) => ({
      id: l.id, product_id: l.product_id, product_name: l.product_name,
      requested_quantity: l.requested_quantity, offered_quantity: l.offered_quantity,
    }))
    setDrafts((prev) => ({ ...prev, [r.id]: { lines, fromDate: r.from_date, toDate: r.to_date ?? '' } }))
    refreshAvailability(r.id, lines, r.from_date, r.to_date ?? '')
  }

  function updateOfferedQty(requestId: string, lineId: string, qty: number) {
    setDrafts((prev) => {
      const draft = prev[requestId]
      if (!draft) return prev
      const line = draft.lines.find((l) => l.id === lineId)
      if (!line) return prev
      const cap = Math.min(line.requested_quantity, availability[requestId]?.[line.product_id] ?? line.requested_quantity)
      const clamped = Math.max(0, Math.min(qty, cap))
      return {
        ...prev,
        [requestId]: { ...draft, lines: draft.lines.map((l) => (l.id === lineId ? { ...l, offered_quantity: clamped } : l)) },
      }
    })
  }

  function updateDraftDate(requestId: string, field: 'fromDate' | 'toDate', value: string) {
    setDrafts((prev) => {
      const draft = prev[requestId]
      if (!draft) return prev
      const next = { ...draft, [field]: value }
      refreshAvailability(requestId, next.lines, next.fromDate, next.toDate)
      return { ...prev, [requestId]: next }
    })
  }


  function isDirty(r: LoanRequest): boolean {
    const draft = drafts[r.id]
    if (!draft) return false
    if (draft.fromDate !== r.from_date || (draft.toDate || null) !== r.to_date) return true
    const original = linesByRequest[r.id] ?? []
    return draft.lines.some((dl) => {
      const orig = original.find((o) => o.id === dl.id)
      return orig ? orig.offered_quantity !== dl.offered_quantity : false
    })
  }

  async function handleApprove(r: LoanRequest) {
    setBusy(r.id); setRowErrors((prev) => ({ ...prev, [r.id]: '' }))
    try {
      await approveAsIs(r, linesByRequest[r.id] ?? [], actor)
      toast.success(`Approved ${r.staff_name}'s request.`)
      collapseRow(r.id)
      await load()
      // Approving moves this request out of Needs Review and into an
      // Incoming Pickup — both this page's own Sidebar badge and the
      // Dashboard's need to know (see alertsBus.ts).
      notifyAlertsChanged()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to approve request.'
      setRowErrors((prev) => ({ ...prev, [r.id]: message }))
      toast.error(message)
    }
    setBusy(null)
  }

  // Opens the confirmation modal below rather than sending straight off
  // the row's button — same reasoning as Decline: this is a staff-visible
  // action, and the optional message belongs in the modal that actually
  // sends it, not sitting inline in the row waiting to be forgotten about.
  function startCounter(r: LoanRequest) {
    setCountering(r)
    setCounterMessage(r.admin_message ?? '')
  }

  async function confirmSendCounter() {
    if (!countering) return
    const r = countering
    const draft = drafts[r.id]
    if (!draft) return
    setCounterBusy(true)
    try {
      await sendCounter(
        r,
        draft.lines.map((l) => ({ lineId: l.id, product_id: l.product_id, offered_quantity: l.offered_quantity })),
        draft.fromDate, draft.toDate || null, counterMessage, actor,
      )
      toast.success(`Counter sent to ${r.staff_name}.`)
      collapseRow(r.id)
      setCountering(null)
      setCounterMessage('')
      await load()
      // Same nudge as Approve above.
      notifyAlertsChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to send counter.')
    }
    setCounterBusy(false)
  }

  // Opens the confirmation dialog below rather than declining straight
  // off the row's button — same reasoning as Dashboard's Resolve/Cancel:
  // this is a one-way, staff-visible action, and now that there's an
  // optional message to type, a dialog is the natural place to type it.
  function startDecline(r: LoanRequest) {
    setDeclining(r)
    setDeclineMessage('')
  }

  async function confirmDecline() {
    if (!declining) return
    const r = declining
    setDeclineBusy(true)
    try {
      await declineRequest(r, declineMessage, linesByRequest[r.id], actor)
      toast.success(`Declined ${r.staff_name}'s request.`)
      collapseRow(r.id)
      setDeclining(null)
      setDeclineMessage('')
      await load()
      // Same nudge as Approve above.
      notifyAlertsChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to decline request.')
    }
    setDeclineBusy(false)
  }

  const pending = requests.filter((r) => r.status === 'pending').sort(byExpirySoonestFirst)
  const countered = requests.filter((r) => r.status === 'countered').sort(byExpirySoonestFirst)

  function EditableRow({ r }: { r: LoanRequest }) {
    // A 'countered' request is read-only from here on — Selouna already
    // sent her offer; she can only Decline it now (see CounteredRow below),
    // never re-edit quantities/dates or send another counter/approve-as-is.
    if (r.status === 'countered') return <CounteredRow r={r} />

    const draft = drafts[r.id]
    const dirty = isDirty(r)
    return (
      <TableRow className="bg-muted/50">
        {/* Holds free text (a staff message, a counter note), and TableCell
                    is whitespace-nowrap by default — see the same fix in
                    audit-log/page.tsx. Without this the message sets the cell's
                    min-content width and drags the table past the screen. */}
        <TableCell colSpan={5} className="p-4 break-words whitespace-normal">
          {!draft ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <div className="flex flex-col gap-4">
              <div className="flex flex-wrap items-end gap-4">
                <div className="grid gap-1.5">
                  <label className="text-xs font-medium text-muted-foreground">From</label>
                  <Input type="date" className="w-40" value={draft.fromDate} min={todayDateStr()}
                    onChange={(e) => updateDraftDate(r.id, 'fromDate', e.target.value)} />
                </div>
                <div className="grid gap-1.5">
                  <label className="text-xs font-medium text-muted-foreground">To</label>
                  <Input type="date" className="w-40" value={draft.toDate} min={draft.fromDate}
                    onChange={(e) => updateDraftDate(r.id, 'toDate', e.target.value)} />
                </div>
              </div>

              {/* Below the dates and full width, rather than squeezed into
                  the date row at a fixed 360px. w-full so it uses the whole
                  expanded cell and only wraps at the table's edge;
                  break-words so an unbroken token can't widen the table. */}
              {r.message && (
                <div className="grid w-full gap-1.5">
                  <span className="text-xs font-medium text-muted-foreground">Message</span>
                  <p className="w-full text-sm break-words whitespace-normal text-foreground">
                    {r.message}
                  </p>
                </div>
              )}

              <div className="max-h-64 overflow-y-auto">
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-card">
                  <TableRow>
                    <TableHead>Product</TableHead>
                    <TableHead>Requested</TableHead>
                    <TableHead>Offering</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {draft.lines.map((l) => (
                    <TableRow key={l.id}>
                      <TableCell className="max-w-xs font-medium whitespace-normal break-words">{l.product_name}</TableCell>
                      <TableCell className="text-muted-foreground">{l.requested_quantity}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1.5">
                          <Button variant="ghost" size="icon-sm" onClick={() => updateOfferedQty(r.id, l.id, l.offered_quantity - 1)}>−</Button>
                          <span className={`min-w-6 text-center font-bold ${l.offered_quantity > 0 ? 'text-primary' : 'text-muted-foreground'}`}>{l.offered_quantity}</span>
                          <Button variant="ghost" size="icon-sm" onClick={() => updateOfferedQty(r.id, l.id, l.offered_quantity + 1)}>+</Button>
                        </div>
                      </TableCell>
                      <TableCell>
                        {l.offered_quantity > 0 && (
                          <Button variant="ghost" size="sm" onClick={() => updateOfferedQty(r.id, l.id, 0)}>Remove</Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              </div>

              {rowErrors[r.id] && (
                <Alert variant="destructive"><AlertDescription>{rowErrors[r.id]}</AlertDescription></Alert>
              )}

              <div className="flex items-center gap-2">
                <Button disabled={busy === r.id || dirty} onClick={() => handleApprove(r)}>
                  {busy === r.id ? '…' : 'Approve as-is'}
                </Button>
                <Button
                  variant="outline"
                  disabled={busy === r.id || !dirty || draft.lines.every((l) => l.offered_quantity <= 0)}
                  onClick={() => startCounter(r)}
                  title={draft.lines.every((l) => l.offered_quantity <= 0) ? 'Offer at least 1 unit of a product to send a counter.' : undefined}
                >
                  Send Counter
                </Button>
                <Button variant="ghost" disabled={busy === r.id} onClick={() => startDecline(r)} className="ml-auto text-destructive hover:text-destructive">
                  Decline
                </Button>
              </div>
            </div>
          )}
        </TableCell>
      </TableRow>
    )
  }

  // Read-only summary for the "Sent Counters" tab: the staff member's
  // original message, a requested-vs-countered line comparison (an item
  // Selouna zeroed out shows as "Removed"), and her own counter message —
  // then just a Decline action. She can no longer re-edit quantities/dates
  // or send another counter/approve-as-is once a counter has gone out;
  // declining here freezes all of this into one audit entry (see
  // declineRequest's countered-aware snapshot in loanRequests.ts).
  function CounteredRow({ r }: { r: LoanRequest }) {
    const lines = linesByRequest[r.id] ?? []
    const datesChanged = r.from_date !== r.original_from_date || (r.to_date ?? null) !== (r.original_to_date ?? null)
    return (
      <TableRow className="bg-muted/50">
        {/* Holds free text (a staff message, a counter note), and TableCell
                    is whitespace-nowrap by default — see the same fix in
                    audit-log/page.tsx. Without this the message sets the cell's
                    min-content width and drags the table past the screen. */}
        <TableCell colSpan={5} className="p-4 break-words whitespace-normal">
          <div className="flex flex-col gap-4">
            {r.message && (
              <div className="grid gap-1.5">
                <span className="text-xs font-medium text-muted-foreground">Staff&apos;s message</span>
                <p className="w-full text-sm break-words whitespace-normal text-foreground">&ldquo;{r.message}&rdquo;</p>
              </div>
            )}

            <div className="grid gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">Counter offered</span>
              <p className="text-sm text-foreground">{formatLendWindow(r.from_date, r.to_date)}</p>
              {datesChanged && (
                <p className="text-xs text-muted-foreground">
                  Originally requested {formatLendWindow(r.original_from_date, r.original_to_date)}
                </p>
              )}
            </div>

            <div className="max-h-64 overflow-y-auto">
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-card">
                  <TableRow>
                    <TableHead>Product</TableHead>
                    <TableHead>Requested</TableHead>
                    <TableHead>Counter Offer</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lines.map((l) => (
                    <TableRow key={l.id}>
                      <TableCell className="max-w-xs font-medium whitespace-normal break-words">{l.product_name}</TableCell>
                      <TableCell className="text-muted-foreground">{l.requested_quantity}</TableCell>
                      <TableCell>
                        {l.offered_quantity > 0 ? (
                          <span className="font-bold text-primary">{l.offered_quantity}</span>
                        ) : (
                          <span className="font-bold text-destructive">Removed</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {r.admin_message && (
              <div className="grid gap-1.5">
                <span className="text-xs font-medium text-muted-foreground">Your counter message</span>
                <p className="w-full text-sm break-words whitespace-normal text-foreground">&ldquo;{r.admin_message}&rdquo;</p>
              </div>
            )}

            <div className="flex items-center gap-2">
              <p className="text-xs text-muted-foreground">
                Waiting on {r.staff_name} to respond — you can decline this counter, or wait for them to accept or decline it themselves.
              </p>
              <Button variant="ghost" disabled={busy === r.id} onClick={() => startDecline(r)} className="ml-auto text-destructive hover:text-destructive">
                Decline
              </Button>
            </div>
          </div>
        </TableCell>
      </TableRow>
    )
  }

  function requestRows(list: LoanRequest[]) {
    if (loading) return <TableRow><TableCell colSpan={5} className="py-8 text-center text-muted-foreground">Loading…</TableCell></TableRow>
    if (list.length === 0) return <TableRow><TableCell colSpan={5} className="py-8 text-center text-muted-foreground">Nothing here ✓</TableCell></TableRow>
    return list.map((r) => {
      const itemCount = (linesByRequest[r.id] ?? []).length
      const expiry = computeExpiryDate(r)
      return (
        <Fragment key={r.id}>
          <TableRow className="cursor-pointer" onClick={() => toggleExpand(r)}>
            <TableCell className="text-xs text-muted-foreground">{isExpanded(r.id) ? '▲' : '▼'}</TableCell>
            <TableCell className="max-w-xs font-medium whitespace-normal break-words">
              {r.staff_name}
              {r.reference_no && (
                <div className="font-mono text-xs font-normal break-all text-muted-foreground">
                  {r.reference_no}
                </div>
              )}
            </TableCell>
            <TableCell className="text-muted-foreground">{itemCount} item{itemCount === 1 ? '' : 's'}</TableCell>
            <TableCell>
              <Badge className={`${STATUS_BADGE_CLASS[r.status]} uppercase`}>{r.status.replace('_', ' ')}</Badge>
            </TableCell>
            <TableCell className="text-muted-foreground">{expiry ? formatDateOnly(expiry) : '—'}</TableCell>
          </TableRow>
          {isExpanded(r.id) && <EditableRow r={r} />}
        </Fragment>
      )
    })
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-foreground">Loan Requests</h1>
        <p className="mt-1 text-sm text-muted-foreground">Review, counter, and track portal lending requests from NWU staff.</p>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)} className="min-h-0 flex-1">
        {/* Same segmented-control tab bar as Reports/Dashboard/My
            Requests: a bordered light-grey track, each tab flex-1 across
            the full width, the active one a white pill with NWU-purple
            text. Forced !h-14/!h-11 heights (rather than h-auto) because
            TabsTrigger's own base class hardcodes h-[calc(100%-1px)],
            which otherwise wins and stretches every tab to the track's
            full height with no breathing room top/bottom. */}
        <TabsList className="mb-6 flex w-full !h-14 gap-0 overflow-hidden rounded-lg border border-(--nwu-purple)/30 bg-border p-1.5">
          <TabsTrigger
            value="pending"
            className="!h-11 flex-1 cursor-pointer self-center rounded-md px-4 text-sm font-semibold whitespace-nowrap text-(--nwu-grey-dark) transition-all hover:text-foreground data-active:border data-active:border-(--nwu-purple)/30 data-active:bg-card data-active:text-(--nwu-purple) data-active:shadow-sm"
          >
            Needs Review
            {pending.length > 0 && <Badge className="bg-amber-100 text-amber-800">{pending.length}</Badge>}
          </TabsTrigger>
          <TabsTrigger
            value="countered"
            className="!h-11 flex-1 cursor-pointer self-center rounded-md px-4 text-sm font-semibold whitespace-nowrap text-(--nwu-grey-dark) transition-all hover:text-foreground data-active:border data-active:border-(--nwu-purple)/30 data-active:bg-card data-active:text-(--nwu-purple) data-active:shadow-sm"
          >
            Sent Counters
            {countered.length > 0 && <Badge className="bg-sky-100 text-sky-800">{countered.length}</Badge>}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="pending" className="min-h-0">
          <Card className="h-full min-h-0 py-0">
            <div className="min-h-0 flex-1 overflow-y-auto">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-card">
                <TableRow>
                  <TableHead className="w-8"></TableHead>
                  <TableHead>Staff</TableHead>
                  <TableHead>Items</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Expires</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>{requestRows(pending)}</TableBody>
            </Table>
            </div>
          </Card>
        </TabsContent>

        <TabsContent value="countered" className="min-h-0">
          <Card className="h-full min-h-0 py-0">
            <div className="min-h-0 flex-1 overflow-y-auto">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-card">
                <TableRow>
                  <TableHead className="w-8"></TableHead>
                  <TableHead>Staff</TableHead>
                  <TableHead>Items</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Expires</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>{requestRows(countered)}</TableBody>
            </Table>
            </div>
          </Card>
        </TabsContent>

      </Tabs>

      {/* Send Counter confirmation — the optional message lives here,
          not inline in the row, so it's the last thing typed right before
          it actually goes out. Same shape as Decline's dialog below. */}
      <Dialog open={countering !== null} onOpenChange={(open) => { if (!open) { setCountering(null); setCounterMessage('') } }}>
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle>Send counter to {countering?.staff_name}?</DialogTitle>
            <DialogDescription>
              This sends the updated dates and quantities set on this request, plus an optional message below.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="counter-message">Message to {countering?.staff_name} <span className="font-normal text-muted-foreground">(optional)</span></Label>
            <Textarea
              id="counter-message"
              rows={2}
              placeholder="Sent to the staff member along with this counter…"
              value={counterMessage}
              onChange={(e) => setCounterMessage(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setCountering(null); setCounterMessage('') }} disabled={counterBusy}>Close</Button>
            <Button disabled={counterBusy} onClick={confirmSendCounter}>
              {counterBusy ? 'Sending…' : 'Send Counter'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Decline confirmation — same shape as the Dashboard's Resolve/
          Cancel-pickup dialogs: a one-way, staff-visible action gets an
          explicit confirm step, with an optional message typed here. */}
      <Dialog open={declining !== null} onOpenChange={(open) => { if (!open) { setDeclining(null); setDeclineMessage('') } }}>
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle>Decline this request?</DialogTitle>
            <DialogDescription>
              {declining && (
                <>
                  <strong className="text-foreground">{declining.staff_name}</strong>&apos;s request will be declined — they&apos;ll see it in their My Requests history.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="decline-message">Message to {declining?.staff_name} <span className="font-normal text-muted-foreground">(optional)</span></Label>
            <Textarea
              id="decline-message"
              rows={2}
              placeholder="e.g. Out of stock for the dates requested, item retired…"
              value={declineMessage}
              onChange={(e) => setDeclineMessage(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setDeclining(null); setDeclineMessage('') }} disabled={declineBusy}>Close</Button>
            <Button variant="destructive" disabled={declineBusy} onClick={confirmDecline}>
              {declineBusy ? 'Declining…' : 'Decline'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

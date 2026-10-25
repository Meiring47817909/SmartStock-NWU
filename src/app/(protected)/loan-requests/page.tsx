'use client'

import { Fragment, useEffect, useState } from 'react'
import { useExpandedRows } from '@/hooks/useExpandedRows'
import { useTable, type SortingState } from '@tanstack/react-table'
import { SORTABLE_TABLE_FEATURES, sortableColumnHelper, SortableHead } from '@/components/data-table-helpers'
import { toast } from 'sonner'
import { notifyLoanRequestEvent } from '@/lib/firebase/notifyEvent'
import { useAuth } from '@/context/AuthContext'
import {
  ACTIVE_STATUSES, approveAsIs, sendCounter, declineRequest, expireIfDue, isStaleRequestError,
  listRequests, getRequestLines, computeExpiryDate, getReservedQuantity, effectiveToDate,
} from '@/lib/api/loanRequests'
import { getProduct } from '@/lib/api/catalog'
import { formatDateOnly, formatDateShort, formatLendWindow, todayDateStr } from '@/lib/utils'
import { loanRequestStatusLabel } from '@/lib/loanRequestRules'
import { notifyAlertsChanged } from '@/lib/alertsBus'
import { Card } from '@/components/ui/card'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { SEGMENTED_TABS_LIST, SEGMENTED_TAB_TRIGGER } from '@/components/ui/segmentedTabs'
import { Button } from '@/components/ui/button'
import { AvailabilityDatePicker } from '@/components/portal/AvailabilityDatePicker'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import type { LoanRequest, LoanRequestLine, LoanRequestStatus } from '@/types/database'

const STATUS_BADGE_CLASS: Record<LoanRequestStatus, string> = {
  pending: 'bg-amber-100 text-amber-800 border-amber-200/60 px-2.5 font-semibold',
  countered: 'bg-sky-100 text-sky-800 border-sky-200/60 px-2.5 font-semibold',
  accepted: 'bg-emerald-100 text-emerald-800 border-emerald-200/60 px-2.5 font-semibold',
  fulfilled: 'bg-accent text-accent-foreground border-transparent px-2.5 font-semibold',
  declined: 'bg-red-100 text-red-800 border-red-200/60 px-2.5 font-semibold',
  expired: 'bg-muted text-muted-foreground border-transparent px-2.5 font-semibold',
  withdrawn: 'bg-muted text-muted-foreground border-transparent px-2.5 font-semibold',
  no_show: 'bg-red-100 text-red-800 border-red-200/60 px-2.5 font-semibold',
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

// The enriched row shape both outer request tables below actually sort --
// itemCount isn't a field on LoanRequest itself, see pendingRows/
// counteredRows below.
type LoanRequestRow = LoanRequest & { itemCount: number }

// Shared by both outer request tables below (Needs Review / Sent
// Counters) -- same shadcn/tanstack sortable-column pattern as Dashboard
// and Reports (see data-table-helpers.tsx). Each table gets its own column
// list because the one date column between them differs (Requested vs
// Countered), but Staff/Items/Status/Expires are otherwise identical.
// Expires uses computeExpiryDate() rather than a stored field (there isn't
// one -- see LoanRequest.updated_at's own doc comment), falling back to ''
// so an undated (indefinite) request sorts before any dated one ascending.
const NEEDS_REVIEW_COLUMNS = sortableColumnHelper.columns([
  sortableColumnHelper.accessor('staff_name', { id: 'staff_name', header: 'Staff', sortFn: 'alphanumeric' }),
  sortableColumnHelper.accessor((r: LoanRequestRow) => r.itemCount, { id: 'item_count', header: 'Items', sortFn: 'alphanumeric' }),
  sortableColumnHelper.accessor('status', { id: 'status', header: 'Status', sortFn: 'alphanumeric' }),
  // created_at is set once at submission and never changes -- exactly
  // "when the staff member requested" this loan.
  sortableColumnHelper.accessor('created_at', { id: 'requested', header: 'Requested', sortFn: 'text' }),
  sortableColumnHelper.accessor((r: LoanRequestRow) => computeExpiryDate(r) ?? '', { id: 'expiry', header: 'Expires', sortFn: 'text' }),
])

const SENT_COUNTERS_COLUMNS = sortableColumnHelper.columns([
  sortableColumnHelper.accessor('staff_name', { id: 'staff_name', header: 'Staff', sortFn: 'alphanumeric' }),
  sortableColumnHelper.accessor((r: LoanRequestRow) => r.itemCount, { id: 'item_count', header: 'Items', sortFn: 'alphanumeric' }),
  sortableColumnHelper.accessor('status', { id: 'status', header: 'Status', sortFn: 'alphanumeric' }),
  // updated_at is bumped on every status transition -- sendCounter() sets
  // it alongside status: 'countered', so on a request that's currently
  // sitting in this tab it's exactly when Selouna sent the counter.
  sortableColumnHelper.accessor('updated_at', { id: 'countered', header: 'Countered', sortFn: 'text' }),
  sortableColumnHelper.accessor((r: LoanRequestRow) => computeExpiryDate(r) ?? '', { id: 'expiry', header: 'Expires', sortFn: 'text' }),
])

export default function LoanRequestsPage() {
  const { user } = useAuth()

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
  // Default: oldest Requested first on Needs Review, oldest Countered
  // first on Sent Counters -- both ascending on their own date column, so
  // whatever's been waiting longest for a response surfaces at the top.
  const [pendingSorting, setPendingSorting] = useState<SortingState>([{ id: 'requested', desc: false }])
  const [counteredSorting, setCounteredSorting] = useState<SortingState>([{ id: 'countered', desc: false }])

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    // Only the active requests: this page shows Needs Review and Sent Counters, and the lazy expiry below only
    // concerns pending/countered/accepted ones.
    let reqs = await listRequests({ statuses: ACTIVE_STATUSES })

    // Lazily flip expiry/no-show transitions before rendering, so a stale
    // pending/countered/accepted status never lingers in the list — see
    // LENDING_PORTAL_SPEC.md §3.3/3.4.
    reqs = await Promise.all(reqs.map(async (r) => {
      if (r.status !== 'pending' && r.status !== 'countered' && r.status !== 'accepted') return r
      const next = await expireIfDue(r)
      return next !== r.status ? { ...r, status: next, updated_at: new Date().toISOString() } : r
    }))

    // Lines are only needed for the two tabs' rows (Needs Review / Sent Counters).
    const byRequest: Record<string, LoanRequestLine[]> = {}
    await Promise.all(reqs.filter((r) => r.status === 'pending' || r.status === 'countered').map(async (r) => {
      byRequest[r.id] = await getRequestLines(r.id)
    }))

    setRequests(reqs)
    setLinesByRequest(byRequest)
    setLoading(false)
  }

  async function refreshAvailability(requestId: string, lines: DraftLine[], fromDate: string, toDate: string) {
    const uniqueProductIds = Array.from(new Set(lines.map((l) => l.product_id)))
    const entries = await Promise.all(uniqueProductIds.map(async (pid) => {
      const onHand = (await getProduct(pid))?.quantity_on_hand ?? 0
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
      await approveAsIs(r)
      notifyLoanRequestEvent(user, 'loan_request_approved', r.id)
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
      // Someone else (or the expiry) got to this request first: show what it is now.
      if (isStaleRequestError(err)) await load()
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
      await sendCounter(r, {
        lines: draft.lines.map((l) => ({ lineId: l.id, product_id: l.product_id, offered_quantity: l.offered_quantity })),
        fromDate: draft.fromDate, toDate: draft.toDate || null, message: counterMessage,
      })
      notifyLoanRequestEvent(user, 'loan_request_countered', r.id)
      toast.success(`Counter sent to ${r.staff_name}.`)
      collapseRow(r.id)
      setCountering(null)
      setCounterMessage('')
      await load()
      // Same nudge as Approve above.
      notifyAlertsChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to send counter.')
      if (isStaleRequestError(err)) { collapseRow(r.id); setCountering(null); setCounterMessage(''); await load() }
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
      await declineRequest(r, declineMessage)
      notifyLoanRequestEvent(user, 'loan_request_declined', r.id)
      toast.success(`Declined ${r.staff_name}'s request.`)
      collapseRow(r.id)
      setDeclining(null)
      setDeclineMessage('')
      await load()
      // Same nudge as Approve above.
      notifyAlertsChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to decline request.')
      if (isStaleRequestError(err)) { collapseRow(r.id); setDeclining(null); setDeclineMessage(''); await load() }
    }
    setDeclineBusy(false)
  }

  // itemCount isn't a field on LoanRequest itself (it's derived from
  // linesByRequest), so it's attached here -- once per row, not recomputed
  // by every column's accessor/sortFn -- before handing rows to the table.
  const pendingRows = requests.filter((r) => r.status === 'pending')
    .map((r) => ({ ...r, itemCount: (linesByRequest[r.id] ?? []).length }))
  const counteredRows = requests.filter((r) => r.status === 'countered')
    .map((r) => ({ ...r, itemCount: (linesByRequest[r.id] ?? []).length }))

  const pendingTable = useTable({
    features: SORTABLE_TABLE_FEATURES,
    columns: NEEDS_REVIEW_COLUMNS,
    data: pendingRows,
    state: { sorting: pendingSorting },
    onSortingChange: setPendingSorting,
  })
  const pending = pendingTable.getSortedRowModel().rows.map((row) => row.original as typeof pendingRows[number])

  const counteredTable = useTable({
    features: SORTABLE_TABLE_FEATURES,
    columns: SENT_COUNTERS_COLUMNS,
    data: counteredRows,
    state: { sorting: counteredSorting },
    onSortingChange: setCounteredSorting,
  })
  const countered = counteredTable.getSortedRowModel().rows.map((row) => row.original as typeof counteredRows[number])

  function EditableRow({ r }: { r: LoanRequest }) {
    // A 'countered' request is read-only from here on — Selouna already
    // sent her offer; she can only Decline it now (see CounteredRow below),
    // never re-edit quantities/dates or send another counter/approve-as-is.
    if (r.status === 'countered') return <CounteredRow r={r} />

    const draft = drafts[r.id]
    const dirty = isDirty(r)
    return (
      <TableRow className="border-y border-[#E2D8E9]/80 bg-[#FBF9FD] shadow-inner hover:bg-[#FBF9FD]">
        {/* Holds free text (a staff message, a counter note), and TableCell
                    is whitespace-nowrap by default — see the same fix in
                    audit-log/page.tsx. Without this the message sets the cell's
                    min-content width and drags the table past the screen. */}
        <TableCell colSpan={6} className="px-8 py-6 break-words whitespace-normal">
          {!draft ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <div className="flex flex-col gap-4">
              <div className="flex flex-wrap items-end gap-4">
                <div className="grid gap-1.5">
                  <label className="text-sm font-semibold text-slate-600">From</label>
                  <AvailabilityDatePicker id={`lr-from-${r.id}`} className="w-48 border-slate-300 bg-white text-slate-700" value={draft.fromDate} min={todayDateStr()}
                    onChange={(next) => updateDraftDate(r.id, 'fromDate', next)} />
                </div>
                <div className="grid gap-1.5">
                  <label className="text-sm font-semibold text-slate-600">To</label>
                  <AvailabilityDatePicker id={`lr-to-${r.id}`} clearable className="w-48 border-slate-300 bg-white text-slate-700" value={draft.toDate} min={draft.fromDate}
                    onChange={(next) => updateDraftDate(r.id, 'toDate', next)} />
                </div>
              </div>

              {/* Below the dates and full width, rather than squeezed into
                  the date row at a fixed 360px. w-full so it uses the whole
                  expanded cell and only wraps at the table's edge;
                  break-words so an unbroken token can't widen the table. */}
              {r.message && (
                <div className="grid w-full gap-1.5">
                  <span className="text-sm font-semibold text-slate-600">Message</span>
                  <p className="w-full text-sm break-words whitespace-normal text-foreground">
                    {r.message}
                  </p>
                </div>
              )}

              <div className="max-h-64 overflow-y-auto rounded-lg border border-[#E5DBEC] bg-white shadow-xs">
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-[#6C3D91] [&_th]:border-b [&_th]:border-[#522E6E] [&_th]:!text-white [&_th_*]:!text-white [&_th_svg]:!text-white/75">
                  <TableRow className="border-b border-[#522E6E] hover:bg-[#6C3D91]">
                    <TableHead className="h-auto py-2.5 text-base font-bold text-[#2D203A]">Product</TableHead>
                    <TableHead className="h-auto py-2.5 text-center text-base font-bold text-[#2D203A]">Requested</TableHead>
                    <TableHead className="h-auto py-2.5 text-center text-base font-bold text-[#2D203A]">Offering</TableHead>
                    <TableHead className="h-auto py-2.5 text-right text-base font-bold text-[#2D203A]">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {draft.lines.map((l) => (
                    <TableRow key={l.id} className="border-slate-100 hover:bg-[#FDFCFE]">
                      <TableCell className="max-w-xs font-semibold text-sm text-slate-800 whitespace-normal break-words">{l.product_name}</TableCell>
                      <TableCell className="text-center text-sm font-medium text-slate-600">{l.requested_quantity}</TableCell>
                      <TableCell>
                        <div className="flex items-center justify-center gap-3">
                          <Button variant="ghost" size="icon-sm" className="text-slate-600 hover:bg-slate-100" onClick={() => updateOfferedQty(r.id, l.id, l.offered_quantity - 1)}>−</Button>
                          <span className={`min-w-6 text-center font-bold ${l.offered_quantity > 0 ? 'text-primary' : 'text-slate-600'}`}>{l.offered_quantity}</span>
                          <Button variant="ghost" size="icon-sm" className="text-slate-600 hover:bg-slate-100" onClick={() => updateOfferedQty(r.id, l.id, l.offered_quantity + 1)}>+</Button>
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        {l.offered_quantity > 0 && (
                          <Button variant="outline" size="sm" className="h-auto rounded-lg border-[#D5C6E0] bg-[#F0EBF5] px-3 py-1.5 text-sm font-semibold text-red-600 hover:bg-[#E4D9EE] hover:text-red-700" onClick={() => updateOfferedQty(r.id, l.id, 0)}>Remove</Button>
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

              <div className="flex items-center justify-between pt-2">
                <div className="flex items-center gap-3">
                  <Button
                    disabled={busy === r.id || dirty}
                    onClick={() => handleApprove(r)}
                    className="h-auto rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-white shadow-sm hover:bg-[#582e78]"
                  >
                    {busy === r.id ? '…' : 'Approve as-is'}
                  </Button>
                  <Button
                    disabled={busy === r.id || !dirty || draft.lines.every((l) => l.offered_quantity <= 0)}
                    onClick={() => startCounter(r)}
                    title={draft.lines.every((l) => l.offered_quantity <= 0) ? 'Offer at least 1 unit of a product to send a counter.' : undefined}
                    className="h-auto rounded-lg bg-(--nwu-turquoise) px-5 py-2.5 text-sm font-medium text-white shadow-sm hover:bg-(--nwu-turquoise-dark)"
                  >
                    Send Counter
                  </Button>
                </div>
                <Button variant="outline" disabled={busy === r.id} onClick={() => startDecline(r)} className="h-auto rounded-lg border-[#D5C6E0] bg-[#F0EBF5] px-3 py-1.5 text-sm font-semibold text-red-600 hover:bg-[#E4D9EE] hover:text-red-700">
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
      <TableRow className="border-y border-[#E2D8E9]/80 bg-[#FBF9FD] shadow-inner hover:bg-[#FBF9FD]">
        {/* Holds free text (a staff message, a counter note), and TableCell
                    is whitespace-nowrap by default — see the same fix in
                    audit-log/page.tsx. Without this the message sets the cell's
                    min-content width and drags the table past the screen. */}
        <TableCell colSpan={6} className="px-8 py-6 break-words whitespace-normal">
          <div className="flex flex-col gap-4">
            {r.message && (
              <div className="grid gap-1.5">
                <span className="text-sm font-semibold text-slate-600">Staff&apos;s message</span>
                <p className="w-full text-sm break-words whitespace-normal text-foreground">&ldquo;{r.message}&rdquo;</p>
              </div>
            )}

            <div className="grid gap-1.5">
              <span className="text-sm font-semibold text-slate-600">Counter offered</span>
              <p className="text-sm text-foreground">{formatLendWindow(r.from_date, r.to_date)}</p>
              {datesChanged && (
                <p className="text-xs text-muted-foreground">
                  Originally requested {formatLendWindow(r.original_from_date, r.original_to_date)}
                </p>
              )}
            </div>

            <div className="max-h-64 overflow-y-auto rounded-lg border border-[#E5DBEC] bg-white shadow-xs">
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-[#6C3D91] [&_th]:border-b [&_th]:border-[#522E6E] [&_th]:!text-white [&_th_*]:!text-white [&_th_svg]:!text-white/75">
                  <TableRow className="border-b border-[#522E6E] hover:bg-[#6C3D91]">
                    <TableHead className="h-auto py-2.5 text-base font-bold text-[#2D203A]">Product</TableHead>
                    <TableHead className="h-auto py-2.5 text-base font-bold text-[#2D203A]">Requested</TableHead>
                    <TableHead className="h-auto py-2.5 text-base font-bold text-[#2D203A]">Counter Offer</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lines.map((l) => (
                    <TableRow key={l.id} className="border-slate-100 hover:bg-[#FDFCFE]">
                      <TableCell className="max-w-xs font-semibold text-sm text-slate-800 whitespace-normal break-words">{l.product_name}</TableCell>
                      <TableCell className="text-sm font-medium text-slate-600">{l.requested_quantity}</TableCell>
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
                <span className="text-sm font-semibold text-slate-600">Your counter message</span>
                <p className="w-full text-sm break-words whitespace-normal text-foreground">&ldquo;{r.admin_message}&rdquo;</p>
              </div>
            )}

            <div className="flex items-center justify-between gap-2 pt-2">
              <p className="text-xs text-muted-foreground">
                Waiting on {r.staff_name} to respond — you can decline this counter, or wait for them to accept or decline it themselves.
              </p>
              <Button variant="outline" disabled={busy === r.id} onClick={() => startDecline(r)} className="h-auto rounded-lg border-[#D5C6E0] bg-[#F0EBF5] px-3 py-1.5 text-sm font-semibold text-red-600 hover:bg-[#E4D9EE] hover:text-red-700">
                Decline
              </Button>
            </div>
          </div>
        </TableCell>
      </TableRow>
    )
  }

  function requestRows(list: LoanRequestRow[], dateColumn: 'requested' | 'countered') {
    if (loading) return <TableRow><TableCell colSpan={6} className="py-8 text-center text-muted-foreground">Loading…</TableCell></TableRow>
    if (list.length === 0) return <TableRow><TableCell colSpan={6} className="py-8 text-center text-muted-foreground">Nothing here ✓</TableCell></TableRow>
    return list.map((r) => {
      const expiry = computeExpiryDate(r)
      // Requested = created_at (set once at submission, never changes).
      // Countered = updated_at (bumped on every status transition -- on a
      // request currently sitting in this tab, its last transition was
      // sendCounter() setting status: 'countered').
      const dateValue = dateColumn === 'requested' ? r.created_at : r.updated_at
      return (
        <Fragment key={r.id}>
          <TableRow className="group cursor-pointer hover:bg-[#FAF7FC]" onClick={() => toggleExpand(r)}>
            <TableCell className="py-4 pl-6 text-xs text-slate-600 transition-colors group-hover:text-primary">{isExpanded(r.id) ? '▲' : '▼'}</TableCell>
            <TableCell className="max-w-xs py-4 text-sm font-semibold whitespace-normal break-words text-slate-900 transition-colors group-hover:text-primary">
              {r.staff_name}
              {r.reference_no && (
                <div className="font-mono text-xs font-normal break-all text-slate-600">
                  {r.reference_no}
                </div>
              )}
            </TableCell>
            <TableCell className="py-4 text-sm text-slate-600">{r.itemCount} item{r.itemCount === 1 ? '' : 's'}</TableCell>
            <TableCell className="py-4">
              <Badge className={STATUS_BADGE_CLASS[r.status]}>{loanRequestStatusLabel(r.status)}</Badge>
            </TableCell>
            <TableCell className="py-4 text-sm font-medium text-slate-600">{formatDateShort(dateValue)}</TableCell>
            <TableCell className="py-4 pr-6 text-sm font-medium text-slate-600">{expiry ? formatDateOnly(expiry) : '—'}</TableCell>
          </TableRow>
          {isExpanded(r.id) && <EditableRow r={r} />}
        </Fragment>
      )
    })
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-6 space-y-1">
        <h1 className="text-3xl font-extrabold tracking-tight text-[#22162B]">Loan Requests</h1>
        <p className="text-sm text-[#5B4F67]">Review, counter, and track portal lending requests from NWU staff.</p>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)} className="min-h-0 flex-1">
        {/* Same segmented-control tab bar as Dashboard/Reports: a
            bordered light-grey track, each tab flex-1 across the full
            width, the active one a solid NWU-purple pill with white text.
            Forced !h-14/!h-11 heights (rather than h-auto) because
            TabsTrigger's own base class hardcodes h-[calc(100%-1px)],
            which otherwise wins and stretches every tab to the track's
            full height with no breathing room top/bottom. */}
        <TabsList className={SEGMENTED_TABS_LIST}>
          <TabsTrigger
            value="pending"
            className={SEGMENTED_TAB_TRIGGER}
          >
            Needs Review
            {pending.length > 0 && (
              <Badge className="bg-(--nwu-turquoise) text-white">
                {pending.length}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger
            value="countered"
            className={SEGMENTED_TAB_TRIGGER}
          >
            Sent Counters
            {countered.length > 0 && (
              <Badge className="bg-(--nwu-turquoise) text-white">
                {countered.length}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="pending" className="min-h-0">
          <Card className="h-full min-h-0 rounded-xl border border-[#E2D8E9] bg-white py-0 shadow-sm ring-0">
            <div className="min-h-0 flex-1 overflow-y-auto">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-[#6C3D91] [&_th]:border-b [&_th]:border-[#522E6E] [&_th]:!text-white [&_th_*]:!text-white [&_th_svg]:!text-white/75">
                <TableRow className="border-b border-[#522E6E] hover:bg-[#6C3D91]">
                  <TableHead className="h-auto w-8 py-3.5 pl-6"></TableHead>
                  <SortableHead column={pendingTable.getColumn('staff_name')!} className="h-auto py-3.5 text-base font-bold text-[#2D203A]">Staff</SortableHead>
                  <SortableHead column={pendingTable.getColumn('item_count')!} className="h-auto py-3.5 text-base font-bold text-[#2D203A]">Items</SortableHead>
                  <SortableHead column={pendingTable.getColumn('status')!} className="h-auto py-3.5 text-base font-bold text-[#2D203A]">Status</SortableHead>
                  <SortableHead column={pendingTable.getColumn('requested')!} className="h-auto py-3.5 text-base font-bold text-[#2D203A]">Requested</SortableHead>
                  <SortableHead column={pendingTable.getColumn('expiry')!} className="h-auto py-3.5 pr-6 text-base font-bold text-[#2D203A]">Expires</SortableHead>
                </TableRow>
              </TableHeader>
              <TableBody>{requestRows(pending, 'requested')}</TableBody>
            </Table>
            </div>
          </Card>
        </TabsContent>

        <TabsContent value="countered" className="min-h-0">
          <Card className="h-full min-h-0 rounded-xl border border-[#E2D8E9] bg-white py-0 shadow-sm ring-0">
            <div className="min-h-0 flex-1 overflow-y-auto">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-[#6C3D91] [&_th]:border-b [&_th]:border-[#522E6E] [&_th]:!text-white [&_th_*]:!text-white [&_th_svg]:!text-white/75">
                <TableRow className="border-b border-[#522E6E] hover:bg-[#6C3D91]">
                  <TableHead className="h-auto w-8 py-3.5 pl-6"></TableHead>
                  <SortableHead column={counteredTable.getColumn('staff_name')!} className="h-auto py-3.5 text-base font-bold text-[#2D203A]">Staff</SortableHead>
                  <SortableHead column={counteredTable.getColumn('item_count')!} className="h-auto py-3.5 text-base font-bold text-[#2D203A]">Items</SortableHead>
                  <SortableHead column={counteredTable.getColumn('status')!} className="h-auto py-3.5 text-base font-bold text-[#2D203A]">Status</SortableHead>
                  <SortableHead column={counteredTable.getColumn('countered')!} className="h-auto py-3.5 text-base font-bold text-[#2D203A]">Countered</SortableHead>
                  <SortableHead column={counteredTable.getColumn('expiry')!} className="h-auto py-3.5 pr-6 text-base font-bold text-[#2D203A]">Expires</SortableHead>
                </TableRow>
              </TableHeader>
              <TableBody>{requestRows(countered, 'countered')}</TableBody>
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

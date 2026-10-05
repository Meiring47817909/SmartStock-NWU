'use client'

import { Fragment, useEffect, useState } from 'react'
import { useExpandedRows } from '@/hooks/useExpandedRows'
import { formatDateOnly, formatLendWindow, sentenceCase } from '@/lib/utils'
import { useTable, type SortingState } from '@tanstack/react-table'
import { SORTABLE_TABLE_FEATURES, sortableColumnHelper, SortableHead } from '@/components/data-table-helpers'
import { toast } from 'sonner'
import { notifyLoanRequestEvent } from '@/lib/firebase/notifyEvent'
import { isStaleRequestError, withdrawRequest } from '@/lib/api/loanRequests'
import { notifyAlertsChanged } from '@/lib/alertsBus'
import { createReturnWaiver } from '@/lib/api/stock'
import { loadDashboard, type DashboardData, type IncomingPickupRow, type LowStockStatus, type OutstandingReturnRow, type OutstandingStatus, type PickupLine } from '@/lib/api/dashboard'
import { loadNotificationSettings } from '@/lib/api/settings'
import { useAuth } from '@/context/AuthContext'
import { useRole } from '@/context/RoleContext'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import { Card, CardContent } from '@/components/ui/card'
import { Carousel, CarouselContent, CarouselItem, CarouselNext, CarouselPrevious } from '@/components/ui/carousel'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { SEGMENTED_TABS_LIST, SEGMENTED_TAB_TRIGGER } from '@/components/ui/segmentedTabs'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'

// Every row here is still outstanding — nothing has been returned yet — so
// the label needs to describe urgency going forward, not judge a completed
// action. "Early/On time/Late" (used in the Reports Returns tab, which
// describes an actual past return event) reads backwards here: it implies
// something already happened. This table only ever shows lines with a
// remaining balance, so there's no "Partial" case to consider the way there
// is on the Returns report (every row here already IS the outstanding portion).
//
// Which state a row is in (overdue / due today / not due yet / no date) is
// decided on the server, by the Johannesburg calendar day — see
// src/server/data/dashboard.ts — so every browser agrees with the server's
// idea of "today". This only maps that state to its label and colours.
//
// An issue with no Lend To is a deliberate "no return date agreed", not
// missing data, so it gets its own neutral label rather than an empty
// cell — otherwise the row reads as broken.
const OUTSTANDING_STATUS: Record<OutstandingStatus, { label: string; className: string }> = {
  no_return_date: { label: 'No Return Date', className: 'bg-slate-100 text-slate-800 border-slate-200/60 px-2.5 font-semibold' },
  overdue: { label: 'Overdue', className: 'bg-red-100 text-red-800 border-red-200/60 px-2.5 font-semibold' },
  due_today: { label: 'Due Today', className: 'bg-amber-100 text-amber-800 border-amber-200/60 px-2.5 font-semibold' },
  not_due_yet: { label: 'Not Due Yet', className: 'bg-emerald-100 text-emerald-800 border-emerald-200/60 px-2.5 font-semibold' },
}

function outstandingStatus(status: OutstandingStatus): { label: string; className: string } {
  return OUTSTANDING_STATUS[status]
}

// Same urgency order as the labels above — most pressing first — so sorting
// the Status column reads as "worst first" either direction, not an
// arbitrary A-Z order over the label text.
const OUTSTANDING_STATUS_RANK: Record<OutstandingStatus, number> = {
  overdue: 0, due_today: 1, not_due_yet: 2, no_return_date: 3,
}

const OUTSTANDING_RETURNS_COLUMNS = sortableColumnHelper.columns([
  sortableColumnHelper.accessor('product_name', { id: 'product_name', header: 'Product', sortFn: 'alphanumeric' }),
  sortableColumnHelper.accessor('staff_name', { id: 'staff_name', header: 'Staff', sortFn: 'alphanumeric' }),
  sortableColumnHelper.accessor('qty', { id: 'qty', header: 'Qty', sortFn: (a: any, b: any) => a.original.qty - b.original.qty }),
  sortableColumnHelper.accessor((o: any) => o.expected_date ?? '', { id: 'expected_date', header: 'Expected', sortFn: 'text' }),
  sortableColumnHelper.accessor((o: any) => outstandingStatus(o.status).label, {
    id: 'status',
    header: 'Status',
    sortFn: (a: any, b: any) => OUTSTANDING_STATUS_RANK[a.original.status as OutstandingStatus] - OUTSTANDING_STATUS_RANK[b.original.status as OutstandingStatus],
  }),
])

// Same idea for Incoming Pickups' Status column — Not Picked Up is the most
// urgent state, On Schedule the least.
const PICKUP_STATUS_RANK: Record<string, number> = { 'Not Picked Up': 0, Insufficient: 1, 'On Schedule': 2 }

function pickupStatusLabel(p: { noShow: boolean; insufficient: boolean }): string {
  return p.noShow ? 'Not Picked Up' : p.insufficient ? 'Insufficient' : 'On Schedule'
}

const INCOMING_PICKUPS_COLUMNS = sortableColumnHelper.columns([
  sortableColumnHelper.accessor('staff_name', { id: 'staff_name', header: 'Staff', sortFn: 'alphanumeric' }),
  sortableColumnHelper.accessor('item_count', { id: 'item_count', header: 'Items', sortFn: (a: any, b: any) => a.original.item_count - b.original.item_count }),
  sortableColumnHelper.accessor('from_date', { id: 'from_date', header: 'Pickup Window', sortFn: 'text' }),
  sortableColumnHelper.accessor((p: any) => pickupStatusLabel(p), {
    id: 'status',
    header: 'Status',
    sortFn: (a: any, b: any) => PICKUP_STATUS_RANK[pickupStatusLabel(a.original)] - PICKUP_STATUS_RANK[pickupStatusLabel(b.original)],
  }),
])

// And Low Stock Alerts' Status column — Out of stock outranks Low stock, so
// sorting surfaces the most depleted items first.
const LOW_STOCK_STATUS: Record<LowStockStatus, { label: string; rank: number }> = {
  out_of_stock: { label: 'Out of stock', rank: 0 },
  low_stock: { label: 'Low stock', rank: 1 },
}

const LOW_STOCK_COLUMNS = sortableColumnHelper.columns([
  sortableColumnHelper.accessor('name', { id: 'name', header: 'Product', sortFn: 'alphanumeric' }),
  sortableColumnHelper.accessor('quantity_on_hand', { id: 'quantity_on_hand', header: 'Qty', sortFn: (a: any, b: any) => a.original.quantity_on_hand - b.original.quantity_on_hand }),
  sortableColumnHelper.accessor((p: any) => LOW_STOCK_STATUS[p.status as LowStockStatus].label, {
    id: 'status',
    header: 'Status',
    sortFn: (a: any, b: any) => LOW_STOCK_STATUS[a.original.status as LowStockStatus].rank - LOW_STOCK_STATUS[b.original.status as LowStockStatus].rank,
  }),
])

type DashboardTab = 'outstanding-returns' | 'incoming-pickups' | 'low-stock'

export default function DashboardPage() {
  const [stats, setStats] = useState({
    total_products: 0,
    total_stock: 0,
    low_stock: 0,
    today_transactions: 0,
    total_staff: 0
  })
  const [outstanding, setOutstanding] = useState<OutstandingReturnRow[]>([])
  const [lowItems, setLowItems] = useState<DashboardData['lowStock']>([])
  const [incomingPickups, setIncomingPickups] = useState<IncomingPickupRow[]>([])
  // The row Selouna has clicked Cancel on, held while the confirmation
  // dialog is open — same pattern as `resolving` above.
  const [cancelling, setCancelling] = useState<{ id: string; staff_name: string; item_count: number; from_date: string; to_date: string | null } | null>(null)
  const [cancelReason, setCancelReason] = useState('')
  // Drives the cancel-pickup dialog's copy below -- starts true (the
  // setting's own default) so the dialog doesn't flash the "off" wording
  // for the instant before this loads.
  const [pickupCancelledEmailOn, setPickupCancelledEmailOn] = useState(true)
  const [cancelBusy, setCancelBusy] = useState(false)
  // Per-request product/qty breakdown for Incoming Pickups' own expandable
  // rows — fetched eagerly alongside lineCountByRequest below rather than
  // lazily on expand, since the same loan_request_lines read already
  // happens for the item count.
  const [pickupLines, setPickupLines] = useState<Record<string, PickupLine[]>>({})
  // Outstanding-and-overdue return lines, grouped by product — the
  // candidate "likely cause" shown when an Incoming Pickup line comes up
  // short (see the insufficiency check below). Keyed by product_id so an
  // expanded pickup row can look its own products up directly.
  const [overdueByProduct, setOverdueByProduct] = useState<DashboardData['overdueByProduct']>({})
  const { isExpanded: isPickupExpanded, toggle: togglePickup } = useExpandedRows()
  const [loading, setLoading] = useState(true)
  // The row Selouna has clicked Resolve on, held while the confirmation
  // dialog is open. Resolving records an append-only return waiver (see
  // lib/stockRules.ts for why that's its own record, not a RETURN).
  const [resolving, setResolving] = useState<OutstandingReturnRow | null>(null)
  const [resolveReason, setResolveReason] = useState('')
  const [resolveBusy, setResolveBusy] = useState(false)
  const [dashboardTab, setDashboardTab] = useState<DashboardTab>('outstanding-returns')
  const [outstandingSorting, setOutstandingSorting] = useState<SortingState>([])
  const [pickupsSorting, setPickupsSorting] = useState<SortingState>([])
  const [lowStockSorting, setLowStockSorting] = useState<SortingState>([])
  const { user } = useAuth()
  const { isAdmin } = useRole()

  // Lifted out of the mount effect so Cancel/Resolve and the tab strip
  // can trigger a fresh pass too — see the two call sites below and
  // notes on why: those two actions (and a tab switch, in case someone
  // else changed something in the meantime) can change whether an
  // Incoming Pickup line is still Insufficient, and nothing was
  // re-checking that after the initial load. `silent` skips the
  // full-page "Loading dashboard..." replacement for a background
  // refresh — only the very first, real page load shows that.
  async function getDashboardData(opts: { silent?: boolean } = {}) {
      if (!opts.silent) setLoading(true)
      try {
        // Everything — the stats, the three tables' rows and each row's
        // badge — is computed on the server in one call (see
        // src/server/data/dashboard.ts); this page only displays it.
        const data = await loadDashboard()
        setStats(data.stats)
        setOutstanding(data.outstandingReturns)
        setOverdueByProduct(data.overdueByProduct)
        setLowItems(data.lowStock)
        setIncomingPickups(data.incomingPickups)
        setPickupLines(data.pickupLines)
      } catch (err) {
        console.error("Failed to load dashboard data", err)
      } finally {
        setLoading(false)
      }
  }

  useEffect(() => {
    getDashboardData()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    // External read (the settings API), not state derivable from props -- same
    // pattern as the Notification Settings page itself.
    loadNotificationSettings()
      .then((s) => setPickupCancelledEmailOn(s.approved_pickup_cancelled))
      .catch(() => {}) // dialog just keeps its default (on) wording
  }, [])

  const statCards = [
    { label: 'Products', value: stats.total_products, className: 'text-primary' },
    { label: 'Total stock units', value: stats.total_stock, className: 'text-(--nwu-turquoise)' },
    { label: 'Low stock items', value: stats.low_stock, className: 'text-amber-600' },
    { label: 'Registered staff', value: stats.total_staff, className: 'text-slate-600' },
  ]

  // Incoming Pickups' own Cancel button (2026-09-20 — moved here from the
  // Loan Requests page, which no longer shows accepted requests at all).
  // Confirmed through a dialog with an optional reason, same shape as
  // Resolve's own confirmation below. withdrawRequest() only needs the
  // request's id (see lib/api/loanRequests.ts) — the lean pickups row
  // already carries it, so there's no need to keep the full LoanRequest
  // around just for this.
  async function confirmCancelPickup() {
    if (!cancelling) return
    setCancelBusy(true)
    try {
      await withdrawRequest(cancelling.id, cancelReason.trim() || null)
      // The reason isn't stored on the request, so it travels with the call.
      notifyLoanRequestEvent(user, 'approved_pickup_cancelled', cancelling.id, { reason: cancelReason })
      // Drop the row locally rather than refetching the whole dashboard —
      // same convention as Resolve below.
      setIncomingPickups(prev => prev.filter(x => x.id !== cancelling.id))
      // Same nudge as Resolve above — this page's own Dashboard badge
      // total needs to drop by one too (alertsBus.ts).
      notifyAlertsChanged()
      // Unlike Resolve, this one genuinely can change another row's
      // Insufficient status — cancelling frees this reservation's hold on
      // the product, which getReservedQuantity subtracts for every OTHER
      // accepted pickup of the same item too.
      getDashboardData({ silent: true })
      toast.success(`Cancelled ${cancelling.staff_name}'s incoming pickup.`)
      setCancelling(null)
      setCancelReason('')
    } catch (err: any) {
      toast.error('Could not cancel this pickup. ' + (err?.message ?? ''))
      // The request changed meanwhile (e.g. it was picked up or expired): show what it is now.
      if (isStaleRequestError(err)) {
        setCancelling(null)
        setCancelReason('')
        getDashboardData({ silent: true })
      }
    } finally {
      setCancelBusy(false)
    }
  }

  // One useTable instance per widget — same shared columnHelper/
  // SortableHead as Reports and the Audit Log, just three small tables
  // instead of one paginated one, so there's no CSV export or pagination
  // footer here (see data-table-helpers.tsx) — sorting only.
  const outstandingTable = useTable({
    features: SORTABLE_TABLE_FEATURES,
    columns: OUTSTANDING_RETURNS_COLUMNS,
    data: outstanding,
    state: { sorting: outstandingSorting },
    onSortingChange: setOutstandingSorting,
  })
  const sortedOutstanding = outstandingTable.getSortedRowModel().rows.map(r => r.original as any)

  const pickupsTable = useTable({
    features: SORTABLE_TABLE_FEATURES,
    columns: INCOMING_PICKUPS_COLUMNS,
    data: incomingPickups,
    state: { sorting: pickupsSorting },
    onSortingChange: setPickupsSorting,
  })
  const sortedPickups = pickupsTable.getSortedRowModel().rows.map(r => r.original as any)

  const lowStockTable = useTable({
    features: SORTABLE_TABLE_FEATURES,
    columns: LOW_STOCK_COLUMNS,
    data: lowItems,
    state: { sorting: lowStockSorting },
    onSortingChange: setLowStockSorting,
  })
  const sortedLowItems = lowStockTable.getSortedRowModel().rows.map(r => r.original as any)

  if (loading) return <div className="p-8 text-muted-foreground">Loading dashboard...</div>

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-6 space-y-1">
        <h1 className="text-3xl font-extrabold tracking-tight text-[#22162B]">Dashboard</h1>
        <p className="text-sm text-[#5B4F67]">NWU IT Store · Potchefstroom</p>
      </div>

      {/* The four summary cards stay on one row at every width: a swipeable
          carousel that shows as many as fit (with the next one peeking in)
          and all four from lg up, where the arrows are no longer needed. */}
      <Carousel opts={{ align: 'start' }} className="mb-6">
        <CarouselContent className="-ml-3 py-1">
          {statCards.map(c => (
            <CarouselItem key={c.label} className="basis-[46%] pl-3 sm:basis-1/3 lg:basis-1/4">
              <Card className="h-full rounded-xl border border-[#E2D8E9] bg-white shadow-sm transition-shadow hover:shadow-md">
                <CardContent>
                  <div className={`text-3xl font-extrabold ${c.className}`}>{c.value}</div>
                  <div className="mt-1 text-sm font-semibold text-muted-foreground">{c.label}</div>
                </CardContent>
              </Card>
            </CarouselItem>
          ))}
        </CarouselContent>
        <CarouselPrevious className="-left-3 bg-white shadow-md disabled:hidden lg:hidden" />
        <CarouselNext className="-right-3 bg-white shadow-md disabled:hidden lg:hidden" />
      </Carousel>

      {/* One table visible at a time, tab-selected — same pattern as the
          Reports page — instead of four permanently-visible cards competing
          for screen space. Each tab label carries its own live count so the
          badge-vs-row-count guarantee from the scrollable-table fix above
          still holds even though only one table is on screen at once. */}
      <Tabs value={dashboardTab} onValueChange={v => { setDashboardTab(v as DashboardTab); getDashboardData({ silent: true }) }} className="min-h-0 flex-1">
        {/* Same segmented-control tab bar as Reports/My Requests: a
            bordered light-grey track, each tab flex-1 across the full
            width, the active one a white pill with NWU-purple text. Forced
            !h-14/!h-11 heights (rather than h-auto) because TabsTrigger's
            own base class hardcodes h-[calc(100%-1px)], which otherwise
            wins and stretches every tab to the track's full height with no
            breathing room top/bottom. */}
        <TabsList className={SEGMENTED_TABS_LIST}>
          <TabsTrigger
            value="outstanding-returns"
            className={SEGMENTED_TAB_TRIGGER}
          >
            Outstanding Returns
            {outstanding.length > 0 && (
              <Badge className="bg-(--nwu-turquoise) text-white">{outstanding.length}</Badge>
            )}
          </TabsTrigger>
          <TabsTrigger
            value="incoming-pickups"
            className={SEGMENTED_TAB_TRIGGER}
          >
            Incoming Pickups
            {incomingPickups.length > 0 && (
              <Badge className="bg-(--nwu-turquoise) text-white">{incomingPickups.length}</Badge>
            )}
          </TabsTrigger>
          <TabsTrigger
            value="low-stock"
            className={SEGMENTED_TAB_TRIGGER}
          >
            Low Stock Alerts
            {stats.low_stock > 0 && (
              <Badge className="bg-(--nwu-turquoise) text-white">{stats.low_stock}</Badge>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="outstanding-returns" className="min-h-0">
          <Card className="h-full min-h-0 overflow-hidden rounded-xl border border-[#E2D8E9] bg-white py-0 shadow-sm ring-0">
            <div className="min-h-0 flex-1 overflow-y-auto">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-[#F0EBF5]">
                <TableRow className="border-b border-[#E0D5E7] hover:bg-[#F0EBF5]">
                  <SortableHead column={outstandingTable.getColumn('product_name')!} className="h-auto py-3.5 text-base font-bold text-[#2D203A]">Product</SortableHead>
                  <SortableHead column={outstandingTable.getColumn('staff_name')!} className="h-auto py-3.5 text-base font-bold text-[#2D203A]">Staff</SortableHead>
                  <SortableHead column={outstandingTable.getColumn('qty')!} className="h-auto py-3.5 text-base font-bold text-[#2D203A]">Qty</SortableHead>
                  <SortableHead column={outstandingTable.getColumn('expected_date')!} className="h-auto py-3.5 text-base font-bold text-[#2D203A]">Expected</SortableHead>
                  <SortableHead column={outstandingTable.getColumn('status')!} className="h-auto py-3.5 text-base font-bold text-[#2D203A]">Status</SortableHead>
                  <TableHead className="h-auto py-3.5 text-right text-base font-bold text-[#2D203A]">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedOutstanding.length === 0 && (
                  <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground">Nothing outstanding ✓</TableCell></TableRow>
                )}
                {sortedOutstanding.map((o) => {
                  const status = outstandingStatus(o.status)
                  return (
                    <TableRow key={o.id} className="hover:bg-[#FAF7FC]">
                      <TableCell className="max-w-xs font-medium whitespace-normal break-words">{o.product_name}</TableCell>
                      <TableCell className="max-w-xs whitespace-normal break-words text-muted-foreground">{o.staff_name}</TableCell>
                      <TableCell className="font-semibold">{o.qty}</TableCell>
                      <TableCell className="text-muted-foreground">{formatDateOnly(o.expected_date)}</TableCell>
                      <TableCell><Badge className={status.className}>{sentenceCase(status.label)}</Badge></TableCell>
                      <TableCell className="text-right">
                        {isAdmin && (
                          <Button variant="outline" size="sm" className="border-slate-300 bg-slate-100 text-slate-600 hover:bg-slate-200 hover:text-slate-900" onClick={() => { setResolving(o); setResolveReason('') }}>
                            Resolve
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
            </div>
          </Card>
        </TabsContent>

        <TabsContent value="incoming-pickups" className="min-h-0">
          <Card className="h-full min-h-0 overflow-hidden rounded-xl border border-[#E2D8E9] bg-white py-0 shadow-sm ring-0">
            <div className="min-h-0 flex-1 overflow-y-auto">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-[#F0EBF5]">
                <TableRow className="border-b border-[#E0D5E7] hover:bg-[#F0EBF5]">
                  <TableHead className="w-8"></TableHead>
                  <SortableHead column={pickupsTable.getColumn('staff_name')!} className="h-auto py-3.5 text-base font-bold text-[#2D203A]">Staff</SortableHead>
                  <SortableHead column={pickupsTable.getColumn('item_count')!} className="h-auto py-3.5 text-base font-bold text-[#2D203A]">Items</SortableHead>
                  <SortableHead column={pickupsTable.getColumn('from_date')!} className="h-auto py-3.5 text-base font-bold text-[#2D203A]">Pickup Window</SortableHead>
                  <SortableHead column={pickupsTable.getColumn('status')!} className="h-auto py-3.5 text-base font-bold text-[#2D203A]">Status</SortableHead>
                  <TableHead className="h-auto py-3.5 text-right text-base font-bold text-[#2D203A]">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedPickups.length === 0 && (
                  <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground">Nothing incoming ✓</TableCell></TableRow>
                )}
                {sortedPickups.map((p) => (
                  <Fragment key={p.id}>
                    <TableRow
                      className="cursor-pointer hover:bg-[#FAF7FC]"
                      onClick={() => togglePickup(p.id)}
                    >
                      <TableCell className="text-xs text-muted-foreground">{isPickupExpanded(p.id) ? '▲' : '▼'}</TableCell>
                      <TableCell className="max-w-xs font-medium whitespace-normal break-words">
                        {p.staff_name}
                        {p.reference_no && (
                          <div className="font-mono text-xs font-normal break-all text-muted-foreground">
                            {p.reference_no}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{p.item_count} item{p.item_count === 1 ? '' : 's'}</TableCell>
                      <TableCell className="text-muted-foreground">{formatLendWindow(p.from_date, p.to_date)}</TableCell>
                      <TableCell>
                        {p.noShow
                          ? <Badge className="bg-red-100 text-red-800 border-red-200/60 px-2.5 font-semibold">Not picked up</Badge>
                          : p.insufficient
                            ? <Badge className="bg-orange-100 text-orange-800 border-orange-200/60 px-2.5 font-semibold">Insufficient</Badge>
                            : <Badge className="bg-emerald-100 text-emerald-800 border-emerald-200/60 px-2.5 font-semibold">On schedule</Badge>}
                      </TableCell>
                      <TableCell className="text-right">
                        {isAdmin && (
                          <Button
                            variant="outline" size="sm"
                            onClick={(e) => { e.stopPropagation(); setCancelling(p); setCancelReason('') }}
                            className="border-[#D5C6E0] bg-[#F0EBF5] text-red-600 hover:bg-[#E4D9EE] hover:text-red-700"
                          >
                            Cancel
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                    {isPickupExpanded(p.id) && (
                      <TableRow className="border-y border-[#E2D8E9]/80 bg-[#FBF9FD] shadow-inner hover:bg-[#FBF9FD]">
                        <TableCell colSpan={6} className="p-4 whitespace-normal">
                          {(pickupLines[p.id] ?? []).length === 0 ? (
                            <p className="text-sm text-muted-foreground">No items recorded.</p>
                          ) : (
                            <ul className="ml-4 list-disc text-sm">
                              {(pickupLines[p.id] ?? []).map((l) => (
                                <li key={l.id}>
                                  {l.product_name} <span className="text-muted-foreground">× {l.offered_quantity}</span>
                                  {l.shortBy > 0 && (
                                    <div className="mt-1.5 ml-1 max-w-md rounded-md border border-orange-200 bg-orange-50 p-2 text-xs break-words text-orange-900">
                                      <p className="font-medium">
                                        Short by {l.shortBy} — only {l.available} of {l.offered_quantity} on hand right now.
                                      </p>
                                      {(overdueByProduct[l.product_id] ?? []).length > 0 ? (
                                        <>
                                          <p className="mt-1 text-orange-800">Likely cause — overdue, not yet returned:</p>
                                          <ul className="mt-0.5 ml-4 list-disc">
                                            {(overdueByProduct[l.product_id] ?? []).map((o) => (
                                              <li key={o.id}>
                                                {o.qty} unit{o.qty === 1 ? '' : 's'} with {o.staff_name}, expected {formatDateOnly(o.expected_date)}
                                                {o.txn_ref ? ` (${o.txn_ref})` : ''}
                                              </li>
                                            ))}
                                          </ul>
                                        </>
                                      ) : (
                                        <p className="mt-1 text-orange-800">No overdue return of this product explains the shortfall — worth a stock check.</p>
                                      )}
                                    </div>
                                  )}
                                </li>
                              ))}
                            </ul>
                          )}
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                ))}
              </TableBody>
            </Table>
            </div>
          </Card>
        </TabsContent>

        <TabsContent value="low-stock" className="min-h-0">
          <Card className="h-full min-h-0 overflow-hidden rounded-xl border border-[#E2D8E9] bg-white py-0 shadow-sm ring-0">
            <div className="min-h-0 flex-1 overflow-y-auto">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-[#F0EBF5]">
                <TableRow className="border-b border-[#E0D5E7] hover:bg-[#F0EBF5]">
                  <SortableHead column={lowStockTable.getColumn('name')!} className="h-auto py-3.5 text-base font-bold text-[#2D203A]">Product</SortableHead>
                  <SortableHead column={lowStockTable.getColumn('quantity_on_hand')!} className="h-auto py-3.5 text-base font-bold text-[#2D203A]">Qty</SortableHead>
                  <SortableHead column={lowStockTable.getColumn('status')!} className="h-auto py-3.5 text-base font-bold text-[#2D203A]">Status</SortableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedLowItems.length === 0 && (
                  <TableRow><TableCell colSpan={3} className="text-center text-muted-foreground">All stock levels healthy ✓</TableCell></TableRow>
                )}
                {sortedLowItems.map((p) => (
                  <TableRow key={p.id} className="hover:bg-[#FAF7FC]">
                    <TableCell className="max-w-xs font-medium whitespace-normal break-words">{p.name}</TableCell>
                    <TableCell className={`font-bold ${p.quantity_on_hand === 0 ? 'text-red-600' : 'text-amber-600'}`}>
                      {p.quantity_on_hand}
                    </TableCell>
                    <TableCell>
                      <Badge className={p.quantity_on_hand === 0 ? 'bg-red-100 text-red-800 border-red-200/60 px-2.5 font-semibold' : 'bg-amber-100 text-amber-800 border-amber-200/60 px-2.5 font-semibold'}>
                        {LOW_STOCK_STATUS[p.status as LowStockStatus].label}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            </div>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Resolve confirmation. Writing off an outstanding line is append-only
          and has no undo in the UI, so it gets an explicit confirm step that
          spells out the two things that are easy to assume wrongly: stock is
          not put back, and the item stays visible on the Staff page. */}
      <Dialog open={resolving !== null} onOpenChange={(open) => { if (!open) { setResolving(null); setResolveReason('') } }}>
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle>Resolve outstanding item?</DialogTitle>
            <DialogDescription>
              {resolving && (
                <>
                  <strong className="text-foreground">{resolving.product_name}</strong> × {resolving.qty},
                  issued to {resolving.staff_name} on {resolving.txn_ref || 'an earlier transaction'}.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2 text-sm text-muted-foreground">
            <p>This records that the item does not need to come back. It will stop appearing here and on the Staff page&apos;s lending count — but it can still be returned normally from the Returns page later if it does turn up.</p>
            <p>Stock levels are <strong className="text-foreground">not</strong> changed — the item left the shelf when it was issued and isn&apos;t returning.</p>
            <p>It stays listed under the staff member on the Staff page, marked <em>Resolved</em>, so there&apos;s still a record of who kept it.</p>
            <p className="text-foreground">This can&apos;t be undone from the app.</p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="resolve-reason">Reason <span className="font-normal text-muted-foreground">(optional)</span></Label>
            <Textarea
              id="resolve-reason"
              rows={2}
              placeholder="e.g. Lost, damaged beyond repair, written off…"
              value={resolveReason}
              onChange={e => setResolveReason(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setResolving(null); setResolveReason('') }} disabled={resolveBusy}>Cancel</Button>
            <Button
              disabled={resolveBusy}
              onClick={async () => {
                if (!resolving) return
                setResolveBusy(true)
                try {
                  // The server fills in the product and staff names from the
                  // Stock Out itself and records the signed-in admin.
                  await createReturnWaiver({
                    transactionId: resolving.txn_id,
                    productId: resolving.product_id,
                    quantity: resolving.qty,
                    reason: resolveReason.trim() || null,
                  })
                  // Drop the row locally rather than refetching the whole
                  // dashboard — nothing else on this page depends on it,
                  // except the Incoming Pickups insufficiency explanation
                  // below, which also needs this write-off gone from its
                  // "likely cause" list (it's resolved, not coming back —
                  // still doesn't fix the shelf shortage, but shouldn't be
                  // shown as if it might).
                  setOutstanding(prev => prev.filter(o => o.id !== resolving.id))
                  setOverdueByProduct(prev => {
                    const forProduct = prev[resolving.product_id]
                    if (!forProduct) return prev
                    return { ...prev, [resolving.product_id]: forProduct.filter(o => o.id !== resolving.id) }
                  })
                  // The Sidebar's Dashboard badge fetches its own count
                  // separately and has no way to know this local patch
                  // just happened — nudge it to refetch (see alertsBus.ts).
                  notifyAlertsChanged()
                  // Full silent re-check, not just the local patches above —
                  // covers it if this ever affects Incoming Pickups'
                  // insufficiency math (it doesn't today, since a waiver
                  // never changes quantity_on_hand, but this keeps that from
                  // becoming a silent trap later).
                  getDashboardData({ silent: true })
                  toast.success(`${resolving.product_name} resolved — no return due.`)
                  setResolving(null)
                  setResolveReason('')
                } catch (err: any) {
                  toast.error('Could not resolve this item. ' + (err?.message ?? ''))
                } finally {
                  setResolveBusy(false)
                }
              }}
            >
              {resolveBusy ? 'Resolving…' : 'Resolve'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Cancel-pickup confirmation — same shape as Resolve above: an
          already-accepted request is a commitment Selouna made to a staff
          member, so cancelling it gets an explicit confirm step too,
          rather than firing straight off the row's Cancel button. */}
      <Dialog open={cancelling !== null} onOpenChange={(open) => { if (!open) { setCancelling(null); setCancelReason('') } }}>
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle>Cancel this pickup?</DialogTitle>
            <DialogDescription>
              {cancelling && (
                <>
                  <strong className="text-foreground">{cancelling.staff_name}</strong>&apos;s accepted pickup,{' '}
                  {cancelling.item_count} item{cancelling.item_count === 1 ? '' : 's'},{' '}
                  {formatLendWindow(cancelling.from_date, cancelling.to_date)}.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2 text-sm text-muted-foreground">
            <p>This withdraws the request — the reservation is released and those units become available for someone else to request or issue.</p>
            {pickupCancelledEmailOn ? (
              <p>
                The staff member will be emailed automatically to let them know, using the reason above if you add
                one — this follows the &quot;Approved pickup cancelled&quot; setting under Notifications.
              </p>
            ) : (
              <p>
                The staff member isn&apos;t notified automatically from here — let them know separately if
                they&apos;re expecting to collect it. (The &quot;Approved pickup cancelled&quot; email under
                Notifications is currently turned off.)
              </p>
            )}
            <p className="text-foreground">This can&apos;t be undone from the app.</p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="cancel-reason">Reason <span className="font-normal text-muted-foreground">(optional)</span></Label>
            <Textarea
              id="cancel-reason"
              rows={2}
              placeholder="e.g. No longer needed, staff member unavailable…"
              value={cancelReason}
              onChange={e => setCancelReason(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setCancelling(null); setCancelReason('') }} disabled={cancelBusy}>Close</Button>
            <Button disabled={cancelBusy} onClick={confirmCancelPickup}>
              {cancelBusy ? 'Cancelling…' : 'Cancel pickup'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

'use client'

import { Fragment, useEffect, useState } from 'react'
import { useExpandedRows } from '@/hooks/useExpandedRows'
import { formatDateOnly, formatLendWindow, sentenceCase, stockStatusLabel, todayDateStr } from '@/lib/utils'
import { db } from '@/lib/firebase/config'
import { collection, query, where, orderBy, getDocs, getCountFromServer } from 'firebase/firestore'
import { useTable, type SortingState } from '@tanstack/react-table'
import { SORTABLE_TABLE_FEATURES, sortableColumnHelper, SortableHead } from '@/components/data-table-helpers'
import { toast } from 'sonner'
import { expireIfNeeded, isNoShowCandidate, withdrawRequest, getReservedQuantity, effectiveToDate } from '@/lib/firebase/loanRequests'
import { notifyAlertsChanged } from '@/lib/alertsBus'
import { loadWaivedByTxn, waivedQty, createReturnWaiver } from '@/lib/firebase/waivers'
import { loadNotificationSettings } from '@/lib/firebase/notificationSettings'
import { useAuth } from '@/context/AuthContext'
import { useRole } from '@/context/RoleContext'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import { Card, CardContent } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import type { LoanRequest } from '@/types/database'

// Every row here is still outstanding — nothing has been returned yet — so
// the label needs to describe urgency going forward, not judge a completed
// action. "Early/On time/Late" (used in the Reports Returns tab, which
// describes an actual past return event) reads backwards here: it implies
// something already happened. This table only ever shows lines with a
// remaining balance, so there's no "Partial" case to consider the way there
// is on the Returns report (every row here already IS the outstanding portion).
function outstandingStatus(expectedDate: string | null): { label: string; className: string } {
  // An issue with no Lend To is a deliberate "no return date agreed", not
  // missing data, so it gets its own neutral label rather than an empty
  // cell — otherwise the row reads as broken.
  if (!expectedDate) return { label: 'No Return Date', className: 'bg-slate-100 text-slate-800 border-slate-200/60 px-2.5 font-semibold' }
  const today = todayDateStr()
  if (today > expectedDate) return { label: 'Overdue', className: 'bg-red-100 text-red-800 border-red-200/60 px-2.5 font-semibold' }
  if (today === expectedDate) return { label: 'Due Today', className: 'bg-amber-100 text-amber-800 border-amber-200/60 px-2.5 font-semibold' }
  return { label: 'Not Due Yet', className: 'bg-emerald-100 text-emerald-800 border-emerald-200/60 px-2.5 font-semibold' }
}

// Same urgency order as outstandingStatus() above returns its labels in —
// most pressing first — so sorting the Status column reads as "worst first"
// either direction, not an arbitrary A-Z order over the label text.
const OUTSTANDING_STATUS_RANK: Record<string, number> = {
  Overdue: 0, 'Due Today': 1, 'Not Due Yet': 2, 'No Return Date': 3,
}

const OUTSTANDING_RETURNS_COLUMNS = sortableColumnHelper.columns([
  sortableColumnHelper.accessor('product_name', { id: 'product_name', header: 'Product', sortFn: 'alphanumeric' }),
  sortableColumnHelper.accessor('staff_name', { id: 'staff_name', header: 'Staff', sortFn: 'alphanumeric' }),
  sortableColumnHelper.accessor('qty', { id: 'qty', header: 'Qty', sortFn: (a: any, b: any) => a.original.qty - b.original.qty }),
  sortableColumnHelper.accessor((o: any) => o.expected_date ?? '', { id: 'expected_date', header: 'Expected', sortFn: 'text' }),
  sortableColumnHelper.accessor((o: any) => outstandingStatus(o.expected_date).label, {
    id: 'status',
    header: 'Status',
    sortFn: (a: any, b: any) =>
      OUTSTANDING_STATUS_RANK[outstandingStatus(a.original.expected_date).label]
      - OUTSTANDING_STATUS_RANK[outstandingStatus(b.original.expected_date).label],
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
const LOW_STOCK_STATUS_RANK: Record<string, number> = { 'Out of stock': 0, 'Low stock': 1, 'In stock': 2 }

const LOW_STOCK_COLUMNS = sortableColumnHelper.columns([
  sortableColumnHelper.accessor('name', { id: 'name', header: 'Product', sortFn: 'alphanumeric' }),
  sortableColumnHelper.accessor('quantity_on_hand', { id: 'quantity_on_hand', header: 'Qty', sortFn: (a: any, b: any) => a.original.quantity_on_hand - b.original.quantity_on_hand }),
  sortableColumnHelper.accessor((p: any) => stockStatusLabel(p.quantity_on_hand, p.reorder_threshold), {
    id: 'status',
    header: 'Status',
    sortFn: (a: any, b: any) =>
      LOW_STOCK_STATUS_RANK[stockStatusLabel(a.original.quantity_on_hand, a.original.reorder_threshold)]
      - LOW_STOCK_STATUS_RANK[stockStatusLabel(b.original.quantity_on_hand, b.original.reorder_threshold)],
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
  const [outstanding, setOutstanding] = useState<any[]>([])
  const [lowItems, setLowItems] = useState<any[]>([])
  const [incomingPickups, setIncomingPickups] = useState<{ id: string; reference_no: string | null; staff_name: string; item_count: number; from_date: string; to_date: string | null; noShow: boolean; insufficient: boolean }[]>([])
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
  const [pickupLines, setPickupLines] = useState<Record<string, { id: string; product_id: string; product_name: string; offered_quantity: number; available: number; shortBy: number }[]>>({})
  // Outstanding-and-overdue return lines, grouped by product — the
  // candidate "likely cause" shown when an Incoming Pickup line comes up
  // short (see the insufficiency check below). Keyed by product_id so an
  // expanded pickup row can look its own products up directly.
  const [overdueByProduct, setOverdueByProduct] = useState<Record<string, { id: string; staff_name: string; qty: number; expected_date: string; txn_ref: string }[]>>({})
  const { isExpanded: isPickupExpanded, toggle: togglePickup } = useExpandedRows()
  const [loading, setLoading] = useState(true)
  // The row Selouna has clicked Resolve on, held while the confirmation
  // dialog is open. Resolving writes a return_waivers doc — see
  // lib/firebase/waivers.ts for why that's its own collection.
  const [resolving, setResolving] = useState<any | null>(null)
  const [resolveReason, setResolveReason] = useState('')
  const [resolveBusy, setResolveBusy] = useState(false)
  const [dashboardTab, setDashboardTab] = useState<DashboardTab>('outstanding-returns')
  const [outstandingSorting, setOutstandingSorting] = useState<SortingState>([])
  const [pickupsSorting, setPickupsSorting] = useState<SortingState>([])
  const [lowStockSorting, setLowStockSorting] = useState<SortingState>([])
  const { user, profile } = useAuth()
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
        const today = new Date()
        today.setHours(0, 0, 0, 0)

        const productsRef = collection(db, 'products')
        const transactionsRef = collection(db, 'transactions')
        const staffRef = collection(db, 'staff')

        // Fetch counts
        const totalProductsSnap = await getCountFromServer(query(productsRef))
        const totalStaffSnap = await getCountFromServer(query(staffRef, where('is_active', '==', true)))
        const todayTxnSnap = await getCountFromServer(query(transactionsRef, where('created_at', '>=', today.toISOString())))

        // Fetch products to calculate stock & low stock
        const productsSnap = await getDocs(query(productsRef))
        let totalStock = 0
        let lowStockCount = 0
        const items: any[] = []
        // Live quantity_on_hand per product, reused below by the Incoming
        // Pickups insufficiency check so it doesn't need its own fetch.
        const productsById: Record<string, { quantity_on_hand: number }> = {}

        productsSnap.forEach(doc => {
          const p = doc.data()
          productsById[doc.id] = { quantity_on_hand: p.quantity_on_hand || 0 }
          totalStock += (p.quantity_on_hand || 0)
          if (p.quantity_on_hand <= p.reorder_threshold) {
            lowStockCount++
            items.push({ id: doc.id, ...p })
          }
        })

        // Sort low items by qty ascending — every low-stock item is kept
        // (the card scrolls instead of truncating; see the badge-vs-row-count
        // note on Outstanding Returns above for why a hidden cap is a trap).
        items.sort((a, b) => a.quantity_on_hand - b.quantity_on_hand)
        const topLowItems = items

        // Outstanding returns: every OUT transaction line whose issued
        // quantity hasn't been fully returned yet — scoped per originating
        // OUT transaction via linked_txn_id, same correctly-scoped logic as
        // returns/page.tsx and the Reports Returns tab (a flat per-product
        // total here would incorrectly let a return against one loan cancel
        // out an unrelated later loan of the same product).
        const outSnap = await getDocs(query(transactionsRef, where('transaction_type', '==', 'OUT')))
        const returnSnap = await getDocs(query(transactionsRef, where('transaction_type', '==', 'RETURN')))
        const outTxns = outSnap.docs.map(d => ({ id: d.id, ...d.data() })) as any[]
        const returnTxns = returnSnap.docs.map(d => ({ id: d.id, ...d.data() })) as any[]

        const linesSnap = await getDocs(collection(db, 'transaction_lines'))
        const linesByTxn: Record<string, any[]> = {}
        linesSnap.forEach(d => {
          const l = d.data()
          ;(linesByTxn[l.transaction_id] ??= []).push(l)
        })

        const returnedByTxn: Record<string, Record<string, number>> = {}
        returnTxns.forEach(t => {
          if (!t.linked_txn_id) return
          const bucket = (returnedByTxn[t.linked_txn_id] ??= {})
          ;(linesByTxn[t.id] || []).forEach((l: any) => {
            bucket[l.product_id] = (bucket[l.product_id] ?? 0) + (l.quantity || 0)
          })
        })

        // Written-off lines (Selouna agreed the staff member keeps the
        // item) are subtracted alongside returns, so a resolved row leaves
        // this table for good without any RETURN transaction existing.
        const waivedByTxn = await loadWaivedByTxn()

        const outstandingList: any[] = []
        outTxns.forEach(t => {
          ;(linesByTxn[t.id] || []).forEach((l: any) => {
            const issued = l.quantity || 0
            const returned = returnedByTxn[t.id]?.[l.product_id] ?? 0
            const waived = waivedQty(waivedByTxn, t.id, l.product_id)
            const remaining = issued - returned - waived
            if (remaining <= 0) return
            outstandingList.push({
              id: `${t.id}_${l.product_id}`,
              txn_id: t.id,
              product_id: l.product_id,
              product_name: l.product_name ?? 'Unknown',
              staff_id: t.staff_id ?? null,
              staff_name: t.staff_name ?? '—',
              qty: remaining,
              expected_date: t.lend_to ?? null,
              txn_ref: t.reference_no ?? '',
            })
          })
        })
        // Most urgent first — overdue/soonest-due at the top, undated
        // (pre-Stage A) loans pushed to the end since there's nothing to sort them by.
        outstandingList.sort((a, b) => {
          if (!a.expected_date && !b.expected_date) return 0
          if (!a.expected_date) return 1
          if (!b.expected_date) return -1
          return a.expected_date.localeCompare(b.expected_date)
        })

        // Overdue outstanding returns, grouped by product — the candidate
        // "likely cause" an Incoming Pickup can point to when it comes up
        // short below. Deliberately OVERDUE only, not every outstanding
        // return: a return that isn't due yet is expected to still be out,
        // so it isn't a "problem" explaining a shortfall the same way an
        // overdue one is.
        const overdueByProduct: Record<string, { id: string; staff_name: string; qty: number; expected_date: string; txn_ref: string }[]> = {}
        outstandingList.forEach(o => {
          if (o.expected_date && todayDateStr() > o.expected_date) {
            (overdueByProduct[o.product_id] ??= []).push({
              id: o.id, staff_name: o.staff_name, qty: o.qty, expected_date: o.expected_date, txn_ref: o.txn_ref,
            })
          }
        })

        // Incoming Pickups — accepted requests only. Outstanding Loan
        // Requests (pending/countered) moved off the Dashboard entirely on
        // 2026-09-20 — that's the Loan Requests page's own job now, which
        // already lazily transitions those two statuses itself. Dashboard
        // only still needs to check accepted -> no_show (a pickup window
        // that's passed with nothing issued), so the fetch is scoped down
        // to accepted requests before doing that check, not all three.
        const loanReqSnap = await getDocs(collection(db, 'loan_requests'))
        let loanReqs = loanReqSnap.docs
          .map(d => ({ id: d.id, ...d.data() }) as LoanRequest)
          .filter(r => r.status === 'accepted')
        loanReqs = await Promise.all(loanReqs.map(async (r) => {
          const next = await expireIfNeeded(r)
          return next !== r.status ? { ...r, status: next } : r
        }))
        const loanReqLinesSnap = await getDocs(collection(db, 'loan_request_lines'))
        const lineCountByRequest: Record<string, number> = {}
        const linesByRequest: Record<string, { id: string; product_id: string; product_name: string; offered_quantity: number; available: number; shortBy: number }[]> = {}
        loanReqLinesSnap.forEach(d => {
          const l = d.data() as any
          const requestId = l.request_id as string
          lineCountByRequest[requestId] = (lineCountByRequest[requestId] ?? 0) + 1
          ;(linesByRequest[requestId] ??= []).push({
            id: d.id, product_id: l.product_id, product_name: l.product_name ?? 'Unknown', offered_quantity: l.offered_quantity ?? 0,
            // Filled in by the still-accepted check below — 0/0 here just
            // keeps the type happy for a request that turns out to have
            // expired/no-showed and never gets that check run on it.
            available: 0, shortBy: 0,
          })
        })

        // Does *current* stock still cover what each still-accepted
        // request was promised, once other active requests' holds on the
        // same product are netted out? An accepted request's offer was
        // only ever checked against live stock at approval time (see
        // assertStillAvailable) — if a same-product return that was due
        // back by now hasn't come in, the promise here can quietly fall
        // short of what's actually on the shelf, with nothing else in the
        // app catching it since no NEW action (a walk-in issue, a manual
        // qty edit) is what caused it. Reuses the exact same
        // getReservedQuantity the rest of the app validates availability
        // with, excluding each request's own hold on the product so it
        // isn't counted against itself.
        const stillAccepted = loanReqs.filter(r => r.status === 'accepted')
        await Promise.all(stillAccepted.map(async (r) => {
          const lines = linesByRequest[r.id] ?? []
          const uniqueProductIds = Array.from(new Set(lines.map(l => l.product_id)))
          const availableByProduct: Record<string, number> = {}
          await Promise.all(uniqueProductIds.map(async (pid) => {
            const onHand = productsById[pid]?.quantity_on_hand ?? 0
            const reserved = await getReservedQuantity(pid, r.from_date, effectiveToDate(r.to_date), r.id)
            availableByProduct[pid] = Math.max(0, onHand - reserved)
          }))
          lines.forEach((l) => {
            l.available = availableByProduct[l.product_id] ?? 0
            l.shortBy = Math.max(0, l.offered_quantity - l.available)
          })
        }))

        // Soonest pickup first. The `noShow` flag here is
        // belt-and-suspenders: the transition pass just above should
        // already have flipped any genuine no-show out of 'accepted'
        // entirely, so in practice this should rarely fire.
        const pickups = loanReqs
          .filter(r => r.status === 'accepted')
          .map(r => ({
            id: r.id, reference_no: r.reference_no ?? null,
            staff_name: r.staff_name, item_count: lineCountByRequest[r.id] ?? 0,
            from_date: r.from_date, to_date: r.to_date, noShow: isNoShowCandidate(r),
            insufficient: (linesByRequest[r.id] ?? []).some(l => l.shortBy > 0),
          }))
          .sort((a, b) => a.from_date.localeCompare(b.from_date))

        setStats({
          total_products: totalProductsSnap.data().count,
          total_stock: totalStock,
          low_stock: lowStockCount,
          today_transactions: todayTxnSnap.data().count,
          total_staff: totalStaffSnap.data().count
        })
        setOutstanding(outstandingList)
        setOverdueByProduct(overdueByProduct)
        setLowItems(topLowItems)
        setIncomingPickups(pickups)
        setPickupLines(linesByRequest)
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
    // External read (Firestore), not state derivable from props -- same
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
  // Resolve's own confirmation below. withdrawRequest() only reads
  // request.id/.status off what's passed in (see loanRequests.ts) — the
  // lean pickups row already carries both, so there's no need to keep the
  // full LoanRequest around just for this.
  async function confirmCancelPickup() {
    if (!cancelling) return
    setCancelBusy(true)
    try {
      await withdrawRequest(
        { id: cancelling.id, status: 'accepted' } as LoanRequest,
        { userId: user?.uid, userName: profile?.full_name ?? user?.email },
        cancelReason.trim() || null,
      )
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

      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {statCards.map(c => (
          <Card key={c.label} className="rounded-xl border border-[#E2D8E9] bg-white shadow-sm transition-shadow hover:shadow-md">
            <CardContent>
              <div className={`text-3xl font-extrabold ${c.className}`}>{c.value}</div>
              <div className="mt-1 text-sm font-semibold text-muted-foreground">{c.label}</div>
            </CardContent>
          </Card>
        ))}
      </div>

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
        <TabsList className="mb-4 flex w-full !h-14 gap-1.5 overflow-hidden rounded-2xl border border-purple-200/50 bg-white/60 p-1.5 backdrop-blur-sm">
          <TabsTrigger
            value="outstanding-returns"
            className="!h-11 flex-1 cursor-pointer self-center rounded-xl px-4 text-sm font-semibold whitespace-nowrap text-(--nwu-grey-dark) transition-all not-data-active:hover:bg-white/70 not-data-active:hover:text-foreground data-active:bg-(--nwu-purple) data-active:text-white data-active:shadow-md"
          >
            Outstanding Returns
            {outstanding.length > 0 && (
              <Badge className="bg-(--nwu-turquoise) text-white">{outstanding.length}</Badge>
            )}
          </TabsTrigger>
          <TabsTrigger
            value="incoming-pickups"
            className="!h-11 flex-1 cursor-pointer self-center rounded-xl px-4 text-sm font-semibold whitespace-nowrap text-(--nwu-grey-dark) transition-all not-data-active:hover:bg-white/70 not-data-active:hover:text-foreground data-active:bg-(--nwu-purple) data-active:text-white data-active:shadow-md"
          >
            Incoming Pickups
            {incomingPickups.length > 0 && (
              <Badge className="bg-(--nwu-turquoise) text-white">{incomingPickups.length}</Badge>
            )}
          </TabsTrigger>
          <TabsTrigger
            value="low-stock"
            className="!h-11 flex-1 cursor-pointer self-center rounded-xl px-4 text-sm font-semibold whitespace-nowrap text-(--nwu-grey-dark) transition-all not-data-active:hover:bg-white/70 not-data-active:hover:text-foreground data-active:bg-(--nwu-purple) data-active:text-white data-active:shadow-md"
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
                  const status = outstandingStatus(o.expected_date)
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
                        {stockStatusLabel(p.quantity_on_hand, p.reorder_threshold)}
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
                  await createReturnWaiver({
                    transactionId: resolving.txn_id,
                    productId: resolving.product_id,
                    productName: resolving.product_name,
                    staffId: resolving.staff_id ?? null,
                    staffName: resolving.staff_name === '\u2014' ? null : resolving.staff_name,
                    quantity: resolving.qty,
                    reason: resolveReason.trim() || null,
                    actorUid: user?.uid,
                    actorName: profile?.full_name ?? user?.email,
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

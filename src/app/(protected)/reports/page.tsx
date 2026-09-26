'use client'

import { Fragment, useEffect, useState, type ReactNode } from 'react'
import { useExpandedRows } from '@/hooks/useExpandedRows'
import { formatDate, formatDateOnly, isoToLocalDateStr, withinDateRange } from '@/lib/utils'
import { db } from '@/lib/firebase/config'
import { loadWaivedByTxn, waivedQty } from '@/lib/firebase/waivers'
import { collection, query, where, getDocs, orderBy, doc, getDoc } from 'firebase/firestore'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'

type ReportTab = 'stock-levels' | 'low-stock' | 'issued-per-staff' | 'returns'

const TABS: { id: ReportTab; label: string }[] = [
  { id: 'stock-levels',        label: 'Current Stock Levels' },
  { id: 'low-stock',           label: 'Low Stock Items' },
  { id: 'issued-per-staff',    label: 'Issued per Staff' },
  { id: 'returns',             label: 'Returns' },
]

const ALL_CATEGORIES = '__all__'

// Labelled date pair, matching the Audit Log's filter row. A date input
// ignores `placeholder`, so without these labels the browser's own dd/mm/yyyy
// hint is all there is to say what each control does. htmlFor/id so clicking a
// label focuses its input; `idPrefix` keeps those ids unique, since two tabs
// each render a pair. `children` is the report's own summary line, sharing the
// row's items-end alignment.
//
// The labels are overridable because the two ends do not always bound the same
// field: Returns brackets one date (when the return was made), while Issued per
// Staff bounds two different ones (issued from / expected back by). Where that
// is so, the labels are the only thing telling Selouna which is which, so they
// say the field rather than just the end of a range.
function DateRangeFilter({
  idPrefix, fromDate, toDate, onFromChange, onToChange, children,
  fromLabel = 'From date', toLabel = 'To date',
}: {
  idPrefix: string
  fromDate: string
  toDate: string
  onFromChange: (v: string) => void
  onToChange: (v: string) => void
  children?: ReactNode
  fromLabel?: string
  toLabel?: string
}) {
  return (
    <div className="mb-4 flex flex-wrap items-end gap-3">
      <div className="grid gap-1.5">
        <label htmlFor={`${idPrefix}-from-date`} className="text-xs font-medium text-muted-foreground">
          {fromLabel}
        </label>
        <Input id={`${idPrefix}-from-date`} type="date" className="w-40"
          value={fromDate} onChange={e => onFromChange(e.target.value)} />
      </div>
      <div className="grid gap-1.5">
        <label htmlFor={`${idPrefix}-to-date`} className="text-xs font-medium text-muted-foreground">
          {toLabel}
        </label>
        <Input id={`${idPrefix}-to-date`} type="date" className="w-40"
          value={toDate} onChange={e => onToChange(e.target.value)} />
      </div>
      {(fromDate || toDate) && (
        <Button variant="ghost" onClick={() => { onFromChange(''); onToChange('') }}>Clear dates</Button>
      )}
      {children}
    </div>
  )
}

const STATUS_BADGE_CLASS: Record<string, string> = {
  'OUT OF STOCK': 'bg-red-100 text-red-800',
  'LOW STOCK': 'bg-amber-100 text-amber-800',
  'IN STOCK': 'bg-emerald-100 text-emerald-800',
}

export default function ReportsPage() {
  const [tab, setTab] = useState<ReportTab>('stock-levels')

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-foreground">Reports</h1>
        <p className="mt-1 text-sm text-muted-foreground">NWU IT Store · Potchefstroom</p>
      </div>

      <Tabs value={tab} onValueChange={v => setTab(v as ReportTab)} className="min-h-0 flex-1">
        <TabsList variant="line" className="mb-6 w-full justify-start overflow-x-auto overflow-y-hidden border-b">
          {TABS.map(t => (
            <TabsTrigger key={t.id} value={t.id} className="whitespace-nowrap">{t.label}</TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="stock-levels" className="min-h-0"><StockLevelsReport /></TabsContent>
        <TabsContent value="low-stock" className="min-h-0"><LowStockReport /></TabsContent>
        <TabsContent value="issued-per-staff" className="min-h-0"><IssuedPerStaffReport /></TabsContent>
        <TabsContent value="returns" className="min-h-0"><ReturnsReport /></TabsContent>
      </Tabs>
    </div>
  )
}

function StockLevelsReport() {
  const [data, setData] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [catFilter, setCatFilter] = useState('')
  const [cats, setCats] = useState<any[]>([])

  useEffect(() => {
    getDocs(query(collection(db, 'categories'), orderBy('name'))).then(snap => {
      setCats(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    })
  }, [])

  useEffect(() => {
    setLoading(true)
    let q = query(collection(db, 'products'))
    if (catFilter) q = query(collection(db, 'products'), where('category_id', '==', catFilter))

    getDocs(q).then(snap => {
      let items = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      items.sort((a: any, b: any) => (a.name || '').localeCompare(b.name || ''))
      setData(items)
      setLoading(false)
    })
  }, [catFilter])

  const totalUnits = data.reduce((s, p) => s + (p.quantity_on_hand || 0), 0)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-4 flex items-center gap-3">
        <Select
          items={{ [ALL_CATEGORIES]: 'All categories', ...Object.fromEntries(cats.map((c: any) => [c.id, c.name])) }}
          value={catFilter || ALL_CATEGORIES}
          onValueChange={v => setCatFilter(v && v !== ALL_CATEGORIES ? v : '')}
        >
          <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_CATEGORIES}>All categories</SelectItem>
            {cats.map((c: any) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <span className="text-sm text-muted-foreground">{data.length} products · {totalUnits} total units</span>
      </div>
      <Card className="min-h-0 flex-1 py-0">
        <div className="min-h-0 flex-1 overflow-y-auto">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-card">
            <TableRow>
              <TableHead>Product</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Qty On Hand</TableHead>
              <TableHead>Threshold</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && <TableRow><TableCell colSpan={5} className="py-8 text-center text-muted-foreground">Loading…</TableCell></TableRow>}
            {data.map((p: any) => {
              const qty = p.quantity_on_hand || 0
              const threshold = p.reorder_threshold || 0
              const status = qty === 0 ? 'OUT OF STOCK' : qty <= threshold ? 'LOW STOCK' : 'IN STOCK'
              return (
                <TableRow key={p.id}>
                  <TableCell className="font-medium">{p.name}</TableCell>
                  <TableCell className="text-muted-foreground">{p.category_name ?? '—'}</TableCell>
                  <TableCell className="font-semibold">{qty}</TableCell>
                  <TableCell className="text-muted-foreground">{threshold}</TableCell>
                  <TableCell><Badge className={STATUS_BADGE_CLASS[status]}>{status}</Badge></TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
        </div>
      </Card>
    </div>
  )
}

function LowStockReport() {
  const [data, setData] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getDocs(query(collection(db, 'products'))).then(snap => {
      let items = snap.docs.map(d => ({ id: d.id, ...d.data() })) as any[]
      items = items.filter(p => p.quantity_on_hand <= p.reorder_threshold)
      items.sort((a, b) => a.quantity_on_hand - b.quantity_on_hand)
      setData(items)
      setLoading(false)
    })
  }, [])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-4">
        {!loading && (
          <div className={`text-sm font-semibold ${data.length > 0 ? 'text-amber-600' : 'text-emerald-600'}`}>
            {data.length === 0 ? '✓ All stock levels are healthy' : `${data.length} item${data.length !== 1 ? 's' : ''} at or below reorder threshold`}
          </div>
        )}
      </div>
      <Card className="min-h-0 flex-1 py-0">
        <div className="min-h-0 flex-1 overflow-y-auto">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-card">
            <TableRow>
              <TableHead>Product</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Qty On Hand</TableHead>
              <TableHead>Threshold</TableHead>
              <TableHead>Shortage</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && <TableRow><TableCell colSpan={5} className="py-8 text-center text-muted-foreground">Loading…</TableCell></TableRow>}
            {!loading && data.length === 0 && <TableRow><TableCell colSpan={5} className="py-8 text-center text-muted-foreground">No low stock items</TableCell></TableRow>}
            {data.map((p: any) => {
              const qty = p.quantity_on_hand
              const threshold = p.reorder_threshold
              return (
                <TableRow key={p.id}>
                  <TableCell className="font-medium">{p.name}</TableCell>
                  <TableCell className="text-muted-foreground">{p.category_name ?? '—'}</TableCell>
                  <TableCell className={`font-semibold ${qty === 0 ? 'text-red-600' : 'text-amber-600'}`}>{qty}</TableCell>
                  <TableCell>{threshold}</TableCell>
                  <TableCell className="font-semibold text-red-600">-{threshold - qty}</TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
        </div>
      </Card>
    </div>
  )
}

// The two ends of this report's filter bound DIFFERENT fields, so they are two
// tests rather than one range: "issued from <date>" opens the window on when
// the item left the store, "expected by <date>" closes it on when it is due
// back. Together they answer "what went out since X that should be back by Y".
//
// Issued-from goes through withinDateRange because created_at is a full UTC ISO
// timestamp that has to be read as a local calendar day. Expected-by must NOT:
// lend_to is already a plain YYYY-MM-DD date-only string, straight off an
// <input type="date">, so it compares directly against the filter value. Putting
// it through new Date() would reintroduce exactly the timezone shift that
// withinDateRange exists to remove.
function issuedFrom(t: any, from: string): boolean {
  return withinDateRange(t.created_at, from, '')
}

// A Stock Out with no expected date is never excluded here, whatever the
// expected-by value. Filtering it out would quietly drop the loosest records in
// the store — items lent with no return date agreed — from the report, and an
// audit wants those visible, not missing.
function expectedBy(t: any, to: string): boolean {
  if (!to) return true
  if (!t.lend_to) return true
  return t.lend_to <= to
}

function IssuedPerStaffReport() {
  const [data, setData] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const { isExpanded: rowExpanded, toggle: toggleRow } = useExpandedRows()
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')

  useEffect(() => {
    async function load() {
      // 1. fetch staff
      const staffSnap = await getDocs(query(collection(db, 'staff'), where('is_active', '==', true), orderBy('full_name')))
      const staffData = staffSnap.docs.map(d => ({ id: d.id, ...d.data(), txns: [] as any[] }))

      // 2. fetch all OUT transactions (if not too many, otherwise we fetch per staff - for now let's just fetch all OUT txns to get counts)
      const txnSnap = await getDocs(query(collection(db, 'transactions'), where('transaction_type', '==', 'OUT')))
      const allTxns = txnSnap.docs.map(d => ({ id: d.id, ...d.data() })) as any[]

      // transaction_lines is its own collection now — fetch once and
      // re-attach as `.transaction_lines` so the rendering code below
      // doesn't need to change.
      const linesSnap = await getDocs(collection(db, 'transaction_lines'))
      const linesByTxn: Record<string, any[]> = {}
      linesSnap.forEach(d => {
        const l = d.data()
        ;(linesByTxn[l.transaction_id] ??= []).push(l)
      })
      allTxns.forEach(t => { t.transaction_lines = linesByTxn[t.id] ?? [] })

      // Map txns to staff
      staffData.forEach(s => {
        s.txns = allTxns.filter(t => t.staff_id === s.id)
      })

      setData(staffData)
      setLoading(false)
    }
    load()
  }, [])

  // Each staff member with their OUT transactions narrowed to the selected
  // dates, newest first, and the totals recomputed over what survives — so the
  // counts on a row always describe the rows underneath it. Derived on render
  // rather than cached when a row expands: the whole set is already in memory
  // (load() fetches it up front), and a cache keyed only by staff id would keep
  // serving the previous range's transactions after the dates change.
  const staff = data
    .map((s: any) => {
      const txns = s.txns
        .filter((t: any) => issuedFrom(t, fromDate) && expectedBy(t, toDate))
        .sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      const totalQty = txns.reduce((sum: number, t: any) =>
        sum + (t.transaction_lines || []).reduce((s2: number, l: any) => s2 + (l.quantity || 0), 0), 0)
      return { ...s, txns, totalQty }
    })
    // With either date set the question is who took stock out, so a staff member
    // with nothing matching is noise. Unfiltered, the report stays what it was:
    // a roster of every active staff member, zeroes included.
    .filter((s: any) => (!fromDate && !toDate) || s.txns.length > 0)

  const rangeTxns = staff.reduce((n: number, s: any) => n + s.txns.length, 0)
  const rangeItems = staff.reduce((n: number, s: any) => n + s.totalQty, 0)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <DateRangeFilter
        idPrefix="issued"
        fromLabel="Issued from"
        toLabel="Expected back by"
        fromDate={fromDate}
        toDate={toDate}
        onFromChange={setFromDate}
        onToChange={setToDate}
      >
        <span className="text-sm text-muted-foreground">
          {staff.length} staff · {rangeTxns} transactions · {rangeItems} items
        </span>
      </DateRangeFilter>
      <Card className="min-h-0 flex-1 py-0">
      <div className="min-h-0 flex-1 overflow-y-auto">
      <Table>
        <TableHeader className="sticky top-0 z-10 bg-card">
          <TableRow>
            <TableHead>Staff Member</TableHead>
            <TableHead>Department</TableHead>
            <TableHead>Total OUT Transactions</TableHead>
            <TableHead>Total Items Issued</TableHead>
            <TableHead></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading && <TableRow><TableCell colSpan={5} className="py-8 text-center text-muted-foreground">Loading…</TableCell></TableRow>}
          {!loading && staff.length === 0 && (
            <TableRow><TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
              {fromDate || toDate ? 'No transactions match the selected dates' : 'No active staff members'}
            </TableCell></TableRow>
          )}
          {staff.map((s: any) => {
            const txns = s.txns
            return (
              <Fragment key={s.id}>
                <TableRow className="cursor-pointer" onClick={() => toggleRow(s.id)}>
                  <TableCell className="font-medium">{s.full_name}</TableCell>
                  <TableCell className="text-muted-foreground">{s.department ?? '—'}</TableCell>
                  <TableCell className="font-semibold">{txns.length}</TableCell>
                  <TableCell className="font-semibold">{s.totalQty}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{rowExpanded(s.id) ? '▲' : '▼'}</TableCell>
                </TableRow>
                {rowExpanded(s.id) && (
                  txns.flatMap((t: any) => {
                    // One row per line item on the transaction (not one row
                    // per transaction with every item mashed into a single
                    // comma-joined cell) — a multi-item Stock Out needs each
                    // product and its own quantity to be its own line here.
                    //
                    // Each cell sits under the parent column it belongs to —
                    // product under Total OUT Transactions, quantity under
                    // Total Items Issued — so a staff member's totals read as
                    // the sum of the lines beneath them rather than as two
                    // numbers with unaligned prose underneath. No colSpan, for
                    // the same reason. Reference and issue date repeat on every
                    // line of a multi-item transaction, matching the one-row-
                    // per-product-line shape the CSV export will take.
                    const tLines = t.transaction_lines || []
                    const rows = tLines.length > 0 ? tLines : [null]
                    return rows.map((l: any, idx: number) => (
                      <TableRow key={`${t.id}_${idx}`} className="bg-muted/50">
                        <TableCell className="pl-8 font-mono text-xs text-muted-foreground">
                          {t.reference_no}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          Issued at {formatDate(t.created_at)}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {l ? (l.product_name ?? '?') : 'No items recorded'}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {l ? l.quantity : '—'}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {t.lend_to ? <>Expected {formatDateOnly(t.lend_to)}</> : '—'}
                        </TableCell>
                      </TableRow>
                    ))
                  })
                )}
              </Fragment>
            )
          })}
        </TableBody>
      </Table>
      </div>
      </Card>
    </div>
  )
}

// Mirrors lineStatus() in returns/page.tsx, adapted for a completed return
// record rather than a still-outstanding line: Partial takes priority (the
// originating Stock Out still has a balance owed, possibly settled across
// more than one return visit), otherwise Early/On time/Late compares the
// date this return was actually made against the originating Lend To date
// — a historical judgement, not a live "today" one.
function returnRowStatus(t: any): { label: string; className: string } | null {
  if (t.partial) return { label: 'Partial', className: 'bg-amber-100 text-amber-800' }
  if (!t.expected_date) return null
  const returnedOn = t.created_at ? isoToLocalDateStr(t.created_at) : ''
  if (returnedOn < t.expected_date) return { label: 'Early', className: 'bg-emerald-100 text-emerald-800' }
  if (returnedOn === t.expected_date) return { label: 'On time', className: 'bg-sky-100 text-sky-800' }
  return { label: 'Late', className: 'bg-red-100 text-red-800' }
}

// Both ends bound t.expected_date — the lend_to copied off the Stock Out this
// return settles. That is already a plain YYYY-MM-DD string, so it compares
// directly and must NOT go through withinDateRange(), which is for reading a
// UTC ISO timestamp as a local day.
//
// A return whose expected date is unknown — its Stock Out set no return date,
// or it is not linked to one at all — has nothing for either end to test. With
// both ends on this one field there is no other bound left, so such a row would
// otherwise appear under every window Selouna picks. Dropping it silently is
// worse: those are the loosest records in the store and are exactly what an
// audit is looking for. So the choice is hers, made in the filter row rather
// than decided here; `includeUndated` carries it. Defaults to including them.
function expectedInRange(t: any, from: string, to: string, includeUndated: boolean): boolean {
  if (!from && !to) return true
  if (!t.expected_date) return includeUndated
  if (from && t.expected_date < from) return false
  if (to && t.expected_date > to) return false
  return true
}

function ReturnsReport() {
  const [data, setData] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const { isExpanded: rowExpanded, toggle: toggleRow } = useExpandedRows()
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [includeUndated, setIncludeUndated] = useState(true)

  useEffect(() => {
    async function load() {
      const snap = await getDocs(query(collection(db, 'transactions'), where('transaction_type', '==', 'RETURN'), orderBy('created_at', 'desc')))
      const txns = snap.docs.map(d => ({ id: d.id, ...d.data() })) as any[]

      // transaction_lines is its own collection now — fetch once and
      // re-attach as `.transaction_lines` for the render code below. This
      // pulls in every line for every transaction (not just RETURNs), which
      // is used again below to look up the originating OUT transaction's
      // issued quantities.
      const linesSnap = await getDocs(collection(db, 'transaction_lines'))
      const linesByTxn: Record<string, any[]> = {}
      linesSnap.forEach(d => {
        const l = d.data()
        ;(linesByTxn[l.transaction_id] ??= []).push(l)
      })
      txns.forEach(t => { t.transaction_lines = linesByTxn[t.id] ?? [] })

      // Total returned so far per [linked OUT transaction][product] — summed
      // across every RETURN on record, since a loan can be settled across
      // more than one return visit (see the same logic in returns/page.tsx).
      const returnedByOutTxn: Record<string, Record<string, number>> = {}
      txns.forEach(t => {
        if (!t.linked_txn_id) return
        const bucket = (returnedByOutTxn[t.linked_txn_id] ??= {})
        ;(t.transaction_lines || []).forEach((l: any) => {
          bucket[l.product_id] = (bucket[l.product_id] ?? 0) + (l.quantity || 0)
        })
      })

      // Fetch each distinct linked OUT transaction once, for its Lend To
      // date and originally-issued quantities.
      // Written-off lines are no longer outstanding, so a Partial row must
      // not keep claiming a balance Selouna has already resolved away.
      const waivedByTxn = await loadWaivedByTxn()
      const linkedIds = Array.from(new Set(txns.map(t => t.linked_txn_id).filter(Boolean))) as string[]
      const outTxnById: Record<string, any> = {}
      await Promise.all(linkedIds.map(async (id) => {
        const outSnap = await getDoc(doc(db, 'transactions', id))
        if (outSnap.exists()) outTxnById[id] = { id: outSnap.id, ...outSnap.data() }
      }))

      txns.forEach(t => {
        const outTxn = t.linked_txn_id ? outTxnById[t.linked_txn_id] : null
        // The raw Firestore doc ID (t.linked_txn_id) means nothing to
        // Selouna — she only ever sees the human reference number
        // (TXN-XXXXXXXX) elsewhere in the app (Stock Out, the Returns page
        // itself, the Audit Log). Surface that instead so she can actually
        // match this return back to the Stock Out it settles.
        t.linked_txn_ref = outTxn?.reference_no ?? null
        t.expected_date = outTxn?.lend_to ?? null
        const outLines = outTxn ? (linesByTxn[outTxn.id] || []) : []
        // Per-product remaining balance on the linked OUT transaction — used
        // to show Selouna exactly what's still owed when she expands a
        // Partial row, not just the fact that something is.
        t.outstandingLines = outTxn
          ? outLines
              .map((l: any) => {
                const issued = l.quantity || 0
                const returned = returnedByOutTxn[outTxn.id]?.[l.product_id] ?? 0
                const waived = waivedQty(waivedByTxn, outTxn.id, l.product_id)
                return { product_name: l.product_name ?? 'Unknown', outstanding: issued - returned - waived }
              })
              .filter((l: any) => l.outstanding > 0)
          : []
        t.partial = t.outstandingLines.length > 0
      })

      setData(txns)
      setLoading(false)
    }
    load()
  }, [])

  // A true range this time, both ends on ONE field: the date the item was due
  // back. "Expected from 21 Sep, Expected to 26 Sep" is everything that was
  // supposed to be returned in that week, whenever it actually came back —
  // which is the question worth asking of a returns report, since the answer
  // includes the things that came back late.
  //
  // It deliberately does not narrow the outstanding-balance maths above: what
  // is still owed on a Stock Out is a live figure across every return on
  // record, so a Partial row keeps telling the truth even when the return that
  // settled the rest of it falls outside the selected window.
  const returns = data.filter((t: any) => expectedInRange(t, fromDate, toDate, includeUndated))
  // Counted over the whole set, not the filtered one: this is the size of the
  // decision the checkbox offers, so it has to stay steady as the dates move.
  const undatedCount = data.filter((t: any) => !t.expected_date).length

  return (
    <div className="flex h-full min-h-0 flex-col">
      <DateRangeFilter
        idPrefix="returns"
        fromLabel="Expected from"
        toLabel="Expected to"
        fromDate={fromDate}
        toDate={toDate}
        onFromChange={setFromDate}
        onToChange={setToDate}
      >
        {/* Only worth showing once a range is set — with no dates the rows are
            all in view anyway — and only when there is at least one such row to
            decide about. */}
        {(fromDate || toDate) && undatedCount > 0 && (
          <div className="grid gap-1">
            <Label htmlFor="returns-include-undated" className="text-xs">
              <input
                id="returns-include-undated"
                type="checkbox"
                className="size-3.5 accent-primary"
                checked={includeUndated}
                onChange={e => setIncludeUndated(e.target.checked)}
              />
              Include {undatedCount} with no expected date
            </Label>
            <span className="text-xs text-muted-foreground">
              No due date to place them in a range, so they show under every window
            </span>
          </div>
        )}
        <span className="text-sm text-muted-foreground">
          {returns.length} {returns.length === 1 ? 'return' : 'returns'}
          {(fromDate || toDate) && <> · by date expected back</>}
        </span>
      </DateRangeFilter>
      <Card className="min-h-0 flex-1 py-0">
      <div className="min-h-0 flex-1 overflow-y-auto">
      <Table>
        <TableHeader className="sticky top-0 z-10 bg-card">
          <TableRow>
            <TableHead>Reference</TableHead>
            <TableHead>Staff</TableHead>
            <TableHead>Items Returned</TableHead>
            <TableHead>Returning For</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Expected</TableHead>
            <TableHead>Date Returned</TableHead>
            <TableHead></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading && <TableRow><TableCell colSpan={8} className="py-8 text-center text-muted-foreground">Loading…</TableCell></TableRow>}
          {!loading && returns.length === 0 && (
            <TableRow><TableCell colSpan={8} className="py-8 text-center text-muted-foreground">
              {fromDate || toDate ? 'No returns were expected in the selected date range' : 'No returns recorded yet'}
            </TableCell></TableRow>
          )}
          {returns.map((t: any) => {
            const tLines = t.transaction_lines || []
            const status = returnRowStatus(t)
            const isExpanded = rowExpanded(t.id)
            return (
              <Fragment key={t.id}>
                <TableRow
                  className={t.partial ? 'cursor-pointer' : ''}
                  onClick={() => t.partial && toggleRow(t.id)}
                >
                  <TableCell className="font-mono text-xs">{t.reference_no}</TableCell>
                  <TableCell className="font-medium">{t.staff_name ?? '—'}</TableCell>
                  <TableCell className="text-sm">
                    {tLines.map((l: any) => `${l.product_name ?? '?'} ×${l.quantity}`).join(', ')}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {t.linked_txn_ref ?? '—'}
                  </TableCell>
                  <TableCell>{status && <Badge className={`${status.className} uppercase`}>{status.label}</Badge>}</TableCell>
                  <TableCell className="text-muted-foreground">{formatDateOnly(t.expected_date)}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{formatDate(t.created_at)}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {t.partial && (isExpanded ? '▲' : '▼')}
                  </TableCell>
                </TableRow>
                {isExpanded && t.partial && (
                  <TableRow className="bg-muted/50">
                    <TableCell colSpan={8} className="p-4">
                      <div className="text-sm">
                        <span className="font-medium text-foreground">Still outstanding on {t.linked_txn_ref ?? 'the original Stock Out'}:</span>
                        <ul className="mt-1 ml-4 list-disc">
                          {t.outstandingLines.map((l: any, i: number) => (
                            <li key={i}>
                              {l.product_name} <span className="text-muted-foreground">× {l.outstanding}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            )
          })}
        </TableBody>
      </Table>
      </div>
      </Card>
    </div>
  )
}

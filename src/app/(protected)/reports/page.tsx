'use client'

import { useEffect, useState } from 'react'
import { formatDate } from '@/lib/utils'
import { db } from '@/lib/firebase/config'
import { collection, query, where, getDocs, orderBy, limit } from 'firebase/firestore'
import { Card } from '@/components/ui/card'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'

type ReportTab = 'stock-levels' | 'low-stock' | 'issued-per-staff' | 'returns' | 'transaction-history'

const TABS: { id: ReportTab; label: string }[] = [
  { id: 'stock-levels',        label: 'Current Stock Levels' },
  { id: 'low-stock',           label: 'Low Stock Items' },
  { id: 'issued-per-staff',    label: 'Issued per Staff' },
  { id: 'returns',             label: 'Returns' },
  { id: 'transaction-history', label: 'Transaction History' },
]

const ALL_CATEGORIES = '__all__'
const ALL_TYPES = '__all__'

const STATUS_BADGE_CLASS: Record<string, string> = {
  'OUT OF STOCK': 'bg-red-100 text-red-800',
  'LOW STOCK': 'bg-amber-100 text-amber-800',
  'IN STOCK': 'bg-emerald-100 text-emerald-800',
}

const TXN_BADGE_CLASS: Record<string, string> = {
  IN: 'bg-emerald-100 text-emerald-800',
  OUT: 'bg-accent text-accent-foreground',
  RETURN: 'bg-sky-100 text-sky-800',
  ADJUST: 'bg-amber-100 text-amber-800',
}

export default function ReportsPage() {
  const [tab, setTab] = useState<ReportTab>('stock-levels')

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-foreground">Reports</h1>
        <p className="mt-1 text-sm text-muted-foreground">NWU IT Store · Potchefstroom</p>
      </div>

      <Tabs value={tab} onValueChange={v => setTab(v as ReportTab)}>
        <TabsList variant="line" className="mb-6 w-full justify-start overflow-x-auto border-b">
          {TABS.map(t => (
            <TabsTrigger key={t.id} value={t.id} className="whitespace-nowrap">{t.label}</TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="stock-levels"><StockLevelsReport /></TabsContent>
        <TabsContent value="low-stock"><LowStockReport /></TabsContent>
        <TabsContent value="issued-per-staff"><IssuedPerStaffReport /></TabsContent>
        <TabsContent value="returns"><ReturnsReport /></TabsContent>
        <TabsContent value="transaction-history"><TransactionHistoryReport /></TabsContent>
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
    <div>
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
      <Card className="py-0">
        <Table>
          <TableHeader>
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
    <div>
      <div className="mb-4">
        {!loading && (
          <div className={`text-sm font-semibold ${data.length > 0 ? 'text-amber-600' : 'text-emerald-600'}`}>
            {data.length === 0 ? '✓ All stock levels are healthy' : `${data.length} item${data.length !== 1 ? 's' : ''} at or below reorder threshold`}
          </div>
        )}
      </div>
      <Card className="py-0">
        <Table>
          <TableHeader>
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
      </Card>
    </div>
  )
}

function IssuedPerStaffReport() {
  const [data, setData] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [lines, setLines] = useState<Record<string, any[]>>({})

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

  async function toggleExpand(staffId: string) {
    if (expanded === staffId) { setExpanded(null); return }
    setExpanded(staffId)
    // we already fetched the txns and they are embedded in 'data' under 's.txns', we just need to group and show them
    if (lines[staffId]) return
    const staffMember = data.find(s => s.id === staffId)
    if (staffMember) {
      const sortedTxns = [...staffMember.txns].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      setLines(prev => ({ ...prev, [staffId]: sortedTxns }))
    }
  }

  return (
    <Card className="py-0">
      <Table>
        <TableHeader>
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
          {data.map((s: any) => {
            const txns = s.txns
            const totalQty = txns.reduce((sum: number, t: any) => {
              const tLines = t.transaction_lines || []
              return sum + tLines.reduce((s2: number, l: any) => s2 + (l.quantity || 0), 0)
            }, 0)
            return (
              <>
                <TableRow key={s.id} className="cursor-pointer" onClick={() => toggleExpand(s.id)}>
                  <TableCell className="font-medium">{s.full_name}</TableCell>
                  <TableCell className="text-muted-foreground">{s.department ?? '—'}</TableCell>
                  <TableCell className="font-semibold">{txns.length}</TableCell>
                  <TableCell className="font-semibold">{totalQty}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{expanded === s.id ? '▲' : '▼'}</TableCell>
                </TableRow>
                {expanded === s.id && lines[s.id] && (
                  lines[s.id].map((t: any) => (
                    <TableRow key={t.id} className="bg-muted/50">
                      <TableCell colSpan={2} className="pl-8 font-mono text-xs text-muted-foreground">
                        {t.reference_no} · {formatDate(t.created_at)}
                      </TableCell>
                      <TableCell colSpan={3} className="text-xs text-muted-foreground">
                        {(t.transaction_lines || []).map((l: any) => `${l.product_name ?? '?'} ×${l.quantity}`).join(', ')}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </>
            )
          })}
        </TableBody>
      </Table>
    </Card>
  )
}

function ReturnsReport() {
  const [data, setData] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      const snap = await getDocs(query(collection(db, 'transactions'), where('transaction_type', '==', 'RETURN'), orderBy('created_at', 'desc')))
      const txns = snap.docs.map(d => ({ id: d.id, ...d.data() })) as any[]

      // transaction_lines is its own collection now — fetch once and
      // re-attach as `.transaction_lines` for the render code below.
      const linesSnap = await getDocs(collection(db, 'transaction_lines'))
      const linesByTxn: Record<string, any[]> = {}
      linesSnap.forEach(d => {
        const l = d.data()
        ;(linesByTxn[l.transaction_id] ??= []).push(l)
      })
      txns.forEach(t => { t.transaction_lines = linesByTxn[t.id] ?? [] })

      setData(txns)
      setLoading(false)
    }
    load()
  }, [])

  return (
    <Card className="py-0">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Reference</TableHead>
            <TableHead>Staff</TableHead>
            <TableHead>Items Returned</TableHead>
            <TableHead>Linked OUT Ref</TableHead>
            <TableHead>Date</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading && <TableRow><TableCell colSpan={5} className="py-8 text-center text-muted-foreground">Loading…</TableCell></TableRow>}
          {!loading && data.length === 0 && <TableRow><TableCell colSpan={5} className="py-8 text-center text-muted-foreground">No returns recorded yet</TableCell></TableRow>}
          {data.map((t: any) => {
            const tLines = t.transaction_lines || []
            return (
              <TableRow key={t.id}>
                <TableCell className="font-mono text-xs">{t.reference_no}</TableCell>
                <TableCell className="font-medium">{t.staff_name ?? '—'}</TableCell>
                <TableCell className="text-sm">
                  {tLines.map((l: any) => `${l.product_name ?? '?'} ×${l.quantity}`).join(', ')}
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {t.linked_txn_id ? `Linked ID: ${t.linked_txn_id}` : '—'}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{formatDate(t.created_at)}</TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </Card>
  )
}

function TransactionHistoryReport() {
  const [data, setData] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [typeFilter, setTypeFilter] = useState('')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')

  useEffect(() => {
    setLoading(true)
    let q = query(collection(db, 'transactions'), orderBy('created_at', 'desc'), limit(200))
    if (typeFilter) {
      q = query(collection(db, 'transactions'), where('transaction_type', '==', typeFilter), orderBy('created_at', 'desc'), limit(200))
    }
    // Note: complex queries with inequality on one field and ordering on another require composite index in Firestore.
    // Client-side filtering dates is easier for small/medium datasets.

    async function load() {
      const snap = await getDocs(q)
      let items = snap.docs.map(d => ({ id: d.id, ...d.data() })) as any[]

      if (fromDate) {
        items = items.filter(t => t.created_at >= `${fromDate}T00:00:00`)
      }
      if (toDate) {
        items = items.filter(t => t.created_at <= `${toDate}T23:59:59`)
      }

      // transaction_lines is its own collection now — fetch once and
      // re-attach as `.transaction_lines` for the render code below.
      const linesSnap = await getDocs(collection(db, 'transaction_lines'))
      const linesByTxn: Record<string, any[]> = {}
      linesSnap.forEach(d => {
        const l = d.data()
        ;(linesByTxn[l.transaction_id] ??= []).push(l)
      })
      items.forEach(t => { t.transaction_lines = linesByTxn[t.id] ?? [] })

      setData(items)
      setLoading(false)
    }
    load()
  }, [typeFilter, fromDate, toDate])

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Select
          items={{ [ALL_TYPES]: 'All types', IN: 'Stock In', OUT: 'Stock Out', RETURN: 'Returns', ADJUST: 'Adjustments' }}
          value={typeFilter || ALL_TYPES}
          onValueChange={v => setTypeFilter(v && v !== ALL_TYPES ? v : '')}
        >
          <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_TYPES}>All types</SelectItem>
            <SelectItem value="IN">Stock In</SelectItem>
            <SelectItem value="OUT">Stock Out</SelectItem>
            <SelectItem value="RETURN">Returns</SelectItem>
            <SelectItem value="ADJUST">Adjustments</SelectItem>
          </SelectContent>
        </Select>
        <Input type="date" className="w-40" value={fromDate} onChange={e => setFromDate(e.target.value)} placeholder="From date" />
        <Input type="date" className="w-40" value={toDate} onChange={e => setToDate(e.target.value)} placeholder="To date" />
        {(typeFilter || fromDate || toDate) && (
          <Button variant="ghost" onClick={() => { setTypeFilter(''); setFromDate(''); setToDate('') }}>Clear filters</Button>
        )}
        <span className="self-center text-sm text-muted-foreground">{data.length} transactions</span>
      </div>
      <Card className="py-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Reference</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Staff</TableHead>
              <TableHead>Items</TableHead>
              <TableHead>Flag</TableHead>
              <TableHead>Date</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && <TableRow><TableCell colSpan={6} className="py-8 text-center text-muted-foreground">Loading…</TableCell></TableRow>}
            {!loading && data.length === 0 && <TableRow><TableCell colSpan={6} className="py-8 text-center text-muted-foreground">No transactions found</TableCell></TableRow>}
            {data.map((t: any) => {
              const tLines = t.transaction_lines || []
              const totalQty = tLines.reduce((s: number, l: any) => s + (l.quantity || 0), 0)
              return (
                <TableRow key={t.id}>
                  <TableCell className="font-mono text-xs">{t.reference_no}</TableCell>
                  <TableCell><Badge className={TXN_BADGE_CLASS[t.transaction_type] ?? ''}>{t.transaction_type}</Badge></TableCell>
                  <TableCell className="text-muted-foreground">{t.staff_name ?? '—'}</TableCell>
                  <TableCell className="text-muted-foreground">{tLines.length} line{tLines.length !== 1 ? 's' : ''} · {totalQty} units</TableCell>
                  <TableCell>{t.manual_override && <Badge className="bg-amber-100 text-amber-800">Manual</Badge>}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{formatDate(t.created_at)}</TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </Card>
    </div>
  )
}

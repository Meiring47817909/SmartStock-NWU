'use client'

import { useEffect, useState } from 'react'
import { formatDateOnly, stockStatusLabel, todayDateStr } from '@/lib/utils'
import { db } from '@/lib/firebase/config'
import { collection, query, where, orderBy, getDocs, getCountFromServer } from 'firebase/firestore'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'

// Every row here is still outstanding — nothing has been returned yet — so
// the label needs to describe urgency going forward, not judge a completed
// action. "Early/On time/Late" (used in the Reports Returns tab, which
// describes an actual past return event) reads backwards here: it implies
// something already happened. This table only ever shows lines with a
// remaining balance, so there's no "Partial" case to consider the way there
// is on the Returns report (every row here already IS the outstanding portion).
function outstandingStatus(expectedDate: string | null): { label: string; className: string } | null {
  if (!expectedDate) return null
  const today = todayDateStr()
  if (today > expectedDate) return { label: 'Overdue', className: 'bg-red-100 text-red-800' }
  if (today === expectedDate) return { label: 'Due Today', className: 'bg-amber-100 text-amber-800' }
  return { label: 'Not Due Yet', className: 'bg-emerald-100 text-emerald-800' }
}

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
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function getDashboardData() {
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

        productsSnap.forEach(doc => {
          const p = doc.data()
          totalStock += (p.quantity_on_hand || 0)
          if (p.quantity_on_hand <= p.reorder_threshold) {
            lowStockCount++
            items.push({ id: doc.id, ...p })
          }
        })

        // Sort low items by qty ascending
        items.sort((a, b) => a.quantity_on_hand - b.quantity_on_hand)
        const topLowItems = items.slice(0, 8)

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

        const outstandingList: any[] = []
        outTxns.forEach(t => {
          ;(linesByTxn[t.id] || []).forEach((l: any) => {
            const issued = l.quantity || 0
            const returned = returnedByTxn[t.id]?.[l.product_id] ?? 0
            const remaining = issued - returned
            if (remaining <= 0) return
            outstandingList.push({
              id: `${t.id}_${l.product_id}`,
              product_name: l.product_name ?? 'Unknown',
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

        setStats({
          total_products: totalProductsSnap.data().count,
          total_stock: totalStock,
          low_stock: lowStockCount,
          today_transactions: todayTxnSnap.data().count,
          total_staff: totalStaffSnap.data().count
        })
        setOutstanding(outstandingList)
        setLowItems(topLowItems)
      } catch (err) {
        console.error("Failed to load dashboard data", err)
      } finally {
        setLoading(false)
      }
    }

    getDashboardData()
  }, [])

  const statCards = [
    { label: 'Active Products', value: stats.total_products, className: 'text-primary' },
    { label: 'Total Stock Units', value: stats.total_stock, className: 'text-(--nwu-turquoise)' },
    { label: 'Low Stock Items', value: stats.low_stock, className: 'text-amber-500' },
    { label: "Today's Transactions", value: stats.today_transactions, className: 'text-emerald-500' },
    { label: 'Registered Staff', value: stats.total_staff, className: 'text-muted-foreground' },
  ]

  if (loading) return <div className="p-8 text-muted-foreground">Loading dashboard...</div>

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-foreground">Dashboard</h1>
        <p className="mt-1 text-sm text-muted-foreground">NWU IT Store · Potchefstroom</p>
      </div>

      <div className="mb-6 grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-4">
        {statCards.map(c => (
          <Card key={c.label}>
            <CardContent>
              <div className={`text-3xl font-extrabold ${c.className}`}>{c.value}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">{c.label}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-5">
        <Card className="py-0">
          <CardHeader className="flex-row items-center justify-between border-b py-3">
            <CardTitle className="text-sm">Outstanding Returns</CardTitle>
            {outstanding.length > 0 && (
              <Badge className="bg-accent text-accent-foreground">{outstanding.length} outstanding</Badge>
            )}
          </CardHeader>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead>Staff</TableHead>
                <TableHead>Qty</TableHead>
                <TableHead>Expected</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {outstanding.length === 0 && (
                <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground">Nothing outstanding ✓</TableCell></TableRow>
              )}
              {outstanding.slice(0, 8).map((o) => {
                const status = outstandingStatus(o.expected_date)
                return (
                  <TableRow key={o.id}>
                    <TableCell className="font-medium">{o.product_name}</TableCell>
                    <TableCell className="text-muted-foreground">{o.staff_name}</TableCell>
                    <TableCell className="font-semibold">{o.qty}</TableCell>
                    <TableCell className="text-muted-foreground">{formatDateOnly(o.expected_date)}</TableCell>
                    <TableCell>{status && <Badge className={`${status.className} uppercase`}>{status.label}</Badge>}</TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </Card>

        <Card className="py-0">
          <CardHeader className="flex-row items-center justify-between border-b py-3">
            <CardTitle className="text-sm">Low Stock Alerts</CardTitle>
            {stats.low_stock > 0 && (
              <Badge className="bg-amber-100 text-amber-800">{stats.low_stock} items</Badge>
            )}
          </CardHeader>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead>Qty</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lowItems.length === 0 && (
                <TableRow><TableCell colSpan={3} className="text-center text-muted-foreground">All stock levels healthy ✓</TableCell></TableRow>
              )}
              {lowItems.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="font-medium">{p.name}</TableCell>
                  <TableCell className={`font-bold ${p.quantity_on_hand === 0 ? 'text-red-600' : 'text-amber-600'}`}>
                    {p.quantity_on_hand}
                  </TableCell>
                  <TableCell>
                    <Badge className={p.quantity_on_hand === 0 ? 'bg-red-100 text-red-800' : 'bg-amber-100 text-amber-800'}>
                      {stockStatusLabel(p.quantity_on_hand, p.reorder_threshold)}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </div>
    </div>
  )
}

'use client'

import { useEffect, useState } from 'react'
import { formatDate, stockStatusLabel } from '@/lib/utils'
import { db } from '@/lib/firebase/config'
import { collection, query, where, orderBy, limit, getDocs, getCountFromServer } from 'firebase/firestore'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'

const TXN_BADGE_CLASS: Record<string, string> = {
  IN: 'bg-emerald-100 text-emerald-800',
  OUT: 'bg-accent text-accent-foreground',
  RETURN: 'bg-sky-100 text-sky-800',
}

export default function DashboardPage() {
  const [stats, setStats] = useState({
    total_products: 0,
    total_stock: 0,
    low_stock: 0,
    today_transactions: 0,
    total_staff: 0
  })
  const [recentTxn, setRecentTxn] = useState<any[]>([])
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

        // Fetch recent transactions
        const recentTxnSnap = await getDocs(query(transactionsRef, orderBy('created_at', 'desc'), limit(8)))
        const txnList: any[] = []
        recentTxnSnap.forEach(doc => {
          txnList.push({ id: doc.id, ...doc.data() })
        })

        setStats({
          total_products: totalProductsSnap.data().count,
          total_stock: totalStock,
          low_stock: lowStockCount,
          today_transactions: todayTxnSnap.data().count,
          total_staff: totalStaffSnap.data().count
        })
        setRecentTxn(txnList)
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
          <CardHeader className="border-b py-3">
            <CardTitle className="text-sm">Recent Transactions</CardTitle>
          </CardHeader>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Ref</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Staff ID</TableHead>
                <TableHead>Date</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {recentTxn.length === 0 && (
                <TableRow><TableCell colSpan={4} className="text-center text-muted-foreground">No transactions yet</TableCell></TableRow>
              )}
              {recentTxn.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="font-mono text-xs">{t.reference_no}</TableCell>
                  <TableCell><Badge className={TXN_BADGE_CLASS[t.transaction_type] ?? ''}>{t.transaction_type}</Badge></TableCell>
                  <TableCell className="text-muted-foreground">{t.staff_id ?? '—'}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{formatDate(t.created_at)}</TableCell>
                </TableRow>
              ))}
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

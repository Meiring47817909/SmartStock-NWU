'use client'

import { Fragment, useEffect, useState } from 'react'
import { formatDate } from '@/lib/utils'
import { db } from '@/lib/firebase/config'
import { collection, query, orderBy, limit, getDocs } from 'firebase/firestore'
import { Card } from '@/components/ui/card'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import type { AuditLogEntry, AuditAction, AuditEntityType } from '@/types/database'

const ACTION_BADGE_CLASS: Record<AuditAction, string> = {
  create: 'bg-emerald-100 text-emerald-800',
  update: 'bg-sky-100 text-sky-800',
  delete: 'bg-red-100 text-red-800',
  activate: 'bg-emerald-100 text-emerald-800',
  deactivate: 'bg-accent text-accent-foreground',
}

const ENTITY_LABEL: Record<AuditEntityType, string> = {
  product: 'Product',
  category: 'Category',
  staff: 'Staff',
  transaction: 'Transaction',
}

const ALL_ENTITIES = '__all__'
const ALL_ACTIONS = '__all__'

export default function AuditLogPage() {
  const [entries, setEntries] = useState<AuditLogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [entityFilter, setEntityFilter] = useState('')
  const [actionFilter, setActionFilter] = useState('')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)

  useEffect(() => {
    async function load() {
      setLoading(true)
      const snap = await getDocs(query(collection(db, 'audit_log'), orderBy('created_at', 'desc'), limit(300)))
      let items = snap.docs.map(d => ({ id: d.id, ...d.data() })) as unknown as AuditLogEntry[]

      if (fromDate) items = items.filter(e => e.created_at >= `${fromDate}T00:00:00`)
      if (toDate) items = items.filter(e => e.created_at <= `${toDate}T23:59:59`)

      setEntries(items)
      setLoading(false)
    }
    load()
  }, [fromDate, toDate])

  const filtered = entries.filter(e =>
    (!entityFilter || e.entity_type === entityFilter) &&
    (!actionFilter || e.action === actionFilter)
  )

  function toggleExpand(id: string) {
    setExpanded(prev => prev === id ? null : id)
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-foreground">Audit Log</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Who changed what, and when — product, category, staff and transaction activity.
        </p>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Select
          items={{ [ALL_ENTITIES]: 'All entities', product: 'Product', category: 'Category', staff: 'Staff', transaction: 'Transaction' }}
          value={entityFilter || ALL_ENTITIES}
          onValueChange={v => setEntityFilter(v && v !== ALL_ENTITIES ? v : '')}
        >
          <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_ENTITIES}>All entities</SelectItem>
            <SelectItem value="product">Product</SelectItem>
            <SelectItem value="category">Category</SelectItem>
            <SelectItem value="staff">Staff</SelectItem>
            <SelectItem value="transaction">Transaction</SelectItem>
          </SelectContent>
        </Select>
        <Select
          items={{ [ALL_ACTIONS]: 'All actions', create: 'Create', update: 'Update', delete: 'Delete', activate: 'Activate', deactivate: 'Deactivate' }}
          value={actionFilter || ALL_ACTIONS}
          onValueChange={v => setActionFilter(v && v !== ALL_ACTIONS ? v : '')}
        >
          <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_ACTIONS}>All actions</SelectItem>
            <SelectItem value="create">Create</SelectItem>
            <SelectItem value="update">Update</SelectItem>
            <SelectItem value="delete">Delete</SelectItem>
            <SelectItem value="activate">Activate</SelectItem>
            <SelectItem value="deactivate">Deactivate</SelectItem>
          </SelectContent>
        </Select>
        <Input type="date" className="w-40" value={fromDate} onChange={e => setFromDate(e.target.value)} placeholder="From date" />
        <Input type="date" className="w-40" value={toDate} onChange={e => setToDate(e.target.value)} placeholder="To date" />
        {(entityFilter || actionFilter || fromDate || toDate) && (
          <Button variant="ghost" onClick={() => { setEntityFilter(''); setActionFilter(''); setFromDate(''); setToDate('') }}>Clear filters</Button>
        )}
        <span className="self-center text-sm text-muted-foreground">{filtered.length} entries</span>
      </div>

      <Card className="py-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>User</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Entity</TableHead>
              <TableHead>Entity ID</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && <TableRow><TableCell colSpan={6} className="py-8 text-center text-muted-foreground">Loading…</TableCell></TableRow>}
            {!loading && filtered.length === 0 && <TableRow><TableCell colSpan={6} className="py-8 text-center text-muted-foreground">No audit entries found</TableCell></TableRow>}
            {filtered.map(e => (
              <Fragment key={e.id}>
                <TableRow className="cursor-pointer" onClick={() => toggleExpand(e.id)}>
                  <TableCell className="text-xs text-muted-foreground">{formatDate(e.created_at)}</TableCell>
                  <TableCell className="font-medium">{e.user_name ?? '—'}</TableCell>
                  <TableCell><Badge className={ACTION_BADGE_CLASS[e.action] ?? ''}>{e.action}</Badge></TableCell>
                  <TableCell className="text-muted-foreground">{ENTITY_LABEL[e.entity_type] ?? e.entity_type}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{e.entity_id}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{expanded === e.id ? '▲' : '▼'}</TableCell>
                </TableRow>
                {expanded === e.id && (
                  <TableRow className="bg-muted/50">
                    <TableCell colSpan={6} className="p-4">
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <div className="mb-1 text-[0.7rem] font-bold tracking-wide text-muted-foreground uppercase">Before</div>
                          <pre className="m-0 overflow-x-auto rounded-md border bg-background p-3 text-xs whitespace-pre-wrap break-words text-muted-foreground">
                            {e.before ? JSON.stringify(e.before, null, 2) : '— (none)'}
                          </pre>
                        </div>
                        <div>
                          <div className="mb-1 text-[0.7rem] font-bold tracking-wide text-muted-foreground uppercase">After</div>
                          <pre className="m-0 overflow-x-auto rounded-md border bg-background p-3 text-xs whitespace-pre-wrap break-words text-muted-foreground">
                            {e.after ? JSON.stringify(e.after, null, 2) : '— (none)'}
                          </pre>
                        </div>
                      </div>
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  )
}

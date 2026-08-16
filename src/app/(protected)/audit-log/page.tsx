'use client'

import { Fragment, useEffect, useState } from 'react'
import { formatDate, formatDateOnly } from '@/lib/utils'
import { db } from '@/lib/firebase/config'
import { collection, query, orderBy, limit, getDocs, where } from 'firebase/firestore'
import { Card } from '@/components/ui/card'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import type { AuditLogEntry, AuditAction, AuditEntityType, TransactionLine } from '@/types/database'

const ACTION_BADGE_CLASS: Record<AuditAction, string> = {
  create: 'bg-emerald-100 text-emerald-800',
  update: 'bg-sky-100 text-sky-800',
  delete: 'bg-red-100 text-red-800',
  activate: 'bg-emerald-100 text-emerald-800',
  deactivate: 'bg-accent text-accent-foreground',
}

// Same mapping as TXN_BADGE_CLASS on the Reports page's transaction-history
// tab — every transaction audit entry logs 'create' as its action (the
// transactions collection is append-only, never updated), which isn't
// useful to look at in a list of IN/OUT/RETURN activity. Show the
// transaction's actual type instead, styled the same as it is in Reports.
const TXN_BADGE_CLASS: Record<string, string> = {
  IN: 'bg-emerald-100 text-emerald-800',
  OUT: 'bg-accent text-accent-foreground',
  RETURN: 'bg-sky-100 text-sky-800',
  ADJUST: 'bg-amber-100 text-amber-800',
}

const ENTITY_LABEL: Record<AuditEntityType, string> = {
  product: 'Product',
  category: 'Category',
  staff: 'Staff',
  transaction: 'Transaction',
}

const ALL_ENTITIES = '__all__'
const ALL_ACTIONS = '__all__'

// Plain-English labels for the raw Firestore field names that show up in
// product/category/staff before-after snapshots — Selouna shouldn't have to
// know what "quantity_on_hand" or "reorder_threshold" mean.
const FIELD_LABELS: Record<string, string> = {
  name: 'Name',
  surname: 'Surname',
  description: 'Description',
  category_name: 'Category',
  barcodes: 'Barcodes',
  quantity_on_hand: 'Qty on hand',
  reorder_threshold: 'Reorder threshold',
  available: 'Available',
  location: 'Location',
  lend_from: 'Lend from',
  lend_to: 'Lend to',
  email: 'Email',
  department: 'Department',
  card_uid: 'Card UID',
  is_active: 'Active',
}

// Fields that are either internal bookkeeping (id, timestamps, the raw
// category_id/uid used to join to other records) or not useful to show as a
// diff (raw Storage paths for photos) — left out of the friendly view.
const SKIP_FIELDS = new Set(['id', 'created_at', 'updated_at', 'category_id', 'images', 'full_name', 'uid'])

function friendlyLabel(key: string): string {
  return FIELD_LABELS[key] ?? key.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
}

function friendlyValue(key: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'boolean') {
    if (key === 'available') return value ? 'Available' : 'Unavailable'
    if (key === 'is_active') return value ? 'Active' : 'Inactive'
    return value ? 'Yes' : 'No'
  }
  if (Array.isArray(value)) return value.length ? value.join(', ') : '—'
  if ((key === 'lend_from' || key === 'lend_to') && typeof value === 'string') return formatDateOnly(value)
  return String(value)
}

// Plain-language before/after view for product, category and staff entries.
// On a create, `before` is null, so every field in `after` is just listed.
// On an update, both are full-object snapshots — only the fields that
// actually changed are shown, as "Field: old → new".
function FieldDiff({ before, after }: { before: Record<string, unknown> | null; after: Record<string, unknown> | null }) {
  const keys = Array.from(new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])).filter(
    (k) => !SKIP_FIELDS.has(k),
  )
  const rows = keys
    .map((key) => ({ key, before: before?.[key], after: after?.[key] }))
    .filter(({ before: b, after: a }) => !before || JSON.stringify(b) !== JSON.stringify(a))

  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No details recorded.</p>
  }

  return (
    <div className="flex flex-col gap-1.5">
      {rows.map(({ key, before: b, after: a }) => (
        <div key={key} className="flex flex-wrap items-baseline gap-1.5 text-sm">
          <span className="font-medium text-foreground">{friendlyLabel(key)}:</span>
          {before ? (
            <>
              <span className="text-muted-foreground line-through">{friendlyValue(key, b)}</span>
              <span className="text-muted-foreground">→</span>
              <span className="text-foreground">{friendlyValue(key, a)}</span>
            </>
          ) : (
            <span className="text-foreground">{friendlyValue(key, a)}</span>
          )}
        </div>
      ))}
    </div>
  )
}

// Transactions are append-only (only ever logged as 'create', with `before`
// always null) and their `after` snapshot is already a purpose-built shape
// rather than a raw entity record — so instead of a field-by-field diff,
// show it the same way the Reports page's transaction-history tab does:
// staff, line/unit counts, manual-entry flag, notes. The individual product
// names/quantities aren't in `after` at all — they live in `transaction_lines`
// (one doc per line item), fetched separately on expand — see `lines` prop.
function TransactionSummary({ after, lines }: { after: Record<string, unknown> | null; lines: TransactionLine[] | undefined }) {
  if (!after) return <p className="text-sm text-muted-foreground">No details recorded.</p>
  const staffName = typeof after.staff_name === 'string' ? after.staff_name : null
  const lineCount = typeof after.line_count === 'number' ? after.line_count : null
  const totalQty = typeof after.total_qty === 'number' ? after.total_qty : null
  const notes = typeof after.notes === 'string' && after.notes ? after.notes : null
  const reference = typeof after.reference_no === 'string' ? after.reference_no : null
  const manual = after.manual_override === true
  // Only OUT transactions set these (Stock Out's Confirm step) — IN and
  // RETURN never write lend_from/lend_to, so both are null/absent there.
  const lendFrom = typeof after.lend_from === 'string' ? after.lend_from : null
  const lendTo = typeof after.lend_to === 'string' ? after.lend_to : null

  return (
    <div className="flex flex-col gap-1.5 text-sm">
      {reference && (
        <div>
          <span className="font-medium text-foreground">Reference:</span>{' '}
          <span className="font-mono text-xs text-muted-foreground">{reference}</span>
        </div>
      )}
      {staffName && (
        <div>
          <span className="font-medium text-foreground">Staff:</span> {staffName}
        </div>
      )}
      {(lineCount !== null || totalQty !== null) && (
        <div>
          <span className="font-medium text-foreground">Items:</span>{' '}
          {lineCount ?? '—'} line{lineCount === 1 ? '' : 's'} · {totalQty ?? '—'} units
        </div>
      )}
      {lines === undefined ? (
        <p className="text-xs text-muted-foreground">Loading items…</p>
      ) : lines.length > 0 ? (
        <ul className="ml-4 list-disc">
          {lines.map((l) => (
            <li key={l.id}>
              {l.product_name ?? 'Unknown product'} <span className="text-muted-foreground">× {l.quantity}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {(lendFrom || lendTo) && (
        <div>
          <span className="font-medium text-foreground">Lend window:</span>{' '}
          {formatDateOnly(lendFrom)} – {formatDateOnly(lendTo)}
        </div>
      )}
      {manual && <Badge className="w-fit bg-amber-100 text-amber-800">Manual entry — no card scan</Badge>}
      {notes && (
        <div>
          <span className="font-medium text-foreground">Notes:</span> {notes}
        </div>
      )}
    </div>
  )
}

export default function AuditLogPage() {
  const [entries, setEntries] = useState<AuditLogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [entityFilter, setEntityFilter] = useState('')
  const [actionFilter, setActionFilter] = useState('')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  // Keyed by transaction entity_id — fetched lazily the first time a
  // transaction row is expanded, then cached so re-expanding is instant.
  const [lines, setLines] = useState<Record<string, TransactionLine[]>>({})

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

  async function toggleExpand(e: AuditLogEntry) {
    if (expanded === e.id) { setExpanded(null); return }
    setExpanded(e.id)
    if (e.entity_type === 'transaction' && !lines[e.entity_id]) {
      const snap = await getDocs(query(collection(db, 'transaction_lines'), where('transaction_id', '==', e.entity_id)))
      const items = snap.docs.map(d => ({ id: d.id, ...d.data() })) as unknown as TransactionLine[]
      setLines(prev => ({ ...prev, [e.entity_id]: items }))
    }
  }

  function actionBadge(e: AuditLogEntry) {
    const txnType = e.entity_type === 'transaction' ? e.after?.transaction_type : undefined
    if (typeof txnType === 'string') {
      return <Badge className={`${TXN_BADGE_CLASS[txnType] ?? ''} uppercase`}>{txnType}</Badge>
    }
    return <Badge className={`${ACTION_BADGE_CLASS[e.action] ?? ''} uppercase`}>{e.action}</Badge>
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
                <TableRow className="cursor-pointer" onClick={() => toggleExpand(e)}>
                  <TableCell className="text-xs text-muted-foreground">{formatDate(e.created_at)}</TableCell>
                  <TableCell className="font-medium">{e.user_name ?? '—'}</TableCell>
                  <TableCell>{actionBadge(e)}</TableCell>
                  <TableCell className="text-muted-foreground">{ENTITY_LABEL[e.entity_type] ?? e.entity_type}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{e.entity_id}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{expanded === e.id ? '▲' : '▼'}</TableCell>
                </TableRow>
                {expanded === e.id && (
                  <TableRow className="bg-muted/50">
                    <TableCell colSpan={6} className="p-4">
                      {e.entity_type === 'transaction' ? (
                        <TransactionSummary after={e.after} lines={lines[e.entity_id]} />
                      ) : (
                        <FieldDiff before={e.before} after={e.after} />
                      )}
                      <details className="mt-3">
                        <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                          Show raw data
                        </summary>
                        <div className="mt-2 grid grid-cols-2 gap-3">
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
                      </details>
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

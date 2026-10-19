'use client'

import { Fragment, useEffect, useState } from 'react'
import { useExpandedRows } from '@/hooks/useExpandedRows'
import { formatDate, formatDateOnly, formatLendWindow, sentenceCase, todayDateStr } from '@/lib/utils'
import { LENDING_INTERVALS } from '@/lib/loanRequestRules'
import { toast } from 'sonner'
import { loadAuditLog } from '@/lib/api/auditLog'
import { useTable, type SortingState } from '@tanstack/react-table'
import {
  SORTABLE_TABLE_FEATURES, sortableColumnHelper, SortableHead, ExportCsvButton, ExportPdfButton,
  type PageSize, paginate, TablePagination,
} from '@/components/data-table-helpers'
import { Card, CardContent } from '@/components/ui/card'
import { CollapsibleFilters } from '@/components/CollapsibleFilters'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { AvailabilityDatePicker } from '@/components/portal/AvailabilityDatePicker'
import { Badge } from '@/components/ui/badge'
import { MultiSelect } from '@/components/ui/multi-select'
import { collapseLinesByProduct, formatBarcodeQuantities } from '@/lib/transactionLines'
import type { AuditLogEntry, AuditAction, AuditEntityType, TransactionLine, LoanRequestLine } from '@/types/database'

const ACTION_BADGE_CLASS: Record<AuditAction, string> = {
  create: 'bg-emerald-100 text-emerald-800 border-emerald-200/60 px-2.5 font-semibold',
  update: 'bg-sky-100 text-sky-800 border-sky-200/60 px-2.5 font-semibold',
  delete: 'bg-red-100 text-red-800 border-red-200/60 px-2.5 font-semibold',
  activate: 'bg-emerald-100 text-emerald-800 border-emerald-200/60 px-2.5 font-semibold',
  deactivate: 'bg-accent text-accent-foreground border-transparent px-2.5 font-semibold',
  resolve: 'bg-violet-100 text-violet-800 border-violet-200/60 px-2.5 font-semibold',
  grant_access: 'bg-emerald-100 text-emerald-800 border-emerald-200/60 px-2.5 font-semibold',
  resend_access: 'bg-sky-100 text-sky-800 border-sky-200/60 px-2.5 font-semibold',
}

// Same mapping as TXN_BADGE_CLASS on the Reports page's transaction-history
// tab — every transaction audit entry logs 'create' as its action (the
// transactions collection is append-only, never updated), which isn't
// useful to look at in a list of IN/OUT/RETURN activity. Show the
// transaction's actual type instead, styled the same as it is in Reports.
const TXN_BADGE_CLASS: Record<string, string> = {
  IN: 'bg-emerald-100 text-emerald-800 border-emerald-200/60 px-2.5 font-semibold',
  OUT: 'bg-accent text-accent-foreground border-transparent px-2.5 font-semibold',
  RETURN: 'bg-sky-100 text-sky-800 border-sky-200/60 px-2.5 font-semibold',
  ADJUST: 'bg-amber-100 text-amber-800 border-amber-200/60 px-2.5 font-semibold',
}

const ENTITY_LABEL: Record<AuditEntityType, string> = {
  product: 'Product',
  category: 'Category',
  staff: 'Staff',
  transaction: 'Transaction',
  loan_request: 'Loan Request',
  settings: 'Settings',
}

// Same reasoning as TXN_BADGE_CLASS above — a loan_request audit entry
// always logs 'update' as its action (the interesting information is which
// status it moved to), so show the status instead of the generic verb.
const LOAN_REQUEST_BADGE_CLASS: Record<string, string> = {
  pending: 'bg-amber-100 text-amber-800 border-amber-200/60 px-2.5 font-semibold',
  countered: 'bg-sky-100 text-sky-800 border-sky-200/60 px-2.5 font-semibold',
  accepted: 'bg-emerald-100 text-emerald-800 border-emerald-200/60 px-2.5 font-semibold',
  fulfilled: 'bg-accent text-accent-foreground border-transparent px-2.5 font-semibold',
  declined: 'bg-red-100 text-red-800 border-red-200/60 px-2.5 font-semibold',
  expired: 'bg-muted text-muted-foreground border-transparent px-2.5 font-semibold',
  withdrawn: 'bg-muted text-muted-foreground border-transparent px-2.5 font-semibold',
  no_show: 'bg-red-100 text-red-800 border-red-200/60 px-2.5 font-semibold',
}

// Display labels for those same statuses. Only the ones whose raw value
// doesn't read correctly on its own need an entry — everything else falls
// back to the underscore-stripped value. 'no_show' is called "Not Picked
// Up" everywhere the admin actually sees it (the Dashboard's Incoming
// Pickups badge), so the Audit Log says the same thing.
const LOAN_REQUEST_STATUS_LABEL: Record<string, string> = {
  no_show: 'Not picked up',
}

function loanRequestStatusLabel(status: string): string {
  return LOAN_REQUEST_STATUS_LABEL[status] ?? status.replace('_', ' ')
}

const ENTITY_OPTIONS: { value: AuditEntityType; label: string }[] = [
  { value: 'product', label: 'Product' }, { value: 'category', label: 'Category' }, { value: 'staff', label: 'Staff' },
  { value: 'transaction', label: 'Transaction' }, { value: 'loan_request', label: 'Loan Request' }, { value: 'settings', label: 'Settings' },
]

/*
 * The "Activity" column and its filter used to disagree, which made the
 * filter look broken: the column showed a DERIVED value (a transaction's
 * IN/OUT/RETURN type, or a loan request's new status) while the dropdown
 * filtered on the raw `action` field. Since `transactions` is append-only
 * every transaction entry logs action 'create', so picking "Create"
 * returned every transaction in the log — each one badged OUT or RETURN,
 * none of them saying "create" anywhere.
 *
 * activityKey() is now the single source of truth. The badge, the filter
 * options and the filter comparison all derive from it, so the column and
 * the dropdown cannot drift apart again.
 */
function activityKey(e: AuditLogEntry): string {
  const loanStatus = e.entity_type === 'loan_request' ? e.after?.status : undefined
  if (typeof loanStatus === 'string') return `status:${loanStatus}`
  // A resolve entry is logged against the transaction it closes out and
  // carries the waiver's fields, not a transaction_type — so it falls
  // through to the action branch below, as 'action:resolve'.
  const txnType = e.entity_type === 'transaction' ? e.after?.transaction_type : undefined
  if (typeof txnType === 'string') return `txn:${txnType}`
  return `action:${e.action}`
}

// Label, badge colour, and which entity types an activity can belong to.
// `entities` is what lets the Activity dropdown narrow when an entity is
// chosen — keeping it in THIS table rather than a separate entity-to-
// activities map means there's only one list to update when something new
// is logged. Anything not listed falls back to the raw key's suffix, so an
// unrecognised value still renders sensibly.
const RECORD_ENTITIES: AuditEntityType[] = ['product', 'category', 'staff']

const ACTIVITY: Record<string, {
  label: string; className: string; entities: AuditEntityType[]
}> = {
  'txn:IN': { label: 'In', className: TXN_BADGE_CLASS.IN, entities: ['transaction'] },
  'txn:OUT': { label: 'Out', className: TXN_BADGE_CLASS.OUT, entities: ['transaction'] },
  'txn:RETURN': { label: 'Return', className: TXN_BADGE_CLASS.RETURN, entities: ['transaction'] },
  'txn:ADJUST': { label: 'Adjust', className: TXN_BADGE_CLASS.ADJUST, entities: ['transaction'] },
  // A resolved return is logged against the transaction it closes out.
  'action:resolve': { label: 'Resolved', className: ACTION_BADGE_CLASS.resolve, entities: ['transaction'] },

  'status:pending': { label: 'Pending', className: LOAN_REQUEST_BADGE_CLASS.pending, entities: ['loan_request'] },
  'status:countered': { label: 'Countered', className: LOAN_REQUEST_BADGE_CLASS.countered, entities: ['loan_request'] },
  'status:accepted': { label: 'Accepted', className: LOAN_REQUEST_BADGE_CLASS.accepted, entities: ['loan_request'] },
  'status:fulfilled': { label: 'Fulfilled', className: LOAN_REQUEST_BADGE_CLASS.fulfilled, entities: ['loan_request'] },
  'status:declined': { label: 'Declined', className: LOAN_REQUEST_BADGE_CLASS.declined, entities: ['loan_request'] },
  'status:expired': { label: 'Expired', className: LOAN_REQUEST_BADGE_CLASS.expired, entities: ['loan_request'] },
  'status:withdrawn': { label: 'Withdrawn', className: LOAN_REQUEST_BADGE_CLASS.withdrawn, entities: ['loan_request'] },
  'status:no_show': { label: 'Not picked up', className: LOAN_REQUEST_BADGE_CLASS.no_show, entities: ['loan_request'] },

  'action:create': { label: 'Create', className: ACTION_BADGE_CLASS.create, entities: RECORD_ENTITIES },
  // 'settings' only ever logs 'update' (there's no create/delete for a
  // singleton settings doc), so it's added here rather than to
  // RECORD_ENTITIES itself -- that would also offer Create/Delete as
  // filter options for an entity that never produces either.
  'action:update': { label: 'Update', className: ACTION_BADGE_CLASS.update, entities: [...RECORD_ENTITIES, 'settings'] },
  // Only products and categories can be deleted from the app today — staff
  // are deactivated instead (see 'action:deactivate' below), never removed.
  'action:delete': { label: 'Delete', className: ACTION_BADGE_CLASS.delete, entities: ['product', 'category'] },
  // Only staff records can be activated or deactivated.
  'action:activate': { label: 'Activate', className: ACTION_BADGE_CLASS.activate, entities: ['staff'] },
  'action:deactivate': { label: 'Deactivate', className: ACTION_BADGE_CLASS.deactivate, entities: ['staff'] },
  'action:grant_access': { label: 'Portal Access Granted', className: ACTION_BADGE_CLASS.grant_access, entities: ['staff'] },
  'action:resend_access': { label: 'Login Link Resent', className: ACTION_BADGE_CLASS.resend_access, entities: ['staff'] },
}

// Activity keys applicable to an entity filter ('' meaning "all entities").
// With several entities ticked, an activity is offered if ANY of them can
// produce it; with none ticked (= all entities), every activity is.
function activityKeysFor(entities: string[]): string[] {
  return Object.keys(ACTIVITY).filter(
    k => entities.length === 0 || entities.some(en => ACTIVITY[k].entities.includes(en as AuditEntityType)),
  )
}

function activityLabel(key: string): string {
  return ACTIVITY[key]?.label ?? key.split(':')[1]?.replace('_', ' ') ?? key
}

// The dropdown, grouped so stock movements, loan-request transitions and
// plain record edits don't read as one flat soup. Order matches the table's
// own vocabulary, not the underlying field names.
const ACTIVITY_GROUPS: { label: string; keys: string[] }[] = [
  { label: 'Stock movements', keys: ['txn:IN', 'txn:OUT', 'txn:RETURN', 'txn:ADJUST', 'action:resolve'] },
  { label: 'Loan requests', keys: ['status:pending', 'status:countered', 'status:accepted', 'status:fulfilled', 'status:declined', 'status:expired', 'status:withdrawn', 'status:no_show'] },
  { label: 'Record changes', keys: ['action:create', 'action:update', 'action:delete', 'action:activate', 'action:deactivate'] },
  { label: 'Portal access', keys: ['action:grant_access', 'action:resend_access'] },
]

// Plain-English labels for the raw Firestore field names that show up in
// product/category/staff before-after snapshots — Jonathan shouldn't have to
// know what "quantity_on_hand" or "reorder_threshold" mean.
const FIELD_LABELS: Record<string, string> = {
  name: 'Name',
  surname: 'Surname',
  description: 'Description',
  category_name: 'Category',
  barcodes: 'Barcodes',
  quantity_on_hand: 'Qty on hand',
  reason: 'Reason for change',
  reorder_threshold: 'Reorder threshold',
  available: 'Available',
  location: 'Location',
  lend_from: 'Lend from',
  lend_to: 'Lend to',
  lending_interval: 'Lending interval',
  email: 'Email',
  department: 'Department',
  card_uid: 'Card UID',
  is_active: 'Active',
  status: 'Status',
  from_date: 'From date',
  to_date: 'To date',
  message: 'Message',
  admin_message: 'Message to staff',
  reference_no: 'Reference',
  operator_name: 'Operator',
  auth_email_synced: 'Login account email also changed',
  fulfilled_txn_id: 'Fulfilled transaction',
  fulfilled_txn_ref: 'Fulfilled transaction ref',
  linked_request_ref: 'Loan request ref',
  linked_request_id: 'Loan request',
  linked_txn_id: 'Returned against',
}

// Fields that are either internal bookkeeping (id, timestamps, the raw
// category_id/uid/staff_id used to join to other records) or not useful to
// show as a diff (raw Storage paths for photos, the immutable
// original_from_date/original_to_date snapshot which would just look like a
// noisy duplicate of from_date/to_date on a loan_request's create entry) —
// left out of the friendly view.
const SKIP_FIELDS = new Set([
  'id', 'created_at', 'updated_at', 'category_id', 'images', 'full_name', 'uid',
  'staff_id', 'original_from_date', 'original_to_date',
])

function friendlyLabel(key: string): string {
  return FIELD_LABELS[key] ?? key.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
}

function friendlyValue(key: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'boolean') {
    if (key === 'available') return value ? 'Available' : 'Unavailable'
    if (key === 'is_active') return value ? 'Active' : 'Deactivated'
    return value ? 'Yes' : 'No'
  }
  if (Array.isArray(value)) return value.length ? value.join(', ') : '—'
  if (
    (key === 'lend_from' || key === 'lend_to' || key === 'from_date' || key === 'to_date') &&
    typeof value === 'string'
  ) return formatDateOnly(value)
  if (key === 'status' && typeof value === 'string') return loanRequestStatusLabel(value)
  if (key === 'lending_interval' && typeof value === 'string') {
    return LENDING_INTERVALS.find((i) => i.value === value)?.label ?? value
  }
  return String(value)
}

// Canonical display field order per entity_type (and, where the action
// changes the field vocabulary entirely rather than just adding a field,
// per entity_type+action) — independent of whatever order the CODE PATH
// that wrote a given entry happened to build its object literal in. Real
// app writes, seed-script writes, and old historical data have all drifted
// from each other in practice (see the 2026-09-26 field-order audit); this
// is what makes every entry for the same kind of record look the same to
// Jonathan regardless of which of those wrote it. Order was chosen to read
// naturally (identity/what-changed fields first, bookkeeping fields last),
// not copied from any one write path.
const AUDIT_FIELD_ORDER: Record<string, string[]> = {
  product: [
    'name', 'category_name', 'category_id', 'description', 'barcodes',
    'quantity_on_hand', 'reason', 'reorder_threshold', 'available', 'location',
    'lend_from', 'lend_to', 'lending_interval', 'images', 'created_at', 'updated_at',
  ],
  category: ['name', 'description', 'created_at'],
  // Staff's three action families genuinely don't share a field vocabulary
  // (a status flip carries none of a profile edit's fields, and granting
  // portal access carries almost none of either) -- keyed by action family
  // via auditFieldOrderKey() below, not by entity_type alone.
  'staff:record': [
    'name', 'surname', 'full_name', 'email', 'department', 'card_uid',
    'is_active', 'uid', 'auth_email_synced', 'created_at', 'updated_at',
  ],
  'staff:status': ['is_active', 'name', 'surname', 'full_name', 'email'],
  'staff:access': ['full_name', 'email', 'uid'],
  // Same story for transactions: a resolved (written-off) return is logged
  // against the transaction it originated from but carries return_waivers'
  // own fields, not a transaction's -- see createReturnWaiver (stock.ts) / ResolveSummary.
  'transaction:record': [
    'transaction_type', 'reference_no', 'staff_id', 'staff_name', 'user_id',
    'operator_name', 'manual_override', 'notes', 'return_date', 'linked_txn_id',
    'lend_from', 'lend_to', 'linked_request_id', 'linked_request_ref',
    'created_at', 'line_count', 'total_qty', 'lines',
  ],
  'transaction:resolve': [
    'product_id', 'product_name', 'quantity', 'staff_id', 'staff_name', 'reason',
    'transaction_id', 'created_at', 'resolved_by_uid', 'resolved_by_name',
  ],
  // Every loan_request transition already funnels through one shared
  // snapshot builder (requestAuditSnapshot in loanRequests.ts), so a single
  // order covers create and every update -- a handful of actions just
  // append 1-3 extra context fields, listed here at the end.
  loan_request: [
    'reference_no', 'staff_id', 'staff_name', 'status', 'from_date', 'to_date',
    'original_from_date', 'original_to_date', 'message', 'admin_message',
    'fulfilled_txn_id', 'fulfilled_txn_ref', 'lines', 'line_count', 'total_qty',
    'staff_message', 'counter_message', 'countered_lines', 'cancel_reason',
    'created_at', 'updated_at',
  ],
}

function auditFieldOrderKey(entityType: AuditEntityType, action: AuditAction): string {
  if (entityType === 'staff') {
    if (action === 'activate' || action === 'deactivate') return 'staff:status'
    if (action === 'grant_access' || action === 'resend_access') return 'staff:access'
    return 'staff:record'
  }
  if (entityType === 'transaction') {
    return action === 'resolve' ? 'transaction:resolve' : 'transaction:record'
  }
  return entityType
}

// Returns a NEW object with the same fields as `obj`, reordered to the
// canonical order above -- never filtered. A field the canonical list
// doesn't know about (a future field nobody's added here yet, or one only
// an old write path ever set) is appended at the end in its original
// order, so nothing already in the entry can silently disappear from
// either the raw-data view or the CSV export.
function reorderForDisplay(
  entityType: AuditEntityType, action: AuditAction, obj: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!obj) return null
  const order = AUDIT_FIELD_ORDER[auditFieldOrderKey(entityType, action)] ?? []
  const result: Record<string, unknown> = {}
  for (const key of order) {
    if (key in obj) result[key] = obj[key]
  }
  for (const key of Object.keys(obj)) {
    if (!(key in result)) result[key] = obj[key]
  }
  return result
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
  const operatorName = typeof after.operator_name === 'string' ? after.operator_name : null
  const lineCount = typeof after.line_count === 'number' ? after.line_count : null
  const totalQty = typeof after.total_qty === 'number' ? after.total_qty : null
  const notes = typeof after.notes === 'string' && after.notes ? after.notes : null
  const reference = typeof after.reference_no === 'string' ? after.reference_no : null
  const txnType = typeof after.transaction_type === 'string' ? after.transaction_type : null
  // manual_override means "the staff member was picked from a list instead
  // of scanning their card", so it's only meaningful on the two flows that
  // HAVE a staff step to bypass -- Stock Out and Returns. Stock In and
  // ADJUST write no staff_id and never set this field, so a true value on
  // one of those is bad data (a seed script fabricated exactly that once),
  // not a real manual entry. Gate the badge rather than trusting the flag.
  const manual = after.manual_override === true && (txnType === 'OUT' || txnType === 'RETURN')
  // Only OUT transactions set these (Stock Out's Confirm step) — IN and
  // RETURN never write lend_from/lend_to, so both are null/absent there.
  const lendFrom = typeof after.lend_from === 'string' ? after.lend_from : null
  const lendTo = typeof after.lend_to === 'string' ? after.lend_to : null

  // Prefer the product lines frozen into the entry at write time over the
  // ones joined from transaction_lines on expand. The frozen copy is what
  // a CSV export carries, so preferring it keeps the screen and the export
  // showing the same thing — and it reflects the names and quantities as
  // they were, not as they are now. Entries written before this was
  // recorded have no `after.lines`, so they fall back to the join.
  const frozenLines = Array.isArray(after.lines)
    ? (after.lines as { product_id?: string; product_name?: string; quantity?: number; barcodes?: string[] | null; barcode_quantities?: { barcode: string; quantity: number }[] | null }[])
    : null
  const shownLines = frozenLines
    ?? collapseLinesByProduct(lines ?? []).map((l) => ({ product_name: l.product_name, quantity: l.quantity, barcodes: l.barcodes, barcode_quantities: l.barcodeQuantities }))
  const linesPending = frozenLines === null && lines === undefined

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
      {operatorName && (
        <div>
          {/* Who ran the till, as opposed to who it was for. On a Stock In
              this is the only person on the record. */}
          <span className="font-medium text-foreground">Operator:</span> {operatorName}
        </div>
      )}
      {typeof after.linked_request_ref === 'string' && after.linked_request_ref && (
        <div>
          {/* Present on an OUT issued against an online request, and on
              any RETURN of that issue. Absent on a walk-in or a Stock In. */}
          <span className="font-medium text-foreground">Loan request:</span>{' '}
          <span className="font-mono text-xs text-muted-foreground">{after.linked_request_ref}</span>
        </div>
      )}
      {(lineCount !== null || totalQty !== null) && (
        <div>
          <span className="font-medium text-foreground">Items:</span>{' '}
          {lineCount ?? '—'} line{lineCount === 1 ? '' : 's'} · {totalQty ?? '—'} units
        </div>
      )}
      {linesPending ? (
        <p className="text-xs text-muted-foreground">Loading items…</p>
      ) : shownLines.length > 0 ? (
        <ul className="ml-4 list-disc">
          {shownLines.map((l, i) => (
            <li key={i}>
              {l.product_name ?? 'Unknown product'} <span className="text-muted-foreground">× {l.quantity}</span>
              {/* Every distinct barcode scanned for the line at Stock Out.
                  Absent on lines picked off a loan request, on other
                  transaction types, and on entries from before barcode
                  capture existed. */}
              {Array.isArray(l.barcode_quantities) && l.barcode_quantities.length > 0 ? (
                <div className="font-mono text-xs text-muted-foreground">{formatBarcodeQuantities(l.barcode_quantities).join(' · ')}</div>
              ) : Array.isArray(l.barcodes) && l.barcodes.length > 0 && (
                <div className="font-mono text-xs text-muted-foreground">{l.barcodes.join(' · ')}</div>
              )}
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
      {manual && <Badge className="w-fit bg-amber-100 text-amber-800 border-amber-200/60 px-2.5 font-semibold">Manual entry — no card scan</Badge>}
      {notes && (
        <div>
          <span className="font-medium text-foreground">Notes:</span> {notes}
        </div>
      )}
    </div>
  )
}

// A product update shows only the fields that changed, which on its own
// never says WHICH product changed — the name is usually untouched, so
// FieldDiff filters it out as unchanged. Same problem StaffStatusSummary
// solves for activate/deactivate. The name is read straight off the
// payload rather than diffed; if the name itself was edited, `after`
// carries the new one and FieldDiff still shows the rename below.
function ProductUpdateSummary({
  before, after,
}: {
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
}) {
  const name =
    (typeof after?.name === 'string' && after.name) ||
    (typeof before?.name === 'string' && before.name) ||
    null

  return (
    <div className="flex flex-col gap-1.5">
      {name && (
        // Same markup FieldDiff uses for a field on a create entry (its
        // no-`before` branch), so "Name: ..." reads identically whether
        // the product was just created or edited. friendlyLabel keeps the
        // wording tied to FIELD_LABELS rather than hard-coding it.
        <div className="flex flex-wrap items-baseline gap-1.5 text-sm">
          <span className="font-medium text-foreground">{friendlyLabel('name')}:</span>
          <span className="text-foreground">{name}</span>
        </div>
      )}
      <FieldDiff before={before} after={after} />
    </div>
  )
}

// Provisioning or re-issuing a lending-portal login. Every field on the
// entry is identical in before and after (it's context, not a change), so
// FieldDiff would filter the lot and render "No details recorded" — which
// is exactly what this entry used to do, since its only field was a `uid`
// that SKIP_FIELDS hides.
function StaffAccessSummary({
  after, granted,
}: {
  after: Record<string, unknown> | null
  granted: boolean
}) {
  if (!after) return <p className="text-sm text-muted-foreground">No details recorded.</p>
  const fullName = typeof after.full_name === 'string' && after.full_name ? after.full_name : null
  const email = typeof after.email === 'string' && after.email ? after.email : null
  const uid = typeof after.uid === 'string' && after.uid ? after.uid : null

  return (
    <div className="flex flex-col gap-1.5 text-sm">
      {fullName && (
        <div><span className="font-medium text-foreground">Staff member:</span> {fullName}</div>
      )}
      {email && (
        <div><span className="font-medium text-foreground">Sent to:</span> {email}</div>
      )}
      <div>
        <span className="font-medium text-foreground">Action:</span>{' '}
        {granted
          ? 'Lending-portal login provisioned and a password-set link emailed.'
          : 'Password-reset link re-sent to the existing login account.'}
      </div>
      {uid && (
        <div>
          <span className="font-medium text-foreground">Login account:</span>{' '}
          <span className="font-mono text-xs text-muted-foreground">{uid}</span>
        </div>
      )}
    </div>
  )
}

// A staff member's activate/deactivate toggle: before and after only ever
// differ in `is_active` (name/surname/email are unchanged, logged purely as
// identifying context — see toggleActive() in staff/page.tsx), so the
// generic FieldDiff would show just "Active: Active → Deactivated" with no
// indication of WHO. This reads the identifying fields straight off `after`
// instead of diffing them.
function StaffStatusSummary({ after }: { after: Record<string, unknown> | null }) {
  if (!after) return <p className="text-sm text-muted-foreground">No details recorded.</p>
  const fullName = typeof after.full_name === 'string' && after.full_name ? after.full_name : null
  const email = typeof after.email === 'string' && after.email ? after.email : null
  const isActive = after.is_active === true

  return (
    <div className="flex flex-col gap-1.5 text-sm">
      {fullName && (
        <div><span className="font-medium text-foreground">Staff member:</span> {fullName}</div>
      )}
      {email && (
        <div><span className="font-medium text-foreground">Email:</span> {email}</div>
      )}
      <div>
        <span className="font-medium text-foreground">Status:</span> {isActive ? 'Active' : 'Deactivated'}
      </div>
    </div>
  )
}

// A resolved (written-off) return: logged against the ORIGINATING
// transaction's entity_type/entity_id (see createReturnWaiver in stock.ts)
// so it shows up alongside that transaction's own Stock Out entry rather
// than looking like an unrelated record — but the waiver's own descriptive
// fields (product/qty/staff/reason) don't match TransactionSummary's shape
// at all, so a resolve entry gets this small renderer instead, picked by
// action rather than entity_type in the switch below.
function ResolveSummary({ after }: { after: Record<string, unknown> | null }) {
  if (!after) return <p className="text-sm text-muted-foreground">No details recorded.</p>
  const productName = typeof after.product_name === 'string' ? after.product_name : null
  const quantity = typeof after.quantity === 'number' ? after.quantity : null
  const staffName = typeof after.staff_name === 'string' ? after.staff_name : null
  const reason = typeof after.reason === 'string' && after.reason ? after.reason : null
  const resolvedByName = typeof after.resolved_by_name === 'string' ? after.resolved_by_name : null

  return (
    <div className="flex flex-col gap-1.5 text-sm">
      {(productName || quantity !== null) && (
        <div>
          <span className="font-medium text-foreground">Item:</span>{' '}
          {productName ?? 'Unknown product'}{quantity !== null && <> × {quantity}</>}
        </div>
      )}
      {staffName && (
        <div><span className="font-medium text-foreground">Held by:</span> {staffName}</div>
      )}
      {reason && (
        <div><span className="font-medium text-foreground">Reason:</span> {reason}</div>
      )}
      {resolvedByName && (
        <div><span className="font-medium text-foreground">Resolved by:</span> {resolvedByName}</div>
      )}
      <p className="text-xs text-muted-foreground">
        Written off — recorded as not needing to come back. Stock levels were not changed.
      </p>
    </div>
  )
}

// A loan_request's 'update' entries (counter/accept/decline/expire/no-show/
// withdraw) are usually just a status/date transition — the generic
// FieldDiff already shows those well. Two entries carry richer, purpose-
// built snapshots instead of a plain before/after diff:
//   - the 'create' entry (before === null): the original ask — staff,
//     requested window, message, item/qty totals (see the item list below,
//     lazily fetched the same way as TransactionSummary's transaction_lines).
//   - declining an already-*countered* request (after.countered_lines is an
//     array): declineRequest() freezes the whole counter offer — the
//     staff's original message, the requested-vs-offered/removed line
//     comparison, Jonathan's counter message, and his decline message — into
//     this one entry, since none of that survives on the live document once
//     status flips to 'declined'. This snapshot is self-contained (no lazy
//     fetch needed).
function LoanRequestSummary({
  before, after, lines,
}: {
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  lines: LoanRequestLine[] | undefined
}) {
  if (!after) return <p className="text-sm text-muted-foreground">No details recorded.</p>

  if (before !== null) {
    // Every transition now writes a full snapshot (requestAuditSnapshot
    // in loanRequests.ts), so this branch handles them all. It is checked
    // BEFORE the countered_lines branch below, which only ever applies to
    // a decline of an already-countered request and would otherwise
    // shadow the richer view.
    if (Array.isArray(after.lines)) {
      const frozen = after.lines as {
        product_id?: string; product_name?: string
        requested_quantity?: number; offered_quantity?: number
      }[]
      const staffName = typeof after.staff_name === 'string' ? after.staff_name : null
      const staffId = typeof after.staff_id === 'string' ? after.staff_id : null
      const fromDate = typeof after.from_date === 'string' ? after.from_date : null
      const toDate = typeof after.to_date === 'string' ? after.to_date : null
      const origFrom = typeof after.original_from_date === 'string' ? after.original_from_date : null
      const origTo = typeof after.original_to_date === 'string' ? after.original_to_date : null
      const datesMoved = origFrom !== null && (origFrom !== fromDate || origTo !== toDate)
      const status = typeof after.status === 'string' ? after.status : ''

      const reference = typeof after.reference_no === 'string' ? after.reference_no : null

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
              <span className="font-medium text-foreground">Staff member:</span> {staffName}
              {staffId && (
                <span className="ml-1.5 font-mono text-xs text-muted-foreground">({staffId})</span>
              )}
            </div>
          )}
          <div>
            <span className="font-medium text-foreground">
              {status === 'no_show' || status === 'accepted' || status === 'fulfilled'
                ? 'Pickup window:'
                : 'Requested window:'}
            </span>{' '}
            {formatLendWindow(fromDate, toDate)}
            {datesMoved && (
              <span className="ml-1.5 text-xs text-muted-foreground">
                (originally {formatLendWindow(origFrom, origTo)})
              </span>
            )}
          </div>
          <div>
            <span className="font-medium text-foreground">Items:</span>{' '}
            {frozen.length} item{frozen.length === 1 ? '' : 's'}
            {typeof after.total_qty === 'number' && ` · ${after.total_qty} units`}
          </div>
          {frozen.length > 0 ? (
            <ul className="ml-4 list-disc">
              {frozen.map((l, i) => (
                <li key={i}>
                  {l.product_name ?? 'Unknown product'}{' '}
                  <span className="text-muted-foreground">× {l.offered_quantity ?? 0}</span>
                  {l.offered_quantity !== l.requested_quantity && (
                    <span className="text-muted-foreground"> (requested {l.requested_quantity ?? 0})</span>
                  )}
                  {l.product_id && (
                    <span className="ml-1.5 font-mono text-xs text-muted-foreground">{l.product_id}</span>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">No line items recorded.</p>
          )}
          {/* The staff member's own note from submission. It rides along
              on every snapshot, and on a counter it's the half of the
              exchange Jonathan was replying to — reading his counter
              without it only tells you half the story. */}
          {typeof after.message === 'string' && after.message && (
            <div>
              <span className="font-medium text-foreground">Staff&apos;s message:</span>{' '}
              <span className="text-foreground">&ldquo;{after.message}&rdquo;</span>
            </div>
          )}
          {/* Jonathan's note to the staff member. admin_message is shared
              between a counter and a decline (they're mutually exclusive
              transitions), so the label follows the status. It is in the
              payload either way — rendering it only on a counter would
              hide a message that was actually sent. */}
          {typeof after.admin_message === 'string' && after.admin_message && (
            <div>
              <span className="font-medium text-foreground">
                {status === 'countered' ? 'Counter message:' : 'Message to staff:'}
              </span>{' '}
              <span className="text-foreground">&ldquo;{after.admin_message}&rdquo;</span>
            </div>
          )}
          {/* Stated rather than omitted: a no-show or expiry means nothing
              was ever issued, so there is no transaction to look up and no
              stock movement. An absent field would read as missing data. */}
          <div>
            <span className="font-medium text-foreground">Fulfilled transaction:</span>{' '}
            {typeof after.fulfilled_txn_id === 'string' && after.fulfilled_txn_id ? (
              <span className="font-mono text-xs">
                {typeof after.fulfilled_txn_ref === 'string' && after.fulfilled_txn_ref
                  ? after.fulfilled_txn_ref
                  : after.fulfilled_txn_id}
              </span>
            ) : status === 'no_show' || status === 'expired' ? (
              <span className="text-muted-foreground">
                none — nothing was issued, stock was never taken off the shelf
              </span>
            ) : (
              <span className="text-muted-foreground">not yet issued</span>
            )}
          </div>
        </div>
      )
    }
    if (Array.isArray(after.countered_lines)) {
      const staffMessage = typeof after.staff_message === 'string' && after.staff_message ? after.staff_message : null
      const counterMessage = typeof after.counter_message === 'string' && after.counter_message ? after.counter_message : null
      const declineMessage = typeof after.admin_message === 'string' && after.admin_message ? after.admin_message : null
      const counteredLines = after.countered_lines as { product_name?: string; requested_quantity?: number; offered_quantity?: number }[]

      return (
        <div className="flex flex-col gap-1.5 text-sm">
          {staffMessage && (
            <div><span className="font-medium text-foreground">Staff&apos;s message:</span> &ldquo;{staffMessage}&rdquo;</div>
          )}
          <div>
            <span className="font-medium text-foreground">Counter offered (declined):</span>
            {counteredLines.length > 0 ? (
              <ul className="ml-4 list-disc">
                {counteredLines.map((l, i) => (
                  <li key={i}>
                    {l.product_name ?? 'Unknown product'}{' '}
                    <span className="text-muted-foreground">— requested {l.requested_quantity ?? '—'},</span>{' '}
                    {(l.offered_quantity ?? 0) > 0
                      ? <>offered <span className="font-semibold">{l.offered_quantity}</span></>
                      : <span className="font-semibold text-destructive">removed</span>}
                  </li>
                ))}
              </ul>
            ) : (
              <span className="text-muted-foreground"> No line items recorded.</span>
            )}
          </div>
          {counterMessage && (
            <div><span className="font-medium text-foreground">Counter message:</span> &ldquo;{counterMessage}&rdquo;</div>
          )}
          {declineMessage && (
            <div><span className="font-medium text-foreground">Decline message:</span> &ldquo;{declineMessage}&rdquo;</div>
          )}
        </div>
      )
    }
    // An automatic no-show / expiry transition (see expireIfNeeded in
    // loanRequests.ts). It freezes the whole picture into `after` so the
    // entry stands on its own: who was meant to collect, what was in it,
    // and the window that lapsed. Recognised by the frozen `lines` array,
    // the same way the countered case is recognised by countered_lines.

    return <FieldDiff before={before} after={after} />
  }

  const staffName = typeof after.staff_name === 'string' ? after.staff_name : null
  const fromDate = typeof after.from_date === 'string' ? after.from_date : null
  const toDate = typeof after.to_date === 'string' ? after.to_date : null
  const message = typeof after.message === 'string' && after.message ? after.message : null
  const lineCount = typeof after.line_count === 'number' ? after.line_count : null
  const totalQty = typeof after.total_qty === 'number' ? after.total_qty : null

  const reference = typeof after.reference_no === 'string' ? after.reference_no : null
  // Items frozen into the entry at submission. Null for entries written
  // before submit recorded them, which then fall back to the join.
  const createFrozenLines = Array.isArray(after.lines)
    ? (after.lines as { product_name?: string; requested_quantity?: number }[])
    : null

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
      {(fromDate || toDate) && (
        <div>
          <span className="font-medium text-foreground">Requested window:</span>{' '}
          {formatDateOnly(fromDate)} – {formatDateOnly(toDate)}
        </div>
      )}
      {message && (
        <div>
          <span className="font-medium text-foreground">Message:</span> &ldquo;{message}&rdquo;
        </div>
      )}
      {(lineCount !== null || totalQty !== null) && (
        <div>
          <span className="font-medium text-foreground">Items:</span>{' '}
          {lineCount ?? '—'} item{lineCount === 1 ? '' : 's'} · {totalQty ?? '—'} units requested
        </div>
      )}
      {/* Prefer the items frozen into the entry; fall back to the join for
          entries written before submit started recording them. */}
      {createFrozenLines ? (
        createFrozenLines.length > 0 ? (
          <ul className="ml-4 list-disc">
            {createFrozenLines.map((l, i) => (
              <li key={i}>
                {l.product_name ?? 'Unknown product'}{' '}
                <span className="text-muted-foreground">× {l.requested_quantity}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">No line items recorded.</p>
        )
      ) : lines === undefined ? (
        <p className="text-xs text-muted-foreground">Loading items…</p>
      ) : lines.length > 0 ? (
        <ul className="ml-4 list-disc">
          {lines.map((l) => (
            <li key={l.id}>
              {l.product_name ?? 'Unknown product'} <span className="text-muted-foreground">× {l.requested_quantity}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">No line items recorded.</p>
      )}
    </div>
  )
}

// Flattens an audit entry's `after` snapshot into plain text for the CSV
// export — every field it has, as "field_name: value |", one field per
// LINE, rather than left as a pretty-printed multi-line JSON blob. This
// still produces one CSV cell (downloadCsv quotes any value containing a
// newline, so it stays one cell, not extra rows) -- the embedded line
// breaks are deliberate: with Excel's Wrap Text turned on, each field
// renders on its own line inside that one cell, like a small card. The
// trailing " |" on every line but the last keeps the pipe-separator look
// Jonathan already knows, while the line break does the actual visual
// separating -- this reads far better than either a single "|"-joined
// line or a raw JSON dump. Field NAMES are kept exactly as they are in
// Firestore (reference_no, not "Reference") rather than run through
// friendlyLabel — Jonathan cross-references these against the raw-data
// JSON view, so the two need to say the same thing. Field VALUES still go
// through friendlyValue for the same date/status/boolean formatting the
// on-screen views use.
function flattenValueForCsv(key: string, value: unknown, noPipes = false): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return '—'
    // An array of line items (after.lines, countered_lines, etc.) — show
    // each as "Product × qty", the same shorthand the on-screen item lists
    // already use, rather than a raw object dump. A plain array of
    // primitives (e.g. a product's barcodes) falls through to friendlyValue.
    if (typeof value[0] === 'object' && value[0] !== null) {
      return (value as Record<string, unknown>[]).map((item) => {
        const name = item.product_name ?? item.name
        const qty = item.quantity ?? item.offered_quantity ?? item.requested_quantity
        // Barcodes scanned for the line (Stock Out), pipe-separated with a
        // space either side and wrapped in brackets so they can't be mistaken
        // for the " |" that separates whole fields in this cell.
        // With per-barcode quantities (newer entries) each barcode carries its
        // count -- "A ×2 | B ×1"; older entries only have the plain list.
        const bqs = item.barcode_quantities
        const barcodes = Array.isArray(bqs) && bqs.length > 0
          ? ` [${formatBarcodeQuantities(bqs as { barcode: string; quantity: number }[]).join(noPipes ? ', ' : ' | ')}]`
          : Array.isArray(item.barcodes) && item.barcodes.length > 0
            ? ` [${(item.barcodes as unknown[]).join(noPipes ? ', ' : ' | ')}]`
            : ''
        if (typeof name === 'string') return (qty !== undefined && qty !== null ? `${name} × ${qty}` : name) + barcodes
        return JSON.stringify(item)
      // PDF: one product per line (comma after each but the last); CSV keeps
      // them on one line.
      }).join(noPipes ? ',\n' : ', ')
    }
    return friendlyValue(key, value)
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${k}: ${friendlyValue(k, v)}`)
      .join(', ')
  }
  return friendlyValue(key, value)
}

function flattenAfterForCsv(after: Record<string, unknown> | null): string {
  if (!after) return '— (none)'
  return Object.keys(after)
    .map((key) => `${key}: ${flattenValueForCsv(key, after[key])}`)
    .join(' |\n')
}

// The same flattened text for the PDF export, minus every pipe: one field per
// line with no trailing " |", and the barcodes inside a line's brackets joined
// with commas instead of " | ". (A PDF cell wraps the lines itself, so the
// pipes that kept fields apart in a one-cell CSV have nothing left to do.)
function flattenAfterForPdf(after: Record<string, unknown> | null): string {
  if (!after) return '— (none)'
  return Object.keys(after)
    .map((key) => `${key}: ${flattenValueForCsv(key, after[key], true)}`)
    .join('\n')
}

// Sortable columns for the table header — same shadcn-data-table pattern
// (and the same shared columnHelper/SortableHead) as the four Reports
// tables. Activity and Entity sort on the same derived display text the
// column and its filter dropdown already agree on (activityLabel/
// ENTITY_LABEL), not the raw action/entity_type, so the sort order matches
// what's actually printed in the cell.
const AUDIT_LOG_COLUMNS = sortableColumnHelper.columns([
  sortableColumnHelper.accessor('created_at', { id: 'created_at', header: 'Date', sortFn: 'datetime' }),
  sortableColumnHelper.accessor((e: AuditLogEntry) => e.user_name ?? '', { id: 'user_name', header: 'User', sortFn: 'alphanumeric' }),
  sortableColumnHelper.accessor((e: AuditLogEntry) => activityLabel(activityKey(e)), { id: 'activity', header: 'Activity', sortFn: 'alphanumeric' }),
  sortableColumnHelper.accessor((e: AuditLogEntry) => ENTITY_LABEL[e.entity_type] ?? e.entity_type, { id: 'entity_type', header: 'Entity', sortFn: 'alphanumeric' }),
  sortableColumnHelper.accessor('entity_id', { id: 'entity_id', header: 'Entity ID', sortFn: 'alphanumeric' }),
])

export default function AuditLogPage() {
  const [entries, setEntries] = useState<AuditLogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [entityFilter, setEntityFilter] = useState<string[]>([])
  const [actionFilter, setActionFilter] = useState<string[]>([])
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [sorting, setSorting] = useState<SortingState>([])
  const [pageIndex, setPageIndex] = useState(0)
  const [pageSize, setPageSize] = useState<PageSize>(10)
  const { isExpanded, toggle: toggleRow } = useExpandedRows()
  // Keyed by transaction entity_id — the product lines of the transaction
  // entries that did not freeze them into their payload (the server looks
  // them up along with the entries, so expanding a row needs no fetch).
  const [lines, setLines] = useState<Record<string, TransactionLine[]>>({})
  // Same idea, for a loan_request's 'create' entry — see LoanRequestSummary.
  const [loanLines, setLoanLines] = useState<Record<string, LoanRequestLine[]>>({})

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      try {
        // Newest first, both ends of the date range inclusive, on the
        // calendar day in Africa/Johannesburg the entry was written — an entry
        // timestamped 00:01 belongs to the day that has just started, which
        // is not what its UTC `created_at` string says. Decided on the
        // server, so it is the same wherever this page is opened.
        const result = await loadAuditLog({ from: fromDate, to: toDate })
        if (cancelled) return
        setEntries(result.entries)
        setLines(result.transactionLines)
        setLoanLines(result.loanRequestLines)
      } catch (err) {
        if (cancelled) return
        // Don't leave the previous range's rows on screen (and in the exports)
        // under a date filter they don't answer.
        console.error('Failed to load the audit log', err)
        setEntries([])
        setLines({})
        setLoanLines({})
        toast.error(err instanceof Error ? err.message : 'Something went wrong.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [fromDate, toDate])

  const filtered = entries.filter(e =>
    (entityFilter.length === 0 || entityFilter.includes(e.entity_type)) &&
    (actionFilter.length === 0 || actionFilter.includes(activityKey(e)))
  )

  const table = useTable({
    features: SORTABLE_TABLE_FEATURES,
    columns: AUDIT_LOG_COLUMNS,
    data: filtered,
    state: { sorting },
    onSortingChange: setSorting,
  })
  // Cast back to AuditLogEntry: the shared columnHelper types rows as `any`
  // (see data-table-helpers.tsx — one loose helper shared by every sortable
  // table rather than a typed one per table), but every row here really is
  // an AuditLogEntry, and the JSX below indexes ENTITY_LABEL (a strict
  // Record<AuditEntityType, string>) by e.entity_type — that only
  // typechecks once `e` is typed again, rather than `any`.
  const sorted = table.getSortedRowModel().rows.map(r => r.original as AuditLogEntry)
  const { pageRows, safeIndex } = paginate(sorted, pageIndex, pageSize)

  // Picking an entity narrows the Activity dropdown to the activities that
  // entity can actually produce — no point offering "Out" under Staff.
  const allowedActivityKeys = activityKeysFor(entityFilter)
  const visibleActivityGroups = ACTIVITY_GROUPS
    .map(g => ({ ...g, keys: g.keys.filter(k => allowedActivityKeys.includes(k)) }))
    .filter(g => g.keys.length > 0)

  // Changing entity can invalidate the current activity (e.g. Transaction +
  // "Out", then switching to Staff). Clear it in the same update rather
  // than leaving a selection that silently matches nothing.
  function changeEntity(next: string[]) {
    setEntityFilter(next)
    const allowed = activityKeysFor(next)
    setActionFilter(prev => (prev.every(k => allowed.includes(k)) ? prev : prev.filter(k => allowed.includes(k))))
  }

  // Renders from activityKey(), the same value the filter compares
  // against — so what you see is exactly what you can filter by.
  function activityBadge(e: AuditLogEntry) {
    const key = activityKey(e)
    const meta = ACTIVITY[key]
    return (
      <Badge className={meta?.className ?? ''}>
        {sentenceCase(activityLabel(key))}
      </Badge>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-6 space-y-1">
        <h1 className="text-3xl font-extrabold tracking-tight text-[#22162B]">Audit Log</h1>
        <p className="text-sm text-[#5B4F67]">
          Who changed what, and when — product, category, staff and transaction activity.
        </p>
      </div>

      <Card className="mb-4 rounded-xl border border-[#E2D8E9] bg-white shadow-sm ring-0">
        <CardContent>
        <CollapsibleFilters
          label="Filters"
          className="flex-wrap items-end gap-3"
          summary={`${filtered.length} ${filtered.length === 1 ? 'entry' : 'entries'}`}
          active={entityFilter.length > 0 || actionFilter.length > 0 || !!fromDate || !!toDate}
        >
        <div className="grid gap-1.5">
          <span className="text-sm font-semibold text-slate-600">Entities</span>
          <MultiSelect
            className="w-44"
            placeholder="All entities"
            value={entityFilter}
            onChange={changeEntity}
            groups={[{ options: ENTITY_OPTIONS }]}
          />
        </div>
        <div className="grid gap-1.5">
          <span className="text-sm font-semibold text-slate-600">Activities</span>
          <MultiSelect
            className="w-52"
            placeholder="All activity"
            value={actionFilter}
            onChange={setActionFilter}
            groups={visibleActivityGroups.map(g => ({
              label: g.label,
              options: g.keys.map(k => ({ value: k, label: activityLabel(k) })),
            }))}
          />
        </div>
        {/* A date input ignores `placeholder`, so these two were the only
            unlabelled controls on the row — the browser's own dd/mm/yyyy
            hint was all there was to say which end of the range each one
            set. htmlFor/id so clicking the label focuses the input. */}
        <div className="grid gap-1.5">
          <label htmlFor="audit-from-date" className="text-sm font-semibold text-slate-600">
            From date
          </label>
          <AvailabilityDatePicker id="audit-from-date" clearable className="w-40 border-slate-300 bg-white text-slate-700"
            value={fromDate} onChange={setFromDate} />
        </div>
        <div className="grid gap-1.5">
          <label htmlFor="audit-to-date" className="text-sm font-semibold text-slate-600">
            To date
          </label>
          <AvailabilityDatePicker id="audit-to-date" clearable className="w-40 border-slate-300 bg-white text-slate-700"
            value={toDate} min={fromDate || undefined} onChange={setToDate} />
        </div>
        {(entityFilter.length > 0 || actionFilter.length > 0 || fromDate || toDate) && (
          <Button variant="ghost" onClick={() => { setEntityFilter([]); setActionFilter([]); setFromDate(''); setToDate('') }}>Clear filters</Button>
        )}
        <span className="self-end pb-2 text-sm text-muted-foreground">{filtered.length} entries</span>
        {/* Exports every filtered+sorted entry (never just the current
            pagination page) with the after state flattened to one
            plain-text line per entry (flattenAfterForCsv) rather than
            pretty-printed JSON — a JSON dump's embedded newlines wrap a
            single entry across several visual lines once opened in Excel.
            Enough for Jonathan to work out what changed by comparing one
            entity's entries against each other, without carrying the
            redundant before snapshot (already the previous row's after)
            on every line. */}
        <ExportCsvButton
          disabled={loading}
          filename={`audit-log-${todayDateStr()}.csv`}
          rows={sorted}
          columns={[
            { header: 'Date', value: (e: AuditLogEntry) => formatDate(e.created_at) },
            { header: 'User', value: (e: AuditLogEntry) => e.user_name ?? '—' },
            { header: 'Activity', value: (e: AuditLogEntry) => activityLabel(activityKey(e)) },
            { header: 'Entity', value: (e: AuditLogEntry) => ENTITY_LABEL[e.entity_type] ?? e.entity_type },
            { header: 'Entity ID', value: (e: AuditLogEntry) => e.entity_id },
            { header: 'Details', value: (e: AuditLogEntry) => flattenAfterForCsv(reorderForDisplay(e.entity_type, e.action, e.after)) },
          ]}
          className="ml-auto"
        />
        {/* Same entries and columns as the CSV, as a PDF table under an
            "Audit Log Report" title, with the Details column free of pipes. */}
        <ExportPdfButton
          disabled={loading}
          filename={`audit-log-${todayDateStr()}.pdf`}
          title="Audit Log Report"
          subtitle={[
            `Compiled ${formatDateOnly(todayDateStr())}  ·  ${sorted.length} ${sorted.length === 1 ? 'entry' : 'entries'}`,
            // Nothing ticked means "everything", so spell every entity and
            // activity out rather than leaving the line off.
            `Entities: ${(entityFilter.length ? entityFilter : ENTITY_OPTIONS.map(o => o.value)).map(en => ENTITY_LABEL[en as AuditEntityType] ?? en).join(', ')}`,
            `Activities: ${(actionFilter.length ? actionFilter : ACTIVITY_GROUPS.flatMap(g => g.keys)).map(activityLabel).join(', ')}`,
            fromDate || toDate
              ? `Dates: ${fromDate ? formatDateOnly(fromDate) : 'earliest entry'} to ${toDate ? formatDateOnly(toDate) : 'latest entry'}`
              : 'Dates: All dates (full system log)',
          ].filter(Boolean)}
          rows={sorted}
          columns={[
            { header: 'Date', width: 118, value: (e: AuditLogEntry) => formatDate(e.created_at) },
            { header: 'User', width: 74, value: (e: AuditLogEntry) => e.user_name ?? '—' },
            { header: 'Activity', width: 88, value: (e: AuditLogEntry) => activityLabel(activityKey(e)) },
            { header: 'Entity', width: 76, value: (e: AuditLogEntry) => ENTITY_LABEL[e.entity_type] ?? e.entity_type },
            { header: 'Entity ID', width: 134, value: (e: AuditLogEntry) => e.entity_id },
            { header: 'Details', value: (e: AuditLogEntry) => flattenAfterForPdf(reorderForDisplay(e.entity_type, e.action, e.after)) },
          ]}
        />
        </CollapsibleFilters>
        </CardContent>
      </Card>

      <Card className="min-h-0 flex-1 rounded-xl border border-[#E2D8E9] bg-white py-0 shadow-sm ring-0">
        <div className="min-h-0 flex-1 overflow-y-auto">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-[#F0EBF5]">
            <TableRow className="border-b border-[#E0D5E7] hover:bg-[#F0EBF5]">
              <TableHead className="h-auto w-8 py-3.5 pl-6"></TableHead>
              <SortableHead column={table.getColumn('created_at')!} className="h-auto py-3.5 text-base font-bold text-[#2D203A]">Date</SortableHead>
              <SortableHead column={table.getColumn('user_name')!} className="h-auto py-3.5 text-base font-bold text-[#2D203A]">User</SortableHead>
              <SortableHead column={table.getColumn('activity')!} className="h-auto py-3.5 text-base font-bold text-[#2D203A]">Activity</SortableHead>
              <SortableHead column={table.getColumn('entity_type')!} className="h-auto py-3.5 text-base font-bold text-[#2D203A]">Entity</SortableHead>
              <SortableHead column={table.getColumn('entity_id')!} className="h-auto py-3.5 pr-6 text-base font-bold text-[#2D203A]">Entity ID</SortableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && <TableRow><TableCell colSpan={6} className="py-8 text-center text-muted-foreground">Loading…</TableCell></TableRow>}
            {!loading && filtered.length === 0 && <TableRow><TableCell colSpan={6} className="py-8 text-center text-muted-foreground">No audit entries found</TableCell></TableRow>}
            {pageRows.map(e => (
              <Fragment key={e.id}>
                <TableRow className="group cursor-pointer hover:bg-[#FAF7FC]" onClick={() => toggleRow(e.id)}>
                  <TableCell className="py-4 pl-6 text-xs text-slate-600 transition-colors group-hover:text-primary">{isExpanded(e.id) ? '▲' : '▼'}</TableCell>
                  <TableCell className="py-4 text-sm text-slate-600">{formatDate(e.created_at)}</TableCell>
                  <TableCell className="max-w-xs py-4 text-sm font-semibold whitespace-normal break-words text-slate-900 transition-colors group-hover:text-primary">{e.user_name ?? '—'}</TableCell>
                  <TableCell className="py-4">{activityBadge(e)}</TableCell>
                  <TableCell className="py-4 text-sm text-slate-600">{ENTITY_LABEL[e.entity_type] ?? e.entity_type}</TableCell>
                  <TableCell className="py-4 pr-6 font-mono text-sm text-slate-600">{e.entity_id}</TableCell>
                </TableRow>
                {isExpanded(e.id) && (
                  <TableRow className="border-y border-[#E2D8E9]/80 bg-[#FBF9FD] shadow-inner hover:bg-[#FBF9FD]">
                    {/* TableCell is whitespace-nowrap by default (see
                        components/ui/table.tsx), which is right for the data
                        rows but wrong here: this cell holds prose — a staff
                        member's message can be a paragraph — and nowrap makes
                        its min-content width the entire message, dragging the
                        whole table past the viewport. Wrap instead, and
                        break-words so an unbroken token (a long id, a pasted
                        URL) still can't push it wide. */}
                    <TableCell colSpan={6} className="px-8 py-6 break-words whitespace-normal">
                      {e.entity_type === 'transaction' ? (
                        e.action === 'resolve' ? (
                          <ResolveSummary after={e.after} />
                        ) : (
                          <TransactionSummary after={e.after} lines={lines[e.entity_id]} />
                        )
                      ) : e.entity_type === 'loan_request' ? (
                        <LoanRequestSummary before={e.before} after={e.after} lines={loanLines[e.entity_id]} />
                      ) : e.entity_type === 'staff' && (e.action === 'grant_access' || e.action === 'resend_access') ? (
                        <StaffAccessSummary after={e.after} granted={e.action === 'grant_access'} />
                      ) : e.entity_type === 'staff' && (e.action === 'activate' || e.action === 'deactivate') ? (
                        <StaffStatusSummary after={e.after} />
                      ) : e.entity_type === 'product' && e.action === 'update' ? (
                        <ProductUpdateSummary before={e.before} after={e.after} />
                      ) : (
                        <FieldDiff before={e.before} after={e.after} />
                      )}
                      <details className="mt-3">
                        <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                          Show raw data
                        </summary>
                        <div className="mt-2 grid grid-cols-2 gap-3">
                          <div>
                            <div className="mb-1 text-xs font-bold text-muted-foreground">Before</div>
                            <pre className="m-0 overflow-x-auto rounded-md border bg-background p-3 text-xs whitespace-pre-wrap break-words text-muted-foreground">
                              {e.before ? JSON.stringify(reorderForDisplay(e.entity_type, e.action, e.before), null, 2) : '— (none)'}
                            </pre>
                          </div>
                          <div>
                            <div className="mb-1 text-xs font-bold text-muted-foreground">After</div>
                            <pre className="m-0 overflow-x-auto rounded-md border bg-background p-3 text-xs whitespace-pre-wrap break-words text-muted-foreground">
                              {e.after ? JSON.stringify(reorderForDisplay(e.entity_type, e.action, e.after), null, 2) : '— (none)'}
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
        </div>
        <TablePagination
          pageIndex={safeIndex}
          pageSize={pageSize}
          totalRows={sorted.length}
          onPageIndexChange={setPageIndex}
          onPageSizeChange={setPageSize}
        />
      </Card>
    </div>
  )
}

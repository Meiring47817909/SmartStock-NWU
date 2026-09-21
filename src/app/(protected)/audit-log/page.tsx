'use client'

import { Fragment, useEffect, useState } from 'react'
import { formatDate, formatDateOnly } from '@/lib/utils'
import { db } from '@/lib/firebase/config'
import { LENDING_INTERVALS } from '@/lib/firebase/loanRequests'
import { collection, query, orderBy, getDocs, where } from 'firebase/firestore'
import { Card } from '@/components/ui/card'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectLabel,
  SelectTrigger, SelectValue,
} from '@/components/ui/select'
import type { AuditLogEntry, AuditAction, AuditEntityType, TransactionLine, LoanRequestLine } from '@/types/database'

const ACTION_BADGE_CLASS: Record<AuditAction, string> = {
  create: 'bg-emerald-100 text-emerald-800',
  update: 'bg-sky-100 text-sky-800',
  activate: 'bg-emerald-100 text-emerald-800',
  deactivate: 'bg-accent text-accent-foreground',
  resolve: 'bg-violet-100 text-violet-800',
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
  loan_request: 'Loan Request',
}

// Same reasoning as TXN_BADGE_CLASS above — a loan_request audit entry
// always logs 'update' as its action (the interesting information is which
// status it moved to), so show the status instead of the generic verb.
const LOAN_REQUEST_BADGE_CLASS: Record<string, string> = {
  pending: 'bg-amber-100 text-amber-800',
  countered: 'bg-sky-100 text-sky-800',
  accepted: 'bg-emerald-100 text-emerald-800',
  fulfilled: 'bg-accent text-accent-foreground',
  declined: 'bg-red-100 text-red-800',
  expired: 'bg-muted text-muted-foreground',
  withdrawn: 'bg-muted text-muted-foreground',
  no_show: 'bg-red-100 text-red-800',
}

// Display labels for those same statuses. Only the ones whose raw value
// doesn't read correctly on its own need an entry — everything else falls
// back to the underscore-stripped value. 'no_show' is called "Not Picked
// Up" everywhere the admin actually sees it (the Dashboard's Incoming
// Pickups badge), so the Audit Log says the same thing.
const LOAN_REQUEST_STATUS_LABEL: Record<string, string> = {
  no_show: 'Not Picked Up',
}

function loanRequestStatusLabel(status: string): string {
  return LOAN_REQUEST_STATUS_LABEL[status] ?? status.replace('_', ' ')
}

const ALL_ENTITIES = '__all__'
const ALL_ACTIONS = '__all__'

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
  'status:no_show': { label: 'Not Picked Up', className: LOAN_REQUEST_BADGE_CLASS.no_show, entities: ['loan_request'] },

  'action:create': { label: 'Create', className: ACTION_BADGE_CLASS.create, entities: RECORD_ENTITIES },
  'action:update': { label: 'Update', className: ACTION_BADGE_CLASS.update, entities: RECORD_ENTITIES },
  // Only staff records can be activated or deactivated.
  'action:activate': { label: 'Activate', className: ACTION_BADGE_CLASS.activate, entities: ['staff'] },
  'action:deactivate': { label: 'Deactivate', className: ACTION_BADGE_CLASS.deactivate, entities: ['staff'] },
}

// Activity keys applicable to an entity filter ('' meaning "all entities").
function activityKeysFor(entity: string): string[] {
  return Object.keys(ACTIVITY).filter(
    k => !entity || ACTIVITY[k].entities.includes(entity as AuditEntityType),
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
  { label: 'Record changes', keys: ['action:create', 'action:update', 'action:activate', 'action:deactivate'] },
]

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
// transaction's entity_type/entity_id (see waivers.ts's createReturnWaiver)
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
//     comparison, Selouna's counter message, and her decline message — into
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
            <div><span className="font-medium text-foreground">Selouna&apos;s counter message:</span> &ldquo;{counterMessage}&rdquo;</div>
          )}
          {declineMessage && (
            <div><span className="font-medium text-foreground">Decline message:</span> &ldquo;{declineMessage}&rdquo;</div>
          )}
        </div>
      )
    }
    return <FieldDiff before={before} after={after} />
  }

  const staffName = typeof after.staff_name === 'string' ? after.staff_name : null
  const fromDate = typeof after.from_date === 'string' ? after.from_date : null
  const toDate = typeof after.to_date === 'string' ? after.to_date : null
  const message = typeof after.message === 'string' && after.message ? after.message : null
  const lineCount = typeof after.line_count === 'number' ? after.line_count : null
  const totalQty = typeof after.total_qty === 'number' ? after.total_qty : null

  return (
    <div className="flex flex-col gap-1.5 text-sm">
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
      {lines === undefined ? (
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
  // Same idea, for a loan_request's 'create' entry — see LoanRequestSummary.
  const [loanLines, setLoanLines] = useState<Record<string, LoanRequestLine[]>>({})

  useEffect(() => {
    async function load() {
      setLoading(true)
      const snap = await getDocs(query(collection(db, 'audit_log'), orderBy('created_at', 'desc')))
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
    (!actionFilter || activityKey(e) === actionFilter)
  )

  // Picking an entity narrows the Activity dropdown to the activities that
  // entity can actually produce — no point offering "Out" under Staff.
  const allowedActivityKeys = activityKeysFor(entityFilter)
  const visibleActivityGroups = ACTIVITY_GROUPS
    .map(g => ({ ...g, keys: g.keys.filter(k => allowedActivityKeys.includes(k)) }))
    .filter(g => g.keys.length > 0)

  // Changing entity can invalidate the current activity (e.g. Transaction +
  // "Out", then switching to Staff). Clear it in the same update rather
  // than leaving a selection that silently matches nothing.
  function changeEntity(next: string) {
    setEntityFilter(next)
    if (actionFilter && !activityKeysFor(next).includes(actionFilter)) {
      setActionFilter('')
    }
  }

  async function toggleExpand(e: AuditLogEntry) {
    if (expanded === e.id) { setExpanded(null); return }
    setExpanded(e.id)
    if (e.entity_type === 'transaction' && !lines[e.entity_id]) {
      const snap = await getDocs(query(collection(db, 'transaction_lines'), where('transaction_id', '==', e.entity_id)))
      const items = snap.docs.map(d => ({ id: d.id, ...d.data() })) as unknown as TransactionLine[]
      setLines(prev => ({ ...prev, [e.entity_id]: items }))
    }
    if (e.entity_type === 'loan_request' && e.before === null && !loanLines[e.entity_id]) {
      const snap = await getDocs(query(collection(db, 'loan_request_lines'), where('request_id', '==', e.entity_id)))
      const items = snap.docs.map(d => ({ id: d.id, ...d.data() })) as unknown as LoanRequestLine[]
      setLoanLines(prev => ({ ...prev, [e.entity_id]: items }))
    }
  }

  // Renders from activityKey(), the same value the filter compares
  // against — so what you see is exactly what you can filter by.
  function activityBadge(e: AuditLogEntry) {
    const key = activityKey(e)
    const meta = ACTIVITY[key]
    return (
      <Badge className={`${meta?.className ?? ''} uppercase`}>
        {activityLabel(key)}
      </Badge>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-foreground">Audit Log</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Who changed what, and when — product, category, staff and transaction activity.
        </p>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Select
          items={{ [ALL_ENTITIES]: 'All entities', product: 'Product', category: 'Category', staff: 'Staff', transaction: 'Transaction', loan_request: 'Loan Request' }}
          value={entityFilter || ALL_ENTITIES}
          onValueChange={v => changeEntity(v && v !== ALL_ENTITIES ? v : '')}
        >
          <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_ENTITIES}>All entities</SelectItem>
            <SelectItem value="product">Product</SelectItem>
            <SelectItem value="category">Category</SelectItem>
            <SelectItem value="staff">Staff</SelectItem>
            <SelectItem value="transaction">Transaction</SelectItem>
            <SelectItem value="loan_request">Loan Request</SelectItem>
          </SelectContent>
        </Select>
        <Select
          items={{
            [ALL_ACTIONS]: 'All activity',
            ...Object.fromEntries(
              visibleActivityGroups.flatMap(g => g.keys.map(k => [k, activityLabel(k)]))
            ),
          }}
          value={actionFilter || ALL_ACTIONS}
          onValueChange={v => setActionFilter(v && v !== ALL_ACTIONS ? v : '')}
        >
          <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_ACTIONS}>All activity</SelectItem>
            {visibleActivityGroups.map(group => (
              <SelectGroup key={group.label}>
                <SelectLabel>{group.label}</SelectLabel>
                {group.keys.map(k => (
                  <SelectItem key={k} value={k}>{activityLabel(k)}</SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
        <Input type="date" className="w-40" value={fromDate} onChange={e => setFromDate(e.target.value)} placeholder="From date" />
        <Input type="date" className="w-40" value={toDate} onChange={e => setToDate(e.target.value)} placeholder="To date" />
        {(entityFilter || actionFilter || fromDate || toDate) && (
          <Button variant="ghost" onClick={() => { setEntityFilter(''); setActionFilter(''); setFromDate(''); setToDate('') }}>Clear filters</Button>
        )}
        <span className="self-center text-sm text-muted-foreground">{filtered.length} entries</span>
      </div>

      <Card className="min-h-0 flex-1 py-0">
        <div className="min-h-0 flex-1 overflow-y-auto">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-card">
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>User</TableHead>
              <TableHead>Activity</TableHead>
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
                  <TableCell>{activityBadge(e)}</TableCell>
                  <TableCell className="text-muted-foreground">{ENTITY_LABEL[e.entity_type] ?? e.entity_type}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{e.entity_id}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{expanded === e.id ? '▲' : '▼'}</TableCell>
                </TableRow>
                {expanded === e.id && (
                  <TableRow className="bg-muted/50">
                    <TableCell colSpan={6} className="p-4">
                      {e.entity_type === 'transaction' ? (
                        e.action === 'resolve' ? (
                          <ResolveSummary after={e.after} />
                        ) : (
                          <TransactionSummary after={e.after} lines={lines[e.entity_id]} />
                        )
                      ) : e.entity_type === 'loan_request' ? (
                        <LoanRequestSummary before={e.before} after={e.after} lines={loanLines[e.entity_id]} />
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
        </div>
      </Card>
    </div>
  )
}

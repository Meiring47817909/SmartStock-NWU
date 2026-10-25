'use client'

import { Fragment, useEffect, useState } from 'react'
import { useExpandedRows } from '@/hooks/useExpandedRows'
import { toast } from 'sonner'
import { Search, Plus, Pencil, CreditCard, Mail, ChevronDown } from 'lucide-react'
import { postStaffAdmin } from '@/lib/firebase/staff'
import { normalizeEmail } from '@/lib/staffRules'
import {
  createStaff, findStaffEmailConflict, listStaff, loadStaffHoldings, resolveHeldItem, setStaffActive, updateStaff,
  type HeldItem as LentItem,
} from '@/lib/api/staff'
import { formatDateOnly, sentenceCase, todayDateStr } from '@/lib/utils'
import { useAuth } from '@/context/AuthContext'
import { useRole } from '@/context/RoleContext'
import { Card, CardContent } from '@/components/ui/card'
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import { useTable, type SortingState } from '@tanstack/react-table'
import { SORTABLE_TABLE_FEATURES, sortableColumnHelper, SortableHead } from '@/components/data-table-helpers'
import type { StaffMember } from '@/types/database'

// One item a staff member currently holds — an OUT line with a remaining
// balance, or one that's been written off via Resolve (Selouna agreed the
// staff member keeps it; it stays listed, never gets a Resolve button). The
// server works these out from the ledger (see getStaffHoldings); an outstanding
// row keeps its (transaction, product) pair so it can be resolved right here —
// same pair the Dashboard's Resolve button writes a waiver against. Shown in
// the same shape as the Dashboard's Outstanding Returns rows.
// Same urgency labels as the Dashboard's Outstanding Returns table, plus the
// terminal written-off state that only exists on this page.
function lentItemStatus(item: LentItem): { label: string; className: string } {
  if (item.waived) return { label: 'Resolved', className: 'bg-violet-100 text-violet-800 border-violet-200/60 px-2.5 font-semibold' }
  if (!item.expected_date) return { label: 'No Return Date', className: 'bg-slate-100 text-slate-700 border-slate-200/60 px-2.5 font-semibold' }
  const today = todayDateStr()
  if (today > item.expected_date) return { label: 'Overdue', className: 'bg-red-100 text-red-800 border-red-200/60 px-2.5 font-semibold' }
  if (today === item.expected_date) return { label: 'Due Today', className: 'bg-amber-100 text-amber-800 border-amber-200/60 px-2.5 font-semibold' }
  return { label: 'Not Due Yet', className: 'bg-emerald-100 text-emerald-800 border-emerald-200/60 px-2.5 font-semibold' }
}

// The three values the Status column already badges (see the TableCell
// below) — Active/Deactivated is_active's own two states, with Lending
// carved out of "active" for anyone currently holding stock. A staff
// member is never in more than one of these at once, same as the Reports
// page's own STOCK_STATUS_VALUES treats IN/LOW/OUT STOCK as one mutually
// exclusive bucket per row rather than overlapping flags.
const STAFF_STATUS_VALUES = ['Active', 'Lending', 'Deactivated'] as const
const STAFF_STATUS_DOT: Record<string, string> = {
  Active: 'bg-emerald-500',
  Lending: 'bg-(--nwu-purple)',
  Deactivated: 'bg-red-500',
}

// Sorting the Status column needs *some* order for its three values — same
// convention as the Products page's PRODUCT_STATUS_RANK and the Dashboard's
// PICKUP_STATUS_RANK.
const STAFF_STATUS_RANK: Record<string, number> = {
  Active: 0,
  Lending: 1,
  Deactivated: 2,
}

function staffStatusValue(s: { is_active: boolean }, lendingIds: Set<string>, id: string): string {
  if (!s.is_active) return 'Deactivated'
  return lendingIds.has(id) ? 'Lending' : 'Active'
}

// Same DropdownMenuCheckboxItem + SelectAllMenuItems pattern as every other
// multi-select filter in the app (Reports' Category/Stock Status, the
// Products page's own Status/Available).
function SelectAllMenuItems({ onSelectAll, onUnselectAll }: { onSelectAll: () => void; onUnselectAll: () => void }) {
  return (
    <>
      <DropdownMenuItem closeOnClick={false} onClick={onSelectAll}>Select all</DropdownMenuItem>
      <DropdownMenuItem closeOnClick={false} onClick={onUnselectAll}>Unselect all</DropdownMenuItem>
      <DropdownMenuSeparator />
    </>
  )
}

function staffStatusFilterLabel(selected: Set<string>): string {
  if (selected.size === 0) return 'No statuses'
  if (selected.size === STAFF_STATUS_VALUES.length) return 'All statuses'
  if (selected.size === 1) return [...selected][0]
  return 'Custom'
}

function StaffStatusFilter({
  selected, onChange,
}: {
  selected: Set<string>
  onChange: (next: Set<string>) => void
}) {
  function toggle(value: string, checked: boolean) {
    const next = new Set(selected)
    if (checked) next.add(value)
    else next.delete(value)
    onChange(next)
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" className="w-40 justify-between font-normal" />}>
        <span className="truncate">{staffStatusFilterLabel(selected)}</span>
        <ChevronDown className="size-3.5 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-44">
        <SelectAllMenuItems
          onSelectAll={() => onChange(new Set(STAFF_STATUS_VALUES))}
          onUnselectAll={() => onChange(new Set())}
        />
        {STAFF_STATUS_VALUES.map(value => (
          <DropdownMenuCheckboxItem
            key={value}
            checked={selected.has(value)}
            onCheckedChange={checked => toggle(value, checked)}
          >
            <span className={`size-2 rounded-full ${STAFF_STATUS_DOT[value]}`} />
            {value}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

type FormData = {
  name: string; surname: string; email: string
  department: string; card_uid: string
}

function staffDisplayName(s: { full_name?: string | null; name?: string | null; surname?: string | null }): string {
  return s.full_name || [s.name, s.surname].filter(Boolean).join(' ') || 'This staff member'
}

const EMPTY_FORM: FormData = { name: '', surname: '', email: '', department: '', card_uid: '' }

export default function StaffPage() {
  const { user } = useAuth()
  const { isAdmin } = useRole()
  const [allStaff, setAllStaff] = useState<StaffMember[]>([])
  const [search, setSearch] = useState('')
  // Active/Deactivated/Lending — the same three values the Status column
  // badges — as a multi-select rather than the Active/Deactivated-only tab
  // pair this used to be: Lending used to only be visible as a badge
  // within the Active tab, with no way to isolate just the people
  // currently holding stock (or to hide them while still seeing everyone
  // else who's Active).
  const [statusFilter, setStatusFilter] = useState<Set<string>>(new Set(STAFF_STATUS_VALUES))
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [editing, setEditing] = useState<StaffMember | null>(null)
  const [form, setForm] = useState<FormData>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [sendingId, setSendingId] = useState<string | null>(null)
  // Staff IDs with at least one OUT transaction line not yet fully returned.
  // This is what the Status badge shows now — NOT is_active (that's the
  // separate Deactivate/Activate action). See loadLendingStatus().
  const [lendingStaffIds, setLendingStaffIds] = useState<Set<string>>(new Set())
  // Everything each staff member currently holds, keyed by staff id —
  // built in the same single pass as lendingStaffIds below, so expanding a
  // row costs no extra reads.
  const [lentByStaff, setLentByStaff] = useState<Record<string, LentItem[]>>({})
  const { isExpanded: isStaffExpanded, toggle: toggleStaff } = useExpandedRows()
  // The item Selouna has clicked Resolve on in a staff member's expanded
  // list, held while the confirmation dialog is open — same write as the
  // Dashboard's Resolve button (a return_waivers doc), just triggered from
  // here instead, for the case where she's already looking at this
  // person's held items and knows right then it's not coming back.
  const [resolving, setResolving] = useState<{ staffId: string; staffName: string; item: LentItem } | null>(null)
  const [resolveReason, setResolveReason] = useState('')
  const [resolveBusy, setResolveBusy] = useState(false)
  // NFR-010: Deactivate/Activate asks first; this is the staff member awaiting confirmation.
  const [confirmingToggle, setConfirmingToggle] = useState<StaffMember | null>(null)
  const [toggleBusy, setToggleBusy] = useState(false)
  const [sorting, setSorting] = useState<SortingState>([])

  async function load() {
    setLoading(true)
    try {
      // Selouna's own self-service record (created via My Profile, so she can
      // be picked as a Stock Out borrower) isn't a staff member to manage
      // here -- the server leaves it out unless asked for.
      setAllStaff(await listStaff())
    } catch (err) {
      console.error(err)
    }
    setLoading(false)
  }

  // Searching narrows what's already loaded -- no re-read per keystroke.
  const needle = search.toLowerCase()
  const staff = needle
    ? allStaff.filter(st =>
        (st.full_name && st.full_name.toLowerCase().includes(needle)) ||
        (st.department && st.department.toLowerCase().includes(needle))
      )
    : allStaff

  // A staff member counts as "Lending" if they hold at least one item: an OUT
  // line whose issued quantity hasn't been fully returned yet, or one that's
  // been written off (still in their possession). The server works this out
  // from the ledger -- a return is matched to its specific originating OUT
  // transaction via linked_txn_id, not lumped into a flat per-product total
  // (see getStaffHoldings in src/server/data/staff.ts) -- and only lists staff
  // who hold something. Independent of the search box, so it's loaded once on
  // mount rather than re-run on every keystroke.
  async function loadLendingStatus() {
    try {
      const holdings = await loadStaffHoldings()
      const byStaff: Record<string, LentItem[]> = {}
      for (const [staffId, holding] of Object.entries(holdings)) byStaff[staffId] = holding.items
      setLendingStaffIds(new Set(Object.keys(byStaff)))
      setLentByStaff(byStaff)
    } catch (err) {
      console.error(err)
    }
  }

  useEffect(() => { load(); loadLendingStatus() }, [])

  function openAdd() {
    setEditing(null)
    setForm(EMPTY_FORM)
    setError('')
    setShowModal(true)
  }

  function openEdit(s: StaffMember) {
    setEditing(s)
    setForm({
      name: s.name,
      surname: s.surname,
      email: s.email ?? '',
      department: s.department ?? '',
      card_uid: s.card_uid ?? '',
    })
    setError('')
    setShowModal(true)
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true); setError('')
    const name = form.name.trim()
    const surname = form.surname.trim()
    // Normalize once, up front — every place that stores or compares this
    // email (this check, the Auth-sync call, the saved record) has to
    // agree on the same casing, or a duplicate could slip past by casing
    // alone. See findStaffEmailConflict in src/lib/api/staff.ts.
    const normalizedEmail = form.email.trim() ? normalizeEmail(form.email) : null

    try {
      if (normalizedEmail) {
        const conflict = await findStaffEmailConflict(normalizedEmail, editing?.id.toString())
        if (conflict) {
          setError(`This email is already used by ${conflict.full_name}.`)
          setSaving(false)
          return
        }
      }

      const payload = {
        name,
        surname,
        email: normalizedEmail,
        department: form.department.trim() || null,
        card_uid: form.card_uid.trim() || null,
      }

      if (editing) {
        // If this record already has a linked login account and the email
        // actually changed, the Auth account's email has to be updated to
        // match — same account, same uid, never a second account. Do this
        // BEFORE saving the staff record, and only proceed to the save
        // if it succeeds, so the two can never drift out of sync.
        const previousEmail = editing.email ? normalizeEmail(editing.email) : null
        let authEmailSynced = false
        if (editing.uid && normalizedEmail && normalizedEmail !== previousEmail) {
          if (!user) throw new Error('Not signed in.')
          await postStaffAdmin('/api/staff/update-email', user, {
            staffId: editing.id.toString(),
            newEmail: normalizedEmail,
          })
          authEmailSynced = true
        }

        // The server writes the audit entry; auth_email_synced flags that this
        // edit also re-pointed the linked login account, which decides where
        // future password-reset links are delivered — a materially different
        // act from editing a contact detail.
        await updateStaff(editing.id.toString(), { ...payload, auth_email_synced: authEmailSynced })
      } else {
        await createStaff(payload)
      }
      setShowModal(false)
      load()
    } catch (err: any) {
      setError(err.message)
    }
    setSaving(false)
  }

  // Runs once the confirmation dialog is accepted.
  async function toggleActive(s: StaffMember) {
    const who = staffDisplayName(s)
    setToggleBusy(true)
    try {
      // The server writes the activate/deactivate audit entry, including who
      // this actually was (not just the boolean flip) — audit-log/page.tsx's
      // StaffStatusSummary reads name/surname/email straight off `after`.
      await setStaffActive(s.id.toString(), !s.is_active)
      toast.success(`${who} ${s.is_active ? 'deactivated' : 'activated'}.`)
      setConfirmingToggle(null)
      load()
    } catch (e) {
      console.error(e)
      toast.error(`Could not ${s.is_active ? 'deactivate' : 'activate'} ${who}. ${e instanceof Error ? e.message : ''}`)
    } finally {
      setToggleBusy(false)
    }
  }

  // Provisions (first time) or resends a lending-portal login email. Safe
  // to click any number of times — see /api/staff/send-reset-email for the
  // full decision tree (handout: "Staff login — resolved auth model").
  async function sendLoginEmail(s: StaffMember) {
    if (!user) return
    if (!s.is_active) {
      toast.error('This staff member is deactivated — reactivate them first.')
      return
    }
    if (!s.email) {
      toast.error('This staff member has no email on file.')
      return
    }
    setSendingId(s.id.toString())
    try {
      const res = await postStaffAdmin<{ linked: boolean; email: string; uid: string }>(
        '/api/staff/send-reset-email', user, { staffId: s.id.toString() },
      )
      toast.success(`Login email sent to ${res.email}.`)
      // The route audits EVERY send (grant_access when this call attached a
      // new Auth account, resend_access otherwise), not only the first.
      if (res.linked) {
        load() // refresh so the row picks up the newly-linked uid
      }
    } catch (err: any) {
      toast.error(err.message)
    }
    setSendingId(null)
  }

  const f = (k: keyof FormData) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm(prev => ({ ...prev, [k]: e.target.value }))

  const activeCount = staff.filter(s => s.is_active).length
  const deactivatedCount = staff.length - activeCount
  const visibleStaff = staff.filter(s =>
    statusFilter.has(staffStatusValue(s, lendingStaffIds, s.id.toString())),
  )

  // Same shared columnHelper/SortableHead as Products, Reports, the Audit
  // Log and the Dashboard's widgets — sorting only, no pagination here
  // (this table already shows every filtered/searched row, same as
  // Products). Defined inside the component, not at module scope like
  // those pages' column lists, because the Status column's sort needs
  // lendingStaffIds, which is only known once loadLendingStatus() has run.
  const STAFF_COLUMNS = sortableColumnHelper.columns([
    sortableColumnHelper.accessor('full_name', { id: 'full_name', header: 'Name', sortFn: 'alphanumeric' }),
    sortableColumnHelper.accessor((s: any) => s.department ?? '', { id: 'department', header: 'Department', sortFn: 'alphanumeric' }),
    sortableColumnHelper.accessor((s: any) => s.card_uid ?? '', { id: 'card_uid', header: 'Card UID', sortFn: 'alphanumeric' }),
    sortableColumnHelper.accessor((s: any) => (s.uid ? 'Granted' : 'Not Granted'), { id: 'portal_access', header: 'Portal Access', sortFn: 'alphanumeric' }),
    sortableColumnHelper.accessor((s: any) => staffStatusValue(s, lendingStaffIds, s.id.toString()), {
      id: 'status',
      header: 'Status',
      sortFn: (a: any, b: any) =>
        STAFF_STATUS_RANK[staffStatusValue(a.original, lendingStaffIds, a.original.id.toString())] -
        STAFF_STATUS_RANK[staffStatusValue(b.original, lendingStaffIds, b.original.id.toString())],
    }),
  ])

  const table = useTable({
    features: SORTABLE_TABLE_FEATURES,
    columns: STAFF_COLUMNS,
    data: visibleStaff,
    state: { sorting },
    onSortingChange: setSorting,
  })
  const sortedStaff = table.getSortedRowModel().rows.map(r => r.original as StaffMember)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-6 flex items-center justify-between">
        <div className="space-y-1">
          <h1 className="text-3xl font-extrabold tracking-tight text-[#22162B]">Staff</h1>
          <p className="text-sm text-[#5B4F67]">{activeCount} active · {deactivatedCount} deactivated</p>
        </div>
        <Button onClick={openAdd} className="h-auto rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-white shadow-sm hover:bg-[#582e78]"><Plus className="size-4" /> Add Staff</Button>
      </div>

      {/* Status multi-select filter + Search */}
      <Card className="mb-4 rounded-xl border border-[#E2D8E9] bg-white shadow-sm ring-0">
        <CardContent className="flex flex-wrap items-end gap-4">
        <div className="grid gap-1.5">
          <span className="text-sm font-semibold text-slate-600">Status</span>
          <StaffStatusFilter selected={statusFilter} onChange={setStatusFilter} />
        </div>
        <div className="relative min-w-40 flex-1">
          <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input className="border-slate-300 bg-white pl-8 text-slate-700 focus-visible:border-[#8046B5] focus-visible:ring-[#8046B5]/50" placeholder="Search name, department…"
            value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        </CardContent>
      </Card>

      {/* Table */}
      <Card className="min-h-0 flex-1 rounded-xl border border-[#E2D8E9] bg-white py-0 shadow-sm ring-0">
        <div className="min-h-0 flex-1 overflow-y-auto">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-[#6C3D91] [&_th]:border-b [&_th]:border-[#522E6E] [&_th]:!text-white [&_th_*]:!text-white [&_th_svg]:!text-white/75">
            <TableRow className="border-b border-[#522E6E] hover:bg-[#6C3D91]">
              <TableHead className="h-auto w-8 py-3.5 pl-6"></TableHead>
              <SortableHead column={table.getColumn('full_name')!} className="h-auto py-3.5 text-base font-bold text-[#2D203A]">Name</SortableHead>
              <SortableHead column={table.getColumn('department')!} className="h-auto py-3.5 text-base font-bold text-[#2D203A]">Department</SortableHead>
              <SortableHead column={table.getColumn('card_uid')!} className="h-auto py-3.5 text-base font-bold text-[#2D203A]">Card UID</SortableHead>
              <SortableHead column={table.getColumn('portal_access')!} className="h-auto py-3.5 text-base font-bold text-[#2D203A]">Portal Access</SortableHead>
              <SortableHead column={table.getColumn('status')!} className="h-auto py-3.5 text-base font-bold text-[#2D203A]">Status</SortableHead>
              <TableHead className="h-auto py-3.5 pr-6"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && <TableRow><TableCell colSpan={7} className="py-8 text-center text-muted-foreground">Loading…</TableCell></TableRow>}
            {!loading && visibleStaff.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                  {statusFilter.size === 0 ? 'No statuses selected' : 'No staff match the selected filters'}
                </TableCell>
              </TableRow>
            )}
            {sortedStaff.map(s => {
            const lent = lentByStaff[s.id.toString()] ?? []
            const isExpanded = isStaffExpanded(s.id.toString())
            return (
            <Fragment key={s.id}>
              <TableRow className="hover:bg-[#FAF7FC]">
                <TableCell className="py-4 pr-0 pl-6">
                  {lent.length > 0 ? (
                    <Button
                      variant="ghost" size="icon-sm"
                      aria-expanded={isExpanded}
                      aria-label={isExpanded ? `Hide items held by ${s.full_name}` : `Show items held by ${s.full_name}`}
                      onClick={() => toggleStaff(s.id.toString())}
                      className="text-xs text-muted-foreground"
                    >
                      {isExpanded ? '▲' : '▼'}
                    </Button>
                  ) : (
                    <span className="sr-only">No items held</span>
                  )}
                </TableCell>
                <TableCell className="max-w-xs py-4 whitespace-normal">
                  <div className="break-words text-sm font-semibold text-slate-900">{s.full_name}</div>
                  {/* break-all, not break-words -- an email has no spaces
                      either, and break-words' min-content exclusion (see the
                      barcode/card-UID comments) means it can't be trusted to
                      force a break at all. */}
                  {s.email && <div className="text-xs break-all text-slate-600">{s.email}</div>}
                </TableCell>
                <TableCell className="max-w-xs py-4 text-sm whitespace-normal break-words text-slate-600">{s.department ?? '—'}</TableCell>
                <TableCell className="max-w-xs py-4 whitespace-normal">
                  {/* Badge is a fixed-height (h-5), non-wrapping,
                      overflow-hidden pill by default (see
                      components/ui/badge.tsx) -- overridden here (h-auto,
                      overflow-visible, items-start) so a long UID can wrap
                      onto a second line and the pill grows taller instead of
                      clipping it. break-all, not break-words, on the UID
                      itself -- same reason as the barcode cell on the
                      Products page: overflow-wrap:break-word is excluded
                      from min-content sizing by spec, so inside this
                      inline-flex pill it would never actually shrink/wrap;
                      word-break:break-all does participate and reliably
                      forces the break. */}
                  {s.card_uid
                    ? <Badge className="h-auto max-w-full items-start overflow-visible whitespace-normal bg-emerald-100 font-mono text-emerald-800 border-emerald-200/60 px-2.5 font-semibold">
                        <CreditCard className="mt-0.5 size-3 shrink-0" />
                        <span className="min-w-0 break-all">{s.card_uid}</span>
                      </Badge>
                    : <Badge className="bg-muted text-muted-foreground border-transparent px-2.5 font-semibold">Not linked</Badge>}
                </TableCell>
                <TableCell className="py-4">
                  {s.uid
                    ? <Badge className="bg-emerald-100 text-emerald-800 border-emerald-200/60 px-2.5 font-semibold">Granted</Badge>
                    : <Badge className="bg-muted text-muted-foreground border-transparent px-2.5 font-semibold">Not granted</Badge>}
                </TableCell>
                <TableCell className="py-4">
                  {(() => {
                    const status = staffStatusValue(s, lendingStaffIds, s.id.toString())
                    return status === 'Deactivated'
                      ? <Badge className="bg-red-100 text-red-800 border-red-200/60 px-2.5 font-semibold">Deactivated</Badge>
                      : status === 'Lending'
                        ? <Badge className="bg-accent text-accent-foreground border-transparent px-2.5 font-semibold">Lending</Badge>
                        : <Badge className="bg-emerald-100 text-emerald-800 border-emerald-200/60 px-2.5 font-semibold">Active</Badge>
                  })()}
                </TableCell>
                <TableCell className="py-4 pr-6">
                  <div className="flex gap-1">
                    <Button variant="outline" size="icon-sm" className="border-slate-300 bg-slate-100 text-slate-600 hover:bg-slate-200 hover:text-slate-900" onClick={() => openEdit(s)}>
                      <Pencil className="size-3.5" />
                    </Button>
                    <Button
                      variant="outline" size="sm"
                      disabled={!s.is_active || !s.email || sendingId === s.id.toString()}
                      title={!s.is_active ? 'Staff member is deactivated' : !s.email ? 'No email on file' : undefined}
                      onClick={() => sendLoginEmail(s)}
                      className="border-slate-300 bg-slate-100 text-slate-600 hover:bg-slate-200 hover:text-slate-900"
                    >
                      <Mail className="size-3.5" />
                      {sendingId === s.id.toString() ? 'Sending…' : s.uid ? 'Resend Login Email' : 'Send Login Email'}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className={s.is_active
                        ? 'h-7 rounded-lg border-[#D5C6E0] bg-[#F0EBF5] px-3 text-sm font-semibold text-red-600 hover:bg-[#E4D9EE] hover:text-red-700'
                        : 'h-7 rounded-lg border-emerald-200 bg-emerald-50 px-3 text-sm font-semibold text-emerald-700 hover:bg-emerald-100 hover:text-emerald-800'}
                      onClick={() => setConfirmingToggle(s)}
                    >
                      {s.is_active ? 'Deactivate' : 'Activate'}
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
              {isExpanded && (
                <TableRow className="border-y border-[#E2D8E9]/80 bg-[#FBF9FD] shadow-inner hover:bg-[#FBF9FD]">
                  <TableCell />
                  <TableCell colSpan={6} className="px-8 py-6">
                    <div className="rounded-lg border border-[#E5DBEC] bg-white p-3 shadow-xs">
                      <div className="mb-2 text-sm font-semibold text-slate-600">
                        Currently held by {s.full_name}
                      </div>
                      <div className="max-h-56 overflow-y-auto">
                      <Table>
                        <TableHeader className="sticky top-0 z-10 bg-[#6C3D91] [&_th]:border-b [&_th]:border-[#522E6E] [&_th]:!text-white [&_th_*]:!text-white [&_th_svg]:!text-white/75">
                          <TableRow className="border-b border-[#522E6E] hover:bg-[#6C3D91]">
                            <TableHead className="h-auto py-2.5 text-base font-bold text-[#2D203A]">Product</TableHead>
                            <TableHead className="h-auto py-2.5 text-base font-bold text-[#2D203A]">Qty</TableHead>
                            <TableHead className="h-auto py-2.5 text-base font-bold text-[#2D203A]">Expected</TableHead>
                            <TableHead className="h-auto py-2.5 text-base font-bold text-[#2D203A]">Status</TableHead>
                            <TableHead className="h-auto py-2.5"></TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {lent.map(item => {
                            const st = lentItemStatus(item)
                            return (
                              <TableRow key={item.key} className="border-slate-100 hover:bg-[#FDFCFE]">
                                <TableCell className="max-w-xs text-sm font-semibold text-slate-800 whitespace-normal break-words">{item.product_name}</TableCell>
                                <TableCell className="text-sm font-medium text-slate-600">{item.qty}</TableCell>
                                <TableCell className="text-sm text-slate-600">
                                  {item.waived ? '—' : formatDateOnly(item.expected_date)}
                                </TableCell>
                                <TableCell>
                                  <Badge className={st.className}>{sentenceCase(st.label)}</Badge>
                                </TableCell>
                                <TableCell className="text-right">
                                  {isAdmin && !item.waived && (
                                    <Button
                                      variant="outline" size="sm"
                                      className="border-slate-300 bg-slate-100 text-slate-600 hover:bg-slate-200 hover:text-slate-900"
                                      onClick={() => { setResolving({ staffId: s.id.toString(), staffName: s.full_name, item }); setResolveReason('') }}
                                    >
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

      {/* Add / Edit modal */}
      <Dialog open={showModal} onOpenChange={setShowModal}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit Staff Member' : 'Add Staff Member'}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSave} className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="s-name">Name *</Label>
                <Input id="s-name" required value={form.name} onChange={f('name')} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="s-surname">Surname *</Label>
                <Input id="s-surname" required value={form.surname} onChange={f('surname')} />
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="s-email">Email *</Label>
              <Input id="s-email" type="email" required value={form.email} onChange={f('email')} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="s-department">Department *</Label>
              <Input id="s-department" required value={form.department} onChange={f('department')} placeholder="e.g. Engineering" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="s-card">
                Card UID <span className="font-normal text-muted-foreground">(tap card)</span>
              </Label>
              <Input id="s-card" className="bg-muted" value={form.card_uid} onChange={f('card_uid')}
                placeholder="e.g. A1B2C3D4E5 — leave blank to link later" />
            </div>
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setShowModal(false)}>Cancel</Button>
              <Button type="submit" disabled={saving}>{saving ? 'Saving…' : editing ? 'Save Changes' : 'Add Staff'}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* NFR-010: explicit confirmation before a staff member is deactivated or activated. */}
      <Dialog open={confirmingToggle !== null} onOpenChange={(open) => { if (!open && !toggleBusy) setConfirmingToggle(null) }}>
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle>{confirmingToggle?.is_active ? 'Deactivate staff member?' : 'Activate staff member?'}</DialogTitle>
            <DialogDescription>
              {confirmingToggle && (
                <>
                  <strong className="text-foreground">{staffDisplayName(confirmingToggle)}</strong>
                  {confirmingToggle.email ? ` (${confirmingToggle.email})` : ''}
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {confirmingToggle?.is_active
              ? 'They will be marked Deactivated and no login email can be sent to them. Their record and history are kept, and you can activate them again at any time.'
              : 'They will be marked Active again.'}
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmingToggle(null)} disabled={toggleBusy}>Cancel</Button>
            <Button
              variant={confirmingToggle?.is_active ? 'destructive' : 'default'}
              disabled={toggleBusy}
              onClick={() => { if (confirmingToggle) toggleActive(confirmingToggle) }}
            >
              {toggleBusy
                ? (confirmingToggle?.is_active ? 'Deactivating…' : 'Activating…')
                : (confirmingToggle?.is_active ? 'Deactivate' : 'Activate')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Resolve confirmation — same write, same warnings as the Dashboard's
          Resolve button (see dashboard/page.tsx), triggered from here for
          the case where Selouna is already looking at what this person
          holds and knows right then an item isn't coming back. */}
      <Dialog open={resolving !== null} onOpenChange={(open) => { if (!open) { setResolving(null); setResolveReason('') } }}>
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle>Resolve outstanding item?</DialogTitle>
            <DialogDescription>
              {resolving && (
                <>
                  <strong className="text-foreground">{resolving.item.product_name}</strong> × {resolving.item.qty},
                  held by {resolving.staffName}.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2 text-sm text-muted-foreground">
            <p>This records that the item does not need to come back. It will stop counting as outstanding here and on the Dashboard — but it can still be returned normally from the Returns page later if it does turn up.</p>
            <p>Stock levels are <strong className="text-foreground">not</strong> changed — the item left the shelf when it was issued and isn&apos;t returning.</p>
            <p>It stays listed here under {resolving?.staffName ?? 'this staff member'}, marked <em>Resolved</em>, so there&apos;s still a record of who kept it.</p>
            <p className="text-foreground">This can&apos;t be undone from the app.</p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="staff-resolve-reason">Reason <span className="font-normal text-muted-foreground">(optional)</span></Label>
            <Textarea
              id="staff-resolve-reason"
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
                  await resolveHeldItem(resolving.staffId, {
                    transactionId: resolving.item.txn_id,
                    productId: resolving.item.product_id,
                    quantity: resolving.item.qty,
                    reason: resolveReason.trim() || null,
                  })
                  toast.success(`${resolving.item.product_name} resolved — no return due.`)
                  setResolving(null)
                  setResolveReason('')
                  // Re-fetch rather than patch lentByStaff locally — this
                  // recomputes lendingStaffIds too, so the row's badge
                  // (Lending vs Active) drops in step with the item moving
                  // out of the outstanding bucket.
                  await loadLendingStatus()
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
    </div>
  )
}

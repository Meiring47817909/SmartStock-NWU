'use client'

import { Fragment, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Search, Plus, Pencil, CreditCard, Mail, ChevronRight, ChevronDown } from 'lucide-react'
import { db } from '@/lib/firebase/config'
import { collection, query, where, getDocs, addDoc, updateDoc, doc, orderBy } from 'firebase/firestore'
import { logAudit } from '@/lib/firebase/audit'
import { normalizeEmail, findStaffEmailConflict, postStaffAdmin } from '@/lib/firebase/staff'
import { loadWaivers, createReturnWaiver } from '@/lib/firebase/waivers'
import { formatDateOnly, todayDateStr } from '@/lib/utils'
import { useAuth } from '@/context/AuthContext'
import { useRole } from '@/context/RoleContext'
import { Card } from '@/components/ui/card'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
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
import type { StaffMember, ReturnWaiver } from '@/types/database'

// One item a staff member currently holds — an OUT line with a remaining
// balance, or one that's been written off via Resolve. Mirrors the
// Dashboard's Outstanding Returns columns (Product / Qty / Expected /
// Status) minus the Staff column, which is the row you expanded from.
interface LentItem {
  key: string
  // Kept alongside the display fields so an outstanding row can be resolved
  // right here — same (transaction, product) pair the Dashboard's Resolve
  // button writes a waiver against.
  txn_id: string
  product_id: string
  product_name: string
  qty: number
  expected_date: string | null
  // Written off already (via this page or the Dashboard): Selouna agreed
  // the staff member keeps it. Kept visible here on purpose — this list is
  // the record that replaces her having to write the item down somewhere.
  // Never gets a Resolve button — there's nothing left to resolve.
  waived: boolean
}

// Same urgency labels as the Dashboard's Outstanding Returns table, plus the
// terminal written-off state that only exists on this page.
function lentItemStatus(item: LentItem): { label: string; className: string } {
  if (item.waived) return { label: 'Resolved', className: 'bg-violet-100 text-violet-800' }
  if (!item.expected_date) return { label: 'No Return Date', className: 'bg-slate-100 text-slate-700' }
  const today = todayDateStr()
  if (today > item.expected_date) return { label: 'Overdue', className: 'bg-red-100 text-red-800' }
  if (today === item.expected_date) return { label: 'Due Today', className: 'bg-amber-100 text-amber-800' }
  return { label: 'Not Due Yet', className: 'bg-emerald-100 text-emerald-800' }
}

type FormData = {
  name: string; surname: string; email: string
  department: string; card_uid: string
}

const EMPTY_FORM: FormData = { name: '', surname: '', email: '', department: '', card_uid: '' }

export default function StaffPage() {
  const { user, profile } = useAuth()
  const { isAdmin } = useRole()
  const [staff, setStaff] = useState<StaffMember[]>([])
  const [search, setSearch] = useState('')
  // Active/Deactivated are shown as two separate lists rather than mixed
  // together with a greyed-out row for the inactive ones — a deactivated
  // staff member is a normal row (see the Status badge below for what
  // distinguishes them), just filed under its own tab.
  const [statusTab, setStatusTab] = useState<'active' | 'deactivated'>('active')
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
  const [expandedId, setExpandedId] = useState<string | null>(null)
  // The item Selouna has clicked Resolve on in a staff member's expanded
  // list, held while the confirmation dialog is open — same write as the
  // Dashboard's Resolve button (a return_waivers doc), just triggered from
  // here instead, for the case where she's already looking at this
  // person's held items and knows right then it's not coming back.
  const [resolving, setResolving] = useState<{ staffId: string; staffName: string; item: LentItem } | null>(null)
  const [resolveReason, setResolveReason] = useState('')
  const [resolveBusy, setResolveBusy] = useState(false)

  async function load() {
    setLoading(true)
    const staffRef = collection(db, 'staff')
    const snap = await getDocs(query(staffRef, orderBy('full_name')))

    let data = snap.docs.map(doc => ({ id: doc.id, ...doc.data() })) as any[]

    const s = search.toLowerCase()
    if (s) {
      data = data.filter(st =>
        (st.full_name && st.full_name.toLowerCase().includes(s)) ||
        (st.department && st.department.toLowerCase().includes(s))
      )
    }

    setStaff(data as StaffMember[])
    setLoading(false)
  }

  // A staff member counts as "Lending" if they have at least one OUT line
  // whose issued quantity hasn't been fully returned yet — the same
  // correctly-scoped issued-vs-returned logic used on the Dashboard and
  // Returns page (a return must be matched to its specific originating OUT
  // transaction via linked_txn_id, not lumped into a flat per-product total
  // — see returns/page.tsx's returnedByTxn comment for why that matters).
  // Independent of the search box, so it's loaded once on mount rather than
  // re-run on every keystroke like load() above.
  async function loadLendingStatus() {
    const waivers = await loadWaivers()
    const outSnap = await getDocs(query(collection(db, 'transactions'), where('transaction_type', '==', 'OUT')))
    const returnSnap = await getDocs(query(collection(db, 'transactions'), where('transaction_type', '==', 'RETURN')))
    const outTxns = outSnap.docs.map(d => ({ id: d.id, ...d.data() })) as any[]
    const returnTxns = returnSnap.docs.map(d => ({ id: d.id, ...d.data() })) as any[]

    const relevantTxnIds = new Set([...outTxns.map(t => t.id), ...returnTxns.map(t => t.id)])
    const linesSnap = await getDocs(collection(db, 'transaction_lines'))
    const linesByTxn: Record<string, any[]> = {}
    linesSnap.forEach(d => {
      const l = d.data()
      if (relevantTxnIds.has(l.transaction_id)) (linesByTxn[l.transaction_id] ??= []).push(l)
    })

    const returnedByTxn: Record<string, Record<string, number>> = {}
    returnTxns.forEach(t => {
      if (!t.linked_txn_id) return
      const bucket = (returnedByTxn[t.linked_txn_id] ??= {})
      ;(linesByTxn[t.id] || []).forEach((l: any) => {
        bucket[l.product_id] = (bucket[l.product_id] ?? 0) + (l.quantity || 0)
      })
    })

    // Written-off quantities, keyed [OUT txn][product] exactly like returns.
    const waivedByTxn: Record<string, Record<string, number>> = {}
    waivers.forEach((w: ReturnWaiver) => {
      if (!w.transaction_id) return
      const bucket = (waivedByTxn[w.transaction_id] ??= {})
      const pid = String(w.product_id)
      bucket[pid] = (bucket[pid] ?? 0) + (w.quantity || 0)
    })

    const lending = new Set<string>()
    const byStaff: Record<string, LentItem[]> = {}
    outTxns.forEach(t => {
      if (!t.staff_id) return
      const staffKey = t.staff_id.toString()
      const lines = linesByTxn[t.id] || []
      lines.forEach((l: any) => {
        const issued = l.quantity || 0
        const returned = returnedByTxn[t.id]?.[l.product_id] ?? 0
        const waived = waivedByTxn[t.id]?.[String(l.product_id)] ?? 0
        const remaining = issued - returned - waived
        const bucket = (byStaff[staffKey] ??= [])

        // Still owed back — this is what the Dashboard's Outstanding
        // Returns keys off, and (along with the resolved/written-off case
        // below) one of two things that make this row count as "Lending".
        if (remaining > 0) {
          bucket.push({
            key: `${t.id}_${l.product_id}_open`,
            txn_id: t.id,
            product_id: String(l.product_id),
            product_name: l.product_name ?? 'Unknown',
            qty: remaining,
            expected_date: t.lend_to ?? null,
            waived: false,
          })
          lending.add(staffKey)
        }

        // Written off — no longer chased anywhere, but still in this
        // person's possession, so it stays listed here. The Returns page
        // no longer excludes waived quantity from what can be processed,
        // so a written-off item CAN now actually come back — once a real
        // return covers it, it needs to drop off this "No Return Due" row
        // rather than sitting there forever. Any return beyond what the
        // non-waived portion already accounts for (issued − waived) must
        // have come out of the waived quantity, so subtract that overflow
        // before deciding how much (if any) is still "written off".
        const returnedBeyondOpenPortion = Math.max(0, returned - (issued - waived))
        const effectiveWaived = Math.max(0, waived - returnedBeyondOpenPortion)
        if (effectiveWaived > 0) {
          bucket.push({
            key: `${t.id}_${l.product_id}_waived`,
            txn_id: t.id,
            product_id: String(l.product_id),
            product_name: l.product_name ?? 'Unknown',
            qty: effectiveWaived,
            expected_date: t.lend_to ?? null,
            waived: true,
          })
          // A resolved item is still physically with the staff member —
          // Resolve only stops it being CHASED, it doesn't hand the item
          // back — so the roster row's Status should still read "Lending"
          // even when every item they hold has been resolved, not fall
          // back to "Active" as if they're holding nothing at all.
          lending.add(staffKey)
        }
      })
    })

    // Same ordering as the Dashboard: most urgent first, undated after
    // those, written-off last (nothing to chase, so it's reference only).
    Object.values(byStaff).forEach(items => {
      items.sort((a, b) => {
        if (a.waived !== b.waived) return a.waived ? 1 : -1
        if (!a.expected_date && !b.expected_date) return 0
        if (!a.expected_date) return 1
        if (!b.expected_date) return -1
        return a.expected_date.localeCompare(b.expected_date)
      })
    })

    setLendingStaffIds(lending)
    setLentByStaff(byStaff)
  }

  useEffect(() => { load(); loadLendingStatus() }, [])
  useEffect(() => { load() }, [search])

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
    // email (this check, the Auth-sync call, the Firestore payload) has to
    // agree on the same casing, or a duplicate could slip past by casing
    // alone. See findStaffEmailConflict in src/lib/firebase/staff.ts.
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
        full_name: `${name} ${surname}`.trim(),
        email: normalizedEmail,
        department: form.department.trim() || null,
        card_uid: form.card_uid.trim() || null,
      }

      if (editing) {
        // If this record already has a linked login account and the email
        // actually changed, the Auth account's email has to be updated to
        // match — same account, same uid, never a second account. Do this
        // BEFORE writing Firestore, and only proceed to the Firestore write
        // if it succeeds, so the two can never drift out of sync.
        const previousEmail = editing.email ? normalizeEmail(editing.email) : null
        if (editing.uid && normalizedEmail && normalizedEmail !== previousEmail) {
          if (!user) throw new Error('Not signed in.')
          await postStaffAdmin('/api/staff/update-email', user, {
            staffId: editing.id.toString(),
            newEmail: normalizedEmail,
          })
        }

        const updated = { ...payload, updated_at: new Date().toISOString() }
        await updateDoc(doc(db, 'staff', editing.id.toString()), updated)
        logAudit({
          userId: user?.uid, userName: profile?.full_name ?? user?.email,
          action: 'update', entityType: 'staff', entityId: editing.id.toString(),
          before: {
            name: editing.name, surname: editing.surname, full_name: editing.full_name,
            email: editing.email, department: editing.department, card_uid: editing.card_uid,
          },
          after: updated,
        })
      } else {
        const created = {
          ...payload,
          is_active: true,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }
        const staffRef = await addDoc(collection(db, 'staff'), created)
        logAudit({
          userId: user?.uid, userName: profile?.full_name ?? user?.email,
          action: 'create', entityType: 'staff', entityId: staffRef.id,
          before: null, after: created,
        })
      }
      setShowModal(false)
      load()
    } catch (err: any) {
      setError(err.message)
    }
    setSaving(false)
  }

  async function toggleActive(s: StaffMember) {
    try {
      const nextActive = !s.is_active
      await updateDoc(doc(db, 'staff', s.id.toString()), {
        is_active: nextActive,
        updated_at: new Date().toISOString()
      })
      // Include who this actually was, not just the boolean flip — a bare
      // "is_active: true → false" in the Audit Log tells Selouna nothing
      // about which staff member it was. name/surname/email are identical
      // before and after (only is_active changes), so the generic FieldDiff
      // view would filter them out as "unchanged"; audit-log/page.tsx's
      // StaffStatusSummary reads them straight off `after` instead of
      // diffing, specifically for this activate/deactivate case.
      logAudit({
        userId: user?.uid, userName: profile?.full_name ?? user?.email,
        action: nextActive ? 'activate' : 'deactivate', entityType: 'staff', entityId: s.id.toString(),
        before: { is_active: s.is_active, name: s.name, surname: s.surname, full_name: s.full_name, email: s.email },
        after: { is_active: nextActive, name: s.name, surname: s.surname, full_name: s.full_name, email: s.email },
      })
      load()
    } catch (e) {
      console.error(e)
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
      if (!s.uid) {
        logAudit({
          userId: user.uid, userName: profile?.full_name ?? user.email,
          action: 'update', entityType: 'staff', entityId: s.id.toString(),
          before: { uid: null },
          after: { uid: res.uid },
        })
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
  const visibleStaff = staff.filter(s => statusTab === 'active' ? s.is_active : !s.is_active)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Staff</h1>
          <p className="mt-1 text-sm text-muted-foreground">{activeCount} active · {deactivatedCount} deactivated</p>
        </div>
        <Button onClick={openAdd}><Plus className="size-4" /> Add Staff</Button>
      </div>

      {/* Search + Active/Deactivated toggle */}
      <div className="mb-4 flex items-center gap-4">
        <div className="relative max-w-80 flex-1">
          <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-8" placeholder="Search name, department…"
            value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <Tabs value={statusTab} onValueChange={v => setStatusTab(v as typeof statusTab)}>
          <TabsList>
            <TabsTrigger value="active">
              Active
              <Badge className="bg-emerald-100 text-emerald-800">{activeCount}</Badge>
            </TabsTrigger>
            <TabsTrigger value="deactivated">
              Deactivated
              <Badge className="bg-red-100 text-red-800">{deactivatedCount}</Badge>
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {/* Table */}
      <Card className="min-h-0 flex-1 py-0">
        <div className="min-h-0 flex-1 overflow-y-auto">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-card">
            <TableRow>
              <TableHead className="w-8"></TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Department</TableHead>
              <TableHead>Card UID</TableHead>
              <TableHead>Portal Access</TableHead>
              <TableHead>Status</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && <TableRow><TableCell colSpan={7} className="py-8 text-center text-muted-foreground">Loading…</TableCell></TableRow>}
            {!loading && visibleStaff.length === 0 && <TableRow><TableCell colSpan={7} className="py-8 text-center text-muted-foreground">No {statusTab} staff found</TableCell></TableRow>}
            {visibleStaff.map(s => {
            const lent = lentByStaff[s.id.toString()] ?? []
            const isExpanded = expandedId === s.id.toString()
            return (
            <Fragment key={s.id}>
              <TableRow>
                <TableCell className="pr-0">
                  {lent.length > 0 ? (
                    <Button
                      variant="ghost" size="icon-sm"
                      aria-expanded={isExpanded}
                      aria-label={isExpanded ? `Hide items held by ${s.full_name}` : `Show items held by ${s.full_name}`}
                      onClick={() => setExpandedId(isExpanded ? null : s.id.toString())}
                    >
                      {isExpanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                    </Button>
                  ) : (
                    <span className="sr-only">No items held</span>
                  )}
                </TableCell>
                <TableCell>
                  <div className="font-medium">{s.full_name}</div>
                  {s.email && <div className="text-xs text-muted-foreground">{s.email}</div>}
                </TableCell>
                <TableCell className="text-muted-foreground">{s.department ?? '—'}</TableCell>
                <TableCell>
                  {s.card_uid
                    ? <Badge className="bg-emerald-100 font-mono text-emerald-800">
                        <CreditCard className="size-3" /> {s.card_uid}
                      </Badge>
                    : <Badge className="bg-muted text-muted-foreground">Not Linked</Badge>}
                </TableCell>
                <TableCell>
                  {s.uid
                    ? <Badge className="bg-emerald-100 text-emerald-800">Granted</Badge>
                    : <Badge className="bg-muted text-muted-foreground">Not Granted</Badge>}
                </TableCell>
                <TableCell>
                  {!s.is_active
                    ? <Badge className="bg-red-100 text-red-800">Deactivated</Badge>
                    : lendingStaffIds.has(s.id.toString())
                      ? <Badge className="bg-accent text-accent-foreground">Lending</Badge>
                      : <Badge className="bg-emerald-100 text-emerald-800">Active</Badge>}
                </TableCell>
                <TableCell>
                  <div className="flex gap-1">
                    <Button variant="ghost" size="icon-sm" onClick={() => openEdit(s)}>
                      <Pencil className="size-3.5" />
                    </Button>
                    <Button
                      variant="ghost" size="sm"
                      disabled={!s.is_active || !s.email || sendingId === s.id.toString()}
                      title={!s.is_active ? 'Staff member is deactivated' : !s.email ? 'No email on file' : undefined}
                      onClick={() => sendLoginEmail(s)}
                    >
                      <Mail className="size-3.5" />
                      {sendingId === s.id.toString() ? 'Sending…' : s.uid ? 'Resend Login Email' : 'Send Login Email'}
                    </Button>
                    <Button
                      variant="ghost" size="sm"
                      className={s.is_active ? 'text-red-600 hover:text-red-700' : 'text-emerald-600 hover:text-emerald-700'}
                      onClick={() => toggleActive(s)}
                    >
                      {s.is_active ? 'Deactivate' : 'Activate'}
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
              {isExpanded && (
                <TableRow className="hover:bg-transparent">
                  <TableCell />
                  <TableCell colSpan={6} className="py-3">
                    <div className="rounded-md border bg-muted/40 p-3">
                      <div className="mb-2 text-xs font-medium text-muted-foreground">
                        Currently held by {s.full_name}
                      </div>
                      <div className="max-h-56 overflow-y-auto">
                      <Table>
                        <TableHeader className="sticky top-0 z-10 bg-muted/40">
                          <TableRow className="hover:bg-transparent">
                            <TableHead>Product</TableHead>
                            <TableHead>Qty</TableHead>
                            <TableHead>Expected</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead></TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {lent.map(item => {
                            const st = lentItemStatus(item)
                            return (
                              <TableRow key={item.key} className="hover:bg-transparent">
                                <TableCell className="font-medium">{item.product_name}</TableCell>
                                <TableCell className="font-semibold">{item.qty}</TableCell>
                                <TableCell className="text-muted-foreground">
                                  {item.waived ? '—' : formatDateOnly(item.expected_date)}
                                </TableCell>
                                <TableCell>
                                  <Badge className={`${st.className} uppercase`}>{st.label}</Badge>
                                </TableCell>
                                <TableCell className="text-right">
                                  {isAdmin && !item.waived && (
                                    <Button
                                      variant="ghost" size="sm"
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
              <div className="grid gap-1.5">
                <Label htmlFor="s-email">Email *</Label>
                <Input id="s-email" type="email" required value={form.email} onChange={f('email')} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="s-department">Department *</Label>
                <Input id="s-department" required value={form.department} onChange={f('department')} placeholder="e.g. Engineering" />
              </div>
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
                  await createReturnWaiver({
                    transactionId: resolving.item.txn_id,
                    productId: resolving.item.product_id,
                    productName: resolving.item.product_name,
                    staffId: Number(resolving.staffId),
                    staffName: resolving.staffName,
                    quantity: resolving.item.qty,
                    reason: resolveReason.trim() || null,
                    actorUid: user?.uid,
                    actorName: profile?.full_name ?? user?.email,
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

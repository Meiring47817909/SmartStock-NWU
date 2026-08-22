'use client'

import { Fragment, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { db } from '@/lib/firebase/config'
import { collection, doc, getDoc, getDocs } from 'firebase/firestore'
import { useAuth } from '@/context/AuthContext'
import {
  approveAsIs, sendCounter, declineRequest, expireIfNeeded,
  computeExpiryDate, isNoShowCandidate, getReservedQuantity,
} from '@/lib/firebase/loanRequests'
import { formatDate, formatDateOnly, todayDateStr } from '@/lib/utils'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import type { LoanRequest, LoanRequestLine, LoanRequestStatus } from '@/types/database'

const STATUS_BADGE_CLASS: Record<LoanRequestStatus, string> = {
  pending: 'bg-amber-100 text-amber-800',
  countered: 'bg-sky-100 text-sky-800',
  accepted: 'bg-emerald-100 text-emerald-800',
  fulfilled: 'bg-accent text-accent-foreground',
  declined: 'bg-red-100 text-red-800',
  expired: 'bg-muted text-muted-foreground',
  withdrawn: 'bg-muted text-muted-foreground',
  no_show: 'bg-red-100 text-red-800',
}

const TERMINAL: LoanRequestStatus[] = ['declined', 'expired', 'withdrawn', 'fulfilled', 'no_show']

interface DraftLine {
  id: string
  product_id: string
  product_name: string
  requested_quantity: number
  offered_quantity: number
}

interface Draft {
  lines: DraftLine[]
  fromDate: string
  toDate: string
}

// Undated-pushed-to-end comparator — same shape as dashboard/page.tsx's
// outstandingList.sort.
function byExpirySoonestFirst(a: LoanRequest, b: LoanRequest) {
  const ea = computeExpiryDate(a)
  const eb = computeExpiryDate(b)
  if (!ea && !eb) return 0
  if (!ea) return 1
  if (!eb) return -1
  return ea.localeCompare(eb)
}

export default function LoanRequestsPage() {
  const { user, profile } = useAuth()
  const actor = { userId: user?.uid, userName: profile?.full_name ?? user?.email }

  const [requests, setRequests] = useState<LoanRequest[]>([])
  const [linesByRequest, setLinesByRequest] = useState<Record<string, LoanRequestLine[]>>({})
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'pending' | 'countered' | 'accepted' | 'history'>('pending')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [availability, setAvailability] = useState<Record<string, Record<string, number>>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})

  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function load() {
    setLoading(true)
    const reqSnap = await getDocs(collection(db, 'loan_requests'))
    let reqs = reqSnap.docs.map(d => ({ id: d.id, ...d.data() })) as LoanRequest[]

    // Lazily flip expiry/no-show transitions before rendering, so a stale
    // pending/countered/accepted status never lingers in the list — see
    // LENDING_PORTAL_SPEC.md §3.3/3.4.
    reqs = await Promise.all(reqs.map(async (r) => {
      if (r.status !== 'pending' && r.status !== 'countered' && r.status !== 'accepted') return r
      const next = await expireIfNeeded(r, actor)
      return next !== r.status ? { ...r, status: next, updated_at: new Date().toISOString() } : r
    }))

    const linesSnap = await getDocs(collection(db, 'loan_request_lines'))
    const byRequest: Record<string, LoanRequestLine[]> = {}
    linesSnap.forEach((d) => {
      const l = { id: d.id, ...d.data() } as LoanRequestLine
      ;(byRequest[l.request_id] ??= []).push(l)
    })

    setRequests(reqs)
    setLinesByRequest(byRequest)
    setLoading(false)
  }

  async function refreshAvailability(requestId: string, lines: DraftLine[], fromDate: string, toDate: string) {
    const uniqueProductIds = Array.from(new Set(lines.map((l) => l.product_id)))
    const entries = await Promise.all(uniqueProductIds.map(async (pid) => {
      const productSnap = await getDoc(doc(db, 'products', pid))
      const onHand = (productSnap.data() as { quantity_on_hand?: number } | undefined)?.quantity_on_hand ?? 0
      const reserved = await getReservedQuantity(pid, fromDate, toDate, requestId)
      return [pid, Math.max(0, onHand - reserved)] as const
    }))
    setAvailability((prev) => ({ ...prev, [requestId]: Object.fromEntries(entries) }))
  }

  function toggleExpand(r: LoanRequest) {
    if (expanded === r.id) { setExpanded(null); return }
    setExpanded(r.id)
    if (r.status !== 'pending' && r.status !== 'countered') return
    if (drafts[r.id]) return
    const lines: DraftLine[] = (linesByRequest[r.id] ?? []).map((l) => ({
      id: l.id, product_id: l.product_id, product_name: l.product_name,
      requested_quantity: l.requested_quantity, offered_quantity: l.offered_quantity,
    }))
    setDrafts((prev) => ({ ...prev, [r.id]: { lines, fromDate: r.from_date, toDate: r.to_date } }))
    refreshAvailability(r.id, lines, r.from_date, r.to_date)
  }

  function updateOfferedQty(requestId: string, lineId: string, qty: number) {
    setDrafts((prev) => {
      const draft = prev[requestId]
      if (!draft) return prev
      const line = draft.lines.find((l) => l.id === lineId)
      if (!line) return prev
      const cap = Math.min(line.requested_quantity, availability[requestId]?.[line.product_id] ?? line.requested_quantity)
      const clamped = Math.max(0, Math.min(qty, cap))
      return {
        ...prev,
        [requestId]: { ...draft, lines: draft.lines.map((l) => (l.id === lineId ? { ...l, offered_quantity: clamped } : l)) },
      }
    })
  }

  function updateDraftDate(requestId: string, field: 'fromDate' | 'toDate', value: string) {
    setDrafts((prev) => {
      const draft = prev[requestId]
      if (!draft) return prev
      const next = { ...draft, [field]: value }
      refreshAvailability(requestId, next.lines, next.fromDate, next.toDate)
      return { ...prev, [requestId]: next }
    })
  }

  function isDirty(r: LoanRequest): boolean {
    const draft = drafts[r.id]
    if (!draft) return false
    if (draft.fromDate !== r.from_date || draft.toDate !== r.to_date) return true
    const original = linesByRequest[r.id] ?? []
    return draft.lines.some((dl) => {
      const orig = original.find((o) => o.id === dl.id)
      return orig ? orig.offered_quantity !== dl.offered_quantity : false
    })
  }

  async function handleApprove(r: LoanRequest) {
    setBusy(r.id); setRowErrors((prev) => ({ ...prev, [r.id]: '' }))
    try {
      await approveAsIs(r, linesByRequest[r.id] ?? [], actor)
      toast.success(`Approved ${r.staff_name}'s request.`)
      setExpanded(null)
      await load()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to approve request.'
      setRowErrors((prev) => ({ ...prev, [r.id]: message }))
      toast.error(message)
    }
    setBusy(null)
  }

  async function handleSendCounter(r: LoanRequest) {
    const draft = drafts[r.id]
    if (!draft) return
    setBusy(r.id); setRowErrors((prev) => ({ ...prev, [r.id]: '' }))
    try {
      await sendCounter(
        r,
        draft.lines.map((l) => ({ lineId: l.id, product_id: l.product_id, offered_quantity: l.offered_quantity })),
        draft.fromDate, draft.toDate, actor,
      )
      toast.success(`Counter sent to ${r.staff_name}.`)
      setExpanded(null)
      await load()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to send counter.'
      setRowErrors((prev) => ({ ...prev, [r.id]: message }))
      toast.error(message)
    }
    setBusy(null)
  }

  async function handleDecline(r: LoanRequest) {
    setBusy(r.id); setRowErrors((prev) => ({ ...prev, [r.id]: '' }))
    try {
      await declineRequest(r, actor)
      toast.success(`Declined ${r.staff_name}'s request.`)
      setExpanded(null)
      await load()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to decline request.'
      setRowErrors((prev) => ({ ...prev, [r.id]: message }))
      toast.error(message)
    }
    setBusy(null)
  }

  const pending = requests.filter((r) => r.status === 'pending').sort(byExpirySoonestFirst)
  const countered = requests.filter((r) => r.status === 'countered').sort(byExpirySoonestFirst)
  const accepted = requests.filter((r) => r.status === 'accepted').sort((a, b) => a.from_date.localeCompare(b.from_date))
  const history = requests.filter((r) => TERMINAL.includes(r.status)).sort((a, b) => b.updated_at.localeCompare(a.updated_at))

  function EditableRow({ r }: { r: LoanRequest }) {
    const draft = drafts[r.id]
    const dirty = isDirty(r)
    return (
      <TableRow className="bg-muted/50">
        <TableCell colSpan={5} className="p-4">
          {!draft ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <div className="flex flex-col gap-4">
              <div className="flex flex-wrap items-end gap-4">
                <div className="grid gap-1.5">
                  <label className="text-xs font-medium text-muted-foreground">From</label>
                  <Input type="date" className="w-40" value={draft.fromDate} min={todayDateStr()}
                    onChange={(e) => updateDraftDate(r.id, 'fromDate', e.target.value)} />
                </div>
                <div className="grid gap-1.5">
                  <label className="text-xs font-medium text-muted-foreground">To</label>
                  <Input type="date" className="w-40" value={draft.toDate} min={draft.fromDate}
                    onChange={(e) => updateDraftDate(r.id, 'toDate', e.target.value)} />
                </div>
                {r.message && (
                  <div className="grid gap-1.5">
                    <span className="text-xs font-medium text-muted-foreground">Message</span>
                    <p className="max-w-[360px] text-sm text-foreground">{r.message}</p>
                  </div>
                )}
              </div>

              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Product</TableHead>
                    <TableHead>Requested</TableHead>
                    <TableHead>Offering</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {draft.lines.map((l) => (
                    <TableRow key={l.id}>
                      <TableCell className="font-medium">{l.product_name}</TableCell>
                      <TableCell className="text-muted-foreground">{l.requested_quantity}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1.5">
                          <Button variant="ghost" size="icon-sm" onClick={() => updateOfferedQty(r.id, l.id, l.offered_quantity - 1)}>−</Button>
                          <span className={`min-w-6 text-center font-bold ${l.offered_quantity > 0 ? 'text-primary' : 'text-muted-foreground'}`}>{l.offered_quantity}</span>
                          <Button variant="ghost" size="icon-sm" onClick={() => updateOfferedQty(r.id, l.id, l.offered_quantity + 1)}>+</Button>
                        </div>
                      </TableCell>
                      <TableCell>
                        {l.offered_quantity > 0 && (
                          <Button variant="ghost" size="sm" onClick={() => updateOfferedQty(r.id, l.id, 0)}>Remove</Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              {rowErrors[r.id] && (
                <Alert variant="destructive"><AlertDescription>{rowErrors[r.id]}</AlertDescription></Alert>
              )}

              <div className="flex items-center gap-2">
                <Button disabled={busy === r.id || dirty} onClick={() => handleApprove(r)}>
                  {busy === r.id ? '…' : 'Approve as-is'}
                </Button>
                <Button variant="outline" disabled={busy === r.id || !dirty} onClick={() => handleSendCounter(r)}>
                  {busy === r.id ? '…' : 'Send Counter'}
                </Button>
                <Button variant="ghost" disabled={busy === r.id} onClick={() => handleDecline(r)} className="ml-auto text-destructive hover:text-destructive">
                  Decline
                </Button>
              </div>
            </div>
          )}
        </TableCell>
      </TableRow>
    )
  }

  function ReadOnlyRow({ r }: { r: LoanRequest }) {
    const lines = linesByRequest[r.id] ?? []
    return (
      <TableRow className="bg-muted/50">
        <TableCell colSpan={5} className="p-4">
          <div className="flex flex-col gap-2 text-sm">
            {r.message && <p className="text-muted-foreground">&ldquo;{r.message}&rdquo;</p>}
            <ul className="ml-4 list-disc">
              {lines.map((l) => (
                <li key={l.id}>{l.product_name} <span className="text-muted-foreground">× {l.offered_quantity}</span></li>
              ))}
            </ul>
            {r.status === 'accepted' && r.fulfilled_txn_id === null && (
              <div className="text-xs text-muted-foreground">Awaiting pickup {formatDateOnly(r.from_date)} – {formatDateOnly(r.to_date)}</div>
            )}
          </div>
        </TableCell>
      </TableRow>
    )
  }

  function requestRows(list: LoanRequest[], editable: boolean) {
    if (loading) return <TableRow><TableCell colSpan={5} className="py-8 text-center text-muted-foreground">Loading…</TableCell></TableRow>
    if (list.length === 0) return <TableRow><TableCell colSpan={5} className="py-8 text-center text-muted-foreground">Nothing here ✓</TableCell></TableRow>
    return list.map((r) => {
      const itemCount = (linesByRequest[r.id] ?? []).length
      const expiry = computeExpiryDate(r)
      const noShow = r.status === 'accepted' && isNoShowCandidate(r)
      return (
        <Fragment key={r.id}>
          <TableRow className="cursor-pointer" onClick={() => toggleExpand(r)}>
            <TableCell className="font-medium">{r.staff_name}</TableCell>
            <TableCell className="text-muted-foreground">{itemCount} item{itemCount === 1 ? '' : 's'}</TableCell>
            <TableCell>
              <Badge className={`${STATUS_BADGE_CLASS[r.status]} uppercase`}>{r.status.replace('_', ' ')}</Badge>
              {noShow && <Badge className="ml-1.5 bg-red-100 text-red-800">Possible no-show</Badge>}
            </TableCell>
            <TableCell className="text-muted-foreground">
              {tab === 'accepted'
                ? `${formatDateOnly(r.from_date)} – ${formatDateOnly(r.to_date)}`
                : tab === 'history'
                  ? formatDate(r.updated_at)
                  : (expiry ? formatDateOnly(expiry) : '—')}
            </TableCell>
            <TableCell className="text-xs text-muted-foreground">{expanded === r.id ? '▲' : '▼'}</TableCell>
          </TableRow>
          {expanded === r.id && (editable ? <EditableRow r={r} /> : <ReadOnlyRow r={r} />)}
        </Fragment>
      )
    })
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-foreground">Loan Requests</h1>
        <p className="mt-1 text-sm text-muted-foreground">Review, counter, and track portal lending requests from NWU staff.</p>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
        <TabsList variant="line" className="mb-6 w-full justify-start overflow-x-auto border-b">
          <TabsTrigger value="pending">Needs Review{pending.length > 0 ? ` (${pending.length})` : ''}</TabsTrigger>
          <TabsTrigger value="countered">Sent Counters{countered.length > 0 ? ` (${countered.length})` : ''}</TabsTrigger>
          <TabsTrigger value="accepted">Incoming Pickups{accepted.length > 0 ? ` (${accepted.length})` : ''}</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>

        <TabsContent value="pending">
          <Card className="py-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Staff</TableHead>
                  <TableHead>Items</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>{requestRows(pending, true)}</TableBody>
            </Table>
          </Card>
        </TabsContent>

        <TabsContent value="countered">
          <Card className="py-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Staff</TableHead>
                  <TableHead>Items</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>{requestRows(countered, true)}</TableBody>
            </Table>
          </Card>
        </TabsContent>

        <TabsContent value="accepted">
          <Card className="py-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Staff</TableHead>
                  <TableHead>Items</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Pickup window</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>{requestRows(accepted, false)}</TableBody>
            </Table>
          </Card>
        </TabsContent>

        <TabsContent value="history">
          <Card className="py-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Staff</TableHead>
                  <TableHead>Items</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Updated</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>{requestRows(history, false)}</TableBody>
            </Table>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}

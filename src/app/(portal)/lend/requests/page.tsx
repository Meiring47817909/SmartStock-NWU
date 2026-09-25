'use client'

import { Fragment, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { db } from '@/lib/firebase/config'
import { collection, query, where, getDocs } from 'firebase/firestore'
import { useStaffPortal } from '@/context/StaffPortalContext'
import { acceptCounter, declineCounter, withdrawRequest, expireIfNeeded } from '@/lib/firebase/loanRequests'
import { formatDateOnly, formatLendWindow } from '@/lib/utils'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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

function RequestCard({
  request, lines, busy, onAccept, onDecline, onWithdraw,
}: {
  request: LoanRequest
  lines: LoanRequestLine[]
  busy: boolean
  onAccept?: () => void
  onDecline?: () => void
  onWithdraw?: () => void
}) {
  const datesChanged = request.from_date !== request.original_from_date || request.to_date !== request.original_to_date

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between border-b py-3">
        <CardTitle className="flex flex-wrap items-baseline gap-2 text-sm">
          {formatLendWindow(request.from_date, request.to_date)}
          {/* The reference is what the staff member quotes if they email
              or phone the IT Store about this request. */}
          {request.reference_no && (
            <span className="font-mono text-xs font-normal text-muted-foreground">
              {request.reference_no}
            </span>
          )}
        </CardTitle>
        <Badge className={`${STATUS_BADGE_CLASS[request.status]} uppercase`}>{request.status.replace('_', ' ')}</Badge>
      </CardHeader>
      <div className="flex flex-col gap-3 p-4">
        {request.status === 'countered' && (
          <div className="flex flex-col gap-1.5">
            {lines.map((l) => (
              <div key={l.id} className="flex items-center gap-2 text-sm">
                <span className="min-w-[140px] font-medium">{l.product_name}</span>
                <span className="text-muted-foreground">You asked for {l.requested_quantity}</span>
                <span className="text-muted-foreground">→</span>
                {l.offered_quantity > 0 ? (
                  <span className="font-semibold text-foreground">Offered {l.offered_quantity}</span>
                ) : (
                  <span className="font-semibold text-destructive">Dropped</span>
                )}
              </div>
            ))}
            {datesChanged && (
              <div className="mt-1 text-sm text-muted-foreground">
                Dates changed from <span className="line-through">{formatDateOnly(request.original_from_date)} – {formatDateOnly(request.original_to_date)}</span>{' '}
                to <span className="font-semibold text-foreground">{formatDateOnly(request.from_date)} – {formatDateOnly(request.to_date)}</span>
              </div>
            )}
          </div>
        )}

        {request.status !== 'countered' && (
          <ul className="ml-4 list-disc text-sm text-muted-foreground">
            {lines.map((l) => (
              <li key={l.id}>{l.product_name} × {l.offered_quantity}</li>
            ))}
          </ul>
        )}

        {request.message && (
          <div>
            <p className="text-xs font-medium text-muted-foreground">Your note</p>
            <p className="text-sm text-muted-foreground">&ldquo;{request.message}&rdquo;</p>
          </div>
        )}

        {request.admin_message && (
          <div className="rounded-md border bg-muted/50 p-2">
            <p className="text-xs font-medium text-muted-foreground">Message from Selouna</p>
            <p className="mt-0.5 text-sm text-foreground">&ldquo;{request.admin_message}&rdquo;</p>
          </div>
        )}

        <div className="flex items-center gap-2">
          {onAccept && <Button size="sm" disabled={busy} onClick={onAccept}>{busy ? '…' : 'Accept'}</Button>}
          {onDecline && <Button size="sm" variant="outline" disabled={busy} onClick={onDecline}>Decline</Button>}
          {onWithdraw && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={onWithdraw} className="text-destructive hover:text-destructive">
              Withdraw
            </Button>
          )}
        </div>
      </div>
    </Card>
  )
}

export default function MyRequestsPage() {
  const { user, staffMember } = useStaffPortal()
  const [requests, setRequests] = useState<LoanRequest[]>([])
  const [linesByRequest, setLinesByRequest] = useState<Record<string, LoanRequestLine[]>>({})
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    if (staffMember) load()
  }, [staffMember]) // eslint-disable-line react-hooks/exhaustive-deps

  async function load() {
    if (!staffMember) return
    setLoading(true)
    const reqSnap = await getDocs(query(collection(db, 'loan_requests'), where('staff_id', '==', staffMember.id.toString())))
    let reqs = reqSnap.docs.map((d) => ({ id: d.id, ...d.data() })) as LoanRequest[]

    reqs = await Promise.all(reqs.map(async (r) => {
      if (r.status !== 'pending' && r.status !== 'countered' && r.status !== 'accepted') return r
      const next = await expireIfNeeded(r)
      return next !== r.status ? { ...r, status: next, updated_at: new Date().toISOString() } : r
    }))

    // Broad read + filter client-side (this app's consistent convention —
    // see loanRequests.ts's getReservedQuantity) rather than an `in` query,
    // which has a value-count cap and needs no composite index here anyway.
    const requestIds = new Set(reqs.map((r) => r.id))
    const linesSnap = await getDocs(collection(db, 'loan_request_lines'))
    const byRequest: Record<string, LoanRequestLine[]> = {}
    linesSnap.forEach((d) => {
      const l = { id: d.id, ...d.data() } as LoanRequestLine
      if (!requestIds.has(l.request_id)) return
      ;(byRequest[l.request_id] ??= []).push(l)
    })

    setRequests(reqs)
    setLinesByRequest(byRequest)
    setLoading(false)
  }

  async function handleAccept(r: LoanRequest) {
    setBusy(r.id)
    try {
      await acceptCounter(r, { userId: user?.uid, userName: staffMember?.full_name })
      toast.success('Accepted — see you at pickup!')
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to accept.')
    }
    setBusy(null)
  }

  async function handleDecline(r: LoanRequest) {
    setBusy(r.id)
    try {
      await declineCounter(r, { userId: user?.uid, userName: staffMember?.full_name })
      toast.success('Declined.')
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to decline.')
    }
    setBusy(null)
  }

  async function handleWithdraw(r: LoanRequest) {
    setBusy(r.id)
    try {
      await withdrawRequest(r, { userId: user?.uid, userName: staffMember?.full_name })
      toast.success('Request withdrawn.')
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to withdraw.')
    }
    setBusy(null)
  }

  const countered = requests.filter((r) => r.status === 'countered')
  const pending = requests.filter((r) => r.status === 'pending')
  const accepted = requests.filter((r) => r.status === 'accepted')
  const history = requests.filter((r) => TERMINAL.includes(r.status)).sort((a, b) => b.updated_at.localeCompare(a.updated_at))

  if (loading) return <div className="p-8 text-center text-sm text-muted-foreground">Loading…</div>

  return (
    <div className="flex max-w-[700px] flex-col gap-8">
      <div>
        <h1 className="text-2xl font-bold text-foreground">My Requests</h1>
        <p className="mt-1 text-sm text-muted-foreground">Track your lending requests and respond to Selouna&apos;s counters.</p>
      </div>

      {requests.length === 0 && (
        <p className="text-sm text-muted-foreground">You haven&apos;t submitted any requests yet.</p>
      )}

      {countered.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-bold tracking-wide text-muted-foreground uppercase">Needs your response</h2>
          {countered.map((r) => (
            <Fragment key={r.id}>
              <RequestCard request={r} lines={linesByRequest[r.id] ?? []} busy={busy === r.id}
                onAccept={() => handleAccept(r)} onDecline={() => handleDecline(r)} />
            </Fragment>
          ))}
        </section>
      )}

      {pending.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-bold tracking-wide text-muted-foreground uppercase">Awaiting Selouna</h2>
          {pending.map((r) => (
            <RequestCard key={r.id} request={r} lines={linesByRequest[r.id] ?? []} busy={busy === r.id}
              onWithdraw={() => handleWithdraw(r)} />
          ))}
        </section>
      )}

      {accepted.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-bold tracking-wide text-muted-foreground uppercase">Upcoming</h2>
          {accepted.map((r) => (
            <RequestCard key={r.id} request={r} lines={linesByRequest[r.id] ?? []} busy={busy === r.id}
              onWithdraw={() => handleWithdraw(r)} />
          ))}
        </section>
      )}

      {history.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-bold tracking-wide text-muted-foreground uppercase">History</h2>
          {history.map((r) => (
            <RequestCard key={r.id} request={r} lines={linesByRequest[r.id] ?? []} busy={busy === r.id} />
          ))}
        </section>
      )}
    </div>
  )
}

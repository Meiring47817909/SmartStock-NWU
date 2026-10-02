'use client'

import { Fragment, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { notifyLoanRequestEvent } from '@/lib/firebase/notifyEvent'
import { db } from '@/lib/firebase/config'
import { collection, query, where, getDocs } from 'firebase/firestore'
import { useStaffPortal } from '@/context/StaffPortalContext'
import { acceptCounter, declineCounter, withdrawRequest, expireIfNeeded, computeExpiryDate, effectiveToDate, OPEN_ENDED_TO } from '@/lib/firebase/loanRequests'
import { notifyAlertsChanged } from '@/lib/alertsBus'
import { formatDateOnly, formatLendWindow, sentenceCase } from '@/lib/utils'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { PortalPagination, paginateList, type PortalPageSize } from '@/components/portal-pagination'
import type { LoanRequest, LoanRequestLine, LoanRequestStatus } from '@/types/database'

const STATUS_BADGE_CLASS: Record<LoanRequestStatus, string> = {
  pending: 'bg-amber-100 text-amber-800 border-amber-200/60 px-2.5 font-semibold',
  countered: 'bg-sky-100 text-sky-800 border-sky-200/60 px-2.5 font-semibold',
  accepted: 'bg-emerald-100 text-emerald-800 border-emerald-200/60 px-2.5 font-semibold',
  fulfilled: 'bg-accent text-accent-foreground border-transparent px-2.5 font-semibold',
  declined: 'bg-red-100 text-red-800 border-red-200/60 px-2.5 font-semibold',
  expired: 'bg-muted text-muted-foreground border-transparent px-2.5 font-semibold',
  withdrawn: 'bg-muted text-muted-foreground border-transparent px-2.5 font-semibold',
  no_show: 'bg-red-100 text-red-800 border-red-200/60 px-2.5 font-semibold',
}

const TERMINAL: LoanRequestStatus[] = ['declined', 'expired', 'withdrawn', 'fulfilled', 'no_show']

type RequestTab = 'countered' | 'pending' | 'accepted' | 'history'

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
    <Card className="rounded-xl border border-[#E2D8E9] bg-white shadow-sm ring-0">
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
        <Badge className={STATUS_BADGE_CLASS[request.status]}>{sentenceCase(request.status.replace('_', ' '))}</Badge>
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
          {onDecline && (
            <Button size="sm" variant="outline" disabled={busy} onClick={onDecline} className="border-[#D5C6E0] bg-[#F0EBF5] font-semibold text-red-600 hover:bg-[#E4D9EE] hover:text-red-700">
              Decline
            </Button>
          )}
          {onWithdraw && (
            <Button size="sm" variant="outline" disabled={busy} onClick={onWithdraw} className="border-[#D5C6E0] bg-[#F0EBF5] font-semibold text-red-600 hover:bg-[#E4D9EE] hover:text-red-700">
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

  const [tab, setTab] = useState<RequestTab>('countered')
  const [pageIndex, setPageIndex] = useState(0)
  // Fixed at 10 rows per page, no rows-per-page selector.
  const pageSize: PortalPageSize = 10

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
      notifyLoanRequestEvent(user, 'loan_request_counter_accepted', r.id)
      toast.success('Accepted — see you at pickup!')
      await load()
      notifyAlertsChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to accept.')
    }
    setBusy(null)
  }

  async function handleDecline(r: LoanRequest) {
    setBusy(r.id)
    try {
      await declineCounter(r, { userId: user?.uid, userName: staffMember?.full_name })
      notifyLoanRequestEvent(user, 'loan_request_counter_declined', r.id)
      toast.success('Declined.')
      await load()
      notifyAlertsChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to decline.')
    }
    setBusy(null)
  }

  async function handleWithdraw(r: LoanRequest) {
    setBusy(r.id)
    try {
      await withdrawRequest(r, { userId: user?.uid, userName: staffMember?.full_name })
      notifyLoanRequestEvent(user, 'loan_request_withdrawn', r.id)
      toast.success('Request withdrawn.')
      await load()
      notifyAlertsChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to withdraw.')
    }
    setBusy(null)
  }

  // Needs your response / Awaiting Selouna: soonest-to-expire first, using
  // the SAME computed expiry expireIfNeeded() itself acts on --
  // computeExpiryDate() = min(updated_at + 30 days, from_date) -- rather
  // than just the lend window's start date. A request sitting untouched
  // for weeks can be closer to silently expiring than one with a nearer
  // from_date, so this is the actual "act on this first" order, not an
  // approximation of it. (computeExpiryDate only returns null for a
  // non-pending/countered request, which never happens here since both
  // arrays are already filtered to those statuses -- the OPEN_ENDED_TO
  // fallback just satisfies the return type.)
  const byExpiryAsc = (a: LoanRequest, b: LoanRequest) =>
    (computeExpiryDate(a) ?? OPEN_ENDED_TO).localeCompare(computeExpiryDate(b) ?? OPEN_ENDED_TO)

  // Upcoming: soonest-to-lapse-into-a-no-show first, using the window's end
  // date (effectiveToDate -- "never" for an Indefinite item), the same date
  // isNoShowCandidate() checks. That's the pickup actually at risk of being
  // missed, not necessarily the one that merely starts soonest.
  const byWindowEndAsc = (a: LoanRequest, b: LoanRequest) =>
    effectiveToDate(a.to_date).localeCompare(effectiveToDate(b.to_date))

  // History: nothing here is actionable, so it's just newest-first by the
  // request's own lend window start date (from_date -- the date shown on
  // each card), matching what you're actually looking at.
  const byFromDateDesc = (a: LoanRequest, b: LoanRequest) => b.from_date.localeCompare(a.from_date)

  const countered = requests.filter((r) => r.status === 'countered').sort(byExpiryAsc)
  const pending = requests.filter((r) => r.status === 'pending').sort(byExpiryAsc)
  const accepted = requests.filter((r) => r.status === 'accepted').sort(byWindowEndAsc)
  const history = requests.filter((r) => TERMINAL.includes(r.status)).sort(byFromDateDesc)

  // Every tab's own paginateList call, all sharing one pageIndex/pageSize —
  // only the active tab's slice and pagination footer are ever visible, and
  // switching tabs resets pageIndex (below) so "page 2" never carries over
  // into a differently-sized section.
  const covPage = paginateList(countered, pageIndex, pageSize)
  const penPage = paginateList(pending, pageIndex, pageSize)
  const accPage = paginateList(accepted, pageIndex, pageSize)
  const hisPage = paginateList(history, pageIndex, pageSize)

  function changeTab(next: string) {
    setTab(next as RequestTab)
    setPageIndex(0)
  }

  if (loading) return <div className="p-8 text-center text-sm text-muted-foreground">Loading…</div>

  return (
    // Centered within the now-wider portal layout (see (portal)/lend/layout.tsx)
    // and as wide as Cart's own content, rather than sitting flush-left in
    // the extra space at 700px.
    <div className="mx-auto flex max-w-[1000px] flex-col gap-6">
      <div className="space-y-1">
        <h1 className="text-3xl font-extrabold tracking-tight text-[#22162B]">My Requests</h1>
        <p className="text-sm text-[#5B4F67]">Track your lending requests and respond to Selouna&apos;s counters.</p>
      </div>

      {requests.length === 0 ? (
        <p className="text-sm text-muted-foreground">You haven&apos;t submitted any requests yet.</p>
      ) : (
        <Tabs value={tab} onValueChange={changeTab} className="flex flex-col gap-4">
          {/* Same segmented-control tab bar as Dashboard/Reports/Loan
              Requests: a bordered light-grey track, each tab flex-1 across
              the full width, the active one a solid NWU-purple pill with
              white text. Forced !h-14/!h-11 heights (rather than h-auto)
              because TabsTrigger's own base class hardcodes
              h-[calc(100%-1px)], which otherwise wins and stretches every
              tab to the track's full height with no breathing room
              top/bottom. */}
          <TabsList className="flex w-full !h-14 gap-1.5 overflow-hidden rounded-2xl border border-purple-200/50 bg-white/60 p-1.5 backdrop-blur-sm">
            <TabsTrigger
              value="countered"
              className="!h-11 flex-1 cursor-pointer self-center rounded-xl px-4 text-sm font-semibold whitespace-nowrap text-(--nwu-grey-dark) transition-all not-data-active:hover:bg-white/70 not-data-active:hover:text-foreground data-active:bg-(--nwu-purple) data-active:text-white data-active:shadow-md"
            >
              Needs your response
              {countered.length > 0 && <Badge className="bg-(--nwu-turquoise) text-white">{countered.length}</Badge>}
            </TabsTrigger>
            <TabsTrigger
              value="pending"
              className="!h-11 flex-1 cursor-pointer self-center rounded-xl px-4 text-sm font-semibold whitespace-nowrap text-(--nwu-grey-dark) transition-all not-data-active:hover:bg-white/70 not-data-active:hover:text-foreground data-active:bg-(--nwu-purple) data-active:text-white data-active:shadow-md"
            >
              Awaiting Selouna
              {pending.length > 0 && <Badge className="bg-(--nwu-turquoise) text-white">{pending.length}</Badge>}
            </TabsTrigger>
            <TabsTrigger
              value="accepted"
              className="!h-11 flex-1 cursor-pointer self-center rounded-xl px-4 text-sm font-semibold whitespace-nowrap text-(--nwu-grey-dark) transition-all not-data-active:hover:bg-white/70 not-data-active:hover:text-foreground data-active:bg-(--nwu-purple) data-active:text-white data-active:shadow-md"
            >
              Upcoming
              {accepted.length > 0 && <Badge className="bg-(--nwu-turquoise) text-white">{accepted.length}</Badge>}
            </TabsTrigger>
            <TabsTrigger
              value="history"
              className="!h-11 flex-1 cursor-pointer self-center rounded-xl px-4 text-sm font-semibold whitespace-nowrap text-(--nwu-grey-dark) transition-all not-data-active:hover:bg-white/70 not-data-active:hover:text-foreground data-active:bg-(--nwu-purple) data-active:text-white data-active:shadow-md"
            >
              History
            </TabsTrigger>
          </TabsList>

          <TabsContent value="countered" className="flex flex-col gap-3">
            {covPage.pageRows.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing needs your response right now.</p>
            ) : (
              covPage.pageRows.map((r) => (
                <Fragment key={r.id}>
                  <RequestCard request={r} lines={linesByRequest[r.id] ?? []} busy={busy === r.id}
                    onAccept={() => handleAccept(r)} onDecline={() => handleDecline(r)} />
                </Fragment>
              ))
            )}
            {countered.length > 0 && (
              <PortalPagination pageIndex={covPage.safeIndex} pageSize={pageSize} totalRows={countered.length}
                onPageIndexChange={setPageIndex} />
            )}
          </TabsContent>

          <TabsContent value="pending" className="flex flex-col gap-3">
            {penPage.pageRows.length === 0 ? (
              <p className="text-sm text-muted-foreground">No pending requests.</p>
            ) : (
              penPage.pageRows.map((r) => (
                <RequestCard key={r.id} request={r} lines={linesByRequest[r.id] ?? []} busy={busy === r.id}
                  onWithdraw={() => handleWithdraw(r)} />
              ))
            )}
            {pending.length > 0 && (
              <PortalPagination pageIndex={penPage.safeIndex} pageSize={pageSize} totalRows={pending.length}
                onPageIndexChange={setPageIndex} />
            )}
          </TabsContent>

          <TabsContent value="accepted" className="flex flex-col gap-3">
            {accPage.pageRows.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing upcoming.</p>
            ) : (
              accPage.pageRows.map((r) => (
                <RequestCard key={r.id} request={r} lines={linesByRequest[r.id] ?? []} busy={busy === r.id}
                  onWithdraw={() => handleWithdraw(r)} />
              ))
            )}
            {accepted.length > 0 && (
              <PortalPagination pageIndex={accPage.safeIndex} pageSize={pageSize} totalRows={accepted.length}
                onPageIndexChange={setPageIndex} />
            )}
          </TabsContent>

          <TabsContent value="history" className="flex flex-col gap-3">
            {hisPage.pageRows.length === 0 ? (
              <p className="text-sm text-muted-foreground">No history yet.</p>
            ) : (
              hisPage.pageRows.map((r) => (
                <RequestCard key={r.id} request={r} lines={linesByRequest[r.id] ?? []} busy={busy === r.id} />
              ))
            )}
            {history.length > 0 && (
              <PortalPagination pageIndex={hisPage.safeIndex} pageSize={pageSize} totalRows={history.length}
                onPageIndexChange={setPageIndex} />
            )}
          </TabsContent>
        </Tabs>
      )}
    </div>
  )
}

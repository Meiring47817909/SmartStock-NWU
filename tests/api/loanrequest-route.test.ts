// Route test for POST /api/notifications/loan-request (emails after a loan-request transition). The request, its lines,
// the staff member and the caller's role come from the test PostgreSQL database; the notification settings and the
// sent-notification markers still live in Firestore until the settings task, so the Admin SDK is replaced with an
// in-memory stand-in. Mail goes to a throwaway local SMTP server (it rejects one address, to prove a failing email does
// not hide the other). Same cases as the scratch harness this replaces (check-loanrequest-route.mts, 41 checks).
import type { AddressInfo } from 'node:net'
import { eq } from 'drizzle-orm'
import { simpleParser, type ParsedMail } from 'mailparser'
import { SMTPServer } from 'smtp-server'
import type { NextRequest } from 'next/server'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const fire = vi.hoisted(() => ({ docs: {} as Record<string, Record<string, unknown>>, reads: 0 }))

// In-memory stand-in for the Firestore Admin SDK pieces notificationDelivery.ts uses: doc get / create / delete.
vi.mock('@/lib/firebase/admin', () => {
  const rows = (col: string) => fire.docs[col] ?? {}
  return {
    adminDb: {
      collection(col: string) {
        return {
          doc(id: string) {
            return {
              async get() {
                fire.reads++
                const d = rows(col)[id]
                return { exists: d !== undefined, data: () => d, id }
              },
              // Admin SDK create(): fails with gRPC code 6 (ALREADY_EXISTS) if the doc exists.
              async create(data: unknown) {
                if (rows(col)[id] !== undefined) {
                  throw Object.assign(new Error(`6 ALREADY_EXISTS: Document already exists: ${col}/${id}`), { code: 6 })
                }
                fire.docs[col] = { ...rows(col), [id]: data }
              },
              async delete() {
                const next = { ...rows(col) }
                delete next[id]
                fire.docs[col] = next
              },
            }
          },
        }
      },
    },
  }
})

import { POST } from '@/app/api/notifications/loan-request/route'
import { loanRequestLines, loanRequests, products, profiles, staff } from '@/server/db/schema'
import type { Db } from '@/server/db/client'
import { installFakeAuth, tokenFor } from '../helpers/auth'
import { closeTestDb, resetTestDb } from '../helpers/db'

const STAFF = 'jessica@example.com'
const ADMIN = 'selouna@nwu.test'
const T0 = new Date('2026-10-01T08:00:00.000Z')
const ENV_KEYS = ['MAIL_TRANSPORT', 'SMTP_HOST', 'SMTP_PORT', 'FIREBASE_AUTH_EMULATOR_HOST', 'FIRESTORE_EMULATOR_HOST', 'APP_BASE_URL']

let db: Db
let restoreAuth: () => void
let sink: SMTPServer
let sinkPort: number
let deadPort: number // a port nothing listens on
const sent: ParsedMail[] = []
const savedEnv: Record<string, string | undefined> = {}

function listen(server: SMTPServer): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.server.address() as AddressInfo).port)))
}
const close = (server: SMTPServer) => new Promise<void>((resolve) => server.close(() => resolve()))

beforeAll(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k]
  db = await resetTestDb()
  restoreAuth = installFakeAuth(db)
  sink = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS', 'AUTH'],
    onRcptTo(addr, _session, cb) {
      if (addr.address === 'bad@example.com') cb(new Error('550 mailbox rejected'))
      else cb()
    },
    onData(stream, _session, cb) {
      const chunks: Buffer[] = []
      stream.on('data', (c: Buffer) => chunks.push(c))
      stream.on('end', async () => {
        sent.push(await simpleParser(Buffer.concat(chunks)))
        cb()
      })
    },
  })
  sinkPort = await listen(sink)
  const probe = new SMTPServer({})
  deadPort = await listen(probe)
  await close(probe)
})

afterAll(async () => {
  await close(sink)
  restoreAuth()
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  await closeTestDb()
})

interface SetupOpts {
  request?: Partial<typeof loanRequests.$inferInsert>
  s1?: Partial<typeof staff.$inferInsert>
  settings?: Record<string, unknown>
  env?: Record<string, string | undefined>
}

// The base data: request r1 (Jessica's, s1) in `status`, with two lines: USB-C Cable 1m asked 3 / offered 2 and
// Wireless Mouse asked 1 / offered 0 (dropped). Jessica logs in as borrower1, another borrower is other1 (s2).
async function setup(status: string, opts: SetupOpts = {}) {
  db = await resetTestDb()
  restoreAuth()
  restoreAuth = installFakeAuth(db)
  await db.insert(profiles).values([
    { uid: 'admin1', full_name: 'Ada Admin', role: 'admin' },
    { uid: 'borrower1', full_name: 'Jessica Moore', role: 'staff' },
    { uid: 'other1', full_name: 'Other Person', role: 'staff' },
  ])
  await db.insert(staff).values([
    { id: 's1', name: 'Jessica', surname: 'Moore', full_name: 'Jessica Moore', email: ` ${STAFF} `, uid: 'borrower1', ...opts.s1 },
    { id: 's2', name: 'Other', surname: 'Person', full_name: 'Other Person', email: 'other@example.com', uid: 'other1' },
  ])
  await db.insert(products).values([
    { id: 'p1', name: 'USB-C Cable 1m', quantity_on_hand: 10, reorder_threshold: 2, location: 'G4', created_at: T0, updated_at: T0 },
    { id: 'p2', name: 'Wireless Mouse', quantity_on_hand: 10, reorder_threshold: 2, location: 'G4', created_at: T0, updated_at: T0 },
  ])
  await db.insert(loanRequests).values({
    id: 'r1', staff_id: 's1', staff_name: 'Jessica Moore', status: status as typeof loanRequests.$inferInsert.status,
    reference_no: 'LR-1234ABCD', message: 'Needed for the open day.', admin_message: 'Only 2 cables left.',
    from_date: '2026-10-07', to_date: '2026-10-14', original_from_date: '2026-10-05', original_to_date: '2026-10-12',
    created_at: T0, updated_at: new Date('2026-10-07T10:00:00.000Z'), ...opts.request,
  })
  await db.insert(loanRequestLines).values([
    { id: 'l1', request_id: 'r1', product_id: 'p1', product_name: 'USB-C Cable 1m', line_no: 0, requested_quantity: 3, offered_quantity: 2, created_at: T0 },
    { id: 'l2', request_id: 'r1', product_id: 'p2', product_name: 'Wireless Mouse', line_no: 1, requested_quantity: 1, offered_quantity: 0, created_at: T0 },
  ])
  fire.docs = { settings: { notifications: opts.settings ?? { admin_notification_email: ADMIN } } }
  fire.reads = 0
  sent.length = 0
  for (const k of ENV_KEYS) delete process.env[k]
  Object.assign(process.env, { MAIL_TRANSPORT: 'smtp', SMTP_HOST: '127.0.0.1', SMTP_PORT: String(sinkPort) }, opts.env)
  for (const [k, v] of Object.entries(opts.env ?? {})) if (v === undefined) delete process.env[k]
}

async function call(body: unknown, token: string | null = 'admin1', rawBody?: string) {
  const res = await POST(
    new Request('http://localhost/api/notifications/loan-request', {
      method: 'POST',
      headers: token ? { authorization: `Bearer ${tokenFor(token)}` } : {},
      body: rawBody ?? JSON.stringify(body),
    }) as unknown as NextRequest,
  )
  return { status: res.status, body: await res.json() }
}

const to = (m: ParsedMail) => (m.to as { value: { address: string }[] }).value[0].address
const markers = () => Object.keys(fire.docs.sent_notifications ?? {})

const CASES = [
  { event: 'new_loan_request', token: 'borrower1', status: 'pending', emails: [[ADMIN, 'New loan request LR-1234ABCD from Jessica Moore']] },
  { event: 'loan_request_approved', token: 'admin1', status: 'accepted', emails: [[STAFF, 'Loan request LR-1234ABCD approved'], [ADMIN, 'Pickup confirmed: Jessica Moore (LR-1234ABCD)']] },
  { event: 'loan_request_countered', token: 'admin1', status: 'countered', emails: [[STAFF, 'Loan request LR-1234ABCD countered']] },
  { event: 'loan_request_declined', token: 'admin1', status: 'declined', emails: [[STAFF, 'Loan request LR-1234ABCD declined']] },
  { event: 'approved_pickup_cancelled', token: 'admin1', status: 'withdrawn', emails: [[STAFF, 'Loan request LR-1234ABCD pickup cancelled']] },
  { event: 'loan_request_counter_accepted', token: 'borrower1', status: 'accepted', emails: [[STAFF, 'Loan request LR-1234ABCD counter accepted'], [ADMIN, 'Pickup confirmed: Jessica Moore (LR-1234ABCD)']] },
  { event: 'loan_request_counter_declined', token: 'borrower1', status: 'declined', emails: [[STAFF, 'Loan request LR-1234ABCD counter declined']] },
  { event: 'loan_request_withdrawn', token: 'borrower1', status: 'withdrawn', emails: [[STAFF, 'Loan request LR-1234ABCD withdrawn']] },
]

describe('POST /api/notifications/loan-request', () => {
  it('no Authorization header -> 401', async () => {
    await setup('accepted')
    expect((await call({ event: 'loan_request_approved', requestId: 'r1' }, null)).status).toBe(401)
  })

  it('unknown event, missing or non-string requestId, unreadable body -> 400', async () => {
    await setup('accepted')
    expect((await call({ event: 'loan_request_expired', requestId: 'r1' })).status).toBe(400)
    expect((await call({ event: 'loan_request_approved' })).status).toBe(400)
    expect((await call({ event: 'loan_request_approved', requestId: 5 })).status).toBe(400)
    expect((await call(undefined, 'admin1', 'this is not json')).status).toBe(400)
  })

  it('unknown request -> 404', async () => {
    await setup('accepted')
    expect((await call({ event: 'loan_request_approved', requestId: 'nope' })).status).toBe(404)
  })

  it('mail disabled -> mail_disabled result and no database reads at all', async () => {
    await setup('accepted', { env: { MAIL_TRANSPORT: undefined } })
    const r = await call({ event: 'loan_request_approved', requestId: 'r1' })
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ results: [{ toggle: 'loan_request_approved', sent: false, reason: 'mail_disabled' }] })
    expect(fire.reads).toBe(0)
    // The request is not even looked up in PostgreSQL: an unknown id answers mail_disabled too.
    expect((await call({ event: 'loan_request_approved', requestId: 'nope' })).body).toEqual(r.body)
  })

  for (const c of CASES) {
    it(`${c.event}: happy path sends ${c.emails.length} email(s) to the right inbox(es) with the reference in the subject`, async () => {
      await setup(c.status)
      const r = await call({ event: c.event, requestId: 'r1' }, c.token)
      expect(r.status, JSON.stringify(r.body)).toBe(200)
      expect(r.body.results).toHaveLength(c.emails.length)
      expect(r.body.results.every((x: { sent: boolean }) => x.sent === true), JSON.stringify(r.body)).toBe(true)
      expect(sent).toHaveLength(c.emails.length)
      for (const [addr, subject] of c.emails) {
        const m = sent.find((s) => to(s) === addr)
        expect(m, `no email to ${addr}`).toBeTruthy()
        expect(m?.subject).toBe(subject)
      }
    })

    it(`${c.event}: status that does not match -> 409, nothing sent`, async () => {
      await setup(c.event === 'new_loan_request' ? 'accepted' : 'pending')
      const r = await call({ event: c.event, requestId: 'r1' }, c.token)
      expect(r.status).toBe(409)
      expect(sent).toHaveLength(0)
    })

    it(`${c.event}: the other kind of caller -> 403, nothing sent`, async () => {
      await setup(c.status)
      const r = await call({ event: c.event, requestId: 'r1' }, c.token === 'admin1' ? 'borrower1' : 'admin1')
      expect(r.status).toBe(403)
      expect(sent).toHaveLength(0)
    })
  }

  it('a borrower who does not own the request cannot trigger borrower events -> 403', async () => {
    await setup('withdrawn')
    expect((await call({ event: 'loan_request_withdrawn', requestId: 'r1' }, 'other1')).status).toBe(403)
    await setup('pending')
    expect((await call({ event: 'new_loan_request', requestId: 'r1' }, 'other1')).status).toBe(403)
    expect(sent).toHaveLength(0)
  })

  it('approved sends the standing items to the staff member (zero-offered line dropped)', async () => {
    await setup('accepted')
    await call({ event: 'loan_request_approved', requestId: 'r1' })
    const m = sent.find((s) => to(s) === STAFF)
    expect(m?.text).toContain('- USB-C Cable 1m × 2')
    expect(m?.text).not.toContain('Wireless Mouse')
    expect(m?.text).toContain('http://localhost:3000/lend/requests')
    expect(sent.find((s) => to(s) === ADMIN)?.text).toContain('http://localhost:3000/dashboard')
  })

  it('APP_BASE_URL is used for the buttons', async () => {
    await setup('pending', { env: { APP_BASE_URL: 'https://smartstock.example/' } })
    await call({ event: 'new_loan_request', requestId: 'r1' }, 'borrower1')
    expect(sent[0].text).toContain('https://smartstock.example/loan-requests')
  })

  it('countered email carries requested -> offered, the note and the date change', async () => {
    await setup('countered')
    await call({ event: 'loan_request_countered', requestId: 'r1' })
    const t = sent[0].text ?? ''
    expect(t).toContain('USB-C Cable 1m: 3 → 2')
    expect(t).toContain('Wireless Mouse: 1 → removed')
    expect(t).toContain('Only 2 cables left.')
    expect(t).toContain('5 October 2026')
  })

  it('lines come out in cart order (line_no), whatever their ids or insert order', async () => {
    await setup('accepted')
    // Same created_at on both and ids that sort the other way round: only line_no says Mouse comes first.
    await db.update(loanRequestLines).set({ line_no: 1 }).where(eq(loanRequestLines.id, 'l1'))
    await db.update(loanRequestLines).set({ line_no: 0, offered_quantity: 1 }).where(eq(loanRequestLines.id, 'l2'))
    await call({ event: 'loan_request_approved', requestId: 'r1' })
    const t = sent.find((s) => to(s) === STAFF)?.text ?? ''
    expect(t.indexOf('Wireless Mouse')).toBeGreaterThan(-1)
    expect(t.indexOf('Wireless Mouse')).toBeLessThan(t.indexOf('USB-C Cable 1m'))
  })

  it('fan-out: incoming_pickup_confirmed off -> only the staff email goes out', async () => {
    await setup('accepted', { settings: { admin_notification_email: ADMIN, incoming_pickup_confirmed: false } })
    const r = await call({ event: 'loan_request_approved', requestId: 'r1' })
    expect(r.body.results).toEqual([{ toggle: 'loan_request_approved', sent: true }, { toggle: 'incoming_pickup_confirmed', sent: false, reason: 'toggle_off' }])
    expect(sent).toHaveLength(1)
    expect(to(sent[0])).toBe(STAFF)
  })

  it('fan-out: staff email blank -> the admin email still goes out', async () => {
    await setup('accepted', { s1: { email: '  ' } })
    const r = await call({ event: 'loan_request_approved', requestId: 'r1' })
    expect(r.body.results).toEqual([{ toggle: 'loan_request_approved', sent: false, reason: 'no_email' }, { toggle: 'incoming_pickup_confirmed', sent: true }])
    expect(sent).toHaveLength(1)
    expect(to(sent[0])).toBe(ADMIN)
  })

  it('fan-out: one email failing does not stop or hide the other; failed marker removed, sent one kept', async () => {
    await setup('accepted', { s1: { email: 'bad@example.com' } })
    const r = await call({ event: 'loan_request_approved', requestId: 'r1' })
    expect(r.status).toBe(500)
    expect(sent).toHaveLength(1)
    expect(to(sent[0])).toBe(ADMIN)
    expect(markers()).toEqual(['incoming_pickup_confirmed__r1__2026-10-07T10:00:00.000Z'])
  })

  it('blank admin inbox -> admin email no_email, 200', async () => {
    await setup('pending', { settings: {} })
    const r = await call({ event: 'new_loan_request', requestId: 'r1' }, 'borrower1')
    expect(r.status).toBe(200)
    expect(r.body.results).toEqual([{ toggle: 'new_loan_request', sent: false, reason: 'no_email' }])
  })

  it('cancel reason is cut to 500 characters and only used by the cancel email', async () => {
    await setup('withdrawn')
    await call({ event: 'approved_pickup_cancelled', requestId: 'r1', reason: 'x'.repeat(600) })
    expect(sent[0].text).toContain(`Reason: ${'x'.repeat(500)}`)
    expect(sent[0].text).not.toContain('x'.repeat(501))
    await setup('accepted')
    await call({ event: 'loan_request_approved', requestId: 'r1', reason: 'SECRETREASON' })
    expect(sent.every((m) => !m.text?.includes('SECRETREASON'))).toBe(true)
  })

  it('same call twice -> second result is duplicate, one email', async () => {
    await setup('accepted')
    await call({ event: 'loan_request_counter_accepted', requestId: 'r1' }, 'borrower1')
    const r = await call({ event: 'loan_request_counter_accepted', requestId: 'r1' }, 'borrower1')
    expect(r.body.results.every((x: { reason?: string }) => x.reason === 'duplicate'), JSON.stringify(r.body)).toBe(true)
    expect(sent).toHaveLength(2)
  })

  it('a later transition of the same request (new updated_at) sends again', async () => {
    await setup('accepted')
    await call({ event: 'loan_request_approved', requestId: 'r1' })
    await db.update(loanRequests).set({ updated_at: new Date('2026-10-09T09:00:00.000Z') }).where(eq(loanRequests.id, 'r1'))
    await call({ event: 'loan_request_approved', requestId: 'r1' })
    expect(sent).toHaveLength(4)
  })

  it('SMTP server down -> 502 with the Mailpit message and no marker left behind', async () => {
    await setup('pending', { env: { SMTP_PORT: String(deadPort) } })
    const r = await call({ event: 'new_loan_request', requestId: 'r1' }, 'borrower1')
    expect(r.status).toBe(502)
    expect(r.body.error).toBe('Mail server not reachable. Is Mailpit running? (npm run mailpit)')
    expect(markers()).toEqual([])
  })

  it('hostile staff name in the request is escaped in the delivered html', async () => {
    await setup('pending', { request: { staff_name: '<script>alert(1)</script>' } })
    await call({ event: 'new_loan_request', requestId: 'r1' }, 'borrower1')
    expect(sent[0].html).not.toContain('<script>')
  })
})

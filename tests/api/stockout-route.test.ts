// Route test for POST /api/notifications/stock-out (confirmation email to the staff member and low stock alert to the
// admin inbox after a Stock Out). The transaction, its lines, the staff member, the products, the caller's role, the
// notification settings and the sent-notification markers all come from the test PostgreSQL database. Mail goes to a
// throwaway local SMTP server.
import type { AddressInfo } from 'node:net'
import { eq, sql } from 'drizzle-orm'
import { simpleParser, type ParsedMail } from 'mailparser'
import { SMTPServer } from 'smtp-server'
import type { NextRequest } from 'next/server'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Counts reads of the settings row, to prove nothing is read while the mailer is off.
vi.mock('@/server/data/settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/data/settings')>()
  return { ...actual, getSettingsRow: vi.fn(actual.getSettingsRow) }
})

import { getSettingsRow } from '@/server/data/settings'
import { POST } from '@/app/api/notifications/stock-out/route'
import { productBarcodes, products, profiles, staff, transactionLines, transactions } from '@/server/db/schema'
import type { Db } from '@/server/db/client'
import { installFakeAuth, tokenFor } from '../helpers/auth'
import { closeTestDb, resetTestDb } from '../helpers/db'
import { putNotificationSettings } from '../helpers/settings'

const ADMIN_INBOX = 'selouna@nwu.test'
const T1 = new Date('2026-10-03T10:00:00.000Z')
const ENV_KEYS = ['MAIL_TRANSPORT', 'SMTP_HOST', 'SMTP_PORT', 'FIREBASE_AUTH_EMULATOR_HOST', 'FIRESTORE_EMULATOR_HOST']

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

// The base data: t1 is a Stock Out to Jessica of USB-C Cable x3 (scanned under two barcodes) and Wireless Mouse x1;
// t2 is a Return. USB-C Cable is at 4 (threshold 5) afterwards, so t1 took it from 7 to 4: it crossed.
async function setup(opts: { settings?: Record<string, unknown>; env?: Record<string, string | undefined> } = {}) {
  db = await resetTestDb()
  restoreAuth()
  restoreAuth = installFakeAuth(db)
  await db.insert(profiles).values([
    { uid: 'admin1', full_name: 'Ada Admin', role: 'admin' },
    { uid: 'borrower1', full_name: 'Bo Borrower', role: 'staff' },
  ])
  await db.insert(staff).values([
    { id: 's1', name: 'Jessica', surname: 'Moore', full_name: 'Jessica Moore', email: ' jessica.moore@gmail.com ' },
    { id: 's2', name: 'No', surname: 'Mail', full_name: 'No Mail', email: '   ' },
  ])
  await db.insert(products).values([
    { id: 'p1', name: 'USB-C Cable 1m', quantity_on_hand: 4, reorder_threshold: 5, location: 'G4', created_at: T1, updated_at: T1 },
    { id: 'p2', name: 'Wireless Mouse', quantity_on_hand: 10, reorder_threshold: 5, location: 'G4', created_at: T1, updated_at: T1 },
  ])
  await db.insert(productBarcodes).values([
    { barcode: 'A', product_id: 'p1', position: 0 },
    { barcode: 'B', product_id: 'p1', position: 1 },
    { barcode: 'M', product_id: 'p2', position: 0 },
  ])
  await db.insert(transactions).values([
    {
      id: 't1', transaction_type: 'OUT', reference_no: 'OUT-123', staff_id: 's1', staff_name: 'Jessica Moore',
      lend_from: '2026-10-07', lend_to: '2026-10-14', created_at: T1,
    },
    { id: 't2', transaction_type: 'RETURN', reference_no: 'RET-1', staff_id: 's1', created_at: T1 },
  ])
  await db.insert(transactionLines).values([
    { id: 'l1', transaction_id: 't1', product_id: 'p1', product_name: 'USB-C Cable 1m', quantity: 2, barcode: 'A', line_no: 0, created_at: T1 },
    { id: 'l2', transaction_id: 't1', product_id: 'p2', product_name: 'Wireless Mouse', quantity: 1, barcode: 'M', line_no: 1, created_at: T1 },
    { id: 'l3', transaction_id: 't1', product_id: 'p1', product_name: 'USB-C Cable 1m', quantity: 1, barcode: 'B', line_no: 2, created_at: T1 },
  ])
  await putNotificationSettings(db, opts.settings ?? {})
  vi.mocked(getSettingsRow).mockClear()
  sent.length = 0
  for (const k of ENV_KEYS) delete process.env[k]
  Object.assign(process.env, { MAIL_TRANSPORT: 'smtp', SMTP_HOST: '127.0.0.1', SMTP_PORT: String(sinkPort) }, opts.env)
  for (const [k, v] of Object.entries(opts.env ?? {})) if (v === undefined) delete process.env[k]
}

async function call(body: unknown, token: string | null = tokenFor('admin1')) {
  const res = await POST(
    new Request('http://localhost/api/notifications/stock-out', {
      method: 'POST',
      headers: token ? { authorization: `Bearer ${token}` } : {},
      body: JSON.stringify(body),
    }) as unknown as NextRequest,
  )
  return { status: res.status, body: await res.json() }
}

// The confirmation's part of the response (without the low stock sub-result).
const conf = (r: { body: Record<string, unknown> }) => Object.fromEntries(Object.entries(r.body).filter(([k]) => k !== 'lowStock'))
const withAdmin = (extra: Record<string, unknown> = {}) => ({ settings: { admin_notification_email: ADMIN_INBOX, ...extra } })
const lowMail = () => sent.filter((m) => (m.to as { value: { address: string }[] }).value[0].address === ADMIN_INBOX)
const setT1 = (values: Partial<typeof transactions.$inferInsert>) => db.update(transactions).set(values).where(eq(transactions.id, 't1'))
const setProduct = (id: string, values: Partial<typeof products.$inferInsert>) => db.update(products).set(values).where(eq(products.id, id))

describe('POST /api/notifications/stock-out', () => {
  beforeEach(() => setup())

  it('no Authorization header -> 401', async () => {
    expect((await call({ transactionId: 't1' }, null)).status).toBe(401)
  })

  it('portal borrower (role staff) -> 403 and nothing sent', async () => {
    expect((await call({ transactionId: 't1' }, tokenFor('borrower1'))).status).toBe(403)
    expect(sent).toHaveLength(0)
  })

  it('missing transactionId -> 400', async () => {
    expect((await call({})).status).toBe(400)
  })

  it('mail disabled -> { sent:false, reason:mail_disabled } and no transaction or settings read', async () => {
    await setup({ env: { MAIL_TRANSPORT: undefined } })
    // The transaction is not even looked up: an unknown id still answers mail_disabled.
    const r = await call({ transactionId: 'nope' })
    expect(r.body).toEqual({ sent: false, reason: 'mail_disabled' })
    expect(vi.mocked(getSettingsRow).mock.calls.length).toBe(0)
  })

  it('unknown transaction -> 404', async () => {
    expect((await call({ transactionId: 'nope' })).status).toBe(404)
  })

  it('RETURN transaction -> not_out', async () => {
    expect((await call({ transactionId: 't2' })).body).toEqual({ sent: false, reason: 'not_out' })
    expect(sent).toHaveLength(0)
  })

  it('toggle explicitly off -> toggle_off, nothing sent', async () => {
    await setup({ settings: { stock_out_confirmation: false } })
    expect(conf(await call({ transactionId: 't1' }))).toEqual({ sent: false, reason: 'toggle_off' })
    expect(sent).toHaveLength(0)
  })

  it('staff with a blank email -> no_email', async () => {
    await setT1({ staff_id: 's2' })
    expect(conf(await call({ transactionId: 't1' }))).toEqual({ sent: false, reason: 'no_email' })
  })

  it('happy path: one email, product scanned under two barcodes is ONE line with the summed quantity', async () => {
    await setup({ settings: { stock_out_confirmation: true } })
    const r = await call({ transactionId: 't1' })
    expect(conf(r)).toEqual({ sent: true })
    expect(sent, 'no admin inbox set, so only the confirmation goes out').toHaveLength(1)
    const m = sent[0]
    expect(m.to).toMatchObject({ value: [{ address: 'jessica.moore@gmail.com' }] })
    expect(m.subject).toContain('OUT-123')
    expect(m.text).toContain('- USB-C Cable 1m × 3')
    expect(m.text).toContain('- Wireless Mouse × 1')
    expect((m.text?.match(/USB-C Cable 1m/g) ?? []).length, 'one line for the product').toBe(1)
    expect(m.text).toContain('14 October 2026')
  })

  it('toggle missing counts as on', async () => {
    expect(conf(await call({ transactionId: 't1' }))).toEqual({ sent: true })
  })

  it('no return date -> "No return date set" in the delivered email', async () => {
    await setT1({ lend_to: null })
    await call({ transactionId: 't1' })
    expect(sent[0].text).toContain('No return date set')
    expect(sent[0].text).not.toContain('null')
  })

  describe('low stock alert', () => {
    it('a product that crossed to at/below its threshold -> one email to the admin inbox, only crossed products listed', async () => {
      await setup(withAdmin())
      const r = await call({ transactionId: 't1' })
      expect(r.body.lowStock).toEqual({ sent: true })
      expect(sent).toHaveLength(2)
      const m = lowMail()[0]
      expect(m.text).toContain('USB-C Cable 1m: 4 on hand (reorder at 5)')
      expect(m.text).not.toContain('Wireless Mouse')
      expect(m.text).toContain('http://localhost:3000/products')
      expect(m.subject).toMatch(/^Low stock: 1 product/)
    })

    it('reaching zero is marked OUT OF STOCK', async () => {
      await setup(withAdmin())
      await setProduct('p1', { quantity_on_hand: 0, reorder_threshold: 2 })
      await call({ transactionId: 't1' })
      expect(lowMail()[0].text).toContain('USB-C Cable 1m: OUT OF STOCK (0 on hand, reorder at 2)')
    })

    it('several crossed products -> ONE email listing all of them', async () => {
      await setup(withAdmin())
      await setProduct('p2', { quantity_on_hand: 5, reorder_threshold: 5 })
      await call({ transactionId: 't1' })
      expect(lowMail()).toHaveLength(1)
      expect(lowMail()[0].text).toContain('USB-C Cable 1m')
      expect(lowMail()[0].text).toContain('Wireless Mouse')
      expect(lowMail()[0].subject).toMatch(/^Low stock: 2 products/)
    })

    it('a product already at its threshold before the Stock Out stays quiet', async () => {
      await setup(withAdmin())
      await db.delete(transactionLines).where(eq(transactionLines.id, 'l2'))
      await db.delete(transactionLines).where(eq(transactionLines.id, 'l3'))
      await db.update(transactionLines).set({ quantity: 1 }).where(eq(transactionLines.id, 'l1'))
      const r = await call({ transactionId: 't1' })
      expect(r.body.lowStock).toEqual({ sent: false })
      expect(lowMail()).toHaveLength(0)
    })

    it('still sent when the confirmation is skipped (staff has no email)', async () => {
      await setup(withAdmin())
      await setT1({ staff_id: 's2' })
      const r = await call({ transactionId: 't1' })
      expect(r.body.reason).toBe('no_email')
      expect(r.body.lowStock).toEqual({ sent: true })
      expect(lowMail()).toHaveLength(1)
    })

    it('toggle off -> toggle_off; blank admin inbox -> no_email', async () => {
      await setup(withAdmin({ low_stock_alert: false }))
      expect((await call({ transactionId: 't1' })).body.lowStock).toEqual({ sent: false, reason: 'toggle_off' })
      await setup()
      expect((await call({ transactionId: 't1' })).body.lowStock).toEqual({ sent: false, reason: 'no_email' })
    })

    it('the same Stock Out reported twice -> second is duplicate, one low stock email', async () => {
      await setup(withAdmin())
      await call({ transactionId: 't1' })
      const r = await call({ transactionId: 't1' })
      expect(r.body.lowStock).toEqual({ sent: false, reason: 'duplicate' })
      expect(lowMail()).toHaveLength(1)
    })

    it('a product row that is gone is skipped, not an error', async () => {
      await setup(withAdmin())
      // The foreign key normally makes this impossible; switch the products table's FK triggers off to prove the guard anyway.
      await db.execute(sql`alter table products disable trigger all`)
      await db.delete(products)
      const r = await call({ transactionId: 't1' })
      expect(r.status).toBe(200)
      expect(r.body.lowStock).toEqual({ sent: false })
    })
  })

  it('both stock-out emails are sent From the system address; none saved -> MAIL_FROM default', async () => {
    await setup(withAdmin({ system_from_email: 'system@nwu.test' }))
    await call({ transactionId: 't1' })
    expect(sent).toHaveLength(2)
    for (const m of sent) {
      expect(m.from).toMatchObject({ value: [{ address: 'system@nwu.test', name: 'SmartStock NWU' }] })
    }
    await setup(withAdmin())
    await call({ transactionId: 't1' })
    expect(sent[0].from).toMatchObject({ value: [{ address: 'no-reply@smartstock.local' }] })
  })

  it('SMTP server down -> 502 with the Mailpit message, quickly', async () => {
    await setup({ env: { SMTP_PORT: String(deadPort) } })
    const t0 = Date.now()
    const r = await call({ transactionId: 't1' })
    expect(r.status).toBe(502)
    expect(r.body.error).toBe('Mail server not reachable. Is Mailpit running? (npm run mailpit)')
    expect(Date.now() - t0).toBeLessThan(5000)
  })

  it('emulators active + non-local SMTP_HOST -> 500 refusal, nothing sent', async () => {
    await setup({ env: { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8081', SMTP_HOST: 'smtp.example.com' } })
    const r = await call({ transactionId: 't1' })
    expect(r.status).toBe(500)
    expect(String(r.body.error)).toContain('Refusing to send mail')
    expect(sent).toHaveLength(0)
  })
})

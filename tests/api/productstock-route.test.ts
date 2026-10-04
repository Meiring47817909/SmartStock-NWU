// Route test for POST /api/notifications/product-stock (low stock email after a Products-page edit).
// The product, the caller's role, the notification settings and the sent-notification markers all come from the test
// PostgreSQL database. Mail goes to a throwaway local SMTP server.
import type { AddressInfo } from 'node:net'
import { eq } from 'drizzle-orm'
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
import { POST } from '@/app/api/notifications/product-stock/route'
import { productBarcodes, products, profiles } from '@/server/db/schema'
import type { Db } from '@/server/db/client'
import { installFakeAuth, tokenFor } from '../helpers/auth'
import { closeTestDb, resetTestDb } from '../helpers/db'
import { markerKeys, putNotificationSettings } from '../helpers/settings'

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

async function setup(opts: { settings?: Record<string, unknown>; env?: Record<string, string | undefined> } = {}) {
  db = await resetTestDb()
  restoreAuth()
  restoreAuth = installFakeAuth(db)
  await db.insert(profiles).values([
    { uid: 'admin1', full_name: 'Ada Admin', role: 'admin' },
    { uid: 'borrower1', full_name: 'Bo Borrower', role: 'staff' },
  ])
  await db.insert(products).values([
    { id: 'p1', name: 'USB-C Cable 1m', quantity_on_hand: 5, reorder_threshold: 5, location: 'G4', created_at: T1, updated_at: T1 },
    { id: 'p2', name: 'Wireless Mouse', quantity_on_hand: 0, reorder_threshold: 2, location: 'G4', created_at: T1, updated_at: T1 },
    { id: 'p3', name: 'HDMI Cable', quantity_on_hand: 10, reorder_threshold: 12, location: 'G4', created_at: T1, updated_at: T1 },
  ])
  await db.insert(productBarcodes).values([
    { barcode: 'B-1', product_id: 'p1', position: 0 },
    { barcode: 'B-2', product_id: 'p2', position: 0 },
    { barcode: 'B-3', product_id: 'p3', position: 0 },
  ])
  await putNotificationSettings(db, opts.settings ?? { admin_notification_email: ADMIN_INBOX })
  vi.mocked(getSettingsRow).mockClear()
  sent.length = 0
  for (const k of ENV_KEYS) delete process.env[k]
  Object.assign(process.env, { MAIL_TRANSPORT: 'smtp', SMTP_HOST: '127.0.0.1', SMTP_PORT: String(sinkPort) }, opts.env)
  for (const [k, v] of Object.entries(opts.env ?? {})) if (v === undefined) delete process.env[k]
}

async function call(body: unknown, token: string | null = tokenFor('admin1')) {
  const res = await POST(
    new Request('http://localhost/api/notifications/product-stock', {
      method: 'POST',
      headers: token ? { authorization: `Bearer ${token}` } : {},
      body: JSON.stringify(body),
    }) as unknown as NextRequest,
  )
  return { status: res.status, body: await res.json() }
}

// p1 is at 5 with threshold 5 now; before the edit it was 10 with threshold 5.
const crossed = (over: Record<string, unknown> = {}) => ({ productId: 'p1', previousQuantity: 10, previousThreshold: 5, ...over })

describe('POST /api/notifications/product-stock', () => {
  beforeEach(() => setup())

  it('no Authorization header -> 401', async () => {
    expect((await call(crossed(), null)).status).toBe(401)
  })

  it('portal borrower (role staff) -> 403, nothing sent', async () => {
    expect((await call(crossed(), tokenFor('borrower1'))).status).toBe(403)
    expect(sent).toHaveLength(0)
  })

  it('bad bodies -> 400', async () => {
    for (const body of [
      null,
      {},
      crossed({ productId: '' }),
      crossed({ productId: 'a/b' }),
      crossed({ productId: 5 }),
      crossed({ previousQuantity: 'x' }),
      crossed({ previousQuantity: null }), // NaN is not valid JSON; it travels as null
      crossed({ previousThreshold: undefined }),
      crossed({ previousQuantity: -1 }),
    ]) {
      expect((await call(body)).status, JSON.stringify(body)).toBe(400)
    }
  })

  it('mail disabled -> mail_disabled, no product or settings read', async () => {
    await setup({ env: { MAIL_TRANSPORT: undefined } })
    // The product is not even looked up: an unknown id still answers mail_disabled.
    const r = await call(crossed({ productId: 'nope' }))
    expect(r.body).toEqual({ sent: false, reason: 'mail_disabled' })
    expect(vi.mocked(getSettingsRow).mock.calls.length).toBe(0)
  })

  it('unknown product -> 404', async () => {
    expect((await call(crossed({ productId: 'nope' }))).status).toBe(404)
  })

  it('quantity edited down to exactly the threshold -> one low stock email to the admin inbox', async () => {
    const r = await call(crossed())
    expect(r.body).toEqual({ sent: true })
    expect(sent).toHaveLength(1)
    const m = sent[0]
    expect(m.to).toMatchObject({ value: [{ address: ADMIN_INBOX }] })
    expect(m.subject).toMatch(/^Low stock: 1 product/)
    expect(m.text).toContain('USB-C Cable 1m: 5 on hand (reorder at 5)')
    expect(m.text).toContain('http://localhost:3000/products')
  })

  it('quantity edited to zero -> marked OUT OF STOCK', async () => {
    await call({ productId: 'p2', previousQuantity: 4, previousThreshold: 2 })
    expect(sent[0].text).toContain('Wireless Mouse: OUT OF STOCK (0 on hand, reorder at 2)')
  })

  it('product that was already low before the edit -> not_crossed, nothing sent', async () => {
    const r = await call({ productId: 'p1', previousQuantity: 7, previousThreshold: 8 })
    expect(r.body).toEqual({ sent: false, reason: 'not_crossed' })
    expect(sent).toHaveLength(0)
  })

  it('product still above its threshold -> not_crossed', async () => {
    await db.update(products).set({ quantity_on_hand: 9 }).where(eq(products.id, 'p1'))
    expect((await call(crossed({ previousQuantity: 20 }))).body).toEqual({ sent: false, reason: 'not_crossed' })
  })

  it('threshold raised above the quantity (becomes listed as low) -> sent', async () => {
    const r = await call({ productId: 'p3', previousQuantity: 10, previousThreshold: 5 })
    expect(r.body).toEqual({ sent: true })
    expect(sent[0].text).toContain('HDMI Cable: 10 on hand (reorder at 12)')
  })

  it('low stock toggle explicitly off -> toggle_off, nothing sent', async () => {
    await setup({ settings: { admin_notification_email: ADMIN_INBOX, low_stock_alert: false } })
    expect((await call(crossed())).body).toEqual({ sent: false, reason: 'toggle_off' })
    expect(sent).toHaveLength(0)
  })

  it('no admin address saved -> no_email', async () => {
    await setup({ settings: {} })
    expect((await call(crossed())).body).toEqual({ sent: false, reason: 'no_email' })
  })

  it('the same saved edit twice -> second is a duplicate; a later edit (new updated_at) sends again', async () => {
    expect((await call(crossed())).body.sent).toBe(true)
    expect((await call(crossed())).body).toEqual({ sent: false, reason: 'duplicate' })
    expect(sent).toHaveLength(1)
    await db.update(products).set({ updated_at: new Date('2026-10-03T11:00:00.000Z') }).where(eq(products.id, 'p1'))
    expect((await call(crossed())).body.sent).toBe(true)
    expect(sent).toHaveLength(2)
  })

  it('sent From the saved system address', async () => {
    await setup({ settings: { admin_notification_email: ADMIN_INBOX, system_from_email: 'system@nwu.test' } })
    await call(crossed())
    expect(sent[0].from).toMatchObject({ value: [{ address: 'system@nwu.test' }] })
  })

  it('SMTP server down -> 502 with the Mailpit message, marker released', async () => {
    await setup({ env: { SMTP_PORT: String(deadPort) } })
    const r = await call(crossed())
    expect(r.status).toBe(502)
    expect(r.body.error).toBe('Mail server not reachable. Is Mailpit running? (npm run mailpit)')
    expect(await markerKeys(db)).toHaveLength(0)
  })
})

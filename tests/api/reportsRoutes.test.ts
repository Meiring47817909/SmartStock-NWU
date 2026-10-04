// Route tests for /api/reports and /api/audit-log: admin only (401 signed out, 403 for staff), the answers and bad input.
import { NextRequest } from 'next/server'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { GET as getReports } from '@/app/api/reports/route'
import { GET as getAuditLog } from '@/app/api/audit-log/route'
import { auditLog, products, profiles, staff, transactionLines, transactions } from '@/server/db/schema'
import type { Db } from '@/server/db/client'
import { installFakeAuth, tokenFor } from '../helpers/auth'
import { closeTestDb, resetTestDb } from '../helpers/db'

let db: Db
let restore: () => void

const call = (handler: typeof getReports, url: string, uid?: string) =>
  handler(new NextRequest(`http://localhost${url}`, { method: 'GET', headers: uid ? { authorization: `Bearer ${tokenFor(uid)}` } : {} })).then(
    async (res) => ({ status: res.status, body: await res.json() }),
  )

beforeAll(async () => {
  db = await resetTestDb()
  restore = installFakeAuth(db)
})
afterAll(async () => {
  restore()
  await closeTestDb()
})

beforeEach(async () => {
  await db.delete(auditLog)
  await db.delete(transactionLines)
  await db.delete(transactions)
  await db.delete(products)
  await db.delete(staff)
  await db.delete(profiles)
  await db.insert(profiles).values([
    { uid: 'admin-uid', full_name: 'Ada Admin', role: 'admin' },
    { uid: 'sam-uid', full_name: 'Sam Staff', role: 'staff' },
  ])
  await db.insert(staff).values({ id: 'staff-1', name: 'Sam', surname: 'Staff', full_name: 'Sam Staff', email: 'sam@nwu.test', uid: 'sam-uid' })
  await db.insert(products).values([
    { id: 'p1', name: 'Projector', quantity_on_hand: 0, reorder_threshold: 1 },
    { id: 'p2', name: 'Cable', quantity_on_hand: 9, reorder_threshold: 1 },
  ])
  await db.insert(transactions).values({ id: 't1', transaction_type: 'OUT', reference_no: 'TXN-AAAAAAAA', staff_id: 'staff-1', staff_name: 'Sam Staff', lend_to: '2026-10-01', created_at: new Date('2026-09-20T08:00:00.000Z') })
  await db.insert(transactionLines).values({ id: 't1-l0', transaction_id: 't1', product_id: 'p1', product_name: 'Projector', line_no: 0, quantity: 2 })
  await db.insert(auditLog).values({ id: 'a1', user_id: 'admin-uid', user_name: 'Ada Admin', action: 'create', entity_type: 'product', entity_id: 'p1', after: { name: 'Projector' }, created_at: new Date('2026-10-01T22:30:00.000Z') })
})

describe('/api/reports', () => {
  it('signed out is a 401, staff a 403', async () => {
    expect(await call(getReports, '/api/reports?report=low-stock')).toEqual({ status: 401, body: { error: 'Missing Authorization header.' } })
    expect(await call(getReports, '/api/reports?report=low-stock', 'sam-uid')).toEqual({ status: 403, body: { error: 'Only admins can do this.' } })
  })

  it('answers each tab for an admin', async () => {
    const levels = await call(getReports, '/api/reports?report=stock-levels', 'admin-uid')
    expect(levels.status).toBe(200)
    expect(levels.body.map((r: { name: string; status: string }) => [r.name, r.status])).toEqual([['Cable', 'IN STOCK'], ['Projector', 'OUT OF STOCK']])
    const low = await call(getReports, '/api/reports?report=low-stock', 'admin-uid')
    expect(low.body.map((r: { id: string }) => r.id)).toEqual(['p1'])
    const issued = await call(getReports, '/api/reports?report=issued-per-staff&from=2026-09-20&to=2026-10-01&includeUndated=false', 'admin-uid')
    expect(issued.status).toBe(200)
    expect(issued.body.staff).toHaveLength(1)
    expect(issued.body.staff[0]).toMatchObject({ full_name: 'Sam Staff', totalQty: 2 })
    expect(issued.body.staff[0].txns[0]).toMatchObject({ id: 't1', created_at: '2026-09-20T08:00:00.000Z', lend_to: '2026-10-01' })
    expect(issued.body.undatedCount).toBe(0)
    expect((await call(getReports, '/api/reports?report=returns', 'admin-uid')).body).toEqual({ returns: [], undatedCount: 0 })
  })

  it('"Expected back by" with includeUndated left out defaults to including undated rows', async () => {
    await db.update(transactions).set({ lend_to: null })
    const defaults = await call(getReports, '/api/reports?report=issued-per-staff&to=2026-09-01', 'admin-uid')
    expect(defaults.body.staff).toHaveLength(1)
    const excluded = await call(getReports, '/api/reports?report=issued-per-staff&to=2026-09-01&includeUndated=false', 'admin-uid')
    expect(excluded.body.staff).toHaveLength(0)
  })

  it('an unknown or missing report, or a bad date, is a 400', async () => {
    expect(await call(getReports, '/api/reports?report=nope', 'admin-uid')).toEqual({ status: 400, body: { error: 'Unknown report.' } })
    expect(await call(getReports, '/api/reports', 'admin-uid')).toEqual({ status: 400, body: { error: 'Unknown report.' } })
    expect(await call(getReports, '/api/reports?report=returns&from=x', 'admin-uid')).toEqual({ status: 400, body: { error: 'From must be a date (YYYY-MM-DD).' } })
  })
})

describe('/api/audit-log', () => {
  it('signed out is a 401, staff a 403', async () => {
    expect(await call(getAuditLog, '/api/audit-log')).toEqual({ status: 401, body: { error: 'Missing Authorization header.' } })
    expect(await call(getAuditLog, '/api/audit-log', 'sam-uid')).toEqual({ status: 403, body: { error: 'Only admins can do this.' } })
  })

  it('answers the entries and filters for an admin', async () => {
    const all = await call(getAuditLog, '/api/audit-log', 'admin-uid')
    expect(all.status).toBe(200)
    expect(all.body.entries.map((e: { id: string }) => e.id)).toEqual(['a1'])
    expect(all.body).toMatchObject({ transactionLines: {}, loanRequestLines: {}, nextCursor: null })
    // 22:30 UTC on the 1st is the 2nd in Johannesburg.
    expect((await call(getAuditLog, '/api/audit-log?from=2026-10-02&to=2026-10-02', 'admin-uid')).body.entries).toHaveLength(1)
    expect((await call(getAuditLog, '/api/audit-log?to=2026-10-01', 'admin-uid')).body.entries).toHaveLength(0)
    expect((await call(getAuditLog, '/api/audit-log?entityType=staff,category', 'admin-uid')).body.entries).toHaveLength(0)
    expect(await call(getAuditLog, '/api/audit-log?entityType=nope', 'admin-uid')).toEqual({ status: 400, body: { error: 'Unknown entity type.' } })
  })

  it('takes a cursor, and a bad one is a 400', async () => {
    // A cursor at the only entry's own key leaves nothing older; one just after it still lists it.
    const cursor = Buffer.from(JSON.stringify(['2026-10-01T22:30:00.000000Z', 'a1'])).toString('base64url')
    expect(await call(getAuditLog, `/api/audit-log?cursor=${cursor}`, 'admin-uid')).toMatchObject({ status: 200, body: { entries: [], nextCursor: null } })
    const before = Buffer.from(JSON.stringify(['2026-10-01T22:30:00.000001Z', 'a0'])).toString('base64url')
    expect((await call(getAuditLog, `/api/audit-log?cursor=${before}`, 'admin-uid')).body.entries.map((e: { id: string }) => e.id)).toEqual(['a1'])
    expect(await call(getAuditLog, '/api/audit-log?cursor=junk', 'admin-uid')).toEqual({ status: 400, body: { error: 'Invalid cursor.' } })
  })
})

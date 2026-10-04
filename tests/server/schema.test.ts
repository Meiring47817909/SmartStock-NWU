import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import type { Db } from '@/server/db/client'
import { newId } from '@/server/db/ids'
import { loanRequests, productBarcodes, products, staff, transactionLines, transactions } from '@/server/db/schema'
import { closeTestDb, resetTestDb } from '../helpers/db'

let db: Db

beforeEach(async () => {
  db = await resetTestDb()
})

afterAll(async () => {
  await closeTestDb()
})

const product = (over: Partial<typeof products.$inferInsert> = {}): typeof products.$inferInsert => ({
  id: newId(),
  name: 'Laptop',
  location: 'Shelf A',
  ...over,
})

const staffMember = (over: Partial<typeof staff.$inferInsert> = {}): typeof staff.$inferInsert => ({
  id: newId(),
  name: 'Ann',
  surname: 'Smith',
  full_name: 'Ann Smith',
  ...over,
})

describe('schema', () => {
  it('rejects stock below zero', async () => {
    await expect(db.insert(products).values(product({ quantity_on_hand: -1 }))).rejects.toThrow()
  })

  it('a barcode belongs to one product', async () => {
    const a = product({ name: 'A' })
    const b = product({ name: 'B' })
    await db.insert(products).values([a, b])
    await db.insert(productBarcodes).values({ barcode: '123', product_id: a.id, position: 0 })
    await expect(
      db.insert(productBarcodes).values({ barcode: '123', product_id: b.id, position: 0 }),
    ).rejects.toThrow()
  })

  it('staff email is unique regardless of capitals', async () => {
    await db.insert(staff).values(staffMember({ email: 'A@x.com' }))
    await expect(db.insert(staff).values(staffMember({ email: 'a@x.com' }))).rejects.toThrow()
  })

  it('request status must be a known value', async () => {
    const s = staffMember()
    await db.insert(staff).values(s)
    await expect(
      db.insert(loanRequests).values({
        id: newId(),
        staff_id: s.id,
        staff_name: s.full_name,
        status: 'archived' as never,
        from_date: '2026-10-01',
        original_from_date: '2026-10-01',
      }),
    ).rejects.toThrow()
  })

  it('dates round-trip unchanged', async () => {
    const p = product({ lend_from: '2026-10-01', lend_to: '2026-12-31' })
    await db.insert(products).values(p)
    const [row] = await db.select().from(products).where(eq(products.id, p.id))
    expect(row.lend_from).toBe('2026-10-01')
    expect(row.lend_to).toBe('2026-12-31')
  })

  it('numerics come back as numbers', async () => {
    const p = product()
    await db.insert(products).values(p)
    const t = { id: newId(), transaction_type: 'IN' as const, reference_no: 'TXN-1' }
    await db.insert(transactions).values(t)
    const lineId = newId()
    await db.insert(transactionLines).values({
      id: lineId,
      transaction_id: t.id,
      product_id: p.id,
      product_name: 'Laptop',
      quantity: 1,
      unit_cost: '12.50' as never,
    })
    const [row] = await db.select().from(transactionLines).where(eq(transactionLines.id, lineId))
    expect(row.unit_cost).toBe(12.5)
  })

  it('newId is 20 alphanumeric characters and unique over 10 000 calls', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 10_000; i++) {
      const id = newId()
      expect(id).toMatch(/^[A-Za-z0-9]{20}$/)
      ids.add(id)
    }
    expect(ids.size).toBe(10_000)
  })
})

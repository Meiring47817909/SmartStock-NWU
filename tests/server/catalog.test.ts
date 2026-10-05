import { NextRequest } from 'next/server'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  createCategory,
  createProduct,
  deleteCategory,
  deleteProduct,
  findBarcodeConflict,
  findProductByBarcode,
  getBarcodeUnitCounts,
  getOutstandingHolders,
  getProduct,
  getProductDeleteBlockers,
  listCategories,
  listProducts,
  updateCategory,
  updateProduct,
} from '@/server/data/catalog'
import { writeAudit } from '@/server/data/audit'
import {
  auditLog,
  categories,
  loanRequestLines,
  loanRequests,
  productBarcodes,
  products,
  returnWaivers,
  staff,
  transactionLines,
  transactions,
} from '@/server/db/schema'
import type { Db } from '@/server/db/client'
import { ANONYMOUS_CALLER, DataError, type Caller, type Ctx } from '@/server/context'
import { productDeleteBlockReason, type ProductInput } from '@/lib/catalogRules'
import { GET as productsGET, POST as productsPOST } from '@/app/api/products/route'
import { GET as productGET, POST as productPOST } from '@/app/api/products/[id]/route'
import { GET as lookupGET } from '@/app/api/products/lookup/route'
import { GET as categoriesGET, POST as categoriesPOST } from '@/app/api/categories/route'
import { installFakeAuth, tokenFor } from '../helpers/auth'
import { closeTestDb, resetTestDb } from '../helpers/db'

let db: Db
let restore: () => void

const NOW = new Date('2026-10-04T09:00:00.000Z')
const admin: Caller = { uid: 'admin-uid', name: 'Ada Admin', role: 'admin', staffId: null }
const staffCaller: Caller = { uid: 'staff-uid', name: 'Sam Staff', role: 'staff', staffId: 'staff-1' }

const ctxAs = (caller: Caller): Ctx => ({ db, caller, now: () => NOW })
const adminCtx = () => ctxAs(admin)

function productInput(overrides: Partial<ProductInput> = {}): ProductInput {
  return {
    name: 'Projector',
    barcodes: ['P-001'],
    category_id: null,
    description: 'HD projector',
    quantity_on_hand: 5,
    reorder_threshold: 1,
    available: true,
    location: 'Room 28',
    lend_from: null,
    lend_to: null,
    lending_interval: 'week_1',
    images: [],
    ...overrides,
  }
}

async function expectDataError(p: Promise<unknown>, status: number, message?: string) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(DataError)
  expect((err as DataError).status).toBe(status)
  if (message !== undefined) expect((err as DataError).message).toBe(message)
}

beforeAll(async () => {
  db = await resetTestDb()
  restore = installFakeAuth(db)
})
afterAll(async () => {
  restore()
  await closeTestDb()
})

beforeEach(async () => {
  // Children first.
  await db.delete(returnWaivers)
  await db.delete(transactionLines)
  await db.delete(loanRequestLines)
  await db.delete(loanRequests)
  await db.delete(transactions)
  await db.delete(auditLog)
  await db.delete(productBarcodes)
  await db.delete(products)
  await db.delete(categories)
  await db.delete(staff)
  await db.insert(staff).values([
    { id: 'staff-1', name: 'Sam', surname: 'Staff', full_name: 'Sam Staff' },
    { id: 'staff-2', name: 'Bo', surname: 'Rrower', full_name: 'Bo Rrower' },
  ])
})

describe('writeAudit', () => {
  it('records the caller, time and snapshots, and returns the id', async () => {
    const id = await writeAudit(adminCtx(), {
      action: 'create',
      entityType: 'category',
      entityId: 'c1',
      before: null,
      after: { name: 'X', gone: undefined },
    })
    const [row] = await db.select().from(auditLog).where(eq(auditLog.id, id))
    expect(id).toHaveLength(20)
    expect(row).toMatchObject({
      user_id: 'admin-uid',
      user_name: 'Ada Admin',
      action: 'create',
      entity_type: 'category',
      entity_id: 'c1',
      before: null,
      after: { name: 'X' },
    })
    expect(row.created_at.toISOString()).toBe(NOW.toISOString())
  })
})

describe('categories', () => {
  it('creates, lists by name, updates and deletes with audit entries shaped like the page writes today', async () => {
    const b = await createCategory(adminCtx(), { name: ' Beta ', description: ' second ' })
    const a = await createCategory(adminCtx(), { name: 'Alpha', description: 'first' })
    expect(b).toMatchObject({ name: 'Beta', description: 'second', created_at: NOW.toISOString() })
    expect((await listCategories(adminCtx())).map(c => c.name)).toEqual(['Alpha', 'Beta'])

    const updated = await updateCategory(adminCtx(), a.id, { name: 'Alpha2', description: 'first!' })
    expect(updated).toMatchObject({ id: a.id, name: 'Alpha2', description: 'first!' })
    await deleteCategory(adminCtx(), a.id)
    expect((await listCategories(adminCtx())).map(c => c.name)).toEqual(['Beta'])

    const audit = await db.select().from(auditLog).where(eq(auditLog.entity_id, a.id))
    const byAction = Object.fromEntries(audit.map(r => [r.action, r]))
    expect(byAction.create.entity_type).toBe('category')
    expect(byAction.create.before).toBeNull()
    expect(byAction.create.after).toEqual({ name: 'Alpha', description: 'first', created_at: NOW.toISOString() })
    expect(byAction.update.before).toEqual({ name: 'Alpha', description: 'first' })
    expect(byAction.update.after).toEqual({ name: 'Alpha2', description: 'first!' })
    expect(byAction.delete.before).toEqual({ name: 'Alpha2', description: 'first!' })
    expect(byAction.delete.after).toBeNull()
  })

  it('deleteCategory in use → 409', async () => {
    const c = await createCategory(adminCtx(), { name: 'Cables', description: 'x' })
    await createProduct(adminCtx(), productInput({ category_id: c.id }))
    await expectDataError(
      deleteCategory(adminCtx(), c.id),
      409,
      '1 product still uses this category. Move or delete it first.',
    )
    expect(await listCategories(adminCtx())).toHaveLength(1)
    await createProduct(adminCtx(), productInput({ name: 'Other', barcodes: ['P-002'], category_id: c.id }))
    await expectDataError(
      deleteCategory(adminCtx(), c.id),
      409,
      '2 products still use this category. Move or delete them first.',
    )
    // Nothing was audited for the refused deletes.
    expect(await db.select().from(auditLog).where(eq(auditLog.action, 'delete'))).toHaveLength(0)
  })

  it('a duplicate category name is a 409, a missing category a 404', async () => {
    await createCategory(adminCtx(), { name: 'Dup', description: 'x' })
    await expectDataError(createCategory(adminCtx(), { name: 'Dup', description: 'y' }), 409)
    await expectDataError(deleteCategory(adminCtx(), 'nope'), 404)
    await expectDataError(updateCategory(adminCtx(), 'nope', { name: 'N', description: 'd' }), 404)
  })

  it('staff cannot manage categories → 403', async () => {
    await expectDataError(createCategory(ctxAs(staffCaller), { name: 'X', description: 'y' }), 403, 'Only admins can do this.')
    await expectDataError(listCategories(ctxAs(staffCaller)), 403)
  })
})

describe('products', () => {
  it('accepts an Available From date in the past, but Available To must come after Available From', async () => {
    // NOW is 2026-10-04: a product lendable since September is fine.
    const past = await createProduct(adminCtx(), productInput({ lend_from: '2026-09-01', lend_to: '2026-09-30' }))
    expect(past).toMatchObject({ lend_from: '2026-09-01', lend_to: '2026-09-30' })
    const openEnded = await createProduct(adminCtx(), productInput({ name: 'Old stock', barcodes: ['P-002'], lend_from: '2025-01-15', lend_to: null }))
    expect(openEnded).toMatchObject({ lend_from: '2025-01-15', lend_to: null })

    const message = 'Available To date must be after the Available From date.'
    await expect(createProduct(adminCtx(), productInput({ name: 'Same day', lend_from: '2026-10-10', lend_to: '2026-10-10' }))).rejects.toThrow(message)
    await expect(createProduct(adminCtx(), productInput({ name: 'Backwards', lend_from: '2026-10-10', lend_to: '2026-10-09' }))).rejects.toThrow(message)
    await expect(updateProduct(adminCtx(), past.id, productInput({ lend_from: '2026-09-30', lend_to: '2026-09-01' }))).rejects.toThrow(message)
  })

  it('product with barcodes round-trips in order', async () => {
    const cat = await createCategory(adminCtx(), { name: 'AV', description: 'audio visual' })
    const created = await createProduct(
      adminCtx(),
      productInput({
        category_id: cat.id,
        barcodes: [' Z-9 ', 'A-1', '', 'M-5', 'A-1'],
        images: ['products/x/1.jpg', 'products/x/2.jpg'],
        lend_from: '2026-10-01',
        lend_to: '2026-12-31',
        lending_interval: 'month_1',
      }),
    )
    const fetched = await getProduct(adminCtx(), created.id)
    expect(fetched).toEqual(created)
    expect(fetched).toMatchObject({
      name: 'Projector',
      barcodes: ['Z-9', 'A-1', 'M-5'], // trimmed, empties and repeats dropped, order kept
      category_id: cat.id,
      category_name: 'AV',
      quantity_on_hand: 5,
      reorder_threshold: 1,
      available: true,
      location: 'Room 28',
      lend_from: '2026-10-01', // date-only values come back unchanged
      lend_to: '2026-12-31',
      lending_interval: 'month_1',
      images: ['products/x/1.jpg', 'products/x/2.jpg'],
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    })
    const rows = await db.select().from(productBarcodes).where(eq(productBarcodes.product_id, created.id))
    expect(rows.sort((x, y) => x.position - y.position).map(r => [r.barcode, r.position])).toEqual([
      ['Z-9', 0],
      ['A-1', 1],
      ['M-5', 2],
    ])
    expect(await findProductByBarcode(adminCtx(), ' A-1 ')).toEqual(created)
    expect(await findProductByBarcode(adminCtx(), 'nope')).toBeNull()
    expect(await findProductByBarcode(adminCtx(), '   ')).toBeNull()
    expect(await getProduct(adminCtx(), 'missing')).toBeNull()
  })

  it('reordering barcodes on update is kept', async () => {
    const created = await createProduct(adminCtx(), productInput({ barcodes: ['A', 'B', 'C'] }))
    const updated = await updateProduct(adminCtx(), created.id, productInput({ barcodes: ['C', 'A'] }))
    expect(updated.barcodes).toEqual(['C', 'A'])
    expect((await getProduct(adminCtx(), created.id))!.barcodes).toEqual(['C', 'A'])
  })

  it('createProduct with a barcode another product uses → 409 with the friendly conflict message', async () => {
    const first = await createProduct(adminCtx(), productInput({ barcodes: ['DUP-1'] }))
    await expectDataError(
      createProduct(adminCtx(), productInput({ name: 'Second', barcodes: ['FREE-1', ' DUP-1 '] })),
      409,
      'Barcode "DUP-1" is already used by another product.',
    )
    // Nothing from the failed save is left behind.
    expect(await listProducts(adminCtx())).toHaveLength(1)
    expect(await db.select().from(productBarcodes)).toHaveLength(1)
    expect(await db.select().from(auditLog)).toHaveLength(1)

    // Editing a product may keep its own barcodes but not take another's.
    const second = await createProduct(adminCtx(), productInput({ name: 'Second', barcodes: ['S-1'] }))
    await expectDataError(
      updateProduct(adminCtx(), second.id, productInput({ barcodes: ['S-1', 'DUP-1'] })),
      409,
      'Barcode "DUP-1" is already used by another product.',
    )
    await updateProduct(adminCtx(), first.id, productInput({ barcodes: ['DUP-1', 'EXTRA'] }))
  })

  it('two saves racing for the same barcode: one wins, the other gets the friendly 409 (not a unique-violation 500)', async () => {
    const results = await Promise.allSettled(
      [1, 2, 3, 4].map(n => createProduct(adminCtx(), productInput({ name: `Race ${n}`, barcodes: ['RACE-1'] }))),
    )
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    for (const r of results.filter(r => r.status === 'rejected')) {
      const err = (r as PromiseRejectedResult).reason
      expect(err).toBeInstanceOf(DataError)
      expect(err.status).toBe(409)
      expect(err.message).toBe('Barcode "RACE-1" is already used by another product.')
    }
  })

  it('findBarcodeConflict returns the first conflicting code, ignoring the excluded product', async () => {
    const a = await createProduct(adminCtx(), productInput({ barcodes: ['A1', 'A2'] }))
    expect(await findBarcodeConflict(adminCtx(), [])).toBeNull()
    expect(await findBarcodeConflict(adminCtx(), ['  ', ''])).toBeNull()
    expect(await findBarcodeConflict(adminCtx(), ['NEW', 'A2', 'A1'])).toBe('A2')
    expect(await findBarcodeConflict(adminCtx(), ['A1'], a.id)).toBeNull()
    expect(await findBarcodeConflict(adminCtx(), ['A1'], 'someone-else')).toBe('A1')
  })

  it('createProduct writes one create audit entry shaped like the Products page writes today', async () => {
    const cat = await createCategory(adminCtx(), { name: 'AV', description: 'x' })
    const created = await createProduct(adminCtx(), productInput({ category_id: cat.id, images: ['products/p/1.jpg'] }))
    const rows = await db.select().from(auditLog).where(eq(auditLog.entity_id, created.id))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      action: 'create',
      entity_type: 'product',
      user_id: 'admin-uid',
      user_name: 'Ada Admin',
      before: null,
    })
    expect(rows[0].after).toEqual({
      name: 'Projector',
      barcodes: ['P-001'],
      category_id: cat.id,
      category_name: 'AV',
      description: 'HD projector',
      quantity_on_hand: 5,
      reorder_threshold: 1,
      available: true,
      location: 'Room 28',
      lend_from: null,
      lend_to: null,
      lending_interval: 'week_1',
      updated_at: NOW.toISOString(),
      created_at: NOW.toISOString(),
      images: ['products/p/1.jpg'],
    })
  })

  it('a caller-chosen id is used when valid and rejected when malformed', async () => {
    const created = await createProduct(adminCtx(), productInput({ id: 'AbCdEfGhIjKlMnOpQrSt' }))
    expect(created.id).toBe('AbCdEfGhIjKlMnOpQrSt')
    await expectDataError(createProduct(adminCtx(), productInput({ id: 'short', barcodes: ['Q'] })), 400)
    await expectDataError(createProduct(adminCtx(), productInput({ id: 'AbCdEfGhIjKlMnOpQrSt', barcodes: ['Q'] })), 409)
  })

  it('updateProduct writes one audit entry with before/after', async () => {
    const cat = await createCategory(adminCtx(), { name: 'AV', description: 'x' })
    const created = await createProduct(adminCtx(), productInput({ barcodes: ['U-1'] }))
    await db.delete(auditLog)

    const later = new Date('2026-10-05T10:00:00.000Z')
    const ctx = { ...adminCtx(), now: () => later }
    const updated = await updateProduct(
      ctx,
      created.id,
      productInput({
        name: 'Projector 2',
        barcodes: ['U-1', 'U-2'],
        category_id: cat.id,
        quantity_on_hand: 3,
        quantity_reason: 'Stocktake',
        images: ['products/p/a.jpg'],
      }),
    )
    expect(updated).toMatchObject({ name: 'Projector 2', category_name: 'AV', updated_at: later.toISOString(), created_at: NOW.toISOString() })

    const rows = await db.select().from(auditLog)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ action: 'update', entity_type: 'product', entity_id: created.id, user_name: 'Ada Admin' })
    expect(rows[0].before).toEqual({
      name: 'Projector',
      barcodes: ['U-1'],
      category_id: null,
      description: 'HD projector',
      quantity_on_hand: 5,
      reorder_threshold: 1,
      available: true,
      location: 'Room 28',
      lend_from: null,
      lend_to: null,
      lending_interval: 'week_1',
      images: [],
    })
    expect(rows[0].after).toEqual({
      name: 'Projector 2',
      barcodes: ['U-1', 'U-2'],
      category_id: cat.id,
      category_name: 'AV',
      description: 'HD projector',
      quantity_on_hand: 3,
      reorder_threshold: 1,
      available: true,
      location: 'Room 28',
      lend_from: null,
      lend_to: null,
      lending_interval: 'week_1',
      updated_at: later.toISOString(),
      images: ['products/p/a.jpg'],
      reason: 'Stocktake',
    })
  })

  it('updateProduct on a missing product → 404; invalid values → 400', async () => {
    await expectDataError(updateProduct(adminCtx(), 'nope', productInput()), 404)
    await expectDataError(createProduct(adminCtx(), productInput({ name: '   ' })), 400)
    await expectDataError(createProduct(adminCtx(), productInput({ quantity_on_hand: -1 })), 400)
    await expectDataError(createProduct(adminCtx(), productInput({ category_id: 'no-such-category' })), 400)
  })

  it('listProducts works without a caller (public) and can filter to available products', async () => {
    await createProduct(adminCtx(), productInput({ name: 'B item', barcodes: ['B1'] }))
    await createProduct(adminCtx(), productInput({ name: 'A item', barcodes: ['A1', 'A2'], available: false }))
    const publicCtx: Ctx = { db, caller: ANONYMOUS_CALLER, now: () => NOW }
    const all = await listProducts(publicCtx)
    expect(all.map(p => p.name)).toEqual(['A item', 'B item'])
    expect(all[0].barcodes).toEqual(['A1', 'A2'])
    expect((await listProducts(publicCtx, { availableOnly: true })).map(p => p.name)).toEqual(['B item'])
    expect((await getProduct(publicCtx, all[0].id))!.name).toBe('A item')
  })

  it('staff caller cannot createProduct → 403', async () => {
    await expectDataError(createProduct(ctxAs(staffCaller), productInput()), 403, 'Only admins can do this.')
    await expectDataError(createProduct({ db, caller: ANONYMOUS_CALLER, now: () => NOW }, productInput()), 403)
    await expectDataError(updateProduct(ctxAs(staffCaller), 'x', productInput()), 403)
    await expectDataError(deleteProduct(ctxAs(staffCaller), 'x'), 403)
    expect(await listProducts(adminCtx())).toHaveLength(0)
  })
})

// --- Fixtures for the ledger-based checks -----------------------------------

async function addTxn(
  id: string,
  type: 'IN' | 'OUT' | 'RETURN',
  opts: { staffId?: string; staffName?: string | null; ref?: string; linked?: string } = {},
) {
  await db.insert(transactions).values({
    id,
    transaction_type: type,
    reference_no: opts.ref ?? `REF-${id}`,
    staff_id: opts.staffId ?? null,
    staff_name: opts.staffName === undefined ? null : opts.staffName,
    linked_txn_id: opts.linked ?? null,
  })
}

async function addLine(
  id: string,
  txn: string,
  product: string,
  quantity: number,
  barcode: string | null = null,
  issued_barcode: string | null = null,
) {
  await db.insert(transactionLines).values({
    id,
    transaction_id: txn,
    product_id: product,
    product_name: 'p',
    line_no: 0,
    quantity,
    barcode,
    issued_barcode,
  })
}

describe('outstanding holders, unit counts and delete blockers', () => {
  it('getOutstandingHolders is issued − returned − waived per OUT transaction', async () => {
    const p = await createProduct(adminCtx(), productInput({ barcodes: ['H1'] }))
    const other = await createProduct(adminCtx(), productInput({ name: 'Other', barcodes: ['H2'] }))
    expect(await getOutstandingHolders(adminCtx(), p.id)).toEqual([])

    await addTxn('out1', 'OUT', { staffId: 'staff-1', staffName: 'Sam Staff', ref: 'OUT-1' })
    await addLine('l1', 'out1', p.id, 3, 'H1')
    await addLine('l1b', 'out1', p.id, 2, 'H1')
    await addLine('l1o', 'out1', other.id, 9, 'H2') // another product's line on the same txn is ignored
    await addTxn('out2', 'OUT', { staffId: 'staff-2', staffName: null, ref: 'OUT-2' })
    await addLine('l2', 'out2', p.id, 4, 'H1')
    await addTxn('out3', 'OUT', { staffId: 'staff-2', staffName: 'Bo Rrower', ref: 'OUT-3' })
    await addLine('l3', 'out3', p.id, 2, 'H1')
    await addTxn('in1', 'IN')
    await addLine('l4', 'in1', p.id, 20, 'H1') // stock in never counts as outstanding

    // out1: 5 issued, 1 returned → 4. out2: 4 issued → 4 (no staff name → em dash). out3: 2 issued, 2 waived → none.
    await addTxn('ret1', 'RETURN', { linked: 'out1' })
    await addLine('r1', 'ret1', p.id, 1, 'H1')
    await db.insert(returnWaivers).values({ id: 'w1', transaction_id: 'out3', product_id: p.id, product_name: 'p', quantity: 2 })

    const holders = await getOutstandingHolders(adminCtx(), p.id)
    expect(holders.sort((a, b) => a.txnId.localeCompare(b.txnId))).toEqual([
      { txnId: 'out1', staffName: 'Sam Staff', quantity: 4, txnRef: 'OUT-1' },
      { txnId: 'out2', staffName: '—', quantity: 4, txnRef: 'OUT-2' },
    ])
    // A waiver for a different product on out1 does not reduce this product's balance.
    await db.insert(returnWaivers).values({ id: 'w2', transaction_id: 'out1', product_id: other.id, product_name: 'p', quantity: 1 })
    expect((await getOutstandingHolders(adminCtx(), p.id)).find(h => h.txnId === 'out1')!.quantity).toBe(4)
  })

  it('getBarcodeUnitCounts splits units into in stock and outstanding per barcode', async () => {
    const p = await createProduct(adminCtx(), productInput({ barcodes: ['B1', 'B2'] }))
    expect(await getBarcodeUnitCounts(adminCtx(), p.id)).toEqual({})
    await addTxn('in1', 'IN')
    await addLine('a', 'in1', p.id, 10, 'B1')
    await addLine('b', 'in1', p.id, 5, 'B2')
    await addTxn('out1', 'OUT', { staffId: 'staff-1', staffName: 'Sam Staff' })
    await addLine('c', 'out1', p.id, 4, 'B1')
    await addLine('d', 'out1', p.id, 1, 'B2')
    await addTxn('ret1', 'RETURN', { linked: 'out1' })
    await addLine('e', 'ret1', p.id, 1, 'B1')
    await addTxn('out2', 'OUT', { staffId: 'staff-1', staffName: 'Sam Staff' })
    await addLine('f', 'out2', p.id, 2, 'B2')
    await db.insert(returnWaivers).values({ id: 'w', transaction_id: 'out2', product_id: p.id, product_name: 'p', quantity: 2 })

    // B1: received 10 + returned 1 − issued 4 = 7 in stock; out1 still has 3 of B1 out → 3 outstanding.
    // B2: received 5 − issued (1 + 2) = 2 in stock; out1 has 1 of B2 out, out2's 2 are waived → 1 outstanding.
    expect(await getBarcodeUnitCounts(adminCtx(), p.id)).toEqual({
      B1: { inStock: 7, outstanding: 3, total: 10 },
      B2: { inStock: 2, outstanding: 1, total: 3 },
    })
  })

  it('getBarcodeUnitCounts reads an OUT\'s lines in scan order (created_at, line_no, id), not id order', async () => {
    const p = await createProduct(adminCtx(), productInput({ barcodes: ['S1', 'S2'] }))
    await addTxn('out1', 'OUT', { staffId: 'staff-1', staffName: 'Sam Staff' })
    // Same timestamp, ids sorting opposite to line_no: S1 was scanned first.
    const at = new Date('2026-10-01T08:00:00.000Z')
    await db.insert(transactionLines).values([
      { id: 'zz-first', transaction_id: 'out1', product_id: p.id, product_name: 'p', line_no: 0, quantity: 1, barcode: 'S1', created_at: at },
      { id: 'aa-second', transaction_id: 'out1', product_id: p.id, product_name: 'p', line_no: 1, quantity: 1, barcode: 'S2', created_at: at },
    ])
    // A waiver (no barcode) relieves the first-issued barcode first, so S1 is the one written off.
    await db.insert(returnWaivers).values({ id: 'w', transaction_id: 'out1', product_id: p.id, product_name: 'p', quantity: 1 })
    expect(await getBarcodeUnitCounts(adminCtx(), p.id)).toEqual({
      S1: { inStock: 0, outstanding: 0, total: 0 },
      S2: { inStock: 0, outstanding: 1, total: 1 },
    })
  })

  it('getProductDeleteBlockers lists outstanding units and active reservations (every status that is still active)', async () => {
    const p = await createProduct(adminCtx(), productInput({ barcodes: ['R1'] }))
    expect(await getProductDeleteBlockers(adminCtx(), p.id)).toEqual({ outstanding: [], reservations: [] })

    const mk = async (id: string, status: 'pending' | 'countered' | 'accepted' | 'declined' | 'fulfilled', qty: number, to: string | null) => {
      await db.insert(loanRequests).values({
        id,
        staff_id: 'staff-1',
        staff_name: 'Sam Staff',
        status,
        from_date: '2026-11-01',
        to_date: to,
        original_from_date: '2026-11-01',
        original_to_date: to,
      })
      await db.insert(loanRequestLines).values({
        id: `line-${id}`,
        request_id: id,
        product_id: p.id,
        product_name: 'p',
        line_no: 0,
        requested_quantity: qty,
        offered_quantity: qty,
      })
    }
    await mk('rq-a', 'accepted', 2, '2026-11-08')
    await mk('rq-p', 'pending', 1, null)
    await mk('rq-d', 'declined', 5, '2026-11-08')
    await mk('rq-f', 'fulfilled', 5, '2026-11-08')
    await mk('rq-zero', 'pending', 0, '2026-11-08') // nothing offered → not a hold

    const { reservations, outstanding } = await getProductDeleteBlockers(adminCtx(), p.id)
    expect(outstanding).toEqual([])
    expect(reservations.sort((a, b) => a.requestId.localeCompare(b.requestId))).toEqual([
      { requestId: 'rq-a', staffId: 'staff-1', staffName: 'Sam Staff', quantity: 2, fromDate: '2026-11-01', toDate: '2026-11-08', status: 'accepted' },
      { requestId: 'rq-p', staffId: 'staff-1', staffName: 'Sam Staff', quantity: 1, fromDate: '2026-11-01', toDate: null, status: 'pending' },
    ])
  })

  it('deleteProduct with outstanding stock → blocked with today\'s reason', async () => {
    const p = await createProduct(adminCtx(), productInput({ barcodes: ['D1'] }))
    await addTxn('out1', 'OUT', { staffId: 'staff-1', staffName: 'Sam Staff', ref: 'OUT-77' })
    await addLine('l1', 'out1', p.id, 2, 'D1')
    await db.insert(loanRequests).values({
      id: 'rq1', staff_id: 'staff-2', staff_name: 'Bo Rrower', status: 'accepted', from_date: '2026-11-01', original_from_date: '2026-11-01',
    })
    await db.insert(loanRequestLines).values({
      id: 'rql1', request_id: 'rq1', product_id: p.id, product_name: 'p', line_no: 0, requested_quantity: 1, offered_quantity: 1,
    })
    const expected =
      'Still in use — 2 unit(s) checked out with Sam Staff (OUT-77); 1 unit(s) on a approved pickup for Bo Rrower. Resolve or cancel these first.'
    expect(productDeleteBlockReason(await getProductDeleteBlockers(adminCtx(), p.id))).toBe(expected)
    await expectDataError(deleteProduct(adminCtx(), p.id), 409, expected)
    expect(await getProduct(adminCtx(), p.id)).not.toBeNull()
  })

  it('deleteProduct when clear removes the product and its barcodes and writes the delete audit entry', async () => {
    const cat = await createCategory(adminCtx(), { name: 'AV', description: 'x' })
    const p = await createProduct(adminCtx(), productInput({ barcodes: ['X1', 'X2'], category_id: cat.id }))
    await db.delete(auditLog)
    await deleteProduct(adminCtx(), p.id)
    expect(await getProduct(adminCtx(), p.id)).toBeNull()
    expect(await db.select().from(productBarcodes)).toHaveLength(0)
    const rows = await db.select().from(auditLog)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ action: 'delete', entity_type: 'product', entity_id: p.id, after: null })
    expect(rows[0].before).toEqual({
      name: 'Projector',
      barcodes: ['X1', 'X2'],
      category_id: cat.id,
      category_name: 'AV',
      description: 'HD projector',
      quantity_on_hand: 5,
      reorder_threshold: 1,
      available: true,
      location: 'Room 28',
    })
    await expectDataError(deleteProduct(adminCtx(), p.id), 404)
  })

  it('deleteProduct for a product with past stock movements is a friendly 409, not a 500', async () => {
    const p = await createProduct(adminCtx(), productInput({ barcodes: ['HIST'] }))
    await addTxn('in1', 'IN')
    await addLine('l1', 'in1', p.id, 5, 'HIST')
    await expectDataError(
      deleteProduct(adminCtx(), p.id),
      409,
      "This product has stock history (Stock In/Out records) and can't be deleted.",
    )
    expect(await getProduct(adminCtx(), p.id)).not.toBeNull()
    expect(await db.select().from(auditLog).where(eq(auditLog.action, 'delete'))).toHaveLength(0)
  })
})

// --- Routes -----------------------------------------------------------------

describe('catalog routes', () => {
  beforeEach(async () => {
    const { profiles } = await import('@/server/db/schema')
    await db.delete(profiles)
    await db.insert(profiles).values([
      { uid: 'admin-uid', full_name: 'Ada Admin', role: 'admin' },
      { uid: 'staff-uid', full_name: 'Sam Staff', role: 'staff' },
    ])
  })

  const req = (method: 'GET' | 'POST', url: string, uid?: string, body?: unknown) =>
    new NextRequest(`http://localhost${url}`, {
      method,
      headers: {
        ...(uid ? { authorization: `Bearer ${tokenFor(uid)}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  const seg = (id: string) => ({ params: Promise.resolve({ id }) })

  it('GET /api/products is public (no sign-in) and honours availableOnly', async () => {
    await createProduct(adminCtx(), productInput({ name: 'On', barcodes: ['O1'] }))
    await createProduct(adminCtx(), productInput({ name: 'Off', barcodes: ['O2'], available: false }))
    const res = await productsGET(req('GET', '/api/products'))
    expect(res.status).toBe(200)
    expect(((await res.json()) as { name: string }[]).map(p => p.name)).toEqual(['Off', 'On'])
    const res2 = await productsGET(req('GET', '/api/products?availableOnly=true'))
    expect(((await res2.json()) as { name: string }[]).map(p => p.name)).toEqual(['On'])

    const one = (await db.select().from(products).where(eq(products.name, 'On')))[0]
    const res3 = await productGET(req('GET', `/api/products/${one.id}`), seg(one.id))
    expect(res3.status).toBe(200)
    expect((await res3.json()).barcodes).toEqual(['O1'])
    const res4 = await productGET(req('GET', '/api/products/nope'), seg('nope'))
    expect(res4.status).toBe(404)
  })

  it('POST /api/products: staff → 403, signed out → 401, admin creates', async () => {
    const asStaff = await productsPOST(req('POST', '/api/products', 'staff-uid', productInput()))
    expect(asStaff.status).toBe(403)
    const anon = await productsPOST(req('POST', '/api/products', undefined, productInput()))
    expect(anon.status).toBe(401)
    expect(await listProducts(adminCtx())).toHaveLength(0)

    const ok = await productsPOST(req('POST', '/api/products', 'admin-uid', productInput()))
    expect(ok.status).toBe(200)
    const created = await ok.json()
    expect(created).toMatchObject({ name: 'Projector', barcodes: ['P-001'] })

    const dup = await productsPOST(req('POST', '/api/products', 'admin-uid', productInput({ name: 'Again' })))
    expect(dup.status).toBe(409)
    expect(await dup.json()).toEqual({ error: 'Barcode "P-001" is already used by another product.' })
  })

  it('POST /api/products/[id] updates and deletes (admin only)', async () => {
    const p = await createProduct(adminCtx(), productInput())
    const denied = await productPOST(req('POST', `/api/products/${p.id}`, 'staff-uid', { action: 'delete' }), seg(p.id))
    expect(denied.status).toBe(403)

    const upd = await productPOST(
      req('POST', `/api/products/${p.id}`, 'admin-uid', { action: 'update', product: productInput({ name: 'Renamed' }) }),
      seg(p.id),
    )
    expect(upd.status).toBe(200)
    expect((await upd.json()).name).toBe('Renamed')

    const bad = await productPOST(req('POST', `/api/products/${p.id}`, 'admin-uid', { action: 'explode' }), seg(p.id))
    expect(bad.status).toBe(400)

    const del = await productPOST(req('POST', `/api/products/${p.id}`, 'admin-uid', { action: 'delete' }), seg(p.id))
    expect(del.status).toBe(200)
    expect(await getProduct(adminCtx(), p.id)).toBeNull()
  })

  it('GET /api/products/lookup answers by kind (admin only)', async () => {
    const p = await createProduct(adminCtx(), productInput({ barcodes: ['L1', 'L2'] }))
    const staffRes = await lookupGET(req('GET', '/api/products/lookup?kind=barcode&code=L1', 'staff-uid'))
    expect(staffRes.status).toBe(403)

    const byCode = await lookupGET(req('GET', '/api/products/lookup?kind=barcode&code=L2', 'admin-uid'))
    expect((await byCode.json()).id).toBe(p.id)
    const missing = await lookupGET(req('GET', '/api/products/lookup?kind=barcode&code=ZZ', 'admin-uid'))
    expect(await missing.json()).toBeNull()

    const conflict = await lookupGET(req('GET', `/api/products/lookup?kind=conflict&codes=${encodeURIComponent(JSON.stringify(['NEW', 'L2']))}`, 'admin-uid'))
    expect(await conflict.json()).toBe('L2')
    const own = await lookupGET(req('GET', `/api/products/lookup?kind=conflict&codes=${encodeURIComponent(JSON.stringify(['L1', 'L2']))}&excludeId=${p.id}`, 'admin-uid'))
    expect(await own.json()).toBeNull()

    const holders = await lookupGET(req('GET', `/api/products/lookup?kind=holders&productId=${p.id}`, 'admin-uid'))
    expect(await holders.json()).toEqual([])
    const counts = await lookupGET(req('GET', `/api/products/lookup?kind=unitCounts&productId=${p.id}`, 'admin-uid'))
    expect(await counts.json()).toEqual({})
    const blockers = await lookupGET(req('GET', `/api/products/lookup?kind=deleteBlockers&productId=${p.id}`, 'admin-uid'))
    expect(await blockers.json()).toEqual({ outstanding: [], reservations: [] })
    const bad = await lookupGET(req('GET', '/api/products/lookup?kind=nope', 'admin-uid'))
    expect(bad.status).toBe(400)
  })

  it('/api/categories: admin lists and manages, staff → 403', async () => {
    expect((await categoriesGET(req('GET', '/api/categories', 'staff-uid'))).status).toBe(403)
    expect((await categoriesPOST(req('POST', '/api/categories', 'staff-uid', { action: 'create', name: 'X', description: 'y' }))).status).toBe(403)

    const created = await categoriesPOST(req('POST', '/api/categories', 'admin-uid', { action: 'create', name: 'Cables', description: 'leads' }))
    expect(created.status).toBe(200)
    const cat = await created.json()
    expect(cat).toMatchObject({ name: 'Cables', description: 'leads' })

    const upd = await categoriesPOST(req('POST', '/api/categories', 'admin-uid', { action: 'update', id: cat.id, name: 'Leads', description: 'd' }))
    expect((await upd.json()).name).toBe('Leads')
    const list = await categoriesGET(req('GET', '/api/categories', 'admin-uid'))
    expect((await list.json()).map((c: { name: string }) => c.name)).toEqual(['Leads'])

    await createProduct(adminCtx(), productInput({ category_id: cat.id }))
    const blocked = await categoriesPOST(req('POST', '/api/categories', 'admin-uid', { action: 'delete', id: cat.id }))
    expect(blocked.status).toBe(409)
    expect((await blocked.json()).error).toBe('1 product still uses this category. Move or delete it first.')
  })
})

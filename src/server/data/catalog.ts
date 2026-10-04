import 'server-only'
import { and, asc, count, eq, inArray, ne, sql } from 'drizzle-orm'
import { assertAdmin, DataError, type Ctx } from '@/server/context'
import { toIso, withTx, type Db } from '@/server/db/client'
import { newId } from '@/server/db/ids'
import { pgError } from '@/server/db/pgError'
import {
  categories,
  LENDING_INTERVALS,
  loanRequestLines,
  loanRequests,
  productBarcodes,
  products,
  returnWaivers,
  transactionLines,
  transactions,
} from '@/server/db/schema'
import { writeAudit } from '@/server/data/audit'
import { openBarcodeQuantities } from '@/lib/transactionLines'
import { ACTIVE_STATUSES } from '@/lib/loanRequestRules'
import {
  barcodeConflictMessage,
  categoryInUseMessage,
  productDeleteBlockReason,
  type BarcodeUnitCount,
  type CategoryInput,
  type OutstandingHolder,
  type ProductDeleteBlockers,
  type ProductInput,
  type ReservationHolder,
} from '@/lib/catalogRules'
import type { Category, LendingInterval, Product } from '@/types/database'

// `Product.id` is typed `number` in src/types/database.ts but ids are strings (same cast the Firestore code used for its
// string document ids); the server side says so honestly, and the browser client hands pages the `Product` type they use.
export type ProductOut = Omit<Product, 'id'> & { id: string }

const ID_PATTERN = /^[A-Za-z0-9]{20}$/
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
export const DEFAULT_LOCATION = 'NWU - Potchefstroom, Building G4, Room 28' // same default the Products page falls back to (and the importer)

/** Run `fn` in a transaction on the caller's connection (a savepoint when `ctx.db` is already a transaction). */
function inTx<T>(ctx: Ctx, fn: (txCtx: Ctx) => Promise<T>): Promise<T> {
  return withTx(ctx.db as Db, (tx) => fn({ ...ctx, db: tx }))
}

// --- Row mapping -------------------------------------------------------------

type ProductRow = typeof products.$inferSelect

function mapProduct(row: ProductRow, barcodes: string[]): ProductOut {
  return {
    id: row.id,
    category_id: row.category_id,
    name: row.name,
    description: row.description,
    barcodes,
    quantity_on_hand: row.quantity_on_hand,
    reorder_threshold: row.reorder_threshold,
    available: row.available,
    location: row.location,
    lend_from: row.lend_from,
    lend_to: row.lend_to,
    lending_interval: row.lending_interval ?? undefined,
    created_at: toIso(row.created_at) as string,
    updated_at: toIso(row.updated_at) as string,
    images: row.images,
    category_name: row.category_name ?? undefined,
  }
}

function mapCategory(row: typeof categories.$inferSelect): Category {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    created_at: toIso(row.created_at) as string,
  }
}

async function barcodesFor(ctx: Ctx, productId: string): Promise<string[]> {
  const rows = await ctx.db
    .select({ barcode: productBarcodes.barcode })
    .from(productBarcodes)
    .where(eq(productBarcodes.product_id, productId))
    .orderBy(asc(productBarcodes.position))
  return rows.map((r) => r.barcode)
}

// --- Categories --------------------------------------------------------------

function text(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new DataError(400, `${label} is required.`)
  return value
}

function normalizeCategory(input: CategoryInput): { name: string; description: string } {
  const name = text(input?.name, 'Name').trim()
  const description = typeof input?.description === 'string' ? input.description.trim() : ''
  if (!name) throw new DataError(400, 'Name is required.')
  return { name, description }
}

function categoryNameTaken(name: string): DataError {
  return new DataError(409, `A category named "${name}" already exists.`)
}

export async function listCategories(ctx: Ctx): Promise<Category[]> {
  assertAdmin(ctx)
  const rows = await ctx.db.select().from(categories).orderBy(asc(categories.name))
  return rows.map(mapCategory)
}

export async function createCategory(ctx: Ctx, input: CategoryInput): Promise<Category> {
  assertAdmin(ctx)
  const { name, description } = normalizeCategory(input)
  try {
    return await inTx(ctx, async (c) => {
      const id = newId()
      const [row] = await c.db.insert(categories).values({ id, name, description, created_at: c.now() }).returning()
      const created = mapCategory(row)
      await writeAudit(c, {
        action: 'create',
        entityType: 'category',
        entityId: id,
        before: null,
        after: { name, description, created_at: created.created_at },
      })
      return created
    })
  } catch (err) {
    if (pgError(err)?.code === '23505') throw categoryNameTaken(name)
    throw err
  }
}

export async function updateCategory(ctx: Ctx, id: string, input: CategoryInput): Promise<Category> {
  assertAdmin(ctx)
  const payload = normalizeCategory(input)
  try {
    return await inTx(ctx, async (c) => {
      const [existing] = await c.db.select().from(categories).where(eq(categories.id, id)).for('no key update')
      if (!existing) throw new DataError(404, 'Category not found.')
      // Like the Categories page today, this does not rewrite `category_name` on the products already using it.
      const [row] = await c.db.update(categories).set(payload).where(eq(categories.id, id)).returning()
      await writeAudit(c, {
        action: 'update',
        entityType: 'category',
        entityId: id,
        before: { name: existing.name, description: existing.description },
        after: payload,
      })
      return mapCategory(row)
    })
  } catch (err) {
    if (pgError(err)?.code === '23505') throw categoryNameTaken(payload.name)
    throw err
  }
}

export async function deleteCategory(ctx: Ctx, id: string): Promise<void> {
  assertAdmin(ctx)
  await inTx(ctx, async (c) => {
    const [existing] = await c.db.select().from(categories).where(eq(categories.id, id)).for('update')
    if (!existing) throw new DataError(404, 'Category not found.')
    const [{ n }] = await c.db.select({ n: count() }).from(products).where(eq(products.category_id, id))
    if (n > 0) throw new DataError(409, categoryInUseMessage(n))
    await c.db.delete(categories).where(eq(categories.id, id))
    await writeAudit(c, {
      action: 'delete',
      entityType: 'category',
      entityId: id,
      before: { name: existing.name, description: existing.description },
      after: null,
    })
  })
}

// --- Products: reads ---------------------------------------------------------

/** Products (public: no sign-in needed), ordered by name, each with its barcodes in saved order. */
export async function listProducts(ctx: Ctx, opts: { availableOnly?: boolean } = {}): Promise<ProductOut[]> {
  const rows = await ctx.db
    .select()
    .from(products)
    .where(opts.availableOnly ? eq(products.available, true) : undefined)
    .orderBy(asc(products.name), asc(products.id))
  if (rows.length === 0) return []
  const codeRows = await ctx.db
    .select()
    .from(productBarcodes)
    .where(inArray(productBarcodes.product_id, rows.map((r) => r.id)))
    .orderBy(asc(productBarcodes.product_id), asc(productBarcodes.position))
  const byProduct = new Map<string, string[]>()
  for (const c of codeRows) {
    const list = byProduct.get(c.product_id)
    if (list) list.push(c.barcode)
    else byProduct.set(c.product_id, [c.barcode])
  }
  return rows.map((r) => mapProduct(r, byProduct.get(r.id) ?? []))
}

export async function getProduct(ctx: Ctx, id: string): Promise<ProductOut | null> {
  const [row] = await ctx.db.select().from(products).where(eq(products.id, id)).limit(1)
  if (!row) return null
  return mapProduct(row, await barcodesFor(ctx, id))
}

export async function findProductByBarcode(ctx: Ctx, code: string): Promise<ProductOut | null> {
  assertAdmin(ctx)
  const trimmed = (code ?? '').trim()
  if (!trimmed) return null
  const [hit] = await ctx.db
    .select({ product_id: productBarcodes.product_id })
    .from(productBarcodes)
    .where(eq(productBarcodes.barcode, trimmed))
    .limit(1)
  return hit ? getProduct(ctx, hit.product_id) : null
}

/**
 * Whether any barcode in `codes` is already used by a product other than `excludeId` (the product being edited, if
 * any). Returns the first conflicting code (in the order given), or null.
 */
export async function findBarcodeConflict(ctx: Ctx, codes: string[], excludeId?: string): Promise<string | null> {
  assertAdmin(ctx)
  const trimmed = (Array.isArray(codes) ? codes : []).map((c) => String(c).trim()).filter(Boolean)
  if (trimmed.length === 0) return null
  const rows = await ctx.db
    .select({ barcode: productBarcodes.barcode })
    .from(productBarcodes)
    .where(
      and(
        inArray(productBarcodes.barcode, trimmed),
        excludeId ? ne(productBarcodes.product_id, excludeId) : undefined,
      ),
    )
  const hits = new Set(rows.map((r) => r.barcode))
  return trimmed.find((c) => hits.has(c)) ?? null
}

// --- Products: writes --------------------------------------------------------

interface CleanProduct {
  name: string
  barcodes: string[]
  category_id: string | null
  description: string
  quantity_on_hand: number
  reorder_threshold: number
  available: boolean
  location: string
  lend_from: string | null
  lend_to: string | null
  lending_interval: LendingInterval
  images: string[]
}

function wholeNumber(value: unknown, label: string): number {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) throw new DataError(400, `${label} must be a whole number, 0 or more.`)
  if (n > 2_147_483_647) throw new DataError(400, `${label} is too large.`)
  return n
}

function dateOrNull(value: unknown, label: string): string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string' || !DATE_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
    throw new DataError(400, `${label} must be a date (YYYY-MM-DD).`)
  }
  return value
}

function cleanProduct(input: ProductInput): CleanProduct {
  if (!input || typeof input !== 'object') throw new DataError(400, 'Product details are required.')
  if (typeof input.name !== 'string' || !input.name.trim()) throw new DataError(400, 'Name is required.')
  const rawCodes = Array.isArray(input.barcodes) ? input.barcodes : []
  const barcodes: string[] = []
  for (const raw of rawCodes) {
    const code = typeof raw === 'string' ? raw.trim() : ''
    if (code && !barcodes.includes(code)) barcodes.push(code)
  }
  const interval = input.lending_interval ?? 'week_1'
  if (!(LENDING_INTERVALS as readonly string[]).includes(interval)) throw new DataError(400, 'Lending interval is not valid.')
  const images = Array.isArray(input.images) ? input.images : []
  if (!images.every((i) => typeof i === 'string')) throw new DataError(400, 'Images must be storage paths.')
  return {
    name: input.name,
    barcodes,
    category_id: typeof input.category_id === 'string' && input.category_id ? input.category_id : null,
    description: typeof input.description === 'string' ? input.description : '',
    quantity_on_hand: wholeNumber(input.quantity_on_hand ?? 0, 'Qty On Hand'),
    reorder_threshold: wholeNumber(input.reorder_threshold ?? 0, 'Reorder Threshold'),
    available: input.available !== false,
    location: typeof input.location === 'string' ? input.location : DEFAULT_LOCATION,
    lend_from: dateOrNull(input.lend_from, 'Available From'),
    lend_to: dateOrNull(input.lend_to, 'Available To'),
    lending_interval: interval,
    images,
  }
}

async function categoryNameFor(c: Ctx, categoryId: string | null): Promise<string | null> {
  if (!categoryId) return null
  const [cat] = await c.db.select({ name: categories.name }).from(categories).where(eq(categories.id, categoryId)).limit(1)
  if (!cat) throw new DataError(400, 'That category no longer exists.')
  return cat.name
}

async function assertNoBarcodeConflict(c: Ctx, codes: string[], excludeId?: string): Promise<void> {
  const conflict = await findBarcodeConflict(c, codes, excludeId)
  if (conflict) throw new DataError(409, barcodeConflictMessage(conflict))
}

async function insertBarcodes(c: Ctx, productId: string, codes: string[]): Promise<void> {
  if (codes.length === 0) return
  await c.db.insert(productBarcodes).values(codes.map((barcode, position) => ({ barcode, product_id: productId, position })))
}

/** A unique-violation on a barcode raced past the conflict check: answer with the same friendly 409 as the check. */
async function mapWriteError(ctx: Ctx, err: unknown, codes: string[], excludeId?: string): Promise<unknown> {
  const pg = pgError(err)
  if (pg?.code !== '23505') return err
  if (pg.constraint === 'products_pkey') return new DataError(409, 'A product with this id already exists.')
  const fromDetail = /\(barcode\)=\(([\s\S]*)\) already exists/.exec(pg.detail ?? '')?.[1]
  const code = fromDetail ?? (await findBarcodeConflict(ctx, codes, excludeId))
  return new DataError(409, code ? barcodeConflictMessage(code) : 'A barcode is already used by another product.')
}

export async function createProduct(ctx: Ctx, input: ProductInput): Promise<ProductOut> {
  assertAdmin(ctx)
  const clean = cleanProduct(input)
  if (input.id !== undefined && !ID_PATTERN.test(String(input.id))) throw new DataError(400, 'Product id is not valid.')
  const id = input.id ?? newId()
  try {
    return await inTx(ctx, async (c) => {
      await assertNoBarcodeConflict(c, clean.barcodes)
      const category_name = await categoryNameFor(c, clean.category_id)
      const now = c.now()
      const [row] = await c.db
        .insert(products)
        .values({
          id,
          category_id: clean.category_id,
          category_name,
          name: clean.name,
          description: clean.description,
          quantity_on_hand: clean.quantity_on_hand,
          reorder_threshold: clean.reorder_threshold,
          available: clean.available,
          location: clean.location,
          lend_from: clean.lend_from,
          lend_to: clean.lend_to,
          lending_interval: clean.lending_interval,
          images: clean.images,
          created_at: now,
          updated_at: now,
        })
        .returning()
      await insertBarcodes(c, id, clean.barcodes)
      const created = mapProduct(row, clean.barcodes)
      await writeAudit(c, {
        action: 'create',
        entityType: 'product',
        entityId: id,
        before: null,
        after: {
          name: clean.name,
          barcodes: clean.barcodes,
          category_id: clean.category_id,
          category_name,
          description: clean.description,
          quantity_on_hand: clean.quantity_on_hand,
          reorder_threshold: clean.reorder_threshold,
          available: clean.available,
          location: clean.location,
          lend_from: clean.lend_from,
          lend_to: clean.lend_to,
          lending_interval: clean.lending_interval,
          updated_at: created.updated_at,
          created_at: created.created_at,
          images: clean.images,
        },
      })
      return created
    })
  } catch (err) {
    throw await mapWriteError(ctx, err, clean.barcodes)
  }
}

export async function updateProduct(ctx: Ctx, id: string, input: ProductInput): Promise<ProductOut> {
  assertAdmin(ctx)
  const clean = cleanProduct(input)
  try {
    return await inTx(ctx, async (c) => {
      const [existing] = await c.db.select().from(products).where(eq(products.id, id)).for('no key update')
      if (!existing) throw new DataError(404, 'Product not found.')
      const existingCodes = await barcodesFor(c, id)
      await assertNoBarcodeConflict(c, clean.barcodes, id)
      const category_name = await categoryNameFor(c, clean.category_id)
      const [row] = await c.db
        .update(products)
        .set({
          category_id: clean.category_id,
          category_name,
          name: clean.name,
          description: clean.description,
          quantity_on_hand: clean.quantity_on_hand,
          reorder_threshold: clean.reorder_threshold,
          available: clean.available,
          location: clean.location,
          lend_from: clean.lend_from,
          lend_to: clean.lend_to,
          lending_interval: clean.lending_interval,
          images: clean.images,
          updated_at: c.now(),
        })
        .where(eq(products.id, id))
        .returning()
      await c.db.delete(productBarcodes).where(eq(productBarcodes.product_id, id))
      await insertBarcodes(c, id, clean.barcodes)
      const updated = mapProduct(row, clean.barcodes)
      const payload = {
        name: clean.name,
        barcodes: clean.barcodes,
        category_id: clean.category_id,
        category_name,
        description: clean.description,
        quantity_on_hand: clean.quantity_on_hand,
        reorder_threshold: clean.reorder_threshold,
        available: clean.available,
        location: clean.location,
        lend_from: clean.lend_from,
        lend_to: clean.lend_to,
        lending_interval: clean.lending_interval,
        updated_at: updated.updated_at,
        images: clean.images,
      }
      const reason = typeof input.quantity_reason === 'string' ? input.quantity_reason.trim() : ''
      await writeAudit(c, {
        action: 'update',
        entityType: 'product',
        entityId: id,
        before: {
          name: existing.name,
          barcodes: existingCodes,
          category_id: existing.category_id,
          description: existing.description ?? '',
          quantity_on_hand: existing.quantity_on_hand,
          reorder_threshold: existing.reorder_threshold,
          available: existing.available,
          location: existing.location,
          lend_from: existing.lend_from,
          lend_to: existing.lend_to,
          lending_interval: existing.lending_interval ?? 'week_1',
          images: existing.images,
        },
        // The change reason is only ever meaningful for this one audit entry; it is not a product field.
        after: reason ? { ...payload, reason } : payload,
      })
      return updated
    })
  } catch (err) {
    throw await mapWriteError(ctx, err, clean.barcodes, id)
  }
}

export async function deleteProduct(ctx: Ctx, id: string): Promise<void> {
  assertAdmin(ctx)
  try {
    await inTx(ctx, async (c) => {
      const [existing] = await c.db.select().from(products).where(eq(products.id, id)).for('update')
      if (!existing) throw new DataError(404, 'Product not found.')
      const reason = productDeleteBlockReason(await computeDeleteBlockers(c, id))
      if (reason) throw new DataError(409, reason)
      const codes = await barcodesFor(c, id)
      await c.db.delete(products).where(eq(products.id, id)) // its barcodes go with it (ON DELETE CASCADE)
      await writeAudit(c, {
        action: 'delete',
        entityType: 'product',
        entityId: id,
        before: {
          name: existing.name,
          barcodes: codes,
          category_id: existing.category_id,
          category_name: existing.category_name,
          description: existing.description ?? '',
          quantity_on_hand: existing.quantity_on_hand,
          reorder_threshold: existing.reorder_threshold,
          available: existing.available,
          location: existing.location,
        },
        after: null,
      })
    })
  } catch (err) {
    // Stock In/Out lines, waivers and loan-request lines keep pointing at the product (they are append-only history).
    if (pgError(err)?.code === '23503') {
      throw new DataError(409, "This product has stock history (Stock In/Out records) and can't be deleted.")
    }
    throw err
  }
}

// --- Ledger-based checks -----------------------------------------------------

/**
 * Same "issued − returned − waived" ledger the Dashboard's Outstanding Returns table computes for every product at
 * once, scoped to this one product's lines.
 */
export async function getOutstandingHolders(ctx: Ctx, productId: string): Promise<OutstandingHolder[]> {
  assertAdmin(ctx)
  return computeOutstandingHolders(ctx, productId)
}

async function computeOutstandingHolders(ctx: Ctx, productId: string): Promise<OutstandingHolder[]> {
  const lines = await ctx.db
    .select({ transaction_id: transactionLines.transaction_id, quantity: transactionLines.quantity })
    .from(transactionLines)
    .where(eq(transactionLines.product_id, productId))
  if (lines.length === 0) return []

  const qtyByTxn = new Map<string, number>()
  for (const l of lines) qtyByTxn.set(l.transaction_id, (qtyByTxn.get(l.transaction_id) ?? 0) + (l.quantity || 0))

  const txns = await ctx.db
    .select()
    .from(transactions)
    .where(inArray(transactions.id, [...qtyByTxn.keys()]))
    .orderBy(asc(transactions.created_at), asc(transactions.id))

  const returnedByOutTxn = new Map<string, number>()
  for (const t of txns) {
    if (t.transaction_type === 'RETURN' && t.linked_txn_id) {
      returnedByOutTxn.set(t.linked_txn_id, (returnedByOutTxn.get(t.linked_txn_id) ?? 0) + (qtyByTxn.get(t.id) ?? 0))
    }
  }

  const waiverRows = await ctx.db
    .select({ transaction_id: returnWaivers.transaction_id, quantity: sql<number>`sum(${returnWaivers.quantity})::int` })
    .from(returnWaivers)
    .where(eq(returnWaivers.product_id, productId))
    .groupBy(returnWaivers.transaction_id)
  const waivedByTxn = new Map(waiverRows.map((w) => [w.transaction_id, w.quantity]))

  const holders: OutstandingHolder[] = []
  for (const t of txns) {
    if (t.transaction_type !== 'OUT') continue
    const remaining = (qtyByTxn.get(t.id) ?? 0) - (returnedByOutTxn.get(t.id) ?? 0) - (waivedByTxn.get(t.id) ?? 0)
    if (remaining > 0) {
      holders.push({ txnId: t.id, staffName: t.staff_name ?? '—', quantity: remaining, txnRef: t.reference_no ?? '' })
    }
  }
  return holders
}

/**
 * How many physical units of a product carry each of its barcodes, worked out from the barcodes recorded on Stock In /
 * Stock Out / Return lines:
 * `outstanding` = issued under the barcode and not yet returned or written off; `inStock` = received under it (or
 * returned wearing it) and not issued; `total` = both. Only scans that recorded a barcode count, so treat it as a floor.
 */
export async function getBarcodeUnitCounts(ctx: Ctx, productId: string): Promise<Record<string, BarcodeUnitCount>> {
  assertAdmin(ctx)
  const lines = await ctx.db
    .select({
      transaction_id: transactionLines.transaction_id,
      quantity: transactionLines.quantity,
      barcode: transactionLines.barcode,
      issued_barcode: transactionLines.issued_barcode,
      transaction_type: transactions.transaction_type,
      linked_txn_id: transactions.linked_txn_id,
    })
    .from(transactionLines)
    .innerJoin(transactions, eq(transactions.id, transactionLines.transaction_id))
    .where(eq(transactionLines.product_id, productId))
    .orderBy(asc(transactionLines.created_at), asc(transactionLines.line_no), asc(transactionLines.id))
  if (lines.length === 0) return {}

  type Line = (typeof lines)[number]
  const received = new Map<string, number>()
  const issued = new Map<string, number>()
  const returnedAs = new Map<string, number>()
  const outLinesByTxn = new Map<string, Line[]>()
  const returnLinesByOut = new Map<string, Line[]>()
  const bump = (m: Map<string, number>, k: string, q: number) => m.set(k, (m.get(k) ?? 0) + q)
  const push = (m: Map<string, Line[]>, k: string, l: Line) => {
    const list = m.get(k)
    if (list) list.push(l)
    else m.set(k, [l])
  }

  for (const l of lines) {
    const q = l.quantity || 0
    const code = l.barcode ? l.barcode : null
    if (l.transaction_type === 'IN' && code) bump(received, code, q)
    else if (l.transaction_type === 'OUT') {
      if (code) bump(issued, code, q)
      push(outLinesByTxn, l.transaction_id, l)
    } else if (l.transaction_type === 'RETURN') {
      if (code) bump(returnedAs, code, q)
      if (l.linked_txn_id) push(returnLinesByOut, l.linked_txn_id, l)
    }
  }

  const waiverRows = await ctx.db
    .select({ transaction_id: returnWaivers.transaction_id, quantity: sql<number>`sum(${returnWaivers.quantity})::int` })
    .from(returnWaivers)
    .where(eq(returnWaivers.product_id, productId))
    .groupBy(returnWaivers.transaction_id)
  const waivedByTxn = new Map(waiverRows.map((w) => [w.transaction_id, w.quantity]))

  const outstanding = new Map<string, number>()
  outLinesByTxn.forEach((outLines, txnId) => {
    const open = openBarcodeQuantities(outLines, returnLinesByOut.get(txnId) ?? [], waivedByTxn.get(txnId) ?? 0)
    open.forEach((o) => bump(outstanding, o.barcode, o.quantity))
  })

  const result: Record<string, BarcodeUnitCount> = {}
  const codes = new Set<string>([...received.keys(), ...issued.keys(), ...returnedAs.keys(), ...outstanding.keys()])
  codes.forEach((code) => {
    const out = outstanding.get(code) ?? 0
    const inStock = Math.max(0, (received.get(code) ?? 0) + (returnedAs.get(code) ?? 0) - (issued.get(code) ?? 0))
    result[code] = { inStock, outstanding: out, total: inStock + out }
  })
  return result
}

/** Active loan requests (pending / countered / accepted, any dates) that still promise units of this product. */
async function computeReservationHolders(ctx: Ctx, productId: string): Promise<ReservationHolder[]> {
  const rows = await ctx.db
    .select({
      requestId: loanRequests.id,
      staffId: loanRequests.staff_id,
      staffName: loanRequests.staff_name,
      quantity: loanRequestLines.offered_quantity,
      fromDate: loanRequests.from_date,
      toDate: loanRequests.to_date,
      status: loanRequests.status,
    })
    .from(loanRequestLines)
    .innerJoin(loanRequests, eq(loanRequests.id, loanRequestLines.request_id))
    .where(
      and(
        eq(loanRequestLines.product_id, productId),
        inArray(loanRequests.status, ACTIVE_STATUSES),
        sql`${loanRequestLines.offered_quantity} > 0`,
      ),
    )
    .orderBy(asc(loanRequests.created_at), asc(loanRequests.id), asc(loanRequestLines.line_no), asc(loanRequestLines.id))
  return rows
}

async function computeDeleteBlockers(ctx: Ctx, productId: string): Promise<ProductDeleteBlockers> {
  const outstanding = await computeOutstandingHolders(ctx, productId)
  const reservations = await computeReservationHolders(ctx, productId)
  return { outstanding, reservations }
}

export async function getProductDeleteBlockers(ctx: Ctx, productId: string): Promise<ProductDeleteBlockers> {
  assertAdmin(ctx)
  return computeDeleteBlockers(ctx, productId)
}

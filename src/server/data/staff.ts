import 'server-only'
import { and, asc, eq, ne, sql } from 'drizzle-orm'
import { assertAdmin, assertStaffSelf, DataError, type Ctx } from '@/server/context'
import { toIso, withTx, type Db } from '@/server/db/client'
import { newId } from '@/server/db/ids'
import { pgError } from '@/server/db/pgError'
import { returnWaivers, staff, transactionLines, transactions } from '@/server/db/schema'
import { writeAudit } from '@/server/data/audit'
import { setOwnProfileName } from '@/server/data/profiles'
import { normalizeEmail } from '@/lib/firebase/staff'
import {
  staffCardConflictMessage,
  staffEmailConflictMessage,
  staffUidConflictMessage,
  type HeldItem,
  type OwnDetailsInput,
  type ResolveHeldItemInput,
  type StaffHoldings,
  type StaffInput,
} from '@/lib/staffRules'
import type { StaffMember } from '@/types/database'

// `StaffMember.id` is typed `number` in src/types/database.ts but ids are strings (same cast the Firestore code used for
// its string document ids); the server side says so honestly, and the browser client hands pages the `StaffMember` type.
export type StaffOut = Omit<StaffMember, 'id'> & { id: string }

type StaffRow = typeof staff.$inferSelect

const NOT_FOUND = 'Staff record not found.'

/** Run `fn` in a transaction on the caller's connection (a savepoint when `ctx.db` is already a transaction). */
function inTx<T>(ctx: Ctx, fn: (txCtx: Ctx) => Promise<T>): Promise<T> {
  return withTx(ctx.db as Db, (tx) => fn({ ...ctx, db: tx }))
}

function mapStaff(row: StaffRow): StaffOut {
  return {
    id: row.id,
    name: row.name,
    surname: row.surname,
    full_name: row.full_name,
    email: row.email,
    department: row.department,
    card_uid: row.card_uid,
    is_active: row.is_active,
    uid: row.uid,
    is_admin_account: row.is_admin_account,
    created_at: toIso(row.created_at) as string,
    updated_at: toIso(row.updated_at) as string,
  }
}

async function loadRow(ctx: Ctx, id: string): Promise<StaffRow> {
  const [row] = await ctx.db.select().from(staff).where(eq(staff.id, id)).limit(1)
  if (!row) throw new DataError(404, NOT_FOUND)
  return row
}

function clean(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function names(name: unknown, surname: unknown, message: string): { name: string; surname: string; full_name: string } {
  const n = typeof name === 'string' ? name.trim() : ''
  const s = typeof surname === 'string' ? surname.trim() : ''
  if (!n || !s) throw new DataError(400, message)
  return { name: n, surname: s, full_name: `${n} ${s}`.trim() }
}

/** The other staff row that has this email (any letter case), or null. */
async function emailOwner(ctx: Ctx, email: string, excludeId?: string): Promise<{ id: string; full_name: string } | null> {
  const where = excludeId
    ? and(sql`lower(${staff.email}) = ${email}`, ne(staff.id, excludeId))
    : sql`lower(${staff.email}) = ${email}`
  const [row] = await ctx.db.select({ id: staff.id, full_name: staff.full_name }).from(staff).where(where).limit(1)
  return row ?? null
}

/** The other staff row linked to this Firebase Auth uid, or null. */
export async function findStaffOwningUid(
  db: Db | Ctx['db'],
  uid: string,
  excludeId?: string,
): Promise<{ id: string; full_name: string } | null> {
  const where = excludeId ? and(eq(staff.uid, uid), ne(staff.id, excludeId)) : eq(staff.uid, uid)
  const [row] = await db.select({ id: staff.id, full_name: staff.full_name }).from(staff).where(where).limit(1)
  return row ?? null
}

/** A unique-constraint failure from a save, turned into the friendly 409 (races past the explicit checks land here). */
async function saveConflict(ctx: Ctx, err: unknown, email: string | null, cardUid: string | null, selfId?: string): Promise<DataError | null> {
  const pg = pgError(err)
  if (pg?.code !== '23505') return null
  if (email && pg.constraint === 'staff_email_lower_uq') {
    const other = await emailOwner(ctx, email, selfId)
    if (other) return new DataError(409, staffEmailConflictMessage(other.full_name))
  }
  if (cardUid && pg.constraint === 'staff_card_uid_unique') {
    const [other] = await ctx.db.select({ full_name: staff.full_name }).from(staff).where(eq(staff.card_uid, cardUid)).limit(1)
    if (other) return new DataError(409, staffCardConflictMessage(other.full_name))
  }
  return null
}

async function cardOwner(ctx: Ctx, cardUid: string, excludeId?: string): Promise<{ full_name: string } | null> {
  const where = excludeId ? and(eq(staff.card_uid, cardUid), ne(staff.id, excludeId)) : eq(staff.card_uid, cardUid)
  const [row] = await ctx.db.select({ full_name: staff.full_name }).from(staff).where(where).limit(1)
  return row ?? null
}

// --- Reads -------------------------------------------------------------------

/**
 * Everyone on the Staff page, by name. The admin's own borrower record (`is_admin_account`) is left out unless asked for:
 * it exists so she can be picked in Stock Out, not to be managed as a staff member.
 */
export async function listStaff(ctx: Ctx, opts: { includeAdminAccount?: boolean } = {}): Promise<StaffOut[]> {
  assertAdmin(ctx)
  const rows = await ctx.db
    .select()
    .from(staff)
    .where(opts.includeAdminAccount ? undefined : eq(staff.is_admin_account, false))
    .orderBy(asc(staff.full_name), asc(staff.id))
  return rows.map(mapStaff)
}

/** One staff record: an admin may read any; anyone else only their own. Null when it doesn't exist. */
export async function getStaff(ctx: Ctx, id: string): Promise<StaffOut | null> {
  assertStaffSelf(ctx, id)
  const [row] = await ctx.db.select().from(staff).where(eq(staff.id, id)).limit(1)
  return row ? mapStaff(row) : null
}

/** The other staff record that already has this email (case-insensitive), or null. Pass `excludeId` when editing. */
export async function findStaffEmailConflict(
  ctx: Ctx,
  email: string,
  excludeId?: string,
): Promise<{ id: string; full_name: string } | null> {
  assertAdmin(ctx)
  const normalized = normalizeEmail(email ?? '')
  if (!normalized) return null
  return emailOwner(ctx, normalized, excludeId)
}

// --- Create / update (Staff page) ---------------------------------------------

export async function createStaff(ctx: Ctx, input: StaffInput): Promise<StaffOut> {
  assertAdmin(ctx)
  const { name, surname, full_name } = names(input?.name, input?.surname, 'Name and surname are required.')
  const email = clean(input.email) ? normalizeEmail(input.email as string) : null
  const department = clean(input.department)
  const card_uid = clean(input.card_uid)

  try {
    return await inTx(ctx, async (c) => {
      if (email) {
        const other = await emailOwner(c, email)
        if (other) throw new DataError(409, staffEmailConflictMessage(other.full_name))
      }
      if (card_uid) {
        const other = await cardOwner(c, card_uid)
        if (other) throw new DataError(409, staffCardConflictMessage(other.full_name))
      }
      const now = c.now()
      const id = newId()
      const [row] = await c.db
        .insert(staff)
        .values({ id, name, surname, full_name, email, department, card_uid, is_active: true, created_at: now, updated_at: now })
        .returning()
      const created = mapStaff(row)
      await writeAudit(c, {
        action: 'create',
        entityType: 'staff',
        entityId: id,
        before: null,
        after: {
          name,
          surname,
          full_name,
          email,
          department,
          card_uid,
          is_active: true,
          created_at: created.created_at,
          updated_at: created.updated_at,
        },
      })
      return created
    })
  } catch (err) {
    throw (await saveConflict(ctx, err, email, card_uid)) ?? err
  }
}

export async function updateStaff(ctx: Ctx, id: string, input: StaffInput): Promise<StaffOut> {
  assertAdmin(ctx)
  const { name, surname, full_name } = names(input?.name, input?.surname, 'Name and surname are required.')
  const email = clean(input.email) ? normalizeEmail(input.email as string) : null
  const department = clean(input.department)
  const card_uid = clean(input.card_uid)

  try {
    return await inTx(ctx, async (c) => {
      const before = await loadRow(c, id)
      if (email) {
        const other = await emailOwner(c, email, id)
        if (other) throw new DataError(409, staffEmailConflictMessage(other.full_name))
      }
      if (card_uid) {
        const other = await cardOwner(c, card_uid, id)
        if (other) throw new DataError(409, staffCardConflictMessage(other.full_name))
      }
      const [row] = await c.db
        .update(staff)
        .set({ name, surname, full_name, email, department, card_uid, updated_at: c.now() })
        .where(eq(staff.id, id))
        .returning()
      const updated = mapStaff(row)
      const after = { name, surname, full_name, email, department, card_uid, updated_at: updated.updated_at }
      await writeAudit(c, {
        action: 'update',
        entityType: 'staff',
        entityId: id,
        before: {
          name: before.name,
          surname: before.surname,
          full_name: before.full_name,
          email: before.email,
          department: before.department,
          card_uid: before.card_uid,
        },
        // Flags that this edit also re-pointed the linked login account, which decides where future password-reset
        // links are delivered: a materially different act from editing a contact detail.
        after: input.auth_email_synced ? { ...after, auth_email_synced: true } : after,
      })
      return updated
    })
  } catch (err) {
    throw (await saveConflict(ctx, err, email, card_uid, id)) ?? err
  }
}

/**
 * Activate or deactivate. The audit entry carries who it was (name, surname, email identical before and after, only
 * `is_active` changes): the Audit Log's activate/deactivate summary reads them straight off `after`.
 */
export async function setStaffActive(ctx: Ctx, id: string, active: boolean): Promise<StaffOut> {
  assertAdmin(ctx)
  return inTx(ctx, async (c) => {
    const before = await loadRow(c, id)
    const [row] = await c.db.update(staff).set({ is_active: active, updated_at: c.now() }).where(eq(staff.id, id)).returning()
    const who = { name: before.name, surname: before.surname, full_name: before.full_name, email: before.email }
    await writeAudit(c, {
      action: active ? 'activate' : 'deactivate',
      entityType: 'staff',
      entityId: id,
      before: { is_active: before.is_active, ...who },
      after: { is_active: active, ...who },
    })
    return mapStaff(row)
  })
}

// --- Login access (called by the /api/staff/* routes after the Firebase Auth step) --

/**
 * Link the staff record to a Firebase Auth account and audit it as `grant_access`. Refuses (409) when another staff
 * record already owns that account. The audit entry is identifying context, not a diff: the same shape on both sides.
 * `email` is the address the login email goes to (defaults to the record's own).
 */
export async function linkStaffLogin(ctx: Ctx, id: string, uid: string, email?: string): Promise<StaffOut> {
  assertAdmin(ctx)
  try {
    return await inTx(ctx, async (c) => {
      const before = await loadRow(c, id)
      const other = await findStaffOwningUid(c.db, uid, id)
      if (other) throw new DataError(409, staffUidConflictMessage(other.full_name))
      let row = before
      if (before.uid !== uid) {
        ;[row] = await c.db.update(staff).set({ uid, updated_at: c.now() }).where(eq(staff.id, id)).returning()
      }
      const context = { full_name: row.full_name, email: email ?? row.email, uid }
      await writeAudit(c, { action: 'grant_access', entityType: 'staff', entityId: id, before: context, after: context })
      return mapStaff(row)
    })
  } catch (err) {
    // Two sends racing for the same account: the unique index on staff.uid catches what the check above missed.
    if (pgError(err)?.code === '23505') {
      const other = await findStaffOwningUid(ctx.db, uid, id)
      if (other) throw new DataError(409, staffUidConflictMessage(other.full_name))
    }
    throw err
  }
}

/** Audit one more login email sent to an already-linked account (`resend_access`). */
export async function logResendAccess(ctx: Ctx, id: string, sent?: { email?: string; uid?: string }): Promise<void> {
  assertAdmin(ctx)
  const row = await loadRow(ctx, id)
  const context = { full_name: row.full_name, email: sent?.email ?? row.email, uid: sent?.uid ?? row.uid }
  await writeAudit(ctx, { action: 'resend_access', entityType: 'staff', entityId: id, before: context, after: context })
}

// --- My Profile (the caller's own row) ----------------------------------------

/**
 * Save the caller's own details. Name, surname and department for anyone; the card UID too for an admin. When an admin
 * has no row yet, this creates their own borrower record (`is_admin_account`, so the Staff page hides it and Stock Out
 * can still pick them). `profiles.full_name` follows the new name. No audit entry, as the page wrote none.
 */
export async function updateOwnDetails(ctx: Ctx, input: OwnDetailsInput): Promise<StaffOut> {
  const uid = ctx.caller.uid
  if (!uid) throw new DataError(403, 'You can only do this for your own staff record.')
  const { name, surname, full_name } = names(input?.name, input?.surname, 'Name and surname are required.')
  const department = clean(input.department)
  const isAdmin = ctx.caller.role === 'admin'
  const card_uid = clean(input.card_uid)

  try {
    return await inTx(ctx, async (c) => {
      const [own] = await c.db.select().from(staff).where(eq(staff.uid, uid)).limit(1)
      let row: StaffRow
      if (own) {
        assertStaffSelf(c, own.id)
        if (isAdmin && card_uid) {
          const other = await cardOwner(c, card_uid, own.id)
          if (other) throw new DataError(409, staffCardConflictMessage(other.full_name))
        }
        ;[row] = await c.db
          .update(staff)
          .set({ name, surname, full_name, department, ...(isAdmin ? { card_uid } : {}), updated_at: c.now() })
          .where(eq(staff.id, own.id))
          .returning()
      } else {
        assertAdmin(c)
        const email = clean(input.email)
        if (email) {
          const other = await emailOwner(c, email.toLowerCase())
          if (other) throw new DataError(409, staffEmailConflictMessage(other.full_name))
        }
        if (card_uid) {
          const other = await cardOwner(c, card_uid)
          if (other) throw new DataError(409, staffCardConflictMessage(other.full_name))
        }
        const now = c.now()
        ;[row] = await c.db
          .insert(staff)
          .values({
            id: newId(),
            name,
            surname,
            full_name,
            department,
            card_uid,
            email,
            uid,
            is_admin_account: true,
            is_active: true,
            created_at: now,
            updated_at: now,
          })
          .returning()
      }
      // profiles.full_name is what the sidebar footer and every transaction/audit entry attribute to her as the operator.
      await setOwnProfileName(c, full_name)
      return mapStaff(row)
    })
  } catch (err) {
    throw (await saveConflict(ctx, err, clean(input.email)?.toLowerCase() ?? null, card_uid)) ?? err
  }
}

/**
 * Keep the caller's own staff record's email in step with their Firebase Auth account after a confirmed email change.
 * `authEmailOf(uid)` returns the account's real, current email (the route looks it up with Firebase Admin: the ID token's
 * own claim can be stale right after a change); anything other than that email is refused with 403, so a signed-in user
 * can't point their row at an arbitrary address. Null (nothing changed) when they have no staff record.
 */
export async function syncOwnEmail(
  ctx: Ctx,
  email: string,
  authEmailOf: (uid: string) => Promise<string | null | undefined>,
): Promise<StaffOut | null> {
  const uid = ctx.caller.uid
  if (!uid) throw new DataError(403, 'You can only do this for your own staff record.')
  const normalized = normalizeEmail(email ?? '')
  if (!normalized) throw new DataError(400, 'Email is required.')
  const authEmail = await authEmailOf(uid)
  if (!authEmail || normalizeEmail(authEmail) !== normalized) throw new DataError(403, 'You can only sync your own login email.')
  try {
    return await inTx(ctx, async (c) => {
      const [own] = await c.db.select().from(staff).where(eq(staff.uid, uid)).limit(1)
      if (!own) return null
      assertStaffSelf(c, own.id)
      const other = await emailOwner(c, normalized, own.id)
      if (other) throw new DataError(409, staffEmailConflictMessage(other.full_name))
      const [row] = await c.db.update(staff).set({ email: normalized, updated_at: c.now() }).where(eq(staff.id, own.id)).returning()
      return mapStaff(row)
    })
  } catch (err) {
    throw (await saveConflict(ctx, err, normalized, null)) ?? err
  }
}

// --- What each staff member holds ------------------------------------------------

type Qty = { txn_id: string; product_id: string; qty: number }

async function computeHoldings(ctx: Ctx, onlyStaffId?: string): Promise<StaffHoldings> {
  // Issued per (OUT transaction, product): lines collapsed by product, the product name from the first line.
  const issued = await ctx.db
    .select({
      txn_id: transactions.id,
      staff_id: transactions.staff_id,
      lend_to: transactions.lend_to,
      product_id: transactionLines.product_id,
      product_name: sql<string>`(array_agg(${transactionLines.product_name} order by ${transactionLines.created_at}, ${transactionLines.id}))[1]`,
      qty: sql<number>`sum(${transactionLines.quantity})::int`,
    })
    .from(transactions)
    .innerJoin(transactionLines, eq(transactionLines.transaction_id, transactions.id))
    .where(
      and(
        eq(transactions.transaction_type, 'OUT'),
        sql`${transactions.staff_id} is not null`,
        onlyStaffId ? eq(transactions.staff_id, onlyStaffId) : undefined,
      ),
    )
    .groupBy(transactions.id, transactions.staff_id, transactions.lend_to, transactions.created_at, transactionLines.product_id)
    .orderBy(asc(transactions.created_at), asc(transactions.id), sql`min(${transactionLines.created_at})`, sql`min(${transactionLines.id})`)

  // A return is matched to the specific OUT transaction it came back against (linked_txn_id), never lumped per product.
  const returnedRows: Qty[] = await ctx.db
    .select({
      txn_id: sql<string>`${transactions.linked_txn_id}`,
      product_id: transactionLines.product_id,
      qty: sql<number>`sum(${transactionLines.quantity})::int`,
    })
    .from(transactions)
    .innerJoin(transactionLines, eq(transactionLines.transaction_id, transactions.id))
    .where(and(eq(transactions.transaction_type, 'RETURN'), sql`${transactions.linked_txn_id} is not null`))
    .groupBy(transactions.linked_txn_id, transactionLines.product_id)

  const waivedRows: Qty[] = await ctx.db
    .select({
      txn_id: returnWaivers.transaction_id,
      product_id: returnWaivers.product_id,
      qty: sql<number>`sum(${returnWaivers.quantity})::int`,
    })
    .from(returnWaivers)
    .groupBy(returnWaivers.transaction_id, returnWaivers.product_id)

  const key = (r: { txn_id: string; product_id: string }) => `${r.txn_id}\u0000${r.product_id}`
  const returned = new Map(returnedRows.map((r) => [key(r), r.qty]))
  const waivedBy = new Map(waivedRows.map((r) => [key(r), r.qty]))

  const byStaff = new Map<string, HeldItem[]>()
  for (const line of issued) {
    const staffId = line.staff_id as string
    const ret = returned.get(key(line)) ?? 0
    const waived = waivedBy.get(key(line)) ?? 0
    const remaining = line.qty - ret - waived
    const bucket = byStaff.get(staffId) ?? []
    byStaff.set(staffId, bucket)

    // Still owed back.
    if (remaining > 0) {
      bucket.push({
        key: `${line.txn_id}_${line.product_id}_open`,
        txn_id: line.txn_id,
        product_id: line.product_id,
        product_name: line.product_name ?? 'Unknown',
        qty: remaining,
        expected_date: line.lend_to ?? null,
        waived: false,
      })
    }

    // Written off: no longer chased, but still with the staff member, so it stays listed. A return beyond what the
    // non-waived portion accounts for (issued - waived) must have come out of the waived quantity.
    const returnedBeyondOpenPortion = Math.max(0, ret - (line.qty - waived))
    const effectiveWaived = Math.max(0, waived - returnedBeyondOpenPortion)
    if (effectiveWaived > 0) {
      bucket.push({
        key: `${line.txn_id}_${line.product_id}_waived`,
        txn_id: line.txn_id,
        product_id: line.product_id,
        product_name: line.product_name ?? 'Unknown',
        qty: effectiveWaived,
        expected_date: line.lend_to ?? null,
        waived: true,
      })
    }
  }

  const holdings: StaffHoldings = {}
  for (const [staffId, items] of byStaff) {
    if (items.length === 0) continue
    // Most urgent first, undated after those, written-off last (nothing to chase, so reference only). Stable sort.
    items.sort((a, b) => {
      if (a.waived !== b.waived) return a.waived ? 1 : -1
      if (!a.expected_date && !b.expected_date) return 0
      if (!a.expected_date) return 1
      if (!b.expected_date) return -1
      return a.expected_date.localeCompare(b.expected_date)
    })
    holdings[staffId] = { outstanding: items.filter((i) => !i.waived).reduce((n, i) => n + i.qty, 0), items }
  }
  return holdings
}

/**
 * Per staff member (only those holding something, or something written off): the quantity still owed back and the
 * items themselves. A holder shows as "Lending" on the Staff page even when everything they hold is written off.
 */
export async function getStaffHoldings(ctx: Ctx): Promise<StaffHoldings> {
  assertAdmin(ctx)
  return computeHoldings(ctx)
}

/**
 * Record that an item a staff member holds does not need to come back (a return waiver). Stock levels are not changed:
 * the item left the shelf when it was issued. Logged as `resolve` against the originating transaction.
 */
export async function resolveHeldItem(ctx: Ctx, staffId: string, input: ResolveHeldItemInput): Promise<string> {
  assertAdmin(ctx)
  const quantity = Number(input?.quantity)
  if (!Number.isInteger(quantity) || quantity <= 0) throw new DataError(400, 'Quantity must be a whole number above zero.')
  const transactionId = String(input?.transactionId ?? '')
  const productId = String(input?.productId ?? '')
  const reason = clean(input?.reason)

  return inTx(ctx, async (c) => {
    const holder = await loadRow(c, staffId)
    const open = (await computeHoldings(c, staffId))[staffId]?.items.find(
      (i) => !i.waived && i.txn_id === transactionId && i.product_id === productId,
    )
    if (!open || open.qty < quantity) throw new DataError(409, 'Nothing outstanding to resolve for this item.')

    const id = newId()
    const payload = {
      transaction_id: transactionId,
      product_id: productId,
      product_name: open.product_name,
      staff_id: staffId,
      staff_name: holder.full_name,
      quantity,
      reason,
      created_at: c.now().toISOString(),
      resolved_by_uid: c.caller.uid,
      resolved_by_name: c.caller.name,
    }
    await c.db.insert(returnWaivers).values({ ...payload, id, created_at: c.now() })
    await writeAudit(c, { action: 'resolve', entityType: 'transaction', entityId: transactionId, before: null, after: payload })
    return id
  })
}

import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  createStaff,
  findStaffEmailConflict,
  getStaff,
  getStaffHoldings,
  linkStaffLogin,
  listStaff,
  logResendAccess,
  resolveHeldItem,
  setStaffActive,
  syncOwnEmail,
  updateOwnDetails,
  updateStaff,
} from '@/server/data/staff'
import {
  auditLog,
  products,
  profiles,
  returnWaivers,
  staff,
  transactionLines,
  transactions,
} from '@/server/db/schema'
import type { Db } from '@/server/db/client'
import { DataError, type Caller, type Ctx } from '@/server/context'
import { findStaffDocOwningUid } from '@/lib/server/staffAdmin'
import { setDbForTests } from '@/server/context'
import { closeTestDb, resetTestDb } from '../helpers/db'

let db: Db

const NOW = new Date('2026-10-04T09:00:00.000Z')
const admin: Caller = { uid: 'admin-uid', name: 'Ada Admin', role: 'admin', staffId: null }
const sam: Caller = { uid: 'sam-uid', name: 'Sam Staff', role: 'staff', staffId: 'staff-1' }

const ctxAs = (caller: Caller): Ctx => ({ db, caller, now: () => NOW })
const adminCtx = () => ctxAs(admin)

async function expectDataError(p: Promise<unknown>, status: number, message?: string) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(DataError)
  expect((err as DataError).status).toBe(status)
  if (message !== undefined) expect((err as DataError).message).toBe(message)
}

const audits = () => db.select().from(auditLog)

beforeAll(async () => {
  db = await resetTestDb()
  setDbForTests(db)
})
afterAll(async () => {
  setDbForTests(null)
  await closeTestDb()
})

beforeEach(async () => {
  await db.delete(auditLog)
  await db.delete(returnWaivers)
  await db.delete(transactionLines)
  await db.delete(transactions)
  await db.delete(products)
  await db.delete(staff)
  await db.delete(profiles)
  await db.insert(profiles).values([
    { uid: 'admin-uid', full_name: 'Ada Admin', role: 'admin' },
    { uid: 'sam-uid', full_name: 'Sam Staff', role: 'staff' },
  ])
  await db.insert(staff).values([
    {
      id: 'staff-1',
      name: 'Sam',
      surname: 'Staff',
      full_name: 'Sam Staff',
      email: 'sam@nwu.test',
      department: 'Maths',
      uid: 'sam-uid',
    },
    { id: 'staff-2', name: 'Bo', surname: 'Rrower', full_name: 'Bo Rrower', email: 'bo@nwu.test', card_uid: 'CARD-2' },
    { id: 'admin-row', name: 'Ada', surname: 'Admin', full_name: 'Ada Admin', is_admin_account: true, uid: 'admin-uid' },
  ])
})

describe('listStaff / getStaff', () => {
  it('lists by name without the admin account unless asked, as the app types expect', async () => {
    const rows = await listStaff(adminCtx())
    expect(rows.map((s) => s.full_name)).toEqual(['Bo Rrower', 'Sam Staff'])
    expect(rows[0]).toMatchObject({
      id: 'staff-2',
      email: 'bo@nwu.test',
      card_uid: 'CARD-2',
      is_active: true,
      uid: null,
      is_admin_account: false,
    })
    expect(typeof rows[0].created_at).toBe('string')
    expect((await listStaff(adminCtx(), { includeAdminAccount: true })).map((s) => s.full_name)).toEqual([
      'Ada Admin',
      'Bo Rrower',
      'Sam Staff',
    ])
  })

  it('the list is admin-only; a staff caller may read only their own row', async () => {
    await expectDataError(listStaff(ctxAs(sam)), 403, 'Only admins can do this.')
    expect(await getStaff(ctxAs(sam), 'staff-1')).toMatchObject({ id: 'staff-1', full_name: 'Sam Staff' })
    await expectDataError(getStaff(ctxAs(sam), 'staff-2'), 403)
    expect(await getStaff(adminCtx(), 'staff-2')).toMatchObject({ id: 'staff-2' })
    expect(await getStaff(adminCtx(), 'nope')).toBeNull()
  })
})

describe('createStaff / updateStaff', () => {
  it('create normalizes the input and writes a create audit entry shaped like the page wrote', async () => {
    const created = await createStaff(adminCtx(), {
      name: ' Tess ',
      surname: ' Ter ',
      email: '  Tess@NWU.test ',
      department: ' Physics ',
      card_uid: ' CARD-9 ',
    })
    expect(created).toMatchObject({
      name: 'Tess',
      surname: 'Ter',
      full_name: 'Tess Ter',
      email: 'tess@nwu.test',
      department: 'Physics',
      card_uid: 'CARD-9',
      is_active: true,
      uid: null,
      is_admin_account: false,
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    })
    expect(created.id).toHaveLength(20)

    const [entry] = await audits()
    expect(entry).toMatchObject({
      user_id: 'admin-uid',
      user_name: 'Ada Admin',
      action: 'create',
      entity_type: 'staff',
      entity_id: created.id,
      before: null,
      after: {
        name: 'Tess',
        surname: 'Ter',
        full_name: 'Tess Ter',
        email: 'tess@nwu.test',
        department: 'Physics',
        card_uid: 'CARD-9',
        is_active: true,
        created_at: NOW.toISOString(),
        updated_at: NOW.toISOString(),
      },
    })
  })

  it('blank email, department and card UID are stored as null; name and surname are required', async () => {
    const created = await createStaff(adminCtx(), { name: 'No', surname: 'Email', email: '  ', department: '', card_uid: '' })
    expect(created).toMatchObject({ email: null, department: null, card_uid: null })
    await expectDataError(createStaff(adminCtx(), { name: ' ', surname: 'X' }), 400)
    await expectDataError(createStaff(adminCtx(), { name: 'X', surname: '' }), 400)
  })

  it('update writes an update audit entry with the before row and the after payload', async () => {
    const updated = await updateStaff(adminCtx(), 'staff-2', {
      name: 'Bob',
      surname: 'Rrower',
      email: 'Bob@nwu.test',
      department: 'Art',
      card_uid: null,
    })
    expect(updated).toMatchObject({ id: 'staff-2', name: 'Bob', full_name: 'Bob Rrower', email: 'bob@nwu.test', card_uid: null })
    const [entry] = await audits()
    expect(entry).toMatchObject({
      action: 'update',
      entity_type: 'staff',
      entity_id: 'staff-2',
      before: { name: 'Bo', surname: 'Rrower', full_name: 'Bo Rrower', email: 'bo@nwu.test', department: null, card_uid: 'CARD-2' },
      after: {
        name: 'Bob',
        surname: 'Rrower',
        full_name: 'Bob Rrower',
        email: 'bob@nwu.test',
        department: 'Art',
        card_uid: null,
        updated_at: NOW.toISOString(),
      },
    })
    expect(entry.after).not.toHaveProperty('auth_email_synced')
  })

  it('update flags auth_email_synced in the after payload when the login email was re-pointed', async () => {
    await updateStaff(adminCtx(), 'staff-1', {
      name: 'Sam',
      surname: 'Staff',
      email: 'sam2@nwu.test',
      department: 'Maths',
      auth_email_synced: true,
    })
    const [entry] = await audits()
    expect(entry.after).toMatchObject({ email: 'sam2@nwu.test', auth_email_synced: true })
  })

  it('a duplicate email in any case is a 409 with today\'s message, on create and on update', async () => {
    await expectDataError(
      createStaff(adminCtx(), { name: 'X', surname: 'Y', email: 'SAM@nwu.TEST' }),
      409,
      'This email is already used by Sam Staff.',
    )
    await expectDataError(
      updateStaff(adminCtx(), 'staff-2', { name: 'Bo', surname: 'Rrower', email: ' Sam@NWU.test' }),
      409,
      'This email is already used by Sam Staff.',
    )
    expect(await audits()).toHaveLength(0)
    // Keeping your own email is not a conflict.
    await updateStaff(adminCtx(), 'staff-2', { name: 'Bo', surname: 'Rrower', email: 'BO@nwu.test' })
  })

  it('findStaffEmailConflict returns the other record, ignores the excluded one and blanks', async () => {
    expect(await findStaffEmailConflict(adminCtx(), 'Sam@NWU.test')).toEqual({ id: 'staff-1', full_name: 'Sam Staff' })
    expect(await findStaffEmailConflict(adminCtx(), 'sam@nwu.test', 'staff-1')).toBeNull()
    expect(await findStaffEmailConflict(adminCtx(), '   ')).toBeNull()
    expect(await findStaffEmailConflict(adminCtx(), 'new@nwu.test')).toBeNull()
    await expectDataError(findStaffEmailConflict(ctxAs(sam), 'x@y.z'), 403)
  })

  it('a card UID already on another staff member is a 409, not a database error', async () => {
    await expectDataError(
      createStaff(adminCtx(), { name: 'X', surname: 'Y', card_uid: 'CARD-2' }),
      409,
      'This card UID is already linked to Bo Rrower.',
    )
  })

  it('update of a missing record is a 404; a staff caller cannot create or update (even themselves)', async () => {
    await expectDataError(updateStaff(adminCtx(), 'nope', { name: 'A', surname: 'B' }), 404, 'Staff record not found.')
    await expectDataError(createStaff(ctxAs(sam), { name: 'A', surname: 'B' }), 403)
    await expectDataError(updateStaff(ctxAs(sam), 'staff-1', { name: 'A', surname: 'B' }), 403)
    await expectDataError(updateStaff(ctxAs(sam), 'staff-2', { name: 'A', surname: 'B' }), 403)
    expect(await audits()).toHaveLength(0)
  })
})

describe('setStaffActive', () => {
  it('deactivate writes a deactivate entry with the same before/after shape the page wrote', async () => {
    const row = await setStaffActive(adminCtx(), 'staff-2', false)
    expect(row).toMatchObject({ id: 'staff-2', is_active: false, updated_at: NOW.toISOString() })
    const [entry] = await audits()
    expect(entry).toMatchObject({
      action: 'deactivate',
      entity_type: 'staff',
      entity_id: 'staff-2',
      before: { is_active: true, name: 'Bo', surname: 'Rrower', full_name: 'Bo Rrower', email: 'bo@nwu.test' },
      after: { is_active: false, name: 'Bo', surname: 'Rrower', full_name: 'Bo Rrower', email: 'bo@nwu.test' },
    })
  })

  it('activate writes an activate entry; staff callers and missing rows are rejected', async () => {
    await setStaffActive(adminCtx(), 'staff-2', false)
    await db.delete(auditLog)
    await setStaffActive(adminCtx(), 'staff-2', true)
    const [entry] = await audits()
    expect(entry).toMatchObject({ action: 'activate', before: { is_active: false }, after: { is_active: true } })
    await expectDataError(setStaffActive(ctxAs(sam), 'staff-1', false), 403)
    await expectDataError(setStaffActive(adminCtx(), 'nope', false), 404, 'Staff record not found.')
  })
})

describe('linkStaffLogin / logResendAccess', () => {
  it('links the uid and writes a grant_access entry with identifying context on both sides', async () => {
    const row = await linkStaffLogin(adminCtx(), 'staff-2', 'bo-uid', 'bo@nwu.test')
    expect(row).toMatchObject({ id: 'staff-2', uid: 'bo-uid' })
    const [entry] = await audits()
    expect(entry).toMatchObject({
      action: 'grant_access',
      entity_type: 'staff',
      entity_id: 'staff-2',
      before: { full_name: 'Bo Rrower', email: 'bo@nwu.test', uid: 'bo-uid' },
      after: { full_name: 'Bo Rrower', email: 'bo@nwu.test', uid: 'bo-uid' },
    })
    const [stored] = await db.select().from(staff).where(eq(staff.id, 'staff-2'))
    expect(stored.uid).toBe('bo-uid')
    expect(stored.updated_at.toISOString()).toBe(NOW.toISOString())
  })

  it('a uid already linked to another staff row is a 409 with today\'s message and writes nothing', async () => {
    await expectDataError(
      linkStaffLogin(adminCtx(), 'staff-2', 'sam-uid', 'bo@nwu.test'),
      409,
      'This email is already linked to another staff record (Sam Staff). Fix the email or contact support before sending a login email.',
    )
    expect(await audits()).toHaveLength(0)
    const [stored] = await db.select().from(staff).where(eq(staff.id, 'staff-2'))
    expect(stored.uid).toBeNull()
  })

  it('re-linking the record\'s own uid is allowed (and still audited)', async () => {
    await linkStaffLogin(adminCtx(), 'staff-1', 'sam-uid')
    const [entry] = await audits()
    expect(entry).toMatchObject({ action: 'grant_access', after: { uid: 'sam-uid', email: 'sam@nwu.test' } })
  })

  it('logResendAccess writes a resend_access entry; the email defaults to the record\'s own', async () => {
    await logResendAccess(adminCtx(), 'staff-1', { email: 'login@nwu.test' })
    await logResendAccess(adminCtx(), 'staff-1')
    const rows = await audits()
    expect(rows.map((r) => r.action)).toEqual(['resend_access', 'resend_access'])
    expect(rows.map((r) => r.after)).toEqual(
      expect.arrayContaining([
        { full_name: 'Sam Staff', email: 'login@nwu.test', uid: 'sam-uid' },
        { full_name: 'Sam Staff', email: 'sam@nwu.test', uid: 'sam-uid' },
      ]),
    )
  })

  it('both are admin-only, and a missing record is a 404', async () => {
    await expectDataError(linkStaffLogin(ctxAs(sam), 'staff-1', 'x'), 403)
    await expectDataError(logResendAccess(ctxAs(sam), 'staff-1'), 403)
    await expectDataError(linkStaffLogin(adminCtx(), 'nope', 'x'), 404)
    await expectDataError(logResendAccess(adminCtx(), 'nope'), 404)
  })

  it('findStaffDocOwningUid (used by the send-reset-email route) reads PostgreSQL', async () => {
    expect(await findStaffDocOwningUid('sam-uid')).toEqual({ id: 'staff-1', full_name: 'Sam Staff' })
    expect(await findStaffDocOwningUid('sam-uid', 'staff-1')).toBeNull()
    expect(await findStaffDocOwningUid('nobody')).toBeNull()
  })
})

describe('updateOwnDetails / syncOwnEmail (My Profile)', () => {
  it('a staff caller (borrower) cannot write their own staff row: 403, row and profile unchanged (spec §4)', async () => {
    await expectDataError(
      updateOwnDetails(ctxAs(sam), { name: 'Samuel', surname: 'Staffer', department: ' Science ', card_uid: 'HACK' }),
      403,
      'Only admins can do this.',
    )
    const [row] = await db.select().from(staff).where(eq(staff.id, 'staff-1'))
    expect(row).toMatchObject({ name: 'Sam', surname: 'Staff', department: 'Maths', card_uid: null })
    const [profile] = await db.select().from(profiles).where(eq(profiles.uid, 'sam-uid'))
    expect(profile.full_name).toBe('Sam Staff')
    expect(await audits()).toHaveLength(0)
  })

  it('requires name and surname, as the page did', async () => {
    await expectDataError(updateOwnDetails(adminCtx(), { name: ' ', surname: 'X' }), 400, 'Name and surname are required.')
  })

  it('an admin with a row updates it, including the card UID, and profiles.full_name follows', async () => {
    const row = await updateOwnDetails(adminCtx(), { name: 'Adaline', surname: 'Admin', department: '', card_uid: ' CARD-A ' })
    expect(row).toMatchObject({
      id: 'admin-row',
      full_name: 'Adaline Admin',
      department: null,
      card_uid: 'CARD-A',
      is_admin_account: true,
      updated_at: NOW.toISOString(),
    })
    const [profile] = await db.select().from(profiles).where(eq(profiles.uid, 'admin-uid'))
    expect(profile.full_name).toBe('Adaline Admin')
    const [other] = await db.select().from(staff).where(eq(staff.id, 'staff-1'))
    expect(other.name).toBe('Sam')
    expect(await audits()).toHaveLength(0) // the page wrote no audit entry for this today
  })

  it('an admin with no row gets their own borrower record created (is_admin_account, with the sign-in email)', async () => {
    await db.delete(staff).where(eq(staff.id, 'admin-row'))
    const row = await updateOwnDetails(adminCtx(), { name: 'Ada', surname: 'Admin', department: 'BICS', email: 'ada@nwu.test' })
    expect(row).toMatchObject({
      name: 'Ada',
      full_name: 'Ada Admin',
      email: 'ada@nwu.test',
      department: 'BICS',
      uid: 'admin-uid',
      is_admin_account: true,
      is_active: true,
    })
    expect(await audits()).toHaveLength(0)
  })

  it('a staff caller with no row cannot create one, and an anonymous caller is refused', async () => {
    await db.delete(staff).where(eq(staff.id, 'staff-1'))
    await expectDataError(updateOwnDetails(ctxAs(sam), { name: 'A', surname: 'B' }), 403)
    await expectDataError(
      updateOwnDetails(ctxAs({ uid: null, name: null, role: 'staff', staffId: null }), { name: 'A', surname: 'B' }),
      403,
    )
    expect(await db.select().from(staff).where(eq(staff.uid, 'sam-uid'))).toHaveLength(0)
  })

  // What Firebase Auth says each uid's email really is.
  let authEmails: Record<string, string> = {}
  beforeEach(() => {
    authEmails = { 'sam-uid': 'New@nwu.test', 'admin-uid': 'Ada.New@nwu.test' }
  })
  const authEmailOf = async (uid: string) => authEmails[uid] ?? null

  it('syncOwnEmail updates the admin\'s own row with their real Auth email (any letter case); another row\'s email is a 409', async () => {
    const row = await syncOwnEmail(adminCtx(), ' ada.new@NWU.test ', authEmailOf)
    expect(row).toMatchObject({ id: 'admin-row', email: 'ada.new@nwu.test', updated_at: NOW.toISOString() })
    authEmails['admin-uid'] = 'BO@nwu.test'
    await expectDataError(syncOwnEmail(adminCtx(), 'BO@nwu.test', authEmailOf), 409, 'This email is already used by Bo Rrower.')
    const [other] = await db.select().from(staff).where(eq(staff.id, 'staff-2'))
    expect(other.email).toBe('bo@nwu.test')
  })

  it('syncOwnEmail refuses an email that is not the caller\'s Auth email (403) and leaves the row unchanged', async () => {
    await expectDataError(syncOwnEmail(adminCtx(), 'anything@else.test', authEmailOf), 403, 'You can only sync your own login email.')
    // Auth knows no email for the caller either: refused.
    await expectDataError(syncOwnEmail(adminCtx(), 'ada.new@nwu.test', async () => null), 403, 'You can only sync your own login email.')
    const [row] = await db.select().from(staff).where(eq(staff.id, 'admin-row'))
    expect(row.email).toBeNull()
    expect(row.updated_at.getTime()).not.toBe(NOW.getTime())
  })

  it('syncOwnEmail from a staff caller (borrower) is 403 even with their real Auth email, and their row is unchanged', async () => {
    await expectDataError(syncOwnEmail(ctxAs(sam), 'new@nwu.test', authEmailOf), 403, 'Only admins can do this.')
    const [row] = await db.select().from(staff).where(eq(staff.id, 'staff-1'))
    expect(row.email).toBe('sam@nwu.test')
  })

  it('syncOwnEmail with no staff row is a no-op (null), like the page when no record was found', async () => {
    await db.delete(staff).where(eq(staff.id, 'admin-row'))
    expect(await syncOwnEmail(adminCtx(), 'ada.new@nwu.test', authEmailOf)).toBeNull()
  })
})

describe('getStaffHoldings', () => {
  async function seedLedger() {
    await db.insert(products).values([
      { id: 'p1', name: 'Projector' },
      { id: 'p2', name: 'Cable' },
      { id: 'p3', name: 'Laptop' },
    ])
    const T = (n: number) => new Date(NOW.getTime() + n * 1000)
    await db.insert(transactions).values([
      { id: 'out1', transaction_type: 'OUT', reference_no: 'R1', staff_id: 'staff-1', lend_to: '2026-10-10', created_at: T(1) },
      { id: 'out2', transaction_type: 'OUT', reference_no: 'R2', staff_id: 'staff-1', lend_to: null, created_at: T(2) },
      { id: 'out3', transaction_type: 'OUT', reference_no: 'R3', staff_id: 'staff-2', lend_to: '2026-10-01', created_at: T(3) },
      { id: 'out4', transaction_type: 'OUT', reference_no: 'R4', staff_id: 'staff-2', lend_to: '2026-11-01', created_at: T(4) },
      { id: 'ret1', transaction_type: 'RETURN', reference_no: 'R5', staff_id: 'staff-1', linked_txn_id: 'out1', created_at: T(5) },
      { id: 'ret3', transaction_type: 'RETURN', reference_no: 'R6', staff_id: 'staff-2', linked_txn_id: 'out3', created_at: T(6) },
      { id: 'ret4', transaction_type: 'RETURN', reference_no: 'R7', staff_id: 'staff-2', linked_txn_id: 'out4', created_at: T(7) },
      { id: 'in1', transaction_type: 'IN', reference_no: 'R8', created_at: T(8) },
    ])
    await db.insert(transactionLines).values([
      { id: 'l1', transaction_id: 'out1', product_id: 'p1', product_name: 'Projector', line_no: 0, quantity: 3, created_at: T(1) },
      { id: 'l2', transaction_id: 'out1', product_id: 'p1', product_name: 'Projector', line_no: 0, quantity: 2, created_at: T(1) },
      { id: 'l3', transaction_id: 'out1', product_id: 'p2', product_name: 'Cable', line_no: 0, quantity: 1, created_at: T(1) },
      { id: 'l4', transaction_id: 'out2', product_id: 'p1', product_name: 'Projector', line_no: 0, quantity: 1, created_at: T(2) },
      { id: 'l5', transaction_id: 'out3', product_id: 'p3', product_name: 'Laptop', line_no: 0, quantity: 1, created_at: T(3) },
      { id: 'l6', transaction_id: 'out4', product_id: 'p3', product_name: 'Laptop', line_no: 0, quantity: 2, created_at: T(4) },
      { id: 'l7', transaction_id: 'ret1', product_id: 'p1', product_name: 'Projector', line_no: 0, quantity: 2, created_at: T(5) },
      { id: 'l8', transaction_id: 'ret3', product_id: 'p3', product_name: 'Laptop', line_no: 0, quantity: 1, created_at: T(6) },
      { id: 'l9', transaction_id: 'ret4', product_id: 'p3', product_name: 'Laptop', line_no: 0, quantity: 1, created_at: T(7) },
      { id: 'l10', transaction_id: 'in1', product_id: 'p1', product_name: 'Projector', line_no: 0, quantity: 9, created_at: T(8) },
    ])
    await db.insert(returnWaivers).values([
      { id: 'w1', transaction_id: 'out1', product_id: 'p2', product_name: 'Cable', staff_id: 'staff-1', quantity: 1 },
      { id: 'w2', transaction_id: 'out4', product_id: 'p3', product_name: 'Laptop', staff_id: 'staff-2', quantity: 2 },
    ])
  }

  it('works out open and written-off items per holder exactly as the Staff page did', async () => {
    await seedLedger()
    const holdings = await getStaffHoldings(adminCtx())
    // staff-1: out1 projector 5 issued - 2 returned = 3 open (due 10 Oct); out1 cable 1 issued, fully written off; out2 projector 1 open, no date.
    expect(holdings['staff-1']).toEqual({
      outstanding: 4,
      items: [
        { key: 'out1_p1_open', txn_id: 'out1', product_id: 'p1', product_name: 'Projector', qty: 3, expected_date: '2026-10-10', waived: false },
        { key: 'out2_p1_open', txn_id: 'out2', product_id: 'p1', product_name: 'Projector', qty: 1, expected_date: null, waived: false },
        { key: 'out1_p2_waived', txn_id: 'out1', product_id: 'p2', product_name: 'Cable', qty: 1, expected_date: '2026-10-10', waived: true },
      ],
    })
    // staff-2: out3 fully returned (nothing); out4 laptop 2 issued, 2 written off, 1 then returned -> the return came
    // out of the written-off quantity, so 1 is still written off and none is open.
    expect(holdings['staff-2']).toEqual({
      outstanding: 0,
      items: [
        { key: 'out4_p3_waived', txn_id: 'out4', product_id: 'p3', product_name: 'Laptop', qty: 1, expected_date: '2026-11-01', waived: true },
      ],
    })
    expect(Object.keys(holdings).sort()).toEqual(['staff-1', 'staff-2'])
  })

  it('is empty with no ledger, and admin-only', async () => {
    expect(await getStaffHoldings(adminCtx())).toEqual({})
    await expectDataError(getStaffHoldings(ctxAs(sam)), 403)
  })

  it('resolveHeldItem writes a waiver and the resolve audit entry; the item then shows as written off', async () => {
    await seedLedger()
    const waiverId = await resolveHeldItem(adminCtx(), 'staff-1', {
      transactionId: 'out1',
      productId: 'p1',
      quantity: 3,
      reason: ' Lost ',
    })
    const [w] = await db.select().from(returnWaivers).where(eq(returnWaivers.id, waiverId))
    expect(w).toMatchObject({
      transaction_id: 'out1',
      product_id: 'p1',
      product_name: 'Projector',
      staff_id: 'staff-1',
      staff_name: 'Sam Staff',
      quantity: 3,
      reason: 'Lost',
      resolved_by_uid: 'admin-uid',
      resolved_by_name: 'Ada Admin',
    })
    const [entry] = await audits()
    expect(entry).toMatchObject({
      action: 'resolve',
      entity_type: 'transaction',
      entity_id: 'out1',
      before: null,
      after: {
        transaction_id: 'out1',
        product_id: 'p1',
        product_name: 'Projector',
        staff_id: 'staff-1',
        staff_name: 'Sam Staff',
        quantity: 3,
        reason: 'Lost',
        resolved_by_uid: 'admin-uid',
        resolved_by_name: 'Ada Admin',
      },
    })
    const holdings = await getStaffHoldings(adminCtx())
    expect(holdings['staff-1'].items.find((i) => i.key === 'out1_p1_waived')).toMatchObject({ qty: 3, waived: true })
    expect(holdings['staff-1'].outstanding).toBe(1)
  })

  it('resolveHeldItem refuses more than is outstanding, a foreign item, and non-admins', async () => {
    await seedLedger()
    await expectDataError(
      resolveHeldItem(adminCtx(), 'staff-1', { transactionId: 'out1', productId: 'p1', quantity: 4 }),
      409,
      'Nothing outstanding to resolve for this item.',
    )
    await expectDataError(
      resolveHeldItem(adminCtx(), 'staff-2', { transactionId: 'out1', productId: 'p1', quantity: 1 }),
      409,
      'Nothing outstanding to resolve for this item.',
    )
    await expectDataError(resolveHeldItem(ctxAs(sam), 'staff-1', { transactionId: 'out1', productId: 'p1', quantity: 1 }), 403)
    expect(await db.select().from(returnWaivers)).toHaveLength(2)
    expect(await audits()).toHaveLength(0)
  })
})

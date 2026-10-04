import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DataError, type Caller, type Ctx } from '@/server/context'
import type { Db } from '@/server/db/client'
import { auditLog, settings } from '@/server/db/schema'
import { getSettingsRow, loadAddress, loadNotificationSettings, saveAddress, setNotificationSetting } from '@/server/data/settings'
import { DEFAULT_NOTIFICATION_SETTINGS } from '@/lib/notificationSettingsRules'
import { closeTestDb, resetTestDb } from '../helpers/db'
import { putNotificationSettings } from '../helpers/settings'

let db: Db

const NOW = new Date('2026-10-04T09:00:00.000Z')
const admin: Caller = { uid: 'admin-uid', name: 'Ada Admin', role: 'admin', staffId: null }
const sam: Caller = { uid: 'sam-uid', name: 'Sam Staff', role: 'staff', staffId: 'staff-1' }
const ctxFor = (caller: Caller = admin): Ctx => ({ db, caller, now: () => NOW })

async function expectDataError(p: Promise<unknown>, status: number, message?: string) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(DataError)
  expect((err as DataError).status).toBe(status)
  if (message !== undefined) expect((err as DataError).message).toBe(message)
}

const audits = () => db.select().from(auditLog).orderBy(auditLog.created_at)

beforeAll(async () => {
  db = await resetTestDb()
})
afterAll(async () => {
  await closeTestDb()
})
beforeEach(async () => {
  await db.delete(auditLog)
  await putNotificationSettings(db, null)
})

describe('getSettingsRow', () => {
  it('returns the stored value, or null when the row has never been saved', async () => {
    expect(await getSettingsRow(db, 'notifications')).toBeNull()
    await putNotificationSettings(db, { admin_notification_email: 'a@nwu.test' })
    expect(await getSettingsRow(db, 'notifications')).toEqual({ admin_notification_email: 'a@nwu.test' })
    expect(await getSettingsRow(db, 'something-else')).toBeNull()
  })
})

describe('loadNotificationSettings', () => {
  it('nothing saved -> the defaults (eleven on, three unbuilt off)', async () => {
    const s = await loadNotificationSettings(ctxFor())
    expect(s).toEqual(DEFAULT_NOTIFICATION_SETTINGS)
    expect(Object.values(s).filter(Boolean)).toHaveLength(11)
  })

  it('a leftover true for an unbuilt email loads as false; every other stored boolean is honoured', async () => {
    await putNotificationSettings(db, {
      loan_request_expired: true,
      overdue_return_alert: true,
      insufficient_pickup_alert: true,
      low_stock_alert: false,
      new_loan_request: 'yes', // not a boolean: falls back to the default
    })
    const s = await loadNotificationSettings(ctxFor())
    expect(s.loan_request_expired).toBe(false)
    expect(s.overdue_return_alert).toBe(false)
    expect(s.insufficient_pickup_alert).toBe(false)
    expect(s.low_stock_alert).toBe(false)
    expect(s.new_loan_request).toBe(true)
  })

  it('is admin only', async () => {
    await expectDataError(loadNotificationSettings(ctxFor(sam)), 403, 'Only admins can do this.')
    await expectDataError(loadAddress(ctxFor(sam), 'admin_notification_email'), 403)
  })
})

describe('setNotificationSetting', () => {
  it('stores the toggle, who changed it, and one audit entry with the label and the value it replaced', async () => {
    await setNotificationSetting(ctxFor(), 'low_stock_alert', false)
    expect((await getSettingsRow(db, 'notifications'))?.low_stock_alert).toBe(false)
    expect(await getSettingsRow(db, 'notifications')).toMatchObject({ updated_by_uid: 'admin-uid', updated_by_name: 'Ada Admin' })
    const [row] = await db.select().from(settings)
    expect(row.updated_at.toISOString()).toBe(NOW.toISOString())

    const log = await audits()
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({
      user_id: 'admin-uid',
      user_name: 'Ada Admin',
      action: 'update',
      entity_type: 'settings',
      entity_id: 'notifications',
      before: { low_stock_alert: true, label: 'Low stock / out of stock alert' },
      after: { low_stock_alert: false, label: 'Low stock / out of stock alert' },
    })
    expect(log[0].created_at.toISOString()).toBe(NOW.toISOString())

    // Switching it back on audits false -> true.
    await setNotificationSetting(ctxFor(), 'low_stock_alert', true)
    expect((await audits())[1]).toMatchObject({
      before: { low_stock_alert: false, label: 'Low stock / out of stock alert' },
      after: { low_stock_alert: true, label: 'Low stock / out of stock alert' },
    })
  })

  it('merges into what is stored: flipping one setting keeps the others', async () => {
    await putNotificationSettings(db, { admin_notification_email: 'a@nwu.test', new_loan_request: false })
    await setNotificationSetting(ctxFor(), 'low_stock_alert', false)
    expect(await getSettingsRow(db, 'notifications')).toMatchObject({
      admin_notification_email: 'a@nwu.test',
      new_loan_request: false,
      low_stock_alert: false,
    })
  })

  it('two toggles saved at the same moment both persist', async () => {
    await Promise.all([
      setNotificationSetting(ctxFor(), 'low_stock_alert', false),
      setNotificationSetting(ctxFor(), 'new_loan_request', false),
      setNotificationSetting(ctxFor(), 'stock_out_confirmation', false),
    ])
    expect(await getSettingsRow(db, 'notifications')).toMatchObject({ low_stock_alert: false, new_loan_request: false, stock_out_confirmation: false })
    expect(await audits()).toHaveLength(3)
  })

  it("refuses to turn on an email that is not built yet, with today's message, saving and auditing nothing", async () => {
    await expectDataError(
      setNotificationSetting(ctxFor(), 'loan_request_expired', true),
      400,
      "Loan request expired isn't implemented yet, so it can't be turned on.",
    )
    await expectDataError(
      setNotificationSetting(ctxFor(), 'overdue_return_alert', true),
      400,
      "Overdue return alert isn't implemented yet, so it can't be turned on.",
    )
    await expectDataError(
      setNotificationSetting(ctxFor(), 'insufficient_pickup_alert', true),
      400,
      "Incoming pickup insufficient stock isn't implemented yet, so it can't be turned on.",
    )
    expect(await getSettingsRow(db, 'notifications')).toBeNull()
    expect(await audits()).toHaveLength(0)
  })

  it('turning an unbuilt email off is allowed (it is already off)', async () => {
    await setNotificationSetting(ctxFor(), 'loan_request_expired', false)
    expect((await audits())[0]).toMatchObject({ before: { loan_request_expired: false }, after: { loan_request_expired: false } })
  })

  it('an unknown key or a non-boolean value -> 400, nothing saved', async () => {
    await expectDataError(setNotificationSetting(ctxFor(), 'nope' as never, true), 400)
    await expectDataError(setNotificationSetting(ctxFor(), '__proto__' as never, true), 400)
    await expectDataError(setNotificationSetting(ctxFor(), 'low_stock_alert', 'false' as never), 400)
    expect(await getSettingsRow(db, 'notifications')).toBeNull()
  })

  it('is admin only, nothing saved for a staff caller', async () => {
    await expectDataError(setNotificationSetting(ctxFor(sam), 'low_stock_alert', false), 403)
    expect(await getSettingsRow(db, 'notifications')).toBeNull()
    expect(await audits()).toHaveLength(0)
  })

  it('the save and its audit entry are one transaction: a failing audit write rolls the save back', async () => {
    await db.execute(sql`create function fail_audit() returns trigger language plpgsql as $$ begin raise exception 'audit down'; end $$`)
    await db.execute(sql`create trigger fail_audit before insert on audit_log for each row execute function fail_audit()`)
    try {
      await expect(setNotificationSetting(ctxFor(), 'low_stock_alert', false)).rejects.toBeTruthy()
      await expect(saveAddress(ctxFor(), 'admin_notification_email', 'a@nwu.test')).rejects.toBeTruthy()
    } finally {
      await db.execute(sql`drop trigger fail_audit on audit_log`)
      await db.execute(sql`drop function fail_audit()`)
    }
    expect(await getSettingsRow(db, 'notifications')).toBeNull()
    expect(await audits()).toHaveLength(0)
  })
})

describe('saveAddress', () => {
  it('saves the trimmed Admin notification address and audits before/after with its label', async () => {
    expect(await saveAddress(ctxFor(), 'admin_notification_email', '  selouna@nwu.test ')).toBe('selouna@nwu.test')
    expect(await loadAddress(ctxFor(), 'admin_notification_email')).toBe('selouna@nwu.test')
    expect(await getSettingsRow(db, 'notifications')).toMatchObject({ updated_by_uid: 'admin-uid', updated_by_name: 'Ada Admin' })
    expect((await audits())[0]).toMatchObject({
      user_id: 'admin-uid',
      action: 'update',
      entity_type: 'settings',
      entity_id: 'notifications',
      before: { admin_notification_email: null, label: 'Admin notification email' },
      after: { admin_notification_email: 'selouna@nwu.test', label: 'Admin notification email' },
    })

    await saveAddress(ctxFor(), 'admin_notification_email', 'jon@nwu.test')
    expect((await audits())[1]).toMatchObject({
      before: { admin_notification_email: 'selouna@nwu.test', label: 'Admin notification email' },
      after: { admin_notification_email: 'jon@nwu.test', label: 'Admin notification email' },
    })
  })

  it('the System sending address is its own field with its own label, and never touches the admin address', async () => {
    await saveAddress(ctxFor(), 'admin_notification_email', 'selouna@nwu.test')
    await saveAddress(ctxFor(), 'system_from_email', 'system@nwu.test')
    expect(await loadAddress(ctxFor(), 'system_from_email')).toBe('system@nwu.test')
    expect(await loadAddress(ctxFor(), 'admin_notification_email')).toBe('selouna@nwu.test')
    expect((await audits())[1]).toMatchObject({
      before: { system_from_email: null, label: 'System sending email' },
      after: { system_from_email: 'system@nwu.test', label: 'System sending email' },
    })
  })

  it('a blank address clears it (stored as null, audited as null) and nothing saved reads as an empty string', async () => {
    expect(await loadAddress(ctxFor(), 'system_from_email')).toBe('')
    await saveAddress(ctxFor(), 'system_from_email', 'system@nwu.test')
    expect(await saveAddress(ctxFor(), 'system_from_email', '   ')).toBe('')
    expect((await getSettingsRow(db, 'notifications'))?.system_from_email).toBeNull()
    expect(await loadAddress(ctxFor(), 'system_from_email')).toBe('')
    expect((await audits())[1]).toMatchObject({
      before: { system_from_email: 'system@nwu.test', label: 'System sending email' },
      after: { system_from_email: null, label: 'System sending email' },
    })
  })

  it('an invalid address -> 400 "Enter a valid email address.", nothing saved or audited', async () => {
    for (const bad of ['nope', 'a@b', 'a b@c.com', '@x.com', 'a@']) {
      await expectDataError(saveAddress(ctxFor(), 'admin_notification_email', bad), 400, 'Enter a valid email address.')
    }
    expect(await getSettingsRow(db, 'notifications')).toBeNull()
    expect(await audits()).toHaveLength(0)
  })

  it('an unknown field -> 400; non-admin -> 403', async () => {
    await expectDataError(saveAddress(ctxFor(), 'updated_by_uid' as never, 'a@b.co'), 400)
    await expectDataError(saveAddress(ctxFor(sam), 'admin_notification_email', 'a@nwu.test'), 403)
    expect(await getSettingsRow(db, 'notifications')).toBeNull()
  })

  it('the stored row is the single `notifications` row', async () => {
    await saveAddress(ctxFor(), 'admin_notification_email', 'a@nwu.test')
    await setNotificationSetting(ctxFor(), 'low_stock_alert', false)
    expect(await db.select().from(settings).where(eq(settings.key, 'notifications'))).toHaveLength(1)
    expect(await db.select().from(settings)).toHaveLength(1)
  })
})

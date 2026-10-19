import 'server-only'
import { eq, sql } from 'drizzle-orm'
import { assertAdmin, DataError, type Ctx } from '@/server/context'
import { withTx, type Db, type Tx } from '@/server/db/client'
import { settings } from '@/server/db/schema'
import { writeAudit } from '@/server/data/audit'
import {
  ADDRESS_LABELS,
  INVALID_ADDRESS_MESSAGE,
  NOTIFICATION_EMAIL_DEFINITIONS,
  NOTIFICATION_SETTINGS_KEY,
  isNotificationKey,
  notificationLabel,
  resolveNotificationSettings,
  storedAddress,
  validatedAddress,
  type AddressField,
} from '@/lib/notificationSettingsRules'
import { DEFAULT_SYSTEM_EMAIL } from '@/lib/notificationCatalog'
import type { NotificationSettingKey } from '@/types/database'

// The notification settings: one `settings` row, key 'notifications', holding one flat object
// ({ <toggle>: boolean, admin_notification_email, system_from_email, updated_by_uid, updated_by_name }).
// Reads and saves are admin only (the Settings page and the Dashboard); the notification routes and the public
// contact route read the row through getSettingsRow on the server.

/** The stored value of one settings row, or null when it has never been saved. */
export async function getSettingsRow(db: Db | Tx, key: string): Promise<Record<string, unknown> | null> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, key)).limit(1)
  return row?.value ?? null
}

/** The 14 toggles as the Settings page shows them (defaults filled in, unbuilt emails always off). */
export async function loadNotificationSettings(ctx: Ctx): Promise<Record<NotificationSettingKey, boolean>> {
  assertAdmin(ctx)
  return resolveNotificationSettings(await getSettingsRow(ctx.db, NOTIFICATION_SETTINGS_KEY))
}

/** One saved address ('' when none is saved). */
export async function loadAddress(ctx: Ctx, field: AddressField): Promise<string> {
  assertAdmin(ctx)
  return storedAddress(await getSettingsRow(ctx.db, NOTIFICATION_SETTINGS_KEY), field)
}

// Merge `patch` into the stored object and return what was stored before. The row is locked first so the "before" in
// the audit entry is the value this save replaced; the merge itself (`value || patch`) is one atomic statement, so
// flipping one setting never clobbers a concurrent change to another.
async function mergeNotificationRow(ctx: Ctx, patch: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const [existing] = await ctx.db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, NOTIFICATION_SETTINGS_KEY))
    .for('update')
  const full = {
    ...patch,
    updated_by_uid: ctx.caller.uid ?? null,
    updated_by_name: ctx.caller.name ?? null,
  }
  await ctx.db
    .insert(settings)
    .values({ key: NOTIFICATION_SETTINGS_KEY, value: full, updated_at: ctx.now() })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: sql`${settings.value} || ${JSON.stringify(full)}::jsonb`, updated_at: ctx.now() },
    })
  return existing?.value ?? null
}

/**
 * Flip exactly one toggle (merged into whatever is already stored) and audit it against the same singleton entity id
 * every time -- 'settings'/'notifications' -- so every change shows up together in the Audit Log. The save and its
 * audit entry commit together. An email that is not built yet cannot be turned on.
 */
export async function setNotificationSetting(ctx: Ctx, key: NotificationSettingKey, value: boolean): Promise<{ key: NotificationSettingKey; value: boolean }> {
  assertAdmin(ctx)
  if (!isNotificationKey(key) || typeof value !== 'boolean') throw new DataError(400, 'Unknown notification setting.')
  const definition = NOTIFICATION_EMAIL_DEFINITIONS.find((d) => d.key === key)
  if (value && definition?.implemented === false) {
    throw new DataError(400, `${definition.label} isn't implemented yet, so it can't be turned on.`)
  }
  await withTx(ctx.db as Db, async (tx) => {
    const txCtx: Ctx = { ...ctx, db: tx }
    const before = await mergeNotificationRow(txCtx, { [key]: value })
    const previous = resolveNotificationSettings(before)[key]
    const label = notificationLabel(key)
    await writeAudit(txCtx, {
      action: 'update',
      entityType: 'settings',
      entityId: NOTIFICATION_SETTINGS_KEY,
      before: { [key]: previous, label },
      after: { [key]: value, label },
    })
  })
  return { key, value }
}

/**
 * Save the Admin notification address or the System sending address ('' clears it) and audit it. An invalid address is
 * refused with the message the Settings form shows inline. Returns the saved (trimmed) address.
 */
export async function saveAddress(ctx: Ctx, field: AddressField, value: string): Promise<string> {
  assertAdmin(ctx)
  if (field !== 'admin_notification_email' && field !== 'system_from_email') throw new DataError(400, 'Unknown setting.')
  const trimmed = validatedAddress(typeof value === 'string' ? value : '')
  if (trimmed === null) throw new DataError(400, INVALID_ADDRESS_MESSAGE)
  await withTx(ctx.db as Db, async (tx) => {
    const txCtx: Ctx = { ...ctx, db: tx }
    const before = await mergeNotificationRow(txCtx, { [field]: trimmed || null })
    const label = ADDRESS_LABELS[field]
    await writeAudit(txCtx, {
      action: 'update',
      entityType: 'settings',
      entityId: NOTIFICATION_SETTINGS_KEY,
      // The old page audited what its field showed before the save: for the sender, the default address when nothing
      // was stored (that is what emails used).
      before: { [field]: storedAddress(before, field) || (field === 'system_from_email' ? DEFAULT_SYSTEM_EMAIL : null), label },
      after: { [field]: trimmed || null, label },
    })
  })
  return trimmed
}

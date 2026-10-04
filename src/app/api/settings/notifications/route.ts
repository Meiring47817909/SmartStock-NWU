import { route } from '@/server/http'
import { DataError } from '@/server/context'
import { loadAddress, loadNotificationSettings, saveAddress, setNotificationSetting } from '@/server/data/settings'
import { INVALID_ADDRESS_MESSAGE } from '@/lib/notificationSettingsRules'
import type { NotificationSettingKey } from '@/types/database'

// Notification settings (admin only).
//   GET  /api/settings/notifications                                 → { [toggle]: boolean }  (defaults filled in)
//   GET  /api/settings/notifications?kind=admin_notification_email   → { value: string }
//   GET  /api/settings/notifications?kind=system_from_email          → { value: string }
//   POST /api/settings/notifications { action: 'toggle', key, value }   → { key, value }   (400 for an email that is not built yet)
//   POST /api/settings/notifications { action: 'address', field, value } → { value }        (400 "Enter a valid email address.")
// Saves are audited by the server in the same transaction.
type Query = { kind?: string }
type Body = { action?: string; key?: NotificationSettingKey; field?: string; value?: unknown }

export const GET = route<Query>('admin', async (ctx, query) => {
  switch (query.kind) {
    case undefined:
    case '':
      return loadNotificationSettings(ctx)
    case 'admin_notification_email':
    case 'system_from_email':
      return { value: await loadAddress(ctx, query.kind) }
    default:
      throw new DataError(400, 'Unknown setting.')
  }
})

export const POST = route<Body>('admin', async (ctx, body) => {
  switch (body.action) {
    case 'toggle':
      return setNotificationSetting(ctx, body.key as NotificationSettingKey, body.value as boolean)
    case 'address': {
      if (body.field !== 'admin_notification_email' && body.field !== 'system_from_email') throw new DataError(400, 'Unknown setting.')
      // Clearing an address sends ''; anything that is not a string (null, a number, an object) is not an address.
      if (typeof body.value !== 'string') throw new DataError(400, INVALID_ADDRESS_MESSAGE)
      return { value: await saveAddress(ctx, body.field, body.value) }
    }
    default:
      throw new DataError(400, 'Unknown action.')
  }
})

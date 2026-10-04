// Browser client for the notification-settings API (admin). The `previous…` and `actor` values are not passed: the server
// reads the value it replaces and writes the audit entry itself, as the signed-in admin.
//
//   GET  /api/settings/notifications[?kind=admin_notification_email|system_from_email]
//   POST /api/settings/notifications { action: 'toggle' | 'address', … }
import { api } from '@/lib/api/client'
import type { NotificationSettingKey } from '@/types/database'
import type { AddressField } from '@/lib/notificationSettingsRules'

export {
  DEFAULT_NOTIFICATION_SETTINGS,
  NOTIFICATION_EMAIL_DEFINITIONS,
  type NotificationEmailDefinition,
} from '@/lib/notificationSettingsRules'

export function loadNotificationSettings(): Promise<Record<NotificationSettingKey, boolean>> {
  return api<Record<NotificationSettingKey, boolean>>('GET', '/api/settings/notifications')
}

async function loadAddress(field: AddressField): Promise<string> {
  return (await api<{ value: string }>('GET', '/api/settings/notifications', { kind: field })).value
}

export function loadAdminNotificationEmail(): Promise<string> {
  return loadAddress('admin_notification_email')
}

// The address every email the system sends comes from (the From header).
// Blank means "use the server's default sender".
export function loadSystemFromEmail(): Promise<string> {
  return loadAddress('system_from_email')
}

// Throws (with the server's message, e.g. "Enter a valid email address.") so the Settings form can show it inline.
async function saveAddress(field: AddressField, value: string): Promise<void> {
  await api('POST', '/api/settings/notifications', { action: 'address', field, value })
}

export function saveAdminNotificationEmail(email: string): Promise<void> {
  return saveAddress('admin_notification_email', email)
}

export function saveSystemFromEmail(email: string): Promise<void> {
  return saveAddress('system_from_email', email)
}

// Flips exactly one toggle, merged into whatever is already stored.
export async function setNotificationSetting(key: NotificationSettingKey, value: boolean): Promise<void> {
  await api('POST', '/api/settings/notifications', { action: 'toggle', key, value })
}

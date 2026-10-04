import { asc } from 'drizzle-orm'
import { sentNotifications, settings } from '@/server/db/schema'
import type { Db } from '@/server/db/client'

/** Store the notification settings object (the one `settings` row, key 'notifications'); `{}` or null leaves it unset. */
export async function putNotificationSettings(db: Db, value: Record<string, unknown> | null): Promise<void> {
  await db.delete(settings)
  if (value) await db.insert(settings).values({ key: 'notifications', value })
}

/** Every sent_notifications marker key, sorted. */
export async function markerKeys(db: Db): Promise<string[]> {
  return (await db.select({ key: sentNotifications.key }).from(sentNotifications).orderBy(asc(sentNotifications.key))).map((r) => r.key)
}

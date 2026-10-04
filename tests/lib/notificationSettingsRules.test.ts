// The pure notification-settings definitions and rules (src/lib/notificationSettingsRules.ts). Port of the scratch harness
// check-settings.mts (5 checks). The harness loaded the settings through a stubbed Firestore document; the stored object
// is now passed to resolveNotificationSettings (and the same cases run through the PostgreSQL-backed
// loadNotificationSettings in tests/server/settings.test.ts).
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  NOTIFICATION_EMAIL_DEFINITIONS,
  resolveNotificationSettings,
  validatedAddress,
} from '@/lib/notificationSettingsRules'
import type { NotificationSettingKey } from '@/types/database'

const UN: NotificationSettingKey[] = ['loan_request_expired', 'overdue_return_alert', 'insufficient_pickup_alert']

describe('notification settings rules', () => {
  it('defaults: three unbuilt off, eleven on', () => {
    for (const [k, v] of Object.entries(DEFAULT_NOTIFICATION_SETTINGS)) assert.equal(v, !UN.includes(k as NotificationSettingKey), k)
  })

  it('definitions carry implemented:false only for the three', () => {
    for (const d of NOTIFICATION_EMAIL_DEFINITIONS) assert.equal(d.implemented === false, UN.includes(d.key), d.key)
  })

  it('the three unbuilt emails say what they need: a scheduled job (cron); built ones carry no such note', () => {
    for (const d of NOTIFICATION_EMAIL_DEFINITIONS) {
      if (UN.includes(d.key)) {
        assert.equal(typeof d.requirement, 'string', d.key)
        assert.match(d.requirement as string, /scheduled/i, d.key)
        assert.match(d.requirement as string, /cron/i, d.key)
      } else {
        assert.equal(d.requirement, undefined, d.key)
      }
    }
  })

  it('a leftover true in the stored settings loads as false for the three, others honoured', () => {
    const s = resolveNotificationSettings({ loan_request_expired: true, overdue_return_alert: true, insufficient_pickup_alert: true, low_stock_alert: false })
    for (const k of UN) assert.equal(s[k], false, k)
    assert.equal(s.low_stock_alert, false)
    assert.equal(s.new_loan_request, true)
  })

  it('no settings saved -> defaults', () => {
    assert.deepEqual(resolveNotificationSettings(null), DEFAULT_NOTIFICATION_SETTINGS)
    assert.deepEqual(resolveNotificationSettings(undefined), DEFAULT_NOTIFICATION_SETTINGS)
    assert.deepEqual(resolveNotificationSettings({}), DEFAULT_NOTIFICATION_SETTINGS)
  })

  // New with the move to the server: the address check the Settings form relies on.
  it('validatedAddress trims, allows blank (clears), and rejects a non-address', () => {
    assert.equal(validatedAddress('  a@b.co '), 'a@b.co')
    assert.equal(validatedAddress('   '), '')
    for (const bad of ['nope', 'a@b', 'a b@c.com', '@x.com']) assert.equal(validatedAddress(bad), null, bad)
  })
})

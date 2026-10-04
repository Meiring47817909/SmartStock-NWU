// Port of the scratch harness check-catalog.mts (4 checks), same assertions.
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { isNotificationImplemented, LOAN_REQUEST_EVENTS, DEFAULT_SYSTEM_EMAIL } from '@/lib/notificationCatalog'
import type { NotificationSettingKey } from '@/types/database'

describe('notification catalog', () => {
  it('three unbuilt keys are not implemented', () => {
    for (const k of ['loan_request_expired', 'overdue_return_alert', 'insufficient_pickup_alert'] as NotificationSettingKey[])
      assert.equal(isNotificationImplemented(k), false, k)
  })

  it('the other eleven are implemented', () => {
    const keys = ['stock_out_confirmation', 'loan_request_approved', 'loan_request_countered', 'loan_request_declined',
      'approved_pickup_cancelled', 'loan_request_counter_accepted', 'loan_request_counter_declined', 'loan_request_withdrawn',
      'new_loan_request', 'incoming_pickup_confirmed', 'low_stock_alert'] as NotificationSettingKey[]
    assert.equal(keys.length, 11)
    assert.ok(keys.every((k) => isNotificationImplemented(k)))
  })

  it('LOAN_REQUEST_EVENTS lists the eight events in order', () => {
    assert.deepEqual([...LOAN_REQUEST_EVENTS], ['new_loan_request', 'loan_request_approved', 'loan_request_countered',
      'loan_request_declined', 'approved_pickup_cancelled', 'loan_request_counter_accepted',
      'loan_request_counter_declined', 'loan_request_withdrawn'])
  })

  it('default system email is the plain address the mailer falls back to', () => {
    assert.equal(DEFAULT_SYSTEM_EMAIL, 'no-reply@smartstock.local')
  })
})

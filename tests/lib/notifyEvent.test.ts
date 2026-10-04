// Port of the scratch harness check-notify-event.mts (7 checks), same assertions. The staff-admin fetch helper and the
// toast are replaced with fakes that record what was called.
import assert from 'node:assert/strict'
import type { User } from 'firebase/auth'
import { beforeEach, describe, it, vi } from 'vitest'

const fb = vi.hoisted(() => ({
  posts: [] as { path: string; uid: string | undefined; body: unknown }[],
  toasts: [] as string[],
  postFail: false,
  postThrow: false,
}))

vi.mock('sonner', () => ({ toast: { error: (message: string) => fb.toasts.push(message), success: () => {} } }))
vi.mock('@/lib/firebase/staff', () => ({
  async postStaffAdmin(path: string, user: { uid?: string } | null, body: unknown) {
    if (fb.postThrow) throw new Error('sync-ish failure')
    fb.posts.push({ path, uid: user?.uid, body })
    if (fb.postFail) throw new Error('Mail server not reachable.')
    return { results: [] }
  },
}))

import { notifyLoanRequestEvent, notifyProductStockChange } from '@/lib/firebase/notifyEvent'

const user = { uid: 'u1' } as unknown as User
const flush = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  fb.posts = []
  fb.toasts = []
  fb.postFail = false
  fb.postThrow = false
})

describe('notify helpers (fire and forget)', () => {
  it('posts { event, requestId } to the loan-request route, without a reason key', async () => {
    const ret = notifyLoanRequestEvent(user, 'loan_request_approved', 'r1')
    await flush()
    assert.equal(ret, undefined)
    assert.deepEqual(fb.posts, [{ path: '/api/notifications/loan-request', uid: 'u1', body: { event: 'loan_request_approved', requestId: 'r1' } }])
    assert.equal(fb.toasts.length, 0)
  })

  it('includes the reason only when it is non-empty, trimmed', async () => {
    notifyLoanRequestEvent(user, 'approved_pickup_cancelled', 'r1', { reason: '  Laptop recalled.  ' })
    notifyLoanRequestEvent(user, 'approved_pickup_cancelled', 'r2', { reason: '   ' })
    notifyLoanRequestEvent(user, 'approved_pickup_cancelled', 'r3', { reason: null })
    await flush()
    assert.deepEqual(fb.posts.map((p) => p.body), [
      { event: 'approved_pickup_cancelled', requestId: 'r1', reason: 'Laptop recalled.' },
      { event: 'approved_pickup_cancelled', requestId: 'r2' },
      { event: 'approved_pickup_cancelled', requestId: 'r3' },
    ])
  })

  it('a rejected request shows exactly one toast and never throws', async () => {
    fb.postFail = true
    assert.doesNotThrow(() => notifyLoanRequestEvent(user, 'new_loan_request', 'r1'))
    await flush()
    assert.deepEqual(fb.toasts, ["Saved, but the email couldn't be sent."])
  })

  it('a helper that throws immediately is also contained (one toast, no throw)', async () => {
    fb.postThrow = true
    assert.doesNotThrow(() => notifyLoanRequestEvent(user, 'new_loan_request', 'r1'))
    await flush()
    assert.deepEqual(fb.toasts, ["Saved, but the email couldn't be sent."])
  })

  it('notifyProductStockChange posts { productId, previousQuantity, previousThreshold } to the product-stock route', async () => {
    const ret = notifyProductStockChange(user, { productId: 'p1', previousQuantity: 10, previousThreshold: 5 })
    await flush()
    assert.equal(ret, undefined)
    assert.deepEqual(fb.posts, [{ path: '/api/notifications/product-stock', uid: 'u1', body: { productId: 'p1', previousQuantity: 10, previousThreshold: 5 } }])
    assert.equal(fb.toasts.length, 0)
  })

  it('notifyProductStockChange: failure -> one toast, never throws; no user -> nothing', async () => {
    fb.postFail = true
    assert.doesNotThrow(() => notifyProductStockChange(user, { productId: 'p1', previousQuantity: 10, previousThreshold: 5 }))
    await flush()
    assert.deepEqual(fb.toasts, ["Saved, but the email couldn't be sent."])
    fb.posts = []
    fb.toasts = []
    fb.postFail = false
    notifyProductStockChange(null, { productId: 'p1', previousQuantity: 10, previousThreshold: 5 })
    await flush()
    assert.equal(fb.posts.length, 0)
  })

  it('no signed-in user -> posts nothing, no toast', async () => {
    notifyLoanRequestEvent(null, 'loan_request_withdrawn', 'r1')
    notifyLoanRequestEvent(undefined, 'loan_request_withdrawn', 'r1')
    await flush()
    assert.equal(fb.posts.length, 0)
    assert.equal(fb.toasts.length, 0)
  })
})

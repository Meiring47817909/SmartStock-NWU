import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api/client', () => ({ api: apiMock }))

import {
  acceptCounter,
  approveAsIs,
  declineCounter,
  declineRequest,
  expireIfNeeded,
  findQuantityReductionConflicts,
  getAcceptedPickups,
  getRequestLines,
  getReservationHolders,
  getReservationIntervals,
  getReservedQuantity,
  listRequests,
  loadLoanRequestsAlertCount,
  loadMyRequestsAlertCount,
  sendCounter,
  submitLoanRequest,
  validateCartDates,
  withdrawRequest,
} from '@/lib/api/loanRequests'

beforeEach(() => apiMock.mockReset())

describe('loan request client', () => {
  it('maps reads onto the routes', async () => {
    apiMock.mockResolvedValue([])
    await listRequests({ staffId: 's1', statuses: ['pending', 'countered'] })
    expect(apiMock).toHaveBeenLastCalledWith('GET', '/api/loan-requests', { staffId: 's1', statuses: 'pending,countered' })
    await listRequests()
    expect(apiMock).toHaveBeenLastCalledWith('GET', '/api/loan-requests', { staffId: undefined, statuses: undefined })
    await getReservationHolders('p1', '2026-10-01', '2026-10-31')
    expect(apiMock).toHaveBeenLastCalledWith('GET', '/api/loan-requests', {
      kind: 'holders', productId: 'p1', fromDate: '2026-10-01', toDate: '2026-10-31', statuses: 'pending,countered,accepted',
    })
    await findQuantityReductionConflicts('p1', 3)
    expect(apiMock).toHaveBeenLastCalledWith('GET', '/api/loan-requests', { kind: 'quantityConflicts', productId: 'p1', quantity: 3 })
    apiMock.mockResolvedValue({ quantity: 4 })
    expect(await getReservedQuantity('p1', '2026-10-01', '2026-10-31', 'r9')).toBe(4)
    expect(apiMock).toHaveBeenLastCalledWith('GET', '/api/loan-requests', { kind: 'reserved', productId: 'p1', fromDate: '2026-10-01', toDate: '2026-10-31', excludeRequestId: 'r9' })
    apiMock.mockResolvedValue({ count: 7 })
    expect(await loadLoanRequestsAlertCount()).toBe(7)
    expect(apiMock).toHaveBeenLastCalledWith('GET', '/api/loan-requests', { kind: 'alertCount' })
    expect(await loadMyRequestsAlertCount()).toBe(7)
    expect(apiMock).toHaveBeenLastCalledWith('GET', '/api/loan-requests', { kind: 'myAlertCount' })
  })

  it('getReservationIntervals returns a Map with an entry for every product asked about', async () => {
    apiMock.mockResolvedValue({ p1: [{ fromDate: 'a', toDate: 'b', quantity: 1 }] })
    const map = await getReservationIntervals(['p1', 'p2'])
    expect([...map.keys()]).toEqual(['p1', 'p2'])
    expect(map.get('p1')).toEqual([{ fromDate: 'a', toDate: 'b', quantity: 1 }])
    expect(map.get('p2')).toEqual([])
    expect(apiMock).toHaveBeenLastCalledWith('GET', '/api/loan-requests', { kind: 'intervals', productIds: 'p1,p2' })
    apiMock.mockClear()
    expect((await getReservationIntervals([])).size).toBe(0)
    expect(apiMock).not.toHaveBeenCalled()
  })

  it("getAcceptedPickups is Stock Out's accepted, not-yet-fulfilled requests of a staff member", async () => {
    apiMock.mockResolvedValue([
      { id: 'r1', fulfilled_txn_id: null },
      { id: 'r2', fulfilled_txn_id: 't1' },
    ])
    expect((await getAcceptedPickups('s1')).map((r) => r.id)).toEqual(['r1'])
    expect(apiMock).toHaveBeenLastCalledWith('GET', '/api/loan-requests', { staffId: 's1', statuses: 'accepted' })
  })

  it('getRequestLines reads the request route', async () => {
    apiMock.mockResolvedValue({ request: { id: 'r1' }, lines: [{ id: 'l1' }] })
    expect(await getRequestLines('r1')).toEqual([{ id: 'l1' }])
    expect(apiMock).toHaveBeenLastCalledWith('GET', '/api/loan-requests/r1')
  })

  it('cart calls send product ids and quantities only', async () => {
    const cart = [{ product: { id: 'p1', name: 'x' }, quantity: 2 }, { product: { id: 7 }, quantity: 1 }]
    apiMock.mockResolvedValue({ valid: true, errors: [] })
    await validateCartDates(cart, '2026-10-10', '2026-10-12')
    expect(apiMock).toHaveBeenLastCalledWith('POST', '/api/loan-requests', {
      action: 'validate', cart: [{ productId: 'p1', quantity: 2 }, { productId: '7', quantity: 1 }], fromDate: '2026-10-10', toDate: '2026-10-12',
    })
    apiMock.mockResolvedValue({ id: 'r1' })
    expect(await submitLoanRequest(cart, '2026-10-10', '', 'hello')).toBe('r1')
    expect(apiMock).toHaveBeenLastCalledWith('POST', '/api/loan-requests', {
      action: 'submit', staffId: undefined, cart: [{ productId: 'p1', quantity: 2 }, { productId: '7', quantity: 1 }], fromDate: '2026-10-10', toDate: null, message: 'hello',
    })
  })

  it('transitions post to the request\'s transition route, by id or by object', async () => {
    apiMock.mockResolvedValue({ id: 'r1', status: 'accepted' })
    await approveAsIs('r1')
    expect(apiMock).toHaveBeenLastCalledWith('POST', '/api/loan-requests/r1/transition', { action: 'approve' })
    await sendCounter({ id: 'r1' }, { lines: [{ lineId: 'l1', product_id: 'p1', offered_quantity: 1 }], fromDate: '2026-10-11', toDate: null, message: 'm' })
    expect(apiMock).toHaveBeenLastCalledWith('POST', '/api/loan-requests/r1/transition', {
      action: 'counter', lines: [{ lineId: 'l1', product_id: 'p1', offered_quantity: 1 }], fromDate: '2026-10-11', toDate: null, message: 'm',
    })
    await declineRequest('r1', 'no')
    expect(apiMock).toHaveBeenLastCalledWith('POST', '/api/loan-requests/r1/transition', { action: 'decline', message: 'no' })
    await acceptCounter('r1')
    expect(apiMock).toHaveBeenLastCalledWith('POST', '/api/loan-requests/r1/transition', { action: 'acceptCounter' })
    await declineCounter('r1')
    expect(apiMock).toHaveBeenLastCalledWith('POST', '/api/loan-requests/r1/transition', { action: 'declineCounter' })
    await withdrawRequest({ id: 'r1' }, 'why')
    expect(apiMock).toHaveBeenLastCalledWith('POST', '/api/loan-requests/r1/transition', { action: 'withdraw', reason: 'why' })
    apiMock.mockResolvedValue({ status: 'no_show' })
    expect(await expireIfNeeded({ id: 'r/1' })).toBe('no_show')
    expect(apiMock).toHaveBeenLastCalledWith('POST', '/api/loan-requests/r%2F1/transition', { action: 'expire' })
  })
})

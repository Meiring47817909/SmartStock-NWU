import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api/client', () => ({ api: apiMock }))

import {
  createReturnWaiver,
  listOutstandingForStaff,
  loadWaivedByTxn,
  loadWaivers,
  recordReturn,
  recordStockIn,
  recordStockOut,
  waivedQty,
} from '@/lib/api/stock'

beforeEach(() => apiMock.mockReset())

describe('stock client', () => {
  it('maps calls onto the routes', async () => {
    apiMock.mockResolvedValue({ id: 't1', reference_no: 'TXN-AAAAAAAA' })
    const items = [{ productId: 'p1', quantity: 1, barcodes: ['A'] }]
    expect(await recordStockIn({ items, notes: 'n' })).toEqual({ id: 't1', reference_no: 'TXN-AAAAAAAA' })
    expect(apiMock).toHaveBeenLastCalledWith('POST', '/api/stock/in', { items, notes: 'n' })
    await recordStockOut({ staffId: 's1', items, lendFrom: '2026-10-04', lendTo: null, manualOverride: true, notes: '', linkedRequestId: 'r1' })
    expect(apiMock).toHaveBeenLastCalledWith('POST', '/api/stock/out', {
      staffId: 's1', items, lendFrom: '2026-10-04', lendTo: null, manualOverride: true, notes: '', linkedRequestId: 'r1',
    })
    await recordReturn({ staffId: 's1', linkedTxnId: 't0', items, notes: 'Return of X' })
    expect(apiMock).toHaveBeenLastCalledWith('POST', '/api/stock/return', { staffId: 's1', linkedTxnId: 't0', items, notes: 'Return of X' })
    await listOutstandingForStaff('s1')
    expect(apiMock).toHaveBeenLastCalledWith('GET', '/api/stock/outstanding', { staffId: 's1' })
    await loadWaivers()
    expect(apiMock).toHaveBeenLastCalledWith('GET', '/api/stock/waivers')
    await loadWaivedByTxn()
    expect(apiMock).toHaveBeenLastCalledWith('GET', '/api/stock/waivers', { kind: 'byTxn' })
  })

  it('createReturnWaiver resolves to the waiver id', async () => {
    apiMock.mockResolvedValue({ id: 'w1' })
    expect(await createReturnWaiver({ transactionId: 't', productId: 'p', quantity: 2, reason: null })).toBe('w1')
    expect(apiMock).toHaveBeenLastCalledWith('POST', '/api/stock/waivers', { transactionId: 't', productId: 'p', quantity: 2, reason: null })
  })

  it('waivedQty reads the map', () => {
    expect(waivedQty({ t: { 'p1': 2 } }, 't', 'p1')).toBe(2)
    expect(waivedQty({ t: { 'p1': 2 } }, 't', 'p2')).toBe(0)
    expect(waivedQty({}, 't', 1)).toBe(0)
  })
})

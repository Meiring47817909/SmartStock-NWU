import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api/client', () => {
  class ClientApiError extends Error {
    status: number
    constructor(status: number, message: string) {
      super(message)
      this.status = status
    }
  }
  return { api: apiMock, ClientApiError }
})

import { ClientApiError } from '@/lib/api/client'
import {
  deleteCategory,
  findBarcodeConflict,
  getProduct,
  listProducts,
  newProductId,
  productDeleteBlockReason,
  updateProduct,
} from '@/lib/api/catalog'

beforeEach(() => apiMock.mockReset())

describe('catalog client', () => {
  it('maps calls onto the routes', async () => {
    apiMock.mockResolvedValue([])
    await listProducts({ availableOnly: true })
    expect(apiMock).toHaveBeenLastCalledWith('GET', '/api/products', { availableOnly: true })
    await listProducts()
    expect(apiMock).toHaveBeenLastCalledWith('GET', '/api/products', undefined)
    await findBarcodeConflict(['a,b', 'c'], 'p1')
    expect(apiMock).toHaveBeenLastCalledWith('GET', '/api/products/lookup', { kind: 'conflict', codes: '["a,b","c"]', excludeId: 'p1' })
    await deleteCategory('c1')
    expect(apiMock).toHaveBeenLastCalledWith('POST', '/api/categories', { action: 'delete', id: 'c1' })
    await updateProduct('p 1', { name: 'x' } as never)
    expect(apiMock).toHaveBeenLastCalledWith('POST', '/api/products/p%201', { action: 'update', product: { name: 'x' } })
  })

  it('getProduct returns null on 404 and rethrows other errors', async () => {
    apiMock.mockRejectedValueOnce(new ClientApiError(404, 'Product not found.'))
    expect(await getProduct('x')).toBeNull()
    apiMock.mockRejectedValueOnce(new ClientApiError(500, 'Something went wrong.'))
    await expect(getProduct('x')).rejects.toThrow('Something went wrong.')
  })

  it('newProductId makes 20-character alphanumeric ids', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newProductId()))
    expect(ids.size).toBe(50)
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9]{20}$/)
  })

  it('re-exports productDeleteBlockReason', () => {
    expect(productDeleteBlockReason({ outstanding: [], reservations: [] })).toBeNull()
    expect(
      productDeleteBlockReason({ outstanding: [{ txnId: 't', staffName: 'Sam', quantity: 1, txnRef: 'R1' }], reservations: [] }),
    ).toBe('Still in use — 1 unit(s) checked out with Sam (R1). Resolve or cancel these first.')
  })
})

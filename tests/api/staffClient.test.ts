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
  createStaff,
  findStaffEmailConflict,
  getStaff,
  listStaff,
  loadStaffHoldings,
  resolveHeldItem,
  setStaffActive,
  syncOwnEmail,
  updateOwnDetails,
  updateStaff,
} from '@/lib/api/staff'

beforeEach(() => apiMock.mockReset())

describe('staff client', () => {
  it('maps calls onto the routes', async () => {
    apiMock.mockResolvedValue([])
    await listStaff()
    expect(apiMock).toHaveBeenLastCalledWith('GET', '/api/staff', undefined)
    await listStaff({ includeAdminAccount: true })
    expect(apiMock).toHaveBeenLastCalledWith('GET', '/api/staff', { includeAdminAccount: true })
    await loadStaffHoldings()
    expect(apiMock).toHaveBeenLastCalledWith('GET', '/api/staff', { kind: 'holdings' })
    await createStaff({ name: 'A', surname: 'B' })
    expect(apiMock).toHaveBeenLastCalledWith('POST', '/api/staff', { action: 'create', name: 'A', surname: 'B' })
    await updateStaff('s 1', { name: 'A', surname: 'B', auth_email_synced: true })
    expect(apiMock).toHaveBeenLastCalledWith('POST', '/api/staff/s%201', {
      action: 'update',
      staff: { name: 'A', surname: 'B', auth_email_synced: true },
    })
    await setStaffActive('s1', false)
    expect(apiMock).toHaveBeenLastCalledWith('POST', '/api/staff/s1', { action: 'setActive', active: false })
    await updateOwnDetails({ name: 'A', surname: 'B' })
    expect(apiMock).toHaveBeenLastCalledWith('POST', '/api/staff', { action: 'updateOwn', name: 'A', surname: 'B' })
    await syncOwnEmail('a@b.c')
    expect(apiMock).toHaveBeenLastCalledWith('POST', '/api/staff', { action: 'syncOwnEmail', email: 'a@b.c' })
  })

  it('resolveHeldItem returns the waiver id', async () => {
    apiMock.mockResolvedValue({ id: 'w1' })
    expect(await resolveHeldItem('s1', { transactionId: 't', productId: 'p', quantity: 2, reason: null })).toBe('w1')
    expect(apiMock).toHaveBeenLastCalledWith('POST', '/api/staff/s1', {
      action: 'resolve',
      transactionId: 't',
      productId: 'p',
      quantity: 2,
      reason: null,
    })
  })

  it('findStaffEmailConflict skips the call for a blank email', async () => {
    expect(await findStaffEmailConflict('   ')).toBeNull()
    expect(apiMock).not.toHaveBeenCalled()
    apiMock.mockResolvedValue({ id: 's2', full_name: 'Bo' })
    expect(await findStaffEmailConflict('bo@nwu.test', 's1')).toEqual({ id: 's2', full_name: 'Bo' })
    expect(apiMock).toHaveBeenLastCalledWith('GET', '/api/staff', { kind: 'emailConflict', email: 'bo@nwu.test', excludeId: 's1' })
  })

  it('getStaff returns null on 404 and rethrows other errors', async () => {
    apiMock.mockRejectedValueOnce(new ClientApiError(404, 'Staff record not found.'))
    expect(await getStaff('x')).toBeNull()
    apiMock.mockRejectedValueOnce(new ClientApiError(403, 'nope'))
    await expect(getStaff('x')).rejects.toThrow('nope')
  })
})

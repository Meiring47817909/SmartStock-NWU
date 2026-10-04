import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api/client', () => ({ api: apiMock }))

import { loadDashboard, loadDashboardAlertCounts } from '@/lib/api/dashboard'

beforeEach(() => apiMock.mockReset())

describe('dashboard client', () => {
  it('maps calls onto the route', async () => {
    apiMock.mockResolvedValue({ outstandingReturns: 1, lowStock: 2, incomingPickups: 3, total: 6 })
    expect(await loadDashboardAlertCounts()).toEqual({ outstandingReturns: 1, lowStock: 2, incomingPickups: 3, total: 6 })
    expect(apiMock).toHaveBeenLastCalledWith('GET', '/api/dashboard', { kind: 'alertCounts' })
    await loadDashboard()
    expect(apiMock).toHaveBeenLastCalledWith('GET', '/api/dashboard')
  })
})

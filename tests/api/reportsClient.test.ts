import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api/client', () => ({ api: apiMock }))

import { loadReport } from '@/lib/api/reports'
import { loadAuditLog } from '@/lib/api/auditLog'

beforeEach(() => apiMock.mockReset())

describe('reports client', () => {
  it('maps a report onto the route, sending only the filters that are set', async () => {
    apiMock.mockResolvedValue([])
    await loadReport('stock-levels')
    expect(apiMock).toHaveBeenLastCalledWith('GET', '/api/reports', { report: 'stock-levels', from: undefined, to: undefined, includeUndated: undefined })
    await loadReport('issued-per-staff', { from: '2026-10-01', to: '', includeUndated: true })
    expect(apiMock).toHaveBeenLastCalledWith('GET', '/api/reports', { report: 'issued-per-staff', from: '2026-10-01', to: undefined, includeUndated: undefined })
    await loadReport('returns', { from: '2026-10-01', to: '2026-10-31', includeUndated: false })
    expect(apiMock).toHaveBeenLastCalledWith('GET', '/api/reports', { report: 'returns', from: '2026-10-01', to: '2026-10-31', includeUndated: 'false' })
  })
})

describe('audit log client', () => {
  it('maps the filters onto the route', async () => {
    apiMock.mockResolvedValue({ entries: [], transactionLines: {}, loanRequestLines: {} })
    await loadAuditLog()
    expect(apiMock).toHaveBeenLastCalledWith('GET', '/api/audit-log', { from: undefined, to: undefined, entityType: undefined, action: undefined, userId: undefined })
    await loadAuditLog({ from: '2026-10-01', to: '2026-10-02', entityType: ['product', 'staff'], action: 'create', userId: 'u1' })
    expect(apiMock).toHaveBeenLastCalledWith('GET', '/api/audit-log', { from: '2026-10-01', to: '2026-10-02', entityType: 'product,staff', action: 'create', userId: 'u1' })
  })
})

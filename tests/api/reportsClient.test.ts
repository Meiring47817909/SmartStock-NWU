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
  const page = (ids: string[], extra: object = {}) => ({
    entries: ids.map((id) => ({ id })),
    transactionLines: {},
    loanRequestLines: {},
    nextCursor: null,
    ...extra,
  })

  it('maps the filters onto the route', async () => {
    apiMock.mockResolvedValue(page([]))
    await loadAuditLog()
    expect(apiMock).toHaveBeenLastCalledWith('GET', '/api/audit-log', { from: undefined, to: undefined, entityType: undefined, action: undefined, userId: undefined, cursor: undefined })
    await loadAuditLog({ from: '2026-10-01', to: '2026-10-02', entityType: ['product', 'staff'], action: 'create', userId: 'u1' })
    expect(apiMock).toHaveBeenLastCalledWith('GET', '/api/audit-log', { from: '2026-10-01', to: '2026-10-02', entityType: 'product,staff', action: 'create', userId: 'u1', cursor: undefined })
  })

  it('follows nextCursor until the last page and combines the pages in order', async () => {
    apiMock
      .mockResolvedValueOnce(page(['a', 'b'], { transactionLines: { t1: [{ id: 'l1' }] }, nextCursor: 'c1' }))
      .mockResolvedValueOnce(page(['c', 'd'], { loanRequestLines: { r1: [{ id: 'q1' }] }, nextCursor: 'c2' }))
      .mockResolvedValueOnce(page(['e'], { transactionLines: { t2: [] } }))
    const result = await loadAuditLog({ from: '2026-10-01' })
    expect(apiMock).toHaveBeenCalledTimes(3)
    expect(apiMock.mock.calls.map((c) => c[2].cursor)).toEqual([undefined, 'c1', 'c2'])
    expect(apiMock.mock.calls.every((c) => c[2].from === '2026-10-01')).toBe(true) // the filters ride along on every page
    expect(result).toEqual({
      entries: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }],
      transactionLines: { t1: [{ id: 'l1' }], t2: [] },
      loanRequestLines: { r1: [{ id: 'q1' }] },
    })
  })

  it('stops at the first error and rejects', async () => {
    apiMock.mockResolvedValueOnce(page(['a'], { nextCursor: 'c1' })).mockRejectedValueOnce(new Error('Something went wrong.'))
    await expect(loadAuditLog()).rejects.toThrow('Something went wrong.')
    expect(apiMock).toHaveBeenCalledTimes(2)
  })
})

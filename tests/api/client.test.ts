import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const authMock = vi.hoisted(() => ({ currentUser: null as null | { getIdToken: () => Promise<string> } }))
vi.mock('@/lib/firebase/config', () => ({ auth: authMock }))

import { api } from '@/lib/api/client'

const fetchMock = vi.fn()

function jsonResponse(status: number, data: unknown) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  authMock.currentUser = null
})
afterEach(() => vi.unstubAllGlobals())

describe('api()', () => {
  it('sends the Bearer token when signed in', async () => {
    authMock.currentUser = { getIdToken: async () => 'tok-123' }
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }))
    const out = await api<{ ok: boolean }>('POST', '/api/things', { a: 1 })
    expect(out).toEqual({ ok: true })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/things')
    expect(init.method).toBe('POST')
    expect(init.headers.authorization).toBe('Bearer tok-123')
    expect(init.headers['content-type']).toBe('application/json')
    expect(init.body).toBe(JSON.stringify({ a: 1 }))
  })

  it('sends no Authorization header when signed out', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, []))
    await api('GET', '/api/products')
    const [, init] = fetchMock.mock.calls[0]
    expect(init.headers.authorization).toBeUndefined()
    expect(init.body).toBeUndefined()
  })

  it('turns a GET body into a query string, skipping empty values', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, []))
    await api('GET', '/api/products', { q: 'a b', page: 2, none: undefined, nul: null, on: true })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/products?q=a+b&page=2&on=true')
    expect(init.body).toBeUndefined()
  })

  it('appends to a path that already has a query string', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, []))
    await api('GET', '/api/x?z=1', { a: 'b' })
    expect(fetchMock.mock.calls[0][0]).toBe('/api/x?z=1&a=b')
  })

  it('throws the server message with .status on a non-2xx response', async () => {
    fetchMock.mockResolvedValue(jsonResponse(409, { error: 'Barcode already used.' }))
    await expect(api('POST', '/api/products', {})).rejects.toMatchObject({ message: 'Barcode already used.', status: 409 })
  })

  it('throws a generic message with .status when the error body is not JSON', async () => {
    fetchMock.mockResolvedValue(new Response('<html>bad gateway</html>', { status: 502 }))
    const err: unknown = await api('GET', '/api/x').catch((e: unknown) => e)
    expect(err).toMatchObject({ status: 502, message: 'Request failed (502).' })
    expect(err).toBeInstanceOf(Error)
  })
})

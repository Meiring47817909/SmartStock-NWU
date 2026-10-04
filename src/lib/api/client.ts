import { auth } from '@/lib/firebase/config'

/** An error response from our own API: the server's message plus the HTTP status. */
export class ClientApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

function withQuery(path: string, params: unknown): string {
  if (!params || typeof params !== 'object') return path
  const qs = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue
    qs.append(key, String(value))
  }
  const text = qs.toString()
  if (!text) return path
  return path + (path.includes('?') ? '&' : '?') + text
}

/** Call one of our /api routes, signed with the current Firebase ID token (if anyone is signed in). */
export async function api<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {}
  const token = await auth.currentUser?.getIdToken()
  if (token) headers.authorization = `Bearer ${token}`

  let url = path
  let payload: string | undefined
  if (method === 'GET') {
    url = withQuery(path, body)
  } else if (body !== undefined) {
    headers['content-type'] = 'application/json'
    payload = JSON.stringify(body)
  }

  const res = await fetch(url, { method, headers, body: payload })
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    const message = typeof data?.error === 'string' && data.error ? data.error : `Request failed (${res.status}).`
    throw new ClientApiError(res.status, message)
  }
  return data as T
}

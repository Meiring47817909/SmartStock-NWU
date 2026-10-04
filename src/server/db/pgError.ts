import 'server-only'

/** The PostgreSQL error behind a driver/Drizzle error (Drizzle wraps the driver's error in `cause`), or null. */
export function pgError(err: unknown): { code?: string; constraint?: string; detail?: string } | null {
  let cur: unknown = err
  for (let i = 0; i < 4 && cur && typeof cur === 'object'; i++) {
    const e = cur as { code?: unknown; constraint?: string; detail?: string; cause?: unknown }
    if (typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code)) return { code: e.code, constraint: e.constraint, detail: e.detail }
    cur = e.cause
  }
  return null
}

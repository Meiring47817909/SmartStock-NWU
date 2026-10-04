import 'server-only'
import { and, gte, lte, sql, type SQL } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { DataError } from '@/server/context'
import { APP_TIME_ZONE } from '@/lib/utils'

// Date filters on the Reports and Audit Log pages pick calendar days. A timestamp belongs to the day it was on the wall
// clock in APP_TIME_ZONE (Africa/Johannesburg), not the UTC day it is stored under and not the zone of the server or
// the database session: an entry written at 23:30 UTC is 01:30 the next day in Johannesburg. The zone is passed
// explicitly, so the answer is the same on Vercel (UTC), Cloud SQL (UTC) and a laptop.

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/** A YYYY-MM-DD calendar day, or `undefined` for a blank filter. Anything else is a 400. */
export function parseDay(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || !DAY_PATTERN.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new DataError(400, `${label} must be a date (YYYY-MM-DD).`)
  }
  return value
}

/** The Johannesburg calendar day of a timestamptz column, as a `date`. */
export const appDay = (column: AnyPgColumn): SQL => sql`(${column} at time zone ${APP_TIME_ZONE})::date`

/** `from <= day <= to` (both ends inclusive, either may be blank) on a timestamptz column's Johannesburg day. */
export function appDayBetween(column: AnyPgColumn, from?: string, to?: string): SQL | undefined {
  const day = appDay(column)
  return and(
    from ? gte(day, sql`${from}::date`) : undefined,
    to ? lte(day, sql`${to}::date`) : undefined,
  )
}

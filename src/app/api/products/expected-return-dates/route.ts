import 'server-only'
import { NextRequest, NextResponse } from 'next/server'
import { requireSignedIn, ApiError } from '@/lib/server/staffAdmin'
import { getExpectedReturnDates } from '@/lib/server/availability'

/**
 * Returns the earliest expected-return date for each requested product id
 * that's currently outstanding on an OUT transaction — used by the portal
 * Browse page to show a sold-out product as "Unavailable — back {date}"
 * instead of just hiding it. Runs with Admin SDK privileges because the
 * underlying data (transactions) is admin-only in firestore.rules; any
 * signed-in user (BICS or portal) can call this endpoint, but it only ever
 * returns a single date per product, never the underlying transaction/staff
 * details.
 *
 * Body: { productIds: string[] }
 */
export async function POST(request: NextRequest) {
  try {
    await requireSignedIn(request)

    const body = await request.json().catch(() => null)
    const productIds = Array.isArray(body?.productIds)
      ? body.productIds.filter((id: unknown): id is string => typeof id === 'string')
      : []

    const expectedReturn = await getExpectedReturnDates(productIds)
    return NextResponse.json({ expectedReturn })
  } catch (err) {
    if (err instanceof ApiError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    console.error('expected-return-dates failed:', err)
    return NextResponse.json({ error: 'Failed to compute expected return dates.' }, { status: 500 })
  }
}

import 'server-only'
import { NextResponse } from 'next/server'
import { getRouteDb } from '@/server/context'
import { getSettingsRow } from '@/server/data/settings'
import { NOTIFICATION_SETTINGS_KEY } from '@/lib/notificationSettingsRules'
import { safeAddress } from '@/lib/server/notificationDelivery'

// Always read fresh: a change under Settings -> Notifications must show on the
// next page load.
export const dynamic = 'force-dynamic'

/**
 * The contact email for the login screen and the lending portal: the "Admin
 * notification address" from Settings -> Notifications. Public on purpose
 * (signed-out visitors need it) and returns only that one address, never the
 * rest of the settings. Anything that is not a plain email address,
 * or nothing saved yet, is returned as an empty string; the page then shows its
 * built-in fallback.
 */
export async function GET() {
  try {
    const row = await getSettingsRow(getRouteDb(), NOTIFICATION_SETTINGS_KEY)
    const email = safeAddress(row?.admin_notification_email) ?? ''
    return NextResponse.json({ email }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    console.error('contact email lookup failed:', err)
    return NextResponse.json({ error: 'Could not load the contact email.' }, { status: 500 })
  }
}

import 'server-only'
import { createHash } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { adminAuth } from '@/lib/firebase/admin'
import { getRouteDb } from '@/server/context'
import { isMailEnabled } from '@/lib/server/mailer'
import { passwordResetEmail } from '@/lib/server/emailTemplates'
import { claimNotificationMarker, releaseNotificationMarker, safeAddress } from '@/lib/server/notificationDelivery'
import { ApiError } from '@/lib/server/staffAdmin'
import { appActionLink, isUnknownAccountError, sendAccountEmail } from '@/lib/server/accountEmail'

// A person can ask for one reset email per address per minute; asking again
// inside that minute is answered "sent" without sending another.
const COOLDOWN_MS = 60_000

/**
 * "Forgot password" for anyone, signed in or not. With the mailer on
 * (MAIL_TRANSPORT=smtp) the reset link is built here and sent through it, so
 * it lands in Mailpit. With it off the answer is { sent: false, reason:
 * 'mail_disabled' } and the page falls back to Firebase's own email.
 *
 * The answer never says whether the address has an account.
 *
 * Body: { email: string }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null)
    const email = typeof body?.email === 'string' ? safeAddress(body.email.trim().toLowerCase()) : undefined
    if (!email) throw new ApiError(400, 'Enter a valid email address.')

    if (!isMailEnabled()) return NextResponse.json({ sent: false, reason: 'mail_disabled' })

    let link: string
    try {
      link = await adminAuth.generatePasswordResetLink(email)
    } catch (err) {
      if (isUnknownAccountError(err)) return NextResponse.json({ sent: true })
      throw err
    }

    const entity = `${createHash('sha256').update(email).digest('hex').slice(0, 32)}__${Math.floor(Date.now() / COOLDOWN_MS)}`
    const db = getRouteDb()
    const markerKey = `password_reset__${entity}`
    // Already asked inside this minute: answered "sent" without sending another.
    if (!(await claimNotificationMarker(db, markerKey, 'password_reset'))) return NextResponse.json({ sent: true })

    try {
      await sendAccountEmail(email, passwordResetEmail({ link: appActionLink(link) }))
    } catch (err) {
      await releaseNotificationMarker(db, markerKey)
      throw err
    }
    return NextResponse.json({ sent: true })
  } catch (err) {
    if (err instanceof ApiError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    console.error('forgot-password failed:', err)
    return NextResponse.json({ error: 'Failed to send reset email.' }, { status: 500 })
  }
}

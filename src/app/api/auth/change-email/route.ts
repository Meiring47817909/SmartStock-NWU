import 'server-only'
import { NextRequest, NextResponse } from 'next/server'
import { adminAuth } from '@/lib/firebase/admin'
import { isMailEnabled } from '@/lib/server/mailer'
import { changeEmailEmail } from '@/lib/server/emailTemplates'
import { safeAddress } from '@/lib/server/notificationDelivery'
import { ApiError, assertAdmin, requireRecentSignIn } from '@/lib/server/staffAdmin'
import { appActionLink, isUnknownAccountError, sendAccountEmail } from '@/lib/server/accountEmail'

// The profile page re-checks the current password right before calling this,
// which refreshes the sign-in time the server checks here.
const MAX_SIGN_IN_AGE_SECONDS = 300

/**
 * Sends the "confirm your new email" link for the signed-in administrator's
 * own login. The link goes to the NEW address through the mailer (Mailpit);
 * the login email only changes once it is clicked. With the mailer off the
 * answer is { sent: false, reason: 'mail_disabled' } and the page falls back
 * to Firebase's own email.
 *
 * Body: { newEmail: string }
 */
export async function POST(request: NextRequest) {
  try {
    const { uid } = await requireRecentSignIn(request, MAX_SIGN_IN_AGE_SECONDS)
    await assertAdmin(uid, 'Only administrators can change their login email here.')

    const body = await request.json().catch(() => null)
    const newEmail = typeof body?.newEmail === 'string' ? safeAddress(body.newEmail.trim().toLowerCase()) : undefined
    if (!newEmail) throw new ApiError(400, 'Enter a valid email address.')

    if (!isMailEnabled()) return NextResponse.json({ sent: false, reason: 'mail_disabled' })

    const account = await adminAuth.getUser(uid)
    const currentEmail = account.email
    if (!currentEmail) throw new ApiError(400, 'This account has no login email to change.')
    if (currentEmail.toLowerCase() === newEmail) throw new ApiError(400, 'That is already your login email.')

    try {
      const existing = await adminAuth.getUserByEmail(newEmail)
      if (existing.uid !== uid) throw new ApiError(409, 'This email is already used by another account.')
    } catch (err) {
      if (err instanceof ApiError) throw err
      if (!isUnknownAccountError(err)) throw err
    }

    const link = await adminAuth.generateVerifyAndChangeEmailLink(currentEmail, newEmail)
    await sendAccountEmail(newEmail, changeEmailEmail({ newEmail, link: appActionLink(link) }))
    return NextResponse.json({ sent: true })
  } catch (err) {
    if (err instanceof ApiError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    console.error('change-email failed:', err)
    return NextResponse.json({ error: 'Failed to send confirmation email.' }, { status: 500 })
  }
}

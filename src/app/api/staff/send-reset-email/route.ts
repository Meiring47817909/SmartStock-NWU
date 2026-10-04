import 'server-only'
import { NextRequest, NextResponse } from 'next/server'
import { adminAuth, adminDb } from '@/lib/firebase/admin'
import { auth as clientAuth } from '@/lib/firebase/config'
import { sendPasswordResetEmail } from 'firebase/auth'
import { ApiError, requireAdmin, findStaffDocOwningUid } from '@/lib/server/staffAdmin'
import { isMailEnabled, sendMail, MailUnreachableError, MailConfigError } from '@/lib/server/mailer'
import { loginEmail } from '@/lib/server/emailTemplates'
import { systemFromAddress } from '@/lib/server/notificationDelivery'
import { appActionLink } from '@/lib/server/accountEmail'

// Sends the "set your password" email. With the mailer on (local emulator
// testing, MAIL_TRANSPORT=smtp) we build the reset link ourselves and send our
// own email, so it lands in Mailpit; otherwise Firebase's built-in email flow
// is used exactly as before.
async function deliverLoginEmail(email: string, name: string): Promise<void> {
  if (!isMailEnabled()) {
    await sendPasswordResetEmail(clientAuth, email)
    return
  }
  try {
    const link = await adminAuth.generatePasswordResetLink(email)
    const { subject, html, text } = loginEmail({ name, link: appActionLink(link) })
    await sendMail({ to: email, subject, html, text, from: await systemFromAddress() })
  } catch (err) {
    if (err instanceof MailUnreachableError) {
      throw new ApiError(502, 'Mail server not reachable. Is Mailpit running? (npm run mailpit)')
    }
    if (err instanceof MailConfigError) {
      throw new ApiError(500, err.message)
    }
    throw err
  }
}

/**
 * Provisions (if needed) and (re)sends a "set your password" email for a
 * staff member's lending-portal login. Safe to call any number of times —
 * see the handout ("Staff login — resolved auth model") for the full
 * decision tree this implements.
 *
 * Body: { staffId: string } — the Firestore document ID in `staff`.
 */
export async function POST(request: NextRequest) {
  try {
    await requireAdmin(request)

    const body = await request.json().catch(() => null)
    const staffId = typeof body?.staffId === 'string' ? body.staffId : null
    if (!staffId) {
      throw new ApiError(400, 'Missing staffId.')
    }

    const staffRef = adminDb.collection('staff').doc(staffId)
    const staffSnap = await staffRef.get()
    if (!staffSnap.exists) {
      throw new ApiError(404, 'Staff record not found.')
    }
    const staffData = staffSnap.data()!
    const existingUid: string | undefined = staffData.uid || undefined
    const displayName: string = staffData.name || staffData.full_name || 'there'

    // 1. Already linked — this record is confirmedly tied to an Auth
    // account. Resend to whatever email that account actually has, not
    // necessarily staffData.email (they could theoretically differ if
    // something updated one without the other — see update-email route).
    if (existingUid) {
      let linkedUser
      try {
        linkedUser = await adminAuth.getUser(existingUid)
      } catch {
        // The linked UID no longer exists in Auth (deleted outside this
        // app). Fall through and re-provision as if uid had never been set.
        linkedUser = null
      }
      if (linkedUser?.email) {
        await deliverLoginEmail(linkedUser.email, displayName)
        return NextResponse.json({ linked: false, email: linkedUser.email, uid: linkedUser.uid })
      }
    }

    // 2. Not linked (or the link was stale) — need an email to work with.
    const rawEmail: string | undefined = staffData.email || undefined
    if (!rawEmail) {
      throw new ApiError(400, 'This staff member has no email on file.')
    }
    const email = rawEmail.trim().toLowerCase()

    let authUser
    try {
      authUser = await adminAuth.getUserByEmail(email)
    } catch {
      authUser = null
    }

    if (!authUser) {
      // 3. No account exists for this email — create one. No password is
      // ever set; the reset email IS the "set your password" step.
      const created = await adminAuth.createUser({ email })
      await staffRef.update({ uid: created.uid, updated_at: new Date().toISOString() })
      await deliverLoginEmail(email, displayName)
      return NextResponse.json({ linked: true, email, uid: created.uid })
    }

    // 4. An account already exists for this email — this is the case that
    // needs the ownership check before touching anything.
    const conflict = await findStaffDocOwningUid(authUser.uid, staffId)
    if (conflict) {
      throw new ApiError(
        409,
        `This email is already linked to another staff record (${conflict.full_name}). Fix the email or contact support before sending a login email.`,
      )
    }

    // No other staff record claims this account (or this one already
    // does) — safe to (re)link and send.
    if (staffData.uid !== authUser.uid) {
      await staffRef.update({ uid: authUser.uid, updated_at: new Date().toISOString() })
    }
    await deliverLoginEmail(email, displayName)
    return NextResponse.json({ linked: true, email, uid: authUser.uid })
  } catch (err) {
    if (err instanceof ApiError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    console.error('send-reset-email failed:', err)
    return NextResponse.json({ error: 'Failed to send login email.' }, { status: 500 })
  }
}

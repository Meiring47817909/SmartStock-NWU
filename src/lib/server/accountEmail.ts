import 'server-only'
import { sendMail, MailUnreachableError, MailConfigError } from '@/lib/server/mailer'
import type { RenderedEmail } from '@/lib/server/emailTemplates'
import { systemFromAddress } from '@/lib/server/notificationDelivery'
import { ApiError } from '@/lib/server/staffAdmin'

// Shared by the account-email routes (forgot password, change email). These
// are sign-in security emails, not notifications: no Settings toggle, always
// sent from the System emails address when mail is on.

// Sends one account email through the mailer. A mail server problem becomes
// an ApiError the route turns into a normal JSON error response.
export async function sendAccountEmail(to: string, email: RenderedEmail): Promise<void> {
  try {
    await sendMail({ to, subject: email.subject, html: email.html, text: email.text, from: await systemFromAddress() })
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

// Firebase Admin reports "no account for this email" under either code.
export function isUnknownAccountError(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code
  return code === 'auth/user-not-found' || code === 'auth/email-not-found'
}

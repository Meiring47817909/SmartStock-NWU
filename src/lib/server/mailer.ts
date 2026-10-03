import 'server-only'
import nodemailer from 'nodemailer'

// Env-switched SMTP mailer. Nothing is sent unless MAIL_TRANSPORT=smtp, which
// only the `dev:emulators` script sets (pointing at a local Mailpit). With it
// unset, sendMail() is a no-op, so production behaviour is unchanged.
//
// This module deliberately has no `@/` imports so it can be exercised in
// isolation.

export interface MailMessage {
  to: string
  subject: string
  html: string
  text: string
  // Overrides MAIL_FROM for this message (the system address saved on the
  // Settings -> Notifications page).
  from?: string
}

export interface SmtpConfig {
  host: string
  port: number
  from: string
}

// Bad SMTP_PORT, or the local-only guard refusing a non-local SMTP_HOST.
export class MailConfigError extends Error {}
// The SMTP server could not be reached (refused or timed out).
export class MailUnreachableError extends Error {}

const DEFAULT_FROM = 'SmartStock NWU <no-reply@smartstock.local>'
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
const UNREACHABLE_CODES = new Set(['ECONNECTION', 'ETIMEDOUT', 'ESOCKET'])

export function isMailEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MAIL_TRANSPORT === 'smtp'
}

export function resolveSmtpConfig(env: NodeJS.ProcessEnv = process.env): SmtpConfig {
  const host = env.SMTP_HOST?.trim() || '127.0.0.1'
  const rawPort = env.SMTP_PORT?.trim() || '1025'
  if (!/^\d+$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535) {
    throw new MailConfigError(`SMTP_PORT must be a number between 1 and 65535 (got "${rawPort}").`)
  }

  // Local-only guard: while the Firebase emulators are active the data is
  // seeded with real-looking gmail addresses, so a non-local SMTP host could
  // deliver real mail to real inboxes. Refuse outright.
  const emulated = !!env.FIREBASE_AUTH_EMULATOR_HOST || !!env.FIRESTORE_EMULATOR_HOST
  if (emulated && !LOCAL_HOSTS.has(host)) {
    throw new MailConfigError(
      `Refusing to send mail to "${host}" while the Firebase emulators are active. Use 127.0.0.1 (Mailpit).`,
    )
  }

  return { host, port: Number(rawPort), from: env.MAIL_FROM?.trim() || DEFAULT_FROM }
}

// Resolves true once the SMTP server accepted the message, false when mail is
// disabled (nothing sent, no connection attempted).
export async function sendMail(msg: MailMessage, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (!isMailEnabled(env)) return false

  const { host, port, from } = resolveSmtpConfig(env)
  const transport = nodemailer.createTransport({
    host,
    port,
    secure: false,
    ignoreTLS: true,
    connectionTimeout: 4000,
    greetingTimeout: 4000,
  })
  try {
    await transport.sendMail({ from: msg.from ?? from, to: msg.to, subject: msg.subject, html: msg.html, text: msg.text })
    return true
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code && UNREACHABLE_CODES.has(code)) {
      throw new MailUnreachableError(`Could not reach the mail server at ${host}:${port}.`)
    }
    throw err
  } finally {
    transport.close()
  }
}

import 'server-only'
import nodemailer from 'nodemailer'
import { DEFAULT_SYSTEM_EMAIL } from '@/lib/notificationCatalog'

// Env-switched SMTP mailer. Nothing is sent unless MAIL_TRANSPORT=smtp; with it
// unset, sendMail() is a no-op. Locally `dev:emulators` points it at Mailpit.
// A hosted server (a Mailtrap sandbox for demos, or the client's own server)
// is set with SMTP_HOST / SMTP_PORT plus MAIL_USERNAME / MAIL_PASSWORD, and
// must encrypt: STARTTLS is required, or TLS from the start on port 465.
// Only a local Mailpit may use a plain connection.
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
  // 'none' only for a local Mailpit; 'tls' = encrypted from the start (465);
  // 'starttls' = the connection must be upgraded before logging in or sending.
  security: 'none' | 'tls' | 'starttls'
  auth?: { user: string; pass: string }
}

// Bad SMTP_PORT, half a login, a rejected login, or the local-only guard
// refusing a non-local SMTP_HOST.
export class MailConfigError extends Error {}
// The SMTP server could not be reached (refused or timed out).
export class MailUnreachableError extends Error {}

const DEFAULT_FROM = `SmartStock NWU <${DEFAULT_SYSTEM_EMAIL}>`
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

  const user = env.MAIL_USERNAME?.trim() ?? ''
  const pass = env.MAIL_PASSWORD?.trim() ? (env.MAIL_PASSWORD as string) : ''
  if (!!user !== !!pass) {
    throw new MailConfigError('Set both MAIL_USERNAME and MAIL_PASSWORD, or neither.')
  }

  const port = Number(rawPort)
  const security: SmtpConfig['security'] = LOCAL_HOSTS.has(host) ? 'none' : port === 465 ? 'tls' : 'starttls'
  return {
    host,
    port,
    from: env.MAIL_FROM?.trim() || DEFAULT_FROM,
    security,
    ...(user ? { auth: { user, pass } } : {}),
  }
}

// Nodemailer options for a resolved config. A remote server gets longer
// timeouts (it is reached over the internet); a local Mailpit fails fast.
export function transportOptions(config: SmtpConfig) {
  const timeout = config.security === 'none' ? 4000 : 10000
  return {
    host: config.host,
    port: config.port,
    secure: config.security === 'tls',
    requireTLS: config.security === 'starttls',
    ignoreTLS: config.security === 'none',
    ...(config.auth ? { auth: config.auth } : {}),
    connectionTimeout: timeout,
    greetingTimeout: timeout,
  }
}

// Resolves true once the SMTP server accepted the message, false when mail is
// disabled (nothing sent, no connection attempted).
export async function sendMail(msg: MailMessage, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (!isMailEnabled(env)) return false

  const config = resolveSmtpConfig(env)
  const { host, port, from } = config
  const transport = nodemailer.createTransport(transportOptions(config))
  try {
    await transport.sendMail({ from: msg.from ?? from, to: msg.to, subject: msg.subject, html: msg.html, text: msg.text })
    return true
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code && UNREACHABLE_CODES.has(code)) {
      throw new MailUnreachableError(`Could not reach the mail server at ${host}:${port}.`)
    }
    if (code === 'EAUTH') {
      throw new MailConfigError(`The mail server at ${host} rejected the login. Check MAIL_USERNAME and MAIL_PASSWORD.`)
    }
    throw err
  } finally {
    transport.close()
  }
}

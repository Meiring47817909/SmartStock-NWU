import type { AddressInfo } from 'node:net'
import { simpleParser, type ParsedMail } from 'mailparser'
import { SMTPServer } from 'smtp-server'

/** A throwaway local SMTP server that parses every message it receives into `sent`. Port 0 = any free port. */
export interface MailSink {
  port: number
  sent: ParsedMail[]
  close(): Promise<void>
}

export function listen(server: SMTPServer, host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve) => server.listen(0, host, () => resolve((server.server.address() as AddressInfo).port)))
}

export const closeServer = (server: SMTPServer) => new Promise<void>((resolve) => server.close(() => resolve()))

export async function startMailSink(): Promise<MailSink> {
  const sent: ParsedMail[] = []
  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS', 'AUTH'],
    onData(stream, _session, cb) {
      const chunks: Buffer[] = []
      stream.on('data', (c: Buffer) => chunks.push(c))
      stream.on('end', async () => {
        sent.push(await simpleParser(Buffer.concat(chunks)))
        cb()
      })
    },
  })
  const port = await listen(server)
  return { port, sent, close: () => closeServer(server) }
}

/** A port nothing listens on. */
export async function deadPort(): Promise<number> {
  const probe = new SMTPServer({})
  const port = await listen(probe)
  await closeServer(probe)
  return port
}

export const MAIL_ENV_KEYS = ['MAIL_TRANSPORT', 'SMTP_HOST', 'SMTP_PORT', 'FIREBASE_AUTH_EMULATOR_HOST', 'FIRESTORE_EMULATOR_HOST', 'APP_BASE_URL', 'MAIL_FROM', 'MAIL_USERNAME', 'MAIL_PASSWORD']

/** Save the mail-related env vars; the returned function restores them. */
export function saveMailEnv(): () => void {
  const saved: Record<string, string | undefined> = {}
  for (const k of MAIL_ENV_KEYS) saved[k] = process.env[k]
  return () => {
    for (const k of MAIL_ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  }
}

/** Clear every mail env var, then set `env` (a key set to undefined stays unset). */
export function setMailEnv(env: Record<string, string | undefined>): void {
  for (const k of MAIL_ENV_KEYS) delete process.env[k]
  for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v
}

/** An env object for functions that take `process.env`-shaped input (e.g. appBaseUrl, appActionLink). */
export const fakeEnv = (vars: Record<string, string> = {}): NodeJS.ProcessEnv => vars as unknown as NodeJS.ProcessEnv

// The mailer (src/lib/server/mailer.ts). Port of the scratch harness check-mailer.mts (13 checks), same assertions; the
// local SMTP servers listen on any free port instead of fixed ones.
import assert from 'node:assert/strict'
import { SMTPServer } from 'smtp-server'
import { describe, it } from 'vitest'
import { isMailEnabled, resolveSmtpConfig, sendMail, transportOptions, MailConfigError, MailUnreachableError } from '@/lib/server/mailer'
import { closeServer, deadPort, fakeEnv, listen } from '../helpers/smtp'

const msg = { to: 'jessica.moore@gmail.com', subject: 'Hello Jess', html: '<p>Hi</p>', text: 'Hi' }
const env = fakeEnv

describe('mailer', () => {
  it('isMailEnabled only true for exactly "smtp"', () => {
    assert.equal(isMailEnabled(env({})), false)
    assert.equal(isMailEnabled(env({ MAIL_TRANSPORT: 'smtp' })), true)
    assert.equal(isMailEnabled(env({ MAIL_TRANSPORT: 'SMTP' })), false)
    assert.equal(isMailEnabled(env({ MAIL_TRANSPORT: 'true' })), false)
  })

  it('resolveSmtpConfig defaults', () => {
    assert.deepEqual(resolveSmtpConfig(env({ MAIL_TRANSPORT: 'smtp' })), {
      host: '127.0.0.1', port: 1025, from: 'SmartStock NWU <no-reply@smartstock.local>', security: 'none',
    })
  })

  it('guard refuses non-local host when the Auth emulator var is set, allows local hosts, allows any host without emulators', () => {
    const bad = { MAIL_TRANSPORT: 'smtp', SMTP_HOST: 'smtp.gmail.com' }
    assert.throws(() => resolveSmtpConfig(env({ ...bad, FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' })), MailConfigError)
    assert.equal(resolveSmtpConfig(env(bad)).host, 'smtp.gmail.com')
    for (const host of ['localhost', '::1', '127.0.0.1']) {
      assert.equal(resolveSmtpConfig(env({ MAIL_TRANSPORT: 'smtp', SMTP_HOST: host, FIREBASE_AUTH_EMULATOR_HOST: 'x' })).host, host)
    }
  })

  it('non-numeric SMTP_PORT throws MailConfigError', () => {
    assert.throws(() => resolveSmtpConfig(env({ MAIL_TRANSPORT: 'smtp', SMTP_PORT: 'abc' })), MailConfigError)
  })

  it('sendMail returns false when disabled', async () => {
    assert.equal(await sendMail(msg, env({})), false)
  })

  it('sendMail delivers to an SMTP server (recipient and subject seen)', async () => {
    const rcpts: string[] = []
    const bodies: string[] = []
    const sink = new SMTPServer({
      authOptional: true,
      disabledCommands: ['STARTTLS', 'AUTH'],
      onRcptTo(addr, _s, cb) { rcpts.push(addr.address); cb() },
      onData(stream, _s, cb) {
        let buf = ''
        stream.on('data', (c: Buffer) => { buf += c.toString() })
        stream.on('end', () => { bodies.push(buf); cb() })
      },
    })
    const port = await listen(sink)
    try {
      assert.equal(await sendMail(msg, env({ MAIL_TRANSPORT: 'smtp', SMTP_PORT: String(port) })), true)
      assert.deepEqual(rcpts, ['jessica.moore@gmail.com'])
      assert.ok(bodies[0].includes('Subject: Hello Jess'))
    } finally {
      await closeServer(sink)
    }
  })

  it('sendMail uses the message From when given, otherwise MAIL_FROM / the default', async () => {
    const froms: string[] = []
    const bodies: string[] = []
    const sink = new SMTPServer({
      authOptional: true,
      disabledCommands: ['STARTTLS', 'AUTH'],
      onMailFrom(addr, _s, cb) { froms.push(addr.address); cb() },
      onData(stream, _s, cb) {
        let buf = ''
        stream.on('data', (c: Buffer) => { buf += c.toString() })
        stream.on('end', () => { bodies.push(buf); cb() })
      },
    })
    const port = await listen(sink)
    try {
      assert.equal(await sendMail({ ...msg, from: 'SmartStock NWU <selouna@nwu.test>' }, env({ MAIL_TRANSPORT: 'smtp', SMTP_PORT: String(port), MAIL_FROM: 'Other <other@x.test>' })), true)
      assert.deepEqual(froms, ['selouna@nwu.test'])
      assert.ok(bodies[0].includes('From: SmartStock NWU <selouna@nwu.test>'), bodies[0].slice(0, 300))
      bodies.length = 0; froms.length = 0
      assert.equal(await sendMail(msg, env({ MAIL_TRANSPORT: 'smtp', SMTP_PORT: String(port) })), true)
      assert.deepEqual(froms, ['no-reply@smartstock.local'])
    } finally {
      await closeServer(sink)
    }
  })

  it('closed port rejects with MailUnreachableError in under 5s', async () => {
    const port = await deadPort()
    const t0 = Date.now()
    await assert.rejects(() => sendMail(msg, env({ MAIL_TRANSPORT: 'smtp', SMTP_PORT: String(port) })), MailUnreachableError)
    assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0}ms`)
  })

  // ---- hosted SMTP (Mailtrap, the client's own server) -----------------------
  const MT = { MAIL_TRANSPORT: 'smtp', SMTP_HOST: 'sandbox.smtp.mailtrap.io', SMTP_PORT: '587' }

  it('MAIL_USERNAME + MAIL_PASSWORD become the login; only one of them set is a config error', () => {
    assert.deepEqual(resolveSmtpConfig(env({ ...MT, MAIL_USERNAME: ' user1 ', MAIL_PASSWORD: 'secret' })).auth, { user: 'user1', pass: 'secret' })
    assert.equal(resolveSmtpConfig(env(MT)).auth, undefined)
    assert.throws(() => resolveSmtpConfig(env({ ...MT, MAIL_USERNAME: 'user1' })), MailConfigError)
    assert.throws(() => resolveSmtpConfig(env({ ...MT, MAIL_PASSWORD: 'secret' })), MailConfigError)
    assert.throws(() => resolveSmtpConfig(env({ ...MT, MAIL_USERNAME: 'user1', MAIL_PASSWORD: '   ' })), MailConfigError)
  })

  it('remote servers must encrypt (STARTTLS, or TLS on 465); only a local Mailpit may stay plain', () => {
    assert.equal(resolveSmtpConfig(env(MT)).security, 'starttls')
    assert.equal(resolveSmtpConfig(env({ ...MT, SMTP_PORT: '2525' })).security, 'starttls')
    assert.equal(resolveSmtpConfig(env({ ...MT, SMTP_PORT: '465' })).security, 'tls')
    for (const host of ['127.0.0.1', 'localhost', '::1']) assert.equal(resolveSmtpConfig(env({ MAIL_TRANSPORT: 'smtp', SMTP_HOST: host })).security, 'none')
  })

  it('transport options: STARTTLS required on 587, TLS on 465, plain only for local', () => {
    const o = transportOptions(resolveSmtpConfig(env({ ...MT, MAIL_USERNAME: 'u', MAIL_PASSWORD: 'p' })))
    assert.equal(o.secure, false); assert.equal(o.requireTLS, true); assert.equal(o.ignoreTLS, false)
    assert.deepEqual(o.auth, { user: 'u', pass: 'p' })
    const o465 = transportOptions(resolveSmtpConfig(env({ ...MT, SMTP_PORT: '465' })))
    assert.equal(o465.secure, true); assert.equal(o465.ignoreTLS, false)
    const oLocal = transportOptions(resolveSmtpConfig(env({ MAIL_TRANSPORT: 'smtp' })))
    assert.equal(oLocal.secure, false); assert.equal(oLocal.ignoreTLS, true); assert.equal(oLocal.requireTLS, false); assert.equal(oLocal.auth, undefined)
  })

  it('sends with the login; a rejected login is a MailConfigError naming MAIL_USERNAME / MAIL_PASSWORD', async () => {
    // A local sink that requires a login.
    const authSeen: string[] = []
    const authSink = new SMTPServer({
      allowInsecureAuth: true,
      disabledCommands: ['STARTTLS'],
      onAuth(a, _s, cb) {
        authSeen.push(`${a.username}:${a.password}`)
        if (a.username === 'demo' && a.password === 'pw') return cb(null, { user: 'demo' })
        return cb(new Error('Invalid username or password'))
      },
      onData(stream, _s, cb) { stream.on('data', () => {}); stream.on('end', () => cb()) },
    })
    const port = await listen(authSink)
    try {
      assert.equal(await sendMail(msg, env({ MAIL_TRANSPORT: 'smtp', SMTP_PORT: String(port), MAIL_USERNAME: 'demo', MAIL_PASSWORD: 'pw' })), true)
      await assert.rejects(() => sendMail(msg, env({ MAIL_TRANSPORT: 'smtp', SMTP_PORT: String(port), MAIL_USERNAME: 'demo', MAIL_PASSWORD: 'wrong' })),
        (e: unknown) => e instanceof MailConfigError && /MAIL_USERNAME/.test(e.message))
      assert.deepEqual(authSeen, ['demo:pw', 'demo:wrong'])
    } finally {
      await closeServer(authSink)
    }
  })

  it('remote server without encryption: refused, no login or message sent', async () => {
    // 127.0.0.2 is loopback on Linux but not in the local list, so it counts as remote.
    const plainSeen: string[] = []
    const plainSink = new SMTPServer({
      allowInsecureAuth: true,
      disabledCommands: ['STARTTLS'],
      onAuth(a, _s, cb) { plainSeen.push(a.username ?? ''); cb(null, { user: a.username }) },
      onData(stream, _s, cb) { plainSeen.push('DATA'); stream.on('data', () => {}); stream.on('end', () => cb()) },
    })
    const port = await listen(plainSink, '127.0.0.2')
    try {
      await assert.rejects(() => sendMail(msg, env({ MAIL_TRANSPORT: 'smtp', SMTP_HOST: '127.0.0.2', SMTP_PORT: String(port), MAIL_USERNAME: 'demo', MAIL_PASSWORD: 'pw' })))
      assert.deepEqual(plainSeen, [])
    } finally {
      await closeServer(plainSink)
    }
  })
})

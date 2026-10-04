// Pool options from the environment (src/server/db/client.ts buildPoolConfig): pool size, idle timeout and the Cloud SQL
// CA-pinned TLS option. No TLS server is needed: pg's own ConnectionParameters shows which `ssl` a client would use.
import ConnectionParameters from 'pg/lib/connection-parameters'
import { describe, expect, it } from 'vitest'
import { buildPoolConfig, stripUrlSsl } from '@/server/db/client'

const PEM = '-----BEGIN CERTIFICATE-----\nMIIBfakefakefake\nAAAA\n-----END CERTIFICATE-----'
const URL_PLAIN = 'postgres://app:p%40ss@203.0.113.10:5432/smartstock'

// What a pg client built from these options would actually use for TLS. (@types/pg leaves connectionString out of the
// ConnectionParameters config type, but pg reads it there: lib/connection-parameters.js.)
type ParamsConfig = ConstructorParameters<typeof ConnectionParameters>[0]
const effectiveSsl = (config: object) => new ConnectionParameters(config as ParamsConfig).ssl

describe('buildPoolConfig', () => {
  it('defaults: 5 connections, a 10 s idle timeout, the URL unchanged and no ssl option', () => {
    const config = buildPoolConfig(`${URL_PLAIN}?sslmode=disable`, {})
    expect(config).toEqual({ connectionString: `${URL_PLAIN}?sslmode=disable`, max: 5, idleTimeoutMillis: 10_000 })
  })

  it('DATABASE_POOL_MAX sets the pool size; anything but a whole number ≥ 1 is a clear error', () => {
    expect(buildPoolConfig(URL_PLAIN, { DATABASE_POOL_MAX: ' 2 ' }).max).toBe(2)
    expect(buildPoolConfig(URL_PLAIN, { DATABASE_POOL_MAX: '' }).max).toBe(5)
    for (const bad of ['0', '-1', '2.5', 'ten']) {
      expect(() => buildPoolConfig(URL_PLAIN, { DATABASE_POOL_MAX: bad })).toThrow('DATABASE_POOL_MAX must be a whole number of at least 1.')
    }
  })

  it('DATABASE_SSL_CA (PEM text) gives verify-ca: the CA is checked, the host name is not', () => {
    const config = buildPoolConfig(URL_PLAIN, { DATABASE_SSL_CA: PEM })
    const ssl = config.ssl as { ca: string; rejectUnauthorized: boolean; checkServerIdentity: () => unknown }
    expect(ssl.ca).toBe(PEM)
    expect(ssl.rejectUnauthorized).toBe(true)
    expect(ssl.checkServerIdentity()).toBeUndefined()
    expect(config.connectionString).toBe(URL_PLAIN)
    expect(effectiveSsl(config)).toBe(config.ssl)
  })

  it('accepts the single-line, \\n-escaped form of the PEM (as pasted into a Vercel env var)', () => {
    const oneLine = PEM.replace(/\n/g, '\\n')
    expect(oneLine).not.toContain('\n')
    expect((buildPoolConfig(URL_PLAIN, { DATABASE_SSL_CA: oneLine }).ssl as { ca: string }).ca).toBe(PEM)
    // Windows line endings in a pasted file are normalised too.
    expect((buildPoolConfig(URL_PLAIN, { DATABASE_SSL_CA: PEM.replace(/\n/g, '\r\n') }).ssl as { ca: string }).ca).toBe(PEM)
  })

  it('refuses a DATABASE_SSL_CA that is not a PEM certificate', () => {
    expect(() => buildPoolConfig(URL_PLAIN, { DATABASE_SSL_CA: '/path/to/server-ca.pem' })).toThrow(/DATABASE_SSL_CA must be the PEM text/)
  })

  it('pg lets sslmode in the URL replace an explicit ssl option, so with DATABASE_SSL_CA the URL\'s TLS settings are dropped', () => {
    // The rule this guards against: URL ssl settings win over the `ssl` pool option.
    const ours = { ca: PEM, rejectUnauthorized: true }
    const overridden = effectiveSsl({ connectionString: `${URL_PLAIN}?sslmode=verify-full`, ssl: ours })
    expect(overridden).not.toBe(ours)

    const config = buildPoolConfig(`${URL_PLAIN}?sslmode=require&application_name=smartstock&ssl=true`, { DATABASE_SSL_CA: PEM })
    expect(config.connectionString).toBe(`${URL_PLAIN}?application_name=smartstock`)
    expect(effectiveSsl(config)).toBe(config.ssl)
  })
})

describe('stripUrlSsl', () => {
  it('removes only the TLS keys and keeps the rest of the URL', () => {
    expect(stripUrlSsl(URL_PLAIN)).toBe(URL_PLAIN)
    expect(stripUrlSsl(`${URL_PLAIN}?sslmode=verify-full`)).toBe(URL_PLAIN)
    expect(stripUrlSsl(`${URL_PLAIN}?uselibpqcompat=true&sslmode=require&sslrootcert=/x.pem&options=-c%20search_path%3Dpublic`)).toBe(
      `${URL_PLAIN}?options=-c+search_path%3Dpublic`,
    )
  })
})

// The database-name guard on `npm run db:reset` and the seeds' --reset (scripts/dbGuard.ts): through the Cloud SQL Auth
// Proxy the target looks local, so these refuse any database not named smartstock / smartstock_test unless --force.
import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assertResettableDatabase, assertResettableDatabaseName, RESETTABLE_DATABASES } from '../../scripts/dbGuard'

const TEST_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/smartstock_test'
const PROBE_DB = 'smartstock_guard_probe' // a throwaway database with a name the guard must refuse
const probeUrl = () => {
  const u = new URL(TEST_URL)
  u.pathname = `/${PROBE_DB}`
  return u.toString()
}
const fake = (name: string) => ({ query: async () => ({ rows: [{ name }] }) })

describe('assertResettableDatabaseName', () => {
  it('allows only the local databases, unless forced', () => {
    expect(RESETTABLE_DATABASES).toEqual(['smartstock', 'smartstock_test'])
    expect(() => assertResettableDatabaseName('smartstock', false, 'reset')).not.toThrow()
    expect(() => assertResettableDatabaseName('smartstock_test', false, 'reset')).not.toThrow()
    for (const name of ['production', 'smartstock_prod', 'SmartStock', 'postgres', '']) {
      expect(() => assertResettableDatabaseName(name, false, 'reset')).toThrow(`Refusing to reset the database "${name}"`)
      expect(() => assertResettableDatabaseName(name, true, 'reset')).not.toThrow()
    }
  })

  it('asks the server for current_database(), whatever the URL says', async () => {
    await expect(assertResettableDatabase(fake('cloudsql_prod'), false, 'clear (--reset)')).rejects.toThrow(
      'Refusing to clear (--reset) the database "cloudsql_prod": only smartstock or smartstock_test can be reset. Pass --force if you really mean it.',
    )
    await expect(assertResettableDatabase(fake('cloudsql_prod'), true, 'reset')).resolves.toBe('cloudsql_prod')
    const pool = new pg.Pool({ connectionString: TEST_URL, max: 1 })
    try {
      await expect(assertResettableDatabase(pool, false, 'reset')).resolves.toBe('smartstock_test')
    } finally {
      await pool.end()
    }
  })
})

describe('npm run db:reset on a database with another name', () => {
  const admin = () => {
    const u = new URL(TEST_URL)
    u.pathname = '/postgres'
    return new pg.Client({ connectionString: u.toString() })
  }

  beforeAll(async () => {
    const c = admin()
    await c.connect()
    try {
      await c.query(`drop database if exists ${PROBE_DB}`)
      await c.query(`create database ${PROBE_DB}`)
    } finally {
      await c.end()
    }
    const p = new pg.Client({ connectionString: probeUrl() })
    await p.connect()
    try {
      await p.query('create table keep_me (id int)')
    } finally {
      await p.end()
    }
  })

  afterAll(async () => {
    const c = admin()
    await c.connect()
    try {
      await c.query(`drop database if exists ${PROBE_DB}`)
    } finally {
      await c.end()
    }
  })

  it('refuses (exit 1) and drops nothing, even though the host is local', async () => {
    const run = promisify(execFile)
    const tsx = path.resolve('node_modules/.bin/tsx')
    const err = await run(tsx, ['scripts/db-reset.ts'], { env: { ...process.env, DATABASE_URL: probeUrl() } }).then(
      () => null,
      (e: { code?: number; stderr?: string }) => e,
    )
    expect(err?.code).toBe(1)
    expect(err?.stderr).toContain(`Refusing to reset the database "${PROBE_DB}"`)
    const p = new pg.Client({ connectionString: probeUrl() })
    await p.connect()
    try {
      const { rows } = await p.query(`select to_regclass('public.keep_me') as t`)
      expect(rows[0].t).toBe('keep_me')
    } finally {
      await p.end()
    }
  }, 30_000)

  it('the seeds\' --reset refuses it too, before clearing anything', async () => {
    const run = promisify(execFile)
    const tsx = path.resolve('node_modules/.bin/tsx')
    for (const script of ['scripts/seed/comprehensive.ts', 'scripts/seed/demo.ts']) {
      const err = await run(tsx, ['--conditions=react-server', script, '--reset', '--dry-auth'], {
        env: { ...process.env, DATABASE_URL: probeUrl() },
      }).then(
        () => null,
        (e: { code?: number; stderr?: string }) => e,
      )
      expect(err?.code, script).toBe(1)
      expect(err?.stderr, script).toContain(`Refusing to clear (--reset) the database "${PROBE_DB}"`)
    }
  }, 60_000)
})

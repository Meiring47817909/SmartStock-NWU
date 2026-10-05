import { count, eq, sql } from 'drizzle-orm'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { parseSeedReset, parseSeedTarget, runSeedCli } from '../../scripts/seed/comprehensive'
import { DEMO_CAST, seedDemo } from '../../scripts/seed/demo'
import {
  castLoginEmails,
  EMULATOR_ENV_VARS,
  LiveAccountChangeRefusedError,
  liveSeedEnvProblem,
  liveStorageBucket,
  loadAdminCredentials,
  missingLiveLogins,
  readOnlyLiveAuth,
} from '../../scripts/seed/live'
import type { SeedBucket } from '../../scripts/seed/context'
import { getDb } from '@/server/db/client'
import { categories, profiles, staff } from '@/server/db/schema'
import { closeTestDb, resetTestDb, TEST_DATABASE_URL } from '../helpers/db'

const notFound = () => Object.assign(new Error('There is no user record corresponding to the provided identifier.'), { code: 'auth/user-not-found' })

/** A stand-in for the live project: existing accounts by email, a bucket that records uploads, and a call log. */
function fakeLiveProject(accounts: Record<string, string>) {
  const calls: string[] = []
  const files = new Map<string, Buffer>()
  const auth = readOnlyLiveAuth({
    async getUserByEmail(email) {
      calls.push(`lookup ${email}`)
      const uid = accounts[email]
      if (!uid) throw notFound()
      return { uid }
    },
  })
  const bucket: SeedBucket = {
    async save(filePath, data) {
      files.set(filePath, data)
    },
  }
  return { calls, files, createLive: async () => ({ auth, bucket, label: 'LIVE (fake)' }) }
}

const SELOUNA = 'selouna.visser@nwu.ac.za'
const MEIRING = '47817909@mynwu.ac.za'
const liveEnv = { DATABASE_URL: TEST_DATABASE_URL }

afterAll(async () => {
  await closeTestDb()
})

describe('live seed: pure helpers', () => {
  it('refuses any emulator variable', () => {
    expect(liveSeedEnvProblem({})).toBeNull()
    for (const name of EMULATOR_ENV_VARS) {
      expect(liveSeedEnvProblem({ [name]: '127.0.0.1:9099' })).toMatch(name)
    }
  })

  it('parses --target and --reset', () => {
    expect(parseSeedTarget([])).toBe('local')
    expect(parseSeedTarget(['--target', 'live'])).toBe('live')
    expect(parseSeedTarget(['--target=live'])).toBe('live')
    expect(() => parseSeedTarget(['--target', 'prod'])).toThrow(/Unknown --target "prod"/)
    expect(parseSeedReset([])).toBeNull()
    expect(parseSeedReset(['--reset'])).toEqual({ database: null })
    expect(parseSeedReset(['--reset=smartstock'])).toEqual({ database: 'smartstock' })
    expect(parseSeedReset(['--reset='])).toEqual({ database: null })
  })

  it('needs exactly the two demo logins: Selouna (admin) and Meiring (portal)', () => {
    expect(castLoginEmails(DEMO_CAST)).toEqual([SELOUNA, MEIRING])
  })

  it('never creates or changes a live account', async () => {
    const auth = readOnlyLiveAuth({ getUserByEmail: async () => ({ uid: 'u1' }) })
    await expect(auth.getUserByEmail('a@b.c')).resolves.toEqual({ uid: 'u1' })
    await expect(auth.updateUser('u1', { email: 'x@y.z', emailVerified: true })).rejects.toBeInstanceOf(LiveAccountChangeRefusedError)
    await expect(auth.createUser({ uid: 'u2', email: 'x@y.z', password: 'p', emailVerified: true })).rejects.toBeInstanceOf(
      LiveAccountChangeRefusedError,
    )
  })

  it('reports only not-found accounts as missing; other lookup errors are thrown', async () => {
    const live = fakeLiveProject({ [SELOUNA]: 'live-selouna' })
    const { auth } = await live.createLive()
    await expect(missingLiveLogins(auth, [SELOUNA, MEIRING])).resolves.toEqual([MEIRING])
    const broken = { getUserByEmail: async () => Promise.reject(Object.assign(new Error('quota'), { code: 'auth/internal-error' })) }
    await expect(missingLiveLogins(broken, [SELOUNA])).rejects.toThrow('quota')
  })

  it('reads the Admin credentials and bucket from .env.local, the environment winning', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'live-env-'))
    writeFileSync(
      path.join(dir, '.env.local'),
      'FIREBASE_ADMIN_PROJECT_ID=smartstock-nwu\nFIREBASE_ADMIN_CLIENT_EMAIL=sa@x.iam\nFIREBASE_ADMIN_PRIVATE_KEY="a\\nb"\nNEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=smartstock-nwu.firebasestorage.app\n',
    )
    expect(loadAdminCredentials({}, dir)).toEqual({ projectId: 'smartstock-nwu', clientEmail: 'sa@x.iam', privateKey: 'a\nb' })
    expect(loadAdminCredentials({ FIREBASE_ADMIN_PROJECT_ID: 'other' }, dir).projectId).toBe('other')
    expect(liveStorageBucket({}, dir)).toBe('smartstock-nwu.firebasestorage.app')
    const empty = mkdtempSync(path.join(tmpdir(), 'live-env-'))
    expect(() => loadAdminCredentials({}, empty)).toThrow(/Missing Firebase Admin credentials/)
    expect(() => liveStorageBucket({}, empty)).toThrow(/NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET/)
  })
})

describe('live seed: command line', () => {
  /** The test database with one leftover row, standing in for the imported live data. */
  async function withOldData() {
    const db = await resetTestDb()
    await db.insert(categories).values({ id: 'old-cat', name: 'Old imported category' })
    return db
  }
  const oldRowStillThere = async () => {
    const [row] = await getDb(TEST_DATABASE_URL).select({ n: count() }).from(categories).where(eq(categories.id, 'old-cat'))
    return row.n === 1
  }
  const run = (argv: string[], live: ReturnType<typeof fakeLiveProject>, env: Record<string, string | undefined> = liveEnv) => {
    const lines: string[] = []
    return {
      lines,
      done: runSeedCli(seedDemo, DEMO_CAST, { argv, env, log: (l) => lines.push(l), createLive: live.createLive }),
    }
  }

  beforeEach(async () => {
    await withOldData()
  })

  it('refuses an emulator variable, a bare --reset, --dry-auth and a missing DATABASE_URL, writing nothing', async () => {
    const live = fakeLiveProject({ [SELOUNA]: 'live-selouna', [MEIRING]: 'live-meiring' })
    await expect(run(['--target', 'live', '--reset=smartstock_test'], live, { ...liveEnv, FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' }).done).rejects.toThrow(/FIREBASE_AUTH_EMULATOR_HOST/)
    await expect(run(['--target', 'live', '--reset'], live).done).rejects.toThrow(/--reset=<database>/)
    await expect(run(['--target', 'live', '--dry-auth'], live).done).rejects.toThrow(/cannot be combined/)
    await expect(run(['--target', 'live', '--reset=smartstock_test'], live, {}).done).rejects.toThrow(/needs DATABASE_URL/)
    expect(live.calls).toEqual([])
    expect(await oldRowStillThere()).toBe(true)
  })

  it('stops before writing when a login is missing on the live project', async () => {
    const live = fakeLiveProject({ [SELOUNA]: 'live-selouna' })
    await expect(run(['--target', 'live', '--reset=smartstock_test'], live).done).rejects.toThrow(
      `No live Firebase login for: ${MEIRING}`,
    )
    expect(await oldRowStillThere()).toBe(true)
    expect(live.files.size).toBe(0)
  })

  it('refuses a --reset name that is not the target database', async () => {
    const live = fakeLiveProject({ [SELOUNA]: 'live-selouna', [MEIRING]: 'live-meiring' })
    await expect(run(['--target', 'live', '--reset=smartstock'], live).done).rejects.toThrow(
      '--reset=smartstock does not match the target database "smartstock_test"',
    )
    expect(await oldRowStillThere()).toBe(true)
  })

  it('replaces everything with the demo data, linking the existing live logins by email', async () => {
    const live = fakeLiveProject({ [SELOUNA]: 'live-selouna', [MEIRING]: 'live-meiring' })
    const { lines, done } = run(['--target', 'live', '--reset=smartstock_test'], live)
    await done
    const db = getDb(TEST_DATABASE_URL)

    expect(await oldRowStillThere()).toBe(false)
    expect(await db.select({ uid: profiles.uid, role: profiles.role }).from(profiles)).toEqual([{ uid: 'live-selouna', role: 'admin' }])
    const [meiring] = await db.select({ uid: staff.uid }).from(staff).where(eq(staff.email, MEIRING))
    expect(meiring.uid).toBe('live-meiring')
    // Only the two live accounts are linked: no made-up uid is left anywhere.
    const linked = await db.select({ uid: staff.uid }).from(staff).where(sql`${staff.uid} is not null`)
    expect(new Set(linked.map((r) => r.uid))).toEqual(new Set(['live-selouna', 'live-meiring']))
    expect((await db.select({ n: count() }).from(staff).where(sql`${staff.uid} = 'admin-selouna-visser'`))[0].n).toBe(0)

    // Look-ups only, and the photos went to the (fake) live bucket.
    expect(live.calls.every((c) => c.startsWith('lookup '))).toBe(true)
    expect(live.files.size).toBeGreaterThan(0)
    expect([...live.files.keys()].every((k) => k.startsWith('products/'))).toBe(true)

    const output = lines.join('\n')
    expect(output).toContain('Target database: "smartstock_test"')
    expect(output).not.toContain('password123')
    expect(output).toContain('no account or password was changed')
  })
})

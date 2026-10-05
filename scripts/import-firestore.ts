// npm run db:import-firestore -- --source emulator|live [--dry-run | --write [--replace=<database>]]
//                                 [--restore-deleted-products] [--allow-non-local-db]
//
// Copies the app's Firestore data into PostgreSQL (spec section 7), keeping every document id.
//
//   --source emulator   reads a Firestore emulator at FIRESTORE_EMULATOR_HOST (default 127.0.0.1:8081, must be on this
//                       machine), project demo-smartstock-nwu. Nothing in this repo starts a Firestore emulator any more
//                       (firebase.json runs Auth and Storage only): start one yourself on that host first.
//   --source live       reads the live project with the Admin credentials in .env.local (FIREBASE_ADMIN_PROJECT_ID,
//                       FIREBASE_ADMIN_CLIENT_EMAIL, FIREBASE_ADMIN_PRIVATE_KEY), loaded the way
//                       src/lib/firebase/admin.ts reads them. READ-ONLY: every collection is read inside ONE read-only
//                       Firestore transaction (one consistent snapshot); the source can only list and get (see
//                       ReadOnlyFirestore in src/server/import/mapFirestore.ts). Nothing here can write to Firestore.
//   (default) --dry-run dry run: prints the documents read, the rows that would be written, every problem and warning.
//                       Writes nothing anywhere. Exits 1 when there are problems.
//   --write             imports into DATABASE_URL in one transaction. Refused if the plan has any problem, or if the
//                       database already has data.
//   --replace=<database>  with --write: empties the app tables first, inside the same transaction. <database> must be
//                       the target's own name (current_database()), and it is refused if the target holds a row the
//                       import does not account for: an id that is not in the plan, or a row created or updated after
//                       the newest record in Firestore (data entered after cut-over).
//   --restore-deleted-products  rebuilds products that history still points at but that were deleted in Firestore,
//                       from their product `delete` audit entry (unavailable, 0 in stock); listed in the output.
//   --allow-non-local-db  needed to write anywhere but this machine (e.g. Cloud SQL by its address). Not needed through
//                       the Cloud SQL Auth Proxy, which looks local. The target host and database are printed before
//                       anything is written.
//
// DATABASE_URL is taken from the environment only (never from .env.local), defaulting to the local development database.
// Server modules import 'server-only': run with `tsx --conditions=react-server` (the npm script does).
import net from 'node:net'
import { sql } from 'drizzle-orm'
import { parse as parseConnectionString } from 'pg-connection-string'
import { closeDb, getDb } from '@/server/db/client'
import { planImport, readFirestoreSnapshot, type FirestoreSource, type ImportPlan } from '@/server/import/mapFirestore'
import { ImportRefusedError, runImport } from '@/server/import/runImport'
import { databaseHosts, isLocalHost } from './seed/context'
import { loadAdminCredentials } from './seed/live'

export const EMULATOR_PROJECT_ID = 'demo-smartstock-nwu'
export const DEFAULT_EMULATOR_HOST = '127.0.0.1:8081' // the port firebase.json used to give the Firestore emulator; no longer configured
export const DEFAULT_DATABASE_URL = 'postgres://postgres:postgres@127.0.0.1:5432/smartstock'

export interface CliArgs {
  source: 'emulator' | 'live'
  write: boolean
  /** null: no --replace. database null: a bare --replace, refused once the target's name is known. */
  replace: { database: string | null } | null
  restoreDeletedProducts: boolean
  allowNonLocalDb: boolean
}

const USAGE =
  'Usage: npm run db:import-firestore -- --source emulator|live [--dry-run | --write [--replace=<database>]] ' +
  '[--restore-deleted-products] [--allow-non-local-db]'

export function parseCliArgs(argv: string[]): CliArgs {
  let source: string | undefined
  let replace: CliArgs['replace'] = null
  const flags = new Set<string>()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--source') source = argv[++i]
    else if (arg.startsWith('--source=')) source = arg.slice('--source='.length)
    else if (arg === '--replace') replace = { database: null }
    else if (arg.startsWith('--replace=')) replace = { database: arg.slice('--replace='.length) || null }
    else if (['--write', '--dry-run', '--allow-non-local-db', '--restore-deleted-products'].includes(arg)) flags.add(arg)
    else throw new Error(`Unknown option ${arg}. ${USAGE}`)
  }
  if (source !== 'emulator' && source !== 'live') throw new Error(`Say where to read from: --source emulator|live. ${USAGE}`)
  if (flags.has('--dry-run') && flags.has('--write')) throw new Error('--dry-run and --write contradict each other: pick one.')
  if (replace && !flags.has('--write')) throw new Error('--replace only makes sense with --write.')
  return {
    source,
    write: flags.has('--write'),
    replace,
    restoreDeletedProducts: flags.has('--restore-deleted-products'),
    allowNonLocalDb: flags.has('--allow-non-local-db'),
  }
}

/** "host X, database Y" for the target (no password); throws for a non-local host unless explicitly allowed. */
export function checkTarget(url: string, allowNonLocalDb: boolean): string {
  const hosts = databaseHosts(url)
  const local = hosts.every(isLocalHost)
  if (!local && !allowNonLocalDb) {
    throw new Error(
      `Refusing to write to a database on "${hosts.filter((h) => !isLocalHost(h)).join(', ')}": that is not this machine. ` +
        'Pass --allow-non-local-db to import into it (e.g. Cloud SQL at cut-over).',
    )
  }
  let database = '(default)'
  try {
    database = parseConnectionString(url).database ?? database
  } catch {
    // databaseHosts already reported an unparseable string as a non-local host
  }
  return `host ${hosts.join(', ')}, database ${database}${local ? '' : ' (NOT this machine)'}`
}

function hostOf(value: string): string {
  return value.replace(/^\w+:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '').replace(/^\[(.*)\]$/, '$1')
}

/** Emulator mode must only ever read an emulator on this machine. */
export function emulatorHostProblem(value: string): string | null {
  return isLocalHost(hostOf(value)) ? null : `FIRESTORE_EMULATOR_HOST "${value}" is not on this machine: --source emulator only reads a local emulator.`
}

/** Live mode refuses an emulator host: with it set, the Admin SDK silently reads the emulator instead of the project. */
export function liveEnvProblem(env: Record<string, string | undefined>): string | null {
  return env.FIRESTORE_EMULATOR_HOST
    ? `FIRESTORE_EMULATOR_HOST is set ("${env.FIRESTORE_EMULATOR_HOST}"): the Admin SDK would read the emulator, not the live project. Unset it for --source live.`
    : null
}

function reachable(hostPort: string, timeoutMs = 3000): Promise<boolean> {
  const m = /^(?:\[(.*)\]|([^:]*))(?::(\d+))?$/.exec(hostPort.replace(/^\w+:\/\//, '').replace(/\/.*$/, ''))
  const host = (m?.[1] ?? m?.[2]) || '127.0.0.1'
  const port = Number(m?.[3] ?? 8081)
  return new Promise((resolve) => {
    const socket = net.connect({ host, port })
    const done = (ok: boolean) => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once('error', () => done(false))
    socket.once('connect', () => done(true))
  })
}

/** The Firestore to read, wrapped so only list/get can be called on it. firebase-admin loads on demand. */
async function openSource(kind: CliArgs['source']): Promise<{ source: FirestoreSource; label: string }> {
  const { cert, initializeApp } = await import('firebase-admin/app')
  const { getFirestore } = await import('firebase-admin/firestore')
  if (kind === 'emulator') {
    process.env.FIRESTORE_EMULATOR_HOST ||= DEFAULT_EMULATOR_HOST
    const host = process.env.FIRESTORE_EMULATOR_HOST
    const problem = emulatorHostProblem(host)
    if (problem) throw new Error(problem)
    if (!(await reachable(host))) throw new Error(`The Firestore emulator (${host}) is not reachable. Nothing in this repo starts a Firestore emulator any more (npm run emulators runs Auth and Storage only): start one yourself on that host, or use --source live.`)
    const app = initializeApp({ projectId: EMULATOR_PROJECT_ID }, 'firestore-import')
    return { source: await readFirestoreSnapshot(getFirestore(app)), label: `Firestore emulator ${host}, project ${EMULATOR_PROJECT_ID}` }
  }
  const problem = liveEnvProblem(process.env)
  if (problem) throw new Error(problem)
  const creds = loadAdminCredentials()
  const app = initializeApp({ credential: cert(creds) }, 'firestore-import')
  return { source: await readFirestoreSnapshot(getFirestore(app)), label: `LIVE Firestore, project ${creds.projectId} (read-only)` }
}

function printPlan(plan: ImportPlan): void {
  const pad = (s: string) => s.padEnd(22)
  console.log('Documents read from Firestore:')
  for (const [c, n] of Object.entries(plan.sourceCounts)) console.log(`  ${pad(c)}${n}`)
  if (plan.notImported.length > 0) {
    console.log('\nCollections the app no longer has (reported, NOT imported):')
    for (const c of plan.notImported) console.log(`  ${pad(c.collection)}${c.documents}`)
  }
  console.log('\nRows to write to PostgreSQL:')
  for (const [t, rows] of Object.entries(plan.rows)) {
    const restored = t === 'products' && plan.restoredProducts.length > 0 ? `  (incl. ${plan.restoredProducts.length} RESTORED deleted product(s))` : ''
    console.log(`  ${pad(t)}${rows.length}${restored}`)
  }
  if (plan.restoredProducts.length > 0) {
    console.log('\nDeleted products restored from their delete audit entry (unavailable, 0 in stock, no photos):')
    for (const m of plan.missingProducts.filter((x) => x.restored)) {
      console.log(`  ${m.id}  ${m.names.join(' / ') || '(no name)'}  deleted ${m.deleted?.at ?? '?'} by ${m.deleted?.by ?? '?'}`)
    }
  }
  console.log(`\nWarnings (${plan.warnings.length}; reported, not blocking):`)
  for (const w of plan.warnings) console.log(`  ${w.collection}/${w.id}: ${w.problem}`)
  console.log(`\nProblems (${plan.problems.length}; each must be fixed in Firestore before --write):`)
  for (const p of plan.problems) console.log(`  ${p.collection}/${p.id}: ${p.problem}`)
  const restorable = plan.missingProducts.filter((m) => !m.restored && m.deleted)
  if (restorable.length > 0) {
    console.log(
      `\n${restorable.length} of the missing products above have a delete entry in the audit log. Run again with ` +
        '--restore-deleted-products to rebuild them from it (unavailable, 0 in stock, no photos; listed in the output).',
    )
  }
}

/** The command. `open` is the Firestore opener (tests pass an in-memory one); returns the process exit code. */
export async function main(argv: string[], open: typeof openSource = openSource): Promise<number> {
  const args = parseCliArgs(argv)
  const { source, label } = await open(args.source)
  console.log(`Reading ${label}\n`)
  const plan = await planImport(source, { restoreDeletedProducts: args.restoreDeletedProducts })
  printPlan(plan)

  if (!args.write) {
    console.log(`\nDry run: nothing was written. ${plan.problems.length === 0 ? 'Re-run with --write to import.' : 'Fix the problems above, then run again.'}`)
    return plan.problems.length === 0 ? 0 : 1
  }
  if (plan.problems.length > 0) {
    console.error(`\n--write refused: ${plan.problems.length} problem(s) above. Nothing was written.`)
    return 1
  }

  const url = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL
  const target = checkTarget(url, args.allowNonLocalDb)
  console.log(`\nWriting to PostgreSQL: ${target}`)
  if (args.replace) console.log('--replace: the app tables there will be emptied first (in the same transaction), if the guards allow it.')
  const db = getDb(url)
  try {
    const info = (await db.execute(sql`select current_database() as db, host(inet_server_addr()) as addr, current_setting('server_version') as version`)).rows[0] as {
      db: string
      addr: string | null
      version: string
    }
    console.log(`Connected: database ${info.db} on server ${info.addr ?? '(local socket)'}, PostgreSQL ${info.version}`)
    if (args.replace && args.replace.database === null) {
      console.error(`\n--replace needs the target database's name, to show you mean this one: --replace=${info.db}. Nothing was written.`)
      return 1
    }
    const counts = await runImport(db, plan, args.replace ? { replace: true, confirmDatabase: args.replace.database as string } : { replace: false })
    console.log('\nImported (one transaction, committed):')
    for (const [t, n] of Object.entries(counts)) console.log(`  ${t.padEnd(22)}${n}`)
    if (plan.restoredProducts.length > 0) console.log(`\nRestored deleted products (no audit entry written): ${plan.restoredProducts.join(', ')}`)
    return 0
  } catch (err) {
    if (err instanceof ImportRefusedError) {
      console.error(`\n${err.message}`)
      return 1
    }
    throw err
  } finally {
    await closeDb(url)
  }
}

// Run only when started as a script (not when a test imports this file).
if (/[\\/]import-firestore\.ts$/.test(process.argv[1] ?? '')) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('Import failed (nothing was written):', err instanceof Error ? err.message : err)
      process.exit(1)
    })
}

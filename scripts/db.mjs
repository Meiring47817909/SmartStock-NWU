// Starts or stops the local PostgreSQL in Docker.
//   npm run db        -> starts the container (creates it the first time, reuses it after)
//   npm run db:stop   -> stops it; the data stays in the smartstock-pg volume
// PostgreSQL listens on 127.0.0.1:5432 (user and password: postgres) with two databases:
// smartstock (the app) and smartstock_test (the automated tests). Loopback only, so the
// database is not reachable from the network. Plain Node so it behaves the same in PowerShell.
import { spawnSync } from 'node:child_process'

const NAME = 'smartstock-postgres'
const IMAGE = 'postgres:17'
const VOLUME = 'smartstock-pg'
const DATABASES = ['smartstock', 'smartstock_test']
const DOCKER_HELP = 'Docker was not found or is not running. Start Docker Desktop and try again.'
const RUN_HELP =
  'Docker could not start PostgreSQL (see the message above). If it says port 5432 is not available, another\n' +
  'PostgreSQL is already running on this machine (on Windows: Get-Service *postgres*). Stop that service while you\n' +
  'work on SmartStock (Stop-Service <name> in an Administrator PowerShell), then run npm run db again.'

function docker(args, quiet) {
  const res = spawnSync('docker', args, { stdio: quiet ? 'ignore' : 'inherit' })
  return !res.error && res.status === 0
}

// Runs a command inside the container and returns its output, or null if it failed.
function exec(args) {
  const res = spawnSync('docker', ['exec', NAME, ...args], { encoding: 'utf8' })
  return !res.error && res.status === 0 ? res.stdout : null
}

function fail(message = DOCKER_HELP) {
  console.error(message)
  process.exit(1)
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

const mode = process.argv[2] ?? 'start'

if (mode === 'start') {
  const exists = spawnSync('docker', ['container', 'inspect', NAME], { stdio: 'ignore' })
  if (exists.error) fail()
  if (exists.status === 0) {
    if (!docker(['start', NAME], false)) fail(RUN_HELP)
  } else if (
    !docker(
      [
        'run', '-d', '--name', NAME,
        '-e', 'POSTGRES_PASSWORD=postgres',
        '-p', '127.0.0.1:5432:5432',
        '-v', `${VOLUME}:/var/lib/postgresql/data`,
        IMAGE,
      ],
      false,
    )
  ) {
    // docker run can leave a created-but-stopped container behind (e.g. when the port is taken); remove it so the next
    // attempt starts clean instead of re-starting the broken one.
    docker(['rm', '-f', NAME], true)
    fail(RUN_HELP)
  }

  // The first start restarts the server once while it initialises, so keep asking until it answers.
  let ready = false
  for (let i = 0; i < 60 && !ready; i++) {
    ready = exec(['pg_isready', '-U', 'postgres', '-h', '127.0.0.1']) !== null
    if (!ready) sleep(1000)
  }
  if (!ready) fail('PostgreSQL did not become ready within 60 seconds. Run "docker logs smartstock-postgres" to see why.')

  for (const name of DATABASES) {
    const found = exec(['psql', '-U', 'postgres', '-tAc', `select 1 from pg_database where datname = '${name}'`])
    if (found === null) fail(`Could not check for the "${name}" database. Run "docker logs smartstock-postgres" to see why.`)
    if (found.trim() !== '1' && exec(['createdb', '-U', 'postgres', name]) === null) fail(`Could not create the "${name}" database.`)
  }
  console.log('PostgreSQL running on 127.0.0.1:5432 (user postgres, password postgres), databases: smartstock, smartstock_test')
} else if (mode === 'stop') {
  if (!docker(['stop', NAME], true)) fail()
  console.log('PostgreSQL stopped. Your data is kept; npm run db starts it again.')
} else {
  console.error('Usage: node scripts/db.mjs [start|stop]')
  process.exit(1)
}

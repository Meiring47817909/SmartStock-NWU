// Starts or stops a local Mailpit mail catcher in Docker.
//   npm run mailpit        -> (re)starts the container
//   npm run mailpit:stop   -> removes it
// SMTP listens on 1025 (the app sends here) and the web inbox is at
// http://localhost:8025. Plain Node so it behaves the same in PowerShell.
import { spawnSync } from 'node:child_process'

const NAME = 'mailpit'
const IMAGE = 'axllent/mailpit'
const DOCKER_HELP = 'Docker was not found or is not running. Start Docker Desktop and try again.'

function docker(args, quiet) {
  const res = spawnSync('docker', args, { stdio: quiet ? 'ignore' : 'inherit' })
  return !res.error && res.status === 0
}

function fail() {
  console.error(DOCKER_HELP)
  process.exit(1)
}

const mode = process.argv[2] ?? 'start'

if (mode === 'start') {
  // Removing first makes running this twice replace the container.
  if (!docker(['rm', '-f', NAME], true)) fail()
  if (!docker(['run', '-d', '--name', NAME, '-p', '1025:1025', '-p', '8025:8025', IMAGE], false)) fail()
  console.log('Mailpit running: inbox http://localhost:8025, SMTP 127.0.0.1:1025')
} else if (mode === 'stop') {
  if (!docker(['rm', '-f', NAME], true)) fail()
  console.log('Mailpit stopped.')
} else {
  console.error('Usage: node scripts/mailpit.mjs [start|stop]')
  process.exit(1)
}

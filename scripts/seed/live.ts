// Live target for the seeds (`npm run seed:demo -- --target live --reset=<database>`).
//
// A live run writes the seed data into the PostgreSQL that DATABASE_URL points at (Cloud SQL through the Auth Proxy) and
// talks to the LIVE Firebase project with the Admin credentials in .env.local, but only in two narrow ways:
//   - Auth: it only LOOKS UP existing accounts by email and links them. It never creates an account, never changes one,
//     never sets a password. Every login the cast needs must already exist, or the run stops before writing anything.
//   - Storage: it uploads the product photos (new files under products/<new product id>/). Nothing existing is touched.
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { parseEnv } from 'node:util'
import type { SeedAuth, SeedBucket } from './context'

/** Any of these set means the Admin SDK would talk to an emulator instead of the live project. */
export const EMULATOR_ENV_VARS = [
  'FIREBASE_AUTH_EMULATOR_HOST',
  'FIREBASE_STORAGE_EMULATOR_HOST',
  'STORAGE_EMULATOR_HOST',
] as const

export function liveSeedEnvProblem(env: Record<string, string | undefined>): string | null {
  const set = EMULATOR_ENV_VARS.filter((name) => env[name])
  return set.length > 0
    ? `${set.join(', ')} ${set.length === 1 ? 'is' : 'are'} set: a live run must not mix the live project with emulators. ` +
        'Unset them (Remove-Item Env:<NAME> in PowerShell) and run again.'
    : null
}

export interface AdminCredentials {
  projectId: string
  clientEmail: string
  privateKey: string
}

/** FIREBASE_ADMIN_* from the environment, else from .env.local (the environment wins, as in Next.js). */
export function loadAdminCredentials(
  env: Record<string, string | undefined> = process.env,
  cwd: string = process.cwd(),
): AdminCredentials {
  const get = envReader(env, cwd)
  const projectId = get('FIREBASE_ADMIN_PROJECT_ID')
  const clientEmail = get('FIREBASE_ADMIN_CLIENT_EMAIL')
  // Same unescaping as src/lib/firebase/admin.ts.
  const privateKey = get('FIREBASE_ADMIN_PRIVATE_KEY')?.replace(/\\n/g, '\n')
  if (!projectId || !clientEmail || !privateKey) {
    throw new Error('Missing Firebase Admin credentials. Set FIREBASE_ADMIN_PROJECT_ID, FIREBASE_ADMIN_CLIENT_EMAIL and FIREBASE_ADMIN_PRIVATE_KEY in .env.local.')
  }
  return { projectId, clientEmail, privateKey }
}

/** The live Storage bucket the app reads product photos from (NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET in .env.local). */
export function liveStorageBucket(env: Record<string, string | undefined> = process.env, cwd: string = process.cwd()): string {
  const bucket = envReader(env, cwd)('NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET')
  if (!bucket) throw new Error('Missing NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET in .env.local: the live run needs it to upload the product photos.')
  return bucket
}

function envReader(env: Record<string, string | undefined>, cwd: string): (name: string) => string | undefined {
  const file = path.resolve(cwd, '.env.local')
  const fromFile = existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {}
  return (name) => env[name] || fromFile[name]
}

export class LiveAccountChangeRefusedError extends Error {}

/**
 * Wraps a live Auth client so the seed can only look accounts up. upsertSeedUser falls back to updateUser/createUser
 * when an email is unknown; on the live project that must never happen, so both refuse.
 */
export function readOnlyLiveAuth(lookup: { getUserByEmail(email: string): Promise<{ uid: string }> }): SeedAuth {
  const refuse = (email: string): never => {
    throw new LiveAccountChangeRefusedError(
      `No live Firebase login for ${email}, and a live run never creates or changes accounts. ` +
        'Create it first (Firebase console -> Authentication -> Add user), then run again.',
    )
  }
  return {
    getUserByEmail: async (email) => {
      const user = await lookup.getUserByEmail(email)
      return { uid: user.uid }
    },
    updateUser: async (_uid, props) => refuse(props.email),
    createUser: async (props) => refuse(props.email),
  }
}

/** The emails that must already have a live login: the cast's administrator and every member with `login`. */
export function castLoginEmails(cast: { admin: { email: string }; staff: { email: string; login?: boolean }[] }): string[] {
  return [cast.admin.email, ...cast.staff.filter((m) => m.login).map((m) => m.email)]
}

/** Which of `emails` have no live login. Any lookup error other than "not found" is thrown, not treated as missing. */
export async function missingLiveLogins(auth: Pick<SeedAuth, 'getUserByEmail'>, emails: string[]): Promise<string[]> {
  const missing: string[] = []
  for (const email of emails) {
    try {
      await auth.getUserByEmail(email)
    } catch (e) {
      if ((e as { code?: string }).code === 'auth/user-not-found') missing.push(email)
      else throw e
    }
  }
  return missing
}

/** Live Auth (look-up only) and the live Storage bucket. firebase-admin loads on demand, so tests never initialise it. */
export async function createLiveAuthAndBucket(
  creds: AdminCredentials,
  bucketName: string,
): Promise<{ auth: SeedAuth; bucket: SeedBucket; label: string }> {
  const { initializeApp, cert } = await import('firebase-admin/app')
  const { getAuth } = await import('firebase-admin/auth')
  const { getStorage } = await import('firebase-admin/storage')
  const app = initializeApp({ credential: cert(creds), projectId: creds.projectId, storageBucket: bucketName }, 'seed-live')
  const liveAuth = getAuth(app)
  const bucket = getStorage(app).bucket(bucketName)
  return {
    auth: readOnlyLiveAuth({ getUserByEmail: (email) => liveAuth.getUserByEmail(email) }),
    bucket: {
      save: (filePath, data, options) =>
        bucket.file(filePath).save(data, { contentType: options.contentType, metadata: { cacheControl: options.cacheControl } }),
    },
    label: `LIVE Firebase project ${creds.projectId} (Auth: look-up only; Storage bucket ${bucketName}: photo uploads)`,
  }
}

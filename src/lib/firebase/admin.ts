import 'server-only'
import { cert, getApps, initializeApp, type App } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore } from 'firebase-admin/firestore'

// Server-only Firebase Admin SDK. The `server-only` import above makes it a
// build error to accidentally import this from a client component — these
// credentials grant full admin access to the project and must never reach
// the browser bundle.
//
// Credentials come from .env.local (never committed — see .gitignore), not
// from the downloaded service-account JSON file itself.

// The demo- project id used for local emulator testing (see firebase.json /
// .firebaserc and `npm run dev:emulators`) — keep this in sync with the
// EMULATOR_PROJECT_ID in src/lib/firebase/config.ts, the client-side half
// of this same setup.
const EMULATOR_PROJECT_ID = 'demo-smartstock-nwu'

function getAdminApp(): App {
  const existing = getApps()[0]
  if (existing) return existing

  // The Admin SDK auto-detects these two host vars and silently redirects
  // every call to the local emulators instead of the real project — this
  // is Firebase's own convention, not something specific to this app. When
  // they're set, emulators don't check credentials at all, so a bare
  // projectId is enough; this deliberately avoids requiring the real
  // service-account secrets just to run local tests against fake data.
  const usingEmulator =
    !!process.env.FIREBASE_AUTH_EMULATOR_HOST || !!process.env.FIRESTORE_EMULATOR_HOST
  if (usingEmulator) {
    const projectId = process.env.FIREBASE_ADMIN_PROJECT_ID || EMULATOR_PROJECT_ID
    return initializeApp({ projectId })
  }

  const projectId = process.env.FIREBASE_ADMIN_PROJECT_ID
  const clientEmail = process.env.FIREBASE_ADMIN_CLIENT_EMAIL
  const privateKey = process.env.FIREBASE_ADMIN_PRIVATE_KEY?.replace(/\\n/g, '\n')

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error(
      'Missing Firebase Admin credentials. Set FIREBASE_ADMIN_PROJECT_ID, ' +
      'FIREBASE_ADMIN_CLIENT_EMAIL and FIREBASE_ADMIN_PRIVATE_KEY in .env.local.'
    )
  }

  return initializeApp({
    credential: cert({ projectId, clientEmail, privateKey }),
  })
}

export const adminApp = getAdminApp()
export const adminAuth = getAuth(adminApp)
export const adminDb = getFirestore(adminApp)

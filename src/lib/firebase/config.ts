import { initializeApp, getApps } from 'firebase/app';
import {
  getFirestore,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  connectFirestoreEmulator,
  type Firestore,
} from 'firebase/firestore';
import { getAuth, connectAuthEmulator } from 'firebase/auth';
import { getStorage, connectStorageEmulator } from 'firebase/storage';

// Opt-in flag for local testing against the Firebase emulators instead of
// the real project — see `npm run dev:emulators` and firebase.json. Off by
// default so the normal dev workflow is unaffected.
const USE_EMULATORS = process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATORS === 'true';
// Keep this in sync with EMULATOR_PROJECT_ID in src/lib/firebase/admin.ts.
const EMULATOR_PROJECT_ID = 'demo-smartstock-nwu';

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  // The emulators don't validate any of these except projectId — real
  // values are harmless to leave in when emulating, but the project id
  // must match the demo- id the emulators were started with.
  projectId: USE_EMULATORS ? EMULATOR_PROJECT_ID : process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  measurementId: process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID,
};

// Initialize Firebase
export const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];

// Firestore is initialized with persistent (IndexedDB-backed) offline
// cache + multi-tab support so the app can read/write while offline and
// sync automatically once connectivity returns. IndexedDB only exists in
// the browser, so on the server (SSR/build) we fall back to the plain,
// in-memory client — it's never actually used there for data access.
function createFirestore(): Firestore {
  if (typeof window === 'undefined') {
    return getFirestore(app);
  }
  try {
    return initializeFirestore(app, {
      localCache: persistentLocalCache({
        tabManager: persistentMultipleTabManager(),
      }),
    });
  } catch {
    // Firestore was already initialized for this app instance
    // (e.g. React Fast Refresh re-evaluating this module).
    return getFirestore(app);
  }
}

export const db = createFirestore();
export const auth = getAuth(app);
export const storage = getStorage(app);

// Point the Auth client SDK at the local emulator, when opted in. Unlike
// Firestore/Storage below, this must run in BOTH the browser and on the
// server: src/app/api/staff/send-reset-email/route.ts imports `auth` from
// this module and calls the client SDK's sendPasswordResetEmail() there
// (the Admin SDK can only generate a reset link, it can't send the actual
// email — see handout.md). If this were gated to the browser only, that
// server-side call would silently talk to the real Firebase project
// instead of the emulator: Firebase's email-enumeration protection makes
// sendPasswordResetEmail() return success even for an email that doesn't
// exist on the real project, so the bug wouldn't even throw — the API
// route would just report "sent" while nothing shows up in the emulator's
// oobCodes.
//
// IMPORTANT: the "only call connectXEmulator() once" guard must NOT be a
// boolean on `globalThis`. Next.js compiles page/SSR code and route-handler
// code as separate bundles, each with its own independent module instance
// of this file — so `app`/`auth` here are a genuinely different object per
// bundle, even though `globalThis` (the actual Node.js process global) is
// shared across all of them. A shared boolean flag means whichever bundle
// happens to load config.ts first "claims" the flag and every other
// bundle's own, never-connected `auth` instance silently skips the call —
// which is exactly what happened: the page bundle logged "Connected Auth"
// and flipped the flag, so the API route bundle's separate `auth` instance
// (the one actually used by sendPasswordResetEmail) never got connected,
// even though the log looked like success. Tagging the flag onto the
// instance itself, and swallowing "already connected" errors, keeps each
// bundle's own instance correctly guarded without leaking across bundles.
type TaggedAuth = typeof auth & { __emulatorConnected?: boolean };
if (USE_EMULATORS && !(auth as TaggedAuth).__emulatorConnected) {
  try {
    connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    (auth as TaggedAuth).__emulatorConnected = true;
    console.info('[firebase] Connected Auth to the local emulator.');
  } catch {
    // Already connected on this instance (e.g. Fast Refresh re-evaluating
    // this module within the same bundle) — safe to ignore.
  }
}

// Firestore/Storage are only ever read via the client SDK in the browser
// (every data-fetching page is a client component) — no server code in
// this app touches `db`/`storage` from here, so these stay browser-gated.
// Same per-instance-flag reasoning as Auth above applies here too.
type TaggedFirestore = typeof db & { __emulatorConnected?: boolean };
type TaggedStorage = typeof storage & { __emulatorConnected?: boolean };
if (USE_EMULATORS && typeof window !== 'undefined') {
  if (!(db as TaggedFirestore).__emulatorConnected) {
    try {
      connectFirestoreEmulator(db, '127.0.0.1', 8080);
      (db as TaggedFirestore).__emulatorConnected = true;
    } catch {
      // Already connected on this instance — safe to ignore.
    }
  }
  if (!(storage as TaggedStorage).__emulatorConnected) {
    try {
      connectStorageEmulator(storage, '127.0.0.1', 9199);
      (storage as TaggedStorage).__emulatorConnected = true;
    } catch {
      // Already connected on this instance — safe to ignore.
    }
  }
  console.info('[firebase] Connected Firestore/Storage to the local emulators.');
}

// One-off script: sets a project-wide Firebase Auth Password Policy on the
// REAL (live) Firebase project — NOT the emulator. This is what makes
// Firebase's own hosted password-reset/creation page (the page staff land
// on from "Send Login Email" and from the portal's own "Forgot password" /
// "Send me a password setup email" buttons) enforce a password length,
// since this app has no custom action-handler page of its own for that
// flow — see sendPasswordResetEmail() calls in
// src/app/api/staff/send-reset-email/route.ts and
// src/app/(portal)/lend/profile/page.tsx.
//
// Mirrors the in-app rule already enforced in ChangePasswordCard on the
// Profile page: 6-20 characters. No character-class requirements are
// added here (uppercase/lowercase/number/symbol) since the in-app rule
// only checks length.
//
// Run once, deliberately, against the live project:
//   node scripts/set-password-policy.mjs
//
// Uses the same real Admin SDK credentials as src/lib/firebase/admin.ts
// (FIREBASE_ADMIN_PROJECT_ID / FIREBASE_ADMIN_CLIENT_EMAIL /
// FIREBASE_ADMIN_PRIVATE_KEY from .env.local) — this script does NOT
// point at the emulator, unlike every other script in this directory.

import { config as loadEnv } from 'dotenv'

loadEnv({ path: '.env.local' })
import { cert, initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'

const projectId = process.env.FIREBASE_ADMIN_PROJECT_ID
const clientEmail = process.env.FIREBASE_ADMIN_CLIENT_EMAIL
const privateKey = process.env.FIREBASE_ADMIN_PRIVATE_KEY?.replace(/\\n/g, '\n')

if (!projectId || !clientEmail || !privateKey) {
  throw new Error(
    'Missing Firebase Admin credentials. Set FIREBASE_ADMIN_PROJECT_ID, ' +
    'FIREBASE_ADMIN_CLIENT_EMAIL and FIREBASE_ADMIN_PRIVATE_KEY in .env.local.'
  )
}

const app = initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) })
const auth = getAuth(app)

console.log(`Setting password policy on live project: ${projectId}`)

await auth.projectConfigManager().updateProjectConfig({
  passwordPolicyConfig: {
    enforcementState: 'ENFORCE',
    constraints: {
      minLength: 6,
      maxLength: 20,
    },
  },
})

const config = await auth.projectConfigManager().getProjectConfig()
console.log('Password policy now in effect:', JSON.stringify(config.passwordPolicyConfig, null, 2))

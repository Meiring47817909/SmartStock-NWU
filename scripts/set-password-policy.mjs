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
// Profile page: 6-20 characters, no character-class requirements. The
// composition flags below are set explicitly to false -- Identity
// Platform's own API defaults an omitted flag to true (a stricter
// "strong password" baseline) the first time ENFORCE is turned on for a
// project, which is why an earlier run of this script against a fresh
// project silently left uppercase + symbol requirements in place even
// though only minLength/maxLength were specified here. Confirmed via a
// live "password123" rejection: PASSWORD_DOES_NOT_MEET_REQUIREMENTS --
// Missing [uppercase, non-alphanumeric] -- so those two must be pinned
// to false, not just left out, to actually match the in-app rule.
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
      requireLowercase: false,
      requireUppercase: false,
      requireNumeric: false,
      requireNonAlphanumeric: false,
    },
  },
})

const config = await auth.projectConfigManager().getProjectConfig()
console.log('Password policy now in effect:', JSON.stringify(config.passwordPolicyConfig, null, 2))

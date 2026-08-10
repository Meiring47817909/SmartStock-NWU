import 'server-only'
import { NextRequest, NextResponse } from 'next/server'
import { XMLParser } from 'fast-xml-parser'
import { adminAuth, adminDb } from '@/lib/firebase/admin'
import type { Role } from '@/types/database'

const CAS_VALIDATE_URL = 'https://casprd.nwu.ac.za/cas/p3/serviceValidate'

interface CasSuccessBody {
  serviceResponse?: {
    authenticationSuccess?: { user?: string }
    authenticationFailure?: { '#text'?: string; '@_code'?: string }
  }
}

/**
 * Validates an NWU-CAS service ticket, checks the resulting username
 * against the `cas_allowlist` Firestore collection, and — only for
 * allowlisted usernames — mints a Firebase custom token so the client can
 * sign in via `signInWithCustomToken`. CAS successfully authenticating
 * someone is not, by itself, authorization to use this app.
 */
export async function GET(request: NextRequest) {
  const ticket = request.nextUrl.searchParams.get('ticket')
  const service = request.nextUrl.searchParams.get('service')

  if (!ticket || !service) {
    return NextResponse.json({ error: 'Missing ticket or service parameter.' }, { status: 400 })
  }

  // 1. Validate the ticket against NWU's CAS server (server-to-server —
  // this can never be done from the browser: no CORS, and a ticket must
  // only ever be trusted after CAS itself confirms it).
  let xmlBody: string
  try {
    const casUrl = `${CAS_VALIDATE_URL}?ticket=${encodeURIComponent(ticket)}&service=${encodeURIComponent(service)}`
    const casResponse = await fetch(casUrl)
    xmlBody = await casResponse.text()
  } catch (err) {
    console.error('CAS validation request failed:', err)
    return NextResponse.json({ error: 'Could not reach the NWU-CAS server.' }, { status: 502 })
  }

  const parser = new XMLParser({ removeNSPrefix: true, ignoreAttributes: false })
  let parsed: CasSuccessBody
  try {
    parsed = parser.parse(xmlBody)
  } catch (err) {
    console.error('CAS XML parse error:', err, xmlBody)
    return NextResponse.json({ error: 'Could not parse the NWU-CAS response.' }, { status: 502 })
  }

  const username = parsed.serviceResponse?.authenticationSuccess?.user
  if (!username) {
    return NextResponse.json({ error: 'NWU-CAS login failed or the ticket was invalid.' }, { status: 401 })
  }

  // 2. CAS confirmed who they are — now check whether they're allowed to
  // use SmartStock-NWU at all, and with what role.
  const allowlistSnap = await adminDb.collection('cas_allowlist').doc(username).get()
  if (!allowlistSnap.exists) {
    return NextResponse.json(
      { error: `Your NWU account (${username}) isn't authorized for SmartStock-NWU. Contact an administrator to be added.` },
      { status: 403 }
    )
  }
  const role = (allowlistSnap.data()?.role ?? 'staff') as Role

  // 3. Get-or-create the Firebase Auth identity and Firestore profile for
  // this CAS user, keeping the role in sync with the allowlist on every
  // login (so revoking/changing access there takes effect immediately).
  const uid = `cas_${username}`
  try {
    await adminAuth.getUser(uid)
  } catch {
    await adminAuth.createUser({ uid, displayName: username })
  }

  const profileRef = adminDb.collection('profiles').doc(uid)
  const profileSnap = await profileRef.get()
  if (!profileSnap.exists) {
    await profileRef.set({
      id: uid,
      full_name: username,
      role,
      created_at: new Date().toISOString(),
    })
  } else {
    await profileRef.set({ role }, { merge: true })
  }

  // 4. Mint a Firebase custom token — the client exchanges this for a real
  // signed-in session via signInWithCustomToken, same as any other login.
  const token = await adminAuth.createCustomToken(uid)

  return NextResponse.json({ token, username, role })
}

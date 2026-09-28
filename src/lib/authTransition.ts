// A one-shot flag so an intentional sign-out can tell the layout guards
// below that the `user: null` they're about to see is expected, and not a
// reason to bounce to /login.
//
// Why this exists: signOut() flips AuthContext's `user` to null (via
// onAuthStateChanged) before — or interleaved with — the caller's own
// post-logout router.push() actually lands. Both (protected)/layout.tsx and
// (portal)/lend/layout.tsx have their own "no user here, redirect" effect
// keyed off that same `user` value, so without this flag their redirect
// fires first and wins the race, silently overwriting wherever the sign-out
// handler actually meant to send the user (see Sidebar.tsx's and
// lend/layout.tsx's own handleLogout/handleSignOut).
let loggingOut = false

export function markLoggingOut() {
  loggingOut = true
}

// Read-and-clear: only the one `user: null` transition an intentional
// sign-out caused gets suppressed, never a later, unrelated one (an expired
// session, a revoked token) that also lands here with no user signed in.
export function consumeLoggingOut(): boolean {
  const was = loggingOut
  loggingOut = false
  return was
}

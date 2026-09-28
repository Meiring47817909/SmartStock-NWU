import { redirect } from 'next/navigation'

// Public landing → straight into the lending portal (Browse works without
// signing in — see StaffPortalContext's anonymous-session fallback and
// (portal)/lend/layout.tsx's isGuest handling). An already-signed-in BICS
// admin who bookmarks the bare root URL now lands here too rather than on
// /dashboard directly; they can still get there via the sidebar/login flow.
export default function Home() {
  redirect('/lend')
}

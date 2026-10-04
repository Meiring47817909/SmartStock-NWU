// The contact address shown to people on the login screen and in the lending
// portal ("contact ... for more information"). It is the "Admin notification
// address" saved under Settings -> Notifications, so changing it there changes
// it everywhere. Only the address is ever shown, never a person's name.
//
// Signed-out visitors and portal borrowers cannot read the settings API
// (admin only), so this reads it through GET /api/contact.

// Shown when nothing is saved yet or the request fails, so there is never a
// blank or a broken mailto link.
export const FALLBACK_CONTACT_EMAIL = 'jonathan.pritchard@nwu.ac.za'

export async function fetchContactEmail(): Promise<string> {
  try {
    const res = await fetch('/api/contact', { cache: 'no-store' })
    if (!res.ok) return FALLBACK_CONTACT_EMAIL
    const data = await res.json()
    const email = typeof data?.email === 'string' ? data.email.trim() : ''
    return email || FALLBACK_CONTACT_EMAIL
  } catch {
    return FALLBACK_CONTACT_EMAIL
  }
}

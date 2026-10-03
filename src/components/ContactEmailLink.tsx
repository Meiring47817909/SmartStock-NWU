'use client'

import { useEffect, useState } from 'react'
import { fetchContactEmail } from '@/lib/contactEmail'

// The contact email as a mailto link. Read fresh each time the page loads, so
// a change under Settings -> Notifications shows up on the next load. Renders
// nothing for a moment while it loads rather than flashing a stale address.
export function ContactEmailLink() {
  const [email, setEmail] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    fetchContactEmail().then((value) => {
      if (alive) setEmail(value)
    })
    return () => {
      alive = false
    }
  }, [])

  if (!email) return null
  return (
    <a href={`mailto:${email}`} className="underline">
      {email}
    </a>
  )
}

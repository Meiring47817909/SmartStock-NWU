'use client'

import { useRouter } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { ContactEmailLink } from '@/components/ContactEmailLink'

// Same "long-form legal/policy page" template as campus-marketplace's own
// /terms page (Project_files_Claude_Code/campus-marketplace/src/app/terms) —
// a centered, narrow card with a title, numbered h2 sections, and a Go Back
// button at the end — rebuilt on this app's own shadcn Card/Button and
// text-foreground/text-muted-foreground tokens instead of that project's
// raw bg-white/text-gray-700 classes. Content itself is grounded in
// LENDING_PORTAL_SPEC.md §1 and §3.3/3.4 (the actual approval, expiry, and
// no-show rules this portal implements), not generic boilerplate.
export default function LendingPolicyPage() {
  const router = useRouter()

  function handleBack() {
    if (window.history.length > 1) {
      router.back()
    } else {
      router.push('/lend')
    }
  }

  return (
    <div className="mx-auto max-w-[1000px]">
      <Card className="rounded-xl border border-[#E2D8E9] bg-white shadow-sm ring-0">
        <CardContent className="p-8">
          <h1 className="text-center text-3xl font-extrabold tracking-tight text-[#22162B]">
            Equipment Lending Policy
          </h1>

          <p className="mt-4 text-sm text-muted-foreground">
            This page covers how borrowing works through the SmartStock lending portal —
            what you can request, how approval works, and what happens at pickup. It applies to
            every loan request submitted through this portal.
          </p>

          <h2 className="mt-6 mb-2 text-lg font-semibold text-foreground">1. Purpose</h2>
          <p className="mb-4 text-sm text-muted-foreground">
            The lending portal lets NWU staff request IT Store equipment — laptops, projectors,
            cables, and other stock — to borrow for a set period, without needing to visit the
            Potchefstroom BICS IT Service Desk in person just to ask what&apos;s available.
          </p>

          <h2 className="mt-6 mb-2 text-lg font-semibold text-foreground">2. Who Can Borrow</h2>
          <p className="mb-4 text-sm text-muted-foreground">
            Only NWU staff members with a linked SmartStock account can submit loan requests.
            If you can sign in but see a message that your account isn&apos;t linked to a staff
            record, email the address under Enquiries below to have it set up.
          </p>

          <h2 className="mt-6 mb-2 text-lg font-semibold text-foreground">3. Requesting Equipment</h2>
          <p className="mb-4 text-sm text-muted-foreground">
            Add what you need to your cart, choose a single pickup-to-return date range that
            covers everything in it, and submit — an optional message can go along with the
            request. Dates must fall within each item&apos;s own lendable window. Adding something
            to your cart does not reserve it: equipment is only held for you once Jonathan approves
            the request.
          </p>

          <h2 className="mt-6 mb-2 text-lg font-semibold text-foreground">4. Jonathan&apos;s Review</h2>
          <p className="mb-4 text-sm text-muted-foreground">
            Jonathan reviews every request and can approve it as submitted, or send back a
            counter — a reduced quantity or an adjusted date range — if the exact request can&apos;t
            be met. You&apos;ll see exactly what changed on any counter, and can accept or decline it.
          </p>

          <h2 className="mt-6 mb-2 text-lg font-semibold text-foreground">5. Loan Duration &amp; Pickup Window</h2>
          <p className="mb-4 text-sm text-muted-foreground">
            Requests cover a maximum of 7 days from pickup to return. Once approved, a request
            stays open for pickup at the Potchefstroom BICS IT Service Desk until 7 days after it
            was last updated, or your requested start date — whichever comes first. If it isn&apos;t
            picked up by then, it expires automatically.
          </p>

          <h2 className="mt-6 mb-2 text-lg font-semibold text-foreground">6. Cancelling or Changing a Request</h2>
          <p className="mb-4 text-sm text-muted-foreground">
            You can withdraw a request at any point before pickup — while it&apos;s awaiting review,
            while a counter is outstanding, or after it&apos;s been approved. To change the quantities
            or dates on an approved request, withdraw it and submit a new one.
          </p>

          <h2 className="mt-6 mb-2 text-lg font-semibold text-foreground">7. No-Shows</h2>
          <p className="mb-4 text-sm text-muted-foreground">
            If an approved request isn&apos;t collected by its start date, it&apos;s marked as a
            no-show and the reservation is released back into stock for other staff to request.
          </p>

          <h2 className="mt-6 mb-2 text-lg font-semibold text-foreground">8. Caring for Borrowed Equipment</h2>
          <p className="mb-4 text-sm text-muted-foreground">
            Treat borrowed equipment as you would your own — report any damage or loss to the IT
            Store as soon as possible, and return everything by the agreed date so it&apos;s
            available for the next person who needs it.
          </p>

          <h2 className="mt-6 mb-2 text-lg font-semibold text-foreground">9. Enquiries</h2>
          <p className="mb-8 text-sm text-muted-foreground">
            For anything not covered here — an urgent request, a question about availability, or
            help with your account — contact{' '}
            <ContactEmailLink />.
          </p>

          <h2 id="privacy-cookies" className="mt-6 mb-2 text-lg font-semibold text-foreground">10. Privacy &amp; Cookies</h2>
          <p className="mb-4 text-sm text-muted-foreground">
            The portal only uses cookies that are strictly necessary for it to work — keeping
            you signed in and remembering basic interface choices. It does not use cookies for
            advertising or analytics.
          </p>
          <p className="mb-8 text-sm text-muted-foreground">
            Your information — contact details, loan requests, and pickup history — is processed
            in line with South Africa&apos;s Protection of Personal Information Act (POPIA), and
            used only to run the lending service itself. It is not shared outside NWU IT Store
            operations. Email the address under Enquiries above with any question about your
            data.
          </p>

          <div className="flex justify-center">
            <Button variant="outline" onClick={handleBack}>
              <ArrowLeft className="size-4" /> Go Back
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

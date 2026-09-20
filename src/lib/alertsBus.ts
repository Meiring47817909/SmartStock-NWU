// Tiny pub/sub so a page that mutates something the Sidebar's badge counts
// depend on — resolving an outstanding return, cancelling a pickup,
// approving/countering/declining a loan request — can tell the Sidebar to
// refresh those counts right away, without a full page reload.
//
// Why this exists: the Sidebar loads its two badge counts (Dashboard,
// Loan Requests — see dashboardAlerts.ts / loanRequests.ts's
// loadLoanRequestsAlertCount) once on mount and again whenever the admin
// navigates to/from the page that badge is for. That's enough to catch a
// change made on a *different* page (Stock Out issuing units that push a
// product under its reorder threshold, say) because navigating away and
// back toggles that dependency. It is NOT enough for a mutation made
// without leaving the page the badge is about — e.g. resolving an
// Outstanding Return right there on the Dashboard, which patches that
// page's own local state instead of navigating anywhere, so the pathname
// never changes and the Sidebar's effect never re-fires. Call
// notifyAlertsChanged() right after any such in-place mutation.
type Listener = () => void
const listeners = new Set<Listener>()

export function notifyAlertsChanged() {
  listeners.forEach((listener) => listener())
}

export function subscribeToAlertsChanged(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

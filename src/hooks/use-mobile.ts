import * as React from "react"

const MOBILE_BREAKPOINT = 768
// A phone turned sideways is wider than 768px but very short. It counts as
// mobile too, so it keeps the top navigation bar instead of the sidebar.
// Keep both numbers in sync with the "roomy" variant in globals.css (the
// exact opposite of this query).
const SHORT_SCREEN_HEIGHT = 500
const MOBILE_QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px), (max-height: ${SHORT_SCREEN_HEIGHT - 1}px)`

function subscribe(onChange: () => void) {
  const mql = window.matchMedia(MOBILE_QUERY)
  mql.addEventListener("change", onChange)
  return () => mql.removeEventListener("change", onChange)
}

export function useIsMobile() {
  return React.useSyncExternalStore(
    subscribe,
    () => window.matchMedia(MOBILE_QUERY).matches,
    // On the server (and the first client render) assume a desktop screen.
    () => false,
  )
}

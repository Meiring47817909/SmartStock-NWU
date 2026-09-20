import type { FirestoreError } from 'firebase/firestore'

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// onAuthStateChanged can fire before Firestore's outgoing requests have
// actually picked up the fresh ID token — the very first Firestore call
// made from inside that callback, right after a sign-in, can go out
// effectively unauthenticated and get a spurious permission-denied, even
// for a rule that would allow it once the token catches up (e.g. a
// profiles/{uid} read gated on request.auth.uid == uid). Wrap any such call
// with this to absorb that one-time race without masking a genuine
// permission problem — a real denial fails identically on the retry, so
// nothing gets silently allowed that shouldn't be.
export async function withAuthRaceRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if ((e as FirestoreError).code !== 'permission-denied') throw e
    await sleep(300)
    return fn()
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// onAuthStateChanged can fire before the fresh ID token is usable — the very
// first call made from inside that callback, right after a sign-in, can go out
// effectively unauthenticated and get a spurious rejection, even though it
// would succeed once the token catches up. Two shapes of that rejection are
// absorbed: a Firestore 'permission-denied' (the original Firestore reads) and
// an HTTP 401 from our own /api routes (a ClientApiError whose `status` is 401,
// i.e. the token was missing or not yet accepted). Wrap any such call with this
// to absorb that one-time race without masking a genuine problem — a real
// denial fails identically on the retry, so nothing gets silently allowed that
// shouldn't be.
export async function withAuthRaceRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    const err = e as { code?: string; status?: number }
    if (err?.code !== 'permission-denied' && err?.status !== 401) throw e
    await sleep(300)
    return fn()
  }
}

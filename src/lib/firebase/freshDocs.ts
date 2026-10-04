// Reads a collection/query straight from the server so the Sidebar badges
// can never be served from Firestore's persistent (IndexedDB) cache -- the
// cache is what a plain getDocs() falls back to whenever the connection is
// still being established right after a page refresh, which showed stale
// counts until the next navigation. Falls back to the normal cache-aware
// read when the server can't be reached (offline).
import { getDocs, getDocsFromServer, type Query, type QuerySnapshot, type DocumentData } from 'firebase/firestore'

export async function getDocsFresh(q: Query<DocumentData>): Promise<QuerySnapshot<DocumentData>> {
  try {
    return await getDocsFromServer(q)
  } catch {
    return getDocs(q)
  }
}

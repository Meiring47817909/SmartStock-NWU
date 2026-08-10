import { defaultCache } from '@serwist/next/worker'
import type { PrecacheEntry, SerwistGlobalConfig } from 'serwist'
import { Serwist } from 'serwist'

// This declares the value of `injectionPoint` to TypeScript.
// `injectionPoint` is the string that will be replaced by the
// actual precache manifest at build time.
declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined
  }
}

declare const self: ServiceWorkerGlobalScope

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  // Caches app-shell pages (HTML/JS/CSS) as they're visited, using a
  // network-first strategy so cached pages are available offline.
  // Firestore's own persistent local cache (see lib/firebase/config.ts)
  // supplies the actual inventory data once the shell has loaded.
  runtimeCaching: defaultCache,
})

serwist.addEventListeners()

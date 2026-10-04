// Firebase Storage helpers for product images.
//
// We store *paths* (e.g. "products/<id>/1699999999-0-photo.jpg") in
// the database rather than resolved download URLs — URLs can change (tokens,
// bucket moves) but a storage path is stable, and it's what deleteObject()
// needs anyway. storageDownloadUrl() turns a path into a fetchable URL for
// <img> tags.

const BUCKET = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET

// Same opt-in flag as src/lib/firebase/config.ts — when set, every Storage
// path resolves against the local emulator's REST endpoint instead of the
// real bucket. Without this, images uploaded to the Storage emulator would
// never actually load in dev: this function would keep pointing at
// firebasestorage.googleapis.com regardless of which Storage instance
// config.ts connected the SDK to. Note config.ts deliberately does NOT
// override storageBucket for emulator mode (only projectId) — the real
// bucket name is harmless to keep since the emulator accepts requests for
// any bucket name and serves them locally — so this still needs to use the
// same real BUCKET value, just against the emulator's host instead.
const USE_EMULATORS = process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATORS === 'true'
const EMULATOR_STORAGE_HOST = '127.0.0.1:9199'

export function storageDownloadUrl(path: string): string {
  const host = USE_EMULATORS ? `http://${EMULATOR_STORAGE_HOST}` : 'https://firebasestorage.googleapis.com'
  return `${host}/v0/b/${BUCKET}/o/${encodeURIComponent(path)}?alt=media`
}

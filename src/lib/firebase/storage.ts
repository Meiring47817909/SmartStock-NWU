// Firebase Storage helpers for product images.
//
// We store *paths* (e.g. "products/<id>/1699999999-0-photo.jpg") in
// Firestore rather than resolved download URLs — URLs can change (tokens,
// bucket moves) but a storage path is stable, and it's what deleteObject()
// needs anyway. storageDownloadUrl() turns a path into a fetchable URL for
// <img> tags.

const BUCKET = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET

export function storageDownloadUrl(path: string): string {
  return `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/${encodeURIComponent(path)}?alt=media`
}

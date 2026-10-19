import 'server-only'
import { assertAdmin, DataError, type Ctx } from '@/server/context'
import {
  MAX_PRODUCT_IMAGE_BYTES,
  imageTypeMatchesBytes,
  isProductIdForImages,
  isProductImageContentType,
  isProductImagePath,
  productImagePath,
} from '@/lib/productImageRules'

// Product photos live in Firebase Storage, but only this server writes or
// deletes them: the caller is checked against Cloud SQL (assertAdmin reads
// profiles.role) exactly like every other admin action, then the Admin SDK
// saves the file. storage.rules therefore refuses all writes from browsers,
// and Firestore plays no part in deciding who is an admin.

export interface ImageStore {
  save(path: string, data: Buffer, contentType: string): Promise<void>
  remove(path: string): Promise<void>
}

let testStore: ImageStore | null = null

/** Tests swap in an in-memory store so Firebase Admin is never initialised. */
export function setImageStoreForTests(store: ImageStore | null): void {
  testStore = store
}

async function imageStore(): Promise<ImageStore> {
  if (testStore) return testStore
  const bucketName = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET
  if (!bucketName) throw new Error('NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET is not set.')
  // Loaded on demand: in emulator mode firebase-admin follows FIREBASE_STORAGE_EMULATOR_HOST.
  const { adminApp } = await import('@/lib/firebase/admin')
  const { getStorage } = await import('firebase-admin/storage')
  const bucket = getStorage(adminApp).bucket(bucketName)
  return {
    save: async (path, data, contentType) => {
      await bucket.file(path).save(data, { contentType, resumable: false, metadata: { cacheControl: 'public, max-age=3600' } })
    },
    remove: async (path) => {
      await bucket.file(path).delete()
    },
  }
}

export type UploadImageInput = {
  productId?: unknown
  index?: unknown
  fileName?: unknown
  contentType?: unknown
  dataBase64?: unknown
}

/** Stores one photo under products/<productId>/ and returns its storage path (what products.images holds). */
export async function uploadProductImage(ctx: Ctx, input: UploadImageInput): Promise<{ path: string }> {
  assertAdmin(ctx)
  const { productId, index, fileName, contentType, dataBase64 } = input
  if (typeof productId !== 'string' || !isProductIdForImages(productId)) throw new DataError(400, 'Invalid product id.')
  if (typeof fileName !== 'string' || !fileName.trim()) throw new DataError(400, 'A file name is required.')
  if (typeof contentType !== 'string' || !isProductImageContentType(contentType)) {
    throw new DataError(400, 'Photos must be JPEG, PNG, WebP or GIF images.')
  }
  const position = typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < 100 ? index : 0
  if (typeof dataBase64 !== 'string') throw new DataError(400, 'The photo is not a valid image.')
  if (dataBase64 === '') throw new DataError(400, 'The photo is empty.')
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(dataBase64)) throw new DataError(400, 'The photo is not a valid image.')
  // Checked on the encoded length first, so an oversized body is refused without decoding it.
  if (Math.floor(dataBase64.length * 3 / 4) > MAX_PRODUCT_IMAGE_BYTES + 2) {
    throw new DataError(400, 'The photo is too large (max 3 MB).')
  }
  const data = Buffer.from(dataBase64, 'base64')
  if (data.length > MAX_PRODUCT_IMAGE_BYTES) throw new DataError(400, 'The photo is too large (max 3 MB).')
  if (!imageTypeMatchesBytes(contentType, data)) throw new DataError(400, 'The photo is not a valid image of that type.')

  const path = productImagePath(productId, position, fileName, ctx.now().getTime())
  await (await imageStore()).save(path, data, contentType)
  return { path }
}

/** Deletes product photos. Every path is checked before anything is removed; a photo that is already gone is fine. */
export async function deleteProductImages(ctx: Ctx, input: { paths?: unknown }): Promise<{ deleted: number }> {
  assertAdmin(ctx)
  const { paths } = input
  if (!Array.isArray(paths) || paths.length > 10 || !paths.every((p) => typeof p === 'string')) {
    throw new DataError(400, 'paths must be a list of up to 10 photo paths.')
  }
  const bad = (paths as string[]).find((p) => !isProductImagePath(p))
  if (bad !== undefined) throw new DataError(400, `"${bad}" is not a product photo.`)

  const store = await imageStore()
  let deleted = 0
  for (const path of paths as string[]) {
    try {
      await store.remove(path)
      deleted++
    } catch (err) {
      if ((err as { code?: unknown })?.code !== 404) throw err
    }
  }
  return { deleted }
}

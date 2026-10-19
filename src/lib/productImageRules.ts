// Rules for product photos, shared by the Products page (browser) and the
// /api/products/images route (server). Photos are stored in Firebase Storage
// under products/<productId>/<file>; only the server writes or deletes them,
// after checking the caller is an admin in Cloud SQL.

/**
 * Largest photo the server accepts. The browser sends it base64-encoded in a
 * JSON body, which adds a third, and a Vercel function accepts at most 4.5 MB.
 * Bigger photos are scaled down in the browser first (prepareProductImage).
 */
export const MAX_PRODUCT_IMAGE_BYTES = 3 * 1024 * 1024

/** Longest side, in pixels, a photo is scaled down to when it is too large to send as is. */
export const PRODUCT_IMAGE_MAX_SIDE = 2000

const CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const

/** The photo types the store accepts. SVG is left out on purpose: it can carry script. */
export function isProductImageContentType(type: string): boolean {
  return (CONTENT_TYPES as readonly string[]).includes(type)
}

/** Product ids are the 20-character ids from newId()/newProductId(); allow a little slack but nothing path-like. */
export function isProductIdForImages(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(id)
}

function safeFileName(fileName: string): string {
  let name = fileName.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  if (!name || /^\.+$/.test(name)) return 'image'
  if (name.length > 60) {
    const ext = name.match(/\.[A-Za-z0-9]{1,5}$/)?.[0] ?? ''
    name = name.slice(0, 60 - ext.length) + ext
  }
  return name
}

/** Where a newly uploaded photo is stored: products/<productId>/<time>-<position>-<safe file name>. */
export function productImagePath(productId: string, index: number, fileName: string, now: number): string {
  return `products/${productId}/${now}-${index}-${safeFileName(fileName)}`
}

/**
 * True for a path inside products/<productId>/ and nowhere else (no sub-folders, no "..").
 * The file name part is not limited to safe characters, because photos uploaded before
 * safeFileName existed kept the browser's original file name.
 */
export function isProductImagePath(path: string): boolean {
  const parts = path.split('/')
  if (parts.length !== 3 || parts[0] !== 'products') return false
  const [, productId, file] = parts
  if (!isProductIdForImages(productId)) return false
  if (!file || file === '.' || file === '..' || /[\x00-\x1f\\]/.test(file)) return false
  return true
}

/** Checks the first bytes really are the claimed image type, so a renamed HTML or script file is refused. */
export function imageTypeMatchesBytes(type: string, data: Uint8Array): boolean {
  const starts = (...sig: number[]) => sig.every((b, i) => data[i] === b)
  switch (type) {
    case 'image/jpeg':
      return data.length > 3 && starts(0xff, 0xd8, 0xff)
    case 'image/png':
      return data.length > 8 && starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
    case 'image/gif':
      return data.length > 6 && starts(0x47, 0x49, 0x46, 0x38)
    case 'image/webp':
      return data.length > 12 && starts(0x52, 0x49, 0x46, 0x46) &&
        data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50
    default:
      return false
  }
}

/** Scales width/height down so the longer side is at most `max`, keeping the shape. Never scales up. */
export function fitWithin(width: number, height: number, max: number): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height))
  return { width: Math.round(width * scale), height: Math.round(height * scale) }
}

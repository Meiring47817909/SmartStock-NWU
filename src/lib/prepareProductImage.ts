// Browser-only: makes a picked photo fit what /api/products/images accepts.
// A JPEG/PNG/WebP/GIF under the size limit is sent unchanged; anything larger
// (a phone photo, say) or in another format the browser can decode (HEIC on
// Safari) is redrawn as a JPEG, shrinking until it fits.
import {
  MAX_PRODUCT_IMAGE_BYTES,
  PRODUCT_IMAGE_MAX_SIDE,
  fitWithin,
  isProductImageContentType,
} from '@/lib/productImageRules'

function toJpeg(source: ImageBitmap, maxSide: number, quality: number): Promise<Blob | null> {
  const { width, height } = fitWithin(source.width, source.height, maxSide)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const g = canvas.getContext('2d')
  if (!g) return Promise.resolve(null)
  g.fillStyle = '#ffffff' // transparent PNG areas become white, not black
  g.fillRect(0, 0, width, height)
  g.drawImage(source, 0, 0, width, height)
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality))
}

export async function prepareProductImage(file: File): Promise<File> {
  if (isProductImageContentType(file.type) && file.size <= MAX_PRODUCT_IMAGE_BYTES) return file

  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new Error(`"${file.name}" can't be used — choose a JPEG, PNG, WebP or GIF photo.`)
  }
  try {
    const name = file.name.replace(/\.[^.]*$/, '') + '.jpg'
    let maxSide = PRODUCT_IMAGE_MAX_SIDE
    for (let attempt = 0; attempt < 6; attempt++) {
      const blob = await toJpeg(bitmap, maxSide, 0.85)
      if (blob && blob.size <= MAX_PRODUCT_IMAGE_BYTES) return new File([blob], name, { type: 'image/jpeg' })
      maxSide = Math.round(maxSide * 0.75)
    }
  } finally {
    bitmap.close()
  }
  throw new Error(`"${file.name}" is too large to upload.`)
}

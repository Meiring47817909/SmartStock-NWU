import { route } from '@/server/http'
import { DataError } from '@/server/context'
import { deleteProductImages, uploadProductImage, type UploadImageInput } from '@/server/productImages'

// Product photos (admin only, checked against Cloud SQL):
//   { action: 'upload', productId, index, fileName, contentType, dataBase64 } → { path }
//   { action: 'delete', paths: string[] }                                     → { deleted }
// The browser never writes to Firebase Storage itself; see src/server/productImages.ts.
type Body = UploadImageInput & { action?: unknown; paths?: unknown }

export const POST = route<Body>('admin', async (ctx, body) => {
  switch (body.action) {
    case 'upload':
      return uploadProductImage(ctx, body)
    case 'delete':
      return deleteProductImages(ctx, body)
    default:
      throw new DataError(400, 'Unknown action.')
  }
})

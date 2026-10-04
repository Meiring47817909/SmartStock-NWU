import { route } from '@/server/http'
import { DataError } from '@/server/context'
import { deleteProduct, getProduct, updateProduct } from '@/server/data/catalog'
import type { ProductInput } from '@/lib/catalogRules'

// GET  /api/products/<id>                                    → Product (404 when missing; public)
// POST /api/products/<id> { action: 'update', product }      → Product (admin)
// POST /api/products/<id> { action: 'delete' }               → { ok: true } (admin; 409 with the reason while in use)
export const GET = route('public', async (ctx, _query, _req, params) => {
  const product = await getProduct(ctx, params.id)
  if (!product) throw new DataError(404, 'Product not found.')
  return product
})

export const POST = route<{ action?: string; product?: ProductInput }>('admin', async (ctx, body, _req, params) => {
  switch (body.action) {
    case 'update':
      return updateProduct(ctx, params.id, body.product as ProductInput)
    case 'delete':
      await deleteProduct(ctx, params.id)
      return { ok: true }
    default:
      throw new DataError(400, 'Unknown action.')
  }
})

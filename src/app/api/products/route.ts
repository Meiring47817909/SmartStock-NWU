import { route } from '@/server/http'
import { createProduct, listProducts } from '@/server/data/catalog'
import type { ProductInput } from '@/lib/catalogRules'

// GET  /api/products[?availableOnly=true]  → Product[]   (public: products are readable without signing in)
// POST /api/products  <ProductInput>        → Product     (admin)
export const GET = route<{ availableOnly?: string }>('public', async (ctx, query) =>
  listProducts(ctx, { availableOnly: query.availableOnly === 'true' }),
)

export const POST = route<ProductInput>('admin', async (ctx, body) => createProduct(ctx, body))

import { route } from '@/server/http'
import { DataError } from '@/server/context'
import { createCategory, deleteCategory, listCategories, updateCategory } from '@/server/data/catalog'

// Categories (admin only).
//   GET  /api/categories                                              → Category[] (by name)
//   POST /api/categories { action: 'create', name, description }      → Category
//   POST /api/categories { action: 'update', id, name, description }  → Category
//   POST /api/categories { action: 'delete', id }                     → { ok: true }   (409 while products use it)
type Body = { action?: string; id?: string; name?: string; description?: string }

export const GET = route('admin', async (ctx) => listCategories(ctx))

export const POST = route<Body>('admin', async (ctx, body) => {
  const input = { name: body.name as string, description: body.description as string }
  switch (body.action) {
    case 'create':
      return createCategory(ctx, input)
    case 'update':
      return updateCategory(ctx, String(body.id ?? ''), input)
    case 'delete':
      await deleteCategory(ctx, String(body.id ?? ''))
      return { ok: true }
    default:
      throw new DataError(400, 'Unknown action.')
  }
})

import { route } from '@/server/http'
import { listOutstandingForStaff } from '@/server/data/stock'

// GET /api/stock/outstanding?staffId=<id> → { lines, unscannable }   (admin; the Returns page)
// What the staff member still has out, per Stock Out, product and barcode, oldest first.
export const GET = route<{ staffId?: string }>('admin', async (ctx, query) => listOutstandingForStaff(ctx, query.staffId ?? ''))

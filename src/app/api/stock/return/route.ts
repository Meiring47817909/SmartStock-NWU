import { route } from '@/server/http'
import { recordReturn } from '@/server/data/stock'
import type { ReturnInput } from '@/lib/stockRules'

// POST /api/stock/return <ReturnInput> → { id, reference_no }   (admin)
// Settles units against ONE OUT transaction (call once per Stock Out being returned against). 400 for a barcode that was
// not issued on it or more than is still out.
export const POST = route<ReturnInput>('admin', async (ctx, body) => recordReturn(ctx, body))

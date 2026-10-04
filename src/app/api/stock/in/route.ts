import { route } from '@/server/http'
import { recordStockIn } from '@/server/data/stock'
import type { StockInInput } from '@/lib/stockRules'

// POST /api/stock/in <StockInInput> → { id, reference_no }   (admin)
// One database transaction: the IN transaction, its lines, the quantity increases and the audit entry.
export const POST = route<StockInInput>('admin', async (ctx, body) => recordStockIn(ctx, body))

import { route } from '@/server/http'
import { recordStockOut } from '@/server/data/stock'
import type { StockOutInput } from '@/lib/stockRules'

// POST /api/stock/out <StockOutInput> → { id, reference_no }   (admin)
// One database transaction: the OUT transaction, its lines, the quantity decreases and the audit entry, plus (with
// linkedRequestId) the loan request marked fulfilled and its audit entry. 409 "Not enough stock for <product>." when a
// product would go below zero. The confirmation emails are a separate call (POST /api/notifications/stock-out).
export const POST = route<StockOutInput>('admin', async (ctx, body) => recordStockOut(ctx, body))

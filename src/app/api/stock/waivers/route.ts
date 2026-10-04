import { route } from '@/server/http'
import { DataError } from '@/server/context'
import { createReturnWaiver, loadWaivedByTxn, loadWaivers } from '@/server/data/stock'
import type { CreateReturnWaiverInput } from '@/lib/stockRules'

// Return waivers (items a staff member keeps, written off without a return). Append-only: there is no update or delete.
//   GET  /api/stock/waivers                → ReturnWaiver[], oldest first          (admin)
//   GET  /api/stock/waivers?kind=byTxn     → { [outTxnId]: { [productId]: qty } }  (admin)
//   POST /api/stock/waivers <CreateReturnWaiverInput> → { id }  the waiver id      (admin; 409 when nothing is outstanding)
export const GET = route<{ kind?: string }>('admin', async (ctx, query) => {
  switch (query.kind) {
    case undefined:
    case '':
      return loadWaivers(ctx)
    case 'byTxn':
      return loadWaivedByTxn(ctx)
    default:
      throw new DataError(400, 'Unknown request.')
  }
})

export const POST = route<CreateReturnWaiverInput>('admin', async (ctx, body) => ({ id: await createReturnWaiver(ctx, body) }))

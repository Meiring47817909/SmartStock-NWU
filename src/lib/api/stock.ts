// Browser client for the stock API. Same function names as the old Firestore helpers where there were any
// (loadWaivedByTxn, loadWaivers, createReturnWaiver), minus the server-side `ctx`.
//
// Routes (all JSON, all admin; the Firebase ID token is attached by api()):
//   POST /api/stock/in                  recordStockIn
//   POST /api/stock/out                 recordStockOut (marks a linked loan request fulfilled in the same transaction)
//   POST /api/stock/return              recordReturn (one OUT transaction per call)
//   GET  /api/stock/waivers[?kind=byTxn]    loadWaivers / loadWaivedByTxn
//   POST /api/stock/waivers             createReturnWaiver
//   GET  /api/stock/outstanding?staffId=…   listOutstandingForStaff
// The confirmation emails after a Stock Out are not part of these calls (POST /api/notifications/stock-out).
import { api } from '@/lib/api/client'
import type { ReturnWaiver } from '@/types/database'
import type {
  CreateReturnWaiverInput,
  OutstandingForStaff,
  ReturnInput,
  StockInInput,
  StockMovementResult,
  StockOutInput,
  WaivedByTxn,
} from '@/lib/stockRules'

export { waivedQty } from '@/lib/stockRules'
export type {
  CreateReturnWaiverInput,
  OutstandingForStaff,
  OutstandingLine,
  ReturnInput,
  StockInInput,
  StockItemInput,
  StockMovementResult,
  StockOutInput,
  UnscannableLine,
  WaivedByTxn,
} from '@/lib/stockRules'

export function recordStockIn(input: StockInInput): Promise<StockMovementResult> {
  return api<StockMovementResult>('POST', '/api/stock/in', input)
}

export function recordStockOut(input: StockOutInput): Promise<StockMovementResult> {
  return api<StockMovementResult>('POST', '/api/stock/out', input)
}

export function recordReturn(input: ReturnInput): Promise<StockMovementResult> {
  return api<StockMovementResult>('POST', '/api/stock/return', input)
}

/** Written-off quantity per [OUT transaction id][product id]. */
export function loadWaivedByTxn(): Promise<WaivedByTxn> {
  return api<WaivedByTxn>('GET', '/api/stock/waivers', { kind: 'byTxn' })
}

/** Every waiver, oldest first. */
export function loadWaivers(): Promise<ReturnWaiver[]> {
  return api<ReturnWaiver[]>('GET', '/api/stock/waivers')
}

/** Writes a return waiver (the item doesn't need to come back). Resolves to the waiver id. */
export async function createReturnWaiver(input: CreateReturnWaiverInput): Promise<string> {
  const res = await api<{ id: string }>('POST', '/api/stock/waivers', input)
  return res.id
}

/** What a staff member still has out, per Stock Out, product and barcode (the Returns page). */
export function listOutstandingForStaff(staffId: string): Promise<OutstandingForStaff> {
  return api<OutstandingForStaff>('GET', '/api/stock/outstanding', { staffId })
}

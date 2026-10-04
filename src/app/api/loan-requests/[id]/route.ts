import { route } from '@/server/http'
import { getRequest } from '@/server/data/loanRequests'

// GET /api/loan-requests/<id> → { request: LoanRequest, lines: LoanRequestLine[] }
// Admin: any request. Staff: their own only; anyone else's is a 404, as if it did not exist.
export const GET = route('signed-in', async (ctx, _query, _req, params) => getRequest(ctx, params.id))

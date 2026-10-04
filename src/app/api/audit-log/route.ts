import { route } from '@/server/http'
import { listAuditLog } from '@/server/data/auditLog'

// The Audit Log, newest first (admin only), with the item lines of the entries that did not freeze them.
//   GET /api/audit-log[?from=YYYY-MM-DD][&to=YYYY-MM-DD][&entityType=a,b][&action=a,b][&userId=…]
// from/to are calendar days in Africa/Johannesburg, both ends inclusive.
type Query = { from?: string; to?: string; entityType?: string; action?: string; userId?: string }

export const GET = route<Query>('admin', async (ctx, q) =>
  listAuditLog(ctx, { from: q.from, to: q.to, entityType: q.entityType, action: q.action, userId: q.userId }),
)

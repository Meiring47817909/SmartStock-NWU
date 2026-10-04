import { route } from '@/server/http'
import { listAuditLog } from '@/server/data/auditLog'

// The Audit Log, newest first (admin only), one page of AUDIT_PAGE_SIZE entries per call, each page with the item lines of
// its entries that did not freeze them, and `nextCursor` (null on the last page).
//   GET /api/audit-log[?from=YYYY-MM-DD][&to=YYYY-MM-DD][&entityType=a,b][&action=a,b][&userId=…][&cursor=…]
// from/to are calendar days in Africa/Johannesburg, both ends inclusive. src/lib/api/auditLog.ts follows the cursor.
type Query = { from?: string; to?: string; entityType?: string; action?: string; userId?: string; cursor?: string }

export const GET = route<Query>('admin', async (ctx, q) =>
  listAuditLog(ctx, { from: q.from, to: q.to, entityType: q.entityType, action: q.action, userId: q.userId, cursor: q.cursor }),
)

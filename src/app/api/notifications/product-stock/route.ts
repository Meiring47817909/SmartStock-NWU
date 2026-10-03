import 'server-only'
import { NextRequest, NextResponse } from 'next/server'
import { adminDb } from '@/lib/firebase/admin'
import { requireAdmin, ApiError } from '@/lib/server/staffAdmin'
import { isMailEnabled, MailUnreachableError, MailConfigError } from '@/lib/server/mailer'
import { lowStockEmail } from '@/lib/server/emailTemplates'
import { deliver, appBaseUrl, adminInboxEmail, type SkipReason } from '@/lib/server/notificationDelivery'

interface ProductDoc {
  name?: string
  quantity_on_hand?: number
  reorder_threshold?: number
  updated_at?: string
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/**
 * Low stock email after an admin edits a product on the Products page.
 * (Stock Out has its own route; this covers quantity or threshold edits that
 * do not go through a transaction.) Called in the background once the edit is
 * saved; the edit never depends on this succeeding. Admin only. Read-only: no
 * product document is modified.
 *
 * Body: { productId, previousQuantity, previousThreshold } — the values the
 * page held before the edit. The product's current values are read here.
 * It sends only when the product has just become low: it was above its
 * reorder threshold before and is at or below it (or at zero) now. A product
 * that was already low, or is still above its threshold, sends nothing.
 *
 * Response: { sent, reason? } with reason a SkipReason or 'not_crossed'.
 */
export async function POST(request: NextRequest) {
  try {
    await requireAdmin(request)

    const body = await request.json().catch(() => null)
    const productId = typeof body?.productId === 'string' ? body.productId : ''
    if (!productId || productId.includes('/')) throw new ApiError(400, 'Missing productId.')
    if (!isCount(body?.previousQuantity) || !isCount(body?.previousThreshold)) {
      throw new ApiError(400, 'Missing previousQuantity or previousThreshold.')
    }
    const previousQuantity: number = body.previousQuantity
    const previousThreshold: number = body.previousThreshold

    // Cheapest check first: with the mailer off (production) nothing is read.
    if (!isMailEnabled()) return NextResponse.json({ sent: false, reason: 'mail_disabled' satisfies SkipReason })

    const snap = await adminDb.collection('products').doc(productId).get()
    if (!snap.exists) throw new ApiError(404, 'Product not found.')
    const product = snap.data() as ProductDoc
    const onHand = Number(product.quantity_on_hand ?? 0)
    const threshold = Number(product.reorder_threshold ?? 0)

    const wasLow = previousQuantity <= previousThreshold
    const isLow = onHand <= threshold
    if (wasLow || !isLow) return NextResponse.json({ sent: false, reason: 'not_crossed' })

    // The product's updated_at changes with every save, so one saved edit
    // sends once and a later edit can send again.
    const result = await deliver({
      toggle: 'low_stock_alert',
      dedupeKey: `low_stock__product-${productId}__${product.updated_at ?? onHand}`,
      recipient: adminInboxEmail,
      render: async () =>
        lowStockEmail({
          products: [{ name: product.name ?? 'Item', onHand, threshold }],
          buttonUrl: `${appBaseUrl()}/products`,
        }),
    })
    return NextResponse.json(result.reason ? { sent: result.sent, reason: result.reason } : { sent: result.sent })
  } catch (err) {
    if (err instanceof ApiError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    if (err instanceof MailUnreachableError) {
      return NextResponse.json(
        { error: 'Mail server not reachable. Is Mailpit running? (npm run mailpit)' },
        { status: 502 },
      )
    }
    if (err instanceof MailConfigError) {
      return NextResponse.json({ error: err.message }, { status: 500 })
    }
    console.error('product stock notification failed:', err)
    return NextResponse.json({ error: 'Failed to send the low stock notification.' }, { status: 500 })
  }
}

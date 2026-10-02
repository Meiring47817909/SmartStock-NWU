import 'server-only'
import { NextRequest, NextResponse } from 'next/server'
import { adminDb } from '@/lib/firebase/admin'
import { requireAdmin, ApiError } from '@/lib/server/staffAdmin'
import { isMailEnabled, sendMail, MailUnreachableError, MailConfigError } from '@/lib/server/mailer'
import {
  stockOutConfirmationEmail, lowStockEmail, type StockOutEmailLine, type LowStockProduct,
} from '@/lib/server/emailTemplates'
import { deliver, appBaseUrl, adminInboxEmail, type SkipReason } from '@/lib/server/notificationDelivery'

interface StepResult {
  sent: boolean
  reason?: SkipReason | 'not_out'
}

interface TransactionDoc {
  transaction_type?: string
  reference_no: string
  staff_id?: unknown
  staff_name?: string
  lend_from?: string | null
  lend_to?: string | null
}

interface TransactionLineDoc {
  product_id?: unknown
  product_name?: string
  quantity?: number
}

// One line per product with the summed quantity (a product scanned under two
// barcodes is two transaction_lines documents), in first-seen order.
function collapseForEmail(lines: TransactionLineDoc[]): StockOutEmailLine[] {
  const byProduct = new Map<string, StockOutEmailLine>()
  for (const l of lines) {
    const key = String(l.product_id)
    const entry = byProduct.get(key) ?? { productName: l.product_name ?? 'Item', quantity: 0 }
    entry.quantity += l.quantity || 0
    byProduct.set(key, entry)
  }
  return Array.from(byProduct.values())
}

function skipped(reason: SkipReason | 'not_out'): StepResult {
  console.info(`stock-out confirmation not sent: ${reason}`)
  return { sent: false, reason }
}

// The staff member's confirmation. Throws on a failed send.
async function sendConfirmation(
  txn: TransactionDoc,
  lines: TransactionLineDoc[],
): Promise<StepResult> {
  // Missing or any non-false value means on, matching DEFAULT_NOTIFICATION_SETTINGS.
  const settingsSnap = await adminDb.collection('settings').doc('notifications').get()
  if (settingsSnap.data()?.stock_out_confirmation === false) return skipped('toggle_off')

  const staffSnap = txn.staff_id == null ? null : await adminDb.collection('staff').doc(String(txn.staff_id)).get()
  const staffData = staffSnap?.data()
  const staffEmail = typeof staffData?.email === 'string' ? staffData.email.trim() : ''
  if (!staffEmail) return skipped('no_email')

  const { subject, html, text } = stockOutConfirmationEmail({
    staffName: txn.staff_name || staffData?.full_name || 'there',
    reference: txn.reference_no,
    lines: collapseForEmail(lines),
    lendFrom: txn.lend_from ?? null,
    lendTo: txn.lend_to ?? null,
  })
  await sendMail({ to: staffEmail, subject, html, text })
  return { sent: true }
}

// One email to the admin inbox listing every product this Stock Out took from
// above its reorder threshold to at/below it (including to zero). `after` is the
// product's current on-hand (the page has already saved the decrement), so the
// level before is after + issued.
async function sendLowStock(transactionId: string, lines: TransactionLineDoc[]): Promise<StepResult> {
  const issued = new Map<string, { qty: number; fallbackName: string }>()
  for (const l of lines) {
    const key = String(l.product_id)
    const entry = issued.get(key) ?? { qty: 0, fallbackName: l.product_name ?? 'Item' }
    entry.qty += l.quantity || 0
    issued.set(key, entry)
  }

  const crossed: LowStockProduct[] = []
  for (const [productId, { qty, fallbackName }] of issued) {
    const data = (await adminDb.collection('products').doc(productId).get()).data()
    if (!data) continue
    const after = Number(data.quantity_on_hand ?? 0)
    const threshold = Number(data.reorder_threshold ?? 0)
    if (after + qty > threshold && after <= threshold) {
      crossed.push({ name: data.name ?? fallbackName, onHand: after, threshold })
    }
  }
  if (crossed.length === 0) return { sent: false }

  const result = await deliver({
    toggle: 'low_stock_alert',
    dedupeKey: `low_stock__${transactionId}`,
    recipient: adminInboxEmail,
    render: async () => lowStockEmail({ products: crossed, buttonUrl: `${appBaseUrl()}/products` }),
  })
  return result.reason ? { sent: result.sent, reason: result.reason } : { sent: result.sent }
}

/**
 * Emails after a Stock Out has been saved: a confirmation to the staff member,
 * and a low-stock alert to the admin inbox when the Stock Out took products
 * down to or below their reorder threshold. Called in the background by the
 * Stock Out page once the transaction and its lines are written; the Stock Out
 * never depends on this succeeding. Admin only: firestore.rules lets only
 * admins create transactions, so only an admin can have just completed a Stock
 * Out. Read-only: no document is modified.
 *
 * Body: { transactionId: string } — the Firestore document ID in `transactions`.
 * Response: { sent, reason?, lowStock: { sent, reason? } } where `sent`/`reason`
 * describe the confirmation. `mail_disabled` and `not_out` return without
 * `lowStock`. The two emails are independent: one failing does not stop the
 * other, and the first failure is reported after both were tried.
 */
export async function POST(request: NextRequest) {
  try {
    await requireAdmin(request)

    const body = await request.json().catch(() => null)
    const transactionId = typeof body?.transactionId === 'string' ? body.transactionId : null
    if (!transactionId) {
      throw new ApiError(400, 'Missing transactionId.')
    }

    // Cheapest check first: with the mailer off (production) nothing is read.
    if (!isMailEnabled()) return NextResponse.json(skipped('mail_disabled'))

    const txnSnap = await adminDb.collection('transactions').doc(transactionId).get()
    if (!txnSnap.exists) {
      throw new ApiError(404, 'Transaction not found.')
    }
    const txn = txnSnap.data() as TransactionDoc
    if (txn.transaction_type !== 'OUT') return NextResponse.json(skipped('not_out'))

    const linesSnap = await adminDb.collection('transaction_lines').where('transaction_id', '==', transactionId).get()
    const lines = linesSnap.docs.map((d) => d.data() as TransactionLineDoc)

    let firstError: unknown = null
    let confirmation: StepResult = { sent: false }
    let lowStock: StepResult = { sent: false }
    try {
      confirmation = await sendConfirmation(txn, lines)
    } catch (err) {
      firstError = err
    }
    try {
      lowStock = await sendLowStock(transactionId, lines)
    } catch (err) {
      firstError ??= err
    }
    if (firstError) throw firstError

    return NextResponse.json({ ...confirmation, lowStock })
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
    console.error('stock-out notification failed:', err)
    return NextResponse.json({ error: 'Failed to send the Stock Out notifications.' }, { status: 500 })
  }
}

import 'server-only'
import { NextRequest, NextResponse } from 'next/server'
import { adminDb } from '@/lib/firebase/admin'
import { requireAdmin, ApiError } from '@/lib/server/staffAdmin'
import { isMailEnabled, sendMail, MailUnreachableError, MailConfigError } from '@/lib/server/mailer'
import { stockOutConfirmationEmail, type StockOutEmailLine } from '@/lib/server/emailTemplates'

type SkipReason = 'mail_disabled' | 'toggle_off' | 'no_email' | 'not_out'

// One line per product with the summed quantity (a product scanned under two
// barcodes is two transaction_lines documents), in first-seen order.
function collapseForEmail(lines: { product_id?: unknown; product_name?: string; quantity?: number }[]): StockOutEmailLine[] {
  const byProduct = new Map<string, StockOutEmailLine>()
  for (const l of lines) {
    const key = String(l.product_id)
    const entry = byProduct.get(key) ?? { productName: l.product_name ?? 'Item', quantity: 0 }
    entry.quantity += l.quantity || 0
    byProduct.set(key, entry)
  }
  return Array.from(byProduct.values())
}

function skipped(reason: SkipReason) {
  console.info(`stock-out confirmation not sent: ${reason}`)
  return NextResponse.json({ sent: false, reason })
}

/**
 * Emails the staff member a confirmation after a Stock Out has been saved.
 * Called in the background by the Stock Out page once the transaction and its
 * lines are written; the Stock Out never depends on this succeeding. Admin
 * only: firestore.rules lets only admins create transactions, so only an admin
 * can have just completed a Stock Out. Read-only: the transaction document is
 * never modified.
 *
 * Body: { transactionId: string } — the Firestore document ID in `transactions`.
 * Response: { sent: boolean, reason?: 'mail_disabled' | 'toggle_off' | 'no_email' | 'not_out' }
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
    if (!isMailEnabled()) return skipped('mail_disabled')

    const txnSnap = await adminDb.collection('transactions').doc(transactionId).get()
    if (!txnSnap.exists) {
      throw new ApiError(404, 'Transaction not found.')
    }
    const txn = txnSnap.data()!
    if (txn.transaction_type !== 'OUT') return skipped('not_out')

    // Missing or any non-false value means on, matching DEFAULT_NOTIFICATION_SETTINGS.
    const settingsSnap = await adminDb.collection('settings').doc('notifications').get()
    if (settingsSnap.data()?.stock_out_confirmation === false) return skipped('toggle_off')

    const staffSnap = txn.staff_id == null ? null : await adminDb.collection('staff').doc(String(txn.staff_id)).get()
    const staffData = staffSnap?.data()
    const staffEmail = typeof staffData?.email === 'string' ? staffData.email.trim() : ''
    if (!staffEmail) return skipped('no_email')

    const linesSnap = await adminDb.collection('transaction_lines').where('transaction_id', '==', transactionId).get()
    const lines = collapseForEmail(linesSnap.docs.map((d) => d.data()))

    const { subject, html, text } = stockOutConfirmationEmail({
      staffName: txn.staff_name || staffData?.full_name || 'there',
      reference: txn.reference_no,
      lines,
      lendFrom: txn.lend_from ?? null,
      lendTo: txn.lend_to ?? null,
    })
    await sendMail({ to: staffEmail, subject, html, text })
    return NextResponse.json({ sent: true })
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
    console.error('stock-out confirmation failed:', err)
    return NextResponse.json({ error: 'Failed to send the Stock Out confirmation.' }, { status: 500 })
  }
}

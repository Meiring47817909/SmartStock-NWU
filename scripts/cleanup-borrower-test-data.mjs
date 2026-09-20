// One-off cleanup: removes loan-request test data created by the seeded
// "Portal Borrower" account (borrower@nwu.test) while manually testing the
// lending portal — the request itself, its lines, and (if it went all the
// way to Stock Out) the fulfilling transaction and its lines.
//
// Run this AFTER `npm run emulators` is already up, in a separate terminal:
//   npm run cleanup:borrower-test
//
// Talks to the emulators only (via the FIRESTORE_EMULATOR_HOST env var
// below) — never touches the real Firebase project, and needs zero real
// credentials to run. Safe to run multiple times (no-ops once there's
// nothing left matching).
//
// Deliberately does NOT touch products' quantity_on_hand: an 'accepted'
// request never decremented stock (only Stock Out fulfillment does that,
// via handleConfirm in stock-out/page.tsx), and the reservation ledger
// itself is always computed live off the loan_requests/loan_request_lines
// this script deletes — so once those documents are gone, the reservation
// disappears with them, nothing to reverse separately. If a fulfilling
// transaction IS found below, its lines' quantities ARE added back to
// quantity_on_hand, since that write did really happen.

process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8081'

import { initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

const PROJECT_ID = 'demo-smartstock-nwu'
const app = initializeApp({ projectId: PROJECT_ID })
const db = getFirestore(app)

const BORROWER_NAME = 'Portal Borrower'

async function main() {
  // Match by staff_id (from the seed-lending-portal.mjs staff doc) as well
  // as by staff_name, in case the staff doc has since been re-seeded with a
  // different id — belt-and-suspenders for a one-off cleanup script.
  const staffSnap = await db.collection('staff').where('full_name', '==', BORROWER_NAME).get()
  const staffIds = new Set(staffSnap.docs.map((d) => d.id))

  const reqSnap = await db.collection('loan_requests').get()
  const targetRequests = reqSnap.docs.filter((d) => {
    const data = d.data()
    return data.staff_name === BORROWER_NAME || staffIds.has(data.staff_id)
  })

  if (targetRequests.length === 0) {
    console.log(`No loan requests found for "${BORROWER_NAME}" — nothing to clean up.`)
    return
  }

  let deletedRequests = 0
  let deletedLines = 0
  let deletedTxns = 0
  let deletedTxnLines = 0
  let restoredUnits = 0

  for (const reqDoc of targetRequests) {
    const requestId = reqDoc.id

    // This request's own lines.
    const linesSnap = await db.collection('loan_request_lines').where('request_id', '==', requestId).get()
    for (const lineDoc of linesSnap.docs) {
      await lineDoc.ref.delete()
      deletedLines++
    }

    // Any transaction that fulfilled this request (Stock Out writes
    // linked_request_id — see handleConfirm in stock-out/page.tsx). If
    // found, restore the stock it actually decremented before deleting it.
    const txnSnap = await db.collection('transactions').where('linked_request_id', '==', requestId).get()
    for (const txnDoc of txnSnap.docs) {
      const txnLinesSnap = await db.collection('transaction_lines').where('transaction_id', '==', txnDoc.id).get()
      for (const txnLineDoc of txnLinesSnap.docs) {
        const line = txnLineDoc.data()
        const productRef = db.collection('products').doc(line.product_id)
        const productSnap = await productRef.get()
        if (productSnap.exists) {
          const onHand = productSnap.data().quantity_on_hand ?? 0
          await productRef.set({ quantity_on_hand: onHand + (line.quantity || 0), updated_at: new Date().toISOString() }, { merge: true })
          restoredUnits += line.quantity || 0
        }
        await txnLineDoc.ref.delete()
        deletedTxnLines++
      }
      await txnDoc.ref.delete()
      deletedTxns++
    }

    await reqDoc.ref.delete()
    deletedRequests++
  }

  console.log(`Cleaned up test data for "${BORROWER_NAME}":`)
  console.log(`  ${deletedRequests} loan request(s), ${deletedLines} loan request line(s)`)
  if (deletedTxns > 0) {
    console.log(`  ${deletedTxns} fulfilling transaction(s), ${deletedTxnLines} transaction line(s)`)
    console.log(`  Restored ${restoredUnits} unit(s) of stock that fulfillment had decremented`)
  }
  console.log('')
  console.log('View in Firestore emulator UI: http://127.0.0.1:4000')
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Cleanup failed:', err)
    process.exit(1)
  })

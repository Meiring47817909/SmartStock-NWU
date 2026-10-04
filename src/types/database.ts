// Database types for NWU BICS – mirrors the Firebase Firestore schema

// Two roles only.
//   admin — Selouna and anyone else running the IT Store: every BICS page.
//   staff — an NWU staff member who can do exactly one thing, apply for a
//           loan request in the lending portal. No BICS access of any kind.
//
// A portal borrower normally has NO profiles/{uid} doc at all (they're
// identified by a staff record whose `uid` matches — see StaffPortalContext).
// A profiles doc carrying role 'staff' is treated identically: portal only.
// So "not admin" is the single BICS gate, whether the profile is missing or
// present-but-staff.
export type Role = 'admin' | 'staff'
export type TxnType = 'IN' | 'OUT' | 'RETURN' | 'ADJUST'

export interface Profile {
  id: string           // auth.users.id
  full_name: string
  role: Role
  created_at: string
}

export interface Category {
  id: string          // Firestore document ID
  name: string
  description: string | null
  created_at: string
}

// How long a single loan of this product can run for, on the portal (see
// LENDING_PORTAL section of loanRequests.ts's validateCartDates). Distinct
// from lend_from/lend_to below (the window during which the product can be
// borrowed AT ALL) — this caps the DURATION of any one loan within that
// window. 'indefinite' additionally means the portal doesn't require a
// return date at all, the same convenience Stock Out's own blank "Lend To"
// already offers for a walk-in issue.
export type LendingInterval = 'week_1' | 'week_2' | 'week_3' | 'month_1' | 'indefinite'

export interface Product {
  id: number
  category_id: string | null   // Firestore document ID of the category (see Category.id)
  name: string
  description: string | null
  // Multiple codes can point at the same product — e.g. the barcode/QR a
  // product already ships with from the manufacturer, plus one or more
  // NWU-generated codes printed later. barcodes[0] is treated as the
  // "primary" one for display purposes; any value in the array resolves a
  // scan to this product.
  barcodes: string[]
  quantity_on_hand: number
  reorder_threshold: number
  available: boolean
  location: string
  // Date window (YYYY-MM-DD, native <input type="date"> format) during which
  // staff are allowed to lend this product out. null/unset means no
  // restriction — informational only, not currently enforced in Stock Out.
  lend_from: string | null
  lend_to: string | null
  // Optional — missing on any product saved before this field existed;
  // treated as 'week_1' wherever it's read (see DEFAULT_LENDING_INTERVAL in
  // loanRequests.ts), preserving the flat 7-day cap that used to apply to
  // every product.
  lending_interval?: LendingInterval
  created_at: string
  updated_at: string
  // Firebase Storage paths (not download URLs) — resolved to a URL at
  // render time via storageDownloadUrl(). Max 3 per product.
  images?: string[]
  // joined
  category_name?: string
}

export interface StaffMember {
  id: number
  name: string
  surname: string
  full_name: string   // denormalized "name surname" — used for search/order/display throughout the app
  email: string | null
  department: string | null
  card_uid: string | null
  is_active: boolean
  // Firebase Auth UID this staff record is linked to, for lending-portal
  // login — null until "Send Login Email" has provisioned an account.
  // Written only by the /api/staff/* routes; see src/lib/server/staffAdmin.ts.
  uid: string | null
  // True only for the one `staff` record a BICS admin creates for herself
  // via (protected)/profile — it lets her show up as a normal borrower in
  // Stock Out (which reads exclusively from this collection) without
  // cluttering the Staff management page's list of actual staff/borrowers.
  // Never set on an ordinary staff member's record.
  is_admin_account?: boolean
  created_at: string
  updated_at: string
}

export interface Transaction {
  id: number
  transaction_type: TxnType
  reference_no: string
  staff_id: number | null
  // The BICS operator who performed this movement — distinct from
  // staff_id, which is the borrower it was for (and is null on an IN,
  // where nothing is lent to anyone). Both were declared from the start
  // but user_id was never written by any flow, so the transactions
  // collection had no record of who did anything; that lived only in the
  // audit log.
  user_id: string | null
  operator_name: string | null   // denormalized, same pattern as staff_name
  notes: string | null
  return_date: string | null
  linked_txn_id: number | null
  // "The staff member was picked from a list instead of scanning their
  // card." Only Stock Out and Returns have a staff step that can be
  // bypassed, so only OUT/RETURN ever write this — Stock In writes no
  // staff_id at all, and so has no card scan to skip. Optional because a
  // real IN document genuinely does not contain the field; anything
  // reading it must therefore treat absent as false AND ignore it on a
  // non-OUT/RETURN transaction (see audit-log and reports).
  manual_override?: boolean
  // Loan window set by Selouna on Stock Out's Confirm step (YYYY-MM-DD,
  // native <input type="date"> format) — when the item is being lent out
  // and when it's due back. Only ever set on OUT transactions.
  lend_from: string | null
  lend_to: string | null
  // Set when this OUT transaction was issued against an accepted loan
  // request (see loan-requests portal). null for walk-ins.
  linked_request_id: string | null
  // The same link in a form a person can read and search for (LR-...).
  // Carried onto the RETURN as well as the OUT: without it a return can
  // only reach its loan request by hopping through the originating
  // transaction, which a CSV export cannot do. Explicitly null on a Stock
  // In and on a walk-in Stock Out, so the column always exists.
  linked_request_ref: string | null
  created_at: string
  // joined
  staff_name?: string
  line_count?: number
  total_qty?: number
}

export interface TransactionLine {
  id: string           // Firestore document ID
  transaction_id: string  // Firestore document ID of the parent transaction
  product_id: string      // Firestore document ID of the product
  quantity: number
  unit_cost: number
  created_at: string
  // denormalized at write-time for cheap rendering (avoids a product lookup per line)
  product_name?: string
  // The single barcode scanned for this line. A product can carry more than
  // one barcode (e.g. its manufacturer code plus an NWU-printed one), and
  // Stock Out / Stock In / Returns write ONE LINE PER (product, barcode):
  // scanning a product via two different barcodes gives two lines for it,
  // each with its own quantity. That keeps a Return exactly matchable per
  // barcode. Anything that needs a per-product view of a transaction (the
  // outstanding-return maths, the reports, the audit log) collapses lines
  // with collapseLinesByProduct() in lib/transactionLines.ts first.
  // Absent on lines written before barcode capture existed.
  barcode?: string | null
  // RETURN lines only, and only when the unit lost its barcode: the barcode it
  // was ISSUED under. `barcode` is then the replacement applied at return time.
  // The Returns page counts the line against issued_barcode.
  issued_barcode?: string | null
}

export interface DashboardStats {
  total_products: number
  total_stock: number
  low_stock: number
  today_transactions: number
  total_staff: number
}

export interface TrendPoint {
  date: string
  IN: number
  OUT: number
  RETURN: number
}

export interface DashboardData {
  stats: DashboardStats
  recent_transactions: Transaction[]
  low_stock_items: Product[]
  trend: TrendPoint[]
}

// Cart item used in stock-out / stock-in forms
export interface CartItem {
  product: Product
  quantity: number
}

// Lending-portal negotiation request. One request = one cart, one shared
// date range, one status covering every line (see LENDING_PORTAL_SPEC.md §1).
export type LoanRequestStatus =
  | 'pending'    // awaiting Selouna's first review
  | 'countered'  // Selouna proposed changes, awaiting staff accept/decline
  | 'accepted'   // staff accepted (or Selouna approved as-is); awaiting pickup
  | 'declined'   // staff declined a counter — terminal
  | 'expired'    // pending/countered request that blew past its expiry — terminal
  | 'withdrawn'  // staff cancelled a pending/countered/accepted request — terminal
  | 'fulfilled'  // Stock Out issued against it — terminal
  | 'no_show'    // accepted but pickup window passed with nothing issued — terminal

export interface LoanRequest {
  id: string                    // Firestore document ID
  // Human-readable reference, LR-XXXXXXXX — the loan-request counterpart
  // to Transaction.reference_no, so a request can be quoted in an email or
  // matched against a paper note instead of a Firestore id. Optional
  // because requests created before this existed genuinely don't have one;
  // they are not backfilled, since a reference invented today was never
  // the reference anyone used at the time.
  reference_no?: string
  staff_id: string               // StaffMember document ID (resolved via StaffMember.uid at submission)
  staff_name: string              // denormalized, same pattern as Transaction.staff_name
  status: LoanRequestStatus
  message: string | null          // optional note from staff at submission
  admin_message: string | null    // optional note from Selouna, sent along with a counter
                                   // or a decline — shown to the staff member on their My
                                   // Requests page. Reused across whichever of those two
                                   // actions was taken most recently (they're mutually
                                   // exclusive transitions for a given request, so there's
                                   // never a case where both need to be visible at once).
  from_date: string               // YYYY-MM-DD — current shared date range. Mutable: Selouna's
                                   // counter can change it, overwritten in place.
  to_date: string | null          // YYYY-MM-DD, or null for an indefinite loan (a product whose
                                   // lending_interval is 'indefinite' doesn't require a return
                                   // date) — same open-ended convention as Product.lend_to and
                                   // Transaction.lend_to.
  // Immutable snapshot of what was originally submitted — set once, never
  // touched again — so the staff-facing counter-diff view can show what
  // Selouna changed even after from_date/to_date are overwritten in place.
  original_from_date: string
  original_to_date: string | null
  created_at: string              // ISO — set once at submission, never changes
  updated_at: string              // ISO — bumped on every status transition. Expiry is computed
                                   // from this (see loanRequests.ts) — never store an expiry date.
  fulfilled_txn_id: string | null // set by Stock Out once issued
}

export interface LoanRequestLine {
  id: string                    // Firestore document ID
  request_id: string             // LoanRequest document ID
  product_id: string              // Firestore document ID of the product (Product.id.toString())
  product_name: string            // denormalized
  requested_quantity: number      // set once at submission — never edited after
  offered_quantity: number        // starts equal to requested_quantity. Selouna's counter edits
                                   // this (reduce, or set to 0 to drop the line). This is the
                                   // number Stock Out actually issues against on fulfillment.
  created_at: string
}

// A permanent write-off of an outstanding loan line: Selouna has agreed the
// staff member keeps the item, so it must stop appearing in Outstanding
// Returns without a RETURN transaction ever happening.
//
// Deliberately its own append-only collection rather than a mutable flag on
// the OUT transaction/line: `transactions` and `transaction_lines` are
// locked `allow update, delete: if false` in firestore.rules, and that
// immutability is load-bearing (the whole outstanding calculation is a
// replay of issued-minus-returned over an append-only ledger). A waiver is
// just a third kind of entry in that replay — subtracted exactly the way a
// RETURN's lines are — so nothing about the existing ledger has to change.
//
// NOTE: a waiver never touches Product.quantity_on_hand. The stock was
// decremented when it was issued and the item is not coming back, so the
// on-hand count is already correct; "resolving" is about the paperwork, not
// the shelf.
export interface ReturnWaiver {
  id: string                 // Firestore document ID
  transaction_id: string      // the originating OUT transaction's document ID
  product_id: string          // Firestore document ID of the product
  product_name: string        // denormalized, same pattern as TransactionLine
  staff_id: number | null     // denormalized from the OUT transaction
  staff_name: string | null
  quantity: number            // units written off — the line's remaining balance at resolve time
  reason: string | null       // free-text note, currently always null (no UI for it yet)
  created_at: string
  resolved_by_uid: string | null
  resolved_by_name: string | null
}

// Feature-flag toggles for the outbound notification emails this app can
// send (see NOTIFICATION_EMAIL_DEFINITIONS in
// lib/firebase/notificationSettings.ts for what each one actually covers,
// and (protected)/settings/notifications for the page that edits these).
// One singleton document, not one per admin -- there is one operational
// inbox (Selouna's) and one lending-portal audience to notify, not several.
// Each toggle gates one email; only an explicit `false` turns it off. The
// three that need a timer (loan_request_expired, overdue_return_alert,
// insufficient_pickup_alert) are not built yet: they are always off and
// cannot be turned on (see lib/notificationCatalog.ts).
export type NotificationSettingKey =
  | 'stock_out_confirmation'
  | 'loan_request_approved'
  | 'loan_request_countered'
  | 'loan_request_declined'
  | 'approved_pickup_cancelled'
  | 'loan_request_expired'
  | 'loan_request_counter_accepted'
  | 'loan_request_counter_declined'
  | 'loan_request_withdrawn'
  | 'new_loan_request'
  | 'incoming_pickup_confirmed'
  | 'overdue_return_alert'
  | 'low_stock_alert'
  | 'insufficient_pickup_alert'

export type NotificationSettings = Record<NotificationSettingKey, boolean> & {
  // Where the five "Selouna" emails above are actually delivered -- set on
  // the Notification Settings page. null/empty until an admin sets one, in
  // which case nothing addressed to Selouna has anywhere to go yet.
  admin_notification_email: string | null
  // The address every system email is sent From. null/empty = the server's
  // default sender (MAIL_FROM).
  system_from_email: string | null
  updated_at: string | null
  updated_by_uid: string | null
  updated_by_name: string | null
}

// 'grant_access' / 'resend_access' cover the Staff page's Send/Resend
// Login Email button — provisioning a portal login and re-issuing the
// password-reset link. They are separate from 'update' because granting
// someone access to the system is not the same kind of event as editing
// their department, and an auditor needs to find them on their own.
export type AuditAction =
  | 'create' | 'update' | 'delete' | 'activate' | 'deactivate' | 'resolve'
  | 'grant_access' | 'resend_access'
export type AuditEntityType = 'product' | 'category' | 'staff' | 'transaction' | 'loan_request' | 'settings'

export interface AuditLogEntry {
  id: string             // Firestore document ID
  user_id: string | null    // Firebase Auth uid of who performed the action
  user_name: string | null  // denormalized at write-time for cheap rendering
  action: AuditAction
  entity_type: AuditEntityType
  entity_id: string
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  created_at: string
}

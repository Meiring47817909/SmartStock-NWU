// Database types for NWU BICS – mirrors the Firebase Firestore schema

export type Role = 'admin' | 'manager' | 'staff'
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
  created_at: string
  updated_at: string
}

export interface Transaction {
  id: number
  transaction_type: TxnType
  reference_no: string
  staff_id: number | null
  user_id: string | null
  notes: string | null
  return_date: string | null
  linked_txn_id: number | null
  manual_override: boolean
  // Loan window set by Selouna on Stock Out's Confirm step (YYYY-MM-DD,
  // native <input type="date"> format) — when the item is being lent out
  // and when it's due back. Only ever set on OUT transactions.
  lend_from: string | null
  lend_to: string | null
  // Set when this OUT transaction was issued against an accepted loan
  // request (see loan-requests portal). null for walk-ins.
  linked_request_id: string | null
  created_at: string
  // joined
  staff_name?: string
  operator?: string
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
  staff_id: string               // StaffMember document ID (resolved via StaffMember.uid at submission)
  staff_name: string              // denormalized, same pattern as Transaction.staff_name
  status: LoanRequestStatus
  message: string | null          // optional note from staff at submission
  from_date: string               // YYYY-MM-DD — current shared date range. Mutable: Selouna's
                                   // counter can change it, overwritten in place.
  to_date: string                 // YYYY-MM-DD
  // Immutable snapshot of what was originally submitted — set once, never
  // touched again — so the staff-facing counter-diff view can show what
  // Selouna changed even after from_date/to_date are overwritten in place.
  original_from_date: string
  original_to_date: string
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

export type AuditAction = 'create' | 'update' | 'delete' | 'activate' | 'deactivate'
export type AuditEntityType = 'product' | 'category' | 'staff' | 'transaction' | 'loan_request'

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

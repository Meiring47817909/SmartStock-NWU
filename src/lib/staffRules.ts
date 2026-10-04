// Pure staff helpers and shapes shared by the server (src/server/data/staff.ts) and the browser client
// (src/lib/api/staff.ts). No Firebase, no database.

// Firebase Auth treats email as case-insensitive, so every place that stores or compares a staff email needs to agree
// on the same normalized form, or a duplicate could slip past the check by casing alone.
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

/** What the Staff page's Add / Edit form sends. Email, department and card UID are optional (blank → null). */
export interface StaffInput {
  name: string
  surname: string
  email?: string | null
  department?: string | null
  card_uid?: string | null
  /** The Auth account's email was already changed to match (set by the page after /api/staff/update-email succeeded). */
  auth_email_synced?: boolean
}

/** What My Profile → My details sends for the admin's own staff row (admin-only). */
export interface OwnDetailsInput {
  name: string
  surname: string
  department?: string | null
  card_uid?: string | null
  /** Used only when the row is created the first time (the admin's own borrower record). */
  email?: string | null
}

/** One item a staff member currently holds: still owed back, or written off (they keep it). */
export interface HeldItem {
  key: string
  txn_id: string
  product_id: string
  product_name: string
  qty: number
  expected_date: string | null
  waived: boolean
}

export interface StaffHolding {
  /** Total quantity still owed back (written-off items are not counted). */
  outstanding: number
  /** Open items first (most urgent first, undated after), written-off items last. */
  items: HeldItem[]
}

export type StaffHoldings = Record<string, StaffHolding>

export interface ResolveHeldItemInput {
  transactionId: string
  productId: string
  quantity: number
  reason?: string | null
}

export function staffEmailConflictMessage(fullName: string): string {
  return `This email is already used by ${fullName}.`
}

export function staffUidConflictMessage(fullName: string): string {
  return `This email is already linked to another staff record (${fullName}). Fix the email or contact support before sending a login email.`
}

export function staffCardConflictMessage(fullName: string): string {
  return `This card UID is already linked to ${fullName}.`
}

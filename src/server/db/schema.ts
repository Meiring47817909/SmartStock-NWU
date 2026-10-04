// Table definitions for the PostgreSQL database (design spec section 3).
//
// Property names are the snake_case column names, so a selected row already has the field names the app's
// types in src/types/database.ts use. Timestamps are timestamptz (Date here; the data layer converts with
// toIso()); day-only fields are `date` and stay 'YYYY-MM-DD' strings.
//
// No `import 'server-only'` here on purpose: drizzle-kit loads this file outside Next.js, where that package
// throws. This file only describes tables (it opens no connection); the connection lives in client.ts.
import { sql, type SQL } from 'drizzle-orm'
import {
  type AnyPgColumn,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import type {
  AuditAction,
  AuditEntityType,
  LendingInterval,
  LoanRequestStatus,
  Role,
  TxnType,
} from '@/types/database'

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' })

// `column IN ('a', 'b', ...)` for a CHECK constraint.
const oneOf = (column: unknown, values: readonly string[]): SQL =>
  sql`${column} in (${sql.raw(values.map((v) => `'${v}'`).join(', '))})`

export const ROLES = ['admin', 'staff'] as const satisfies readonly Role[]
export const TXN_TYPES = ['IN', 'OUT', 'RETURN', 'ADJUST'] as const satisfies readonly TxnType[]
export const LOAN_REQUEST_STATUSES = [
  'pending',
  'countered',
  'accepted',
  'declined',
  'expired',
  'withdrawn',
  'fulfilled',
  'no_show',
] as const satisfies readonly LoanRequestStatus[]
export const LENDING_INTERVALS = [
  'week_1',
  'week_2',
  'week_3',
  'month_1',
  'indefinite',
] as const satisfies readonly LendingInterval[]
export const AUDIT_ACTIONS = [
  'create',
  'update',
  'delete',
  'activate',
  'deactivate',
  'resolve',
  'grant_access',
  'resend_access',
] as const satisfies readonly AuditAction[]
export const AUDIT_ENTITY_TYPES = [
  'product',
  'category',
  'staff',
  'transaction',
  'loan_request',
  'settings',
] as const satisfies readonly AuditEntityType[]

export const profiles = pgTable(
  'profiles',
  {
    uid: text('uid').primaryKey(), // Firebase Auth uid
    full_name: text('full_name').notNull(),
    role: text('role').$type<Role>().notNull(),
    created_at: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [check('profiles_role_check', oneOf(t.role, ROLES))],
)

export const categories = pgTable('categories', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  description: text('description'),
  created_at: timestamptz('created_at').notNull().defaultNow(),
})

export const products = pgTable(
  'products',
  {
    id: text('id').primaryKey(),
    category_id: text('category_id').references(() => categories.id),
    category_name: text('category_name'), // kept for compatibility
    name: text('name').notNull(),
    description: text('description'),
    quantity_on_hand: integer('quantity_on_hand').notNull().default(0),
    reorder_threshold: integer('reorder_threshold').notNull().default(0),
    available: boolean('available').notNull().default(true),
    location: text('location').notNull().default(''),
    lend_from: date('lend_from', { mode: 'string' }),
    lend_to: date('lend_to', { mode: 'string' }),
    lending_interval: text('lending_interval').$type<LendingInterval>(),
    images: text('images').array().notNull().default(sql`'{}'::text[]`),
    created_at: timestamptz('created_at').notNull().defaultNow(),
    updated_at: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check('products_quantity_on_hand_check', sql`${t.quantity_on_hand} >= 0`),
    check(
      'products_lending_interval_check',
      sql`${t.lending_interval} is null or ${oneOf(t.lending_interval, LENDING_INTERVALS)}`,
    ),
    index('products_category_id_idx').on(t.category_id),
  ],
)

export const productBarcodes = pgTable(
  'product_barcodes',
  {
    barcode: text('barcode').primaryKey(), // one barcode can belong to one product only
    product_id: text('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    position: integer('position').notNull().default(0), // keeps the order; 0 is the primary barcode
  },
  (t) => [index('product_barcodes_product_id_idx').on(t.product_id, t.position)],
)

export const staff = pgTable(
  'staff',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    surname: text('surname').notNull(),
    full_name: text('full_name').notNull(),
    email: text('email'),
    department: text('department'),
    card_uid: text('card_uid').unique(), // the unique constraint also serves lookups by card
    is_active: boolean('is_active').notNull().default(true),
    uid: text('uid').unique(), // Firebase Auth uid; the unique constraint also serves lookups by uid
    is_admin_account: boolean('is_admin_account').notNull().default(false),
    created_at: timestamptz('created_at').notNull().defaultNow(),
    updated_at: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('staff_email_lower_uq').on(sql`lower(${t.email})`)],
)

export const transactions = pgTable(
  'transactions',
  {
    id: text('id').primaryKey(),
    transaction_type: text('transaction_type').$type<TxnType>().notNull(),
    reference_no: text('reference_no').notNull().unique(),
    staff_id: text('staff_id').references(() => staff.id),
    staff_name: text('staff_name'), // frozen at write time
    user_id: text('user_id'),
    operator_name: text('operator_name'), // frozen at write time
    notes: text('notes'),
    return_date: date('return_date', { mode: 'string' }),
    linked_txn_id: text('linked_txn_id').references((): AnyPgColumn => transactions.id),
    manual_override: boolean('manual_override'),
    lend_from: date('lend_from', { mode: 'string' }),
    lend_to: date('lend_to', { mode: 'string' }),
    linked_request_id: text('linked_request_id').references((): AnyPgColumn => loanRequests.id),
    linked_request_ref: text('linked_request_ref'),
    created_at: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    check('transactions_type_check', oneOf(t.transaction_type, TXN_TYPES)),
    index('transactions_staff_created_idx').on(t.staff_id, t.created_at),
    index('transactions_type_created_idx').on(t.transaction_type, t.created_at),
  ],
)

export const transactionLines = pgTable(
  'transaction_lines',
  {
    id: text('id').primaryKey(),
    transaction_id: text('transaction_id')
      .notNull()
      .references(() => transactions.id),
    product_id: text('product_id')
      .notNull()
      .references(() => products.id),
    product_name: text('product_name').notNull(), // frozen at write time
    barcode: text('barcode'),
    issued_barcode: text('issued_barcode'),
    line_no: integer('line_no').notNull(), // 0-based scan order within the transaction ("issue order" reads by created_at, line_no)
    quantity: integer('quantity').notNull(),
    unit_cost: numeric('unit_cost', { mode: 'number' }).notNull().default(0),
    created_at: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    check('transaction_lines_quantity_check', sql`${t.quantity} > 0`),
    index('transaction_lines_transaction_id_idx').on(t.transaction_id),
    index('transaction_lines_product_id_idx').on(t.product_id),
  ],
)

export const returnWaivers = pgTable(
  'return_waivers',
  {
    id: text('id').primaryKey(),
    transaction_id: text('transaction_id')
      .notNull()
      .references(() => transactions.id),
    product_id: text('product_id')
      .notNull()
      .references(() => products.id),
    product_name: text('product_name').notNull(),
    staff_id: text('staff_id').references(() => staff.id),
    staff_name: text('staff_name'),
    quantity: integer('quantity').notNull(),
    reason: text('reason'),
    created_at: timestamptz('created_at').notNull().defaultNow(),
    resolved_by_uid: text('resolved_by_uid'),
    resolved_by_name: text('resolved_by_name'),
  },
  (t) => [
    check('return_waivers_quantity_check', sql`${t.quantity} > 0`),
    index('return_waivers_transaction_id_idx').on(t.transaction_id),
  ],
)

export const loanRequests = pgTable(
  'loan_requests',
  {
    id: text('id').primaryKey(),
    reference_no: text('reference_no').unique(), // null on requests that pre-date references
    staff_id: text('staff_id')
      .notNull()
      .references(() => staff.id),
    staff_name: text('staff_name').notNull(), // frozen at write time
    status: text('status').$type<LoanRequestStatus>().notNull().default('pending'),
    message: text('message'),
    admin_message: text('admin_message'),
    from_date: date('from_date', { mode: 'string' }).notNull(),
    to_date: date('to_date', { mode: 'string' }),
    original_from_date: date('original_from_date', { mode: 'string' }).notNull(),
    original_to_date: date('original_to_date', { mode: 'string' }),
    fulfilled_txn_id: text('fulfilled_txn_id').references((): AnyPgColumn => transactions.id),
    created_at: timestamptz('created_at').notNull().defaultNow(),
    updated_at: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check('loan_requests_status_check', oneOf(t.status, LOAN_REQUEST_STATUSES)),
    index('loan_requests_staff_status_idx').on(t.staff_id, t.status),
    index('loan_requests_status_idx').on(t.status),
  ],
)

export const loanRequestLines = pgTable(
  'loan_request_lines',
  {
    id: text('id').primaryKey(),
    request_id: text('request_id')
      .notNull()
      .references(() => loanRequests.id),
    product_id: text('product_id')
      .notNull()
      .references(() => products.id),
    product_name: text('product_name').notNull(),
    line_no: integer('line_no').notNull(), // 0-based position in the cart; lines read back in this order
    requested_quantity: integer('requested_quantity').notNull(),
    offered_quantity: integer('offered_quantity').notNull(),
    created_at: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [index('loan_request_lines_request_id_idx').on(t.request_id)],
)

export const auditLog = pgTable(
  'audit_log',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id'),
    user_name: text('user_name'),
    action: text('action').$type<AuditAction>().notNull(),
    entity_type: text('entity_type').$type<AuditEntityType>().notNull(),
    entity_id: text('entity_id').notNull(),
    before: jsonb('before').$type<Record<string, unknown> | null>(),
    after: jsonb('after').$type<Record<string, unknown> | null>(),
    created_at: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    check('audit_log_action_check', oneOf(t.action, AUDIT_ACTIONS)),
    check('audit_log_entity_type_check', oneOf(t.entity_type, AUDIT_ENTITY_TYPES)),
    index('audit_log_created_at_idx').on(t.created_at.desc()),
    index('audit_log_entity_idx').on(t.entity_type, t.entity_id),
  ],
)

export const settings = pgTable('settings', {
  key: text('key').primaryKey(), // e.g. 'notifications'
  value: jsonb('value').$type<Record<string, unknown>>().notNull(),
  updated_at: timestamptz('updated_at').notNull().defaultNow(),
})

export const sentNotifications = pgTable('sent_notifications', {
  key: text('key').primaryKey(), // dedupe key; insert with ON CONFLICT DO NOTHING
  toggle: text('toggle').notNull(),
  entity_id: text('entity_id'),
  created_at: timestamptz('created_at').notNull().defaultNow(),
})

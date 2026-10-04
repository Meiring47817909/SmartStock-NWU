import 'server-only'
import { count, getTableName, sql } from 'drizzle-orm'
import type { PgTable } from 'drizzle-orm/pg-core'
import { withTx, type Db, type Tx } from '@/server/db/client'
import {
  auditLog,
  categories,
  loanRequestLines,
  loanRequests,
  productBarcodes,
  products,
  profiles,
  returnWaivers,
  sentNotifications,
  settings,
  staff,
  transactionLines,
  transactions,
} from '@/server/db/schema'
import type { ImportPlan, ImportRows, ImportTableName } from '@/server/import/mapFirestore'

// The write half of the Firestore importer: puts a clean ImportPlan into PostgreSQL in ONE transaction.
//
//   - A plan with any problem is refused before a connection is used.
//   - Without `replace`, the app tables are locked (EXCLUSIVE: reads go on, writes wait) and must all be empty, or the
//     import is refused; the lock makes "checked empty" still true when the rows go in.
//   - With `replace`, the app tables are TRUNCATEd inside the same transaction, so a failure later restores them.
//   - Any failing insert (or a final count that doesn't match the plan) throws, and the whole transaction rolls back:
//     the database is left exactly as it was.
//
// Foreign keys: none of the schema's constraints are DEFERRABLE, so the insert order satisfies every one of them:
//   profiles, categories, products, product_barcodes, staff,
//   loan_requests (fulfilled_txn_id left null for now),
//   transactions (in link order: a RETURN after the Stock Out it points at; linked_request_id is already satisfied),
//   transaction_lines, return_waivers, loan_request_lines,
//   loan_requests.fulfilled_txn_id (second pass: the only cycle, loan_requests <-> transactions),
//   audit_log, settings, sent_notifications.
// The second pass updates loan_requests (a mutable table) rather than transactions, so the append-only ledger is only
// ever inserted, once, verbatim.

/** Every app table, by the plan's names. A test checks this is exactly the schema's table list. */
export const IMPORT_TABLES: Record<ImportTableName, PgTable> = {
  profiles,
  categories,
  products,
  product_barcodes: productBarcodes,
  staff,
  loan_requests: loanRequests,
  transactions,
  transaction_lines: transactionLines,
  return_waivers: returnWaivers,
  loan_request_lines: loanRequestLines,
  audit_log: auditLog,
  settings,
  sent_notifications: sentNotifications,
}

export type ImportCounts = Record<ImportTableName, number>

/** The import was refused before anything was written (problems in the plan, or a database that already has data). */
export class ImportRefusedError extends Error {}

/** Rows per INSERT: well under PostgreSQL's 65535 bind parameters for the widest table. */
const CHUNK = 500

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

async function insertRows(tx: Tx, table: PgTable, rows: Record<string, unknown>[]): Promise<void> {
  for (let i = 0; i < rows.length; i += CHUNK) {
    await tx.insert(table).values(rows.slice(i, i + CHUNK) as never)
  }
}

/** Transactions grouped so each group only links to transactions in earlier groups (Stock Outs before their Returns). */
function inLinkOrder(rows: ImportRows['transactions']): ImportRows['transactions'][] {
  const ids = new Set(rows.map((r) => r.id))
  const done = new Set<string>()
  const levels: ImportRows['transactions'][] = []
  let remaining = rows
  while (remaining.length > 0) {
    // A link to an id outside the plan is left for the foreign key to refuse (planImport reports it first).
    const ready = remaining.filter((r) => !r.linked_txn_id || done.has(r.linked_txn_id) || !ids.has(r.linked_txn_id))
    if (ready.length === 0) throw new Error(`Transactions ${remaining.map((r) => r.id).join(', ')} link to each other in a loop.`)
    for (const r of ready) done.add(r.id)
    levels.push(ready)
    remaining = remaining.filter((r) => !done.has(r.id))
  }
  return levels
}

async function countAll(tx: Tx | Db): Promise<ImportCounts> {
  const out = {} as ImportCounts
  for (const [name, table] of Object.entries(IMPORT_TABLES) as [ImportTableName, PgTable][]) {
    const [row] = await tx.select({ n: count() }).from(table)
    out[name] = row.n
  }
  return out
}

export async function runImport(db: Db, plan: ImportPlan, opts: { replace: boolean }): Promise<ImportCounts> {
  if (plan.problems.length > 0) {
    throw new ImportRefusedError(`The plan has ${plural(plan.problems.length, 'problem')}: fix them in Firestore and plan again. Nothing was written.`)
  }
  const { rows } = plan
  const tableList = Object.values(IMPORT_TABLES)
    .map((t) => `"${getTableName(t)}"`)
    .join(', ')

  return withTx(db, async (tx) => {
    if (opts.replace) {
      await tx.execute(sql.raw(`truncate table ${tableList}`))
    } else {
      await tx.execute(sql.raw(`lock table ${tableList} in exclusive mode`))
      const filled = Object.entries(await countAll(tx))
        .filter(([, n]) => n > 0)
        .map(([name, n]) => `${name} (${n})`)
      if (filled.length > 0) {
        throw new ImportRefusedError(
          `The database already has data: ${filled.join(', ')}. Nothing was written. ` +
            'Import into an empty database, or pass --replace to empty the app tables first (in the same transaction).',
        )
      }
    }

    await insertRows(tx, profiles, rows.profiles)
    await insertRows(tx, categories, rows.categories)
    await insertRows(tx, products, rows.products)
    await insertRows(tx, productBarcodes, rows.product_barcodes)
    await insertRows(tx, staff, rows.staff)
    await insertRows(tx, loanRequests, rows.loan_requests.map((r) => ({ ...r, fulfilled_txn_id: null })))
    for (const level of inLinkOrder(rows.transactions)) await insertRows(tx, transactions, level)
    await insertRows(tx, transactionLines, rows.transaction_lines)
    await insertRows(tx, returnWaivers, rows.return_waivers)
    await insertRows(tx, loanRequestLines, rows.loan_request_lines)

    const fulfilled = rows.loan_requests.filter((r) => r.fulfilled_txn_id)
    let linked = 0
    for (let i = 0; i < fulfilled.length; i += CHUNK) {
      const values = sql.join(
        fulfilled.slice(i, i + CHUNK).map((r) => sql`(${r.id}::text, ${r.fulfilled_txn_id}::text)`),
        sql`, `,
      )
      const result = await tx.execute(
        sql`update ${loanRequests} set fulfilled_txn_id = v.txn from (values ${values}) as v(id, txn) where ${loanRequests.id} = v.id`,
      )
      linked += result.rowCount ?? 0
    }

    await insertRows(tx, auditLog, rows.audit_log)
    await insertRows(tx, settings, rows.settings)
    await insertRows(tx, sentNotifications, rows.sent_notifications)

    // Every planned row is there, and nothing else: otherwise roll the whole import back.
    const counts = await countAll(tx)
    const off = (Object.keys(IMPORT_TABLES) as ImportTableName[]).filter((name) => counts[name] !== rows[name].length)
    if (off.length > 0 || linked !== fulfilled.length) {
      const detail = off.map((name) => `${name}: planned ${rows[name].length}, found ${counts[name]}`)
      if (linked !== fulfilled.length) detail.push(`fulfilled requests: planned ${fulfilled.length}, linked ${linked}`)
      throw new Error(`Import check failed (${detail.join('; ')}); rolled back.`)
    }
    return counts
  })
}

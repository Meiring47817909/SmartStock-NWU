import { sql } from 'drizzle-orm'
import type { Db } from '@/server/db/client'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Hold a row lock on `table.id` from another connection until released, so later transactions queue behind it. */
export async function holdRowLock(on: Db, table: string, id: string) {
  let release!: () => void
  const released = new Promise<void>((r) => (release = r))
  let locked!: () => void
  const gotLock = new Promise<void>((r) => (locked = r))
  const done = on.transaction(async (tx) => {
    await tx.execute(sql`select 1 from ${sql.raw(table)} where id = ${id} for update`)
    locked()
    await released
  })
  await gotLock
  return { release, done }
}

/** Wait until `count` database sessions are blocked waiting for a lock (polls pg_stat_activity; fails after `timeoutMs`). */
export async function waitForLockWaiters(db: Db, count: number, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const res = await db.execute(
      sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
    )
    const waiting = (res.rows[0] as { n: number }).n
    if (waiting >= count) return
    if (Date.now() > deadline) throw new Error(`Timed out: ${waiting} of ${count} sessions waiting on a lock.`)
    await sleep(10)
  }
}

/**
 * Hold a row lock on `table.id` from `lockDb`, start every attempt, wait until all of them are blocked on a lock, then
 * release it and settle them. Without a row lock in the code under test the attempts never block, and this times out.
 */
export async function raceBehindLock<T>(db: Db, lockDb: Db, table: string, id: string, attempts: (() => Promise<T>)[]) {
  const held = await holdRowLock(lockDb, table, id)
  try {
    const all = Promise.allSettled(attempts.map((a) => a()))
    await waitForLockWaiters(db, attempts.length)
    held.release()
    await held.done
    return await all
  } finally {
    held.release()
  }
}

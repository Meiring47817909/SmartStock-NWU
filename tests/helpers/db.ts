import path from 'node:path'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { closeDb, getDb, type Db } from '@/server/db/client'

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/smartstock_test'

/** Empty the test database and run every migration, so each test starts from the real schema with no rows. */
export async function resetTestDb(): Promise<Db> {
  const db = getDb(TEST_DATABASE_URL)
  await db.execute(sql`drop schema if exists drizzle cascade`)
  await db.execute(sql`drop schema if exists public cascade`)
  await db.execute(sql`create schema public`)
  await migrate(db, { migrationsFolder: path.resolve(process.cwd(), 'drizzle') })
  return db
}

export async function closeTestDb(): Promise<void> {
  await closeDb(TEST_DATABASE_URL)
}

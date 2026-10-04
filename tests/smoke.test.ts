import { Client } from 'pg'
import { describe, expect, it } from 'vitest'

const url = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/smartstock_test'

describe('test database', () => {
  it('reaches the test database', async () => {
    const client = new Client({ connectionString: url })
    try {
      await client.connect()
    } catch (err) {
      throw new Error(
        `Could not connect to the test database. Check that PostgreSQL is running (npm run db) or fix TEST_DATABASE_URL. ${(err as Error).message}`,
      )
    }
    try {
      const res = await client.query<{ ok: number }>('select 1 as ok')
      expect(res.rows[0].ok).toBe(1)
    } finally {
      await client.end()
    }
  })
})

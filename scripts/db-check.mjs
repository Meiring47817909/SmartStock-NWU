// Read-only check of the database DATABASE_URL points at: which server and database, how many app tables,
// and which migrations have been applied. Safe to run against Cloud SQL (through the Auth Proxy) or the local
// database; it never writes anything.
//   npm run db:check
import pg from 'pg'

const url = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/smartstock'
const client = new pg.Client(url)

try {
  await client.connect()
  const who = await client.query('select current_database() as database, current_user as "user", version() as version')
  const tables = await client.query(
    "select count(*)::int as n from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'",
  )
  const hasJournal = await client.query("select to_regclass('drizzle.__drizzle_migrations') is not null as ok")
  const applied = hasJournal.rows[0].ok
    ? (await client.query('select id, created_at from drizzle.__drizzle_migrations order by id')).rows
    : []
  const { database, user, version } = who.rows[0]
  console.log(`Connected:   database "${database}" as "${user}"`)
  console.log(`Server:      ${version.split(',')[0]}`)
  console.log(`App tables:  ${tables.rows[0].n} (13 expected after migrating)`)
  console.log(`Migrations:  ${applied.length} applied (3 expected)`)
} catch (e) {
  console.error(`Could not check the database: ${e.message}`)
  process.exitCode = 1
} finally {
  await client.end().catch(() => {})
}

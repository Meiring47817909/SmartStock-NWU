// Database-name guard for the destructive scripts: `npm run db:reset` and the seeds' `--reset`. Their host check
// ("local only") cannot tell Cloud SQL behind the Auth Proxy (127.0.0.1) from the local container, so they also refuse
// any database whose name is not one of the local ones unless `--force` is given. No `server-only` imports here:
// db-reset runs under plain tsx.

/** The databases the local setup creates (handout "Local setup"): the app's and the tests'. */
export const RESETTABLE_DATABASES = ['smartstock', 'smartstock_test'] as const

/** Throws unless `name` is one of RESETTABLE_DATABASES (or `force`). `what` names the action in the message. */
export function assertResettableDatabaseName(name: string, force: boolean, what: string): void {
  if (force || (RESETTABLE_DATABASES as readonly string[]).includes(name)) return
  throw new Error(
    `Refusing to ${what} the database "${name}": only ${RESETTABLE_DATABASES.join(' or ')} can be reset. ` +
      'Pass --force if you really mean it.',
  )
}

/** Anything that runs a query the way pg's Pool and Client do. */
export interface Queryable {
  query(text: string): Promise<{ rows: Record<string, unknown>[] }>
}

/** Ask the server which database this connection is really on (`current_database()`), then apply the name check. */
export async function assertResettableDatabase(db: Queryable, force: boolean, what: string): Promise<string> {
  const { rows } = await db.query('select current_database() as name')
  const name = String(rows[0]?.name ?? '')
  assertResettableDatabaseName(name, force, what)
  return name
}

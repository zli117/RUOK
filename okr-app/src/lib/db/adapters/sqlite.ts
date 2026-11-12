/**
 * Concrete SQLite adapter facade (WP10 / U1 / D-07).
 *
 * {@link SqliteDatabaseServices} is the awaitable worker facade used by the
 * lifecycle, `createDatabaseServices` and tests. It keeps the exact public
 * contract (`DatabaseServices`) while executing every synchronous SQLite
 * operation in a worker-private engine (`sqlite-local.ts` via
 * `sqlite-worker.ts`), off the HTTP event loop. No better-sqlite3 call runs on
 * the main thread or in the server bundle.
 *
 * `runSqlitePreparation` runs WP03 migrate/verify in a separate preparation
 * worker that closes before the runtime worker opens.
 *
 * The synchronous implementation intentionally lives in `sqlite-local.ts`,
 * which is imported only by the worker threads and never here.
 */
export { SqliteDatabaseServices, runPreparation, runSqlitePreparation } from './sqlite-worker-client';
export type { SqliteDatabaseServices as SqliteDatabaseServicesInstance } from './sqlite-worker-client';
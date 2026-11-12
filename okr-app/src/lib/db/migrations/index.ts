/**
 * Migration lifecycle public surface (FR-004 / FR-005 / T009).
 *
 * Canonical migration orchestration + dialect runners. Importing this module
 * performs no I/O; the backend is opened/migrated only when `migrateDatabase`
 * is invoked.
 */
export * from './contracts'
export * from './migration-files'
export * from './fingerprint'
export { getExpectedSqliteLayout } from './expected-sqlite'
export { inspectSqlite } from './sqlite-inspect'
export { migrateDatabase, defaultMigrationsFolder } from './migrate'
export type { MigrateOptions } from './migrate'
export { runSqliteMigrations } from './sqlite-migrator'
export { runSqliteVerify } from './sqlite-verify'
export {
	runPostgresMigrations,
	acquirePostgresMigrationLock,
	releasePostgresMigrationLock,
	createPostgresMigrationClient
} from './postgres-migrator'
export {
	runPostgresVerify,
	parsePostgresTables,
	type PostgresTableDescriptor,
	type PostgresTableColumn
} from './postgres-verify'
/**
 * Persistence factory (FR-001 / FR-003 / T007 / T011/T012).
 *
 * Public entrypoint for the typed persistence boundary. Re-exports the
 * canonical contracts, models, validated configuration, the lifecycle/
 * ownership helpers and the migration surface. `createDatabaseServices`
 * returns the concrete adapter selected by a validated {@link DatabaseConfig}
 * there is never a silent backend fallback and exactly one backend is opened
 * per process.
 *
 * Importing this module is free of connection side effects: no file or socket
 * is opened until `open()` (or {@link openDatabase}) is called, and no
 * migration runs until `migrateDatabase` / `openDatabase` is invoked.
 */
export * from './contracts'
export * from './models'
export * from './config'
export * from './lifecycle'
export * from './migrations'
// Shared migration-mode parser (FR-003 / T010): published here so the
// application lifecycle (WP04) and the CLI resolve MIGRATION_MODE identically.
export * from './migration-mode'

export { SqliteDatabaseServices } from './adapters/sqlite'
export { PostgresDatabaseServices } from './adapters/postgres'
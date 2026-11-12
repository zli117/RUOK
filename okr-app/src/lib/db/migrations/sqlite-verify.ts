/**
 * SQLite schema-verification mode (FR-002 / FR-005 / T008, T009).
 *
 * For deployments where the runtime role may not execute DDL (separate
 * migration role), verification asserts the target schema + history are
 * already in place WITHOUT mutating anything. It shares the exact semantic
 * inspector and classifier used by the migrator, so a definition hidden behind
 * an expected name, a journal that is corrupt/unknown/future, or a layout still
 * needing adoption deltas is reported as not ready rather than repaired.
 *
 * An un-migrated database, an unrecognized layout, or a layout still needing
 * adoption deltas is reported as not ready. Verify is strictly read-only: it
 * issues no DDL and no journal writes and performs no persistent pragma change.
 */
import type Database from 'better-sqlite3'
import { getExpectedSqliteLayout } from './expected-sqlite'
import { classifyLegacy } from './fingerprint'
import { readMigrationFolder } from './migration-files'
import { inspectSqlite } from './sqlite-inspect'
import type { MigrationResult } from './contracts'

export function runSqliteVerify(
	sqlite: Database.Database,
	migrationsFolder: string
): MigrationResult {
	const { migrations } = readMigrationFolder(migrationsFolder)
	const expected = getExpectedSqliteLayout(migrations)

	// Shared semantic inspection; read-only, no pragma mutation.
	const current = inspectSqlite(sqlite)
	const classification = classifyLegacy(current, expected, migrations)

	switch (classification.kind) {
		case 'fresh':
			throw new Error(
				'SQLite schema verification failed: database has not been migrated. Run the migration role first.'
			)
		case 'ready':
			return {
				dialect: 'sqlite',
				classification: 'ready',
				appliedCount: migrations.length,
				recorded: 0,
				schemaVersion: migrations.length - 1
			}
		case 'adopt':
			throw new Error(
				`SQLite schema verification failed: schema still requires adoption ` +
					`(${classification.addColumns.length} column(s), ${classification.addIndexes.length} index(es), ` +
					`${classification.journalToRecord.length} journal record(s)). Run the migration role first; the runtime role cannot DDL.`
			)
		case 'reject':
			throw new Error(
				`Unrecognized SQLite schema; verification failed. Reasons: ${classification.reasons.join('; ')}`
			)
	}
}
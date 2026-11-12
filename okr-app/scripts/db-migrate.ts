/**
 * Standalone migration CLI (FR-004 / FR-005 / T009/T011).
 *
 * Runs the selected backend's checked migration history (or schema
 * verification) using the SAME canonical config + runner as the startup
 * lifecycle, so the runtime container can migrate with a separate DDL role and
 * ship the migration command without dev dependencies.
 *
 * Usage (from `okr-app/`):
 *   node <bundled>            # migrate (default)
 *   MIGRATION_MODE=verify node <bundled>   # schema verification only (no DDL)
 *
 * Environment: DATABASE_TYPE / DATABASE_PATH / DATABASE_URL / TLS settings are
 * read through {@link loadConfig}. Output is redacted (no credentials).
 */
import { loadConfig } from '../src/lib/db/config'
import { parseMigrationMode } from '../src/lib/db/migration-mode'
import { migrateDatabase } from '../src/lib/db/migrations'

function fail(message: string): never {
	console.error(`[db-migrate] ${message}`)
	process.exitCode = 1
	throw new Error(message)
}

async function main(): Promise<void> {
	// Shared parser (FR-003 / T010): absent -> migrate, invalid -> redacted error.
	const mode = parseMigrationMode(process.env.MIGRATION_MODE)

	let config
	try {
		config = loadConfig(process.env)
	} catch (err) {
		fail(`Configuration error: ${(err as Error).message}`)
		return
	}

	console.log(`[db-migrate] backend=${config.type} mode=${mode}`)
	try {
		const result = await migrateDatabase(config, { mode })
		console.log(
			`[db-migrate] OK classification=${result.classification} applied=${result.appliedCount} ` +
				`recorded=${result.recorded} schemaVersion=${result.schemaVersion}`
		)
	} catch (err) {
		fail(`Migration failed: ${(err as Error).message}`)
	}
}

main().catch((err) => {
	console.error(`[db-migrate] Unexpected error: ${(err as Error).message}`)
	process.exitCode = 1
})
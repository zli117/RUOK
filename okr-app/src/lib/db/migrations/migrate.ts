/**
 * Canonical migration orchestration entry (FR-003 / FR-004 / FR-005 / T009/T011/T012).
 *
 * Runs the selected backend's checked migration history (or a read-only schema
 * verification) ahead of opening the runtime connection. Used by the startup
 * lifecycle and the standalone `db:migrate` CLI — one config contract, one
 * runner. Importing this module performs no I/O; the backend is opened and
 * migrated only when `migrateDatabase` is invoked.
 *
 * No-DDL verification (DRIFT-3 / T011 / T012): `verify` mode is a separate,
 * strictly read-only execution path. It branches BEFORE any object creation:
 *
 *   - SQLite verify opens the file with `readonly` + `fileMustExist` and never
 *     calls `mkdir` (a missing path/dir remains absent).
 *   - PostgreSQL verify uses `runPostgresVerify` (read-only transaction, no
 *     `createJournal`, no advisory lock) so a data-only runtime role can check
 *     migrated storage.
 */
import { dirname, join } from 'path'
import { mkdirSync } from 'fs'
import { runSqliteMigrations } from './sqlite-migrator'
import {
	acquirePostgresMigrationLock,
	createPostgresMigrationClient,
	releasePostgresMigrationLock,
	runPostgresMigrations
} from './postgres-migrator'
import type { DatabaseConfig } from '../contracts'
import type { MigrationResult } from './contracts'

export interface MigrateOptions {
	/**
	 * `verify` runs only schema/history verification without applying DDL
	 * (for deployments where the runtime role may not migrate). Default `migrate`.
	 */
	mode?: 'migrate' | 'verify'
	/** Override the migration folder (defaults to the configured dialect folder). */
	migrationsFolder?: string
}

/** Default migration folder per dialect (relative to the process cwd). */
export function defaultMigrationsFolder(dialect: 'sqlite' | 'postgres'): string {
	return join(process.cwd(), dialect === 'sqlite' ? 'drizzle' : 'drizzle-postgres')
}

/**
 * Migrate (or verify) the selected backend's schema. Serializes concurrent
 * migration attempts (SQLite exclusive transaction; PostgreSQL advisory lock).
 * Verify performs zero DDL on both backends and never creates paths/files.
 */
export async function migrateDatabase(
	config: DatabaseConfig,
	options: MigrateOptions = {}
): Promise<MigrationResult> {
	const mode = options.mode ?? 'migrate'

	if (config.type === 'sqlite') {
		if (mode === 'verify') {
			// T012: read-only, fileMustExist, no mkdir. A missing path/dir is
			// rejected without being created; no persistent pragmas are set.
			// The driver is imported lazily so this module never pulls
			// better-sqlite3 into a bundle that only runs the postgres branch.
			const { default: Database } = await import('better-sqlite3')
			const sqlite = new Database(config.path, { readonly: true, fileMustExist: true })
			try {
				const { runSqliteVerify } = await import('./sqlite-verify')
				return runSqliteVerify(sqlite, options.migrationsFolder ?? defaultMigrationsFolder('sqlite'))
			} finally {
				sqlite.close()
			}
		}
		// Migrate retains the original create behavior (mkdir + create file).
		const { default: Database } = await import('better-sqlite3')
		mkdirSync(dirname(config.path), { recursive: true })
		const sqlite = new Database(config.path)
		try {
			return runSqliteMigrations(
				sqlite,
				config,
				options.migrationsFolder ?? defaultMigrationsFolder('sqlite')
			)
		} finally {
			sqlite.close()
		}
	}

	const client = createPostgresMigrationClient(config)
	try {
		await client.connect()
		if (mode === 'verify') {
			// T011: read-only verification — no createJournal, no advisory lock.
			const { runPostgresVerify } = await import('./postgres-verify')
			return await runPostgresVerify(
				client,
				config,
				options.migrationsFolder ?? defaultMigrationsFolder('postgres')
			)
		}
		await acquirePostgresMigrationLock(client)
		try {
			return await runPostgresMigrations(
				client,
				config,
				options.migrationsFolder ?? defaultMigrationsFolder('postgres')
			)
		} finally {
			await releasePostgresMigrationLock(client)
		}
	} finally {
		await client.end().catch(() => undefined)
	}
}
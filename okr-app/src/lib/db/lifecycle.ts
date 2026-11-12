/**
 * Selected-backend connection ownership (FR-001 / FR-005 / T007 / T011/T012 / D-04).
 *
 * A process owns at most one {@link DatabaseServices} instance for exactly one
 * configured backend. `open`/`close`/`isOpen` are awaitable and idempotent.
 * Opening happens at runtime (startup/readiness), never at import or build
 * time, so importing the database module is free of connection side effects.
 *
 * One lifecycle owner (D-04): concurrent callers share a single in-flight open
 * attempt; the attempt is cleared in `finally`; services/schema version are
 * published ONLY on success; partially-opened resources are closed on failure;
 * shutdown/reset fence stale completions via a generation counter; and a
 * bounded retry cooldown (<=1s) prevents a tight retry loop over a failing
 * storage. Readiness is an asynchronous bounded LIVE check (D-05) — never a
 * cached-success shortcut.
 *
 * Migration (FR-004/FR-005): `openDatabase` runs the selected backend's checked
 * migration history (or schema verification in `verify` mode) INSIDE a dedicated
 * preparation worker BEFORE opening the runtime connection, serializing concurrent
 * startups/CLI. The main/HTTP thread never runs the SQLite driver or the dialect
 * migration runners synchronously. The process-wide readiness surface reflects
 * whether the backend is open AND migrated.
 *
 * The singleton is optional: callers may use {@link createDatabaseServices} to
 * manage their own instance (e.g. tests). Importing this module performs no I/O.
 */
import type { DatabaseConfig, DatabaseServices } from './contracts'
import type { ReadinessState } from './migrations'
import type { MigrateOptions } from './migrations'
import { PostgresDatabaseServices } from './adapters/postgres'
import { SqliteDatabaseServices, runPreparation } from './adapters/sqlite'
import { loadConfig } from './config'
import { parseMigrationMode } from './migration-mode'

/** Construct the concrete adapter selected by a validated config. */
export function createDatabaseServices(config: DatabaseConfig): DatabaseServices {
	switch (config.type) {
		case 'sqlite':
			return new SqliteDatabaseServices(config)
		case 'postgres':
			return new PostgresDatabaseServices(config)
	}
}

// ---------------------------------------------------------------------------
// Optional process-wide singleton (one lifecycle owner per process)
// ---------------------------------------------------------------------------

let singleton: DatabaseServices | undefined
let singletonConfig: DatabaseConfig | undefined
let lastMigrationVersion: number | undefined
/** Shared in-flight open attempt; concurrent callers await the same promise. */
let opening: Promise<DatabaseServices> | undefined
/** Generation counter: reset/shutdown increments it to fence stale completions. */
let generation = 0
/** Timestamp of the last failed open attempt (bounded retry cooldown). */
let lastFailedAt = 0
/** Maximum wait before a new open attempt is allowed after a failure. */
const RETRY_COOLDOWN_MS = 1000

/**
 * Return the process-wide services, constructing it lazily on first use with
 * the provided config. Importing this module has no side effects; the backend
 * is only opened when {@link openDatabase} is called.
 */
export function getDatabaseServices(config?: DatabaseConfig): DatabaseServices {
	if (!singleton) {
		if (!config) {
			throw new Error(
				'getDatabaseServices requires a DatabaseConfig on first use (no instance open yet)'
			)
		}
		singleton = createDatabaseServices(config)
		singletonConfig = config
	}
	return singleton
}

/**
 * Open the process-wide backend and make it ready. Idempotent. Runs the
 * selected backend's migrations (or verification in `verify` mode) first.
 *
 * One shared open attempt per process/generation: concurrent callers share the
 * in-flight attempt. The migrate/verify step is executed inside a dedicated
 * preparation worker (via {@link runPreparation}) for BOTH backends, so no
 * synchronous SQLite I/O (or the SQLite driver / dialect migration runners)
 * ever runs on the HTTP thread. This is the single lifecycle boundary through
 * which migrations are reached.
 */
export async function openDatabase(
	config?: DatabaseConfig,
	migrateOptions: MigrateOptions = {}
): Promise<DatabaseServices> {
	const services = getDatabaseServices(config)
	const resolved = getOpenConfig() ?? config
	if (!resolved) return services
	if (services.isOpen()) return services
	if (opening) return opening

	// Bounded retry cooldown: after a failed attempt, refuse a new one for a
	// short window so a failing storage never triggers a tight retry loop.
	if (Date.now() - lastFailedAt < RETRY_COOLDOWN_MS) {
		throw new Error('Database open attempt is cooling down; retry shortly')
	}

	const gen = generation
	let attempt!: Promise<DatabaseServices>
	attempt = (async () => {
		try {
			const result = await runPreparation(resolved, migrateOptions)
			if (gen !== generation) {
				throw new Error('Database open attempt superseded by reset/shutdown')
			}
			await services.open()
			if (gen !== generation) {
				throw new Error('Database open attempt superseded by reset/shutdown')
			}
			// Successful-only publication: never publish a stale/partial state.
			lastMigrationVersion = result.schemaVersion
			return services
		} catch (err) {
			if (gen === generation) {
				// Partial-resource close so a retry can recreate invalid ownership.
				lastFailedAt = Date.now()
				await services.close().catch(() => undefined)
			}
			throw err
		} finally {
			// Clear the shared attempt so a later retry can start a fresh one.
			if (opening === attempt) opening = undefined
		}
	})()
	opening = attempt
	return attempt
}

/** Whether the process-wide backend is currently open. */
export function isDatabaseOpen(): boolean {
	return singleton?.isOpen() ?? false
}

/**
 * Login-independent readiness of the process-wide backend (FR-012 / T012 / D-05).
 *
 * Asynchronous: once the backend is open, readiness resolves after a bounded
 * LIVE availability query against the selected service — never a cached-success
 * shortcut. If the backend is not yet open (opening attempt in progress or
 * failed), resolves `ready:false` immediately without waiting for migration.
 * Never includes secrets or connection strings.
 */
export async function getReadiness(): Promise<ReadinessState> {
	const config = getOpenConfig()
	const open = isDatabaseOpen()
	if (!config) {
		return { ready: false, open }
	}
	if (!open) {
		return { ready: false, dialect: config.type, open, schemaVersion: lastMigrationVersion }
	}
	let available = false
	try {
		available = await singleton!.checkAvailability()
	} catch {
		available = false
	}
	return { ready: available, dialect: config.type, open, schemaVersion: lastMigrationVersion }
}

/**
 * Trigger one asynchronous opening attempt without awaiting it (fire-and-forget).
 *
 * Used by the readiness probe so it can start initialization without blocking
 * on a long migration. Concurrent calls are no-ops while an attempt is already
 * in flight or the backend is already open.
 */
export function ensureOpenAttempted(config?: DatabaseConfig): void {
	if (isDatabaseOpen() || opening) return
	try {
		const mode = parseMigrationMode(process.env.MIGRATION_MODE)
		const cfg = config ?? loadConfig()
		void openDatabase(cfg, { mode }).catch((err: unknown) => {
			// Opening failures surface via readiness; never log secrets.
			console.error('[lifecycle] database opening attempt failed:', (err as Error).message)
		})
	} catch (err) {
		console.error('[lifecycle] database opening attempt failed:', (err as Error).message)
	}
}

/** Release all process-wide database resources. Idempotent. */
export async function closeDatabase(): Promise<void> {
	generation += 1 // fence any in-flight opening attempt against stale completion
	opening = undefined
	lastFailedAt = 0
	if (singleton) {
		await singleton.close()
	}
}

/** The validated config used for the open process-wide backend, if any. */
export function getOpenConfig(): DatabaseConfig | undefined {
	return singletonConfig
}

/** Clear the process-wide singleton (test isolation only). */
export function resetDatabaseForTests(): void {
	generation += 1 // fence any in-flight attempt
	opening = undefined
	lastFailedAt = 0
	singleton = undefined
	singletonConfig = undefined
	lastMigrationVersion = undefined
}

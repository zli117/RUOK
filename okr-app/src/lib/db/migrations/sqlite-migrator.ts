/**
 * SQLite migration execution (FR-002 / FR-004 / T008, T009).
 *
 * Dialect-specific migration/adoption runner. It owns the SQLite-specific
 * queries and synchronous transaction, while the shared semantic inspector,
 * canonical expected layout, classification and journal reconciliation live in
 * `sqlite-inspect.ts`, `expected-sqlite.ts`, `fingerprint.ts`,
 * `migration-files.ts`.
 *
 * Flow (T008 — inspect before mutation, atomic adoption):
 *  1. Set the connection-local busy timeout ONLY (no persistent journal-mode
 *     change yet).
 *  2. Inspect the semantic fingerprint and classify it against the
 *     migration-derived expected layout + full history.
 *  3. fresh        -> apply the full checked history in one transaction.
 *     ready        -> nothing to do (schema + journal already aligned).
 *     adopt        -> run a data-integrity (FK orphan) preflight, then apply
 *                     ONLY the supported additive deltas and record the
 *                     reconciled journal facts atomically in one transaction.
 *     reject       -> fail with reasons BEFORE any mutation.
 *  4. Only after a compatible transaction has COMMITTED is the persistent
 *     journal-mode pragma applied — an incompatible/rejected database is never
 *     mutated.
 *
 * better-sqlite3 transactions are synchronous: no `await` appears inside a
 * transaction callback in this module.
 */
import type Database from 'better-sqlite3'
import { getExpectedSqliteLayout } from './expected-sqlite'
import { classifyLegacy } from './fingerprint'
import { readMigrationFolder } from './migration-files'
import { inspectSqlite } from './sqlite-inspect'
import type { ForeignKeyDescriptor, MigrationResult } from './contracts'
import type { SqliteConfig } from '../contracts'

const JOURNAL_TABLE = '__drizzle_migrations'

function appliedWhen(sqlite: Database.Database): number[] {
	return (sqlite
		.prepare(`SELECT created_at FROM ${JOURNAL_TABLE}`)
		.all() as Array<{ created_at: number }>).map((r) => Number(r.created_at))
}

/**
 * Data-integrity preflight: ensure no orphaned foreign-key rows exist before a
 * legacy layout is adopted. Failures are reported and never auto-deleted.
 */
function assertFkIntegrity(sqlite: Database.Database, foreignKeys: ForeignKeyDescriptor[]): void {
	const orphans: string[] = []
	for (const edge of foreignKeys) {
		if (edge.columns.length === 0) continue
		const joinSql = edge.columns
			.map((c) => `child.\`${c.from}\` = parent.\`${c.to}\``)
			.join(' AND ')
		const whereSql = edge.columns.map((c) => `child.\`${c.from}\` IS NOT NULL`).join(' AND ')
		// A LEFT JOIN with no parent match nulls every parent column, so checking
		// the first referenced parent column is sufficient for the null test.
		const parentProbe = `parent.\`${edge.columns[0].to}\``
		const sql = `SELECT COUNT(*) AS c FROM \`${edge.child}\` child LEFT JOIN \`${edge.parent}\` parent ON ${joinSql} WHERE ${whereSql} AND ${parentProbe} IS NULL`
		const row = sqlite.prepare(sql).get() as { c: number }
		if (row.c > 0) {
			orphans.push(`${edge.child}.${edge.columns.map((c) => c.from).join(',')} -> ${edge.parent}`)
		}
	}
	if (orphans.length > 0) {
		throw new Error(
			`Legacy adoption aborted: foreign-key orphans found (${orphans.join(', ')}). ` +
				'No schema changes were applied. Fix or migrate the orphan data explicitly; orphan data is never auto-deleted.'
		)
	}
}

/**
 * Run migrations/adoption for a SQLite database against the checked history.
 * The caller owns the open {@link sqlite} connection (lifetime + close).
 *
 * Serialization (T008): the whole inspect -> classify -> apply sequence runs
 * inside a `BEGIN IMMEDIATE` transaction, which immediately acquires the write
 * (RESERVED) lock. A concurrent migrator blocks on the bounded busy_timeout,
 * then re-reads the now-converged state and no-ops — so two processes never
 * double-apply or race on the schema.
 */
export function runSqliteMigrations(
	sqlite: Database.Database,
	config: SqliteConfig,
	migrationsFolder: string
): MigrationResult {
	// Connection-local busy timeout may be set before inspection; the
	// persistent journal mode is deferred until a compatible commit (T008).
	sqlite.pragma(`busy_timeout = ${config.busyTimeoutMs}`)

	const { migrations } = readMigrationFolder(migrationsFolder)
	const expected = getExpectedSqliteLayout(migrations)

	sqlite.exec('BEGIN IMMEDIATE')
	let result: MigrationResult
	try {
		const current = inspectSqlite(sqlite)
		const classification = classifyLegacy(current, expected, migrations)

		switch (classification.kind) {
			case 'fresh': {
				applyFresh(sqlite, migrations)
				result = {
					dialect: 'sqlite',
					classification: 'fresh',
					appliedCount: migrations.length,
					recorded: migrations.length,
					schemaVersion: migrations.length - 1
				}
				break
			}
			case 'ready': {
				result = {
					dialect: 'sqlite',
					classification: 'ready',
					appliedCount: migrations.length,
					recorded: 0,
					schemaVersion: migrations.length - 1
				}
				break
			}
			case 'adopt': {
				// Data-integrity preflight BEFORE any mutation (inside the lock).
				assertFkIntegrity(sqlite, current.foreignKeys ?? [])
				applyAdoption(
					sqlite,
					classification.addColumns,
					classification.addIndexes,
					classification.journalToRecord
				)
				result = {
					dialect: 'sqlite',
					classification: 'adopt',
					appliedCount: migrations.length,
					recorded: classification.journalToRecord.length,
					schemaVersion: migrations.length - 1
				}
				break
			}
			case 'reject': {
				throw new Error(
					`Unrecognized SQLite schema; refusing to mutate. Reasons: ${classification.reasons.join('; ')}. ` +
						'Unknown layouts are left unchanged and rejected; no partial changes or automatic deletion.'
				)
			}
		}
		sqlite.exec('COMMIT')
	} catch (err) {
		sqlite.exec('ROLLBACK')
		throw err
	}

	// Persistent journal mode is applied only after a compatible transaction
	// has committed; a rejected/incompatible database is never mutated.
	sqlite.pragma(`journal_mode = ${config.journalMode}`)
	return result
}

function ensureJournalTable(sqlite: Database.Database): void {
	sqlite.exec(
		`CREATE TABLE IF NOT EXISTS ${JOURNAL_TABLE} (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)`
	)
}

/** Apply the full checked history in order (fresh install). Runs in the caller's transaction. */
function applyFresh(sqlite: Database.Database, migrations: Array<{ when: number; sql: string[]; hash: string }>): void {
	ensureJournalTable(sqlite)
	const existing = new Set(appliedWhen(sqlite))
	const insert = sqlite.prepare(`INSERT INTO ${JOURNAL_TABLE} (hash, created_at) VALUES (?, ?)`)
	for (const m of migrations) {
		if (existing.has(m.when)) continue
		for (const stmt of m.sql) sqlite.exec(stmt)
		insert.run(m.hash, m.when)
	}
}

/** Apply supported additive deltas + reconciled journal facts atomically (in caller's transaction). */
function applyAdoption(
	sqlite: Database.Database,
	addColumns: Array<{ table: string; column: string; definition: string }>,
	addIndexes: Array<{ definition: string }>,
	journalToRecord: Array<{ when: number; hash: string }>
): void {
	ensureJournalTable(sqlite)
	const existing = new Set(appliedWhen(sqlite))
	for (const d of addColumns) {
		sqlite.exec(`ALTER TABLE \`${d.table}\` ADD COLUMN \`${d.column}\` ${d.definition}`)
	}
	for (const ix of addIndexes) {
		sqlite.exec(ix.definition)
	}
	const insert = sqlite.prepare(`INSERT INTO ${JOURNAL_TABLE} (hash, created_at) VALUES (?, ?)`)
	for (const m of journalToRecord) {
		if (existing.has(m.when)) continue
		insert.run(m.hash, m.when)
	}
}
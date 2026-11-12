/**
 * Canonical expected SQLite layout (FR-002 / T005, T006).
 *
 * Derives the expected SQLite surface from the *checked migrations themselves*:
 * the full history is applied to an isolated in-memory SQLite database and the
 * shared {@link ./sqlite-inspect} inspector produces the authoritative semantic
 * reference (column descriptors, index descriptors, foreign keys). This keeps
 * the expected layout locked to the frozen, checked history — it cannot drift
 * from the real migrations, and harmless formatting/quoting differences remain
 * equivalent because inspection is PRAGMA-based.
 *
 * It also declares the *additive* deltas — columns and indexes introduced
 * after the 0000 baseline — which are the only changes fingerprinted legacy
 * adoption is allowed to apply. Any missing base table/column/index is
 * unrecognized drift and must be rejected, never auto-repaired.
 *
 * Historical migrations (`okr-app/drizzle/0000..0006*.sql`) are a frozen
 * surface; this module only describes what adoption may safely add.
 */
import type Database from 'better-sqlite3'
import { createRequire } from 'node:module'
import type { ColumnDescriptor, DbShape, ExpectedLayout, MigrationMeta } from './contracts'
import { inspectSqlite } from './sqlite-inspect'

const JOURNAL_TABLE = '__drizzle_migrations'

/**
 * Additive columns introduced by migrations 0001/0003/0004/0005/0006.
 * Definition strings are SQLite `ALTER TABLE ... ADD COLUMN` clauses.
 */
const ADDITIVE_COLUMNS: Record<string, Record<string, string>> = {
	users: {
		week_start_day: "text DEFAULT 'monday' NOT NULL",
		timezone: "text DEFAULT 'UTC' NOT NULL",
		bg_color: 'text',
		is_admin: 'integer DEFAULT false NOT NULL',
		is_disabled: 'integer DEFAULT false NOT NULL'
	},
	tasks: {
		time_spent_ms: 'integer DEFAULT 0 NOT NULL',
		timer_started_at: 'integer'
	},
	objectives: {
		color_index: 'integer'
	},
	key_results: {
		score_label: 'text'
	},
	user_ai_config: {
		max_agent_rounds: 'integer DEFAULT 20 NOT NULL'
	}
}

/**
 * Indexes that adoption may create (added after the 0000 baseline).
 */
const ADDITIVE_INDEXES: Record<string, string> = {
	objective_reflections_unique:
		'CREATE UNIQUE INDEX objective_reflections_unique ON objective_reflections (user_id, level, year, month)',
	user_ai_config_user_id_unique:
		'CREATE UNIQUE INDEX user_ai_config_user_id_unique ON user_ai_config (user_id)'
}

/** Apply the full checked history to an isolated in-memory reference database. */
function buildReferenceDb(migrations: MigrationMeta[]): Database.Database {
	// Lazily resolve the driver so this module never statically bundles
	// better-sqlite3; it is only ever loaded by the worker migration path.
	const require = createRequire(import.meta.url)
	const Driver: typeof import('better-sqlite3') = require('better-sqlite3')
	const db = new Driver(':memory:')
	db.exec(
		`CREATE TABLE ${JOURNAL_TABLE} (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)`
	)
	const insert = db.prepare(`INSERT INTO ${JOURNAL_TABLE} (hash, created_at) VALUES (?, ?)`)
	for (const m of migrations) {
		for (const stmt of m.sql) db.exec(stmt)
		insert.run(m.hash, m.when)
	}
	return db
}

/**
 * The canonical expected layout derived from the checked migrations. Both the
 * migrator and the verifier build this from the same history they run, so the
 * two paths cannot drift apart.
 */
export function getExpectedSqliteLayout(migrations: MigrationMeta[]): ExpectedLayout {
	const db = buildReferenceDb(migrations)
	let ref: DbShape
	try {
		ref = inspectSqlite(db)
	} finally {
		db.close()
	}

	// Name-level views (user tables only — the journal table is internal).
	const tables: Record<string, string[]> = {}
	const namedIndexes: Record<string, string> = {}
	for (const [name, cols] of Object.entries(ref.tables)) {
		if (name === JOURNAL_TABLE) continue
		tables[name] = cols
	}
	for (const [name, sql] of Object.entries(ref.indexes)) {
		namedIndexes[name] = sql
	}

	// Semantic views (exclude the internal journal table from column comparison).
	// `inspectSqlite` always populates the semantic fields; the `?? {}` fallbacks
	// keep `DbShape`'s optional descriptors assignable to `ExpectedLayout`'s
	// required ones without narrowing the shared contract.
	const columns: Record<string, ColumnDescriptor[]> = {}
	for (const [name, cols] of Object.entries(ref.columns ?? {})) {
		if (name === JOURNAL_TABLE) continue
		columns[name] = cols
	}

	return {
		tables,
		namedIndexes,
		additiveColumns: ADDITIVE_COLUMNS,
		additiveIndexes: ADDITIVE_INDEXES,
		columns,
		indexDescriptors: ref.indexDescriptors ?? {},
		journalColumns: ref.columns?.[JOURNAL_TABLE] ?? [],
		foreignKeys: ref.foreignKeys ?? [],
		tableChecks: ref.tableChecks ?? {}
	}
}
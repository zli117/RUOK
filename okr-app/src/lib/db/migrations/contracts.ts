/**
 * Migration lifecycle types (FR-002 / FR-004 / FR-005 / T006, T009).
 *
 * Shared, dialect-agnostic shapes for independent checked migration
 * histories, fingerprinted legacy adoption and readiness. Canonical
 * validation/classification logic lives here and in {@link ./fingerprint};
 * only dialect SQL/transaction/migration execution belongs in adapters
 * (`migrations/sqlite-migrator.ts`, `migrations/postgres-migrator.ts`).
 *
 * Since the DRIFT-2 remediation, the SQLite surface is recognised
 * semantically (column descriptors, index descriptors, foreign-key
 * descriptors and journal records) rather than by column-name arrays and
 * index-name presence. A definition hidden behind an expected name is now
 * rejected, and index-name equality is never definition equality.
 */

/** One migration in a checked, versioned history (tag + sha256 + SQL). */
export interface MigrationMeta {
	/** Drizzle journal tag, e.g. `0006_max_agent_rounds`. */
	tag: string
	/** Folder timestamp (`journal.when`); drives applied-ordering. */
	when: number
	/** sha256 (hex) of the migration file body — the journal record hash. */
	hash: string
	/** Migration SQL split on `--> statement-breakpoint`. */
	sql: string[]
	/** Whether breakpoints were declared in the journal entry. */
	breakpoints: boolean
}

/** A parsed, checked migration folder (journal + files). */
export interface MigrationFolder {
	folder: string
	migrations: MigrationMeta[]
}

/** Semantic descriptor for one physical column. */
export interface ColumnDescriptor {
	/** Physical column name. */
	name: string
	/** Declared type exactly as SQLite reports it (normalized case). */
	type: string
	/** NOT NULL flag. */
	notNull: boolean
	/** Declared default value (SQLite literal), or `null` when none. */
	default: string | null
	/** Primary-key ordinal position (1-based); `0` means not a PK column. */
	pkPosition: number
}

/** Semantic descriptor for one ordered index key. */
export interface IndexColumnDescriptor {
	/** Column name for a plain column key; `null` for an expression key. */
	name: string | null
	/** Normalized expression token for an expression key; else `null`. */
	expression: string | null
	/** Collation reported by SQLite (e.g. `BINARY`). */
	collation: string | null
	/** Sort direction. */
	order: 'ASC' | 'DESC'
}

/** Semantic descriptor for a named index. */
export interface IndexDescriptor {
	name: string
	table: string
	/** Whether the index is UNIQUE. */
	unique: boolean
	/** SQLite index origin: `c` CREATE INDEX, `u` UNIQUE, `pk` PRIMARY KEY. */
	origin: 'c' | 'u' | 'pk' | null
	/** Ordered index keys. */
	columns: IndexColumnDescriptor[]
	/** Partial-index WHERE predicate (normalized), or `null`. */
	predicate: string | null
}

/** Semantic descriptor for a foreign-key relationship. */
export interface ForeignKeyDescriptor {
	/** Child (referencing) table. */
	child: string
	/** Parent (referenced) table. */
	parent: string
	/** Ordered column mapping (child `from` -> parent `to`). */
	columns: Array<{ from: string; to: string }>
	/** ON UPDATE action (`NO ACTION`, `CASCADE`, ...). */
	onUpdate: string
	/** ON DELETE action (`NO ACTION`, `CASCADE`, ...). */
	onDelete: string
}

/** One journal record: the migration hash + applied timestamp pair. */
export interface JournalRecord {
	hash: string
	createdAt: number
}

/** Structural + semantic fingerprint of a live backend schema. */
export interface DbShape {
	/** table name -> physical column names (excludes `__drizzle_migrations`-adjacent handling). */
	tables: Record<string, string[]>
	/** named index -> full CREATE INDEX statement. */
	indexes: Record<string, string>
	/** Whether the migration journal table exists. */
	journalPresent: boolean
	/** Applied journal `created_at` (folderMillis) values, if the table exists. */
	journalCreatedAts: number[]
	/** Semantic column descriptors per table (populated by {@link inspectSqlite}). */
	columns?: Record<string, ColumnDescriptor[]>
	/** Semantic descriptors for named and implicit indexes (populated by {@link inspectSqlite}). */
	indexDescriptors?: Record<string, IndexDescriptor>
	/** Semantic foreign-key descriptors (populated by {@link inspectSqlite}). */
	foreignKeys?: ForeignKeyDescriptor[]
	/** Full journal records with hashes (populated by {@link inspectSqlite}). */
	journalRecords?: JournalRecord[]
	/**
	 * Per-table CHECK-constraint count from the CREATE TABLE SQL (bounded
	 * token scan). The checked grammar declares no CHECK constraints, so any
	 * count > 0 is unsupported drift (populated by {@link inspectSqlite}).
	 */
	tableChecks?: Record<string, number>
}

/** A column that may be applied to an existing table during adoption. */
export interface AddColumnDelta {
	table: string
	column: string
	definition: string
}

/** A named index that may be created during adoption. */
export interface AddIndexDelta {
	name: string
	definition: string
}

export type LegacyClassification =
	| { kind: 'fresh' }
	| { kind: 'ready'; journalComplete: boolean }
	| {
			kind: 'adopt'
			addColumns: AddColumnDelta[]
			addIndexes: AddIndexDelta[]
			journalToRecord: MigrationMeta[]
	  }
	| { kind: 'reject'; reasons: string[] }

/**
 * Canonical expected layout a fingerprint is checked against. Name-level
 * views (`tables`, `namedIndexes`) are retained for quick inventory checks
 * and legacy unit fixtures; the semantic views (`columns`, `indexDescriptors`,
 * `foreignKeys`) are the authoritative definition-level oracle.
 */
export interface ExpectedLayout {
	/** table -> physical columns (names). */
	tables: Record<string, string[]>
	/** all expected named indexes (base + additive). */
	namedIndexes: Record<string, string>
	/** additive columns: table -> column -> ALTER definition (added post-baseline). */
	additiveColumns: Record<string, Record<string, string>>
	/** additive indexes: name -> CREATE definition (added post-baseline). */
	additiveIndexes: Record<string, string>
	/** Semantic column descriptors per table. */
	columns: Record<string, ColumnDescriptor[]>
	/** Semantic descriptors for named and implicit indexes. */
	indexDescriptors: Record<string, IndexDescriptor>
	/** Supported internal journal column structure, derived from the reference. */
	journalColumns: ColumnDescriptor[]
	/** Semantic foreign-key descriptors. */
	foreignKeys: ForeignKeyDescriptor[]
	/** Per-table CHECK-constraint count (0 for every checked table). */
	tableChecks: Record<string, number>
}

/** Outcome of a migration run (fresh or adopted). */
export interface MigrationResult {
	/** The selected backend dialect. */
	dialect: 'sqlite' | 'postgres'
	/** How the target schema was reached. */
	classification: 'fresh' | 'ready' | 'adopt'
	/** Number of migrations present in the applied history. */
	appliedCount: number
	/** Number of migration journal records written by this run. */
	recorded: number
	/** Schema version = index of the highest applied migration (0-based). */
	schemaVersion: number
}

/** Readiness of a selected backend (login-independent, redacted). */
export interface ReadinessState {
	ready: boolean
	/** Undefined when no backend has been opened yet. */
	dialect?: 'sqlite' | 'postgres'
	open: boolean
	schemaVersion?: number
}
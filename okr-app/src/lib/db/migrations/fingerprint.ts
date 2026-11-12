/**
 * Canonical fingerprinted legacy classification (FR-002 / T005, T006, T007).
 *
 * Pure, shared logic that classifies a live backend's structural + semantic
 * fingerprint against a canonical expected layout and the full checked
 * migration history. It decides whether a database is fresh, already at the
 * expected schema (`ready`), a recognized legacy layout that may be adopted
 * (`adopt`), or an unknown/incompatible layout that must be rejected before
 * any mutation.
 *
 * DRIFT-2 remediation: index *definitions* (uniqueness, ordered keys,
 * collation, direction, predicate), column definitions (type/nullability/
 * default/PK position), foreign-key mappings/actions and full journal
 * integrity are compared — not just names. An incompatible definition hidden
 * behind an expected name is rejected.
 *
 * This function performs NO I/O and is fully unit-testable. Dialect-specific
 * inspection of a live database (reading tables/indexes, running data-integrity
 * checks, applying deltas in a transaction) lives in the adapter migrators.
 */
import type {
	AddColumnDelta,
	AddIndexDelta,
	ColumnDescriptor,
	DbShape,
	ExpectedLayout,
	ForeignKeyDescriptor,
	IndexDescriptor,
	LegacyClassification,
	MigrationMeta
} from './contracts'

const JOURNAL_TABLE = '__drizzle_migrations'

function userTables(current: DbShape): string[] {
	return Object.keys(current.tables).filter((t) => t !== JOURNAL_TABLE)
}

/** Collapse insignificant whitespace so harmless formatting stays equivalent. */
function normalizeDefault(d: string | null): string | null {
	if (d == null) return null
	return d.replace(/\s+/g, ' ').trim()
}

function columnSignature(c: ColumnDescriptor): string {
	return JSON.stringify([
		c.name,
		normalizeDefault(c.type),
		c.notNull,
		normalizeDefault(c.default),
		c.pkPosition
	])
}

function indexKeySignature(c: { name: string | null; expression: string | null; collation: string | null; order: string }): string {
	return JSON.stringify([c.name, c.expression, c.collation, c.order])
}

function indexSignature(i: IndexDescriptor): string {
	return JSON.stringify([
		i.name,
		i.table,
		i.unique,
		i.columns.map(indexKeySignature),
		i.predicate
	])
}

function fkSignature(f: ForeignKeyDescriptor): string {
	return JSON.stringify([
		f.child,
		f.parent,
		f.columns.map((c) => `${c.from}->${c.to}`).join(','),
		f.onUpdate,
		f.onDelete
	])
}

/**
 * Validate journal records (hash + timestamp pairs). Duplicate, unknown,
 * future and corrupt (hash-mismatched) rows are rejected. Name-only fixtures
 * that lack hashes still validate the timestamp inventory for duplicates and
 * unknown timestamps.
 */
function validateJournal(
	current: DbShape,
	migrations: MigrationMeta[]
): string[] {
	const reasons: string[] = []
	const byWhen = new Map(migrations.map((m) => [m.when, m]))
	const seen = new Set<number>()
	const records: Array<{ hash: string | null; createdAt: number }> =
		current.journalRecords?.map((r) => ({ hash: r.hash, createdAt: r.createdAt })) ??
		current.journalCreatedAts.map((c) => ({ hash: null, createdAt: c }))

	for (const rec of records) {
		if (seen.has(rec.createdAt)) {
			reasons.push(`duplicate journal record at created_at=${rec.createdAt}`)
		}
		seen.add(rec.createdAt)
		const m = byWhen.get(rec.createdAt)
		if (!m) {
			reasons.push(`unknown journal record at created_at=${rec.createdAt}`)
			continue
		}
		if (rec.hash != null && m.hash !== rec.hash) {
			reasons.push(`corrupt journal record at created_at=${rec.createdAt}: hash mismatch`)
		}
	}
	return reasons
}

/**
 * Classify a structural fingerprint against the expected layout and history.
 */
export function classifyLegacy(
	current: DbShape,
	expected: ExpectedLayout,
	migrations: MigrationMeta[]
): LegacyClassification {
	const tables = userTables(current)

	// Journal integrity precedes fresh classification: recorded history cannot
	// justify skipping CREATE statements when the application tables are absent.
	const reasons: string[] = []
	if (current.journalPresent) {
		reasons.push(...validateJournal(current, migrations))
		const journalPk = Object.values(current.indexDescriptors ?? {})
			.find((i) => i.table === JOURNAL_TABLE && i.origin === 'pk')
		const expectedJournalPk = Object.values(expected.indexDescriptors)
			.find((i) => i.table === JOURNAL_TABLE && i.origin === 'pk')
		if (journalPk && expectedJournalPk &&
			JSON.stringify(journalPk.columns.map(indexKeySignature)) !==
			JSON.stringify(expectedJournalPk.columns.map(indexKeySignature))) {
			reasons.push('migration journal primary key definition differs from expected (columns/collation/order)')
		}
		// INTEGER PRIMARY KEY uses the rowid and has no autoindex; the column
		// shape check below still requires its supported PK ordinal and type.
		// Empty journals are eligible for fresh migration only with the supported
		// constraint surface too; otherwise the first history INSERT can fail or
		// leave unsupported restrictions behind after a successful migration.
		for (const index of Object.values(current.indexDescriptors ?? {})) {
			if (index.table === JOURNAL_TABLE && index.origin !== 'pk') {
				reasons.push('unsupported index/UNIQUE constraint on migration journal')
			}
		}
		if ((current.tableChecks?.[JOURNAL_TABLE] ?? 0) !== (expected.tableChecks[JOURNAL_TABLE] ?? 0)) {
			reasons.push('unsupported CHECK constraint on migration journal')
		}
		if (current.foreignKeys?.some((fk) => fk.child === JOURNAL_TABLE)) {
			reasons.push('unsupported foreign key on migration journal')
		}
		const journalColumns = current.columns?.[JOURNAL_TABLE]
		if (journalColumns) {
			// Drizzle/our migrator use SERIAL; SQLite-native journals can use
			// INTEGER PRIMARY KEY. Both are supported journal IDs.
			const signature = (c: ColumnDescriptor) => columnSignature(
				c.name === 'id' && c.type.toUpperCase() === 'SERIAL' ? { ...c, type: 'INTEGER' } : c
			)
			if (journalColumns.length !== expected.journalColumns.length ||
				journalColumns.some((c, i) => signature(c) !== signature(expected.journalColumns[i]))) {
				reasons.push('invalid SQLite migration journal structure')
			}
		}
	}
	if (tables.length === 0) {
		if (current.journalCreatedAts.length > 0) reasons.push('nonempty migration journal without application tables')
		return reasons.length > 0 ? { kind: 'reject', reasons } : { kind: 'fresh' }
	}
	const addColumns: AddColumnDelta[] = []
	const addIndexes: AddIndexDelta[] = []

	// --- Name-level inventory (always checked) ---
	for (const t of tables) {
		if (!expected.tables[t]) reasons.push(`unknown table '${t}'`)
	}
	for (const [t, cols] of Object.entries(current.tables)) {
		if (t === JOURNAL_TABLE) continue
		const expectedCols = expected.tables[t]
		if (!expectedCols) continue
		for (const c of cols) {
			if (!expectedCols.includes(c)) reasons.push(`unknown column '${t}.${c}'`)
		}
	}
	for (const name of Object.keys(current.indexes)) {
		if (name.startsWith('sqlite_autoindex_')) continue
		if (!expected.namedIndexes[name]) reasons.push(`unknown index '${name}'`)
	}
	for (const t of Object.keys(expected.tables)) {
		if (!current.tables[t]) reasons.push(`missing table '${t}' (incomplete layout)`)
	}

	// --- Semantic column comparison (definitions, not names) ---
	if (current.columns && expected.columns) {
		for (const [t, expectedCols] of Object.entries(expected.columns)) {
			const curCols = current.columns[t]
			if (!curCols) continue
			const expByCol = new Map(expectedCols.map((c) => [c.name, c]))
			for (const col of curCols) {
				const exp = expByCol.get(col.name)
				if (!exp) continue // missing-from-expected columns are handled at name level
				if (columnSignature(col) !== columnSignature(exp)) {
					reasons.push(
						`column '${t}.${col.name}' definition differs from expected (type/nullability/default/PK)`
					)
				}
			}
		}
	}

	// --- Semantic index comparison (definition, not name) ---
	if (current.indexDescriptors && expected.indexDescriptors) {
		for (const [name, exp] of Object.entries(expected.indexDescriptors)) {
			if (exp.origin !== 'c') continue // PK/UNIQUE autoindex names are SQLite implementation details.
			const cur = current.indexDescriptors[name]
			if (!cur) continue // missing index handled at name level
			if (indexSignature(cur) !== indexSignature(exp)) {
				reasons.push(
					`index '${name}' definition differs from expected (uniqueness/columns/order/predicate)`
				)
			}
		}
	}

	// Implicit UNIQUE constraints have no CREATE INDEX SQL. Compare their
	// ordered key semantics, preserving PK validation through column ordinals.
	if (current.indexDescriptors && expected.indexDescriptors) {
		const uniqueSignature = (i: IndexDescriptor) => JSON.stringify([
			i.table, i.columns.map(indexKeySignature), i.predicate
		])
		const expectedUnique = new Set(Object.values(expected.indexDescriptors)
			.filter((i) => i.unique && i.origin !== 'pk').map(uniqueSignature))
		for (const index of Object.values(current.indexDescriptors)) {
			if (index.table === JOURNAL_TABLE && index.origin === 'pk') continue
			if (index.unique && index.origin !== 'pk' && !expectedUnique.has(uniqueSignature(index))) {
				reasons.push(`unsupported UNIQUE constraint on table '${index.table}'`)
			}
		}
	}

	// PK column ordinals do not capture key collation or direction. Autoindex
	// names are incidental; compare the complete PRAGMA key by owning table.
	if (current.indexDescriptors && expected.indexDescriptors) {
		const primaryKeys = (indexes: Record<string, IndexDescriptor>) => new Map(
			Object.values(indexes).filter((i) => i.origin === 'pk' && i.table !== JOURNAL_TABLE)
				.map((i) => [i.table, JSON.stringify(i.columns.map(indexKeySignature))])
		)
		const actual = primaryKeys(current.indexDescriptors)
		const reference = primaryKeys(expected.indexDescriptors)
		for (const table of new Set([...actual.keys(), ...reference.keys()])) {
			if (actual.get(table) !== reference.get(table)) {
				reasons.push(`primary key index on table '${table}' definition differs from expected (columns/collation/order)`)
			}
		}
	}

	// --- Foreign-key comparison ---
	if (current.foreignKeys && expected.foreignKeys) {
		const expectedCounts = new Map<string, number>()
		for (const fk of expected.foreignKeys) {
			const sig = fkSignature(fk)
			expectedCounts.set(sig, (expectedCounts.get(sig) ?? 0) + 1)
		}
		for (const fk of current.foreignKeys) {
			const sig = fkSignature(fk)
			const remaining = expectedCounts.get(sig) ?? 0
			if (remaining === 0) reasons.push(`unexpected foreign key ${fk.child}.(${fk.columns.map((c) => c.from).join(',')}) -> ${fk.parent}`)
			else expectedCounts.set(sig, remaining - 1)
		}
		for (const fk of expected.foreignKeys) {
			if ((expectedCounts.get(fkSignature(fk)) ?? 0) > 0) {
				reasons.push(
					`foreign key ${fk.child}.(${fk.columns.map((c) => c.from).join(',')}) -> ${fk.parent} differs from expected (mapping/actions)`
				)
			}
		}
	}

	// --- Unsupported CHECK constraints (the checked grammar declares none) ---
	if (current.tableChecks && expected.tableChecks) {
		for (const [t, count] of Object.entries(current.tableChecks)) {
			if (count > 0 && !(expected.tableChecks[t] ?? 0)) {
				reasons.push(`unsupported CHECK constraint on table '${t}'`)
			}
		}
	}

	// --- Journal validation + reconciliation ---
	let journalToRecord: MigrationMeta[] = []
	let journalComplete = false
	if (current.journalPresent) {
		const knownWhen = new Set(current.journalCreatedAts)
		journalToRecord = migrations.filter((m) => !knownWhen.has(m.when))
		journalComplete = journalToRecord.length === 0 && migrations.length > 0
	} else {
		journalToRecord = migrations
	}

	// --- Missing additive columns (recognized deltas) vs drift ---
	for (const [t, expectedCols] of Object.entries(expected.tables)) {
		const curCols = current.tables[t]
		if (!curCols) continue
		for (const c of expectedCols) {
			if (curCols.includes(c)) continue
			const def = expected.additiveColumns[t]?.[c]
			if (def) addColumns.push({ table: t, column: c, definition: def })
			else reasons.push(`missing column '${t}.${c}' not covered by a supported additive migration`)
		}
	}

	// --- Missing base/additive indexes ---
	for (const [name, def] of Object.entries(expected.namedIndexes)) {
		if (current.indexes[name]) continue
		const additiveDef = expected.additiveIndexes[name]
		if (additiveDef) addIndexes.push({ name, definition: additiveDef })
		else reasons.push(`missing base index '${name}'`)
	}

	if (reasons.length > 0) {
		return { kind: 'reject', reasons }
	}

	if (addColumns.length === 0 && addIndexes.length === 0 && journalComplete) {
		return { kind: 'ready', journalComplete: true }
	}

	return { kind: 'adopt', addColumns, addIndexes, journalToRecord }
}
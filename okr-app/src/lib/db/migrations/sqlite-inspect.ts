/**
 * Shared SQLite semantic inspector (FR-002 / T006, T008, T009).
 *
 * Produces the structural + semantic fingerprint of a live SQLite schema from
 * PRAGMA metadata: column descriptors (type/nullability/default/PK position),
 * named-index descriptors (uniqueness/ordered keys/collation/direction),
 * foreign-key descriptors (mapping + actions) and full journal records
 * (hash + timestamp pairs).
 *
 * The same inspector is used by both the migrator and the verifier so the two
 * execution paths cannot drift apart, and by {@link ./expected-sqlite} to
 * derive the expected reference layout from the checked migrations in an
 * isolated in-memory database.
 *
 * Index definitions are captured from PRAGMA metadata (not whole-SQL string
 * equality), so harmless whitespace/quoting differences remain equivalent
 * while a definition hidden behind an expected name is still rejected.
 * Unsupported constructs (expression/partial indexes) surface as descriptors
 * that never match the enumerated checked grammar and are therefore rejected
 * rather than silently compared.
 */
import type Database from 'better-sqlite3'
import type {
	ColumnDescriptor,
	DbShape,
	ForeignKeyDescriptor,
	IndexColumnDescriptor,
	IndexDescriptor,
	JournalRecord
} from './contracts'

const JOURNAL_TABLE = '__drizzle_migrations'

/**
 * Count `CHECK` keywords in a CREATE TABLE statement outside string literals
 * (single/double quotes and backtick identifiers). The checked grammar declares
 * no CHECK constraints, so any occurrence marks the table as unsupported drift.
 */
function countCheckKeywords(sql: string): number {
	let count = 0
	let i = 0
	let inSingle = false
	let inDouble = false
	let inBacktick = false
	while (i < sql.length) {
		const ch = sql[i]
		if (ch === "'" && !inDouble && !inBacktick) inSingle = !inSingle
		else if (ch === '"' && !inSingle && !inBacktick) inDouble = !inDouble
		else if (ch === '`' && !inSingle && !inDouble) inBacktick = !inBacktick
		else if (!inSingle && !inDouble && !inBacktick && /[A-Za-z]/.test(ch)) {
			const start = i
			while (i < sql.length && /[A-Za-z0-9_]/.test(sql[i])) i++
			if (sql.slice(start, i).toUpperCase() === 'CHECK') count++
			continue
		}
		i++
	}
	return count
}

function readColumns(sqlite: Database.Database, table: string): ColumnDescriptor[] {
	const rows = sqlite.pragma(`table_info(\`${table}\`)`) as unknown as Array<{
		name: string
		type: string | null
		notnull: number
		dflt_value: string | null
		pk: number
	}>
	return rows.map((c) => ({
		name: c.name,
		type: (c.type ?? '').trim(),
		notNull: !!c.notnull,
		default: c.dflt_value ?? null,
		pkPosition: Number(c.pk) || 0
	}))
}

function readForeignKeys(sqlite: Database.Database, table: string): ForeignKeyDescriptor[] {
	const rows = sqlite.pragma(`foreign_key_list(\`${table}\`)`) as unknown as Array<{
		id: number
		seq: number
		table: string
		from: string
		to: string
		on_update: string
		on_delete: string
	}>
	const groups = new Map<number, ForeignKeyDescriptor>()
	for (const r of rows) {
		let edge = groups.get(r.id)
		if (!edge) {
			edge = {
				child: table,
				parent: r.table,
				columns: [],
				onUpdate: r.on_update,
				onDelete: r.on_delete
			}
			groups.set(r.id, edge)
		}
		edge.columns.push({ from: r.from, to: r.to })
	}
	return [...groups.values()]
}

/** Normalize a predicate expression for stable comparison (whitespace folding). */
function normalizeTokens(s: string | null): string | null {
	if (s == null) return null
	return s.replace(/\s+/g, ' ').trim()
}

function readIndex(
	sqlite: Database.Database,
	name: string,
	table: string,
	sql: string | null
): IndexDescriptor {
	const list = sqlite.pragma(`index_list(\`${table}\`)`) as unknown as Array<{
		name: string
		unique: number
		origin: string
		partial: number
	}>
	const info = list.find((i) => i.name === name)
	const unique = info ? !!info.unique : false
	const origin = (info ? info.origin : null) as IndexDescriptor['origin']
	const partial = info ? !!info.partial : false

	const xinfo = sqlite.pragma(`index_xinfo(\`${name}\`)`) as unknown as Array<{
		cid: number
		name: string | null
		desc: number
		coll: string | null
		key: number
	}>
	const columns: IndexColumnDescriptor[] = []
	for (const c of xinfo) {
		if (!c.key) continue
		// A column key has a real column name; an expression key (cid < 0) does
		// not. Expression/partial constructs are unsupported and will never
		// match the checked grammar, so they are captured as opaque and rejected.
		columns.push({
			name: c.cid >= 0 ? c.name : null,
			expression: c.cid < 0 ? '<expr>' : null,
			collation: c.coll ?? null,
			order: c.desc ? 'DESC' : 'ASC'
		})
	}

	// Bounded predicate capture: the WHERE clause (after the closing paren of
	// the key list) of a partial index, normalized. None of the checked
	// migrations use partial indexes, so this is normally null.
	let predicate: string | null = null
	if (partial) {
		const definition = sql ?? ''
		const close = definition.lastIndexOf(')')
		const tail = close >= 0 ? definition.slice(close + 1) : ''
		predicate = normalizeTokens(tail) || null
	}

	return { name, table, unique, origin, columns, predicate }
}

function readJournal(sqlite: Database.Database): JournalRecord[] {
	return (
		sqlite
			.prepare(`SELECT hash, created_at FROM ${JOURNAL_TABLE}`)
			.all() as Array<{ hash: string; created_at: number }>
	).map((r) => ({ hash: r.hash, createdAt: Number(r.created_at) }))
}

/**
 * Inspect a live SQLite connection into a structural + semantic fingerprint.
 * Read-only: performs no DDL, no pragma that mutates persistent state and no
 * journal writes.
 */
export function inspectSqlite(sqlite: Database.Database): DbShape {
	const tables: Record<string, string[]> = {}
	const columns: Record<string, ColumnDescriptor[]> = {}
	const indexes: Record<string, string> = {}
	const indexDescriptors: Record<string, IndexDescriptor> = {}
	const foreignKeys: ForeignKeyDescriptor[] = []
	const tableChecks: Record<string, number> = {}

	const tableRows = sqlite
		.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'table'`)
		.all() as Array<{ name: string; sql: string | null }>
	for (const r of tableRows) {
		if (r.name.startsWith('sqlite_')) continue
		tables[r.name] = []
		columns[r.name] = []
		for (const col of readColumns(sqlite, r.name)) {
			tables[r.name].push(col.name)
			columns[r.name].push(col)
		}
		foreignKeys.push(...readForeignKeys(sqlite, r.name))
		tableChecks[r.name] = r.sql ? countCheckKeywords(r.sql) : 0
	}

	const idxRows = sqlite
		.prepare(
			`SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index'`
		)
		.all() as Array<{ name: string; tbl_name: string; sql: string | null }>
	for (const r of idxRows) {
		if (r.sql !== null) indexes[r.name] = r.sql
		indexDescriptors[r.name] = readIndex(sqlite, r.name, r.tbl_name, r.sql)
	}

	const journalPresent = Object.prototype.hasOwnProperty.call(tables, JOURNAL_TABLE)
	let journalRecords: JournalRecord[] = []
	if (journalPresent) {
		if (!tables[JOURNAL_TABLE].includes('hash') || !tables[JOURNAL_TABLE].includes('created_at')) {
			throw new Error('Invalid SQLite migration journal structure: missing hash or created_at column')
		}
		journalRecords = readJournal(sqlite)
	}

	return {
		tables,
		indexes,
		journalPresent,
		journalCreatedAts: journalRecords.map((r) => r.createdAt),
		columns,
		indexDescriptors,
		foreignKeys,
		journalRecords,
		tableChecks
	}
}
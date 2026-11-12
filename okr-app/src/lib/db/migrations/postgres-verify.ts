/**
 * PostgreSQL read-only schema verification (FR-003 / DRIFT-3 / T011).
 *
 * The runtime verify path is a DIFFERENT execution path from privileged
 * migration. It performs NO DDL and NO journal writes, even when storage is
 * empty, outdated, corrupt or incompatible. It runs inside a consistent
 * read-only transaction snapshot and:
 *
 *   1. validates the checked migration journal is present,
 *   2. checks the complete known journal (exact `when` set, no unknown,
 *      duplicate or corrupt records, every checked migration applied), and
 *   3. compares the physical catalog shape (tables + column types) against the
 *      checked migration SQL, NOT merely journal timestamps.
 *
 * It deliberately does NOT take the advisory migration lock and does NOT call
 * `createJournal`: a data-only runtime role that owns no objects and lacks
 * CREATE must be able to verify migrated storage. Privileged migration remains
 * the sole owner of schema/journal creation.
 *
 * The caller owns the {@link Client} connection lifecycle (connect/close).
 */
import { Client } from 'pg'
import { readMigrationFolder } from './migration-files'
import type { MigrationResult } from './contracts'
import type { PostgresConfig } from '../contracts'

const MIGRATION_SCHEMA = 'drizzle'
const MIGRATION_TABLE = '__drizzle_migrations'
/** Application tables are created unqualified by the checked migrations. */
const APP_SCHEMA = 'public'

/** Physical column descriptor parsed from checked migration DDL. */
export interface PostgresTableColumn {
	name: string
	type: string
}

/** Physical table descriptor parsed from checked migration DDL. */
export interface PostgresTableDescriptor {
	name: string
	columns: PostgresTableColumn[]
}

/** Column-type tokens that terminate a declared type (drizzle output grammar). */
const TYPE_TERMINATORS = new Set([
	'not',
	'null',
	'primary',
	'key',
	'references',
	'unique',
	'default',
	'constraint',
	'check',
	'collate'
]);

/**
 * Parse `CREATE TABLE "name" ( ... )` statements from a list of already-split
 * migration statements (each element is one statement, per
 * {@link readMigrationFolder}) into physical table + column descriptors.
 * Column declared types are captured as the leading tokens up to the first
 * type-terminator keyword. Non-CREATE TABLE statements (ALTER TABLE ... ADD
 * CONSTRAINT, CREATE UNIQUE INDEX, ...) are ignored — table/column shape is the
 * physical metadata oracle.
 */
export function parsePostgresTables(statements: string[]): PostgresTableDescriptor[] {
	const tables: PostgresTableDescriptor[] = [];
	for (const statementRaw of statements) {
		const statement = statementRaw.trim();
		const m = /^CREATE TABLE\s+"([^"]+)"\s*\(([\s\S]*)\)\s*;?$/i.exec(statement);
		if (!m) continue;
		const columns: PostgresTableColumn[] = [];
		for (const def of splitTopLevel(m[2])) {
			const dm = /^\s*"([^"]+)"\s+([\s\S]*)$/.exec(def);
			if (!dm) continue;
			columns.push({ name: dm[1], type: extractDeclaredType(dm[2]) });
		}
		tables.push({ name: m[1], columns });
	}
	return tables;
}

/** Split a CREATE TABLE body into top-level column definitions (paren-aware). */
function splitTopLevel(body: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let current = '';
	for (const ch of body) {
		if (ch === '(') depth++;
		else if (ch === ')') depth--;
		if (ch === ',' && depth === 0) {
			parts.push(current);
			current = '';
			continue;
		}
		current += ch;
	}
	if (current.trim()) parts.push(current);
	return parts;
}

/** Capture the declared type tokens (up to the first type-terminator keyword). */
function extractDeclaredType(rest: string): string {
	const tokens: string[] = [];
	for (const token of rest.split(/\s+/)) {
		if (token === '') continue;
		if (TYPE_TERMINATORS.has(token.toLowerCase())) break;
		tokens.push(token);
	}
	return tokens.join(' ').toLowerCase().trim();
}

/**
 * Verify the PostgreSQL schema/history is fully migrated and physically
 * compatible, read-only. Throws a redacted, actionable error on any
 * empty/outdated/corrupt/incompatible state; returns a `ready` result on a
 * complete, compatible migrated storage. Never attempts DDL.
 */
export async function runPostgresVerify(
	client: Client,
	config: PostgresConfig,
	migrationsFolder: string
): Promise<MigrationResult> {
	const { migrations } = readMigrationFolder(migrationsFolder);
	const expectedWhen = new Map(migrations.map((m) => [m.when, m]));

	// Read-only consistent snapshot; no advisory lock, no createJournal.
	await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
	try {
		if (!(await tableExists(client, MIGRATION_SCHEMA, MIGRATION_TABLE))) {
			throw new Error(
				'PostgreSQL schema verification failed: migration journal is missing. ' +
					'The database has not been migrated or is incompatible. Run the migration role first; ' +
					'the runtime role cannot execute DDL.'
			);
		}

		const records = await client.query(
			`SELECT hash, created_at FROM ${MIGRATION_SCHEMA}.${MIGRATION_TABLE} ORDER BY created_at`
		);
		const applied = new Map<number, string>();
		for (const r of records.rows as Array<{ hash: string; created_at: string }>) {
			const when = Number(r.created_at);
			if (applied.has(when)) {
				throw new Error(
					'PostgreSQL schema verification failed: duplicate journal record for migration timestamp ' +
						`${when}. The journal is corrupt; run the migration role to repair it.`
				);
			}
			applied.set(when, r.hash);
		}

		for (const when of applied.keys()) {
			const expected = expectedWhen.get(when);
			if (!expected) {
				throw new Error(
					'PostgreSQL schema verification failed: unknown journal record (timestamp ' +
						`${when}) that no checked migration defines. The journal is corrupt or future.`
				);
			}
			if (applied.get(when) !== expected.hash) {
				throw new Error(
					`PostgreSQL schema verification failed: corrupt journal record for migration ` +
						`'${expected.tag}' (hash mismatch). The journal does not match the checked history.`
				);
			}
		}

		const pending = migrations.filter((m) => !applied.has(m.when));
		if (pending.length > 0) {
			throw new Error(
				`PostgreSQL schema verification failed: ${pending.length} migration(s) not applied ` +
					`(${pending.map((m) => m.tag).join(', ')}). Run the migration role first; the runtime role cannot DDL.`
			);
		}

		// Physical catalog shape validation (not just journal timestamps).
		const expectedTables = parsePostgresTables(migrations.flatMap((m) => m.sql));
		await validateCatalog(client, expectedTables);

		return {
			dialect: 'postgres',
			classification: 'ready',
			appliedCount: migrations.length,
			recorded: 0,
			schemaVersion: migrations.length - 1
		};
	} finally {
		await client.query('ROLLBACK').catch(() => undefined);
	}
}

/** Confirm a table exists in a schema (visible to the current role). */
async function tableExists(client: Client, schema: string, table: string): Promise<boolean> {
	const res = await client.query(
		`SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2`,
		[schema, table]
	);
	return (res.rowCount ?? 0) > 0;
}

/**
 * Compare the physical catalog shape of the application schema against the
 * checked migration descriptors: every expected table must exist and every
 * expected column must be present with a matching declared data type.
 */
async function validateCatalog(
	client: Client,
	expected: PostgresTableDescriptor[]
): Promise<void> {
	const res = await client.query(
		`SELECT table_name, column_name, data_type FROM information_schema.columns ` +
			`WHERE table_schema = $1 ORDER BY table_name, ordinal_position`,
		[APP_SCHEMA]
	);
	const actualByTable = new Map<string, Map<string, string>>();
	for (const r of res.rows as Array<{ table_name: string; column_name: string; data_type: string }>) {
		if (!actualByTable.has(r.table_name)) actualByTable.set(r.table_name, new Map());
		actualByTable.get(r.table_name)!.set(r.column_name, r.data_type.toLowerCase());
	}

	for (const table of expected) {
		const columns = actualByTable.get(table.name);
		if (!columns) {
			throw new Error(
				`PostgreSQL schema verification failed: expected table '${table.name}' is missing ` +
					'in the physical catalog. Run the migration role first; the runtime role cannot DDL.'
			);
		}
		for (const col of table.columns) {
			const actualType = columns.get(col.name);
			if (actualType === undefined) {
				throw new Error(
					`PostgreSQL schema verification failed: expected column '${table.name}.${col.name}' ` +
						'is missing in the physical catalog. Run the migration role first; the runtime role cannot DDL.'
				);
			}
			if (actualType !== col.type) {
				throw new Error(
					`PostgreSQL schema verification failed: column '${table.name}.${col.name}' type differs ` +
						`(expected ${col.type}, found ${actualType}). Run the migration role first; ` +
						'the runtime role cannot DDL.'
				);
			}
		}
	}
}
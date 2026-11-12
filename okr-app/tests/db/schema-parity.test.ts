/**
 * Structural dialect-drift guard (enforced checks / persistence contract).
 *
 * Compares the SQLite and PostgreSQL schemas AND both against the canonical
 * production schema (`src/lib/db/schema.ts`) so neither dialect can silently
 * drift from the application's real surface. A dropped field or default in
 * either dialect is caught here (e.g. `key_results.expected_hours` must keep
 * its `DEFAULT 0`). Backend-agnostic and requires no running database.
 */
import { describe, expect, it } from 'vitest';
import * as productionSchema from '../../src/lib/db/schema';
import * as sqliteSchema from '../../src/lib/db/schema/sqlite';
import * as pgSchema from '../../src/lib/db/schema/postgres';

// In Drizzle 0.45.x table column builders are exposed as direct enumerable
// properties of the table object (each with a `.name`). PostgreSQL tables add
// non-column helpers (e.g. `enableRLS`) which must be excluded. Real columns
// are objects carrying a `dataType`.
type ColumnRef = { name: string; dataType?: string; notNull?: boolean; hasDefault?: boolean };
type TableShape = Record<string, ColumnRef>;

function isTableShape(value: unknown): value is TableShape {
	if (typeof value !== 'object' || value === null) return false;
	return Object.values(value as Record<string, unknown>).some(
		(c) => c !== null && typeof c === 'object' && typeof (c as ColumnRef).dataType === 'string'
	);
}

function columnKeys(table: TableShape): string[] {
	return Object.keys(table).filter(
		(k) => table[k] && typeof table[k] === 'object' && typeof table[k].dataType === 'string'
	);
}

function collectTables(
	mod: Record<string, unknown>
): Record<string, TableShape> {
	return Object.fromEntries(
		Object.entries(mod)
			.filter(([, value]) => isTableShape(value))
			.map(([key, value]) => [key, value as TableShape])
	);
}

const prodTables = collectTables(productionSchema as unknown as Record<string, unknown>);
const sqliteTables = collectTables(sqliteSchema as unknown as Record<string, unknown>);
const pgTables = collectTables(pgSchema as unknown as Record<string, unknown>);

// The production schema is the canonical reference surface.
const ALL_TABLE_KEYS = Object.keys(prodTables);

describe('schema parity (production <-> sqlite <-> postgres)', () => {
	it('represents every current application table (25 tables)', () => {
		expect(ALL_TABLE_KEYS).toHaveLength(25);
	});

	it('exposes the same set of tables across production and both dialects', () => {
		const expected = ALL_TABLE_KEYS.sort();
		expect(Object.keys(prodTables).sort()).toEqual(expected);
		expect(Object.keys(sqliteTables).sort()).toEqual(expected);
		expect(Object.keys(pgTables).sort()).toEqual(expected);
	});

	it('keeps identical column property keys for every table', () => {
		for (const key of ALL_TABLE_KEYS) {
			expect(columnKeys(prodTables[key]).sort(), `table ${key}`).toEqual(
				columnKeys(sqliteTables[key]).sort()
			);
			expect(columnKeys(prodTables[key]).sort(), `table ${key}`).toEqual(
				columnKeys(pgTables[key]).sort()
			);
		}
	});

	it('keeps identical physical column names for every column', () => {
		for (const key of ALL_TABLE_KEYS) {
			const p = prodTables[key];
			const s = sqliteTables[key];
			const g = pgTables[key];
			for (const colKey of columnKeys(p)) {
				expect(s[colKey].name, `${key}.${colKey}`).toBe(p[colKey].name);
				expect(g[colKey].name, `${key}.${colKey}`).toBe(p[colKey].name);
			}
		}
	});

	it('keeps identical codec kinds for every column', () => {
		// Drizzle normalizes logical codecs to a small set ('string' | 'number' |
		// 'boolean' | 'date'). The millisecond column is 'number' on both sides
		// (SQLite integer / PostgreSQL bigint); booleans are 'boolean' (SQLite
		// integer-boolean / PostgreSQL boolean); timestamps are 'date'.
		for (const key of ALL_TABLE_KEYS) {
			const p = prodTables[key];
			const s = sqliteTables[key];
			const g = pgTables[key];
			for (const colKey of columnKeys(p)) {
				expect(s[colKey].dataType, `${key}.${colKey}`).toBe(p[colKey].dataType);
				expect(g[colKey].dataType, `${key}.${colKey}`).toBe(p[colKey].dataType);
			}
		}
	});

	it('keeps identical nullability for every column', () => {
		// A field that is NOT NULL (or nullable) in production must match in both
		// dialects so inserts behave identically.
		for (const key of ALL_TABLE_KEYS) {
			const p = prodTables[key];
			const s = sqliteTables[key];
			const g = pgTables[key];
			for (const colKey of columnKeys(p)) {
				expect(!!s[colKey].notNull, `${key}.${colKey}`).toBe(!!p[colKey].notNull);
				expect(!!g[colKey].notNull, `${key}.${colKey}`).toBe(!!p[colKey].notNull);
			}
		}
	});

	it('keeps identical default semantics for every column', () => {
		// A column with a default in production must also have a default in both
		// dialects (and vice versa), so an omitted field yields the same stored
		// value instead of NULL (e.g. key_results.expected_hours DEFAULT 0).
		for (const key of ALL_TABLE_KEYS) {
			const p = prodTables[key];
			const s = sqliteTables[key];
			const g = pgTables[key];
			for (const colKey of columnKeys(p)) {
				expect(!!s[colKey].hasDefault, `${key}.${colKey}`).toBe(!!p[colKey].hasDefault);
				expect(!!g[colKey].hasDefault, `${key}.${colKey}`).toBe(!!p[colKey].hasDefault);
			}
		}
	});
});
/**
 * Feature-to-contract coverage ledger guard (T029 / FR-002, FR-006, FR-007,
 * FR-008, FR-011).
 *
 * WP08's verification deliverable. Every one of the 25 application tables from
 * `data-model.md` must exist in the canonical production schema with the exact
 * documented physical name, and both dialect schemas must expose the same set.
 * This guards against a table silently dropping out of coverage when a
 * feature/API family is added or refactored.
 *
 * The human-readable ledger — each table mapped to its feature/API family and
 * the concrete shared both-backend scenario that exercises it — lives in
 * `docs/DATABASE-VERIFICATION.md` (T032). This test asserts the machine-checked
 * half: that the documented inventory is exactly the production surface. The
 * per-table behavioural coverage itself is enforced by the real-backend domain
 * suites (`tests/domains/*`, `tests/backup/*`, `tests/db/contract.suite.ts`)
 * which run on BOTH SQLite and PostgreSQL with no mocks at the persistence
 * layer.
 *
 * Runs backend-agnostic: requires no database.
 */
import { describe, expect, it } from 'vitest'
import { getTableName, isTable } from 'drizzle-orm'
import * as productionSchema from '../../src/lib/db/schema'
import * as sqliteSchema from '../../src/lib/db/schema/sqlite'
import * as pgSchema from '../../src/lib/db/schema/postgres'

/**
 * Canonical 25-table RUOK database inventory.
 * Ordered to match the documented "Current tables" list. Physical SQL names.
 */
const CANONICAL_TABLES = [
	'users',
	'sessions',
	'values',
	'principles',
	'objectives',
	'key_results',
	'time_periods',
	'time_commitments',
	'tasks',
	'task_attributes',
	'tags',
	'task_tags',
	'daily_metrics',
	'saved_queries',
	'dashboard_widgets',
	'plugins',
	'system_config',
	'user_ai_config',
	'metrics_templates',
	'daily_metric_values',
	'objective_reflections',
	'friend_requests',
	'friendships',
	'friend_notes',
	'query_execution_logs'
]

/** Collect table export name -> physical SQL name for a schema module. */
function collectTableNames(mod: Record<string, unknown>): Map<string, string> {
	const map = new Map<string, string>()
	for (const [key, value] of Object.entries(mod)) {
		if (isTable(value)) map.set(key, getTableName(value))
	}
	return map
}

const prod = collectTableNames(productionSchema as unknown as Record<string, unknown>)
const sqlite = collectTableNames(sqliteSchema as unknown as Record<string, unknown>)
const postgres = collectTableNames(pgSchema as unknown as Record<string, unknown>)

describe('T029 coverage ledger', () => {
	it('the canonical inventory has exactly 25 tables (matches data-model.md)', () => {
		expect(CANONICAL_TABLES).toHaveLength(25)
		// No duplicates in the documented inventory.
		expect(new Set(CANONICAL_TABLES).size).toBe(25)
	})

	it('production schema exposes exactly the documented 25-table inventory', () => {
		expect([...prod.values()].sort()).toEqual([...CANONICAL_TABLES].sort())
		expect(prod.size).toBe(25)
	})

	it('both dialect schemas expose exactly the same 25 physical tables', () => {
		const expected = CANONICAL_TABLES.slice().sort()
		expect([...sqlite.values()].sort()).toEqual(expected)
		expect([...postgres.values()].sort()).toEqual(expected)
		expect(sqlite.size).toBe(25)
		expect(postgres.size).toBe(25)
	})

	it('each documented table is present on every surface (no dropped table)', () => {
		for (const table of CANONICAL_TABLES) {
			expect([...prod.values()], table).toContain(table)
			expect([...sqlite.values()], table).toContain(table)
			expect([...postgres.values()], table).toContain(table)
		}
	})

	it('every production schema export is a documented table (no undocumented table)', () => {
		const documented = new Set(CANONICAL_TABLES)
		for (const name of prod.values()) {
			expect(documented.has(name), `undocumented table ${name}`).toBe(true)
		}
	})
})
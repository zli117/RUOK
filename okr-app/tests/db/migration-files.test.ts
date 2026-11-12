/**
 * Canonical migration-history unit tests (T009 / T010).
 *
 * Pure, no-DB tests for the shared migration folder reader and the
 * fingerprinted legacy classifier: fresh, ready, every adopt delta, and
 * unknown-drift rejection are covered without touching a database.
 */
import { describe, expect, it } from 'vitest'
import { getExpectedSqliteLayout } from '../../src/lib/db/migrations/expected-sqlite'
import { classifyLegacy } from '../../src/lib/db/migrations/fingerprint'
import { readMigrationFolder } from '../../src/lib/db/migrations/migration-files'
import type { DbShape, ExpectedLayout } from '../../src/lib/db/migrations'
import { SQLITE_FOLDER } from './migration-fixtures'

const { migrations } = readMigrationFolder(SQLITE_FOLDER)
const expected: ExpectedLayout = getExpectedSqliteLayout(migrations)

function journalState(present: boolean, recordedWhen: number[] = []): Pick<DbShape, 'journalPresent' | 'journalCreatedAts'> {
	return { journalPresent: present, journalCreatedAts: recordedWhen }
}

describe('migration folder reader (T009)', () => {
	it('parses the checked SQLite history with sha256 hashes', () => {
		expect(migrations.length).toBe(7)
		expect(migrations[0].tag).toBe('0000_cultured_tana_nile')
		expect(migrations[6].tag).toBe('0006_max_agent_rounds')
		for (const m of migrations) {
			expect(m.hash).toMatch(/^[0-9a-f]{64}$/)
			expect(m.when).toBeGreaterThan(0)
			expect(m.sql.length).toBeGreaterThan(0)
		}
		// FolderMillis are strictly increasing -> applied ordering is well defined.
		for (let i = 1; i < migrations.length; i++) {
			expect(migrations[i].when).toBeGreaterThan(migrations[i - 1].when)
		}
	})
})

describe('fingerprinted legacy classifier (T010)', () => {
	const allWhen = migrations.map((m) => m.when)

	function fullShape(journal = journalState(true, allWhen)): DbShape {
		return { tables: expected.tables, indexes: expected.namedIndexes, ...journal }
	}

	it('classifies an empty database as fresh', () => {
		const c = classifyLegacy({ tables: {}, indexes: {}, ...journalState(false) }, expected, migrations)
		expect(c.kind).toBe('fresh')
	})

	it('classifies a fully migrated, journal-managed database as ready', () => {
		const c = classifyLegacy(fullShape(), expected, migrations)
		expect(c.kind).toBe('ready')
	})

	it('classifies a db:push schema (no journal) as adopt that only records the history', () => {
		const c = classifyLegacy(fullShape(journalState(false)), expected, migrations)
		expect(c.kind).toBe('adopt')
		if (c.kind === 'adopt') {
			expect(c.addColumns).toHaveLength(0)
			expect(c.addIndexes).toHaveLength(0)
			expect(c.journalToRecord).toHaveLength(migrations.length)
		}
	})

	it('classifies a schema missing an additive column as adopt with that delta', () => {
		const shape = fullShape(journalState(false))
		shape.tables = {
			...shape.tables,
			user_ai_config: shape.tables.user_ai_config.filter((c) => c !== 'max_agent_rounds')
		}
		const c = classifyLegacy(shape, expected, migrations)
		expect(c.kind).toBe('adopt')
		if (c.kind === 'adopt') {
			expect(c.addColumns).toEqual([{ table: 'user_ai_config', column: 'max_agent_rounds', definition: 'integer DEFAULT 20 NOT NULL' }])
		}
	})

	it('classifies an incomplete journal as adopt that records only the missing facts', () => {
		const recorded = allWhen.slice(0, migrations.length - 2)
		const c = classifyLegacy(fullShape(journalState(true, recorded)), expected, migrations)
		expect(c.kind).toBe('adopt')
		if (c.kind === 'adopt') {
			expect(c.journalToRecord.map((m) => m.when)).toEqual(migrations.slice(-2).map((m) => m.when))
		}
	})

	it('rejects unknown drift (extra table) without any delta', () => {
		const shape = fullShape()
		shape.tables = { ...shape.tables, unknown_extra: ['id'] }
		const c = classifyLegacy(shape, expected, migrations)
		expect(c.kind).toBe('reject')
		if (c.kind === 'reject') expect(c.reasons.join()).toContain('unknown table')
	})

	it('rejects unknown drift (extra column) without any delta', () => {
		const shape = fullShape()
		shape.tables = { ...shape.tables, users: [...shape.tables.users, 'hacked_column'] }
		const c = classifyLegacy(shape, expected, migrations)
		expect(c.kind).toBe('reject')
		if (c.kind === 'reject') expect(c.reasons.join()).toContain('unknown column')
	})

	it('rejects a missing base column (not a supported additive delta)', () => {
		const shape = fullShape()
		shape.tables = {
			...shape.tables,
			users: shape.tables.users.filter((c) => c !== 'password_hash')
		}
		const c = classifyLegacy(shape, expected, migrations)
		expect(c.kind).toBe('reject')
		if (c.kind === 'reject') {
			expect(c.reasons.join()).toContain("not covered by a supported additive migration")
		}
	})

	it('rejects a missing base table (incomplete layout)', () => {
		const shape = fullShape()
		shape.tables = { ...shape.tables }
		delete shape.tables.users
		const c = classifyLegacy(shape, expected, migrations)
		expect(c.kind).toBe('reject')
		if (c.kind === 'reject') expect(c.reasons.join()).toContain('missing table')
	})

	it('rejects a missing base index', () => {
		const shape = fullShape()
		shape.indexes = { ...shape.indexes }
		delete shape.indexes.users_username_unique
		const c = classifyLegacy(shape, expected, migrations)
		expect(c.kind).toBe('reject')
		if (c.kind === 'reject') expect(c.reasons.join()).toContain('missing base index')
	})
})
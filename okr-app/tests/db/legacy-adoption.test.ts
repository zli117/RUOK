/**
 * Fingerprinted legacy-adoption tests (T010 / T012).
 *
 * Every supported legacy SQLite layout converges; unknown layouts are left
 * unchanged and rejected with NO partial changes or automatic deletion.
 */
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig, migrateDatabase } from '../../src/lib/db'
import { buildLegacyFixture, SQLITE_FOLDER } from './migration-fixtures'

const cleanups: Array<() => void> = []

function tableNames(path: string): string[] {
	const raw = new Database(path, { readonly: true })
	try {
		return (
			raw
				.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '__drizzle_migrations'`)
				.all() as Array<{ name: string }>
		).map((r) => r.name)
	} finally {
		raw.close()
	}
}

function journalCount(path: string): number {
	const raw = new Database(path, { readonly: true })
	try {
		const exists = raw
			.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'`)
			.get()
		if (!exists) return 0
		return (raw.prepare('SELECT count(*) AS c FROM __drizzle_migrations').get() as { c: number }).c
	} finally {
		raw.close()
	}
}

function columnExists(path: string, table: string, column: string): boolean {
	const raw = new Database(path, { readonly: true })
	try {
		const cols = raw.pragma(`table_info(\`${table}\`)`) as unknown as Array<{ name: string }>
		return cols.some((c) => c.name === column)
	} finally {
		raw.close()
	}
}

afterEach(() => {
	for (const c of cleanups.splice(0)) c()
})

describe('supported legacy adoption (T010)', () => {
	it('adopts a journal-managed database as ready (no mutation)', async () => {
		const f = buildLegacyFixture('journal-managed')
		cleanups.push(f.cleanup)
		const config = loadConfig({ DATABASE_PATH: f.path })
		const result = await migrateDatabase(config, { migrationsFolder: SQLITE_FOLDER })
		expect(result.classification).toBe('ready')
		expect(result.recorded).toBe(0)
		expect(journalCount(f.path)).toBe(7)
	})

	it('adopts a db:push schema (no journal) by recording the history only', async () => {
		const f = buildLegacyFixture('db-push')
		cleanups.push(f.cleanup)
		const before = tableNames(f.path)
		const config = loadConfig({ DATABASE_PATH: f.path })
		const result = await migrateDatabase(config, { migrationsFolder: SQLITE_FOLDER })
		expect(result.classification).toBe('adopt')
		expect(result.recorded).toBe(7)
		// No DDL: the table set is unchanged, only the journal is written.
		expect(tableNames(f.path)).toEqual(before)
		expect(journalCount(f.path)).toBe(7)
	})

	it('adopts a db:push schema missing an additive column by adding it', async () => {
		const f = buildLegacyFixture('db-push-missing-additive')
		cleanups.push(f.cleanup)
		expect(columnExists(f.path, 'user_ai_config', 'max_agent_rounds')).toBe(false)
		const config = loadConfig({ DATABASE_PATH: f.path })
		const result = await migrateDatabase(config, { migrationsFolder: SQLITE_FOLDER })
		expect(result.classification).toBe('adopt')
		expect(columnExists(f.path, 'user_ai_config', 'max_agent_rounds')).toBe(true)
		expect(journalCount(f.path)).toBe(7)
	})

	it('adopts an incomplete journal by recording the missing facts', async () => {
		const f = buildLegacyFixture('incomplete-journal')
		cleanups.push(f.cleanup)
		expect(journalCount(f.path)).toBe(4)
		const config = loadConfig({ DATABASE_PATH: f.path })
		const result = await migrateDatabase(config, { migrationsFolder: SQLITE_FOLDER })
		expect(result.classification).toBe('adopt')
		expect(journalCount(f.path)).toBe(7)
	})
})

describe('unsupported layouts are rejected unchanged (T010)', () => {
	it('rejects foreign-key orphans with no journal written and no deletion', async () => {
		const f = buildLegacyFixture('orphan-data')
		cleanups.push(f.cleanup)
		const before = tableNames(f.path)
		expect(journalCount(f.path)).toBe(0)

		const config = loadConfig({ DATABASE_PATH: f.path })
		await expect(
			migrateDatabase(config, { migrationsFolder: SQLITE_FOLDER })
		).rejects.toThrow(/orphans/)

		// No partial changes, no automatic deletion, no journal recorded.
		expect(tableNames(f.path)).toEqual(before)
		expect(journalCount(f.path)).toBe(0)
		// The orphan row is still present.
		const raw = new Database(f.path, { readonly: true })
		try {
			const orphan = raw.prepare("SELECT count(*) AS c FROM tasks WHERE id = 't1'").get() as { c: number }
			expect(orphan.c).toBe(1)
		} finally {
			raw.close()
		}
	})

	it('rejects unknown drift with no partial changes', async () => {
		const f = buildLegacyFixture('unknown-drift')
		cleanups.push(f.cleanup)
		const before = tableNames(f.path)
		const journalBefore = journalCount(f.path)
		expect(journalBefore).toBe(7)

		const config = loadConfig({ DATABASE_PATH: f.path })
		await expect(
			migrateDatabase(config, { migrationsFolder: SQLITE_FOLDER })
		).rejects.toThrow(/Unrecognized SQLite schema/)

		// No partial changes, no auto-deletion, journal untouched.
		expect(tableNames(f.path)).toEqual(before)
		expect(tableNames(f.path)).toContain('unknown_extra')
		expect(journalCount(f.path)).toBe(journalBefore)
	})
})
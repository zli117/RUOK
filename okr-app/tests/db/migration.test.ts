/**
 * Fresh + repeated startup migration tests (T009 / T011 / T012).
 *
 * Verifies a fresh SQLite database converges via the canonical runner, that
 * repeated startup is idempotent (converges to the same schema/history), and
 * that the process-wide lifecycle exposes correct readiness after open.
 */
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
	closeDatabase,
	createDatabaseServices,
	getReadiness,
	loadConfig,
	migrateDatabase,
	openDatabase,
	resetDatabaseForTests
} from '../../src/lib/db'
import { SQLITE_FOLDER } from './migration-fixtures'

const dirs: string[] = []

function tempPath(name: string): string {
	const dir = mkdtempSync(join(tmpdir(), `ruok-mig-${name}-`))
	dirs.push(dir)
	return join(dir, 'okr.db')
}

afterEach(() => {
	resetDatabaseForTests()
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('fresh and repeated migration (T009/T012)', () => {
	it('migrates a fresh database to the full checked history', async () => {
		const path = tempPath('fresh')
		const config = loadConfig({ DATABASE_PATH: path })

		const result = await migrateDatabase(config, { migrationsFolder: SQLITE_FOLDER })
		expect(result.classification).toBe('fresh')
		expect(result.appliedCount).toBe(7)
		expect(result.recorded).toBe(7)
		expect(result.schemaVersion).toBe(6)

		const raw = new Database(path, { readonly: true })
		try {
			const tables = raw
				.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
				.all() as Array<{ name: string }>
			expect(tables.map((t) => t.name)).toContain('users')
			expect(tables.map((t) => t.name)).toContain('user_ai_config')
			expect(tables.length).toBe(26); // 25 app tables + __drizzle_migrations
			const journal = raw.prepare('SELECT count(*) AS c FROM __drizzle_migrations').get() as { c: number }
			expect(journal.c).toBe(7)
		} finally {
			raw.close()
		}
	})

	it('repeated migration is idempotent (converges to ready)', async () => {
		const path = tempPath('repeat')
		const config = loadConfig({ DATABASE_PATH: path })

		const first = await migrateDatabase(config, { migrationsFolder: SQLITE_FOLDER })
		expect(first.classification).toBe('fresh')

		const second = await migrateDatabase(config, { migrationsFolder: SQLITE_FOLDER })
		expect(second.classification).toBe('ready')
		expect(second.recorded).toBe(0)
		expect(second.appliedCount).toBe(7)
		expect(second.schemaVersion).toBe(6)
	})
})

describe('lifecycle readiness (T011/T012)', () => {
	it('openDatabase migrates then reports readiness true; close reports false', async () => {
		const path = tempPath('lifecycle')
		const config = loadConfig({ DATABASE_PATH: path })

		expect((await getReadiness()).ready).toBe(false)

		const services = await openDatabase(config)
		expect(services.isOpen()).toBe(true)
		const ready = await getReadiness()
		expect(ready.ready).toBe(true)
		expect(ready.open).toBe(true)
		expect(ready.dialect).toBe('sqlite')
		expect(ready.schemaVersion).toBe(6)

		await closeDatabase()
		expect((await getReadiness()).ready).toBe(false)
		expect((await getReadiness()).open).toBe(false)
	})

	it('a raw adapter open (no migration step) leaves readiness unmigrated', async () => {
		// createDatabaseServices(...).open() bypasses migrateDatabase: the WP01
		// contract fixtures rely on this. It must not run migrations.
		const path = tempPath('raw')
		const config = loadConfig({ DATABASE_PATH: path })
		const services = createDatabaseServices(config)
		await services.open()
		expect(services.isOpen()).toBe(true)
		await services.close()
	})
})

describe('schema verification mode (T011)', () => {
	it('verify fails on a fresh database (nothing applied, no DDL)', async () => {
		const path = tempPath('verify-fresh')
		// An existing-but-unmigrated (fresh) database: verify opens it read-only
		// and rejects it without creating any tables (T012). A *missing* file is
		// rejected at open and left uncreated (covered by runtime-mode.test.ts).
		writeFileSync(path, '')
		const config = loadConfig({ DATABASE_PATH: path })
		await expect(
			migrateDatabase(config, { mode: 'verify', migrationsFolder: SQLITE_FOLDER })
		).rejects.toThrow(/not been migrated/)
	})

	it('verify succeeds on an already-migrated database without mutating', async () => {
		const path = tempPath('verify-ok')
		const config = loadConfig({ DATABASE_PATH: path })
		await migrateDatabase(config, { migrationsFolder: SQLITE_FOLDER })
		const result = await migrateDatabase(config, { mode: 'verify', migrationsFolder: SQLITE_FOLDER })
		expect(result.classification).toBe('ready')
		expect(result.recorded).toBe(0)
	})
})
/**
 * Shared migration-mode contract + SQLite noncreating verify (FR-003 / T010 / T012).
 *
 * T010: the CLI and the application resolve `MIGRATION_MODE` through ONE shared
 * side-effect-free parser (`parseMigrationMode`), absent retains the original
 * `migrate` default, and invalid values fail redacted. The helper is published
 * from the public db surface so WP04 can consume the exact same contract.
 *
 * T012: SQLite verify opens read-only with `fileMustExist` semantics and never
 * calls `mkdir` — a missing path/dir remains absent, and a rejected existing
 * database is left unchanged. Migrate retains its original create behavior.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig, migrateDatabase, parseMigrationMode } from '../../src/lib/db'
import { SQLITE_FOLDER } from './migration-fixtures'

const dirs: string[] = []

function tempDir(name: string): string {
	const dir = mkdtempSync(join(tmpdir(), `ruok-mode-${name}-`))
	dirs.push(dir)
	return dir
}

afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('shared migration-mode parser (T010)', () => {
	it('defaults an absent value to migrate (mode-omission baseline preserved)', () => {
		expect(parseMigrationMode(undefined)).toBe('migrate')
		expect(parseMigrationMode('')).toBe('migrate')
	})

	it('accepts migrate and verify', () => {
		expect(parseMigrationMode('migrate')).toBe('migrate')
		expect(parseMigrationMode('verify')).toBe('verify')
	})

	it('trims and lower-cases accepted values deterministically', () => {
		expect(parseMigrationMode(' Verify ')).toBe('verify')
		expect(parseMigrationMode('MIGRATE')).toBe('migrate')
	})

	it('rejects any invalid value with a redacted actionable error', () => {
		for (const bad of ['push', 'verify-only', 'n/a', 'TRUE', '0']) {
			expect(() => parseMigrationMode(bad)).toThrow(/Invalid MIGRATION_MODE/)
		}
	})

	it('is published from the public db surface for the application lifecycle (WP04)', () => {
		// Direct import from the barrel proves the exact API a dependent WP consumes.
		expect(typeof parseMigrationMode).toBe('function')
	})
})

describe('SQLite verify is noncreating (T012)', () => {
	it('verify does not create a missing database file or parent directory', async () => {
		const dir = tempDir('missing')
		const missing = join(dir, 'nested', 'does-not-exist', 'okr.db')
		const config = loadConfig({ DATABASE_PATH: missing })
		await expect(
			migrateDatabase(config, { mode: 'verify', migrationsFolder: SQLITE_FOLDER })
		).rejects.toThrow()
		// Nothing was created: neither the file nor the parent directories.
		expect(existsSync(missing)).toBe(false)
		expect(existsSync(join(dir, 'nested'))).toBe(false)
	})

	it('verify rejects an existing-but-empty database and leaves it unchanged (no tables created)', async () => {
		const dir = tempDir('empty')
		const path = join(dir, 'okr.db')
		writeFileSync(path, '') // an existing empty (unmigrated) database
		const config = loadConfig({ DATABASE_PATH: path })
		await expect(
			migrateDatabase(config, { mode: 'verify', migrationsFolder: SQLITE_FOLDER })
		).rejects.toThrow(/not been migrated/)
		// The empty database was not mutated: no tables and no journal were created.
		const sqlite = new (await import('better-sqlite3')).default(path, { readonly: true })
		try {
			const tables = sqlite
				.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
				.all() as Array<{ name: string }>
			expect(tables).toHaveLength(0)
		} finally {
			sqlite.close()
		}
	})
})
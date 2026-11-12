/**
 * Failure-path migration tests (T011 / T012).
 *
 * Covers failed-migration rollback (a mid-transaction failure leaves the
 * database unchanged), PostgreSQL connectivity failure surfacing as a
 * readiness/migration error, and TLS misconfiguration (missing CA file)
 * failing before any connection is attempted.
 */
import Database from 'better-sqlite3'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig, migrateDatabase } from '../../src/lib/db'

const dirs: string[] = []

function tempDir(name: string): string {
	const dir = mkdtempSync(join(tmpdir(), `ruok-fail-${name}-`))
	dirs.push(dir)
	return dir
}

afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('failed migration rolls back atomically (T012)', () => {
	it('a mid-transaction failure leaves the database unchanged (no partial tables/journal)', async () => {
		const dir = tempDir('rollback')
		const folder = join(dir, 'broken-migrations')
		mkdirSync(join(folder, 'meta'), { recursive: true })
		writeFileSync(
			join(folder, 'meta', '_journal.json'),
			JSON.stringify({
				version: '7',
				dialect: 'sqlite',
				entries: [{ idx: 0, version: '7', when: 1000, tag: '0000_broken', breakpoints: true }]
			})
		)
		// First statement succeeds, second is invalid SQL -> transaction must roll back.
		writeFileSync(
			join(folder, '0000_broken.sql'),
			'CREATE TABLE rollback_test (id text PRIMARY KEY);\n--> statement-breakpoint\nTHIS IS NOT VALID SQL'
		)

		const dbPath = join(dir, 'okr.db')
		const config = loadConfig({ DATABASE_PATH: dbPath })
		await expect(
			migrateDatabase(config, { migrationsFolder: folder })
		).rejects.toThrow()

		const raw = new Database(dbPath, { readonly: true })
		try {
			const tables = raw
				.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
				.all() as Array<{ name: string }>
			// The CREATE TABLE and the journal table were both rolled back.
			expect(tables).toHaveLength(0)
		} finally {
			raw.close()
		}
	})
})

describe('postgres connectivity and TLS failure (T012, no live server)', () => {
	it('an unreachable postgres backend fails migration (readiness fails, no fallback)', async () => {
		const config = loadConfig({
			DATABASE_TYPE: 'postgres',
			DATABASE_URL: 'postgres://u:p@127.0.0.1:1/ruok',
			DATABASE_CONNECT_TIMEOUT_MS: '2000'
		})
		await expect(migrateDatabase(config)).rejects.toThrow()
	})

	it('a missing TLS CA file fails before any connection is attempted', async () => {
		const dir = tempDir('tls')
		const config = loadConfig({
			DATABASE_TYPE: 'postgres',
			DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/ruok',
			DATABASE_SSL_MODE: 'verify-full',
			DATABASE_SSL_CA_FILE: join(dir, 'does-not-exist.pem')
		})
		await expect(migrateDatabase(config)).rejects.toThrow(/does not exist/)
	})

	it('postgres mode never falls back to sqlite on config errors', () => {
		expect(() =>
			loadConfig({ DATABASE_TYPE: 'postgres' })
		).toThrowError(/DATABASE_URL/)
	})
})
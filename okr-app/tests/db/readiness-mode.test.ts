/** MR-1 / FR-003: readiness-first startup must honor the operator's mode. */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	closeDatabase, ensureOpenAttempted, getReadiness, isDatabaseOpen,
	loadConfig, migrateDatabase, resetDatabaseForTests
} from '../../src/lib/db'
import { SQLITE_FOLDER } from './migration-fixtures'

let dir: string
let errors: ReturnType<typeof vi.spyOn>

beforeEach(() => {
	resetDatabaseForTests()
	dir = mkdtempSync(join(tmpdir(), 'ruok-readiness-mode-'))
	errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(async () => {
	await closeDatabase()
	resetDatabaseForTests()
	vi.unstubAllEnvs()
	vi.restoreAllMocks()
	rmSync(dir, { recursive: true, force: true })
})

// Wait for a real worker attempt to settle, whether it succeeds or refuses.
// The unfixed lifecycle collects normally and fails the state/file assertions.
async function attempt(config: ReturnType<typeof loadConfig>): Promise<void> {
	const failuresBefore = errors.mock.calls.length
	const start = performance.now()
	ensureOpenAttempted(config)
	expect(performance.now() - start).toBeLessThan(1000)
	await vi.waitFor(() => {
		expect(isDatabaseOpen() || errors.mock.calls.length > failuresBefore).toBe(true)
	}, { timeout: 5000, interval: 20 })
}

describe('readiness-first runtime mode (MR-1)', () => {
	it('verify leaves a fresh file and parent absent across cooldown and retry', async () => {
		vi.stubEnv('MIGRATION_MODE', ' Verify ')
		const path = join(dir, 'missing', 'nested', 'okr.db')
		const config = loadConfig({ DATABASE_PATH: path })
		await attempt(config)
		expect((await getReadiness()).ready).toBe(false)
		expect(existsSync(path)).toBe(false)
		expect(existsSync(join(dir, 'missing'))).toBe(false)
		await attempt(config)
		expect(errors.mock.calls.flat().join(' ')).toMatch(/cooling down/)
		await new Promise((resolve) => setTimeout(resolve, 1100))
		await attempt(config)
		expect((await getReadiness()).ready).toBe(false)
		expect(existsSync(path)).toBe(false)
		expect(existsSync(join(dir, 'missing'))).toBe(false)
	}, 15000)

	it('verify refuses an existing empty database without changing bytes or catalog', async () => {
		vi.stubEnv('MIGRATION_MODE', 'verify')
		const path = join(dir, 'empty.db')
		writeFileSync(path, '')
		const before = readFileSync(path)
		await attempt(loadConfig({ DATABASE_PATH: path }))
		expect((await getReadiness()).ready).toBe(false)
		expect(readFileSync(path)).toEqual(before)
		const sqlite = new (await import('better-sqlite3')).default(path, { readonly: true })
		try {
			expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([])
		} finally { sqlite.close() }
	})

	it('recovers in verify mode after external migration without restarting the lifecycle', async () => {
		vi.stubEnv('MIGRATION_MODE', 'verify')
		const path = join(dir, 'externally-migrated.db')
		const config = loadConfig({ DATABASE_PATH: path })
		await attempt(config)
		expect((await getReadiness()).ready).toBe(false)
		expect(existsSync(path)).toBe(false)
		await migrateDatabase(config, { mode: 'migrate', migrationsFolder: SQLITE_FOLDER })
		await new Promise((resolve) => setTimeout(resolve, 1100))
		await attempt(config)
		expect(await getReadiness()).toMatchObject({ ready: true, open: true, dialect: 'sqlite' })
	}, 15000)

	it('an absent mode retains automatic migration and readiness', async () => {
		vi.stubEnv('MIGRATION_MODE', undefined)
		const path = join(dir, 'default.db')
		await attempt(loadConfig({ DATABASE_PATH: path }))
		expect(existsSync(path)).toBe(true)
		expect(await getReadiness()).toMatchObject({ ready: true, open: true, dialect: 'sqlite' })
	})

	it('invalid mode refuses readiness before any filesystem creation', async () => {
		vi.stubEnv('MIGRATION_MODE', 'verify-only')
		const path = join(dir, 'invalid', 'okr.db')
		await attempt(loadConfig({ DATABASE_PATH: path }))
		expect((await getReadiness()).ready).toBe(false)
		expect(errors.mock.calls.flat().join(' ')).toMatch(/Invalid MIGRATION_MODE/)
		expect(existsSync(path)).toBe(false)
		expect(existsSync(join(dir, 'invalid'))).toBe(false)
	})
})

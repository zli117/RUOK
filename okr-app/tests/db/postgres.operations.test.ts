/**
 * PostgreSQL operational-failure tests (T030 / FR-005, FR-009; T021).
 *
 * Exercises the live production PostgreSQL adapter under operational load and
 * failures, on a disposable database:
 *   - migration advisory-lock cleanup (lock held then released);
 *   - bounded pool under concurrency (no deadlock, all ops complete);
 *   - readiness transitions through the process-wide singleton
 *     (open -> ready -> closed);
 *   - connection loss (DROP DATABASE WITH FORCE kills the pool's backends) is
 *     surfaced as a controlled error, never a hang or a silent SQLite fallback.
 *
 * T021 (DRIFT-4): every case that uses a repository first migrates its disposable
 * database and asserts the expected application tables exist BEFORE exercising
 * bounded-pool/outage behavior — the original defect was that pool/outage cases
 * targeted nonexistent `users` tables (the production adapter only connects and
 * issues SELECT 1; it never creates tables). The fresh-database missing-users
 * reproduction is preserved, then made to reach the real assertions.
 *
 * Pool saturation / connection timeout bounds are pinned at the config layer
 * (`tests/db/config.test.ts`); the connectivity-failure path is covered
 * without a server in `tests/db/failure.test.ts`. This file needs a live
 * PostgreSQL and therefore runs in CI only: it is skipped when
 * `RUOK_TEST_PG_ADMIN_URL` is absent, and it never substitutes SQLite.
 */
import { Client } from 'pg'
import { describe, expect, it } from 'vitest'
import {
	acquirePostgresMigrationLock,
	closeDatabase,
	createDatabaseServices,
	createPostgresMigrationClient,
	getReadiness,
	migrateDatabase,
	openDatabase,
	releasePostgresMigrationLock,
	resetDatabaseForTests
} from '../../src/lib/db'
import type { PostgresConfig } from '../../src/lib/db/contracts'

const adminUrl = process.env.RUOK_TEST_PG_ADMIN_URL
const integration = adminUrl ? describe : describe.skip

/** Expected application tables that must exist after migration. */
const EXPECTED_APP_TABLES = [
	'users',
	'sessions',
	'system_config',
	'friendships',
	'plugins',
	'user_ai_config',
	'objectives',
	'tasks'
]

function makeConfig(connectionString: string): PostgresConfig {
	return {
		type: 'postgres',
		connectionString,
		poolMax: 2,
		connectTimeoutMs: 5000,
		statementTimeoutMs: 30000,
		sslMode: 'disable'
	}
}

/**
 * Assert the expected application tables exist on a migrated database. Fails
 * (with the missing names) if migration did not create them — the regression
 * oracle for T021.
 */
async function expectAppTables(connectionString: string): Promise<void> {
	const client = new Client({ connectionString })
	await client.connect()
	try {
		const res = await client.query<{ name: string }>(
			`SELECT table_name AS name FROM information_schema.tables ` +
				`WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
			[EXPECTED_APP_TABLES]
		)
		const present = new Set(res.rows.map((r) => r.name))
		const missing = EXPECTED_APP_TABLES.filter((t) => !present.has(t))
		expect(missing, `application tables missing after migrateDatabase: ${missing.join(', ')}`).toHaveLength(0)
	} finally {
		await client.end()
	}
}

async function withDisposableDb(
	fn: (config: PostgresConfig, dbName: string, connectionString: string) => Promise<void>
): Promise<void> {
	const admin = new Client({ connectionString: adminUrl })
	await admin.connect()
	const dbName = `ruok_ops_${Math.random().toString(36).slice(2, 10)}`
	try {
		await admin.query(`CREATE DATABASE ${dbName}`)
	} finally {
		await admin.end()
	}

	const appUrl = new URL(adminUrl as string)
	appUrl.pathname = `/${dbName}`
	const config = makeConfig(appUrl.toString())

	try {
		await fn(config, dbName, appUrl.toString())
	} finally {
		const admin2 = new Client({ connectionString: adminUrl })
		await admin2.connect()
		try {
			await admin2.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`)
		} finally {
			await admin2.end()
		}
	}
}

integration('T030 PostgreSQL operational failures', () => {
	it('releases the migration advisory lock after use (lock cleanup)', async () => {
		await withDisposableDb(async (config) => {
			const client = createPostgresMigrationClient(config)
			await client.connect()
			try {
				await acquirePostgresMigrationLock(client)
				// Scope to this connection's backend pid so an advisory lock held by
				// another test/process (the recovery suite migrates in parallel) is
				// never mistaken for this client's lock.
				const held = await client.query(
					`SELECT count(*)::int AS c FROM pg_locks WHERE locktype='advisory' AND classid=798137 AND objid=9003 AND pid = pg_backend_pid()`
				)
				expect(held.rows[0].c).toBe(1)

				await releasePostgresMigrationLock(client)
				const released = await client.query(
					`SELECT count(*)::int AS c FROM pg_locks WHERE locktype='advisory' AND classid=798137 AND objid=9003 AND pid = pg_backend_pid()`
				)
				expect(released.rows[0].c).toBe(0)
			} finally {
				await client.end()
			}
		})
	})

	it('completes concurrent operations through a bounded pool (no deadlock)', async () => {
		await withDisposableDb(async (config, _dbName, connectionString) => {
			// T021: migrate the disposable database and assert app tables exist
			// before the pool exercises repositories (was missing-users defect).
			expect((await migrateDatabase(config)).classification).toBe('fresh')
			await expectAppTables(connectionString)

			const services = createDatabaseServices(config)
			await services.open()
			try {
				const jobs = Array.from({ length: 8 }, (_, i) =>
					(async () => {
						await services.users.create({
							id: `u${i}`,
							username: `user${i}`,
							passwordHash: `h${i}`
						})
						return services.users.findById(`u${i}`)
					})()
				)
				const results = await Promise.all(jobs)
				for (let i = 0; i < results.length; i++) {
					expect(results[i]?.username).toBe(`user${i}`)
				}
				expect(await services.users.count()).toBe(8)
			} finally {
				await services.close()
			}
		})
	})

	it('tracks readiness transitions through the process-wide singleton', async () => {
		await withDisposableDb(async (config, _dbName, connectionString) => {
			resetDatabaseForTests()
			try {
				expect((await getReadiness()).ready).toBe(false)
				// openDatabase runs the canonical postgres migration then opens.
				await openDatabase(config)
				expect((await getReadiness()).ready).toBe(true)
				expect((await getReadiness()).dialect).toBe('postgres')

				await closeDatabase()
				expect((await getReadiness()).ready).toBe(false)
				expect((await getReadiness()).open).toBe(false)

				// A fresh adapter can reopen the same (still-existing) database.
				const again = createDatabaseServices(config)
				await again.open()
				await again.close()
			} finally {
				resetDatabaseForTests()
			}
		})
	})

	it('surfaces connection loss as a controlled error (never a fallback)', async () => {
		await withDisposableDb(async (config, dbName, connectionString) => {
			// T021: migrate the disposable database and assert app tables exist
			// before the outage is exercised (was missing-users defect).
			expect((await migrateDatabase(config)).classification).toBe('fresh')
			await expectAppTables(connectionString)

			const services = createDatabaseServices(config)
			await services.open()
			try {
				// Confirm the connection works before the outage.
				await services.users.count()

				// Kill the database out from under the pool (terminates backends).
				const admin = new Client({ connectionString: adminUrl })
				await admin.connect()
				try {
					await admin.query(`DROP DATABASE ${dbName} WITH (FORCE)`)
				} finally {
					await admin.end()
				}

				// The next operation must reject with a controlled error rather than
				// hanging or silently falling back to SQLite.
				await expect(services.users.count()).rejects.toThrow()
			} finally {
				await services.close().catch(() => undefined)
			}
		})
	})
})
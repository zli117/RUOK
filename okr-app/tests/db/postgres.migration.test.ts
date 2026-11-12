/**
 * PostgreSQL migration tests (T009 / T011 / T012).
 *
 * Unit portion (no server required): parses the independent `drizzle-postgres`
 * history and asserts the pinned-client/advisory-lock helpers exist.
 *
 * Integration portion (requires a live PostgreSQL): runs a fresh migration then
 * a repeated (ready) migration on a disposable database, exercising the
 * advisory-lock + pinned-connection runner. This is guarded on
 * `RUOK_TEST_PG_ADMIN_URL` and SKIPS when no server is available — it never
 * substitutes SQLite for PostgreSQL. Live execution is covered by CI.
 */
import { Client } from 'pg'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import {
	acquirePostgresMigrationLock,
	createPostgresMigrationClient,
	parsePostgresTables,
	readMigrationFolder,
	releasePostgresMigrationLock,
	runPostgresMigrations,
	runPostgresVerify
} from '../../src/lib/db/migrations'
import type { PostgresConfig } from '../../src/lib/db'

const PG_FOLDER = join(process.cwd(), 'drizzle-postgres')

describe('postgres migration history (T009)', () => {
	it('parses the independent postgres baseline (one reviewed migration)', () => {
		const { migrations, folder } = readMigrationFolder(PG_FOLDER)
		expect(migrations).toHaveLength(1)
		expect(migrations[0].tag.startsWith('0000_')).toBe(true)
		expect(folder).toBe(PG_FOLDER)
	})

	it('exports the pinned-client + advisory-lock runner surface', () => {
		expect(typeof runPostgresMigrations).toBe('function')
		expect(typeof acquirePostgresMigrationLock).toBe('function')
		expect(typeof releasePostgresMigrationLock).toBe('function')
		expect(typeof createPostgresMigrationClient).toBe('function')
	})

	it('exports the separate read-only verify surface (no-DDL path, T011)', () => {
		expect(typeof runPostgresVerify).toBe('function')
		expect(typeof parsePostgresTables).toBe('function')
	})
})

const adminUrl = process.env.RUOK_TEST_PG_ADMIN_URL
const integration = adminUrl ? describe : describe.skip

integration('postgres migration runner (T012, live server)', () => {
	it('runs a fresh migration then a repeated (ready) migration on a disposable database', async () => {
		const admin = new Client({ connectionString: adminUrl })
		await admin.connect()
		const dbName = `ruok_mig_${Math.random().toString(36).slice(2, 10)}`
		try {
			await admin.query(`CREATE DATABASE ${dbName}`)
		} finally {
			await admin.end()
		}

		const appUrl = new URL(adminUrl as string)
		appUrl.pathname = `/${dbName}`
		const config: PostgresConfig = {
			type: 'postgres',
			connectionString: appUrl.toString(),
			poolMax: 5,
			connectTimeoutMs: 10000,
			statementTimeoutMs: 30000,
			sslMode: 'disable'
		}

		try {
			const client = createPostgresMigrationClient(config)
			await client.connect()
			try {
				await acquirePostgresMigrationLock(client)
				try {
					const fresh = await runPostgresMigrations(client, config, PG_FOLDER)
					expect(fresh.classification).toBe('fresh')
					expect(fresh.appliedCount).toBe(1)

					const ready = await runPostgresMigrations(client, config, PG_FOLDER)
					expect(ready.classification).toBe('ready')
					expect(ready.recorded).toBe(0)
				} finally {
					await releasePostgresMigrationLock(client)
				}
			} finally {
				await client.end()
			}
		} finally {
			const admin2 = new Client({ connectionString: adminUrl })
			await admin2.connect()
			try {
				await admin2.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`)
			} finally {
				await admin2.end()
			}
		}
	})
})
/**
 * PostgreSQL no-DDL runtime verification (DRIFT-3 / FR-003 / T011 / T013).
 *
 * Unit portion (no server required): asserts the read-only verify surface is
 * exported and that the physical catalog descriptor parser reproduces the real
 * checked PostgreSQL history (tables + column types) — the physical-shape
 * oracle that prevents journal-timestamp-only verification.
 *
 * Integration portion (requires a live PostgreSQL admin URL, SKIPPED when
 * absent — never substituted with SQLite/mocked persistence): provisions a
 * separately-migrated database, creates a data-only runtime role that owns no
 * objects and lacks CREATE (PUBLIC CREATE revoked), grants only CONNECT /
 * schema USAGE / DML / sequence usage / journal SELECT, then proves that
 * `runPostgresVerify` succeeds on migrated storage and rejects empty, outdated
 * and incompatible storage — capturing attempted statements and comparing
 * before/after object inventories to prove ZERO DDL on both success and
 * rejection.
 */
import { Client } from 'pg'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import {
	createPostgresMigrationClient,
	migrateDatabase,
	parsePostgresTables,
	readMigrationFolder,
	runPostgresVerify
} from '../../src/lib/db'
import type { PostgresConfig } from '../../src/lib/db'

const PG_FOLDER = join(process.cwd(), 'drizzle-postgres')

describe('postgres read-only verify surface (T011/T013)', () => {
	it('exports runPostgresVerify as the read-only no-DDL entry point', () => {
		expect(typeof runPostgresVerify).toBe('function')
		expect(typeof parsePostgresTables).toBe('function')
	})

	it('reproduces the real checked history as physical table + column descriptors', () => {
		const { migrations } = readMigrationFolder(PG_FOLDER)
		expect(migrations.length).toBe(1)
		const tables = parsePostgresTables(migrations.flatMap((m) => m.sql))
		expect(tables.length).toBe(25)
		const names = tables.map((t) => t.name)
		for (const expected of ['users', 'tasks', 'system_config', 'user_ai_config']) {
			expect(names).toContain(expected)
		}
		// Spot-check the physical type oracle used to reject incompatible storage.
		const byName = new Map(tables.map((t) => [t.name, t]))
		const users = byName.get('users')!
		expect(users.columns.find((c) => c.name === 'id')?.type).toBe('text')
		expect(users.columns.find((c) => c.name === 'username')?.type).toBe('text')
		expect(users.columns.find((c) => c.name === 'created_at')?.type).toBe('timestamp with time zone')
		expect(byName.get('tasks')!.columns.find((c) => c.name === 'time_spent_ms')?.type).toBe('bigint')
		expect(byName.get('key_results')!.columns.find((c) => c.name === 'weight')?.type).toBe(
			'double precision'
		)
	})
})

const adminUrl = process.env.RUOK_TEST_PG_ADMIN_URL
const integration = adminUrl ? describe : describe.skip

interface Provisioned {
	runtimeConfig: PostgresConfig
	role: string
	/** Admin (owner) connection string re-pointed at the freshly-created database. */
	adminConnectionString: string
	cleanup(): Promise<void>
}

/**
 * Create a fresh disposable database, optionally migrate it as the admin
 * (owner), and provision a least-privilege runtime role that owns no objects
 * and lacks CREATE (PUBLIC CREATE revoked). Returns a config the runtime role
 * can connect with.
 */
async function provision(migrated: boolean): Promise<Provisioned> {
	const admin = new Client({ connectionString: adminUrl })
	await admin.connect()
	const dbName = `ruok_noddl_${Math.random().toString(36).slice(2, 10)}`
	const role = `ruok_runtime_${Math.random().toString(36).slice(2, 10)}`
	const password = `p_${Math.random().toString(36).slice(2, 12)}`
	// Second admin session re-pointed at the freshly-created database, used for
	// the schema/table/sequence grants below (they must target the new database,
	// where the `drizzle` schema/journal live — not the admin URL's original
	// database, which has no `drizzle` schema).
	let dbAdmin: Client | undefined
	try {
		await admin.query(`CREATE DATABASE ${dbName}`)
		await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`)
		await admin.query(`GRANT CONNECT ON DATABASE "${dbName}" TO "${role}"`)

		const appUrl = new URL(adminUrl as string)
		appUrl.pathname = `/${dbName}`
		const adminConfig: PostgresConfig = {
			type: 'postgres',
			connectionString: appUrl.toString(),
			poolMax: 5,
			connectTimeoutMs: 10000,
			statementTimeoutMs: 30000,
			sslMode: 'disable'
		}
		if (migrated) {
			await migrateDatabase(adminConfig)
		}

		// Re-point an admin session at the newly-created database before running
		// the schema/table/sequence grants below.
		await admin.end()
		dbAdmin = new Client({ connectionString: appUrl.toString() })
		await dbAdmin.connect()

		// Least-privilege runtime grants (no CREATE anywhere).
		await dbAdmin.query(`GRANT USAGE ON SCHEMA public TO "${role}"`)
		if (migrated) {
			await dbAdmin.query(`GRANT USAGE ON SCHEMA drizzle TO "${role}"`)
			await dbAdmin.query(`GRANT SELECT ON TABLE drizzle.__drizzle_migrations TO "${role}"`)
			await dbAdmin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${role}"`)
			await dbAdmin.query(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO "${role}"`)
			await dbAdmin.query(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA drizzle TO "${role}"`)
		}
		// Ensure PUBLIC cannot create in the application schema.
		await dbAdmin.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`)
		await dbAdmin.query(`REVOKE ALL ON SCHEMA public FROM PUBLIC`).catch(() => undefined)
		if (migrated) {
			await dbAdmin.query(`REVOKE ALL ON SCHEMA drizzle FROM PUBLIC`).catch(() => undefined)
		}

		const runtimeUrl = new URL(appUrl.toString())
		runtimeUrl.username = role
		runtimeUrl.password = password
		const runtimeConfig: PostgresConfig = {
			type: 'postgres',
			connectionString: runtimeUrl.toString(),
			poolMax: 5,
			connectTimeoutMs: 10000,
			statementTimeoutMs: 30000,
			sslMode: 'disable'
		}

		return {
			runtimeConfig,
			role,
			adminConnectionString: appUrl.toString(),
			cleanup: async () => {
				const admin2 = new Client({ connectionString: adminUrl })
				await admin2.connect()
				try {
					await admin2.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`)
					await admin2.query(`DROP ROLE IF EXISTS "${role}"`)
				} finally {
					await admin2.end()
				}
			}
		}
	} finally {
		await admin.end().catch(() => undefined)
		await dbAdmin?.end().catch(() => undefined)
	}
}

/** Wrap a client so every SQL statement issued through it is recorded. */
function recordStatements(client: Client): { client: Client; statements: string[] } {
	const statements: string[] = []
	const orig = client.query.bind(client)
	client.query = ((...args: unknown[]) => {
		const first = args[0] as { text?: string } | string | undefined
		statements.push(typeof first === 'string' ? first : (first?.text ?? ''))
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		return orig(...(args as [any, ...any[]]))
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
	}) as any
	return { client, statements }
}

function assertNoDdlAttempted(statements: string[]): void {
	const ddl = statements.filter((s) =>
		/^\s*(CREATE|ALTER|DROP|GRANT|REVOKE|TRUNCATE|INSERT|UPDATE|DELETE)\b/i.test(s.trim())
	)
	expect(ddl).toEqual([])
}

/** Object inventory (tables/columns/sequences + journal) a runtime role can see. */
async function inventory(client: Client): Promise<Record<string, unknown>> {
	const tables = await client.query(
		`SELECT table_schema, table_name FROM information_schema.tables ` +
			`WHERE table_schema IN ('public','drizzle') ORDER BY 1, 2`
	)
	const columns = await client.query(
		`SELECT table_schema, table_name, column_name, data_type FROM information_schema.columns ` +
			`WHERE table_schema IN ('public','drizzle') ORDER BY 1, 2, 3`
	)
	const seqs = await client.query(
		`SELECT n.nspname, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace ` +
			`WHERE c.relkind = 'S' AND n.nspname IN ('public','drizzle') ORDER BY 1, 2`
	)
	// The journal table only exists once storage is migrated; for unmigrated
	// (empty) storage it is absent and inventories as an empty journal.
	let journal: Array<{ hash: string; created_at: string }> = []
	try {
		const res = await client.query(
			`SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at`
		)
		journal = res.rows as Array<{ hash: string; created_at: string }>
	} catch {
		// journal table/schema absent (empty storage) — treated as empty.
	}
	return { tables: tables.rows, columns: columns.rows, seqs: seqs.rows, journal }
}

integration('restricted-role no-DDL runtime verify (T013, live server)', () => {
	it('succeeds on migrated storage with zero DDL, runtime DML works, and role owns no objects', async () => {
		const p = await provision(true)
		try {
			// Least-privilege assertions (admin view).
			const admin = new Client({ connectionString: adminUrl })
			await admin.connect()
			try {
				const priv = await admin.query(
					`SELECT has_schema_privilege($1,'public','CREATE') AS c, ` +
						`has_schema_privilege($1,'public','USAGE') AS u`,
					[p.role]
				)
				expect(priv.rows[0].c).toBe(false)
				expect(priv.rows[0].u).toBe(true)
				const owned = await admin.query(
					`SELECT n.nspname, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace ` +
						`WHERE c.relowner = (SELECT oid FROM pg_roles WHERE rolname = $1)`,
					[p.role]
				)
				expect(owned.rows).toHaveLength(0)
			} finally {
				await admin.end()
			}

			const runtime = new Client({ connectionString: p.runtimeConfig.connectionString })
			await runtime.connect()
			try {
				const before = await inventory(runtime)
				const rec = recordStatements(runtime)
				const result = await runPostgresVerify(rec.client, p.runtimeConfig, PG_FOLDER)
				expect(result.classification).toBe('ready')
				expect(result.recorded).toBe(0)
				expect(result.appliedCount).toBe(1)
				const after = await inventory(runtime)
				expect(after).toEqual(before)
				assertNoDdlAttempted(rec.statements)

				// Runtime DML works on migrated storage (least-privilege role).
				await runtime.query(
					`INSERT INTO system_config (key, value, is_secret, updated_at) ` +
						`VALUES ('noddl_probe', '1', false, now())`
				)
				const readback = await runtime.query(
					`SELECT value FROM system_config WHERE key = 'noddl_probe'`
				)
				expect(readback.rows[0].value).toBe('1')
			} finally {
				await runtime.end()
			}
		} finally {
			await p.cleanup()
		}
	})

	it('rejects empty storage with zero DDL and no attempted DDL', async () => {
		const p = await provision(false)
		try {
			const runtime = new Client({ connectionString: p.runtimeConfig.connectionString })
			await runtime.connect()
			try {
				const before = await inventory(runtime)
				const rec = recordStatements(runtime)
				await expect(runPostgresVerify(rec.client, p.runtimeConfig, PG_FOLDER)).rejects.toThrow(
					/journal is missing/
				)
				const after = await inventory(runtime)
				expect(after).toEqual(before)
				assertNoDdlAttempted(rec.statements)
			} finally {
				await runtime.end()
			}
		} finally {
			await p.cleanup()
		}
	})

	it('rejects outdated storage (journal incomplete) with zero DDL', async () => {
		const p = await provision(true)
		const admin = new Client({ connectionString: p.adminConnectionString })
		await admin.connect()
		try {
			// Remove the only journal record as admin -> the history is incomplete.
			await admin.query(`DELETE FROM drizzle.__drizzle_migrations`)
			const runtime = new Client({ connectionString: p.runtimeConfig.connectionString })
			await runtime.connect()
			try {
				const before = await inventory(runtime)
				const rec = recordStatements(runtime)
				await expect(runPostgresVerify(rec.client, p.runtimeConfig, PG_FOLDER)).rejects.toThrow(
					/not applied/
				)
				const after = await inventory(runtime)
				expect(after).toEqual(before)
				assertNoDdlAttempted(rec.statements)
			} finally {
				await runtime.end()
			}
		} finally {
			await admin.end()
			await p.cleanup()
		}
	})

	it('rejects incompatible storage (missing column) with zero DDL', async () => {
		const p = await provision(true)
		const admin = new Client({ connectionString: p.adminConnectionString })
		await admin.connect()
		try {
			// Drop an expected column as admin -> physical catalog mismatch.
			await admin.query(`ALTER TABLE system_config DROP COLUMN is_secret`)
			const runtime = new Client({ connectionString: p.runtimeConfig.connectionString })
			await runtime.connect()
			try {
				const before = await inventory(runtime)
				const rec = recordStatements(runtime)
				await expect(runPostgresVerify(rec.client, p.runtimeConfig, PG_FOLDER)).rejects.toThrow(
					/is_secret/
				)
				const after = await inventory(runtime)
				expect(after).toEqual(before)
				assertNoDdlAttempted(rec.statements)
			} finally {
				await runtime.end()
			}
		} finally {
			await admin.end()
			await p.cleanup()
		}
	})
})
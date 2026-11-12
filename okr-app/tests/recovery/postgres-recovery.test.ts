/**
 * PostgreSQL native dump/restore rehearsal (T023 / T031 / FR-014, US5).
 *
 * This is the PostgreSQL half of the native installation-recovery rehearsal.
 * It is intentionally separate from the SQLite test (`native-recovery.test.ts`)
 * and from user-export portability (FR-008): native dumps preserve
 * installation-wide data (accounts, sessions, system config, social links,
 * plugin credentials, AI config) that user exports intentionally exclude.
 *
 * It performs a real `pg_dump` of a migrated, seeded disposable database,
 * drops and recreates an empty database, `pg_restore`s the dump, then verifies
 * the restored installation is classified ready and every seeded row is
 * readable through the typed boundary.
 *
 * GATING (T022): this suite runs whenever the live-test prerequisites are met.
 * It is NOT silently skipped. Missing prerequisites (no `RUOK_TEST_PG_ADMIN_URL`,
 * no `pg_dump`/`pg_restore`/`psql`, or no reachable PG18 server) FAIL the suite
 * with a credential-free report from {@link assertPostgresPrerequisites} — the
 * recovery claim is fail-closed and never substitutes SQLite. Native dumps
 * cannot switch backend engines: a PostgreSQL dump restores only to PostgreSQL.
 */
import { execFile } from 'child_process'
import { Client } from 'pg'
import { describe, expect, it } from 'vitest'
import { createDatabaseServices, migrateDatabase } from '../../src/lib/db'
import type { PostgresConfig } from '../../src/lib/db/contracts'
import { assertPostgresPrerequisites } from '../../scripts/require-postgres-test'
import type { PostgresPrerequisites } from '../../scripts/require-postgres-test'
import { seedInstall } from './seed'

const adminUrl = process.env.RUOK_TEST_PG_ADMIN_URL

/**
 * Matching pg18 native toolchain available via the ALREADY-RUNNING
 * `traggo-test-pg` container (C-007-safe): the same postgres:18 container that
 * serves the live PG18 keeps `pg_dump`/`pg_restore` 18.6 at
 * `/usr/lib/postgresql/18/bin/`. Invoking those binaries through `docker exec`
 * reuses a running container — it pulls or substitutes NO image. This is the
 * fallback that lets T023 actually rehearse when the host PATH tools are an
 * older major than the live server.
 */
const DOCKER_PG_CONTAINER = 'traggo-test-pg'
const DOCKER_PG_BIN = '/usr/lib/postgresql/18/bin'
/** Container-internal postgres TCP port (published as 55432 on the host). */
const DOCKER_PG_PORT = '5432'

type NativeTool = 'pg_dump' | 'pg_restore' | 'psql'
type ExecResult = { code: number; stdout: string; stderr: string }

interface Toolchain {
	kind: 'host' | 'docker'
	run: (tool: NativeTool, args: string[]) => Promise<ExecResult>
	/** Adapt a host-side connection URI so the tool's process can reach the server. */
	adaptUrl: (url: string) => string
	dumpPath: (dbName: string) => string
}

function run(cmd: string, args: string[]): Promise<ExecResult> {
	return new Promise((resolve) => {
		execFile(cmd, args, (error, stdout, stderr) => {
			resolve({ code: error ? (error as { code?: number }).code ?? 1 : 0, stdout, stderr })
		})
	})
}

function dockerExec(container: string, args: string[]): Promise<ExecResult> {
	return run('docker', ['exec', container, ...args])
}

function parseMajor(version: string): number | undefined {
	const m = /(\d+)/.exec(version)
	return m ? Number(m[1]) : undefined
}

/**
 * Resolve the native toolchain used for the rehearsal, or `null` when no
 * matching toolchain is available (fail-closed).
 *
 * 1. If the host PATH tools already match the live server major (`prereq.ok`),
 *    run them directly (no docker indirection).
 * 2. Otherwise — when an admin URL is present and the server is reachable —
 *    fall back to the pg18 binaries inside the already-running `traggo-test-pg`
 *    container, but only if their major matches the live server major. This
 *    reuses a running container; it never pulls or substitutes an image (C-007).
 * 3. If neither provides matching tools, return `null` so the suite fails closed
 *    with the credential-free prerequisite report.
 */
async function resolveToolchain(prereq: PostgresPrerequisites): Promise<Toolchain | null> {
	if (prereq.ok) {
		return {
			kind: 'host',
			run: (tool, args) => run(tool, args),
			adaptUrl: (url) => url,
			dumpPath: (dbName) => `/tmp/ruok-${dbName}.dump`
		}
	}

	if (!prereq.adminUrl || !prereq.server || prereq.serverMajor === undefined) return null

	const dumpProbe = await dockerExec(DOCKER_PG_CONTAINER, [`${DOCKER_PG_BIN}/pg_dump`, '--version'])
	if (dumpProbe.code !== 0 || (parseMajor(dumpProbe.stdout) ?? 0) < prereq.serverMajor) return null
	const restoreProbe = await dockerExec(DOCKER_PG_CONTAINER, [`${DOCKER_PG_BIN}/pg_restore`, '--version'])
	if (restoreProbe.code !== 0 || (parseMajor(restoreProbe.stdout) ?? 0) < prereq.serverMajor) return null

	return {
		kind: 'docker',
		run: (tool, args) => dockerExec(DOCKER_PG_CONTAINER, [`${DOCKER_PG_BIN}/${tool}`, ...args]),
		// The container's postgres listens on its internal port 5432, not the
		// host-published 55432; point the tool at the loopback it can actually see.
		adaptUrl: (url) => {
			const u = new URL(url)
			u.hostname = '127.0.0.1'
			u.port = DOCKER_PG_PORT
			return u.toString()
		},
		// pg_dump + pg_restore both run inside the same container, so a shared
		// container-local dump path keeps the file visible to both steps.
		dumpPath: (dbName) => `/tmp/ruok-${dbName}.dump`
	}
}

async function withDisposableDb(
	fn: (config: PostgresConfig, dbName: string) => Promise<void>
): Promise<void> {
	const admin = new Client({ connectionString: adminUrl })
	await admin.connect()
	const dbName = `ruok_recover_${Math.random().toString(36).slice(2, 10)}`
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
		await fn(config, dbName)
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

describe('T031 PostgreSQL native recovery rehearsal', () => {
	// This composed prerequisite/migrate/seed/dump/recreate/restore/verify/cleanup
	// rehearsal needs its own budget: configured connections allow 10s and SQL
	// statements 30s; Vitest's 5s unit-test default cannot cover the whole flow.
	it('pg_dump + pg_restore preserves a full migrated installation', async () => {
		// Fail-closed prerequisite gate (T022): the preflight checks
		// RUOK_TEST_PG_ADMIN_URL, pg_dump/pg_restore/psql and a reachable PG18.
		// When the host PATH tools do not match the live server major, we fall
		// back to the matching pg18 binaries already present in the running
		// `traggo-test-pg` container (C-007-safe). The gate still fails closed:
		// it aborts only when no matching toolchain is genuinely available.
		const prereq = await assertPostgresPrerequisites(process.env)
		const toolchain = await resolveToolchain(prereq)
		expect(
			toolchain !== null,
			[
				...prereq.missing,
				'no matching pg18 native toolchain available (host PATH or running traggo-test-pg container)'
			].join('; ')
		).toBe(true)
		if (toolchain === null) return

		await withDisposableDb(async (config, dbName) => {
			// 1. Migrate + seed a full installation.
			expect((await migrateDatabase(config)).classification).toBe('fresh')
			const services = createDatabaseServices(config)
			await services.open()
			await seedInstall(services)
			await services.close()

			// 2. Native dump (matching pg18 toolchain — host PATH or running container).
			const dumpPath = toolchain.dumpPath(dbName)
			const dump = await toolchain.run('pg_dump', [
				'-Fc',
				'--no-owner',
				'--no-privileges',
				toolchain.adaptUrl(config.connectionString),
				'-f',
				dumpPath
			])
			expect(dump.code, dump.stderr).toBe(0)
			expect(dump.stderr).toBe('')

			// 3. Drop and recreate an empty database, then restore. pg_restore was
			//    already confirmed by the preflight before the rehearsal.
			const admin = new Client({ connectionString: adminUrl })
			await admin.connect()
			try {
				await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`)
				await admin.query(`CREATE DATABASE ${dbName}`)
			} finally {
				await admin.end()
			}
			const restore = await toolchain.run('pg_restore', [
				'--no-owner',
				'--no-privileges',
				'-d',
				toolchain.adaptUrl(config.connectionString),
				dumpPath
			])
			expect(restore.code, restore.stderr).toBe(0)

			// 4. Verify the restored installation is classified ready (migration check
			//    sees an aligned schema + history) and every row is readable.
			const migrated = await migrateDatabase(config)
			expect(migrated.classification).toBe('ready')
			expect(migrated.recorded).toBe(0)

			const restored = createDatabaseServices(config)
			await restored.open()
			try {
				expect((await restored.users.findByUsername('alice'))?.passwordHash).toBe('hash-a')
				expect((await restored.users.findByUsername('bob'))?.isAdmin).toBe(true)
				expect((await restored.systemConfig.all()).length).toBe(2)
				expect(await restored.friendships.findBetween('alice', 'bob')).toBeDefined()
				expect((await restored.plugins.findByUserAndPlugin('alice', 'fitbit'))?.enabled).toBe(true)
				expect((await restored.userAiConfig.findByUser('alice'))?.provider).toBe('anthropic')
				expect((await restored.objectives.findById('o1'))?.title).toBe('Yearly goal')
				expect((await restored.tasks.findById('t1'))?.title).toBe('Write code')
			} finally {
				await restored.close()
			}
		})
	}, 30_000)
})
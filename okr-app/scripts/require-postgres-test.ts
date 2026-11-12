/**
 * PostgreSQL live-test prerequisite preflight (WP05 / T022, FR-004 / FR-006 /
 * FR-008 / NFR-001 / NFR-003 / NFR-004).
 *
 * A side-effect-free module: importing it performs NO I/O (no binary exec, no
 * connection). The exported {@link assertPostgresPrerequisites} helper — and the
 * executable bundled CLI mode below — verify that the environment is ready for a
 * real disposable-PostgreSQL operational/recovery run and report ANY missing
 * prerequisite as a NONZERO failure WITHOUT printing credentials.
 *
 * Required for the native recovery rehearsal and the live operational suites:
 *   - `RUOK_TEST_PG_ADMIN_URL` is set (a DBA/owner connection to a disposable PG);
 *   - `pg_dump` / `pg_restore` / `psql` are on PATH and report a version;
 *   - the configured server is reachable and is PostgreSQL 18 or newer (PG18),
 *     the supported server for native dump/restore rehearsals.
 *
 * WP11 later activates this preflight for all required package commands; here it
 * is verified directly (T022) and used to gate the recovery/operational suites
 * (T023). It never substitutes SQLite and never hides a missing prerequisite.
 */
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { redactConnectionString } from '../src/lib/db/config'

/** Environment variable that supplies the DBA/owner connection string. */
export const PG_ADMIN_URL_ENV = 'RUOK_TEST_PG_ADMIN_URL'

/** Minimum supported server major version for disposable live runs (PG18). */
export const MIN_SERVER_MAJOR = 18

/** Native tools the recovery rehearsal and live dumps depend on. */
export const REQUIRED_TOOLS = ['pg_dump', 'pg_restore', 'psql'] as const

export interface PostgresPrerequisites {
	/** true when every prerequisite is satisfied (run may proceed). */
	ok: boolean
	/** Human-readable, credential-free reasons for every missing prerequisite. */
	missing: string[]
	/** true when `RUOK_TEST_PG_ADMIN_URL` is set. */
	adminUrl: boolean
	/** true when every native tool is present and reports a version. */
	tools: boolean
	pgDump: boolean
	pgRestore: boolean
	psql: boolean
	/** true when the configured server is reachable and is PG >= MIN_SERVER_MAJOR. */
	server: boolean
	/** Full server version string when reachable, else undefined. */
	serverVersion: string | undefined
	/** Server major version (e.g. 18) when reachable, else undefined. */
	serverMajor: number | undefined
}

/** Parse the leading numeric major from a tool `--version` string. */
function parseMajor(version: string): number | undefined {
	const m = /(\d+)/.exec(version)
	if (!m) return undefined
	return Number(m[1])
}

/** Report a tool's version (present + major) without leaking stdout. */
function toolInfo(name: string): { present: boolean; major: number | undefined } {
	try {
		const out = execFileSync(name, ['--version'], { stdio: 'pipe', encoding: 'utf8' })
		return { present: true, major: parseMajor(out) }
	} catch {
		return { present: false, major: undefined }
	}
}

/**
 * Verify all prerequisites for a live disposable-PostgreSQL run.
 *
 * Performs real checks only when invoked (never at import). Connection URLs are
 * redacted in every message; the raw admin URL is never printed. Does not
 * install or substitute anything — it only reports what is missing.
 */
export async function assertPostgresPrerequisites(
	env: Record<string, string | undefined> = process.env
): Promise<PostgresPrerequisites> {
	const missing: string[] = []
	const adminUrl = env[PG_ADMIN_URL_ENV]?.trim()

	// 1. Admin URL.
	if (!adminUrl) {
		missing.push(
			`${PG_ADMIN_URL_ENV} is not set. Set it to a DBA/owner connection string for a ` +
				`disposable PostgreSQL ${MIN_SERVER_MAJOR}+ server (no password will be printed).`
		)
	}

	// 2. Native tools (present + version).
	const dump = toolInfo('pg_dump')
	const restore = toolInfo('pg_restore')
	const psqlTool = toolInfo('psql')
	const tools = dump.present && restore.present && psqlTool.present
	if (!dump.present) missing.push('pg_dump is not on PATH (required for native dump)')
	if (!restore.present) missing.push('pg_restore is not on PATH (required before restore rehearsal)')
	if (!psqlTool.present) missing.push('psql is not on PATH (required for native dump/restore)')

	// 3. Reachable PG >= MIN_SERVER_MAJOR.
	let server = false
	let serverVersion: string | undefined
	let serverMajor: number | undefined
	if (adminUrl) {
		try {
			const { Client } = await import('pg')
			const client = new Client({ connectionString: adminUrl, connectionTimeoutMillis: 3000 })
			await client.connect()
			try {
				const version = await client.query<{ server_version: string; num: string }>(
					`SELECT current_setting('server_version') AS server_version, ` +
						`current_setting('server_version_num') AS num`
				)
				const row = version.rows[0]
				serverVersion = row.server_version
				const num = Number(row.num)
				serverMajor = Math.floor(num / 10000)
				if (Number.isFinite(num) && (serverMajor ?? 0) >= MIN_SERVER_MAJOR) {
					server = true
				} else {
					missing.push(
						`PostgreSQL server reports version ${row.server_version} (major ${serverMajor}); ` +
							`disposable live runs require >= ${MIN_SERVER_MAJOR}.`
					)
				}
			} finally {
				await client.end().catch(() => undefined)
			}
		} catch (err) {
			missing.push(
				`PostgreSQL server at ${redactConnectionString(adminUrl)} is not reachable: ` +
					`${(err as Error).message}`
			)
		}
	}

	// 4. Native dump/restore tools must MATCH the server major (T022): pg_dump
	//    cannot dump a newer server, and pg_restore must understand the dump
	//    produced by the matching pg_dump. psql is client-forward-compatible, so
	//    it only needs to be present.
	if (serverMajor !== undefined) {
		if (dump.present && (dump.major ?? 0) < serverMajor) {
			missing.push(
				`pg_dump major ${dump.major} does not match PostgreSQL server major ${serverMajor}; ` +
					`the native dump requires pg_dump >= the server version.`
			)
		}
		if (restore.present && (restore.major ?? 0) < serverMajor) {
			missing.push(
				`pg_restore major ${restore.major} does not match PostgreSQL server major ${serverMajor}; ` +
					`the native restore requires pg_restore >= the dump's server version.`
			)
		}
	}

	return {
		ok: missing.length === 0,
		missing,
		adminUrl: Boolean(adminUrl),
		tools,
		pgDump: dump.present,
		pgRestore: restore.present,
		psql: psqlTool.present,
		server,
		serverVersion,
		serverMajor
	}
}

async function main(): Promise<void> {
	const result = await assertPostgresPrerequisites(process.env)
	if (result.ok) {
		console.log('[require-postgres] OK')
		console.log(`[require-postgres] server=${result.serverVersion ?? 'unknown'} tools=pg_dump,pg_restore,psql`)
		process.exitCode = 0
		return
	}
	console.error('[require-postgres] Missing PostgreSQL test prerequisites:')
	for (const reason of result.missing) {
		console.error(`  - ${reason}`)
	}
	process.exitCode = 1
}

// Executable bundled CLI mode (T022): `node <bundled require-postgres-test.mjs>`.
// Importing this module (as a library) performs no I/O. `realpathSync` resolves
// the entry path so the identity check survives symlinked temp dirs (e.g. macOS
// `/tmp` -> `/private/tmp`).
const isMain = process.argv[1]
	? import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
	: false
if (isMain) {
	main().catch((err: unknown) => {
		console.error(`[require-postgres] Unexpected error: ${(err as Error).message}`)
		process.exitCode = 1
	})
}
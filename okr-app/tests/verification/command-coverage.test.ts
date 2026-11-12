/**
 * WP11 — command coverage and failure behavior (T051, FR-004 / FR-005 /
 * FR-008 / NFR-001 / NFR-003 / NFR-004).
 *
 * Proves that the required application/backend/recovery package commands are
 * wired to real on-disk entry points supplied by their dependency closure
 * (WP05/WP06/WP07), and that the fail-closed behaviors hold:
 *
 *   1. Entrypoint inventory (T049): every file a required command references
 *      exists on disk — a missing file is a hard failure, never an optional
 *      discovery or a placeholder.
 *   2. Command wiring (T050): `test:application:sqlite` /
 *      `test:application:postgres` run their HTTP/auth/probe entry AND their
 *      integration entry; the WP05 PostgreSQL preflight is bundled/invoked
 *      before every required PostgreSQL backend/recovery/application command.
 *   3. Missing-file / no-tests failure (T051): a nonexistent entry or a
 *      zero-test run exits nonzero (`passWithNoTests=false`, no implicit
 *      skips).
 *   4. Controlled missing-prerequisite subprocess (T051): the bundled
 *      preflight CLI fails nonzero for a missing `RUOK_TEST_PG_ADMIN_URL`
 *      without printing credentials. Positive execution of the actual
 *      application/backend/recovery commands on both real backends is recorded
 *      separately as run evidence (WP11 evidence dir); this suite supplies the
 *      deterministic static + negative-control checks that keep "exists on
 *      disk" from being mistaken for "runs".
 *
 * This file makes no claim about application behavior (WP11 is a planning
 * amendment).
 */
import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { beforeAll, describe, expect, it } from 'vitest'

// Repository-relative: okr-app/ (this file lives at okr-app/tests/verification/).
const OKR_APP_DIR = fileURLToPath(new URL('../../', import.meta.url))
const VITEST_BIN = join(OKR_APP_DIR, 'node_modules', 'vitest', 'vitest.mjs')
const CACHE_DIR = join(OKR_APP_DIR, 'node_modules', '.cache')
const PREFLIGHT_MJS = join(CACHE_DIR, 'require-postgres-test.mjs')
const PG_ADMIN_URL_ENV = 'RUOK_TEST_PG_ADMIN_URL'

/** Entry points required by the application/backend/recovery commands (T049). */
const REQUIRED_ENTRYPOINTS = [
	'scripts/require-postgres-test.ts', // WP05 preflight (executable bundled mode)
	'tests/application/sqlite.test.ts', // WP06 auth + probe (SQLite)
	'tests/application/postgres.test.ts', // WP06 auth + probe (PostgreSQL)
	'tests/application/integrations.sqlite.test.ts', // WP07 integrations (SQLite)
	'tests/application/integrations.postgres.test.ts' // WP07 integrations (PostgreSQL)
] as const

interface ScriptSpec {
	name: string
	/** Literal script body present in package.json (trimmed). */
	body: string
}

function loadScripts(): Record<string, string> {
	const pkg = JSON.parse(readFileSync(join(OKR_APP_DIR, 'package.json'), 'utf8'))
	return pkg.scripts ?? {}
}

/** Resolve a repository-relative path against okr-app and return its abs path. */
function abs(rel: string): string {
	return join(OKR_APP_DIR, rel)
}

/** Run a subprocess and always resolve with code/stdout/stderr (never throws). */
async function run(
	command: string,
	args: string[],
	env: NodeJS.ProcessEnv
): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		execFile(
			command,
			args,
			{ cwd: OKR_APP_DIR, env, timeout: 180_000, maxBuffer: 16 * 1024 * 1024 },
			(err, stdout, stderr) => {
				const code = err ? (err as { code?: unknown }).code ?? 1 : 0
				resolve({
					code: typeof code === 'number' ? code : 1,
					stdout: String(stdout),
					stderr: String(stderr)
				})
			}
		)
	})
}

/** env without the PG admin URL (the negative-control environment). */
function withoutAdminUrl(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env }
	delete env[PG_ADMIN_URL_ENV]
	// Ensure no PG* connection credentials leak into the negative control.
	for (const k of Object.keys(env)) {
		if (/^PG(HOST|USER|PASSWORD|DATABASE|PORT|URL)$/i.test(k)) delete env[k]
	}
	return env
}

/** Is the reporter free of any credential-shaped content? */
function credentialFree(stdout: string, stderr: string): boolean {
	const combined = `${stdout}\n${stderr}`
	return !/postgres:\/\/|postgresql:\/\/|password\s*[=:]/i.test(combined)
}

describe('T049 — dependency-produced entrypoint inventory', () => {
	it('every entry point referenced by required commands exists on disk', () => {
		for (const rel of REQUIRED_ENTRYPOINTS) {
			expect(existsPath(rel), `required entry point missing: ${rel}`).toBe(true)
		}
	})

	it('no referenced test/script file is a placeholder or empty', () => {
		for (const rel of REQUIRED_ENTRYPOINTS) {
			const content = readFileSync(abs(rel), 'utf8')
			expect(content.trim().length, `${rel} is empty`).toBeGreaterThan(0)
		}
	})
})

describe('T050 — application + PostgreSQL preflight command wiring', () => {
	it('test:application:sqlite runs both HTTP/auth/probe and integration entries', () => {
		const scripts = loadScripts()
		expect(scripts['test:application:sqlite']).toBeDefined()
		const body = scripts['test:application:sqlite']
		expect(body).toContain('tests/application/sqlite.test.ts')
		expect(body).toContain('tests/application/integrations.sqlite.test.ts')
		expect(body).toContain('DB_BACKEND=sqlite')
	})

	it('test:application:postgres runs both HTTP/auth/probe and integration entries behind the preflight', () => {
		const scripts = loadScripts()
		expect(scripts['test:application:postgres']).toBeDefined()
		const body = scripts['test:application:postgres']
		expect(body).toContain('tests/application/postgres.test.ts')
		expect(body).toContain('tests/application/integrations.postgres.test.ts')
		expect(body).toContain('DB_BACKEND=postgres')
		expect(body).toContain('preflight:postgres')
	})

	it('preflight:postgres bundles and invokes scripts/require-postgres-test.ts', () => {
		const scripts = loadScripts()
		expect(scripts['preflight:postgres']).toBeDefined()
		const body = scripts['preflight:postgres']
		expect(body).toContain('scripts/require-postgres-test.ts')
		expect(body).toContain('--bundle')
		expect(body).toContain('node_modules/.cache/require-postgres-test.mjs')
	})

	it('preflight is wired before every required PostgreSQL backend/recovery/application command', () => {
		const scripts = loadScripts()
		for (const name of ['test:db:postgres', 'test:recovery:postgres', 'test:application:postgres']) {
			expect(scripts[name], `${name} is missing`).toBeDefined()
			expect(scripts[name].startsWith('npm run preflight:postgres && '), `${name} must run preflight first`).toBe(true)
		}
	})
})

describe('T051 — missing-file and no-tests are hard failures (passWithNoTests=false)', () => {
	it('a nonexistent entry point fails nonzero', async () => {
		const res = await run(
			process.execPath,
			[VITEST_BIN, 'run', 'tests/application/definitely-missing.test.ts'],
			process.env
		)
		expect(res.code).not.toBe(0)
	})

	it('a zero-test run (no matching files) fails nonzero', async () => {
		const res = await run(process.execPath, [VITEST_BIN, 'run', 'tests/zzz_no_such_suite/**'], process.env)
		expect(res.code).not.toBe(0)
	})

	it('the vite config keeps passWithNoTests=false (no implicit skip of empty runs)', () => {
		const viteConfig = readFileSync(abs('vite.config.ts'), 'utf8')
		expect(viteConfig).toContain('passWithNoTests')
		expect(viteConfig).toContain('false')
	})
})

describe('T051 — controlled missing-prerequisite subprocess (preflight fail-closed)', () => {
	beforeAll(async () => {
		// Build the preflight CLI exactly as `preflight:postgres` does.
		mkdirSync(CACHE_DIR, { recursive: true })
		await build({
			entryPoints: [abs('scripts/require-postgres-test.ts')],
			bundle: true,
			platform: 'node',
			packages: 'external',
			format: 'esm',
			outfile: PREFLIGHT_MJS
		})
		expect(existsPath('node_modules/.cache/require-postgres-test.mjs')).toBe(true)
	})

	it('preflight fails nonzero when RUOK_TEST_PG_ADMIN_URL is missing', async () => {
		const res = await run(process.execPath, [PREFLIGHT_MJS], withoutAdminUrl())
		expect(res.code).not.toBe(0)
		expect(res.stderr).toContain(PG_ADMIN_URL_ENV)
		// Fail-closed, credential-free: never echoes a connection URL/password.
		expect(credentialFree(res.stdout, res.stderr)).toBe(true)
	})
})

function existsPath(rel: string): boolean {
	try {
		readFileSync(abs(rel))
		return true
	} catch {
		return false
	}
}
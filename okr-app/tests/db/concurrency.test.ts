/**
 * Concurrency serialization test (T011 / T012 / T024).
 *
 * Two independent `db:migrate` CLI processes race to migrate the same fresh
 * SQLite file. The migration lock/busy-timeout must serialize them: both
 * succeed and the resulting schema + journal are valid (not corrupted, not
 * double-applied). Uses the REAL bundled CLI so this exercises the shipped
 * migration runtime.
 *
 * T024 (stability): the regression is executed TEN consecutive times against
 * fresh databases, each run in its own isolated temp directory with its own
 * unique bundle (no shared node_modules/.cache path that could collide across
 * parallel test files/processes). Child stdout/stderr, exit code AND signal are
 * captured; Vitest retry is disabled (default) — a flake is never retried into
 * green.
 */
import { execFile } from 'child_process'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'

const cwd = process.cwd()
const esbuild = join(cwd, 'node_modules', '.bin', 'esbuild')

/** Number of consecutive independent regression runs (T024, retries disabled). */
const CONCURRENT_RUNS = 10

interface RunResult {
	code: number
	signal: string | null
	stdout: string
	stderr: string
}

function run(cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv }): Promise<RunResult> {
	return new Promise((resolve) => {
		execFile(cmd, args, { ...opts, cwd }, (error, stdout, stderr) => {
			const err = error as (NodeJS.ErrnoException & { signal?: string | null }) | null
			resolve({
				code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
				signal: err ? (err.signal ?? null) : null,
				stdout: String(stdout),
				stderr: String(stderr)
			})
		})
	})
}

describe('concurrent startup/CLI migration (T011/T012)', () => {
	// One isolated bundle path for the whole test (unique per run; external
	// packages resolve because the bundle lives under the project's node_modules).
	const bundle = join(cwd, 'node_modules', '.cache', `db-migrate-conc-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
	const dirs: string[] = []

	afterAll(() => {
		rmSync(bundle, { force: true })
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
	})

	it('serializes two concurrent CLI migrations and converges cleanly (10 runs)', async () => {
		// Bundle the CLI once into the isolated path (avoids racing the output
		// file), then for each run spawn two processes against a fresh database.
		const bundleRes = await run(
			esbuild,
			['scripts/db-migrate.ts', '--bundle', '--platform=node', '--packages=external', '--format=esm', `--outfile=${bundle}`],
			{ env: process.env }
		)
		expect(bundleRes.code, bundleRes.stderr).toBe(0)

		for (let runNo = 0; runNo < CONCURRENT_RUNS; runNo++) {
			const dir = mkdtempSync(join(tmpdir(), 'ruok-conc-'))
			dirs.push(dir)
			const dbPath = join(dir, 'okr.db')
			const env = { ...process.env, DATABASE_PATH: dbPath }

			const [a, b] = await Promise.all([
				run('node', [bundle], { env }),
				run('node', [bundle], { env })
			])

			// Both children must exit cleanly (0) with no signal.
			expect(a.code, `run ${runNo} child A stderr: ${a.stderr}`).toBe(0)
			expect(a.signal, `run ${runNo} child A was killed by signal ${a.signal}`).toBeNull()
			expect(b.code, `run ${runNo} child B stderr: ${b.stderr}`).toBe(0)
			expect(b.signal, `run ${runNo} child B was killed by signal ${b.signal}`).toBeNull()

			// The converged database is valid: 25 app tables, full journal, no dupes.
			const raw = new Database(dbPath, { readonly: true })
			try {
				const tables = raw
					.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '__drizzle_migrations'`)
					.all() as Array<{ name: string }>
				expect(tables, `run ${runNo} table count`).toHaveLength(25)
				const journal = raw.prepare('SELECT count(*) AS c FROM __drizzle_migrations').get() as { c: number }
				expect(journal.c, `run ${runNo} journal count`).toBe(7)
				const dupes = raw
					.prepare('SELECT created_at, count(*) AS c FROM __drizzle_migrations GROUP BY created_at HAVING c > 1')
					.all()
				expect(dupes, `run ${runNo} duplicate migrations`).toHaveLength(0)
			} finally {
				raw.close()
			}
		}
	})
})
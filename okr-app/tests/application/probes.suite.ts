/**
 * WP06 — real HTTP health/readiness across storage outage and recovery (T028).
 *
 * Drives the BUILT server with real HTTP and real storage faults — no mocked
 * `getReadiness`, no fake repositories. Health must stay 200 while readiness
 * truthfully reports 503 during storage unavailability and returns to 200 after
 * recovery, all within the NFR-002 bounds (5s request / 10s detection / 30s
 * recovery) and WITHOUT process restart (unchanged PID).
 *
 * SQLite outage/recovery uses REAL external storage faults:
 *  - startup-unavailable: the migration cannot create its DB path because a
 *    parent path is occupied by a regular file (mkdir fails); readiness 503.
 *  - recovery: the blocker is removed so the next bounded open attempt succeeds.
 *  - later outage: an external better-sqlite3 connection holds `BEGIN EXCLUSIVE`
 *    on a `journal_mode=delete` database, which blocks even reads, so the app's
 *    live availability probe (and an authenticated write) wait; readiness 503.
 *  - second recovery: releasing the external lock unblocks the worker; readiness 200.
 *
 * PostgreSQL outage manipulation needs live server control; it is recorded
 * PENDING (never fabricated). The healthy/ready baseline and the startup-
 * unavailable baseline run on both backends where the host supports them.
 */
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CookieJar, startServer, type RunningServer } from './http-fixture';

const PASSWORD = 'correct-horse-battery';
const DETECTION_BOUND_MS = 10_000;
const RECOVERY_BOUND_MS = 30_000;
const REQUEST_BOUND_MS = 5_000;
// Fixture startup already permits 20s and shutdown 3s. Account separately for
// two individually bounded requests and 2s of orchestration; do not relax the
// five-second probe-response contract to fit Vitest's aggregate test timer.
const COMPOSED_PROBE_BOUND_MS = 20_000 + 2 * REQUEST_BOUND_MS + 3_000 + 2_000;

async function measurePhase<T>(label: string, phase: () => Promise<T>): Promise<T> {
	const started = performance.now();
	try {
		return await phase();
	} finally {
		console.info(`HTTP probe phase ${label}: ${(performance.now() - started).toFixed(1)}ms`);
	}
}

async function boundedProbe(srv: RunningServer, path: string, label: string) {
	const started = performance.now();
	try {
		const response = await srv.request(path, { signal: AbortSignal.timeout(REQUEST_BOUND_MS) });
		const body = await response.json();
		expect(performance.now() - started, `${label} ${path} response including body`).toBeLessThan(REQUEST_BOUND_MS);
		return { response, body };
	} finally {
		console.info(`HTTP probe phase ${label} ${path}: ${(performance.now() - started).toFixed(1)}ms`);
	}
}

/** Poll `/api/ready` every ~1s until 200 or the deadline; returns true on recovery. */
async function pollUntilReady(srv: RunningServer, deadlineMs: number): Promise<boolean> {
	const deadline = Date.now() + deadlineMs;
	while (Date.now() < deadline) {
		try {
			const res = await srv.request('/api/ready');
			if (res.status === 200) return true;
		} catch {
			// not ready
		}
		await new Promise((r) => setTimeout(r, 1000));
	}
	return false;
}

export interface ProbesHost {
	backend: 'sqlite' | 'postgres';
	/** Start a ready server (both backends). */
	startHealthy(): Promise<RunningServer>;
	/** Start a server whose storage is unavailable at startup (health 200 / ready 503). */
	startUnavailable(): Promise<RunningServer>;
}

export function probesSuite(label: string, host: ProbesHost) {
	describe(`HTTP probes (${label})`, () => {
		it('health returns 200 {status:ok, uptime} and ready returns 200 ready:true', async () => {
			const srv = await measurePhase(`${label} healthy startup`, () => host.startHealthy());
			try {
				const { response: health, body: hb } = await boundedProbe(srv, '/api/health', `${label} healthy`);
				expect(health.status).toBe(200);
				expect(hb.status).toBe('ok');
				expect(typeof hb.uptime).toBe('number');

				const { response: ready, body: rb } = await boundedProbe(srv, '/api/ready', `${label} healthy`);
				expect(ready.status).toBe(200);
				expect(rb.ready).toBe(true);
				expect(rb.open).toBe(true);
				expect(rb.dialect).toBe(host.backend);
				expect(typeof rb.schemaVersion).toBe('number');
			} finally {
				await measurePhase(`${label} healthy shutdown`, () => srv.stop());
			}
		}, COMPOSED_PROBE_BOUND_MS);

		it('health stays 200 and ready is 503 while storage is unavailable at startup', async () => {
			const srv = await measurePhase(`${label} unavailable startup`, () => host.startUnavailable());
			try {
				const { response: health } = await boundedProbe(srv, '/api/health', `${label} unavailable`);
				expect(health.status).toBe(200);
				const { response: ready, body: rb } = await boundedProbe(srv, '/api/ready', `${label} unavailable`);
				expect(ready.status).toBe(503);
				expect(rb.ready).toBe(false);
			} finally {
				await measurePhase(`${label} unavailable shutdown`, () => srv.stop());
			}
		}, COMPOSED_PROBE_BOUND_MS);
	});

	if (host.backend === 'sqlite') {
		describe(`HTTP startup→recovery→outage→recovery on one PID (${label})`, () => {
			it(
				'one process: unavailable startup -> first recovery -> later outage -> second recovery, unchanged PID, within bounds',
				async () => {
					// Startup-unavailable: parent path is a regular file so mkdir fails.
					const dir = mkdtempSync(join(tmpdir(), 'ruok-probe-cycle-'));
					const blocker = join(dir, 'blocker');
					writeFileSync(blocker, 'occupied');
					const dbPath = join(dir, 'blocker', 'okr.db');

					const srv = await startServer({
						backend: 'sqlite',
						dataDir: dir,
						env: {
							DATABASE_PATH: dbPath,
							SQLITE_JOURNAL_MODE: 'delete',
							SQLITE_BUSY_TIMEOUT_MS: '5000',
							ADMIN_USERNAME: 'admin'
						},
						requireReady: false
					});
					const pid = srv.pid;
					const timeline: string[] = [];
					try {
						// Unavailable startup: health 200, ready 503.
						expect((await srv.request('/api/health')).status).toBe(200);
						timeline.push(`startup-unavailable health=200`);
						const ready1 = await srv.request('/api/ready');
						expect(ready1.status).toBe(503);
						timeline.push(`startup-unavailable ready=503`);

						// First recovery: remove the blocker, poll ready -> 200 (same PID).
						rmSync(blocker, { force: true });
						const rec1Start = Date.now();
						expect(await pollUntilReady(srv, RECOVERY_BOUND_MS)).toBe(true);
						timeline.push(`first-recovery ready=200 after ${Date.now() - rec1Start}ms`);
						expect(srv.pid).toBe(pid);

						// Authenticated ordinary user for the later outage write.
						const jar = new CookieJar();
						expect((await srv.register('probe_user', PASSWORD, jar)).status).toBe(200);

						// Later outage: hold an external EXCLUSIVE lock (delete mode blocks reads).
						const lock = new Database(dbPath, { timeout: 5000 });
						lock.exec('BEGIN EXCLUSIVE');
						timeline.push(`outage-started external exclusive lock`);

						// Authenticated ordinary write is blocked by the lock.
						const writePromise = srv.request(
							'/api/objectives',
							{
								method: 'POST',
								body: JSON.stringify({ title: 'outage objective', level: 'yearly', year: 2026 })
							},
							jar
						);

						// Overlapping readiness probes coalesce/backpressure to 503 within bounds.
						const probeStart = Date.now();
						const probes = await Promise.all([
							srv.request('/api/ready'),
							srv.request('/api/ready'),
							srv.request('/api/ready')
						]);
						const probeDuration = Date.now() - probeStart;
						expect(probeDuration).toBeLessThan(REQUEST_BOUND_MS);
						for (const p of probes) expect(p.status).toBe(503);
						timeline.push(`outage ready=503 (coalesced ${probeDuration}ms)`);

						// Health stays 200 during the outage.
						expect((await srv.request('/api/health')).status).toBe(200);
						timeline.push(`outage health=200`);

						// Second recovery: release the external lock.
						lock.exec('ROLLBACK');
						lock.close();
						timeline.push(`outage-released external lock`);

						// The blocked write completes (recorded result, no retry/replay).
						const writeResult = await Promise.race([
							writePromise,
							new Promise<null>((r) => setTimeout(() => r(null), 20_000))
						]);
						expect(writeResult).not.toBeNull();
						expect(writeResult!.status).toBe(201);
						timeline.push(`blocked-write completed status=201`);

						// Readiness recovers to 200 within bound, still same PID.
						const rec2Start = Date.now();
						expect(await pollUntilReady(srv, RECOVERY_BOUND_MS)).toBe(true);
						timeline.push(`second-recovery ready=200 after ${Date.now() - rec2Start}ms`);
						expect(srv.pid).toBe(pid);

						// The objective persisted through the outage (no data loss).
						const list = await srv.request('/api/objectives', {}, jar);
						const body = await list.json();
						expect(body.objectives.some((o: any) => o.title === 'outage objective')).toBe(true);

						// Attach the timeline to the test context for the evidence transcript.
						(expect.getState() as any).timeline = timeline;
					} finally {
						await srv.stop();
						rmSync(dir, { recursive: true, force: true });
					}
				},
				120_000
			);

			it(
				'repeated outage/recovery across SQLite busy timeouts 0/5000/30000 stays within bounds',
				async () => {
					for (const busy of [0, 5000, 30000]) {
						const dir = mkdtempSync(join(tmpdir(), 'ruok-probe-busy-'));
						const dbPath = join(dir, 'data', 'okr.db');
						const srv = await startServer({
							backend: 'sqlite',
							dataDir: dir,
							env: {
								DATABASE_PATH: dbPath,
								SQLITE_JOURNAL_MODE: 'delete',
								SQLITE_BUSY_TIMEOUT_MS: String(busy)
							}
						});
						const pid = srv.pid;
						try {
							const jar = new CookieJar();
							expect((await srv.register('busy_user', PASSWORD, jar)).status).toBe(200);

							const lock = new Database(dbPath, { timeout: Math.max(busy, 1000) });
							lock.exec('BEGIN EXCLUSIVE');

							const writePromise = srv.request(
								'/api/objectives',
								{
									method: 'POST',
									body: JSON.stringify({ title: `busy-${busy}`, level: 'yearly', year: 2026 })
								},
								jar
							);

							// Outage: readiness reports 503 within the request bound.
							const started = Date.now();
							const ready = await srv.request('/api/ready');
							expect(Date.now() - started).toBeLessThan(REQUEST_BOUND_MS);
							expect(ready.status).toBe(503);
							expect((await srv.request('/api/health')).status).toBe(200);

							// Let the write either complete or fail (busy=0 fails fast);
							// record the result separately — never retry/replay.
							const writeResult = await Promise.race([
								writePromise,
								new Promise<null>((r) => setTimeout(() => r(null), 35_000))
							]);
							expect(writeResult).not.toBeNull();

							// Release the lock -> readiness recovers within bound, same PID.
							lock.exec('ROLLBACK');
							lock.close();
							expect(await pollUntilReady(srv, RECOVERY_BOUND_MS)).toBe(true);
							expect(srv.pid).toBe(pid);
						} finally {
							await srv.stop();
							rmSync(dir, { recursive: true, force: true });
						}
					}
				},
				240_000
			);
		});
	}
}

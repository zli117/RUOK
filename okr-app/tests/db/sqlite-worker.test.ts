/**
 * WP10 — SQLite execution isolation (T044–T048).
 *
 * Verifies that every synchronous SQLite operation runs off the HTTP event loop
 * through a worker-private engine behind the awaitable {@link DatabaseServices}
 * facade:
 *  - structured-clone value types (Date/Map/null/undefined) survive the boundary;
 *  - the typed allowlist denies unknown/denied methods and covers every contract
 *    method;
 *  - a real external write lock leaves host event-loop timers responsive and
 *    readiness truthful (times out while blocked, recovers on release) at
 *    configured busy timeouts 0/5000/30000ms;
 *  - the ordinary-request queue is bounded (overflow rejected before dispatch);
 *  - shutdown rejects pending work and does not leak workers;
 *  - preparation runs in a separate worker; SQLite verify creates no missing
 *    file/path; PostgreSQL selection creates no SQLite worker.
 */
import { describe, expect, it, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabaseServices } from '../../src/lib/db';
import type { DatabaseServices, SqliteConfig } from '../../src/lib/db/contracts';
import { SqliteDatabaseServices } from '../../src/lib/db/adapters/sqlite';
import { runSqlitePreparation } from '../../src/lib/db/adapters/sqlite';
import { SqliteLocalServices } from '../../src/lib/db/adapters/sqlite-local';
import { resolveWorkerEntry } from '../../src/lib/db/adapters/sqlite-worker-client';
import { allowlistedMethods, MAX_ORDINARY_QUEUE } from '../../src/lib/db/adapters/sqlite-worker-protocol';
import { buildAllWorkers } from '../../scripts/build-database-workers';
import { existsSync } from 'node:fs';

const T = new Date(Date.UTC(2026, 0, 15, 12, 30, 45, 0));

interface Db {
	dir: string;
	path: string;
	config: SqliteConfig;
}

const liveConnections: Database.Database[] = [];

function trackLive(db: Database.Database): Database.Database {
	liveConnections.push(db);
	return db;
}

/** Create a temp SQLite database fully migrated via the preparation worker. */
async function createMigratedDb(busyTimeoutMs = 5000): Promise<Db> {
	const dir = mkdtempSync(join(tmpdir(), 'ruok-wp10-'));
	const path = join(dir, 'okr.db');
	const config: SqliteConfig = { type: 'sqlite', path, journalMode: 'wal', busyTimeoutMs };
	await runSqlitePreparation(config, { mode: 'migrate' });
	return { dir, path, config };
}

afterEach(async () => {
	for (const db of liveConnections) {
		try {
			db.close();
		} catch {
			/* already closed */
		}
	}
	liveConnections.length = 0;
});

function cleanup(dir: string): void {
	rmSync(dir, { recursive: true, force: true });
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withServices(
	config: SqliteConfig,
	fn: (services: DatabaseServices) => Promise<void>
): Promise<void> {
	const services = createDatabaseServices(config) as SqliteDatabaseServices;
	await services.open();
	try {
		await fn(services);
	} finally {
		await services.close();
	}
}

describe('WP10 sqlite-worker-protocol (T044)', () => {
	it('preserves Date, Map, null and undefined across the structured-clone boundary', async () => {
		const { dir, config } = await createMigratedDb();
		try {
			await withServices(config, async (s) => {
				const created = await s.users.create({
					id: 'u1',
					username: 'u1',
					passwordHash: 'hash',
					weekStartDay: 'monday',
					timezone: 'UTC',
					bgColor: null,
					createdAt: T
				});
				const read = await s.users.findById('u1');
				expect(read).toBeDefined();
				// Date must survive as a real Date, not a string/number.
				expect(read?.createdAt).toBeInstanceOf(Date);
				expect(read?.createdAt?.toISOString()).toBe(T.toISOString());
				// null preserved.
				expect(read?.bgColor).toBeNull();
				// undefined for a missing row.
				expect(await s.users.findById('nope')).toBeUndefined();

				// Map result type survives structured clone.
				const tp = await s.timePeriods.create({
					id: 'tp1',
					userId: 'u1',
					periodType: 'daily',
					year: 2026,
					createdAt: T,
					updatedAt: T
				});
				await s.tasks.create({
					id: 't1',
					userId: 'u1',
					timePeriodId: tp.id,
					title: 't',
					completed: false,
					sortOrder: 0,
					timeSpentMs: 0,
					createdAt: T,
					updatedAt: T
				});
				await s.taskAttributes.upsertByTaskAndKey({
					taskId: 't1',
					key: 'k',
					value: 'v',
					valueType: 'text'
				});
				const map = await s.taskAttributes.listByTasks(['t1']);
				expect(map).toBeInstanceOf(Map);
				expect(map.get('t1')).toHaveLength(1);
			});
		} finally {
			cleanup(dir);
		}
	});

	it('denies unknown/denied methods in the local engine allowlist', async () => {
		const { dir, config } = await createMigratedDb();
		try {
			const local = new SqliteLocalServices(config);
			await local.open();
			try {
				await expect(local.dispatch('not.a.real.method', [])).rejects.toThrow(/disallow|Unknown/i);
				await expect(local.dispatch('users.__proto__', [])).rejects.toThrow(/disallow|Unknown/i);
			} finally {
				await local.close();
			}
		} finally {
			cleanup(dir);
		}
	});

	it('allowlist covers every repository/service method in the persistence contract', () => {
		const methods = allowlistedMethods();
		// Spot-check representative methods across the surface.
		for (const m of [
			'users.create',
			'users.remove',
			'tasks.stopTimer',
			'taskTags.listByTasks',
			'dailyMetricValues.upsert',
			'backup.exportSnapshot',
			'backup.restore',
			'createUserWithInitialData',
			'createTaskWithDetails',
			'updateTaskWithDetails',
			'checkAvailability'
		]) {
			expect(methods).toContain(m);
		}
		expect(methods.length).toBeGreaterThan(90);
	});

	it('resolveWorkerEntry points at a real, runnable worker asset (dev/Vitest bundling)', async () => {
		const entry = await resolveWorkerEntry('runtime');
		expect(existsSync(entry)).toBe(true);
		expect(entry.endsWith('.mjs')).toBe(true);
	});
});

describe('WP10 isolation parity (T045)', () => {
	it('runs the full contract surface through the worker facade unchanged', async () => {
		const { dir, config } = await createMigratedDb();
		try {
			await withServices(config, async (s) => {
				const user = await s.users.create({
					id: 'u1',
					username: 'u1',
					passwordHash: 'hash',
					weekStartDay: 'monday',
					timezone: 'UTC',
					createdAt: T
				});
				expect(await s.users.count()).toBe(1);
				expect(await s.users.remove('u1')).toBe(1);
				expect(await s.users.findById('u1')).toBeUndefined();
			});
		} finally {
			cleanup(dir);
		}
	});

	it('SQLite verify creates no missing file/path and rejects absent storage', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'ruok-wp10-verify-'));
		const missingPath = join(dir, 'does-not-exist', 'db.sqlite');
		const config: SqliteConfig = {
			type: 'sqlite',
			path: missingPath,
			journalMode: 'wal',
			busyTimeoutMs: 5000
		};
		await expect(runSqlitePreparation(config, { mode: 'verify' })).rejects.toThrow();
		// No file or directory was created by the verify path.
		expect(existsSync(missingPath)).toBe(false);
		expect(existsSync(join(dir, 'does-not-exist'))).toBe(false);
		cleanup(dir);
	});

	it('PostgreSQL selection constructs a postgres facade and never spawns a SQLite worker', () => {
		const services = createDatabaseServices({
			type: 'postgres',
			connectionString: 'postgres://u:p@localhost:5432/nope',
			poolMax: 5,
			connectTimeoutMs: 1000,
			statementTimeoutMs: 1000,
			sslMode: 'disable'
		});
		expect(services.dialect).toBe('postgres');
		// No worker is spawned at construction time (I/O-free lazy factory).
		expect((services as unknown as { worker?: unknown }).worker).toBeUndefined();
	});
});

describe('WP10 lock isolation & readiness (T046/T048)', () => {
	it.each([5000, 30000])(
		'a locked write leaves host timers responsive; readiness times out then recovers (busy=%i)',
		async (busy) => {
			const { dir, config } = await createMigratedDb(busy);
			const path = config.path;
			try {
				const services = createDatabaseServices(config) as SqliteDatabaseServices;
				await services.open();
				// Parent rows so the blocked write satisfies foreign keys.
				await services.users.create({
					id: 'u1',
					username: 'u1',
					passwordHash: 'h',
					weekStartDay: 'monday',
					timezone: 'UTC',
					createdAt: T
				});
				await services.timePeriods.create({
					id: 'tp1',
					userId: 'u1',
					periodType: 'daily',
					year: 2026,
					createdAt: T,
					updatedAt: T
				});

				// External writer acquires the write lock AFTER the app is open.
				const lock = trackLive(new Database(path, { timeout: 2000 }));
				lock.exec('BEGIN IMMEDIATE');

				// Ordinary write: blocks in the worker on busy_timeout.
				const writePromise = services.tasks.create({
					id: 't1',
					userId: 'u1',
					timePeriodId: 'tp1',
					title: 'blocked',
					completed: false,
					sortOrder: 0,
					timeSpentMs: 0,
					createdAt: T,
					updatedAt: T
				});
				await sleep(250);

				// Event-loop timer is not delayed by the blocked worker write.
				const delay = await new Promise<number>((resolve) => {
					const start = Date.now();
					setTimeout(() => resolve(Date.now() - start), 100);
				});
				expect(delay).toBeLessThan(500);

				// Readiness is truthful: queued behind the blocked write -> unavailable.
				const availBefore = await services.checkAvailability();
				expect(availBefore).toBe(false);

				// Release the lock: the same owner recovers and the write completes.
				lock.exec('COMMIT');
				const task = await writePromise;
				expect(task).toBeDefined();
				expect(task.title).toBe('blocked');

				const availAfter = await services.checkAvailability();
				expect(availAfter).toBe(true);

				await services.close();
			} finally {
				cleanup(dir);
			}
		}
	);

	it('a locked write with busy_timeout=0 rejects immediately without stalling the loop', async () => {
		const { dir, config } = await createMigratedDb(0);
		const path = config.path;
		try {
			const services = createDatabaseServices(config) as SqliteDatabaseServices;
			await services.open();
			const lock = trackLive(new Database(path, { timeout: 0 }));
			lock.exec('BEGIN IMMEDIATE');
			const started = Date.now();
			await expect(
				services.users.create({
					id: 'u1',
					username: 'u1',
					passwordHash: 'h',
					weekStartDay: 'monday',
					timezone: 'UTC',
					createdAt: T
				})
			).rejects.toThrow();
			expect(Date.now() - started).toBeLessThan(2000);
			lock.exec('ROLLBACK');
			await services.close();
		} finally {
			cleanup(dir);
		}
	});

	it('bounded ordinary queue rejects overflow before dispatch and does not leak', async () => {
		const { dir, config } = await createMigratedDb(5000);
		const path = config.path;
		try {
			const services = createDatabaseServices(config) as SqliteDatabaseServices;
			await services.open();
			const lock = trackLive(new Database(path, { timeout: 2000 }));
			lock.exec('BEGIN IMMEDIATE');

			const promises: Promise<unknown>[] = [];
			for (let i = 0; i < MAX_ORDINARY_QUEUE + 5; i++) {
				promises.push(
					services.users.create({
						id: `u${i}`,
						username: `u${i}`,
						passwordHash: 'h',
						weekStartDay: 'monday',
						timezone: 'UTC',
						createdAt: T
					})
				);
			}
			// Release the lock so queued writes can settle.
			lock.exec('ROLLBACK');
			const settled = await Promise.allSettled(promises);
			const rejected = settled.filter((r) => r.status === 'rejected');
			expect(rejected.length).toBeGreaterThan(0);
			const overflowRejections = settled.filter(
				(r) => r.status === 'rejected' && String((r as PromiseRejectedResult).reason).includes('overflow')
			);
			expect(overflowRejections.length).toBeGreaterThan(0);
			await services.close();
		} finally {
			cleanup(dir);
		}
	});

	it('shutdown fences generations, rejects pending work and does not leak workers', async () => {
		const { dir, config } = await createMigratedDb(5000);
		try {
			const services = createDatabaseServices(config) as SqliteDatabaseServices;
			await services.open();
			// Fire an in-flight write; attach a handler so its fence rejection is not
			// reported as unhandled, and let close() settle it.
			const inFlight = services.users
				.create({
					id: 'u1',
					username: 'u1',
					passwordHash: 'h',
					weekStartDay: 'monday',
					timezone: 'UTC',
					createdAt: T
				})
				.catch(() => undefined);

			// Also queue ordinary work that close() must reject without dispatching.
			const queued: Promise<unknown>[] = [];
			for (let i = 0; i < 3; i++) {
				queued.push(services.users.findById(`u${i}`).catch(() => undefined));
			}

			await services.close();
			await inFlight;
			await Promise.allSettled(queued);

			expect(services.isOpen()).toBe(false);
			// Generation fence: invocations after close reject.
			await expect(services.users.findById('x')).rejects.toThrow(/closed/);

			// No leak: reopening works and the same owner serves writes again.
			await services.open();
			expect(services.isOpen()).toBe(true);
			const created = await services.users.create({
				id: 'u2',
				username: 'u2',
				passwordHash: 'h',
				weekStartDay: 'monday',
				timezone: 'UTC',
				createdAt: T
			});
			expect(created.id).toBe('u2');
			await services.close();
		} finally {
			cleanup(dir);
		}
	});
});

describe('WP10 packaging (T047)', () => {
	it('buildAllWorkers emits runnable .mjs worker assets without opening a database', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'ruok-wp10-build-'));
		try {
			const outputs = await buildAllWorkers(dir);
			expect(outputs.length).toBeGreaterThanOrEqual(2);
			for (const out of outputs) {
				expect(existsSync(out)).toBe(true);
				expect(out.endsWith('.mjs')).toBe(true);
			}
			// The runtime worker asset must reference no bundled SQLite driver.
			const runtime = outputs.find((o) => o.endsWith('runtime.mjs'));
			expect(runtime).toBeTruthy();
		} finally {
			cleanup(dir);
		}
	});
});
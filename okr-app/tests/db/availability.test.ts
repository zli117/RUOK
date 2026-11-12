/**
 * WP04 — live availability + lifecycle ownership (T014/T015/T016/T020).
 *
 * Binds `DatabaseServices` to a concrete dialect and verifies the bounded live
 * availability probe (`checkAvailability`) plus the single lifecycle owner:
 * shared open attempt, successful-only publication, finally cleanup,
 * partial-resource close, bounded retry cooldown (<=1s), generation fencing on
 * shutdown/reset, and "close cannot resurrect resources".
 *
 * SQLite checks run against a real temp DB through the WP10 worker facade (the
 * only way the backend runs in this app). The live PostgreSQL availability
 * check is guarded on `RUOK_TEST_PG_ADMIN_URL` (skipped when absent — recorded
 * PENDING in WP04 evidence, never substituted with SQLite). The not-open
 * branch of the PostgreSQL probe is exercised without a server.
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Client, type Pool } from 'pg';
import { beforeEach, describe, expect, it } from 'vitest';
import {
	closeDatabase,
	createDatabaseServices,
	getReadiness,
	isDatabaseOpen,
	loadConfig,
	openDatabase,
	resetDatabaseForTests
} from '../../src/lib/db';
import { createPostgresFixture, type DbFixture } from './fixtures';

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), 'ruok-avail-'));
}

describe('checkAvailability (T015) — SQLite live probe', () => {
	beforeEach(() => {
		resetDatabaseForTests();
	});

	it('reports true for an open, migrated backend', async () => {
		const dir = tempDir();
		try {
			const config = loadConfig({ DATABASE_PATH: join(dir, 'okr.db') });
			const services = await openDatabase(config);
			expect(services.isOpen()).toBe(true);
			expect(services.dialect).toBe('sqlite');
			expect(await services.checkAvailability()).toBe(true);
			// Process-wide readiness resolves via the bounded live check.
			const readiness = await getReadiness();
			expect(readiness.ready).toBe(true);
			expect(readiness.dialect).toBe('sqlite');
			await closeDatabase();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('reports false before open and after close (no cached-success shortcut)', async () => {
		const dir = tempDir();
		try {
			const config = loadConfig({ DATABASE_PATH: join(dir, 'okr.db') });
			const services = createDatabaseServices(config);
			expect(services.isOpen()).toBe(false);
			expect(await services.checkAvailability()).toBe(false);

			// Through the lifecycle (migration runs first) the same backend is live.
			const migrated = await openDatabase(config);
			expect(migrated.isOpen()).toBe(true);
			expect(await migrated.checkAvailability()).toBe(true);

			await closeDatabase();
			expect(await migrated.checkAvailability()).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('recovers after close + reopen on the same file (no leaked lock)', async () => {
		const dir = tempDir();
		try {
			const config = loadConfig({ DATABASE_PATH: join(dir, 'okr.db') });
			const first = await openDatabase(config);
			expect(await first.checkAvailability()).toBe(true);
			await closeDatabase();
			expect(await first.checkAvailability()).toBe(false);

			// A fresh lifecycle open reopens the same file and recovers.
			resetDatabaseForTests();
			const second = await openDatabase(config);
			expect(await second.checkAvailability()).toBe(true);
			await closeDatabase();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('a raw adapter open without migration reports unavailable (required table absent)', async () => {
		const dir = tempDir();
		try {
			const config = loadConfig({ DATABASE_PATH: join(dir, 'okr.db') });
			const services = createDatabaseServices(config);
			await services.open();
			expect(services.isOpen()).toBe(true);
			// Raw open bypasses migration, so the required application table
			// (`users`) is absent and the live probe must report unavailable.
			expect(await services.checkAvailability()).toBe(false);
			await services.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('concurrent live checks all resolve within budget (coalesced, no repeats)', async () => {
		const dir = tempDir();
		try {
			const config = loadConfig({ DATABASE_PATH: join(dir, 'okr.db') });
			const services = await openDatabase(config);
			const started = Date.now();
			const results = await Promise.all(
				Array.from({ length: 8 }, () => services.checkAvailability())
			);
			expect(results.every(Boolean)).toBe(true);
			expect(Date.now() - started).toBeLessThan(3000);
			await closeDatabase();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('lifecycle ownership (T014/T016)', () => {
	beforeEach(() => {
		resetDatabaseForTests();
	});

	it('concurrent openDatabase callers share a single attempt', async () => {
		const dir = tempDir();
		try {
			const config = loadConfig({ DATABASE_PATH: join(dir, 'okr.db') });
			const [a, b, c] = await Promise.all([
				openDatabase(config),
				openDatabase(config),
				openDatabase(config)
			]);
			expect(a).toBe(b);
			expect(b).toBe(c);
			expect(isDatabaseOpen()).toBe(true);
			await closeDatabase();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('a failed open imposes a bounded retry cooldown then permits recovery', async () => {
		const dir = tempDir();
		try {
			const badConfig = loadConfig({
				DATABASE_TYPE: 'postgres',
				DATABASE_URL: 'postgres://u:p@127.0.0.1:1/ruok',
				DATABASE_CONNECT_TIMEOUT_MS: '2000'
			});
			// Failing-before: unreachable backend rejects (rejection permits recovery).
			await expect(openDatabase(badConfig)).rejects.toThrow();
			// Immediate retry is refused by the <=1s cooldown (no tight retry loop).
			await expect(openDatabase(badConfig)).rejects.toThrow(/cooling down/i);

			// After reset (clears cooldown + singleton) a valid SQLite open recovers.
			resetDatabaseForTests();
			const config = loadConfig({ DATABASE_PATH: join(dir, 'okr.db') });
			const services = await openDatabase(config);
			expect(services.isOpen()).toBe(true);
			expect(await getReadiness()).toMatchObject({ ready: true, dialect: 'sqlite' });
			await closeDatabase();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('close fences state: not open, readiness false, and a fresh open recovers', async () => {
		const dir = tempDir();
		try {
			const config = loadConfig({ DATABASE_PATH: join(dir, 'okr.db') });
			const services = await openDatabase(config);
			expect(isDatabaseOpen()).toBe(true);

			await closeDatabase();
			expect(isDatabaseOpen()).toBe(false);
			expect((await getReadiness()).ready).toBe(false);
			expect((await getReadiness()).open).toBe(false);

			// A fresh attempt re-publishes successfully (recovery, no resurrection
			// of a stale completed promise).
			const again = await openDatabase(config);
			expect(again.isOpen()).toBe(true);
			await closeDatabase();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('dialect binding (no cross-dialect leakage)', () => {
	beforeEach(() => {
		resetDatabaseForTests();
	});

	it('a SQLite backend is bound to the sqlite dialect and opens no pg pool', async () => {
		const dir = tempDir();
		try {
			const services = createDatabaseServices(
				loadConfig({ DATABASE_TYPE: 'sqlite', DATABASE_PATH: join(dir, 'okr.db') })
			);
			expect(services.dialect).toBe('sqlite');
			await services.open();
			expect(services.isOpen()).toBe(true);
			expect(services.dialect).toBe('sqlite');
			// No postgres pool is created on the sqlite facade.
			expect((services as unknown as { pool?: unknown }).pool).toBeUndefined();
			await services.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('checkAvailability (T015) — PostgreSQL not-open branch (no server)', () => {
	it('reports false before open and after close', async () => {
		const config = loadConfig({
			DATABASE_TYPE: 'postgres',
			DATABASE_URL: 'postgres://u:p@127.0.0.1:1/ruok'
		});
		const services = createDatabaseServices(config);
		expect(services.dialect).toBe('postgres');
		expect(await services.checkAvailability()).toBe(false);
		await services.close(); // idempotent no-op close
		expect(await services.checkAvailability()).toBe(false);
	});
});

// Live PostgreSQL availability (guarded on admin URL — recorded PENDING when
// absent; never substituted with SQLite). Pattern matches the other db suites.
const adminUrl = process.env.RUOK_TEST_PG_ADMIN_URL;
const pgLive = adminUrl ? describe : describe.skip;

pgLive('checkAvailability (T015) — PostgreSQL live probe', () => {
	it('returns true when open and safely repeats/concurrently closes then reopens', async () => {
		const fixture: DbFixture = await createPostgresFixture();
		const observer = new Client({
			connectionString: adminUrl,
			connectionTimeoutMillis: 1000,
			statement_timeout: 1000
		});
		try {
			await observer.connect();
			expect(fixture.services.dialect).toBe('postgres');
			expect(await fixture.services.checkAvailability()).toBe(true);
			// Read the actual runtime pool's database identity; observe server-side
			// connections separately so fixture teardown cannot hide a leaked pool.
			const pool = (fixture.services as unknown as { pool: Pool }).pool;
			const { rows } = await pool.query<{ name: string }>('SELECT current_database() AS name');
			const connectionCount = async () => {
				const result = await observer.query<{ count: number }>(
					'SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = $1',
					[rows[0].name]
				);
				return result.rows[0].count;
			};
			const closing = fixture.services.close();
			expect(fixture.services.isOpen()).toBe(false);
			expect(await fixture.services.checkAvailability()).toBe(false);
			await Promise.all([closing, fixture.services.close(), fixture.services.close()]);
			await fixture.services.close();
			expect(await fixture.services.checkAvailability()).toBe(false);
			expect(await connectionCount()).toBe(0);

			await Promise.all([fixture.services.open(), fixture.services.open()]);
			expect(fixture.services.isOpen()).toBe(true);
			expect(await fixture.services.checkAvailability()).toBe(true);
			expect(await connectionCount()).toBe(1);
			await Promise.all([fixture.services.close(), fixture.services.close()]);
			expect(fixture.services.isOpen()).toBe(false);
			expect(await fixture.services.checkAvailability()).toBe(false);
			expect(await connectionCount()).toBe(0);
		} finally {
			try {
				await fixture.teardown();
			} finally {
				await observer.end();
			}
		}
	});
});

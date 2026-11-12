/**
 * WP10 — SQLite execution isolation through the REAL lifecycle path (Issue 2).
 *
 * Exercises the production `openDatabase`/startup path with a SQLite backend and
 * proves the isolation contract holds end-to-end:
 *   - migration/verification runs in the preparation worker, never on the
 *     HTTP/main thread;
 *   - the better-sqlite3 driver is never imported on the main thread. If a
 *     regression routes migration back through `migrateDatabase` on the calling
 *     thread, importing the driver on the main thread throws and fails the test;
 *   - readiness reports open AND migrated, and the DB file is actually created.
 *
 * This complements the facade-level suites (`sqlite-worker.test.ts`), which
 * drive `runSqlitePreparation` + `SqliteDatabaseServices.open()` directly and
 * therefore cannot catch a lifecycle that bypasses the worker.
 */
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The SQLite driver must NEVER load on the main/HTTP thread. If the lifecycle
// regresses and imports better-sqlite3 on the calling thread (e.g. via a direct
// migrateDatabase call), this mock throws and the test fails. The worker threads
// run in a separate Node thread and load the real driver, so they are unaffected.
vi.mock('better-sqlite3', () => {
	throw new Error('better-sqlite3 must not be imported on the main thread (WP10 isolation)');
});

import { closeDatabase, getReadiness, openDatabase, resetDatabaseForTests } from '../../src/lib/db';

function tempDb(): { dir: string; path: string } {
	const dir = mkdtempSync(join(tmpdir(), 'ruok-wp10-lifecycle-'));
	return { dir, path: join(dir, 'okr.db') };
}

describe('WP10 lifecycle isolation through the real openDatabase path', () => {
	beforeEach(() => {
		resetDatabaseForTests();
	});

	it('openDatabase migrates SQLite in the worker (no main-thread driver) and reports ready', async () => {
		const { dir, path } = tempDb();
		try {
			expect(existsSync(path)).toBe(false);

			const services = await openDatabase({
				type: 'sqlite',
				path,
				journalMode: 'wal',
				busyTimeoutMs: 5000
			});

			// Driver never imported on the main thread; migration ran in the worker.
			const readiness = await getReadiness();
			expect(readiness.ready).toBe(true);
			expect(readiness.dialect).toBe('sqlite');
			expect(readiness.schemaVersion).toBeGreaterThan(0);
			expect(existsSync(path)).toBe(true);

			expect(services.isOpen()).toBe(true);
			await services.close();
			expect(services.isOpen()).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('openDatabase is idempotent and readiness stays true while open', async () => {
		const { dir, path } = tempDb();
		try {
			await openDatabase({ type: 'sqlite', path, journalMode: 'wal', busyTimeoutMs: 5000 });
			// Second call reuses the singleton; no re-migration on the main thread.
			const services = await openDatabase({
				type: 'sqlite',
				path,
				journalMode: 'wal',
				busyTimeoutMs: 5000
			});
			expect(services.isOpen()).toBe(true);
			expect((await getReadiness()).ready).toBe(true);
			await closeDatabase();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
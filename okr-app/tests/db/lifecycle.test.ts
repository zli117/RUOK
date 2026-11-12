/**
 * T007 lifecycle tests: lazy factory, readiness state, adapter lifecycle and
 * shutdown, and "no SQLite file in PostgreSQL mode". These run without a live
 * PostgreSQL service (the pool TLS/readiness path is covered by CI); the
 * SQLite lifecycle is exercised against a real temp file.
 */
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
	closeDatabase,
	createDatabaseServices,
	getDatabaseServices,
	isDatabaseOpen,
	loadConfig,
	openDatabase,
	resetDatabaseForTests
} from '../../src/lib/db';

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), 'ruok-lifecycle-'));
}

describe('lazy factory and sqlite lifecycle (T007)', () => {
	it('does not open or create a SQLite file until open() is called', async () => {
		const dir = tempDir();
		const path = join(dir, 'okr.db');
		try {
			const config = loadConfig({ DATABASE_PATH: path });
			expect(config.type).toBe('sqlite');
			const services = createDatabaseServices(config);
			// No connection side effect from construction.
			expect(existsSync(path)).toBe(false);
			expect(services.isOpen()).toBe(false);

			await services.open();
			expect(services.isOpen()).toBe(true);
			expect(existsSync(path)).toBe(true);

			await services.close();
			expect(services.isOpen()).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('open() and close() are idempotent', async () => {
		const dir = tempDir();
		try {
			const services = createDatabaseServices(
				loadConfig({ DATABASE_PATH: join(dir, 'okr.db') })
			);
			await services.open();
			await services.open();
			expect(services.isOpen()).toBe(true);

			await services.close();
			await services.close();
			expect(services.isOpen()).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('close() releases the file so a new adapter can reopen it (shutdown)', async () => {
		const dir = tempDir();
		const path = join(dir, 'okr.db');
		try {
			const first = createDatabaseServices(loadConfig({ DATABASE_PATH: path }));
			await first.open();
			await first.close();

			// No lingering lock: a fresh adapter can reopen the same file.
			const second = createDatabaseServices(loadConfig({ DATABASE_PATH: path }));
			await second.open();
			expect(second.isOpen()).toBe(true);
			await second.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('no SQLite file in PostgreSQL mode (T007)', () => {
	it('constructing a postgres backend never creates the DATABASE_PATH file/dirs', () => {
		const dir = tempDir();
		const sqlitePath = join(dir, 'data', 'okr.db');
		try {
			const config = loadConfig({
				DATABASE_TYPE: 'postgres',
				DATABASE_URL: 'postgres://u:p@h:5432/db',
				// Deliberately points at a SQLite path; it must be ignored.
				DATABASE_PATH: sqlitePath
			});
			expect(config.type).toBe('postgres');
			// Constructing the factory performs no I/O.
			const services = createDatabaseServices(config);
			expect(services.dialect).toBe('postgres');
			expect(existsSync(sqlitePath)).toBe(false);
			expect(existsSync(join(dir, 'data'))).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('process-wide lifecycle singleton (T007)', () => {
	beforeEach(() => {
		resetDatabaseForTests();
	});

	it('opens, tracks readiness and closes the process-wide backend', async () => {
		const dir = tempDir();
		try {
			const config = loadConfig({ DATABASE_PATH: join(dir, 'okr.db') });
			expect(isDatabaseOpen()).toBe(false);

			const services = await openDatabase(config);
			expect(isDatabaseOpen()).toBe(true);
			expect(services.isOpen()).toBe(true);

			await closeDatabase();
			expect(isDatabaseOpen()).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('returns a single shared instance for repeated getDatabaseServices calls', async () => {
		const dir = tempDir();
		try {
			const config = loadConfig({ DATABASE_PATH: join(dir, 'okr.db') });
			const a = getDatabaseServices(config);
			const b = getDatabaseServices();
			expect(a).toBe(b);
			await a.open();
			await closeDatabase();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('resets the singleton for test isolation', async () => {
		const dir = tempDir();
		try {
			const config = loadConfig({ DATABASE_PATH: join(dir, 'okr.db') });
			const first = getDatabaseServices(config);
			await first.open();
			await closeDatabase();
			resetDatabaseForTests();
			const second = getDatabaseServices(config);
			expect(second).not.toBe(first);
			await second.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
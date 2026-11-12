/**
 * FR-001 / FR-009 / FR-010 config validation tests.
 *
 * `loadConfig` is the single place an environment maps to a validated
 * {@link DatabaseConfig}. These tests pin behavior: DATABASE_TYPE defaults to
 * `sqlite` with the default `data/okr.db` path; only `sqlite`/`postgres` are
 * accepted; `postgres` requires DATABASE_URL; there is never a silent backend
 * fallback; pool/timeouts, journal mode and TLS settings are validated; DSNs
 * are redacted; and DATABASE_PATH is ignored in PostgreSQL mode.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
	buildPostgresPoolConfig,
	buildSqlitePragmas,
	loadConfig,
	redactConfig,
	redactConnectionString,
	sanitizePostgresConnectionString
} from '../../src/lib/db';
import type { PostgresConfig, SqliteConfig } from '../../src/lib/db/contracts';

function sqliteCfg(env: Record<string, string | undefined> = {}): SqliteConfig {
	const cfg = loadConfig(env);
	if (cfg.type !== 'sqlite') throw new Error('expected sqlite config');
	return cfg;
}

function postgresCfg(env: Record<string, string | undefined> = {}): PostgresConfig {
	const cfg = loadConfig(env);
	if (cfg.type !== 'postgres') throw new Error('expected postgres config');
	return cfg;
}

function sqliteExpected(over: Record<string, unknown> = {}): Record<string, unknown> {
	return { type: 'sqlite', path: 'data/okr.db', journalMode: 'wal', busyTimeoutMs: 5000, ...over };
}

describe('loadConfig (FR-001)', () => {
	it('defaults to sqlite with the default data/okr.db path when DATABASE_TYPE is omitted', () => {
		expect(loadConfig({})).toEqual(sqliteExpected());
	});

	it('honours an explicit sqlite type and DATABASE_PATH', () => {
		expect(loadConfig({ DATABASE_TYPE: 'sqlite', DATABASE_PATH: '/tmp/custom.db' })).toEqual(
			sqliteExpected({ path: '/tmp/custom.db' })
		);
	});

	it('normalizes DATABASE_TYPE to trimmed lowercase', () => {
		expect(loadConfig({ DATABASE_TYPE: '  SQLITE  ' })).toEqual(sqliteExpected());
	});

	it('throws when DATABASE_TYPE=postgres and DATABASE_URL is missing', () => {
		expect(() => loadConfig({ DATABASE_TYPE: 'postgres' })).toThrow(/DATABASE_URL/);
	});

	it('returns a postgres config when DATABASE_URL is set', () => {
		const cfg = postgresCfg({
			DATABASE_TYPE: 'postgres',
			DATABASE_URL: 'postgres://user:pass@localhost:5432/okr'
		});
		expect(cfg.connectionString).toBe('postgres://user:pass@localhost:5432/okr');
		expect(cfg.poolMax).toBe(5);
		expect(cfg.connectTimeoutMs).toBe(10000);
		expect(cfg.statementTimeoutMs).toBe(30000);
		expect(cfg.sslMode).toBe('disable');
	});

	it('rejects an unsupported DATABASE_TYPE', () => {
		expect(() => loadConfig({ DATABASE_TYPE: 'mysql' })).toThrow(/Unsupported DATABASE_TYPE/);
		expect(() => loadConfig({ DATABASE_TYPE: '' })).toThrow(/Unsupported DATABASE_TYPE/);
	});

	it('ignores DATABASE_PATH in postgres mode (legacy Docker setting)', () => {
		const cfg = postgresCfg({
			DATABASE_TYPE: 'postgres',
			DATABASE_URL: 'postgres://u:p@h:5432/db',
			DATABASE_PATH: '/some/sqlite/file.db'
		});
		expect(cfg.connectionString).toBe('postgres://u:p@h:5432/db');
		// No SQLite path field leaks into a postgres config.
		expect('path' in cfg).toBe(false);
	});

	describe('bounded pool / connect-timeout / statement-timeout (FR-009)', () => {
		const base = { DATABASE_TYPE: 'postgres', DATABASE_URL: 'postgres://u:p@h:5432/db' };

		it('accepts valid positive-integer bounds', () => {
			const cfg = postgresCfg({
				...base,
				DATABASE_POOL_MAX: '20',
				DATABASE_CONNECT_TIMEOUT_MS: '5000',
				DATABASE_STATEMENT_TIMEOUT_MS: '15000'
			});
			expect(cfg.poolMax).toBe(20);
			expect(cfg.connectTimeoutMs).toBe(5000);
			expect(cfg.statementTimeoutMs).toBe(15000);
		});

		it.each([
			['DATABASE_POOL_MAX', '0'],
			['DATABASE_POOL_MAX', '-3'],
			['DATABASE_POOL_MAX', '1.5'],
			['DATABASE_POOL_MAX', 'abc'],
			['DATABASE_CONNECT_TIMEOUT_MS', '0'],
			['DATABASE_CONNECT_TIMEOUT_MS', '-1'],
			['DATABASE_CONNECT_TIMEOUT_MS', 'nan'],
			['DATABASE_STATEMENT_TIMEOUT_MS', '0'],
			['DATABASE_STATEMENT_TIMEOUT_MS', '-5']
		])('rejects invalid %s value %j', (key, value) => {
			expect(() => loadConfig({ ...base, [key]: value })).toThrow(/Invalid positive integer/);
		});
	});

	describe('sqlite journal mode and busy timeout (FR-010)', () => {
		it('defaults journal mode to wal', () => {
			expect(sqliteCfg({}).journalMode).toBe('wal');
		});

		it('accepts an explicit delete journal mode', () => {
			expect(sqliteCfg({ SQLITE_JOURNAL_MODE: 'DELETE' }).journalMode).toBe('delete');
		});

		it('rejects an unsupported journal mode', () => {
			expect(() => loadConfig({ SQLITE_JOURNAL_MODE: 'truncate' })).toThrow(
				/Invalid SQLITE_JOURNAL_MODE/
			);
		});

		it('accepts a non-negative busy timeout and rejects negative/non-integer', () => {
			expect(sqliteCfg({ SQLITE_BUSY_TIMEOUT_MS: '0' }).busyTimeoutMs).toBe(0);
			expect(sqliteCfg({ SQLITE_BUSY_TIMEOUT_MS: '2500' }).busyTimeoutMs).toBe(2500);
			expect(() => loadConfig({ SQLITE_BUSY_TIMEOUT_MS: '-1' })).toThrow(
				/Invalid non-negative integer/
			);
			expect(() => loadConfig({ SQLITE_BUSY_TIMEOUT_MS: '1.5' })).toThrow(
				/Invalid non-negative integer/
			);
		});
	});

	describe('TLS validation (FR-009)', () => {
		const base = { DATABASE_TYPE: 'postgres', DATABASE_URL: 'postgres://u:p@h:5432/db' };

		it('defaults to disable when no TLS hint is present', () => {
			expect(postgresCfg(base).sslMode).toBe('disable');
		});

		it('accepts an explicit verify-full mode', () => {
			expect(postgresCfg({ ...base, DATABASE_SSL_MODE: 'verify-full' }).sslMode).toBe(
				'verify-full'
			);
		});

		it('defaults to verify-full when a CA file is provided', () => {
			const cfg = postgresCfg({ ...base, DATABASE_SSL_CA_FILE: '/secrets/ca.pem' });
			expect(cfg.sslMode).toBe('verify-full');
			expect(cfg.sslCaFile).toBe('/secrets/ca.pem');
		});

		it('rejects an invalid DATABASE_SSL_MODE', () => {
			expect(() => loadConfig({ ...base, DATABASE_SSL_MODE: 'require' })).toThrow(
				/Invalid DATABASE_SSL_MODE/
			);
		});

		it('rejects a CA file combined with an explicit disable (never silently disable)', () => {
			expect(() =>
				loadConfig({
					...base,
					DATABASE_SSL_MODE: 'disable',
					DATABASE_SSL_CA_FILE: '/secrets/ca.pem'
				})
			).toThrow(/CA file/);
		});

		it('maps a verifying URL sslmode to verify-full', () => {
			const cfg = postgresCfg({
				DATABASE_TYPE: 'postgres',
				DATABASE_URL: 'postgres://u:p@h:5432/db?sslmode=verify-full'
			});
			expect(cfg.sslMode).toBe('verify-full');
		});

		it('rejects an explicit disable conflicting with a verifying URL sslmode', () => {
			expect(() =>
				loadConfig({
					...base,
					DATABASE_URL: 'postgres://u:p@h:5432/db?sslmode=require',
					DATABASE_SSL_MODE: 'disable'
				})
			).toThrow(/silently disable TLS verification/);
		});
	});

	describe('URL TLS controls (DRIFT-1)', () => {
		const base = { DATABASE_TYPE: 'postgres', DATABASE_URL: 'postgres://u:p@h:5432/db' };

		it('rejects a duplicate sslmode control in the connection URL', () => {
			expect(() =>
				loadConfig({
					...base,
					DATABASE_URL: 'postgres://u:p@h:5432/db?sslmode=require&sslmode=verify-full'
				})
			).toThrow(/Duplicate TLS control 'sslmode'/);
		});

		it('rejects an unknown/unsupported sslmode value (no-verify would weaken TLS)', () => {
			expect(() =>
				loadConfig({
					...base,
					DATABASE_URL: 'postgres://u:p@h:5432/db?sslmode=no-verify'
				})
			).toThrow(/Unsupported TLS sslmode 'no-verify'/);
			expect(() =>
				loadConfig({
					...base,
					DATABASE_URL: 'postgres://u:p@h:5432/db?sslmode=prefer'
				})
			).toThrow(/Unsupported TLS sslmode 'prefer'/);
		});

		it.each([
			['ssl', '?ssl=no-verify'],
			['sslcert', '?sslcert=/x.pem'],
			['sslkey', '?sslkey=/x.key'],
			['sslrootcert', '?sslrootcert=/x.pem'],
			['sslnegotiation', '?sslnegotiation=direct']
		])('rejects unsupported URL TLS control %s', (key, query) => {
			expect(() => loadConfig({ ...base, DATABASE_URL: `postgres://u:p@h:5432/db${query}` })).toThrow(
				/Unsupported TLS control/
			);
		});

		it('maps accepted verifying URL modes (require/verify-ca/verify-full) to verify-full', () => {
			for (const mode of ['require', 'verify-ca', 'verify-full']) {
				const cfg = postgresCfg({
					...base,
					DATABASE_URL: `postgres://u:p@h:5432/db?sslmode=${mode}`
				});
				expect(cfg.sslMode).toBe('verify-full');
			}
		});

		it('sanitizes TLS controls from the connection string while preserving other params', () => {
			const cleaned = sanitizePostgresConnectionString(
				'postgres://u:p@h:5432/db?sslmode=require&application_name=okr&foo=bar'
			);
			expect(cleaned).not.toContain('sslmode');
			expect(cleaned).toContain('application_name=okr');
			expect(cleaned).toContain('foo=bar');
		});
	});
});

describe('secret redaction (FR-009)', () => {
	it('redacts the password in a connection URL', () => {
		const redacted = redactConnectionString('postgres://alice:s3cret@db.example:5432/okr');
		expect(redacted).not.toContain('s3cret');
		expect(redacted).toContain('***');
	});

	it('redacts the username when no password is present', () => {
		const redacted = redactConnectionString('postgres://alice@db.example:5432/okr');
		expect(redacted).not.toContain('alice');
		expect(redacted).toContain('***');
	});

	it('returns a safe marker for an unparseable URL', () => {
		expect(redactConnectionString('not-a-url')).toBe('<unparseable-redacted>');
	});

	it('redactConfig never exposes the connection string or CA body', () => {
		const cfg = postgresCfg({
			DATABASE_TYPE: 'postgres',
			DATABASE_URL: 'postgres://u:s3cret@h:5432/db',
			DATABASE_SSL_MODE: 'verify-full',
			DATABASE_SSL_CA_FILE: '/secrets/ca.pem'
		});
		const json = JSON.stringify(redactConfig(cfg));
		expect(json).not.toContain('s3cret');
		expect(json).not.toContain('/secrets/ca.pem');
	});
});

describe('adapter-facing config builders', () => {
	it('builds sqlite pragmas from validated config (FK + busy timeout + journal)', () => {
		const cfg = sqliteCfg({ SQLITE_BUSY_TIMEOUT_MS: '2500', SQLITE_JOURNAL_MODE: 'delete' });
		const pragmas = buildSqlitePragmas(cfg);
		// Matches the better-sqlite3 `.pragma()` API (no `PRAGMA` keyword prefix).
		expect(pragmas).toContain('journal_mode = delete');
		expect(pragmas).toContain('foreign_keys = ON');
		expect(pragmas).toContain('busy_timeout = 2500');
	});

	it('builds a disabled-TLS pool config with bounded settings', () => {
		const cfg = postgresCfg({ DATABASE_TYPE: 'postgres', DATABASE_URL: 'postgres://u:p@h:5432/db' });
		const pool = buildPostgresPoolConfig(cfg);
		expect(pool.max).toBe(5);
		expect(pool.connectionTimeoutMillis).toBe(10000);
		expect(pool.statement_timeout).toBe(30000);
		expect(pool.ssl).toBe(false);
	});

	it('builds a verified-TLS pool config that loads the CA file without erasing settings', () => {
		const dir = mkdtempSync(join(tmpdir(), 'ruok-ca-'));
		const caPath = join(dir, 'ca.pem');
		writeFileSync(caPath, '-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n');
		try {
			const cfg = postgresCfg({
				DATABASE_TYPE: 'postgres',
				DATABASE_URL: 'postgres://u:p@h:5432/db',
				DATABASE_SSL_MODE: 'verify-full',
				DATABASE_SSL_CA_FILE: caPath
			});
			const pool = buildPostgresPoolConfig(cfg);
			expect(pool.ssl).toEqual({
				rejectUnauthorized: true,
				ca: '-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n'
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('strips URL TLS controls from the connection string handed to pg (DRIFT-1)', () => {
		const cfg = postgresCfg({
			DATABASE_TYPE: 'postgres',
			DATABASE_URL: 'postgres://u:p@h:5432/db?sslmode=verify-full&application_name=okr',
			DATABASE_SSL_MODE: 'verify-full'
		});
		const pool = buildPostgresPoolConfig(cfg);
		expect(pool.connectionString).toBe('postgres://u:p@h:5432/db?application_name=okr');
		expect(pool.connectionString).not.toContain('sslmode');
	});

	it('preserves unrelated URL parameters after sanitizing the connection string', () => {
		const cleaned = sanitizePostgresConnectionString(
			'postgres://u:p@h:5432/db?sslmode=require&sslcert=/x&target_session_attrs=read-write&options=-cfoo'
		);
		expect(cleaned).not.toContain('sslmode');
		expect(cleaned).not.toContain('sslcert');
		expect(cleaned).toContain('target_session_attrs=read-write');
		expect(cleaned).toContain('options=-cfoo');
	});
});
/**
 * WP01 — Enforce effective PostgreSQL TLS (FR-001 / DRIFT-1).
 *
 * T001  Baseline + effective pg settings matrix: exercises the ACTUAL
 *       pg-connection-string parser / pg Client to reproduce the DRIFT-1
 *       defect (a URL SSL control overriding the explicit ssl object and
 *       dropping the CA / disabling verification) and prove the fixed builder
 *       keeps `rejectUnauthorized` and the CA through the real parser.
 * T002  Canonical policy unit checks (reject duplicate/unknown/contradictory
 *       URL controls before connect; sanitized URL handed to pg).
 * T003  Real PostgreSQL TLS endpoint tests (opt-in via `RUOK_TEST_LIVE_TLS=1`
 *       and Docker): trusted CA succeeds; untrusted CA and hostname mismatch
 *       fail without plaintext fallback, via both the runtime pool and the
 *       migration Client builders.
 *
 * Live tests fail as a missing prerequisite (never silently skip) when Docker
 * or the pinned image is absent (NFR-001 / C-007).
 */
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, type ClientConfig, Pool } from 'pg';
import {
	buildPostgresPoolConfig,
	loadConfig,
	sanitizePostgresConnectionString
} from '../../src/lib/db';
import { createPostgresMigrationClient } from '../../src/lib/db/migrations';
import type { PostgresConfig } from '../../src/lib/db/contracts';
import {
	dockerAvailable,
	disposeTls,
	generateTestTls,
	opensslAvailable,
	startTlsPostgres,
	type TlsMaterial
} from './tls-fixtures';

const CA_BODY = '-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n';

/** The `ssl` object the real pg Client ends up with after parsing. */
function effectiveSsl(config: ClientConfig): unknown {
	const client = new Client(config);
	return (client as unknown as { connectionParameters: { ssl: unknown } }).connectionParameters.ssl;
}

function pgConfig(over: Record<string, string | undefined>): PostgresConfig {
	const cfg = loadConfig({ DATABASE_TYPE: 'postgres', ...over });
	if (cfg.type !== 'postgres') throw new Error('expected postgres config');
	return cfg;
}

describe('T001 parser baseline (DRIFT-1 reproduction through the real pg parser)', () => {
	it('reproduces DRIFT-1: raw URL sslmode=no-verify overrides explicit ssl to disable verification', () => {
		const ssl = effectiveSsl({
			connectionString: 'postgres://u:p@h:5432/db?sslmode=no-verify',
			ssl: { rejectUnauthorized: true, ca: CA_BODY }
		});
		expect(ssl).toEqual({ rejectUnauthorized: false });
	});

	it('reproduces DRIFT-1: raw URL sslmode=require silently drops the explicit CA', () => {
		const ssl = effectiveSsl({
			connectionString: 'postgres://u:p@h:5432/db?sslmode=require',
			ssl: { rejectUnauthorized: true, ca: CA_BODY }
		});
		expect(ssl).toEqual({});
	});

	it('reproduces DRIFT-1: raw URL sslmode=disable downgrades to plaintext', () => {
		const ssl = effectiveSsl({
			connectionString: 'postgres://u:p@h:5432/db?sslmode=disable',
			ssl: { rejectUnauthorized: true, ca: CA_BODY }
		});
		expect(ssl).toBe(false);
	});
});

describe('T002 canonical TLS policy (effective pg Client retains verification + CA)', () => {
	const base = 'postgres://u:p@h:5432/db';

	it('disabled TLS yields ssl=false with no URL hint', () => {
		const pool = buildPostgresPoolConfig(pgConfig({ DATABASE_URL: base }));
		expect(effectiveSsl(pool)).toBe(false);
	});

	it('verify-full with a custom CA keeps rejectUnauthorized and the CA through the real parser', () => {
		const dir = mkdtempSync(join(tmpdir(), 'ruok-ca-'));
		const caPath = join(dir, 'ca.pem');
		writeFileSync(caPath, CA_BODY);
		try {
			const cfg = pgConfig({
				DATABASE_URL: base,
				DATABASE_SSL_MODE: 'verify-full',
				DATABASE_SSL_CA_FILE: caPath
			});
			const pool = buildPostgresPoolConfig(cfg);
			// The builder sanitized the URL so the parser cannot override ssl.
			expect(pool.connectionString).not.toContain('sslmode');
			expect(effectiveSsl(pool)).toEqual({ rejectUnauthorized: true, ca: CA_BODY });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('a verifying URL sslmode is consumed and normalized, and the CA still survives', () => {
		const dir = mkdtempSync(join(tmpdir(), 'ruok-ca-'));
		const caPath = join(dir, 'ca.pem');
		writeFileSync(caPath, CA_BODY);
		try {
			for (const mode of ['require', 'verify-ca', 'verify-full']) {
				const cfg = pgConfig({
					DATABASE_URL: `${base}?sslmode=${mode}`,
					DATABASE_SSL_MODE: 'verify-full',
					DATABASE_SSL_CA_FILE: caPath
				});
				expect(cfg.sslMode).toBe('verify-full');
				const pool = buildPostgresPoolConfig(cfg);
				expect(pool.connectionString).not.toContain('sslmode');
				expect(effectiveSsl(pool)).toEqual({ rejectUnauthorized: true, ca: CA_BODY });
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('migration Client shares the same sanitized builder (same effective ssl)', () => {
		const dir = mkdtempSync(join(tmpdir(), 'ruok-ca-'));
		const caPath = join(dir, 'ca.pem');
		writeFileSync(caPath, CA_BODY);
		try {
			const cfg = pgConfig({
				DATABASE_URL: `${base}?sslmode=require`,
				DATABASE_SSL_MODE: 'verify-full',
				DATABASE_SSL_CA_FILE: caPath
			});
			const migrationClient = createPostgresMigrationClient(cfg);
			const params = (migrationClient as unknown as { connectionParameters: { ssl: unknown } })
				.connectionParameters;
			expect(params.ssl).toEqual({ rejectUnauthorized: true, ca: CA_BODY });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('rejects duplicate/unknown/unsupported URL TLS controls before connect', () => {
		expect(() =>
			pgConfig({ DATABASE_URL: `${base}?sslmode=require&sslmode=verify-full` })
		).toThrow(/Duplicate TLS control/);
		expect(() => pgConfig({ DATABASE_URL: `${base}?sslmode=no-verify` })).toThrow(
			/Unsupported TLS sslmode/
		);
		expect(() => pgConfig({ DATABASE_URL: `${base}?ssl=no-verify` })).toThrow(
			/Unsupported TLS control/
		);
		expect(() => pgConfig({ DATABASE_URL: `${base}?sslrootcert=/x.pem` })).toThrow(
			/Unsupported TLS control/
		);
	});

	it('sanitizePostgresConnectionString removes all SSL controls and preserves other params', () => {
		const cleaned = sanitizePostgresConnectionString(
			'postgres://u:p@h:5432/db?sslmode=require&ssl=no-verify&sslcert=/a&sslkey=/b&sslrootcert=/c&sslnegotiation=direct&application_name=okr&foo=bar'
		);
		for (const k of ['sslmode', 'ssl', 'sslcert', 'sslkey', 'sslrootcert', 'sslnegotiation']) {
			expect(cleaned).not.toContain(`${k}=`);
		}
		expect(cleaned).toContain('application_name=okr');
		expect(cleaned).toContain('foo=bar');
	});
});

// ---------------------------------------------------------------------------
// T003 — Real PostgreSQL TLS endpoints (opt-in: RUOK_TEST_LIVE_TLS=1)
// ---------------------------------------------------------------------------

const runLive =
	process.env.RUOK_TEST_LIVE_TLS === '1' && (dockerAvailable() || opensslAvailable());

describe.runIf(runLive)('T003 real PostgreSQL TLS endpoint (trusted / untrusted CA / hostname mismatch)', () => {
	// A trusted server whose cert (signed by CA_A) covers localhost + 127.0.0.1.
	let trusted:
		| { material: TlsMaterial; endpoint: Awaited<ReturnType<typeof startTlsPostgres>> }
		| undefined;
	// A server whose cert (also signed by CA_A) omits IP:127.0.0.1, forcing a
	// hostname mismatch when we connect to 127.0.0.1.
	let mismatch:
		| { material: TlsMaterial; endpoint: Awaited<ReturnType<typeof startTlsPostgres>> }
		| undefined;
	// An unrelated CA that did not sign the server cert (for untrusted-CA checks).
	let foreignCa: TlsMaterial | undefined;

	beforeAll(async () => {
		if (!dockerAvailable()) {
			throw new Error('Missing prerequisite for live TLS: Docker daemon is not reachable.');
		}
		if (!opensslAvailable()) {
			throw new Error('Missing prerequisite for live TLS: openssl is not available on PATH.');
		}
		const trustedMaterial = generateTestTls(['DNS:localhost', 'IP:127.0.0.1']);
		trusted = { material: trustedMaterial, endpoint: await startTlsPostgres(trustedMaterial) };
		const mismatchMaterial = generateTestTls(['DNS:localhost']);
		mismatch = { material: mismatchMaterial, endpoint: await startTlsPostgres(mismatchMaterial) };
		foreignCa = generateTestTls(['DNS:localhost', 'IP:127.0.0.1']);
	}, 120_000);

	afterAll(async () => {
		await trusted?.endpoint?.stop().catch(() => undefined);
		await mismatch?.endpoint?.stop().catch(() => undefined);
		disposeTls(trusted?.material);
		disposeTls(mismatch?.material);
		disposeTls(foreignCa);
	});

	async function trustedPoolConnect(caCertBody: string, url: string): Promise<string> {
		const dir = mkdtempSync(join(tmpdir(), 'ruok-live-ca-'));
		const caPath = join(dir, 'ca.pem');
		writeFileSync(caPath, caCertBody);
		try {
			const cfg = pgConfig({
				DATABASE_URL: url,
				DATABASE_SSL_MODE: 'verify-full',
				DATABASE_SSL_CA_FILE: caPath
			});
			const pool = new Pool(buildPostgresPoolConfig(cfg));
			try {
				const res = await pool.query('SELECT 1 AS one');
				return String(res.rows[0].one);
			} finally {
				await pool.end().catch(() => undefined);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}

	async function trustedMigrationConnect(caCertBody: string, url: string): Promise<string> {
		const dir = mkdtempSync(join(tmpdir(), 'ruok-live-ca-'));
		const caPath = join(dir, 'ca.pem');
		writeFileSync(caPath, caCertBody);
		try {
			const cfg = pgConfig({
				DATABASE_URL: url,
				DATABASE_SSL_MODE: 'verify-full',
				DATABASE_SSL_CA_FILE: caPath
			});
			const client = createPostgresMigrationClient(cfg);
			try {
				await client.connect();
				const res = await client.query('SELECT 1 AS one');
				return String(res.rows[0].one);
			} finally {
				await client.end().catch(() => undefined);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}

	it('trusted matching CA + hostname succeeds on the runtime pool', async () => {
		await expect(
			trustedPoolConnect(trusted!.endpoint.caCertBody, trusted!.endpoint.url)
		).resolves.toBe('1');
	});

	it('trusted matching CA + hostname succeeds on the migration Client', async () => {
		await expect(
			trustedMigrationConnect(trusted!.endpoint.caCertBody, trusted!.endpoint.url)
		).resolves.toBe('1');
	});

	it('untrusted CA is rejected without plaintext fallback (runtime pool)', async () => {
		// Client trusts foreignCa, but the server cert was signed by trusted CA.
		await expect(
			trustedPoolConnect(foreignCa!.caCertBody, trusted!.endpoint.url)
		).rejects.toThrow(/certificate|self-signed|authorized/i);
	});

	it('untrusted CA is rejected without plaintext fallback (migration Client)', async () => {
		await expect(
			trustedMigrationConnect(foreignCa!.caCertBody, trusted!.endpoint.url)
		).rejects.toThrow(/certificate|self-signed|authorized/i);
	});

	it('hostname mismatch is rejected even with the correct CA', async () => {
		// Server cert omits IP:127.0.0.1, so connecting to 127.0.0.1 fails
		// hostname verification despite the CA being trusted.
		await expect(
			trustedPoolConnect(mismatch!.endpoint.caCertBody, mismatch!.endpoint.url)
		).rejects.toThrow(/hostname|IP|subject|alternative|mismatch|checkServerIdentity/i);
	});
});
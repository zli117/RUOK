/**
 * Database configuration (FR-001 / FR-009 / FR-010).
 *
 * A single validated environment mapping. `loadConfig` is the only place an
 * environment object becomes a {@link DatabaseConfig}; unknown settings are
 * rejected and there is never a silent backend fallback.
 *
 * Highlights:
 *  - `DATABASE_TYPE` defaults to `sqlite`; only `sqlite`/`postgres` accepted.
 *  - SQLite keeps the legacy `DATABASE_PATH` (default `data/okr.db`); journal
 *    mode and busy timeout are validated.
 *  - PostgreSQL requires `DATABASE_URL`; pool/timeouts are bounded; TLS is
 *    `disable` or `verify-full` (verified only, no silent downgrade).
 *  - DSNs are redacted for logs via {@link redactConnectionString}.
 */
import { existsSync, readFileSync } from 'fs';
import type { PoolConfig } from 'pg';
import type {
	DatabaseConfig,
	PostgresConfig,
	PostgresSslMode,
	SqliteConfig,
	SqliteJournalMode
} from './contracts';

const DEFAULT_SQLITE_PATH = 'data/okr.db';
const DEFAULT_POOL_MAX = 5;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

// Values in a connection URL that would require TLS verification. A URL asking
// for any of these must never be silently downgraded to `disable`.
const VERIFYING_URL_SSLMODES = new Set(['require', 'verify-ca', 'verify-full']);

/**
 * Every query key that node-postgres' `pg-connection-string` treats as an SSL
 * control. If any of these survive in the connection string passed to pg, the
 * parser reproduces them into its parsed config and — via
 * `Object.assign(config, parse(connectionString))` — OVERRIDES the explicit
 * `ssl` object we set, silently dropping the CA and/or disabling verification
 * (DRIFT-1). We therefore consume/reject them in {@link parseUrlSslControls}
 * and strip them in {@link sanitizePostgresConnectionString}.
 */
const SECURITY_QUERY_KEYS = [
	'sslmode',
	'ssl',
	'sslcert',
	'sslkey',
	'sslrootcert',
	'sslnegotiation'
] as const;

/**
 * URL `sslmode` values this application understands. `require`/`verify-ca`/
 * `verify-full` all map to the canonical `verify-full` (the pg parser treats
 * them as aliases for verification). Anything else — including `prefer` and
 * `no-verify` — is unsupported here and rejected so a URL can never silently
 * weaken TLS. `no-verify` explicitly disables verification; `prefer` is
 * ambiguous. Both are refused deterministically before a connection.
 */
const ACCEPTED_URL_SSLMODES = new Set(['disable', 'require', 'verify-ca', 'verify-full']);

function parsePositiveBounded(value: string | undefined, fallback: number, name: string): number {
	if (value === undefined) return fallback;
	const n = Number(value);
	if (!Number.isInteger(n) || n <= 0) {
		throw new Error(`Invalid positive integer value '${value}' for ${name}`);
	}
	return n;
}

function parseNonNegativeBounded(value: string | undefined, fallback: number, name: string): number {
	if (value === undefined) return fallback;
	const n = Number(value);
	if (!Number.isInteger(n) || n < 0) {
		throw new Error(`Invalid non-negative integer value '${value}' for ${name}`);
	}
	return n;
}

function parseJournalMode(value: string | undefined): SqliteJournalMode {
	if (value === undefined) return 'wal';
	const mode = value.trim().toLowerCase();
	if (mode === 'wal' || mode === 'delete') return mode;
	throw new Error(
		`Invalid SQLITE_JOURNAL_MODE '${value}'. Expected 'wal' or 'delete' (default is 'wal').`
	);
}

/**
 * Inventory and validate the TLS-related query controls in a PostgreSQL URL.
 *
 * Returns the canonical `sslmode` hint (if any). Throws deterministically —
 * before any connection — when the URL contains duplicate, unknown or
 * unsupported TLS security controls, so a URL can never silently alter TLS
 * verification. Non-security query parameters are untouched and preserved by
 * the caller.
 */
function parseUrlSslControls(connectionString: string): { sslmode: string | undefined } {
	let u: URL;
	try {
		u = new URL(connectionString);
	} catch {
		// Invalid URL; treat as no TLS hint (surfaces at connect).
		return { sslmode: undefined };
	}

	let sslmode: string | undefined;
	for (const key of SECURITY_QUERY_KEYS) {
		const values = u.searchParams.getAll(key);
		if (values.length > 1) {
			throw new Error(`Duplicate TLS control '${key}' in connection URL`);
		}
		if (values.length !== 1) continue;

		if (key === 'sslmode') {
			const mode = values[0].trim().toLowerCase();
			if (!ACCEPTED_URL_SSLMODES.has(mode)) {
				throw new Error(
					`Unsupported TLS sslmode '${values[0]}' in connection URL. Supported URL modes are ` +
						'disable/require/verify-ca/verify-full; use DATABASE_SSL_MODE and ' +
						'DATABASE_SSL_CA_FILE for verified TLS.'
				);
			}
			sslmode = mode;
		} else {
			// `ssl`, `sslcert`, `sslkey`, `sslrootcert`, `sslnegotiation` are
			// unsupported URL controls here; refuse them so pg never reads them.
			throw new Error(
				`Unsupported TLS control '${key}' in connection URL. Configure TLS via ` +
					'DATABASE_SSL_MODE and DATABASE_SSL_CA_FILE.'
			);
		}
	}
	return { sslmode };
}

function sslModeFromUrl(connectionString: string): PostgresSslMode | undefined {
	const { sslmode } = parseUrlSslControls(connectionString);
	if (sslmode === 'disable') return 'disable';
	if (sslmode && VERIFYING_URL_SSLMODES.has(sslmode)) return 'verify-full';
	return undefined;
}

function parseSslMode(
	env: Record<string, string | undefined>,
	connectionString: string
): { sslMode: PostgresSslMode; sslCaFile: string | undefined } {
	const raw = env.DATABASE_SSL_MODE?.trim().toLowerCase();
	const urlHint = sslModeFromUrl(connectionString);
	const caFile = env.DATABASE_SSL_CA_FILE?.trim();

	// Resolve an explicit setting.
	if (raw !== undefined) {
		if (raw !== 'disable' && raw !== 'verify-full') {
			throw new Error(
				`Invalid DATABASE_SSL_MODE '${env.DATABASE_SSL_MODE}'. Expected 'disable' or 'verify-full'.`
			);
		}
		// Never silently disable verification the URL explicitly requested.
		if (raw === 'disable' && urlHint === 'verify-full') {
			throw new Error(
				"Contradictory TLS settings: DATABASE_SSL_MODE=disable conflicts with the URL's " +
					'sslmode requiring verification. Refusing to silently disable TLS verification.'
			);
		}
		// A CA file implies verification; reject an explicit disable.
		if (raw === 'disable' && caFile) {
			throw new Error(
				'Contradictory TLS settings: DATABASE_SSL_CA_FILE was set while DATABASE_SSL_MODE=disable. ' +
					'A CA file implies verification; refusing to silently disable it.'
			);
		}
		return { sslMode: raw, sslCaFile: caFile };
	}

	// No explicit mode: a CA file or a verifying URL mode defaults to verify-full.
	if (caFile) {
		return { sslMode: 'verify-full', sslCaFile: caFile };
	}
	if (urlHint === 'verify-full') {
		return { sslMode: 'verify-full', sslCaFile: undefined };
	}
	return { sslMode: 'disable', sslCaFile: undefined };
}

export function loadConfig(
	env: Record<string, string | undefined> = process.env
): DatabaseConfig {
	const type = (env.DATABASE_TYPE ?? 'sqlite').trim().toLowerCase();

	if (type === 'sqlite') {
		return {
			type: 'sqlite',
			path: env.DATABASE_PATH?.trim() || DEFAULT_SQLITE_PATH,
			journalMode: parseJournalMode(env.SQLITE_JOURNAL_MODE),
			busyTimeoutMs: parseNonNegativeBounded(
				env.SQLITE_BUSY_TIMEOUT_MS,
				DEFAULT_BUSY_TIMEOUT_MS,
				'SQLITE_BUSY_TIMEOUT_MS'
			)
		};
	}

	if (type === 'postgres') {
		const connectionString = env.DATABASE_URL?.trim();
		if (!connectionString) {
			throw new Error('DATABASE_TYPE=postgres requires DATABASE_URL to be set');
		}
		const { sslMode, sslCaFile } = parseSslMode(env, connectionString);
		const config: PostgresConfig = {
			type: 'postgres',
			connectionString,
			poolMax: parsePositiveBounded(env.DATABASE_POOL_MAX, DEFAULT_POOL_MAX, 'DATABASE_POOL_MAX'),
			connectTimeoutMs: parsePositiveBounded(
				env.DATABASE_CONNECT_TIMEOUT_MS,
				DEFAULT_CONNECT_TIMEOUT_MS,
				'DATABASE_CONNECT_TIMEOUT_MS'
			),
			statementTimeoutMs: parsePositiveBounded(
				env.DATABASE_STATEMENT_TIMEOUT_MS,
				DEFAULT_STATEMENT_TIMEOUT_MS,
				'DATABASE_STATEMENT_TIMEOUT_MS'
			),
			sslMode,
			sslCaFile
		};
		// DATABASE_PATH is a SQLite-only legacy setting; in PostgreSQL mode it is
		// deliberately ignored (the existing Docker environment sets it).
		return config;
	}

	throw new Error(
		`Unsupported DATABASE_TYPE '${type}'. Expected 'sqlite' or 'postgres' (omitted means sqlite).`
	);
}

// ---------------------------------------------------------------------------
// Secret redaction (FR-009)
// ---------------------------------------------------------------------------

/**
 * Redact the password (and any userinfo) from a PostgreSQL connection URL so
 * credentials never reach logs or error messages.
 */
export function redactConnectionString(connectionString: string): string {
	try {
		const u = new URL(connectionString);
		if (u.password) u.password = '***';
		else if (u.username) u.username = '***';
		return u.toString();
	} catch {
		return '<unparseable-redacted>';
	}
}

/**
 * A log-safe representation of a validated config (no secrets, no CA file body).
 */
export function redactConfig(config: DatabaseConfig): Record<string, unknown> {
	if (config.type === 'sqlite') {
		return {
			type: 'sqlite',
			path: config.path,
			journalMode: config.journalMode,
			busyTimeoutMs: config.busyTimeoutMs
		};
	}
	return {
		type: 'postgres',
		connectionString: redactConnectionString(config.connectionString),
		poolMax: config.poolMax,
		connectTimeoutMs: config.connectTimeoutMs,
		statementTimeoutMs: config.statementTimeoutMs,
		sslMode: config.sslMode,
		sslCaFile: config.sslCaFile ? '<path-redacted>' : undefined
	};
}

// ---------------------------------------------------------------------------
// Adapter-facing builders (keep dialect SQL/connection details out of the app)
// ---------------------------------------------------------------------------

/**
 * Remove every TLS-related query parameter from a PostgreSQL URL so the pg
 * parser never sees a security control that could override the explicit
 * canonical `ssl` we apply (DRIFT-1). Non-security parameters are preserved
 * and the rest of the URL is unchanged. If the URL cannot be parsed it is
 * returned untouched (it will fail at connect).
 */
export function sanitizePostgresConnectionString(connectionString: string): string {
	try {
		const u = new URL(connectionString);
		for (const key of SECURITY_QUERY_KEYS) {
			u.searchParams.delete(key);
		}
		return u.toString();
	} catch {
		return connectionString;
	}
}

/**
 * Build the node-postgres pool configuration from a validated config.
 *
 * Verified TLS (FR-009) is expressed as an explicit `ssl` object so the CA file
 * is not erased by URL parsing and there is no merge that could drop
 * verification. The connection string is sanitized first (all TLS query
 * controls removed) so `pg-connection-string` cannot override our explicit
 * `ssl` with a value parsed from the URL. When `sslMode` is `disable` the pool
 * is forced to `ssl: false`; contradictory URL `sslmode` values are already
 * rejected by {@link loadConfig}.
 */
export function buildPostgresPoolConfig(config: PostgresConfig): PoolConfig {
	const poolConfig: PoolConfig = {
		connectionString: sanitizePostgresConnectionString(config.connectionString),
		max: config.poolMax,
		connectionTimeoutMillis: config.connectTimeoutMs,
		statement_timeout: config.statementTimeoutMs
	};

	if (config.sslMode === 'verify-full') {
		const ca = config.sslCaFile ? readCaFile(config.sslCaFile) : undefined;
		poolConfig.ssl = {
			rejectUnauthorized: true,
			...(ca ? { ca } : {})
		};
	} else {
		poolConfig.ssl = false;
	}
	return poolConfig;
}

function readCaFile(path: string): string {
	if (!existsSync(path)) {
		throw new Error(`DATABASE_SSL_CA_FILE '${path}' does not exist`);
	}
	try {
		return readFileSync(path, 'utf8');
	} catch (err) {
		throw new Error(`Failed to read DATABASE_SSL_CA_FILE '${path}': ${(err as Error).message}`);
	}
}

/**
 * Build the SQLite pragmas to apply on open (FR-010): foreign-key enforcement,
 * a bounded busy timeout and the supported journal mode. Each string is a
 * pragma *without* the `PRAGMA` keyword, matching the better-sqlite3 `.pragma()`
 * API (`pragma('journal_mode = wal')`).
 */
export function buildSqlitePragmas(config: SqliteConfig): string[] {
	return [
		`journal_mode = ${config.journalMode}`,
		'foreign_keys = ON',
		`busy_timeout = ${config.busyTimeoutMs}`
	];
}
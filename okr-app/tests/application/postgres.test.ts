/**
 * WP06 — PostgreSQL real-backend entry point (auth + probe scenarios).
 *
 * Backend selection is MANDATORY: this file refuses to run unless
 * `DB_BACKEND=postgres` is set. It runs the real HTTP auth/admin/two-account
 * suites and the HTTP probe baseline against the BUILT server against a
 * disposable PostgreSQL database (created via `RUOK_TEST_PG_ADMIN_URL`).
 *
 * PostgreSQL outage/coalescing timing requires live server control and is
 * recorded PENDING (never fabricated, never substituted with SQLite) — the
 * sqlite entry covers that contract. When PostgreSQL is unreachable or no admin
 * URL is configured, starting a healthy server fails as a missing prerequisite.
 */
import { authSuite } from './auth.suite';
import { probesSuite, type ProbesHost } from './probes.suite';
import { startServer, type RunningServer } from './http-fixture';

if (process.env.DB_BACKEND !== 'postgres') {
	throw new Error(
		`PostgreSQL application suite requires DB_BACKEND=postgres (got '${process.env.DB_BACKEND}'). ` +
			'Backend selection is mandatory for real-database tests.'
	);
}

function startHealthy(): Promise<RunningServer> {
	return startServer({
		backend: 'postgres',
		env: { ADMIN_USERNAME: 'admin' }
	});
}

/** Start a server pointing at an unreachable PostgreSQL (health 200 / ready 503). */
function startUnavailable(): Promise<RunningServer> {
	return startServer({
		backend: 'postgres',
		env: {
			DATABASE_URL: 'postgres://ruok:pending@127.0.0.1:1/ruok',
			DATABASE_CONNECT_TIMEOUT_MS: '1500',
			DATABASE_POOL_MAX: '2'
		},
		requireReady: false
	});
}

const host: ProbesHost = {
	backend: 'postgres',
	startHealthy,
	startUnavailable
};

authSuite('postgres', startHealthy);
probesSuite('postgres', host);
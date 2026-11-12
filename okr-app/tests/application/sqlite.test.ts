/**
 * WP06 — SQLite real-backend entry point (auth + probe scenarios).
 *
 * Backend selection is MANDATORY: this file refuses to run unless
 * `DB_BACKEND=sqlite` is set. It runs the real HTTP auth/admin/two-account
 * suites and the HTTP outage/recovery probe suite against the BUILT server with
 * disposable SQLite storage.
 *
 * WP06 boundary: this entry imports `auth.suite.ts` and `probes.suite.ts` only.
 * WP07 later supplies its own `integrations.sqlite.test.ts` importing the HTTP
 * fixture; no forward imports or edits to WP06 files are needed.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authSuite } from './auth.suite';
import { probesSuite, type ProbesHost } from './probes.suite';
import { startServer, type RunningServer } from './http-fixture';

if (process.env.DB_BACKEND !== 'sqlite') {
	throw new Error(
		`SQLite application suite requires DB_BACKEND=sqlite (got '${process.env.DB_BACKEND}'). ` +
			'Backend selection is mandatory for real-database tests.'
	);
}

function startHealthy(): Promise<RunningServer> {
	return startServer({
		backend: 'sqlite',
		env: { ADMIN_USERNAME: 'admin' }
	});
}

/** Start a server whose SQLite storage is unavailable at startup (ready 503). */
async function startUnavailable(): Promise<RunningServer> {
	const dir = mkdtempSync(join(tmpdir(), 'ruok-http-unavail-'));
	const blocker = join(dir, 'blocker');
	writeFileSync(blocker, 'occupied');
	return startServer({
		backend: 'sqlite',
		dataDir: dir,
		env: {
			DATABASE_PATH: join(dir, 'blocker', 'okr.db'),
			SQLITE_JOURNAL_MODE: 'delete'
		},
		requireReady: false
	});
}

const host: ProbesHost = {
	backend: 'sqlite',
	startHealthy,
	startUnavailable
};

authSuite('sqlite', startHealthy);
probesSuite('sqlite', host);
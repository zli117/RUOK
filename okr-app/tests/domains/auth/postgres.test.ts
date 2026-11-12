/**
 * PostgreSQL real-backend entry point for the auth domain contract suite.
 *
 * Backend selection is MANDATORY: this file refuses to run unless
 * `DB_BACKEND=postgres` is set. It fails (never falls back to SQLite) if
 * PostgreSQL is unreachable. Live PostgreSQL runs in CI; see the handoff note
 * in WP04 for local coverage.
 */
import { authSuite } from './auth.suite';
import { createPostgresFixture } from '../../db/fixtures';

if (process.env.DB_BACKEND !== 'postgres') {
	throw new Error(
		`PostgreSQL auth domain suite requires DB_BACKEND=postgres (got '${process.env.DB_BACKEND}'). ` +
			'Backend selection is mandatory for real-database tests.'
	);
}

authSuite('postgres', createPostgresFixture);
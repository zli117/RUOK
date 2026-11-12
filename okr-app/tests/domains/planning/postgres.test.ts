/**
 * PostgreSQL real-backend entry point for the planning domain contract suite.
 *
 * Backend selection is MANDATORY: this file refuses to run unless
 * `DB_BACKEND=postgres` is set. It fails (never falls back to SQLite) if
 * PostgreSQL is unreachable. Live PostgreSQL runs in CI; see the WP05 handoff
 * note for local coverage.
 */
import { planningSuite } from './planning.suite';
import { createPostgresFixture } from '../../db/fixtures';

if (process.env.DB_BACKEND !== 'postgres') {
	throw new Error(
		`PostgreSQL planning domain suite requires DB_BACKEND=postgres (got '${process.env.DB_BACKEND}'). ` +
			'Backend selection is mandatory for real-database tests.'
	);
}

planningSuite('postgres', createPostgresFixture);
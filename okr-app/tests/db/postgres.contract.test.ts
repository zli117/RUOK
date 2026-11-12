/**
 * PostgreSQL real-backend entry point for the shared contract suite.
 *
 * Backend selection is MANDATORY: this file refuses to run unless
 * `DB_BACKEND=postgres` is set. If PostgreSQL is requested but unreachable the
 * tests FAIL (they never fall back to SQLite). Requires
 * `RUOK_TEST_PG_ADMIN_URL` to create a disposable database per fixture.
 */
import { contractSuite } from './contract.suite';
import { createPostgresFixture } from './fixtures';

if (process.env.DB_BACKEND !== 'postgres') {
	throw new Error(
		`PostgreSQL contract suite requires DB_BACKEND=postgres (got '${process.env.DB_BACKEND}'). ` +
			'Backend selection is mandatory; refusing to substitute SQLite for a missing PostgreSQL service.'
	);
}

contractSuite('postgres', createPostgresFixture);
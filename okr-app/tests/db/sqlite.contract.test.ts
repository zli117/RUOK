/**
 * SQLite real-backend entry point for the shared contract suite.
 *
 * Backend selection is MANDATORY: this file refuses to run unless
 * `DB_BACKEND=sqlite` is set, so a missing PostgreSQL service is never
 * silently substituted with SQLite and vice-versa.
 */
import { contractSuite } from './contract.suite';
import { createSqliteFixture } from './fixtures';

if (process.env.DB_BACKEND !== 'sqlite') {
	throw new Error(
		`SQLite contract suite requires DB_BACKEND=sqlite (got '${process.env.DB_BACKEND}'). ` +
			'Backend selection is mandatory for real-database tests.'
	);
}

contractSuite('sqlite', createSqliteFixture);
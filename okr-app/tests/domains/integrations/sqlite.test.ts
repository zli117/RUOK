/**
 * SQLite real-backend entry point for the WP07 application integrations suite.
 *
 * Backend selection is MANDATORY: this file refuses to run unless
 * `DB_BACKEND=sqlite` is set, so a missing PostgreSQL service is never
 * silently substituted with SQLite and vice-versa.
 */
import { integrationsSuite } from './integrations.suite';
import { createSqliteFixture } from '../../db/fixtures';

if (process.env.DB_BACKEND !== 'sqlite') {
	throw new Error(
		`SQLite integrations suite requires DB_BACKEND=sqlite (got '${process.env.DB_BACKEND}'). ` +
			'Backend selection is mandatory for real-database tests.'
	);
}

integrationsSuite('sqlite', createSqliteFixture);
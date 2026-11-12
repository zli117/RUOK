/**
 * PostgreSQL real-backend entry point for the WP07 application integrations suite.
 *
 * Backend selection is MANDATORY: this file refuses to run unless
 * `DB_BACKEND=postgres` is set, so a missing PostgreSQL service is never
 * silently substituted with SQLite and vice-versa.
 */
import { integrationsSuite } from './integrations.suite';
import { createPostgresFixture } from '../../db/fixtures';

if (process.env.DB_BACKEND !== 'postgres') {
	throw new Error(
		`PostgreSQL integrations suite requires DB_BACKEND=postgres (got '${process.env.DB_BACKEND}'). ` +
			'Backend selection is mandatory for real-database tests.'
	);
}

integrationsSuite('postgres', createPostgresFixture);
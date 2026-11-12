/**
 * PostgreSQL real-backend entry point for the metrics domain contract suite.
 *
 * Backend selection is MANDATORY: this file refuses to run unless
 * `DB_BACKEND=postgres` is set. Live PostgreSQL runs in CI.
 */
import { metricsSuite } from './metrics.suite';
import { createPostgresFixture } from '../../db/fixtures';

if (process.env.DB_BACKEND !== 'postgres') {
	throw new Error(
		`PostgreSQL metrics domain suite requires DB_BACKEND=postgres (got '${process.env.DB_BACKEND}'). ` +
			'Backend selection is mandatory for real-database tests.'
	);
}

metricsSuite('postgres', createPostgresFixture);
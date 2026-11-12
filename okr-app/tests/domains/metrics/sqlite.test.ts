/**
 * SQLite real-backend entry point for the metrics domain contract suite.
 *
 * Backend selection is MANDATORY: this file refuses to run unless
 * `DB_BACKEND=sqlite` is set.
 */
import { metricsSuite } from './metrics.suite';
import { createSqliteFixture } from '../../db/fixtures';

if (process.env.DB_BACKEND !== 'sqlite') {
	throw new Error(
		`SQLite metrics domain suite requires DB_BACKEND=sqlite (got '${process.env.DB_BACKEND}'). ` +
			'Backend selection is mandatory for real-database tests.'
	);
}

metricsSuite('sqlite', createSqliteFixture);
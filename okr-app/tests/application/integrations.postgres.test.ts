/**
 * WP07 — PostgreSQL real-backend entry point for the application-integration
 * suite (T030–T034).
 *
 * Backend selection is MANDATORY: this file refuses to run unless
 * `DB_BACKEND=postgres` is set. It runs the scheduler/query/saved-query/friend/
 * AI scenarios against the BUILT server against a disposable PostgreSQL
 * database plus the in-process scheduler against a real migrated PostgreSQL
 * database. Both require `RUOK_TEST_PG_ADMIN_URL` (with CREATEDB); without it
 * the suite fails as a missing prerequisite rather than silently falling back
 * to SQLite.
 */
import { integrationsSuite } from './integrations.suite';

if (process.env.DB_BACKEND !== 'postgres') {
	throw new Error(
		`PostgreSQL integrations suite requires DB_BACKEND=postgres (got '${process.env.DB_BACKEND}'). ` +
			'Backend selection is mandatory for real-database tests.'
	);
}

integrationsSuite({ label: 'postgres', backend: 'postgres' });
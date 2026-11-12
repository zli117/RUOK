/**
 * WP07 — SQLite real-backend entry point for the application-integration suite
 * (T030–T034).
 *
 * Backend selection is MANDATORY: this file refuses to run unless
 * `DB_BACKEND=sqlite` is set, so a missing backend is never silently
 * substituted. It runs the scheduler/query/saved-query/friend/AI scenarios
 * against the BUILT server with disposable SQLite storage plus the in-process
 * scheduler against a real migrated SQLite database.
 */
import { integrationsSuite } from './integrations.suite';

if (process.env.DB_BACKEND !== 'sqlite') {
	throw new Error(
		`SQLite integrations suite requires DB_BACKEND=sqlite (got '${process.env.DB_BACKEND}'). ` +
			'Backend selection is mandatory for real-database tests.'
	);
}

integrationsSuite({ label: 'sqlite', backend: 'sqlite' });
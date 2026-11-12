/**
 * Cross-backend real-backend entry points for the backup/restore contract suite.
 *
 * Runs the three pairs that involve PostgreSQL: SQLite→PostgreSQL,
 * PostgreSQL→SQLite and PostgreSQL→PostgreSQL. Backend selection is MANDATORY:
 * this file refuses to run unless `DB_BACKEND=postgres` is set, and fails
 * (never falls back to SQLite) if PostgreSQL is unreachable. Live PostgreSQL
 * runs in CI; see the handoff note in WP06 for local coverage.
 */
import { backupSuite } from './backup.suite';
import { createPostgresFixture, createSqliteFixture } from './fixtures';

if (process.env.DB_BACKEND !== 'postgres') {
	throw new Error(
		`PostgreSQL backup suite requires DB_BACKEND=postgres (got '${process.env.DB_BACKEND}'). ` +
			'Backend selection is mandatory for real-database tests.'
	);
}

backupSuite('sqlite->postgres', async () => ({
	source: await createSqliteFixture(),
	target: await createPostgresFixture()
}));

backupSuite('postgres->sqlite', async () => ({
	source: await createPostgresFixture(),
	target: await createSqliteFixture()
}));

backupSuite('postgres->postgres', async () => ({
	source: await createPostgresFixture(),
	target: await createPostgresFixture()
}));
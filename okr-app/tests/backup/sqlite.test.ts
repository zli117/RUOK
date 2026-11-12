/**
 * SQLite→SQLite real-backend entry point for the backup/restore contract suite.
 *
 * Backend selection is MANDATORY: this file refuses to run unless
 * `DB_BACKEND=sqlite` is set.
 */
import { backupSuite } from './backup.suite';
import { createSqliteFixture } from './fixtures';

if (process.env.DB_BACKEND !== 'sqlite') {
	throw new Error(
		`SQLite backup suite requires DB_BACKEND=sqlite (got '${process.env.DB_BACKEND}'). ` +
			'Backend selection is mandatory for real-database tests.'
	);
}

backupSuite('sqlite->sqlite', async () => ({
	source: await createSqliteFixture(),
	target: await createSqliteFixture()
}));
/**
 * Legacy-adoption test fixtures (T010 / T012).
 *
 * Builds real SQLite database files in temp dirs representing every supported
 * and unsupported legacy layout, using the checked `drizzle/` migration folder
 * directly so the fixtures match the real history exactly:
 *
 *  - fresh            : an empty database (no user tables).
 *  - journal-managed  : full schema + complete journal (drizzle migrate).
 *  - db:push          : full schema, NO journal table.
 *  - db:push + missing additive columns (e.g. missing `max_agent_rounds`).
 *  - incomplete journal: full schema but some journal records deleted.
 *  - orphan data      : full schema, no journal, plus a foreign-key orphan row.
 *  - unknown drift    : full schema + an unknown table and/or column.
 */
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { readMigrationFolder } from '../../src/lib/db/migrations'
import type { MigrationMeta } from '../../src/lib/db/migrations'

export const SQLITE_FOLDER = join(process.cwd(), 'drizzle')

export interface Fixture {
	path: string
	cleanup(): void
}

export type LegacyKind =
	| 'fresh'
	| 'journal-managed'
	| 'db-push'
	| 'db-push-missing-additive'
	| 'incomplete-journal'
	| 'orphan-data'
	| 'unknown-drift'

function makeDir(): string {
	return mkdtempSync(join(tmpdir(), 'ruok-mig-'))
}

/** Apply the first `count` migrations in order (creating the journal table). */
function applyUpTo(db: Database.Database, migrations: MigrationMeta[], count: number): void {
	db.exec(
		'CREATE TABLE IF NOT EXISTS __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)'
	)
	const insert = db.prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)')
	for (const m of migrations.slice(0, count)) {
		for (const stmt of m.sql) db.exec(stmt)
		insert.run(m.hash, m.when)
	}
}

/** Build a real sqlite file for a given legacy kind. */
export function buildLegacyFixture(kind: LegacyKind): Fixture {
	const dir = makeDir()
	const path = join(dir, 'okr.db')
	const { migrations } = readMigrationFolder(SQLITE_FOLDER)
	const db = new Database(path)
	// better-sqlite3 enables FK enforcement by default; disable it here so the
	// fixture builder can reproduce legacy layouts (e.g. orphan data) that a
	// pre-adoption, FK-off database would contain.
	db.pragma('foreign_keys = OFF')

	try {
		switch (kind) {
			case 'fresh':
				// A freshly created file with no user tables.
				break
			case 'journal-managed':
				applyUpTo(db, migrations, migrations.length)
				break
			case 'db-push':
				// Full schema (all migrations) but no journal table.
				applyUpTo(db, migrations, migrations.length)
				db.exec('DROP TABLE __drizzle_migrations')
				break
			case 'db-push-missing-additive':
				// Schema at migration 5 (before 0006) and no journal: the adoption
				// must ADD the missing `max_agent_rounds` additive column.
				applyUpTo(db, migrations, migrations.length - 1)
				db.exec('DROP TABLE __drizzle_migrations')
				break
			case 'incomplete-journal':
				applyUpTo(db, migrations, migrations.length)
				// Delete the last three journal records; schema remains complete.
				db.prepare('DELETE FROM __drizzle_migrations WHERE created_at >= ?').run(
					migrations[migrations.length - 3].when
				)
				break
			case 'orphan-data':
				applyUpTo(db, migrations, migrations.length)
				db.exec('DROP TABLE __drizzle_migrations')
				// Insert a task referencing a non-existent time_period (orphan).
				db.exec(`
					INSERT INTO users (id, username, password_hash, created_at)
					VALUES ('u1', 'orphan-user', 'x', 1);
					INSERT INTO tasks (id, user_id, time_period_id, title, created_at, updated_at)
					VALUES ('t1', 'u1', 'missing-period', 'orphan', 1, 1);
				`)
				break
			case 'unknown-drift':
				applyUpTo(db, migrations, migrations.length)
				// An unknown table the expected layout does not know about.
				db.exec('CREATE TABLE unknown_extra (id text PRIMARY KEY)')
				break
		}
	} finally {
		db.close()
	}

	return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** Open a read-only view helper for assertions (returns an open handle). */
export function openRaw(path: string): Database.Database {
	return new Database(path, { readonly: true })
}
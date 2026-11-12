/**
 * Upgrade preserves data test (T030 / FR-004, US1).
 *
 * A historical (db:push-era) SQLite installation carries REAL rows. Running the
 * canonical migration/adoption path on top of it must:
 *   - record the reconciled migration journal (no schema mutation when the
 *     layout is already complete);
 *   - leave every pre-existing row readable through the typed boundary; and
 *   - allow new writes immediately afterwards.
 *
 * This closes a gap the schema-only legacy tests (T010) deliberately leave
 * open: they assert the schema converges, but not that application DATA
 * survives an upgrade. Uses the real bundled migration runner and the real
 * production adapters — no mocks at the persistence layer.
 */
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig, openDatabase, resetDatabaseForTests } from '../../src/lib/db'
import { buildLegacyFixture } from '../db/migration-fixtures'

afterEach(() => {
	resetDatabaseForTests()
})

describe('T030 upgrade preserves application data', () => {
	it('adopts a db:push-era layout with real data and keeps every row readable', async () => {
		const fixture = buildLegacyFixture('db-push')
		try {
			// Seed real historical rows with FK enforcement off (as the original
			// db:push-era database would have had them) before adopting.
			const raw = new Database(fixture.path)
			try {
				raw.pragma('foreign_keys = OFF')
				const t = Date.parse('2025-01-15T12:00:00Z')
				raw.exec(`
					INSERT INTO users (id, username, password_hash, created_at)
					VALUES ('u1', 'alice', '$2b$10$legacy.hash', ${t});
					INSERT INTO objectives (id, user_id, title, level, year, weight, created_at, updated_at)
					VALUES ('o1', 'u1', 'Legacy yearly goal', 'yearly', 2025, 1.0, ${t}, ${t});
					INSERT INTO key_results (id, objective_id, title, weight, score, sort_order, created_at, updated_at)
					VALUES ('kr1', 'o1', 'Legacy KR', 1.0, 0.5, 0, ${t}, ${t});
					INSERT INTO time_periods (id, user_id, period_type, year, month, created_at, updated_at)
					VALUES ('tp1', 'u1', 'weekly', 2025, 1, ${t}, ${t});
					INSERT INTO tasks (id, user_id, time_period_id, title, created_at, updated_at)
					VALUES ('t1', 'u1', 'tp1', 'Legacy task', ${t}, ${t});
				`)
			} finally {
				raw.close()
			}

			// Upgrade path: openDatabase runs the canonical migration/adoption.
			const services = await openDatabase(loadConfig({ DATABASE_PATH: fixture.path }))
			try {
				// Every pre-existing row is readable through the typed boundary.
				const user = await services.users.findByUsername('alice')
				expect(user?.id).toBe('u1')
				expect(user?.passwordHash).toBe('$2b$10$legacy.hash')

				const goal = await services.objectives.findById('o1')
				expect(goal?.title).toBe('Legacy yearly goal')
				expect(goal?.level).toBe('yearly')

				const kr = await services.keyResults.findById('kr1')
				expect(kr?.title).toBe('Legacy KR')
				expect(kr?.score).toBeCloseTo(0.5)

				const period = await services.timePeriods.findById('tp1')
				expect(period?.periodType).toBe('weekly')

				const task = await services.tasks.findById('t1')
				expect(task?.title).toBe('Legacy task')

				// New writes work immediately after upgrade.
				await services.objectives.create({
					id: 'o2',
					userId: 'u1',
					title: 'New goal after upgrade',
					level: 'monthly',
					year: 2025,
					month: 2
				})
				expect((await services.objectives.findById('o2'))?.title).toBe('New goal after upgrade')
			} finally {
				await services.close()
			}

			// The reconciled journal records the full history (7 rows).
			const check = new Database(fixture.path, { readonly: true })
			try {
				const c = check.prepare('SELECT count(*) AS c FROM __drizzle_migrations').get() as { c: number }
				expect(c.c).toBe(7)
			} finally {
				check.close()
			}
		} finally {
			fixture.cleanup()
		}
	})
})
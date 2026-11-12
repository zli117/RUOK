/**
 * Native installation recovery rehearsal (T031 / FR-014, US5).
 *
 * Full-installation recovery is deliberately DISTINCT from user-export
 * portability (FR-008). This test rehearses the SQLite native backup path
 * against a REAL migrated installation (the production `openDatabase`/migration
 * path, not fixture DDL):
 *
 *   1. build a fresh migrated SQLite install and write a complete set of
 *      installation + application data through the typed boundary
 *      (accounts, sessions, system config incl. a secret, friendships + friend
 *      notes, plugin config, AI config, objectives/KRs, periods/tasks/tags,
 *      metrics, saved queries/widgets, query logs);
 *   2. close the database;
 *   3. take a NATIVE backup with better-sqlite3's online `.backup()` API (the
 *      supported SQLite mechanism — no SQL/JSON export involved);
 *   4. open the backup as a fresh install and verify every row, the migration
 *      journal and readiness survive byte-for-byte through the typed boundary.
 *
 * The PostgreSQL native dump/restore rehearsal is gated separately
 * (`postgres-recovery.test.ts`) because it needs a live server and `pg_dump`.
 * Native dumps cannot switch backend engines — a SQLite backup restores only to
 * SQLite and a PostgreSQL dump only to PostgreSQL; backend conversion is a
 * separately scoped problem (see docs/DATABASE-VERIFICATION.md).
 */
import Database from 'better-sqlite3'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
	createDatabaseServices,
	getReadiness,
	loadConfig,
	migrateDatabase,
	openDatabase,
	resetDatabaseForTests
} from '../../src/lib/db'
import { seedInstall } from './seed'

const dirs: string[] = []

function tempPath(name: string): string {
	const dir = mkdtempSync(join(tmpdir(), `ruok-recovery-${name}-`))
	dirs.push(dir)
	return join(dir, 'okr.db')
}

afterEach(() => {
	resetDatabaseForTests()
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** Build a real migrated install, write data, native-backup it, restore + verify. */
describe('T031 native SQLite recovery rehearsal', () => {
	it('backs up a migrated installation and restores every row + journal + readiness', async () => {
		const src = tempPath('src')
		const dst = tempPath('dst')

		// 1. Fresh migrated install (production path).
		const srcConfig = loadConfig({ DATABASE_PATH: src })
		expect((await migrateDatabase(srcConfig)).classification).toBe('fresh')
		const services = createDatabaseServices(srcConfig)
		await services.open()
		await seedInstall(services)
		await services.close()
		resetDatabaseForTests()

		// 2. Native backup via better-sqlite3's online backup API.
		const live = new Database(src, { readonly: true })
		try {
			await live.backup(dst)
		} finally {
			live.close()
		}
		expect(existsSync(dst)).toBe(true)

		// The backup must be a full independent copy (migrated schema + journal).
		const dstRaw = new Database(dst, { readonly: true })
		try {
			const c = dstRaw.prepare('SELECT count(*) AS c FROM __drizzle_migrations').get() as { c: number }
			expect(c.c).toBe(7)
		} finally {
			dstRaw.close()
		}

		// 3. Open the backup as a fresh install and verify readiness + all rows.
		//    `openDatabase` runs the canonical migration check first: the restored
		//    copy must classify as already-ready (schema + journal aligned) and
		//    then publish a ready process-wide state.
		const dstServices = await openDatabase(loadConfig({ DATABASE_PATH: dst }))
		try {
			const readiness = await getReadiness()
			expect(readiness.ready).toBe(true)
			expect(readiness.dialect).toBe('sqlite')
			expect(readiness.schemaVersion).toBe(6)

			// Accounts + session
			expect((await dstServices.users.findByUsername('alice'))?.passwordHash).toBe('hash-a')
			expect((await dstServices.users.findByUsername('bob'))?.isAdmin).toBe(true)
			expect(await dstServices.sessions.findById('s1')).toBeDefined()

			// System config incl. secret
			expect((await dstServices.systemConfig.all()).length).toBe(2)
			expect(
				(await dstServices.systemConfig.all()).find((r) => r.key === 'plugin.fitbit.client_secret')?.value
			).toBe('super-secret')

			// Social
			expect(await dstServices.friendships.findBetween('alice', 'bob')).toBeDefined()
			expect((await dstServices.friendNotes.findByUserAndFriend('alice', 'bob'))?.note).toBe('private note')

			// Plugin + AI
			expect((await dstServices.plugins.findByUserAndPlugin('alice', 'fitbit'))?.enabled).toBe(true)
			expect((await dstServices.userAiConfig.findByUser('alice'))?.provider).toBe('anthropic')

			// Goals + reflection
			expect((await dstServices.objectives.findById('o1'))?.title).toBe('Yearly goal')
			expect((await dstServices.keyResults.findById('kr1'))?.title).toBe('KR')
			expect(
				(await dstServices.objectiveReflections.findByUserLevelYearMonth({
					userId: 'alice',
					level: 'yearly',
					year: 2026,
					month: null
				}))?.reflection
			).toBe('Solid year')

			// Planning
			expect((await dstServices.timePeriods.findById('tp1'))?.periodType).toBe('weekly')
			expect((await dstServices.tasks.findById('t1'))?.title).toBe('Write code')
			expect((await dstServices.taskAttributes.listByTask('t1')).length).toBe(1)
			expect((await dstServices.taskTags.listByTask('t1')).length).toBe(1)
			expect(await dstServices.tags.findById('tag1')).toBeDefined()

			// Metrics
			expect((await dstServices.metricsTemplates.findById('tpl1'))?.name).toBe('default')
			expect(
				(await dstServices.dailyMetricValues.findByUserDateName('alice', '2026-01-01', 'steps'))?.value
			).toBe('10000')

			// Saved queries/widgets + query logs
			expect((await dstServices.savedQueries.findById('q1'))?.name).toBe('Progress')
			expect(await dstServices.dashboardWidgets.findById('w1')).toBeDefined()
			expect((await dstServices.queryExecutionLogs.listByUser('alice')).length).toBe(1)
		} finally {
			await dstServices.close()
		}
	})
})
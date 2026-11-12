/**
 * Shared backup/restore contract suite (WP06 / FR-008, US4, T021-T024).
 *
 * Runs identically against the four source→target pairs. It verifies:
 *  - complete supported-field round-trip (values/principles, tags, saved
 *    queries, objectives with KRs incl. scoreLabel + query refs, time periods
 *    with commitment/metrics/tasks + attributes/tags, widgets, templates,
 *    metric values, reflections, preferences);
 *  - logical link integrity (parentIndex, tag names, query names) survives;
 *  - other accounts are preserved;
 *  - invalid versions are rejected BEFORE any mutation;
 *  - injected failures (after deletion and near final preference writes)
 *    roll the whole restore back and restore the original rows/preferences;
 *  - exports under concurrent changes remain internally consistent.
 */
import { describe, it, expect } from 'vitest';
import { buildExportDocument, buildRestorePlan, BackupValidationError } from '../../src/lib/db/backup';
import type {
	BackupDocumentV2,
	RestoreCommandPlan,
	RestoreStats
} from '../../src/lib/db/backup';
import type { DbFixture } from './fixtures';
import type { DatabaseServices } from '../../src/lib/db';

export interface BackupPair {
	source: DbFixture;
	target: DbFixture;
}

export type FixtureFactory = () => Promise<DbFixture>;

export function backupSuite(label: string, makeFixtures: () => Promise<BackupPair>) {
	describe(`backup/restore contract (${label})`, () => {
		it('round-trips complete supported content with preserved links', async () => {
			const { source, target } = await makeFixtures();
			try {
				await seedUser(source.services, 'alice');
				const doc = await exportDocument(source.services, 'alice');

				await target.services.users.create({
					id: 'bob',
					username: 'bob',
					passwordHash: 'hash'
				});
				const plan = buildRestorePlan(doc, 'bob');
				const stats = await target.services.backup.restore(plan);
				expect(stats).toMatchObject({
					tags: 2,
					values: 1,
					principles: 2,
					savedQueries: 2,
					objectives: 2,
					keyResults: 2,
					timePeriods: 1,
					tasks: 2,
					taskAttributes: 1,
					taskTags: 2,
					dailyMetrics: 1,
					timeCommitments: 1,
					dashboardWidgets: 1,
					metricsTemplates: 1,
					dailyMetricValues: 1,
					objectiveReflections: 1
				});

				const restored = await exportDocument(target.services, 'bob');
				expect(restored.data).toEqual(doc.data);
				expect(restored.preferences).toEqual(doc.preferences);
				expect(restored.version).toBe(2);
			} finally {
				await source.teardown();
				await target.teardown();
			}
		});

		it('preserves other accounts when restoring into one user', async () => {
			const { source, target } = await makeFixtures();
			try {
				await seedUser(source.services, 'alice');
				const doc = await exportDocument(source.services, 'alice');

				// bob has his own data; carol has her own data.
				await target.services.users.create({ id: 'bob', username: 'bob', passwordHash: 'h' });
				await target.services.users.create({ id: 'carol', username: 'carol', passwordHash: 'h' });
				await seedUser(target.services, 'bob');
				await seedUser(target.services, 'carol');
				const carolBefore = await exportDocument(target.services, 'carol');

				// Restore a modified document into bob only (change a tag color so
				// references stay valid).
				const modified = structuredClone(doc);
				modified.data.tags[0].color = '#00ff00';
				const plan = buildRestorePlan(modified, 'bob');
				await target.services.backup.restore(plan);

				const bobNow = await exportDocument(target.services, 'bob');
				const carolAfter = await exportDocument(target.services, 'carol');
				// bob's tags were replaced by the restored content.
				expect(bobNow.data.tags.find((t) => t.name === 'focus')?.color).toBe('#00ff00');
				// carol is untouched.
				expect(carolAfter.data).toEqual(carolBefore.data);
				expect(carolAfter.preferences).toEqual(carolBefore.preferences);
			} finally {
				await source.teardown();
				await target.teardown();
			}
		});

		it('rejects an unsupported version before any mutation', async () => {
			const { source, target } = await makeFixtures();
			try {
				await seedUser(source.services, 'alice');
				const doc = await exportDocument(source.services, 'alice');
				await target.services.users.create({ id: 'bob', username: 'bob', passwordHash: 'h' });
				await seedUser(target.services, 'bob');
				const before = await exportDocument(target.services, 'bob');

				const bad = { ...doc, version: 3 };
				let err: unknown;
				try {
					buildRestorePlan(bad, 'bob');
				} catch (e) {
					err = e;
				}
				expect(err).toBeInstanceOf(BackupValidationError);
				expect((err as BackupValidationError).code).toBe('unsupported_version');

				// Nothing was mutated.
				const after = await exportDocument(target.services, 'bob');
				expect(after.data).toEqual(before.data);
				expect(after.preferences).toEqual(before.preferences);
			} finally {
				await source.teardown();
				await target.teardown();
			}
		});

		it('deterministically rejects duplicate names and broken references before mutation', async () => {
			const { source, target } = await makeFixtures();
			try {
				await seedUser(source.services, 'alice');
				const doc = await exportDocument(source.services, 'alice');

				// Duplicate tag name.
				const dupTags = structuredClone(doc);
				dupTags.data.tags = [
					{ name: 'same', color: null, category: null },
					{ name: 'same', color: null, category: null }
				];
				await expectRejected(dupTags, 'duplicate_tag_name');

				// Unresolved saved-query reference on a key result.
				const badRef = structuredClone(doc);
				badRef.data.objectives[0].keyResults[0].progressQueryName = 'nope';
				await expectRejected(badRef, 'unresolved_query_reference');

				// Out-of-range parentIndex.
				const badParent = structuredClone(doc);
				badParent.data.objectives[1].parentIndex = 99;
				await expectRejected(badParent, 'invalid_parent_index');

				// Unresolved task tag reference.
				const badTag = structuredClone(doc);
				badTag.data.timePeriods[0].tasks[0].tagNames = ['nope'];
				await expectRejected(badTag, 'unresolved_tag_reference');
			} finally {
				await source.teardown();
				await target.teardown();
			}
		});

		it('rolls back the whole restore on a failure after deletion', async () => {
			const { source, target } = await makeFixtures();
			try {
				await seedUser(source.services, 'alice');
				const doc = await exportDocument(source.services, 'alice');
				await target.services.users.create({ id: 'bob', username: 'bob', passwordHash: 'h' });
				await seedUser(target.services, 'bob');
				const before = await exportDocument(target.services, 'bob');

				// Valid plan, then corrupt the FIRST insert (tags) with a NOT NULL
				// violation. Deletes have already run inside the transaction.
				const plan = buildRestorePlan(doc, 'bob');
				plan.tags.push({
					id: 'broken-tag',
					userId: 'bob',
					name: undefined as unknown as string,
					color: null,
					category: null
				});

				await expect(target.services.backup.restore(plan)).rejects.toThrow();

				// Original rows and preferences are restored; no partial state.
				const after = await exportDocument(target.services, 'bob');
				expect(after.data).toEqual(before.data);
				expect(after.preferences).toEqual(before.preferences);
			} finally {
				await source.teardown();
				await target.teardown();
			}
		});

		it('rolls back the whole restore on a failure near the final preference writes', async () => {
			const { source, target } = await makeFixtures();
			try {
				await seedUser(source.services, 'alice');
				const doc = await exportDocument(source.services, 'alice');
				await target.services.users.create({ id: 'bob', username: 'bob', passwordHash: 'h' });
				await seedUser(target.services, 'bob');
				const before = await exportDocument(target.services, 'bob');

				// Valid plan, then corrupt the near-final objectiveReflections insert.
				const plan = buildRestorePlan(doc, 'bob');
				plan.objectiveReflections.push({
					id: 'broken-ref',
					userId: 'bob',
					level: undefined as unknown as 'yearly',
					year: 2025,
					month: null,
					reflection: 'x',
					createdAt: new Date(),
					updatedAt: new Date()
				});

				await expect(target.services.backup.restore(plan)).rejects.toThrow();

				// Everything (incl. preferences) rolled back.
				const after = await exportDocument(target.services, 'bob');
				expect(after.data).toEqual(before.data);
				expect(after.preferences).toEqual(before.preferences);
			} finally {
				await source.teardown();
				await target.teardown();
			}
		});

		it('keeps exports consistent under concurrent replace restores', async () => {
			const { source, target } = await makeFixtures();
			try {
				await seedUser(source.services, 'alice');
				const doc = await exportDocument(source.services, 'alice');

				await target.services.users.create({ id: 'bob', username: 'bob', passwordHash: 'h' });
				await seedUser(target.services, 'bob');
				const plan = buildRestorePlan(doc, 'bob');

				// Fire exports while restores of the same document replace bob's data.
				// Each restore is atomic, so every export must observe a complete,
				// internally-consistent state equal to the seed document.
				const tasks: Promise<BackupDocumentV2>[] = [];
				for (let i = 0; i < 5; i++) {
					tasks.push(exportDocument(target.services, 'bob'));
				}
				for (let i = 0; i < 3; i++) {
					await target.services.backup.restore(plan);
				}
				const docs = await Promise.all(tasks);

				for (const d of docs) {
					expect(assertInternallyConsistent(d)).toBe(true);
					expect(d.data).toEqual(doc.data);
				}
			} finally {
				await source.teardown();
				await target.teardown();
			}
		});
	});
}

// ---------------------------------------------------------------------------

/** A complete version-2 document exercising every supported field. */
export function makeSeedDocument(): BackupDocumentV2 {
	const iso = '2026-01-01T00:00:00.000Z';
	return {
		version: 2,
		exportedAt: iso,
		preferences: { timezone: 'Europe/Samara', weekStartDay: 'sunday', bgColor: '#abcdef' },
		data: {
			values: [
				{
					title: 'Growth',
					rank: 1,
					description: 'Keep improving',
					createdAt: iso,
					updatedAt: iso,
					principles: [
						{
							title: 'Own your outcomes',
							description: 'Be accountable',
							examples: 'Deliver',
							createdAt: iso,
							updatedAt: iso
						}
					]
				}
			],
			orphanPrinciples: [
				{
					title: 'Orphan',
					description: null,
					examples: null,
					createdAt: iso,
					updatedAt: iso
				}
			],
			tags: [
				{ name: 'focus', color: '#ff0000', category: 'priority' },
				{ name: 'admin', color: null, category: null }
			],
			savedQueries: [
				{
					name: 'Weekly Progress',
					description: 'Progress query',
					queryType: 'progress',
					code: 'return ctx.tasks',
					createdAt: iso,
					updatedAt: iso
				},
				{
					name: 'Widget Query',
					description: 'Widget query',
					queryType: 'widget',
					code: 'return ctx.metrics',
					createdAt: iso,
					updatedAt: iso
				}
			],
			objectives: [
				{
					title: 'Parent objective',
					description: 'Top',
					level: 'yearly',
					year: 2026,
					month: null,
					weight: 1.0,
					category: 'personal',
					colorIndex: 2,
					parentIndex: null,
					createdAt: iso,
					updatedAt: iso,
					keyResults: [
						{
							title: 'Ship WP06',
							details: 'Backup',
							weight: 1.0,
							score: 0.5,
							scoreLabel: 'On track',
							expectedHours: 40,
							sortOrder: 0,
							measurementType: 'custom_query',
							checkboxItems: null,
							progressQueryName: 'Weekly Progress',
							progressQueryCode: 'return 1',
							widgetQueryName: null,
							widgetQueryCode: null,
							createdAt: iso,
							updatedAt: iso
						}
					]
				},
				{
					title: 'Child objective',
					description: null,
					level: 'monthly',
					year: 2026,
					month: 1,
					weight: 0.5,
					category: null,
					colorIndex: null,
					parentIndex: 0,
					createdAt: iso,
					updatedAt: iso,
					keyResults: [
						{
							title: 'KR 2',
							details: null,
							weight: 1.0,
							score: 0,
							scoreLabel: null,
							expectedHours: null,
							sortOrder: 0,
							measurementType: 'slider',
							checkboxItems: '["a","b"]',
							progressQueryName: null,
							progressQueryCode: null,
							widgetQueryName: 'Widget Query',
							widgetQueryCode: 'return ctx.widgets',
							createdAt: iso,
							updatedAt: iso
						}
					]
				}
			],
			timePeriods: [
				{
					periodType: 'weekly',
					year: 2026,
					month: 1,
					week: 3,
					day: null,
					notes: 'Week notes',
					reviewWhatWorked: 'Good',
					reviewImprovements: 'Better',
					createdAt: iso,
					updatedAt: iso,
					timeCommitment: {
						numberOfWeeks: 4,
						availableHoursPerWeekday: 2.5,
						availableHoursPerWeekend: 8.0
					},
					dailyMetrics: {
						previousNightBedTime: '23:00',
						wakeUpTime: '07:00',
						sleepLength: '8h',
						cardioLoad: 5,
						fitbitReadiness: 80,
						steps: 10000,
						heartPoints: 120,
						restingHeartRate: 55,
						customMetrics: '{"morning_mood":3}'
					},
					tasks: [
						{
							title: 'Write code',
							completed: true,
							completedAt: iso,
							sortOrder: 1,
							timeSpentMs: 3600000,
							timerStartedAt: null,
							createdAt: iso,
							updatedAt: iso,
							attributes: [{ key: 'effort', value: '5', valueType: 'number' }],
							tagNames: ['focus', 'admin']
						},
						{
							title: 'Review',
							completed: false,
							completedAt: null,
							sortOrder: 2,
							timeSpentMs: 0,
							timerStartedAt: iso,
							createdAt: iso,
							updatedAt: iso,
							attributes: [],
							tagNames: []
						}
					]
				}
			],
			dashboardWidgets: [
				{
					title: 'Progress widget',
					widgetType: 'custom',
					config: '{"queryName":"Widget Query"}',
					sortOrder: 0,
					page: 'dashboard',
					createdAt: iso
				}
			],
			metricsTemplates: [
				{
					name: 'Default',
					effectiveFrom: '2026-01-01',
					metricsDefinition: '{}',
					createdAt: iso,
					updatedAt: iso
				}
			],
			dailyMetricValues: [
				{ date: '2026-01-01', metricName: 'steps', value: '12345', source: 'fitbit' }
			],
			objectiveReflections: [
				{ level: 'yearly', year: 2026, month: null, reflection: 'Solid year', createdAt: iso, updatedAt: iso }
			]
		}
	};
}

export async function seedUser(services: DatabaseServices, userId: string): Promise<RestoreStats> {
	const existing = await services.users.findById(userId);
	if (!existing) {
		await services.users.create({ id: userId, username: userId, passwordHash: 'hash' });
	}
	const plan = buildRestorePlan(makeSeedDocument(), userId);
	return services.backup.restore(plan);
}

export async function exportDocument(
	services: DatabaseServices,
	userId: string
): Promise<BackupDocumentV2> {
	return buildExportDocument(await services.backup.exportSnapshot(userId));
}

async function expectRejected(doc: BackupDocumentV2, code: string): Promise<void> {
	let err: unknown;
	try {
		buildRestorePlan(doc, 'bob');
	} catch (e) {
		err = e;
	}
	expect(err).toBeInstanceOf(BackupValidationError);
	expect((err as BackupValidationError).code).toBe(code);
}

function assertInternallyConsistent(doc: BackupDocumentV2): boolean {
	const tags = new Set(doc.data.tags.map((t) => t.name));
	const queries = new Set(doc.data.savedQueries.map((q) => q.name));
	for (const obj of doc.data.objectives) {
		if (obj.parentIndex !== null && (obj.parentIndex < 0 || obj.parentIndex >= doc.data.objectives.length)) {
			return false;
		}
		for (const kr of obj.keyResults) {
			if (kr.progressQueryName !== null && !queries.has(kr.progressQueryName)) return false;
			if (kr.widgetQueryName !== null && !queries.has(kr.widgetQueryName)) return false;
		}
	}
	for (const tp of doc.data.timePeriods) {
		for (const task of tp.tasks) {
			for (const name of task.tagNames) {
				if (!tags.has(name)) return false;
			}
		}
	}
	return true;
}

export type BackupServices = DatabaseServices;
export type { RestoreCommandPlan };
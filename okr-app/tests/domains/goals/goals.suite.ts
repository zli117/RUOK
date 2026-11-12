/**
 * Shared goals contract suite (WP04 / T015, T016).
 *
 * Runs identically against both SQLite and PostgreSQL adapters. It exercises
 * the year → month → key result → progress/reflection journey while preserving
 * parent links, weights, scoreLabel, custom-query links, null-month reflection
 * behavior, per-user scope and precise boolean/date serialization (FR-007).
 */
import { describe, it, expect } from 'vitest';
import type { DbFixture } from '../../db/fixtures';

export type FixtureFactory = () => Promise<DbFixture>;

export function goalsSuite(label: string, createFixture: FixtureFactory) {
	describe(`goals domain contract (${label})`, () => {
		it('creates objectives and scopes them per user', async () => {
			const { services, teardown } = await createFixture();
			try {
				await services.users.create({ id: 'u1', username: 'alice', passwordHash: 'h' });
				await services.users.create({ id: 'u2', username: 'bob', passwordHash: 'h' });
				const now = new Date();
				await services.objectives.create({
					id: 'yearly',
					userId: 'u1',
					title: 'Yearly focus',
					level: 'yearly',
					year: 2025,
					weight: 1,
					createdAt: now,
					updatedAt: now
				});
				await services.objectives.create({
					id: 'monthly',
					userId: 'u2',
					title: 'Bob monthly',
					level: 'monthly',
					year: 2025,
					month: 3,
					createdAt: now,
					updatedAt: now
				});

				const aliceObjectives = await services.objectives.listByUser('u1');
				expect(aliceObjectives).toHaveLength(1);
				expect(aliceObjectives[0].id).toBe('yearly');
				// Foreign user isolation: Bob's objective is invisible to Alice.
				expect(aliceObjectives.some((o) => o.id === 'monthly')).toBe(false);
				expect(aliceObjectives[0].month).toBeNull();

				const bobObjectives = await services.objectives.listByUser('u2');
				expect(bobObjectives).toHaveLength(1);
				expect(bobObjectives[0].month).toBe(3);
			} finally {
				await teardown();
			}
		});

		it('preserves parent links, weight, description and timestamps', async () => {
			const { services, teardown } = await createFixture();
			try {
				await services.users.create({ id: 'u1', username: 'alice', passwordHash: 'h' });
				const t = new Date();
				await services.objectives.create({
					id: 'parent',
					userId: 'u1',
					title: 'Parent',
					level: 'yearly',
					year: 2025,
					createdAt: t,
					updatedAt: t
				});
				const child = await services.objectives.create({
					id: 'child',
					userId: 'u1',
					title: 'Child',
					description: 'desc',
					level: 'monthly',
					year: 2025,
					month: 6,
					weight: 0.5,
					parentId: 'parent',
					category: 'health',
					colorIndex: 2,
					createdAt: t,
					updatedAt: t
				});
				expect(child.parentId).toBe('parent');
				expect(child.weight).toBeCloseTo(0.5);
				expect(child.description).toBe('desc');
				expect(child.category).toBe('health');
				expect(child.colorIndex).toBe(2);
				expect(child.updatedAt.getTime() % 1000).toBe(0);
			} finally {
				await teardown();
			}
		});

		it('updates and removes objectives with missing-row semantics', async () => {
			const { services, teardown } = await createFixture();
			try {
				await services.users.create({ id: 'u1', username: 'alice', passwordHash: 'h' });
				await services.objectives.create({
					id: 'o1',
					userId: 'u1',
					title: 'Old title',
					level: 'yearly',
					year: 2025
				});
				const updated = await services.objectives.update('o1', {
					title: 'New title',
					weight: 0.9
				});
				expect(updated!.title).toBe('New title');
				expect(updated!.weight).toBeCloseTo(0.9);

				expect(await services.objectives.update('missing', { title: 'x' })).toBeUndefined();
				expect(await services.objectives.findById('missing')).toBeUndefined();
				expect(await services.objectives.remove('o1')).toBe(1);
				expect(await services.objectives.remove('o1')).toBe(0);
			} finally {
				await teardown();
			}
		});

		it('manages key results with ordering, scoreLabel and custom-query links', async () => {
			const { services, teardown } = await createFixture();
			try {
				await services.users.create({ id: 'u1', username: 'alice', passwordHash: 'h' });
				await services.objectives.create({
					id: 'o1',
					userId: 'u1',
					title: 'Objective',
					level: 'yearly',
					year: 2025
				});
				await services.keyResults.create({
					id: 'kr2',
					objectiveId: 'o1',
					title: 'KR two',
					sortOrder: 2,
					weight: 1,
					measurementType: 'custom_query',
					progressQueryId: 'q1',
					progressQueryCode: 'return 1',
					widgetQueryId: 'w1',
					widgetQueryCode: 'return 2'
				});
				await services.keyResults.create({
					id: 'kr1',
					objectiveId: 'o1',
					title: 'KR one',
					sortOrder: 1,
					weight: 1,
					measurementType: 'slider',
					score: 0.25,
					scoreLabel: 'On track'
				});

				// Explicit ordering by sortOrder is preserved on both backends.
				const krs = await services.keyResults.listByObjective('o1');
				expect(krs.map((k) => k.id)).toEqual(['kr1', 'kr2']);

				const custom = await services.keyResults.findById('kr2');
				expect(custom!.measurementType).toBe('custom_query');
				expect(custom!.progressQueryId).toBe('q1');
				expect(custom!.progressQueryCode).toBe('return 1');
				expect(custom!.widgetQueryId).toBe('w1');
				expect(custom!.widgetQueryCode).toBe('return 2');

				const slider = await services.keyResults.findById('kr1');
				expect(slider!.scoreLabel).toBe('On track');
				expect(slider!.score).toBeCloseTo(0.25);

				// Update score and scoreLabel (progress update path).
				const updated = await services.keyResults.update('kr1', {
					score: 0.8,
					scoreLabel: 'Done',
					updatedAt: new Date()
				});
				expect(updated!.score).toBeCloseTo(0.8);
				expect(updated!.scoreLabel).toBe('Done');

				expect(await services.keyResults.remove('kr2')).toBe(1);
				expect(await services.keyResults.remove('kr2')).toBe(0);
				expect(await services.keyResults.findById('missing')).toBeUndefined();
			} finally {
				await teardown();
			}
		});

		it('stores reflections with null-month behavior and per-user scope', async () => {
			const { services, teardown } = await createFixture();
			try {
				await services.users.create({ id: 'u1', username: 'alice', passwordHash: 'h' });
				await services.users.create({ id: 'u2', username: 'bob', passwordHash: 'h' });

				// Yearly reflection has a NULL month.
				const yearly = await services.objectiveReflections.create({
					id: 'r-year',
					userId: 'u1',
					level: 'yearly',
					year: 2025,
					month: null,
					reflection: 'Year in review'
				});
				expect(yearly.month).toBeNull();

				// Monthly reflection carries a month.
				const monthly = await services.objectiveReflections.create({
					id: 'r-march',
					userId: 'u1',
					level: 'monthly',
					year: 2025,
					month: 3,
					reflection: 'March'
				});
				expect(monthly.month).toBe(3);

				const foundYearly = await services.objectiveReflections.findByUserLevelYearMonth({
					userId: 'u1',
					level: 'yearly',
					year: 2025,
					month: null
				});
				expect(foundYearly!.reflection).toBe('Year in review');

				const foundMonthly = await services.objectiveReflections.findByUserLevelYearMonth({
					userId: 'u1',
					level: 'monthly',
					year: 2025,
					month: 3
				});
				expect(foundMonthly!.reflection).toBe('March');

				// Foreign user cannot read Alice's reflection.
				const bobLookup = await services.objectiveReflections.findByUserLevelYearMonth({
					userId: 'u2',
					level: 'yearly',
					year: 2025,
					month: null
				});
				expect(bobLookup).toBeUndefined();

				// Multiple NULL-month reflections are permitted (NULLS DISTINCT).
				await services.objectiveReflections.create({
					id: 'r-year-2',
					userId: 'u1',
					level: 'yearly',
					year: 2024,
					month: null,
					reflection: 'Older year'
				});

				// Update path returns the updated row.
				const updated = await services.objectiveReflections.update('r-year', {
					reflection: 'Revised year',
					updatedAt: new Date()
				});
				expect(updated!.reflection).toBe('Revised year');

				expect(
					await services.objectiveReflections.findByUserLevelYearMonth({
						userId: 'u1',
						level: 'yearly',
						year: 2025,
						month: null
					})
				).toBeDefined();
			} finally {
				await teardown();
			}
		});

		it('joins objectives with key results deterministically', async () => {
			const { services, teardown } = await createFixture();
			try {
				await services.users.create({ id: 'u1', username: 'alice', passwordHash: 'h' });
				await services.objectives.create({
					id: 'o1',
					userId: 'u1',
					title: 'Objective',
					level: 'yearly',
					year: 2025
				});
				await services.keyResults.create({
					id: 'kr1',
					objectiveId: 'o1',
					title: 'KR',
					sortOrder: 1
				});
				const joined = await services.objectives.listByUserWithKeyResults('u1');
				expect(joined).toHaveLength(1);
				expect(joined[0].objective.id).toBe('o1');
				expect(joined[0].keyResults.map((k) => k.id)).toEqual(['kr1']);
			} finally {
				await teardown();
			}
		});
	});
}
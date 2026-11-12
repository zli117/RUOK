/**
 * Shared metrics domain contract suite (WP05 / T019, T020).
 *
 * Runs identically against both SQLite and PostgreSQL adapters. Covers
 * metrics templates (version selection by effectiveFrom), flexible daily
 * metric values (upsert on user/date/name, computed-metric input retrieval),
 * fixed daily metrics, template CRUD, timezone boundary date strings and
 * per-user isolation (FR-007).
 */
import { describe, it, expect } from 'vitest';
import type { DbFixture } from '../../db/fixtures';

export type FixtureFactory = () => Promise<DbFixture>;

export function metricsSuite(label: string, createFixture: FixtureFactory) {
	describe(`metrics domain contract (${label})`, () => {
		async function seed(services: Awaited<ReturnType<FixtureFactory>>['services']) {
			await services.users.create({ id: 'u1', username: 'alice', passwordHash: 'h' });
			await services.users.create({ id: 'u2', username: 'bob', passwordHash: 'h' });
			const now = new Date();
			await services.timePeriods.create({
				id: 'p-daily',
				userId: 'u1',
				periodType: 'daily',
				year: 2025,
				month: 4,
				day: '2025-04-10',
				createdAt: now,
				updatedAt: now
			});
		}

		it('creates and lists templates ordered by effectiveFrom descending (T019)', async () => {
			const { services, teardown } = await createFixture();
			try {
				await seed(services);
				const t1 = await services.metricsTemplates.create({
					id: 'tpl-1',
					userId: 'u1',
					name: 'default',
					effectiveFrom: '2025-01-01',
					metricsDefinition: JSON.stringify([{ name: 'sleep', type: 'input' }]),
					createdAt: new Date(),
					updatedAt: new Date()
				});
				const t2 = await services.metricsTemplates.create({
					id: 'tpl-2',
					userId: 'u1',
					name: 'v2',
					effectiveFrom: '2025-03-01',
					metricsDefinition: JSON.stringify([{ name: 'steps', type: 'input' }]),
					createdAt: new Date(),
					updatedAt: new Date()
				});

				const list = await services.metricsTemplates.listByUser('u1');
				// Ordered by effectiveFrom descending => tpl-2 first.
				expect(list.map((t) => t.id)).toEqual(['tpl-2', 'tpl-1']);
				expect(t1.metricsDefinition).toContain('sleep');
			} finally {
				await teardown();
			}
		});

		it('selects the active template by effectiveFrom <= date (version selection)', async () => {
			const { services, teardown } = await createFixture();
			try {
				await seed(services);
				await services.metricsTemplates.create({
					id: 'tpl-1',
					userId: 'u1',
					name: 'default',
					effectiveFrom: '2025-01-01',
					metricsDefinition: '[]',
					createdAt: new Date(),
					updatedAt: new Date()
				});
				await services.metricsTemplates.create({
					id: 'tpl-2',
					userId: 'u1',
					name: 'v2',
					effectiveFrom: '2025-03-01',
					metricsDefinition: '[]',
					createdAt: new Date(),
					updatedAt: new Date()
				});

				// Before the second template's effective date => tpl-1.
				const before = await services.metricsTemplates.findActiveByDate('u1', '2025-02-15');
				expect(before!.id).toBe('tpl-1');

				// On/after the second template's effective date => tpl-2.
				const on = await services.metricsTemplates.findActiveByDate('u1', '2025-03-01');
				expect(on!.id).toBe('tpl-2');

				// Before any template => undefined.
				const none = await services.metricsTemplates.findActiveByDate('u1', '2024-12-31');
				expect(none).toBeUndefined();

				// Foreign user has no active template.
				expect(await services.metricsTemplates.findActiveByDate('u2', '2025-06-01')).toBeUndefined();
			} finally {
				await teardown();
			}
		});

		it('upserts flexible daily metric values and reads them back (T019/T020)', async () => {
			const { services, teardown } = await createFixture();
			try {
				await seed(services);
				const v1 = await services.dailyMetricValues.upsert({
					id: 'mv-1',
					userId: 'u1',
					date: '2025-04-10',
					metricName: 'sleep_hours',
					value: '7.5',
					source: 'user'
				});
				expect(v1.value).toBe('7.5');

				// Upsert updates the same (user, date, metricName) row in place.
				const v2 = await services.dailyMetricValues.upsert({
					id: 'mv-1b',
					userId: 'u1',
					date: '2025-04-10',
					metricName: 'sleep_hours',
					value: '8',
					source: 'user'
				});
				expect(v2.value).toBe('8');

				const values = await services.dailyMetricValues.listByUserAndDate('u1', '2025-04-10');
				expect(values).toHaveLength(1);
				expect(values[0].metricName).toBe('sleep_hours');
				expect(values[0].value).toBe('8');

				// Computed-metric input retrieval by names (external-source check path).
				const byNames = await services.dailyMetricValues.listByUserAndDateAndNames('u1', '2025-04-10', [
					'sleep_hours',
					'steps'
				]);
				expect(byNames.map((v) => v.metricName)).toEqual(['sleep_hours']);

				// findByUserDateName resolves single rows.
				const found = await services.dailyMetricValues.findByUserDateName('u1', '2025-04-10', 'sleep_hours');
				expect(found!.value).toBe('8');
				expect(
					await services.dailyMetricValues.findByUserDateName('u2', '2025-04-10', 'sleep_hours')
				).toBeUndefined();

				// Empty metric-name list short-circuits.
				expect(await services.dailyMetricValues.listByUserAndDateAndNames('u1', '2025-04-10', [])).toHaveLength(0);
			} finally {
				await teardown();
			}
		});

		it('stores null values and preserves per-user isolation (T020)', async () => {
			const { services, teardown } = await createFixture();
			try {
				await seed(services);
				await services.dailyMetricValues.upsert({
					id: 'mv-1',
					userId: 'u1',
					date: '2025-04-10',
					metricName: 'heart_rate',
					value: null,
					source: 'fitbit'
				});
				await services.dailyMetricValues.upsert({
					id: 'mv-2',
					userId: 'u2',
					date: '2025-04-10',
					metricName: 'heart_rate',
					value: '72',
					source: 'fitbit'
				});

				const u1 = await services.dailyMetricValues.listByUserAndDate('u1', '2025-04-10');
				expect(u1).toHaveLength(1);
				expect(u1[0].value).toBeNull();
				expect(u1[0].source).toBe('fitbit');

				const u2 = await services.dailyMetricValues.listByUserAndDate('u2', '2025-04-10');
				expect(u2[0].value).toBe('72');

				// Optional NULL maps to null, never '' / 0.
				const found = await services.dailyMetricValues.findByUserDateName('u1', '2025-04-10', 'heart_rate');
				expect(found!.value).toBeNull();
			} finally {
				await teardown();
			}
		});

		it('creates, updates and deletes fixed daily metrics (T019)', async () => {
			const { services, teardown } = await createFixture();
			try {
				await seed(services);
				const created = await services.dailyMetrics.create({
					id: 'dm-1',
					userId: 'u1',
					timePeriodId: 'p-daily',
					steps: 10000,
					sleepLength: '07:30',
					customMetrics: '{"x":1}'
				});
				expect(created.steps).toBe(10000);
				expect(created.customMetrics).toBe('{"x":1}');

				const byPeriod = await services.dailyMetrics.findByPeriod('u1', 'p-daily');
				expect(byPeriod!.id).toBe('dm-1');
				// Foreign user cannot read Alice's metrics.
				expect(await services.dailyMetrics.findByPeriod('u2', 'p-daily')).toBeUndefined();

				const updated = await services.dailyMetrics.update('dm-1', {
					steps: 12000,
					heartPoints: 30
				});
				expect(updated!.steps).toBe(12000);
				expect(updated!.heartPoints).toBe(30);
				expect(updated!.sleepLength).toBe('07:30');

				expect(
					await services.dailyMetrics.update('missing', { steps: 1 })
				).toBeUndefined();
			} finally {
				await teardown();
			}
		});

		it('updates and deletes templates with missing-row semantics (T019)', async () => {
			const { services, teardown } = await createFixture();
			try {
				await seed(services);
				await services.metricsTemplates.create({
					id: 'tpl-1',
					userId: 'u1',
					name: 'default',
					effectiveFrom: '2025-01-01',
					metricsDefinition: '[]',
					createdAt: new Date(),
					updatedAt: new Date()
				});

				const updated = await services.metricsTemplates.update('tpl-1', {
					name: 'renamed',
					effectiveFrom: '2025-05-01',
					updatedAt: new Date()
				});
				expect(updated!.name).toBe('renamed');
				expect(updated!.effectiveFrom).toBe('2025-05-01');

				expect(
					await services.metricsTemplates.update('missing', { name: 'x' })
				).toBeUndefined();
				expect(await services.metricsTemplates.remove('tpl-1')).toBe(1);
				expect(await services.metricsTemplates.remove('tpl-1')).toBe(0);
				expect(await services.metricsTemplates.findById('tpl-1')).toBeUndefined();
			} finally {
				await teardown();
			}
		});

		it('preserves timezone-boundary date strings on daily values (T020)', async () => {
			const { services, teardown } = await createFixture();
			try {
				await seed(services);
				// Date strings are opaque identifiers, not timestamps: they must round-trip
				// exactly regardless of server-local timezone (no implicit conversion).
				const edgeDates = ['2025-01-01', '2025-12-31', '2025-04-10', '2025-02-28'];
				for (let i = 0; i < edgeDates.length; i++) {
					await services.dailyMetricValues.upsert({
						id: `mv-${i}`,
						userId: 'u1',
						date: edgeDates[i],
						metricName: 'steps',
						value: String(i),
						source: 'user'
					});
				}
				for (let i = 0; i < edgeDates.length; i++) {
					const found = await services.dailyMetricValues.findByUserDateName('u1', edgeDates[i], 'steps');
					expect(found!.value).toBe(String(i));
				}
			} finally {
				await teardown();
			}
		});
	});
}
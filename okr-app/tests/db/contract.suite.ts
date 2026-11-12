/**
 * Shared real-backend persistence contract suite (FR-003 / FR-011).
 *
 * Runs identically against a real SQLite and a real PostgreSQL backend. It
 * asserts the typed boundary's observable behavior: CRUD, JOIN, UPSERT, COUNT,
 * bounded atomic rollback and the codec contract (boolean, Date second
 * precision, null, >32-bit millisecond values).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseServices } from '../../src/lib/db/contracts';
import type {
	NewKeyResultRow,
	NewObjectiveRow,
	NewTaskRow,
	NewTimePeriodRow,
	NewUserRow,
	ObjectivePatch,
	TaskPatch,
	UserPatch
} from '../../src/lib/db/models';
import { toSecondPrecision } from '../../src/lib/db/models';

export interface Fixture {
	services: DatabaseServices;
	teardown(): Promise<void>;
}

export type FixtureFactory = () => Promise<Fixture>;

// Fixed dates (UTC, second precision) for deterministic assertions.
const T0 = new Date(Date.UTC(2026, 0, 15, 12, 30, 45, 0));
const T1 = new Date(Date.UTC(2026, 1, 2, 8, 5, 10, 0));

function makeUser(id: string, username: string, over: Partial<NewUserRow> = {}): NewUserRow {
	return {
		id,
		username,
		passwordHash: '$2b$10$test.hash',
		weekStartDay: 'monday',
		timezone: 'UTC',
		createdAt: T0,
		...over
	};
}

function makeObjective(id: string, userId: string, over: Partial<NewObjectiveRow> = {}): NewObjectiveRow {
	return {
		id,
		userId,
		title: 'Objective',
		level: 'yearly',
		year: 2026,
		weight: 1.0,
		createdAt: T0,
		updatedAt: T0,
		...over
	};
}

function makeKeyResult(id: string, objectiveId: string, over: Partial<NewKeyResultRow> = {}): NewKeyResultRow {
	return {
		id,
		objectiveId,
		title: 'Key result',
		weight: 1.0,
		score: 0,
		sortOrder: 0,
		createdAt: T0,
		updatedAt: T0,
		...over
	};
}

function makeTimePeriod(id: string, userId: string, over: Partial<NewTimePeriodRow> = {}): NewTimePeriodRow {
	return {
		id,
		userId,
		periodType: 'daily',
		year: 2026,
		createdAt: T0,
		updatedAt: T0,
		...over
	};
}

function makeTask(id: string, userId: string, over: Partial<NewTaskRow> = {}): NewTaskRow {
	return {
		id,
		userId,
		timePeriodId: '',
		title: 'Task',
		completed: false,
		timeSpentMs: 0,
		createdAt: T0,
		updatedAt: T0,
		...over
	};
}

export function contractSuite(label: string, makeFixture: FixtureFactory): void {
	describe(`persistence contract [${label}]`, () => {
		let fixture: Fixture;
		let services: DatabaseServices;

		beforeEach(async () => {
			fixture = await makeFixture();
			services = fixture.services;
		});

		afterEach(async () => {
			// Guard: fixture may be undefined if beforeEach setup (e.g. the
			// database provisioning) failed, in which case there is nothing to
			// tear down and the original error should surface, not a new one.
			await fixture?.teardown();
		});

		// ---------------------------------------------------------------
		// users CRUD
		// ---------------------------------------------------------------
		it('inserts and reads back a user', async () => {
			const created = await services.users.create(makeUser('u1', 'alice'));
			expect(created.id).toBe('u1');
			expect(created.username).toBe('alice');
			expect(created.createdAt.getTime()).toBe(T0.getTime());

			const found = await services.users.findById('u1');
			expect(found).toEqual(created);
			expect(found?.isAdmin).toBe(false);
			expect(found?.bgColor).toBeNull();
		});

		it('finds a user by username', async () => {
			await services.users.create(makeUser('u1', 'alice'));
			const found = await services.users.findByUsername('alice');
			expect(found?.id).toBe('u1');
			expect(await services.users.findByUsername('missing')).toBeUndefined();
		});

		it('updates a user and returns the canonical row', async () => {
			await services.users.create(makeUser('u1', 'alice'));
			const patch: UserPatch = { timezone: 'Europe/Samara', isAdmin: true, bgColor: '#EFEFF6' };
			const updated = await services.users.update('u1', patch);
			expect(updated?.timezone).toBe('Europe/Samara');
			expect(updated?.isAdmin).toBe(true);
			expect(updated?.bgColor).toBe('#EFEFF6');
			expect(updated?.username).toBe('alice');

			const missing = await services.users.update('nope', patch);
			expect(missing).toBeUndefined();
		});

		it('lists, counts and deletes users', async () => {
			await services.users.create(makeUser('u1', 'alice'));
			await services.users.create(makeUser('u2', 'bob'));
			expect(await services.users.count()).toBe(2);
			expect((await services.users.list()).map((u) => u.username).sort()).toEqual(['alice', 'bob']);

			expect(await services.users.remove('u1')).toBe(1);
			expect(await services.users.count()).toBe(1);
			expect(await services.users.findById('u1')).toBeUndefined();
			expect(await services.users.remove('u1')).toBe(0);
		});

		// ---------------------------------------------------------------
		// codec: boolean
		// ---------------------------------------------------------------
		it('round-trips booleans distinctly (true/false), not 0/1 or missing', async () => {
			await services.users.create(
				makeUser('u1', 'alice', { isAdmin: true, isDisabled: false })
			);
			await services.users.create(
				makeUser('u2', 'bob', { isAdmin: false, isDisabled: true })
			);
			const a = await services.users.findById('u1');
			const b = await services.users.findById('u2');
			expect(a?.isAdmin).toBe(true);
			expect(a?.isDisabled).toBe(false);
			expect(b?.isAdmin).toBe(false);
			expect(b?.isDisabled).toBe(true);
		});

		// ---------------------------------------------------------------
		// codec: optional NULL -> null
		// ---------------------------------------------------------------
		it('maps optional SQL NULL to null (not empty string / false / 0)', async () => {
			await services.users.create(makeUser('u1', 'alice'));
			const user = await services.users.findById('u1');
			expect(user?.bgColor).toBeNull();

			await services.objectives.create(makeObjective('o1', 'u1', { description: null, month: null }));
			const obj = await services.objectives.findById('o1');
			expect(obj?.description).toBeNull();
			expect(obj?.month).toBeNull();
			expect(obj?.parentId).toBeNull();
		});

		// ---------------------------------------------------------------
		// codec: Date second precision
		// ---------------------------------------------------------------
		it('normalizes timestamps to second precision on both backends', async () => {
			const subSecond = new Date(Date.UTC(2026, 0, 15, 12, 30, 45, 789));
			await services.users.create(makeUser('u1', 'alice', { createdAt: subSecond }));
			const user = await services.users.findById('u1');
			expect(user?.createdAt.getTime()).toBe(toSecondPrecision(subSecond).getTime());
			expect(user?.createdAt.getTime()).toBe(T0.getTime());
			expect(user?.createdAt.getMilliseconds()).toBe(0);
		});

		// ---------------------------------------------------------------
		// codec: >32-bit millisecond values
		// ---------------------------------------------------------------
		it('stores and reads a >32-bit millisecond value without truncation', async () => {
			// 4,000,000,000 ms > Number.MAX_SAFE_INTEGER? no — but > 2^31-1 (2,147,483,647).
			const bigMs = 4_000_000_000;
			expect(bigMs).toBeGreaterThan(2 ** 31 - 1);
			await services.users.create(makeUser('u1', 'alice'));
			const tp = await services.timePeriods.create(makeTimePeriod('tp1', 'u1'));
			await services.tasks.create(
				makeTask('t1', 'u1', { timePeriodId: tp.id, completed: true, timeSpentMs: bigMs })
			);
			const task = await services.tasks.findById('t1');
			expect(task?.timeSpentMs).toBe(bigMs);
			expect(task?.completed).toBe(true);
		});

		// ---------------------------------------------------------------
		// tasks CRUD
		// ---------------------------------------------------------------
		it('updates and deletes tasks, returning canonical values', async () => {
			await services.users.create(makeUser('u1', 'alice'));
			const tp = await services.timePeriods.create(makeTimePeriod('tp1', 'u1'));
			await services.tasks.create(
				makeTask('t1', 'u1', { timePeriodId: tp.id, timeSpentMs: 123 })
			);
			const patch: TaskPatch = { completed: true, timeSpentMs: 456 };
			const updated = await services.tasks.update('t1', patch);
			expect(updated?.completed).toBe(true);
			expect(updated?.timeSpentMs).toBe(456);
			expect(await services.tasks.remove('t1')).toBe(1);
			expect(await services.tasks.findById('t1')).toBeUndefined();
		});

		// ---------------------------------------------------------------
		// time periods CRUD + codec (date fields, nullable week/day)
		// ---------------------------------------------------------------
		it('creates, reads and counts time periods with nullable fields', async () => {
			await services.users.create(makeUser('u1', 'alice'));
			const created = await services.timePeriods.create(
				makeTimePeriod('tp1', 'u1', {
					periodType: 'monthly',
					month: 2,
					week: null,
					day: null,
					notes: 'focus'
				})
			);
			expect(created.month).toBe(2);
			expect(created.week).toBeNull();
			expect(created.day).toBeNull();
			expect(created.notes).toBe('focus');

			const found = await services.timePeriods.findById('tp1');
			expect(found).toEqual(created);
			expect(await services.timePeriods.count()).toBe(1);
			expect(await services.timePeriods.findById('nope')).toBeUndefined();
		});

		// ---------------------------------------------------------------
		// objectives CRUD + count
		// ---------------------------------------------------------------
		it('creates, updates and counts objectives', async () => {
			await services.users.create(makeUser('u1', 'alice'));
			const created = await services.objectives.create(makeObjective('o1', 'u1'));
			expect(created.year).toBe(2026);
			expect(created.weight).toBe(1.0);

			const patch: ObjectivePatch = { title: 'Renamed', weight: 0.8, category: 'Health' };
			const updated = await services.objectives.update('o1', patch);
			expect(updated?.title).toBe('Renamed');
			expect(updated?.weight).toBe(0.8);
			expect(updated?.category).toBe('Health');

			expect(await services.objectives.count()).toBe(1);
			expect(await services.objectives.findById('o1')?.then((o) => o?.title)).toBe('Renamed');
		});

		// ---------------------------------------------------------------
		// objective UPSERT
		// ---------------------------------------------------------------
		it('upserts: inserts on new key and updates on existing key', async () => {
			await services.users.create(makeUser('u1', 'alice'));
			const inserted = await services.objectives.upsert(makeObjective('o1', 'u1', { title: 'First' }));
			expect(inserted.title).toBe('First');
			expect(await services.objectives.count()).toBe(1);

			const updated = await services.objectives.upsert(
				makeObjective('o1', 'u1', { title: 'Second', weight: 0.5 })
			);
			expect(updated.title).toBe('Second');
			expect(updated.weight).toBe(0.5);
			expect(await services.objectives.count()).toBe(1);
			expect((await services.objectives.findById('o1'))?.title).toBe('Second');
		});

		// ---------------------------------------------------------------
		// objective JOIN with key results
		// ---------------------------------------------------------------
		it('joins objectives with their key results', async () => {
			await services.users.create(makeUser('u1', 'alice'));
			await services.objectives.create(makeObjective('o1', 'u1', { title: 'A' }));
			await services.objectives.create(makeObjective('o2', 'u1', { title: 'B' }));
			await services.keyResults.create(makeKeyResult('k1', 'o1', { title: 'KR1' }));
			await services.keyResults.create(makeKeyResult('k2', 'o1', { title: 'KR2' }));
			await services.keyResults.create(makeKeyResult('k3', 'o2', { title: 'KR3' }));

			const joined = await services.objectives.listByUserWithKeyResults('u1');
			expect(joined).toHaveLength(2);
			const a = joined.find((e) => e.objective.id === 'o1');
			expect(a?.keyResults.map((k) => k.id).sort()).toEqual(['k1', 'k2']);
			expect(joined.find((e) => e.objective.id === 'o2')?.keyResults).toHaveLength(1);
		});

		it('lists and removes key results', async () => {
			await services.users.create(makeUser('u1', 'alice'));
			await services.objectives.create(makeObjective('o1', 'u1'));
			await services.keyResults.create(makeKeyResult('k1', 'o1'));
			await services.keyResults.create(makeKeyResult('k2', 'o1'));
			expect((await services.keyResults.listByObjective('o1')).map((k) => k.id).sort()).toEqual([
				'k1',
				'k2'
			]);
			expect(await services.keyResults.remove('k1')).toBe(1);
			expect((await services.keyResults.listByObjective('o1')).map((k) => k.id)).toEqual(['k2']);
		});

		// ---------------------------------------------------------------
		// bounded atomic operation
		// ---------------------------------------------------------------
		it('creates a user with initial data atomically (commit path)', async () => {
			const user = await services.createUserWithInitialData({
				user: makeUser('u1', 'alice'),
				objectives: [
					{
						objective: makeObjective('o1', 'u1', { title: 'Yearly goal' }),
						keyResults: [makeKeyResult('k1', 'o1', { title: 'KR A' }), makeKeyResult('k2', 'o1', { title: 'KR B' })]
					}
				]
			});
			expect(user.id).toBe('u1');
			expect(await services.users.findById('u1')).toBeDefined();
			expect((await services.keyResults.listByObjective('o1')).map((k) => k.title).sort()).toEqual([
				'KR A',
				'KR B'
			]);
		});

		it('rolls back the whole operation when an injected insert fails', async () => {
			// Seed user u1 + objective o1 (committed).
			await services.createUserWithInitialData({
				user: makeUser('u1', 'alice'),
				objectives: [{ objective: makeObjective('o1', 'u1'), keyResults: [] }]
			});

			// Second atomic op: the objective id collides with the existing o1
			// PK, so the transaction must fail AFTER the user insert, and the
			// entire operation (including the new user u2) must roll back.
			await expect(
				services.createUserWithInitialData({
					user: makeUser('u2', 'bob'),
					objectives: [{ objective: makeObjective('o1', 'u2'), keyResults: [] }]
				})
			).rejects.toThrow();

			// The injected failure rolled back the u2 user and any partial data.
			expect(await services.users.findById('u2')).toBeUndefined();
			expect(await services.users.count()).toBe(1);
			// The pre-existing committed data is untouched.
			expect(await services.objectives.findById('o1')).toBeDefined();
			expect(await services.users.findById('u1')).toBeDefined();
		});
	});
}
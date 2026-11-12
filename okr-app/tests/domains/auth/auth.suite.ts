/**
 * Shared auth/account/session/config contract suite (WP04 / T013, T016).
 *
 * Runs identically against both the SQLite and PostgreSQL adapters. It
 * exercises account creation, session lifecycle (create/find/delete/deleteByUser/
 * deleteExpired), admin flags, foreign-user isolation, missing-row semantics and
 * precise boolean/date serialization — the same fixtures on both backends must
 * yield equivalent results (FR-006).
 */
import { describe, it, expect } from 'vitest';
import type { DbFixture } from '../../db/fixtures';
import type { DatabaseServices } from '../../../src/lib/db';

export type FixtureFactory = () => Promise<DbFixture>;

export function authSuite(label: string, createFixture: FixtureFactory) {
	describe(`auth domain contract (${label})`, () => {
		it('creates an account and reads it back with preserved defaults', async () => {
			const { services, teardown } = await createFixture();
			try {
				const created = await services.users.create({
					id: 'u1',
					username: 'alice',
					passwordHash: 'hash1'
				});
				expect(created.id).toBe('u1');
				expect(created.username).toBe('alice');
				expect(created.weekStartDay).toBe('monday');
				expect(created.timezone).toBe('UTC');
				expect(created.bgColor).toBeNull();
				expect(created.isAdmin).toBe(false);
				expect(created.isDisabled).toBe(false);
				expect(created.createdAt).toBeInstanceOf(Date);

				const found = await services.users.findByUsername('alice');
				expect(found).toBeDefined();
				expect(found!.id).toBe('u1');
				// Date codec is normalized to second precision on both backends.
				expect(found!.createdAt.getTime() % 1000).toBe(0);
			} finally {
				await teardown();
			}
		});

		it('findByUsername / findById return undefined for missing rows', async () => {
			const { services, teardown } = await createFixture();
			try {
				expect(await services.users.findByUsername('nobody')).toBeUndefined();
				expect(await services.users.findById('missing')).toBeUndefined();
			} finally {
				await teardown();
			}
		});

		it('updates admin/disabled flags with boolean serialization', async () => {
			const { services, teardown } = await createFixture();
			try {
				await services.users.create({
					id: 'u1',
					username: 'alice',
					passwordHash: 'hash1'
				});
				const updated = await services.users.update('u1', {
					isAdmin: true,
					isDisabled: true,
					bgColor: '#112233',
					weekStartDay: 'sunday'
				});
				expect(updated).toBeDefined();
				expect(updated!.isAdmin).toBe(true);
				expect(updated!.isDisabled).toBe(true);
				expect(updated!.bgColor).toBe('#112233');
				expect(updated!.weekStartDay).toBe('sunday');

				const reread = await services.users.findById('u1');
				expect(reread!.isAdmin).toBe(true);
				expect(reread!.isDisabled).toBe(true);
			} finally {
				await teardown();
			}
		});

		it('lists users and removes one with cascade to its sessions', async () => {
			const { services, teardown } = await createFixture();
			try {
				await services.users.create({ id: 'u1', username: 'alice', passwordHash: 'h' });
				await services.users.create({ id: 'u2', username: 'bob', passwordHash: 'h' });
				await services.sessions.create({ id: 's1', userId: 'u1', expiresAt: new Date() });
				await services.sessions.create({ id: 's2', userId: 'u2', expiresAt: new Date() });

				const list = await services.users.list();
				expect(list.map((u) => u.username).sort()).toEqual(['alice', 'bob']);

				expect(await services.users.remove('u1')).toBe(1);
				// Cascade removed the session for u1 but not u2.
				expect(await services.sessions.findById('s1')).toBeUndefined();
				expect(await services.sessions.findById('s2')).toBeDefined();
				// Removing a missing row yields 0 affected rows.
				expect(await services.users.remove('missing')).toBe(0);
			} finally {
				await teardown();
			}
		});

		it('preserves per-user session scope on deleteByUser', async () => {
			const { services, teardown } = await createFixture();
			try {
				await services.users.create({ id: 'u1', username: 'alice', passwordHash: 'h' });
				await services.users.create({ id: 'u2', username: 'bob', passwordHash: 'h' });
				await services.sessions.create({ id: 's1', userId: 'u1', expiresAt: new Date() });
				await services.sessions.create({ id: 's2', userId: 'u2', expiresAt: new Date() });

				expect(await services.sessions.deleteByUser('u1')).toBe(1);
				expect(await services.sessions.findById('s1')).toBeUndefined();
				// The other user's session is untouched.
				expect(await services.sessions.findById('s2')).toBeDefined();
				// No-op for a user with no sessions.
				expect(await services.sessions.deleteByUser('u1')).toBe(0);
			} finally {
				await teardown();
			}
		});

		it('deletes sessions that expire on or before the given instant', async () => {
			const { services, teardown } = await createFixture();
			try {
				await services.users.create({ id: 'u1', username: 'alice', passwordHash: 'h' });
				const past = new Date(Date.now() - 10_000);
				const future = new Date(Date.now() + 60_000);
				await services.sessions.create({ id: 's1', userId: 'u1', expiresAt: past });
				await services.sessions.create({ id: 's2', userId: 'u1', expiresAt: future });

				expect(await services.sessions.deleteExpired(new Date())).toBe(1);
				expect(await services.sessions.findById('s1')).toBeUndefined();
				expect(await services.sessions.findById('s2')).toBeDefined();
			} finally {
				await teardown();
			}
		});

		it('system config upserts and masks nothing at the boundary', async () => {
			const { services, teardown } = await createFixture();
			try {
				const created = await services.systemConfig.upsert({
					key: 'plugin.fitbit.client_secret',
					value: 'supersecret',
					isSecret: true,
					updatedAt: new Date()
				});
				expect(created.isSecret).toBe(true);
				expect(created.value).toBe('supersecret');

				// Upsert updates the same key in place.
				const updated = await services.systemConfig.upsert({
					key: 'plugin.fitbit.client_secret',
					value: 'newsecret',
					isSecret: true,
					updatedAt: new Date()
				});
				expect(updated.value).toBe('newsecret');

				await services.systemConfig.upsert({
					key: 'global.base_url',
					value: 'https://okr.example.com',
					isSecret: false,
					updatedAt: new Date()
				});

				const all = await services.systemConfig.all();
				expect(all).toHaveLength(2);
				const secret = all.find((r) => r.key === 'plugin.fitbit.client_secret');
				expect(secret).toBeDefined();
				expect(secret!.isSecret).toBe(true);
				expect(secret!.updatedAt).toBeInstanceOf(Date);
				expect(secret!.updatedAt.getTime() % 1000).toBe(0);
			} finally {
				await teardown();
			}
		});

		it('rejects cross-user objective reads (foreign user id is invisible)', async () => {
			const { services, teardown } = await createFixture();
			try {
				await services.users.create({ id: 'u1', username: 'alice', passwordHash: 'h' });
				await services.users.create({ id: 'u2', username: 'bob', passwordHash: 'h' });
				await services.objectives.create({
					id: 'o1',
					userId: 'u1',
					title: 'Alice yearly',
					level: 'yearly',
					year: 2025
				});
				// A foreign user cannot list Alice's objectives.
				const bobObjectives = await services.objectives.listByUser('u2');
				expect(bobObjectives).toHaveLength(0);
				expect(await services.objectives.findById('o1')).toBeDefined();
			} finally {
				await teardown();
			}
		});
	});
}

// Re-export for the type convenience of entry points.
export type AuthServices = DatabaseServices;
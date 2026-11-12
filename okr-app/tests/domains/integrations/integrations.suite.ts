/**
 * WP07 application-domain integration suite (T028).
 *
 * Runs identically against both SQLite and PostgreSQL adapters. Exercises the
 * domains cut over in WP07 — friends/notes privacy, saved queries, dashboard
 * widgets, plugins, AI config and query-execution audit logs — against real
 * backends. External AI/plugin providers are never invoked; only the typed
 * repository boundary and real database behavior are tested here.
 */
import { describe, it, expect } from 'vitest';
import type { DbFixture } from '../../db/fixtures';

export type FixtureFactory = () => Promise<DbFixture>;

export function integrationsSuite(label: string, createFixture: FixtureFactory) {
	describe(`application integrations contract (${label})`, () => {
		it('friend requests can be created, accepted and declined with per-user scope', async () => {
			const { services, teardown } = await createFixture();
			try {
				await services.users.create({ id: 'alice', username: 'alice', passwordHash: 'h' });
				await services.users.create({ id: 'bob', username: 'bob', passwordHash: 'h' });

				// Alice requests Bob.
				const req = await services.friendRequests.create({
					id: 'r1',
					fromUserId: 'alice',
					toUserId: 'bob',
					status: 'pending',
					createdAt: new Date()
				});
				expect(req.status).toBe('pending');

				// Duplicate pending request in either direction is detected.
				expect(await services.friendRequests.findPendingBetween('alice', 'bob')).toBeDefined();
				expect(await services.friendRequests.findPendingBetween('bob', 'alice')).toBeDefined();

				// Incoming/outgoing lists are correct.
				const incoming = await services.friendRequests.listIncomingPending('bob');
				expect(incoming.map((r) => r.fromUserId)).toEqual(['alice']);
				const outgoing = await services.friendRequests.listOutgoingPending('alice');
				expect(outgoing.map((r) => r.toUserId)).toEqual(['bob']);

				// Bob accepts → friendship is created, request becomes accepted.
				await services.friendRequests.update('r1', { status: 'accepted', respondedAt: new Date() });
				await services.friendships.create({
					id: 'f1',
					userId1: 'alice',
					userId2: 'bob',
					createdAt: new Date()
				});
				expect(await services.friendships.findBetween('alice', 'bob')).toBeDefined();
				expect((await services.friendships.findBetween('bob', 'alice'))!.id).toBe('f1');

				// A third user cannot see the friendship.
				await services.users.create({ id: 'carol', username: 'carol', passwordHash: 'h' });
				expect(await services.friendships.findBetween('carol', 'bob')).toBeUndefined();
				expect(await services.friendships.listForUser('alice')).toHaveLength(1);

				// Unfriend removes the friendship.
				await services.friendships.remove('f1');
				expect(await services.friendships.findBetween('alice', 'bob')).toBeUndefined();
			} finally {
				await teardown();
			}
		});

		it('declining a request keeps it non-pending and never creates a friendship', async () => {
			const { services, teardown } = await createFixture();
			try {
				await services.users.create({ id: 'alice', username: 'alice', passwordHash: 'h' });
				await services.users.create({ id: 'bob', username: 'bob', passwordHash: 'h' });
				await services.friendRequests.create({
					id: 'r1',
					fromUserId: 'alice',
					toUserId: 'bob',
					createdAt: new Date()
				});
				await services.friendRequests.update('r1', { status: 'declined', respondedAt: new Date() });
				expect(await services.friendRequests.findPendingBetween('alice', 'bob')).toBeUndefined();
				expect(await services.friendships.findBetween('alice', 'bob')).toBeUndefined();
			} finally {
				await teardown();
			}
		});

		it('friend notes are private to their author (per-user isolation)', async () => {
			const { services, teardown } = await createFixture();
			try {
				await services.users.create({ id: 'alice', username: 'alice', passwordHash: 'h' });
				await services.users.create({ id: 'bob', username: 'bob', passwordHash: 'h' });
				await services.friendships.create({
					id: 'f1',
					userId1: 'alice',
					userId2: 'bob',
					createdAt: new Date()
				});

				// Alice writes a private note about Bob.
				await services.friendNotes.upsert({
					id: 'n1',
					userId: 'alice',
					friendId: 'bob',
					note: 'secret about bob',
					updatedAt: new Date()
				});
				expect((await services.friendNotes.findByUserAndFriend('alice', 'bob'))!.note).toBe(
					'secret about bob'
				);
				// Bob cannot read Alice's note about him.
				expect(await services.friendNotes.findByUserAndFriend('bob', 'alice')).toBeUndefined();

				// Upsert updates in place (no duplicate).
				await services.friendNotes.upsert({
					id: 'n2',
					userId: 'alice',
					friendId: 'bob',
					note: 'revised secret',
					updatedAt: new Date()
				});
				const all = await services.friendNotes.findByUserAndFriend('alice', 'bob');
				expect(all!.note).toBe('revised secret');

				// Unfriending removes notes in both directions.
				await services.friendNotes.removeBetween('alice', 'bob');
				expect(await services.friendNotes.findByUserAndFriend('alice', 'bob')).toBeUndefined();
			} finally {
				await teardown();
			}
		});

		it('saved queries and dashboard widgets are scoped per user', async () => {
			const { services, teardown } = await createFixture();
			try {
				await services.users.create({ id: 'alice', username: 'alice', passwordHash: 'h' });
				await services.users.create({ id: 'bob', username: 'bob', passwordHash: 'h' });

				await services.savedQueries.create({
					id: 'q1',
					userId: 'alice',
					name: 'Progress',
					queryType: 'progress',
					code: 'return 1',
					createdAt: new Date(),
					updatedAt: new Date()
				});
				await services.savedQueries.create({
					id: 'q2',
					userId: 'alice',
					name: 'General',
					queryType: 'general',
					code: 'return 2',
					createdAt: new Date(),
					updatedAt: new Date()
				});

				expect(await services.savedQueries.listByUser('alice')).toHaveLength(2);
				expect(
					await services.savedQueries.listByUser('alice', { queryType: 'progress' })
				).toHaveLength(1);
				expect(await services.savedQueries.listByUser('bob')).toHaveLength(0);
				expect(await services.savedQueries.findByIdForUser('q1', 'bob')).toBeUndefined();
				expect((await services.savedQueries.findByIdForUser('q1', 'alice'))!.name).toBe('Progress');

				await services.dashboardWidgets.create({
					id: 'w1',
					userId: 'alice',
					title: 'Widget',
					widgetType: 'saved',
					config: JSON.stringify({ queryId: 'q1' }),
					sortOrder: 0,
					page: 'dashboard'
				});
				expect(await services.dashboardWidgets.listByUserAndPage('alice', 'dashboard')).toHaveLength(1);
				expect(await services.dashboardWidgets.listByUserAndPage('bob', 'dashboard')).toHaveLength(0);
				expect(await services.dashboardWidgets.findByIdForUser('w1', 'bob')).toBeUndefined();

				// Update + remove semantics.
				await services.savedQueries.update('q1', { name: 'Renamed' });
				expect((await services.savedQueries.findById('q1'))!.name).toBe('Renamed');
				await services.savedQueries.remove('q1');
				expect(await services.savedQueries.findById('q1')).toBeUndefined();
			} finally {
				await teardown();
			}
		});

		it('plugins persist config and list enabled instances for the scheduler', async () => {
			const { services, teardown } = await createFixture();
			try {
				await services.users.create({ id: 'alice', username: 'alice', passwordHash: 'h' });

				await services.plugins.create({
					id: 'p1',
					userId: 'alice',
					pluginId: 'fitbit',
					enabled: true,
					config: JSON.stringify({ credentials: { accessToken: 'tok' } }),
					createdAt: new Date()
				});
				const cfg = await services.plugins.findByUserAndPlugin('alice', 'fitbit');
				expect(cfg).toBeDefined();
				expect(JSON.parse(cfg!.config!).credentials.accessToken).toBe('tok');
				expect(await services.plugins.listEnabled()).toHaveLength(1);

				// Disable + clear config.
				await services.plugins.updateByUserAndPlugin('alice', 'fitbit', { enabled: false, config: null });
				expect((await services.plugins.findByUserAndPlugin('alice', 'fitbit'))!.enabled).toBe(false);
				expect((await services.plugins.findByUserAndPlugin('alice', 'fitbit'))!.config).toBeNull();
				expect(await services.plugins.listEnabled()).toHaveLength(0);

				// Per-user scope.
				await services.users.create({ id: 'bob', username: 'bob', passwordHash: 'h' });
				expect(await services.plugins.findByUserAndPlugin('bob', 'fitbit')).toBeUndefined();
			} finally {
				await teardown();
			}
		});

		it('AI configuration is upserted per user with a clamped provider', async () => {
			const { services, teardown } = await createFixture();
			try {
				await services.users.create({ id: 'alice', username: 'alice', passwordHash: 'h' });
				await services.users.create({ id: 'bob', username: 'bob', passwordHash: 'h' });

				await services.userAiConfig.upsert({
					id: 'c1',
					userId: 'alice',
					provider: 'anthropic',
					providersConfig: JSON.stringify({ anthropic: { apiKey: 'sk-xxx' } }),
					maxAgentRounds: 20
				});
				const cfg = await services.userAiConfig.findByUser('alice');
				expect(cfg!.provider).toBe('anthropic');
				expect(JSON.parse(cfg!.providersConfig!).anthropic.apiKey).toBe('sk-xxx');

				// Upsert updates the same user's row; other users unaffected.
				await services.userAiConfig.upsert({
					id: 'c2',
					userId: 'alice',
					provider: 'openai',
					providersConfig: JSON.stringify({ openai: { apiKey: 'sk-ooo' } }),
					maxAgentRounds: 5
				});
				const updated = await services.userAiConfig.findByUser('alice');
				expect(updated!.provider).toBe('openai');
				expect(JSON.parse(updated!.providersConfig!).openai.apiKey).toBe('sk-ooo');
				expect(await services.userAiConfig.findByUser('bob')).toBeUndefined();
			} finally {
				await teardown();
			}
		});

		it('query execution logs are recorded, listed and aggregated', async () => {
			const { services, teardown } = await createFixture();
			try {
				await services.users.create({ id: 'alice', username: 'alice', passwordHash: 'h' });
				// Whole-second boundaries are represented identically by both adapters.
				const firstLogTime = Date.UTC(2026, 0, 1);

				await services.queryExecutionLogs.create({
					id: 'l1',
					userId: 'alice',
					codeSnippet: 'return 1',
					success: true,
					executionTimeMs: 10,
					createdAt: new Date(firstLogTime)
				});
				await services.queryExecutionLogs.create({
					id: 'l2',
					userId: 'alice',
					codeSnippet: 'throw new Error()',
					success: false,
					errorMessage: 'boom',
					executionTimeMs: 5,
					createdAt: new Date(firstLogTime + 1000)
				});

				const recent = await services.queryExecutionLogs.listByUser('alice');
				expect(recent).toHaveLength(2);

				const failed = await services.queryExecutionLogs.list(
					{ success: false },
					{ limit: 50, offset: 0 }
				);
				expect(failed).toHaveLength(1);
				expect(failed[0].errorMessage).toBe('boom');

				expect(await services.queryExecutionLogs.count({})).toBe(2);
				const sinceFirst = await services.queryExecutionLogs.listSince(new Date(firstLogTime));
				expect(sinceFirst.map((row) => row.id).sort()).toEqual(['l1', 'l2']);
				const sinceSecond = await services.queryExecutionLogs.listSince(new Date(firstLogTime + 1000));
				expect(sinceSecond.map((row) => row.id)).toEqual(['l2']);
				expect(await services.queryExecutionLogs.listSince(new Date(firstLogTime + 2000))).toEqual([]);
			} finally {
				await teardown();
			}
		});
	});
}

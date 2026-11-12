/**
 * Shared helper for the T031 native-recovery rehearsal (SQLite + PostgreSQL).
 *
 * Writes a COMPLETE installation through the typed persistence boundary:
 * accounts, sessions, system config (incl. a secret), friendships + friend
 * notes, plugin config, AI config, objectives/KRs/reflections, periods/tasks/
 * tags, metrics, saved queries/widgets and query logs. This is distinct from
 * the user-export (FR-008) seed in `tests/backup/fixtures.ts` because it also
 * writes installation-wide rows (accounts, secrets, social links, plugin
 * credentials, AI config) that user exports intentionally exclude.
 */
import type { DatabaseServices } from '../../src/lib/db/contracts'

export async function seedInstall(services: DatabaseServices): Promise<void> {
	const now = new Date()
	// Accounts
	await services.users.create({ id: 'alice', username: 'alice', passwordHash: 'hash-a' })
	await services.users.create({ id: 'bob', username: 'bob', passwordHash: 'hash-b', isAdmin: true })
	await services.sessions.create({ id: 's1', userId: 'alice', expiresAt: new Date(Date.now() + 86_400_000) })

	// System config (incl. a secret)
	await services.systemConfig.upsert({
		key: 'plugin.fitbit.client_secret',
		value: 'super-secret',
		isSecret: true,
		updatedAt: now
	})
	await services.systemConfig.upsert({
		key: 'global.base_url',
		value: 'https://okr.example.com',
		isSecret: false,
		updatedAt: now
	})

	// Social
	await services.friendRequests.create({
		id: 'r1',
		fromUserId: 'alice',
		toUserId: 'bob',
		status: 'accepted',
		createdAt: now,
		respondedAt: now
	})
	await services.friendships.create({ id: 'f1', userId1: 'alice', userId2: 'bob', createdAt: now })
	await services.friendNotes.upsert({
		id: 'n1',
		userId: 'alice',
		friendId: 'bob',
		note: 'private note',
		updatedAt: now
	})

	// Plugin + AI
	await services.plugins.create({
		id: 'p1',
		userId: 'alice',
		pluginId: 'fitbit',
		enabled: true,
		config: JSON.stringify({ credentials: { accessToken: 'tok' } }),
		createdAt: now
	})
	await services.userAiConfig.upsert({
		id: 'ai1',
		userId: 'alice',
		provider: 'anthropic',
		providersConfig: JSON.stringify({ anthropic: { apiKey: 'sk-x' } }),
		maxAgentRounds: 20
	})

	// Goals + reflections
	await services.objectives.create({
		id: 'o1',
		userId: 'alice',
		title: 'Yearly goal',
		level: 'yearly',
		year: 2026,
		createdAt: now,
		updatedAt: now
	})
	await services.keyResults.create({
		id: 'kr1',
		objectiveId: 'o1',
		title: 'KR',
		weight: 1,
		createdAt: now,
		updatedAt: now
	})
	await services.objectiveReflections.create({
		id: 'ref1',
		userId: 'alice',
		level: 'yearly',
		year: 2026,
		month: null,
		reflection: 'Solid year',
		createdAt: now,
		updatedAt: now
	})

	// Planning
	await services.timePeriods.create({
		id: 'tp1',
		userId: 'alice',
		periodType: 'weekly',
		year: 2026,
		month: 1,
		week: 3,
		createdAt: now,
		updatedAt: now
	})
	await services.tags.create({ id: 'tag1', userId: 'alice', name: 'Focus' })
	await services.createTaskWithDetails({
		task: {
			id: 't1',
			userId: 'alice',
			timePeriodId: 'tp1',
			title: 'Write code',
			createdAt: now,
			updatedAt: now
		},
		attributes: { effort: 3 },
		tagIds: ['tag1']
	})

	// Metrics
	await services.metricsTemplates.create({
		id: 'tpl1',
		userId: 'alice',
		name: 'default',
		effectiveFrom: '2026-01-01',
		metricsDefinition: '{}',
		createdAt: now,
		updatedAt: now
	})
	await services.dailyMetricValues.upsert({
		id: 'mv1',
		userId: 'alice',
		date: '2026-01-01',
		metricName: 'steps',
		value: '10000',
		source: 'user'
	})

	// Saved queries + widgets + query logs
	await services.savedQueries.create({
		id: 'q1',
		userId: 'alice',
		name: 'Progress',
		queryType: 'progress',
		code: 'return 1',
		createdAt: now,
		updatedAt: now
	})
	await services.dashboardWidgets.create({
		id: 'w1',
		userId: 'alice',
		title: 'Widget',
		widgetType: 'saved',
		config: JSON.stringify({ queryId: 'q1' }),
		sortOrder: 0,
		page: 'dashboard',
		createdAt: now
	})
	await services.queryExecutionLogs.create({
		id: 'l1',
		userId: 'alice',
		codeSnippet: 'return 1',
		success: true,
		executionTimeMs: 10,
		createdAt: now
	})
}
import type { PageServerLoad } from './$types';
import { redirect, error } from '@sveltejs/kit';
import { getDatabase } from '$lib/server/database';
import { getAllConfig, GLOBAL_CONFIG_FIELDS } from '$lib/server/config';
import { getRegisteredPlugins, initializePlugins } from '$lib/server/plugins';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) {
		throw redirect(302, '/login');
	}

	if (!locals.user.isAdmin) {
		throw error(403, 'Admin access required');
	}

	const now = new Date();
	const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
	const last7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
	const services = await getDatabase();

	// Get all users
	const allUsers = await services.users.list();
	allUsers.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

	const safeUsers = allUsers.map((user) => ({
		id: user.id,
		username: user.username,
		isAdmin: user.isAdmin || false,
		isDisabled: user.isDisabled || false,
		weekStartDay: user.weekStartDay,
		timezone: user.timezone,
		createdAt: user.createdAt
	}));

	// Get recent logs
	const recentLogs = await services.queryExecutionLogs.list({}, { limit: 50, offset: 0 });

	// Enrich logs with username
	const userIds = [...new Set(recentLogs.map((log) => log.userId))];
	const usersData = await Promise.all(
		userIds.map((id) => services.users.findById(id))
	);
	const usernameMap = new Map(
		usersData.filter(Boolean).map((u) => [u!.id, u!.username])
	);

	const enrichedLogs = recentLogs.map((log) => ({
		id: log.id,
		userId: log.userId,
		username: usernameMap.get(log.userId) || 'Unknown',
		codeSnippet: log.codeSnippet,
		success: log.success,
		errorMessage: log.errorMessage,
		executionTimeMs: log.executionTimeMs,
		createdAt: log.createdAt
	}));

	// Get stats
	const logs24h = await services.queryExecutionLogs.listSince(last24h);
	const logs7d = await services.queryExecutionLogs.listSince(last7d);

	const stats = {
		users: {
			total: allUsers.length,
			disabled: allUsers.filter((u) => u.isDisabled).length,
			admins: allUsers.filter((u) => u.isAdmin).length
		},
		queries: {
			last24h: {
				total: logs24h.length,
				errors: logs24h.filter((l) => !l.success).length,
				avgExecutionTimeMs:
					logs24h.length > 0
						? Math.round(
								logs24h.reduce((sum, l) => sum + (l.executionTimeMs || 0), 0) / logs24h.length
							)
						: 0
			},
			last7d: {
				total: logs7d.length,
				errors: logs7d.filter((l) => !l.success).length
			}
		}
	};

	// Get system configuration for config tab
	initializePlugins();
	const allConfig = await getAllConfig();
	const allPlugins = getRegisteredPlugins();

	// Build a config key→value map for getSetupInfo
	const configMap: Record<string, string> = {};
	for (const entry of allConfig) {
		if (!entry.isSecret) {
			configMap[entry.key] = entry.value;
		}
	}

	const pluginConfigs = await Promise.all(
		allPlugins.map(async (plugin) => ({
			id: plugin.id,
			name: plugin.name,
			description: plugin.description,
			icon: plugin.icon,
			configured: await plugin.isConfigured(),
			adminFields: plugin.getAdminConfigFields(),
			setupInfo: plugin.getSetupInfo(configMap),
			setupGuide: plugin.getSetupGuide?.(configMap) ?? null
		}))
	);

	return {
		user: locals.user,
		users: safeUsers,
		logs: enrichedLogs,
		stats,
		systemConfig: allConfig,
		pluginConfigs,
		globalFields: GLOBAL_CONFIG_FIELDS
	};
};
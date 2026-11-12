import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDatabase } from '$lib/server/database';

// GET /api/admin/logs - Get query execution logs with pagination and filters
export const GET: RequestHandler = async ({ locals, url }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	if (!locals.user.isAdmin) {
		return json({ error: 'Admin access required' }, { status: 403 });
	}

	try {
		const services = await getDatabase();
		// Pagination
		const page = parseInt(url.searchParams.get('page') || '1');
		const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 100);
		const offset = (page - 1) * limit;

		// Filters
		const userIdFilter = url.searchParams.get('userId');
		const successFilter = url.searchParams.get('success');
		const fromDate = url.searchParams.get('from');
		const toDate = url.searchParams.get('to');

		const filters: {
			userId?: string;
			success?: boolean;
			from?: Date;
			to?: Date;
		} = {};

		if (userIdFilter) filters.userId = userIdFilter;
		if (successFilter !== null && successFilter !== '') {
			filters.success = successFilter === 'true';
		}
		if (fromDate) filters.from = new Date(fromDate);
		if (toDate) filters.to = new Date(toDate);

		// Fetch logs
		const logs = await services.queryExecutionLogs.list(filters, { limit, offset });

		// Get usernames for logs
		const userIds = [...new Set(logs.map((log) => log.userId))];
		const usersData = await Promise.all(
			userIds.map((id) => services.users.findById(id))
		);

		const usernameMap = new Map(
			usersData.filter(Boolean).map((u) => [u!.id, u!.username])
		);

		// Enrich logs with username
		const enrichedLogs = logs.map((log) => ({
			id: log.id,
			userId: log.userId,
			username: usernameMap.get(log.userId) || 'Unknown',
			codeSnippet: log.codeSnippet,
			success: log.success,
			errorMessage: log.errorMessage,
			executionTimeMs: log.executionTimeMs,
			createdAt: log.createdAt
		}));

		// Get total count for pagination
		const totalCount = await services.queryExecutionLogs.count(filters);

		return json({
			logs: enrichedLogs,
			pagination: {
				page,
				limit,
				totalCount,
				totalPages: Math.ceil(totalCount / limit)
			}
		});
	} catch (error) {
		console.error('Error fetching logs:', error);
		return json({ error: 'Failed to fetch logs' }, { status: 500 });
	}
};
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDatabase } from '$lib/server/database';

// GET /api/admin/users - List all users (admin only)
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	if (!locals.user.isAdmin) {
		return json({ error: 'Admin access required' }, { status: 403 });
	}

	try {
		const db = await getDatabase();
		const allUsers = (await db.users.list()).sort(
			(a, b) => b.createdAt.getTime() - a.createdAt.getTime()
		);

		// Don't expose password hashes
		const safeUsers = allUsers.map((user) => ({
			id: user.id,
			username: user.username,
			isAdmin: user.isAdmin || false,
			isDisabled: user.isDisabled || false,
			weekStartDay: user.weekStartDay,
			timezone: user.timezone,
			createdAt: user.createdAt
		}));

		return json({ users: safeUsers });
	} catch (error) {
		console.error('Error fetching users:', error);
		return json({ error: 'Failed to fetch users' }, { status: 500 });
	}
};
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDatabase } from '$lib/server/database';
import type { UserPatch } from '$lib/db/models';

// GET /api/user/preferences - Get user preferences
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const db = await getDatabase();
	const user = await db.users.findById(locals.user.id);

	if (!user) {
		return json({ error: 'User not found' }, { status: 404 });
	}

	return json({
		weekStartDay: user.weekStartDay || 'monday',
		timezone: user.timezone || 'UTC',
		bgColor: user.bgColor || null
	});
};

// PUT /api/user/preferences - Update user preferences
export const PUT: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	try {
		const body = await request.json();
		const { weekStartDay, timezone, bgColor } = body;

		// Validate weekStartDay
		if (weekStartDay && !['sunday', 'monday'].includes(weekStartDay)) {
			return json({ error: 'Invalid weekStartDay value' }, { status: 400 });
		}

		// Validate timezone (basic check - IANA timezone format)
		if (timezone) {
			try {
				// Try to use the timezone - this will throw if invalid
				new Intl.DateTimeFormat('en-US', { timeZone: timezone });
			} catch {
				return json({ error: 'Invalid timezone value' }, { status: 400 });
			}
		}

		// Validate bgColor (hex color or null to reset)
		if (bgColor !== undefined && bgColor !== null && !/^#[0-9a-fA-F]{6}$/.test(bgColor)) {
			return json({ error: 'Invalid bgColor value' }, { status: 400 });
		}

		const updates: UserPatch = {};
		if (weekStartDay) {
			updates.weekStartDay = weekStartDay;
		}
		if (timezone) {
			updates.timezone = timezone;
		}
		if (bgColor !== undefined) {
			updates.bgColor = bgColor; // null clears it
		}

		if (Object.keys(updates).length === 0) {
			return json({ error: 'No valid preferences to update' }, { status: 400 });
		}

		const db = await getDatabase();
		await db.users.update(locals.user.id, updates);

		return json({ success: true, weekStartDay, timezone });
	} catch (error) {
		console.error('Error updating preferences:', error);
		return json({ error: 'Failed to update preferences' }, { status: 500 });
	}
};
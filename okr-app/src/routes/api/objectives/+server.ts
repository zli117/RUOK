import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDatabase } from '$lib/server/database';
import { v4 as uuidv4 } from 'uuid';
import { broadcastDataChange } from '$lib/server/events';
import type { ObjectiveLevel } from '$lib/db/models';

// GET /api/objectives - List all objectives for the current user
export const GET: RequestHandler = async ({ locals, url }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const year = url.searchParams.get('year');
	const level = url.searchParams.get('level');
	const month = url.searchParams.get('month');

	const db = await getDatabase();
	const all = await db.objectives.listByUser(locals.user.id);

	let result = all;
	if (year) result = result.filter((o) => o.year === parseInt(year));
	if (level) result = result.filter((o) => o.level === (level as ObjectiveLevel));
	if (month) result = result.filter((o) => o.month === parseInt(month));

	// Preserve the original explicit ordering: year asc, month asc (null month first).
	result = result.sort((a, b) => a.year - b.year || (a.month ?? -1) - (b.month ?? -1));

	return json({ objectives: result });
};

// POST /api/objectives - Create a new objective
export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	try {
		const body = await request.json();
		const { title, description, level, year, month, weight, parentId, category, colorIndex } = body;

		// Validate required fields
		if (!title || typeof title !== 'string') {
			return json({ error: 'Title is required' }, { status: 400 });
		}

		if (!level || !['yearly', 'monthly'].includes(level)) {
			return json({ error: 'Level must be "yearly" or "monthly"' }, { status: 400 });
		}

		if (!year || typeof year !== 'number') {
			return json({ error: 'Year is required' }, { status: 400 });
		}

		if (level === 'monthly' && (month === undefined || month < 1 || month > 12)) {
			return json({ error: 'Month (1-12) is required for monthly objectives' }, { status: 400 });
		}

		const id = uuidv4();
		const now = new Date();

		const db = await getDatabase();
		const objective = await db.objectives.create({
			id,
			userId: locals.user.id,
			title,
			description: description || null,
			level,
			year,
			month: level === 'monthly' ? month : null,
			weight: weight ?? 1.0,
			parentId: parentId || null,
			category: category || null,
			colorIndex: colorIndex !== undefined && colorIndex !== null ? colorIndex : null,
			createdAt: now,
			updatedAt: now
		});

		// Broadcast change to other connected clients
		broadcastDataChange(locals.user.id, 'data:objectives');

		return json({ objective }, { status: 201 });
	} catch (error) {
		console.error('Error creating objective:', error);
		return json({ error: 'Failed to create objective' }, { status: 500 });
	}
};
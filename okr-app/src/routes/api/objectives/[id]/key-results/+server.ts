import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDatabase } from '$lib/server/database';
import { v4 as uuidv4 } from 'uuid';
import { broadcastDataChange } from '$lib/server/events';

// GET /api/objectives/[id]/key-results - List all key results for an objective
export const GET: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const db = await getDatabase();

	// Verify objective belongs to user
	const objective = await db.objectives.findById(params.id);

	if (!objective || objective.userId !== locals.user.id) {
		return json({ error: 'Objective not found' }, { status: 404 });
	}

	const krs = await db.keyResults.listByObjective(params.id);

	return json({ keyResults: krs });
};

// POST /api/objectives/[id]/key-results - Create a new key result
export const POST: RequestHandler = async ({ locals, params, request }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const db = await getDatabase();

	// Verify objective belongs to user
	const objective = await db.objectives.findById(params.id);

	if (!objective || objective.userId !== locals.user.id) {
		return json({ error: 'Objective not found' }, { status: 404 });
	}

	try {
		const body = await request.json();
		const {
			title,
			weight,
			score,
			expectedHours,
			sortOrder,
			details,
			measurementType,
			checkboxItems,
			progressQueryId,
			progressQueryCode,
			widgetQueryId,
			widgetQueryCode
		} = body;

		if (!title || typeof title !== 'string') {
			return json({ error: 'Title is required' }, { status: 400 });
		}

		// Get the current max sort order
		const existing = await db.keyResults.listByObjective(params.id);
		const maxSortOrder = existing.reduce((max, kr) => Math.max(max, kr.sortOrder), -1);

		const id = uuidv4();
		const now = new Date();

		const keyResult = await db.keyResults.create({
			id,
			objectiveId: params.id,
			title,
			details: details || null,
			weight: weight ?? 1.0,
			score: score ?? 0,
			expectedHours: expectedHours ?? 0,
			sortOrder: sortOrder ?? maxSortOrder + 1,
			measurementType: measurementType || 'slider',
			checkboxItems: checkboxItems || null,
			progressQueryId: progressQueryId || null,
			progressQueryCode: progressQueryCode || null,
			widgetQueryId: widgetQueryId || null,
			widgetQueryCode: widgetQueryCode || null,
			createdAt: now,
			updatedAt: now
		});

		// Broadcast change to other connected clients
		broadcastDataChange(locals.user.id, 'data:objectives');

		return json({ keyResult }, { status: 201 });
	} catch (error) {
		console.error('Error creating key result:', error);
		return json({ error: 'Failed to create key result' }, { status: 500 });
	}
};
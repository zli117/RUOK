import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDatabase } from '$lib/server/database';
import { broadcastDataChange } from '$lib/server/events';
import type { KeyResultPatch } from '$lib/db/models';

// PUT /api/objectives/[id]/key-results/[krId] - Update a key result
export const PUT: RequestHandler = async ({ locals, params, request }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const db = await getDatabase();

	// Verify objective belongs to user
	const objective = await db.objectives.findById(params.id);

	if (!objective || objective.userId !== locals.user.id) {
		return json({ error: 'Objective not found' }, { status: 404 });
	}

	// Verify key result exists and belongs to objective
	const existing = await db.keyResults.findById(params.krId);

	if (!existing || existing.objectiveId !== params.id) {
		return json({ error: 'Key result not found' }, { status: 404 });
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

		const updates: KeyResultPatch = {
			updatedAt: new Date()
		};

		if (title !== undefined) updates.title = title;
		if (weight !== undefined) updates.weight = weight;
		if (score !== undefined) {
			// Validate score is between 0 and 1
			if (typeof score !== 'number' || score < 0 || score > 1) {
				return json({ error: 'Score must be between 0 and 1' }, { status: 400 });
			}
			updates.score = score;
		}
		if (expectedHours !== undefined) updates.expectedHours = expectedHours;
		if (sortOrder !== undefined) updates.sortOrder = sortOrder;
		if (details !== undefined) updates.details = details || null;
		if (measurementType !== undefined) updates.measurementType = measurementType;
		if (checkboxItems !== undefined) updates.checkboxItems = checkboxItems || null;
		if (progressQueryId !== undefined) updates.progressQueryId = progressQueryId || null;
		if (progressQueryCode !== undefined) updates.progressQueryCode = progressQueryCode || null;
		if (widgetQueryId !== undefined) updates.widgetQueryId = widgetQueryId || null;
		if (widgetQueryCode !== undefined) updates.widgetQueryCode = widgetQueryCode || null;

		await db.keyResults.update(params.krId, updates);

		const updated = await db.keyResults.findById(params.krId);

		// Broadcast change to other connected clients
		broadcastDataChange(locals.user.id, 'data:objectives');

		return json({ keyResult: updated });
	} catch (error) {
		console.error('Error updating key result:', error);
		return json({ error: 'Failed to update key result' }, { status: 500 });
	}
};

// DELETE /api/objectives/[id]/key-results/[krId] - Delete a key result
export const DELETE: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const db = await getDatabase();

	// Verify objective belongs to user
	const objective = await db.objectives.findById(params.id);

	if (!objective || objective.userId !== locals.user.id) {
		return json({ error: 'Objective not found' }, { status: 404 });
	}

	// Verify key result exists
	const existing = await db.keyResults.findById(params.krId);

	if (!existing || existing.objectiveId !== params.id) {
		return json({ error: 'Key result not found' }, { status: 404 });
	}

	await db.keyResults.remove(params.krId);

	// Broadcast change to other connected clients
	broadcastDataChange(locals.user.id, 'data:objectives');

	return json({ success: true });
};
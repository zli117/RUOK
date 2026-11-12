import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDatabase } from '$lib/server/database';
import { broadcastDataChange } from '$lib/server/events';
import type { ObjectivePatch } from '$lib/db/models';

// GET /api/objectives/[id] - Get a single objective
export const GET: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const db = await getDatabase();
	const objective = await db.objectives.findById(params.id);

	if (!objective || objective.userId !== locals.user.id) {
		return json({ error: 'Objective not found' }, { status: 404 });
	}

	return json({ objective });
};

// PUT /api/objectives/[id] - Update an objective
export const PUT: RequestHandler = async ({ locals, params, request }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const db = await getDatabase();

	// Check if objective exists and belongs to user
	const existing = await db.objectives.findById(params.id);

	if (!existing || existing.userId !== locals.user.id) {
		return json({ error: 'Objective not found' }, { status: 404 });
	}

	try {
		const body = await request.json();
		const { title, description, weight, parentId, category, colorIndex } = body;

		const updates: ObjectivePatch = {
			updatedAt: new Date()
		};

		if (title !== undefined) updates.title = title;
		if (description !== undefined) updates.description = description;
		if (weight !== undefined) updates.weight = weight;
		if (parentId !== undefined) updates.parentId = parentId;
		if (category !== undefined) updates.category = category;
		if (colorIndex !== undefined) updates.colorIndex = colorIndex;

		await db.objectives.update(params.id, updates);

		const updated = await db.objectives.findById(params.id);

		// Broadcast change to other connected clients
		broadcastDataChange(locals.user.id, 'data:objectives');

		return json({ objective: updated });
	} catch (error) {
		console.error('Error updating objective:', error);
		return json({ error: 'Failed to update objective' }, { status: 500 });
	}
};

// DELETE /api/objectives/[id] - Delete an objective
export const DELETE: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const db = await getDatabase();

	// Check if objective exists and belongs to user
	const existing = await db.objectives.findById(params.id);

	if (!existing || existing.userId !== locals.user.id) {
		return json({ error: 'Objective not found' }, { status: 404 });
	}

	await db.objectives.remove(params.id);

	// Broadcast change to other connected clients
	broadcastDataChange(locals.user.id, 'data:objectives');

	return json({ success: true });
};
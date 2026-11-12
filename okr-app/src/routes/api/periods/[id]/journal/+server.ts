import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDatabase } from '$lib/server/database';
import { broadcastDataChange } from '$lib/server/events';

// PUT /api/periods/[id]/journal - Save journal entry for a period
export const PUT: RequestHandler = async ({ locals, params, request }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	try {
		const { notes } = await request.json();

		if (typeof notes !== 'string') {
			return json({ error: 'Notes must be a string' }, { status: 400 });
		}

		const services = await getDatabase();

		// Verify the period belongs to the user
		const period = await services.timePeriods.findById(params.id);
		if (!period || period.userId !== locals.user.id) {
			return json({ error: 'Period not found' }, { status: 404 });
		}

		await services.timePeriods.update(params.id, { notes, updatedAt: new Date() });

		broadcastDataChange(locals.user.id, 'data:daily');

		return json({ success: true });
	} catch (error) {
		console.error('Error saving journal entry:', error);
		return json({ error: 'Failed to save journal entry' }, { status: 500 });
	}
};
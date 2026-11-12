import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDatabase } from '$lib/server/database';
import { broadcastDataChange } from '$lib/server/events';

// POST /api/tasks/[id]/timer - Start or stop timer
export const POST: RequestHandler = async ({ locals, params, request }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const services = await getDatabase();
	const existing = await services.tasks.findById(params.id);
	if (!existing || existing.userId !== locals.user.id) {
		return json({ error: 'Task not found' }, { status: 404 });
	}

	try {
		const body = await request.json();
		const { action } = body; // 'start' or 'stop'

		if (action !== 'start' && action !== 'stop') {
			return json({ error: 'Invalid action. Use "start" or "stop"' }, { status: 400 });
		}

		const now = new Date();

		// Atomic timer mutations (T018): no read-modify-write lost update.
		let task;
		if (action === 'start') {
			if (existing.timerStartedAt) {
				return json({ error: 'Timer is already running' }, { status: 400 });
			}
			task = await services.tasks.startTimer(params.id, now);
		} else {
			if (!existing.timerStartedAt) {
				return json({ error: 'Timer is not running' }, { status: 400 });
			}
			task = await services.tasks.stopTimer(params.id, now);
		}

		broadcastDataChange(locals.user.id, 'data:tasks', 'data:weekly');

		return json({ task });
	} catch (error) {
		console.error('Error toggling timer:', error);
		return json({ error: 'Failed to toggle timer' }, { status: 500 });
	}
};
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDatabase } from '$lib/server/database';
import { broadcastDataChange } from '$lib/server/events';

// GET /api/tasks/[id] - Get a single task
export const GET: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const services = await getDatabase();
	const task = await services.tasks.findById(params.id);

	if (!task || task.userId !== locals.user.id) {
		return json({ error: 'Task not found' }, { status: 404 });
	}

	const [attributes, tags] = await Promise.all([
		services.taskAttributes.listByTask(task.id),
		services.taskTags.listByTask(task.id)
	]);

	return json({
		task: {
			...task,
			attributes: attributes.reduce(
				(acc, attr) => {
					acc[attr.key] = attr.value;
					return acc;
				},
				{} as Record<string, string>
			),
			tagIds: tags.map((t) => t.tagId)
		}
	});
};

// PUT /api/tasks/[id] - Update a task
export const PUT: RequestHandler = async ({ locals, params, request }) => {
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
		const { title, completed, sortOrder, attributes, tagIds } = body;

		const patch: Record<string, unknown> = {
			updatedAt: new Date()
		};

		if (title !== undefined) patch.title = title;
		if (completed !== undefined) {
			patch.completed = completed;
			patch.completedAt = completed ? new Date() : null;
		}
		if (sortOrder !== undefined) patch.sortOrder = sortOrder;

		// Atomic update: base fields + replace attributes + replace tags (T018).
		const task = await services.updateTaskWithDetails({
			id: params.id,
			patch,
			attributes: attributes && typeof attributes === 'object' ? attributes : undefined,
			tagIds: tagIds !== undefined && Array.isArray(tagIds) ? tagIds : undefined
		});

		if (!task) {
			return json({ error: 'Task not found' }, { status: 404 });
		}

		const [attrs, tags] = await Promise.all([
			services.taskAttributes.listByTask(task.id),
			services.taskTags.listByTask(task.id)
		]);

		broadcastDataChange(locals.user.id, 'data:tasks', 'data:weekly');

		return json({
			task: {
				...task,
				attributes: attrs.reduce(
					(acc, attr) => {
						acc[attr.key] = attr.value;
						return acc;
					},
					{} as Record<string, string>
				),
				tagIds: tags.map((t) => t.tagId)
			}
		});
	} catch (error) {
		console.error('Error updating task:', error);
		return json({ error: 'Failed to update task' }, { status: 500 });
	}
};

// PATCH /api/tasks/[id] - Toggle task completion
export const PATCH: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const services = await getDatabase();
	const existing = await services.tasks.findById(params.id);
	if (!existing || existing.userId !== locals.user.id) {
		return json({ error: 'Task not found' }, { status: 404 });
	}

	const newCompleted = !existing.completed;
	const now = new Date();

	// Build update object
	const updates: Record<string, unknown> = {
		completed: newCompleted,
		completedAt: newCompleted ? now : null,
		updatedAt: now
	};

	// If completing the task and timer is running, stop it and save elapsed time
	if (newCompleted && existing.timerStartedAt) {
		const stopped = await services.tasks.stopTimer(params.id, now);
		if (stopped) {
			updates.timeSpentMs = stopped.timeSpentMs;
			updates.timerStartedAt = null;
		} else {
			// Concurrent stop already applied the accumulated total and cleared the
			// running state between findById and stopTimer — re-read the stopped row
			// so we carry those values instead of returning a stale/undefined task.
			const current = await services.tasks.findById(params.id);
			if (current) {
				updates.timeSpentMs = current.timeSpentMs;
				updates.timerStartedAt = null;
			}
		}
	}

	await services.tasks.update(params.id, updates);

	const task = await services.tasks.findById(params.id);

	broadcastDataChange(locals.user.id, 'data:tasks', 'data:weekly');

	return json({ task });
};

// DELETE /api/tasks/[id] - Delete a task
export const DELETE: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const services = await getDatabase();
	const existing = await services.tasks.findById(params.id);
	if (!existing || existing.userId !== locals.user.id) {
		return json({ error: 'Task not found' }, { status: 404 });
	}

	await services.tasks.remove(params.id);

	broadcastDataChange(locals.user.id, 'data:tasks', 'data:weekly');

	return json({ success: true });
};
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDatabase } from '$lib/server/database';
import { v4 as uuidv4 } from 'uuid';
import { broadcastDataChange } from '$lib/server/events';

// GET /api/tasks - List tasks with filters
export const GET: RequestHandler = async ({ locals, url }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const periodId = url.searchParams.get('periodId');
	const completed = url.searchParams.get('completed');

	const services = await getDatabase();
	const taskList = await services.tasks.listByUser(locals.user.id, {
		timePeriodId: periodId ?? undefined,
		completed: completed !== null ? completed === 'true' : undefined
	});

	// Batch attributes for every task (T018: avoid N+1 under latency).
	const attrMap = await services.taskAttributes.listByTasks(taskList.map((t) => t.id));

	const tasksWithAttributes = taskList.map((task) => {
		const attributes = (attrMap.get(task.id) ?? []).reduce(
			(acc, attr) => {
				acc[attr.key] = attr.value;
				return acc;
			},
			{} as Record<string, string>
		);
		return { ...task, attributes };
	});

	return json({ tasks: tasksWithAttributes });
};

// POST /api/tasks - Create a new task
export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	try {
		const body = await request.json();
		const { timePeriodId, title, attributes, tagIds } = body;

		// Validate required fields
		if (!timePeriodId || typeof timePeriodId !== 'string') {
			return json({ error: 'Time period ID is required' }, { status: 400 });
		}

		if (!title || typeof title !== 'string') {
			return json({ error: 'Title is required' }, { status: 400 });
		}

		const services = await getDatabase();

		// Verify time period belongs to user
		const period = await services.timePeriods.findById(timePeriodId);
		if (!period || period.userId !== locals.user.id) {
			return json({ error: 'Time period not found' }, { status: 404 });
		}

		// Get current max sort order
		const existingTasks = await services.tasks.listByPeriod(timePeriodId);
		const maxSortOrder = existingTasks.reduce((max, t) => Math.max(max, t.sortOrder), -1);

		const taskId = uuidv4();
		const now = new Date();

		// Atomic create: task + attributes + tags commit together (T018).
		const task = await services.createTaskWithDetails({
			task: {
				id: taskId,
				userId: locals.user.id,
				timePeriodId,
				title,
				sortOrder: maxSortOrder + 1,
				createdAt: now,
				updatedAt: now
			},
			attributes: attributes && typeof attributes === 'object' ? attributes : undefined,
			tagIds: tagIds && Array.isArray(tagIds) ? tagIds : undefined
		});

		const taskAttrs = await services.taskAttributes.listByTask(taskId);
		const attributeMap = taskAttrs.reduce(
			(acc, attr) => {
				acc[attr.key] = attr.value;
				return acc;
			},
			{} as Record<string, string>
		);

		// Broadcast change to other connected clients
		broadcastDataChange(locals.user.id, 'data:tasks', 'data:weekly');

		return json(
			{
				task: {
					...task,
					attributes: attributeMap
				}
			},
			{ status: 201 }
		);
	} catch (error) {
		console.error('Error creating task:', error);
		return json({ error: 'Failed to create task' }, { status: 500 });
	}
};
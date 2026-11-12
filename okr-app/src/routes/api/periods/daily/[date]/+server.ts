import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDatabase } from '$lib/server/database';
import { v4 as uuidv4 } from 'uuid';

// GET /api/periods/daily/[date] - Get a specific day's data
export const GET: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const dateStr = params.date; // Expected format: YYYY-MM-DD

	// Validate date format
	if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
		return json({ error: 'Invalid date format. Use YYYY-MM-DD' }, { status: 400 });
	}

	const date = new Date(dateStr);
	const year = date.getFullYear();
	const month = date.getMonth() + 1;

	const services = await getDatabase();

	// Find or create the daily period
	let period = await services.timePeriods.find({
		userId: locals.user.id,
		type: 'daily',
		day: dateStr
	});

	let created = false;
	if (!period) {
		const id = uuidv4();
		const now = new Date();

		period = await services.timePeriods.create({
			id,
			userId: locals.user.id,
			periodType: 'daily',
			year,
			month,
			day: dateStr,
			createdAt: now,
			updatedAt: now
		});
		created = true;
	}

	if (!period) {
		return json({ error: 'Failed to get or create period' }, { status: 500 });
	}

	// Get tasks for this period (ordered) and batch their attributes + tags.
	const periodTasks = await services.tasks.listByPeriod(period.id);
	const taskIds = periodTasks.map((t) => t.id);
	const [attrMap, tagMap] = await Promise.all([
		services.taskAttributes.listByTasks(taskIds),
		services.taskTags.listByTasks(taskIds)
	]);

	const tasksWithAttributes = periodTasks.map((task) => {
		const attributes = (attrMap.get(task.id) ?? []).reduce(
			(acc, attr) => {
				acc[attr.key] = attr.value;
				return acc;
			},
			{} as Record<string, string>
		);
		const tagIds = (tagMap.get(task.id) ?? []).map((t) => t.tagId);
		return { ...task, attributes, tagIds };
	});

	// Get daily metrics
	const metrics = await services.dailyMetrics.findByPeriod(locals.user.id, period.id);

	return json({
		period,
		tasks: tasksWithAttributes,
		metrics,
		created
	});
};
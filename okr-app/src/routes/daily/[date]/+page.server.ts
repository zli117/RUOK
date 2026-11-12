import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDatabase } from '$lib/server/database';
import { getWeekNumber, getWeekYear, getTodayInTimezone } from '$lib/utils/week';

export const load: PageServerLoad = async ({ params, locals, fetch, depends }) => {
	// Register dependencies for invalidation
	depends('data:daily');
	depends('data:tasks');
	depends('data:weekly');
	depends('data:metrics');

	if (!locals.user) {
		throw redirect(302, '/login');
	}

	const dateStr = params.date;

	// Validate date format
	if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
		const timezone = locals.user.timezone || 'UTC';
		throw redirect(302, `/daily/${getTodayInTimezone(timezone)}`);
	}

	// Calculate week number and year for this date
	const dateObj = new Date(dateStr + 'T00:00:00Z');
	const weekStartDay = locals.user.weekStartDay || 'monday';
	const weekYear = getWeekYear(dateObj, weekStartDay);
	const weekNumber = getWeekNumber(dateObj, weekStartDay);

	const services = await getDatabase();

	// Fetch daily data, tags, and weekly period in parallel
	// (metrics are loaded client-side to avoid blocking on slow plugin API calls)
	const [response, tagsResponse, weeklyPeriod] = await Promise.all([
		fetch(`/api/periods/daily/${dateStr}`),
		fetch('/api/tags'),
		services.timePeriods.find({
			userId: locals.user.id,
			type: 'weekly',
			year: weekYear,
			week: weekNumber
		})
	]);

	const data = await response.json();

	if (!response.ok) {
		return {
			date: dateStr,
			period: null,
			tasks: [],
			weeklyInitiatives: [],
			weeklyPeriod: null,
			weekYear,
			weekNumber,
			error: data.error || 'Failed to load data'
		};
	}

	const tagsData = await tagsResponse.json();

	// Load weekly initiatives if we have a weekly period
	let weeklyInitiatives: any[] = [];
	if (weeklyPeriod) {
		const weeklyTasks = await services.tasks.listByPeriod(weeklyPeriod.id);
		const taskIds = weeklyTasks.map((t) => t.id);
		const [attrMap, tagMap] = await Promise.all([
			services.taskAttributes.listByTasks(taskIds),
			services.taskTags.listByTasks(taskIds)
		]);

		weeklyInitiatives = weeklyTasks.map((task) => {
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
	}

	return {
		date: dateStr,
		period: data.period,
		tasks: data.tasks || [],
		tags: tagsData.tags || [],
		// Weekly initiatives
		weeklyInitiatives,
		weeklyPeriod,
		weekYear,
		weekNumber
	};
};
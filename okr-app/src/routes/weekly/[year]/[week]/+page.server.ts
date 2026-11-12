import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDatabase } from '$lib/server/database';
import { getWeekNumber, getWeekStartDate, getWeekYear, getTodayDateInTimezone, formatDate, addDays, getDayName } from '$lib/utils/week';

export const load: PageServerLoad = async ({ params, locals, depends }) => {
	// Register dependency for invalidation
	depends('data:weekly');
	depends('data:tasks');

	if (!locals.user) {
		throw redirect(302, '/login');
	}

	const year = parseInt(params.year);
	const week = parseInt(params.week);
	const weekStartDay = locals.user.weekStartDay || 'monday';

	if (isNaN(year) || isNaN(week) || week < 1 || week > 53) {
		const timezone = locals.user.timezone || 'UTC';
		const today = getTodayDateInTimezone(timezone);
		const currentYear = getWeekYear(today, weekStartDay);
		const currentWeek = getWeekNumber(today, weekStartDay);
		throw redirect(302, `/weekly/${currentYear}/${currentWeek}`);
	}

	const services = await getDatabase();

	// Fetch weekly period and tags in parallel with day processing
	const [weeklyPeriod, userTags] = await Promise.all([
		services.timePeriods.find({
			userId: locals.user.id,
			type: 'weekly',
			year,
			week
		}),
		services.tags.listByUser(locals.user.id)
	]);

	// Get the dates for this week (using UTC-based utilities)
	const weekStart = getWeekStartDate(year, week, weekStartDay);
	const days: { date: string; dayName: string; tasks: any[]; period: any }[] = [];

	for (let i = 0; i < 7; i++) {
		const date = addDays(weekStart, i);
		const dateStr = formatDate(date);
		const dayName = getDayName(date);

		// Find the period for this day
		const period = await services.timePeriods.find({
			userId: locals.user.id,
			type: 'daily',
			day: dateStr
		});

		let dayTasks: any[] = [];
		if (period) {
			const periodTasks = await services.tasks.listByPeriod(period.id);
			const taskIds = periodTasks.map((t) => t.id);
			const [attrMap, tagMap] = await Promise.all([
				services.taskAttributes.listByTasks(taskIds),
				services.taskTags.listByTasks(taskIds)
			]);

			dayTasks = periodTasks.map((task) => {
				const attributes = (attrMap.get(task.id) ?? []).reduce(
					(acc, attr) => {
						acc[attr.key] = attr.value;
						return acc;
					},
					{} as Record<string, string>
				);
				const tags = (tagMap.get(task.id) ?? []).map((t) => t.tagId);
				return { ...task, attributes, tagIds: tags };
			});
		}

		days.push({
			date: dateStr,
			dayName,
			tasks: dayTasks,
			period
		});
	}

	// Load weekly initiatives if we have a weekly period
	let weeklyInitiatives: any[] = [];
	if (weeklyPeriod) {
		const weeklyTasks = await services.tasks.listByPeriod(weeklyPeriod.id);
		const weeklyTaskIds = weeklyTasks.map((t) => t.id);
		const [attrMap, tagMap] = await Promise.all([
			services.taskAttributes.listByTasks(weeklyTaskIds),
			services.taskTags.listByTasks(weeklyTaskIds)
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

	// Calculate weekly stats (daily tasks only)
	const allTasks = days.flatMap((d) => d.tasks);
	const completedTasks = allTasks.filter((t) => t.completed);
	const totalPlannedHours = allTasks.reduce((sum, t) => {
		const hours = parseFloat(t.attributes?.expected_hours || '0');
		return sum + (isNaN(hours) ? 0 : hours);
	}, 0);
	const totalTrackedMs = allTasks.reduce((sum, t) => sum + (t.timeSpentMs || 0), 0);

	// Calculate initiative stats
	const completedInitiatives = weeklyInitiatives.filter((t) => t.completed);
	const initiativePlannedHours = weeklyInitiatives.reduce((sum, t) => {
		const hours = parseFloat(t.attributes?.expected_hours || '0');
		return sum + (isNaN(hours) ? 0 : hours);
	}, 0);
	const initiativeTrackedMs = weeklyInitiatives.reduce((sum, t) => sum + (t.timeSpentMs || 0), 0);

	// Convert ms to hours
	const msToHours = (ms: number) => (ms / 1000 / 60 / 60).toFixed(1);

	return {
		year,
		week,
		weekStartDay,
		days,
		weeklyInitiatives,
		weeklyPeriod,
		tags: userTags,
		stats: {
			totalTasks: allTasks.length,
			completedTasks: completedTasks.length,
			totalPlannedHours: totalPlannedHours.toFixed(1),
			totalTrackedHours: msToHours(totalTrackedMs),
			totalInitiatives: weeklyInitiatives.length,
			completedInitiatives: completedInitiatives.length,
			initiativePlannedHours: initiativePlannedHours.toFixed(1),
			initiativeTrackedHours: msToHours(initiativeTrackedMs)
		}
	};
};
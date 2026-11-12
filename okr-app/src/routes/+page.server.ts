import type { PageServerLoad } from './$types';
import { getDatabase } from '$lib/server/database';
import {
	getWeekNumber,
	getWeekStartDate,
	getWeekYear,
	formatDate,
	addDays,
	getTodayInTimezone,
	getTodayDateInTimezone,
	getCurrentMonthInTimezone
} from '$lib/utils/week';

export const load: PageServerLoad = async ({ locals, depends }) => {
	// Register dependencies for invalidation
	depends('data:dashboard');
	depends('data:tasks');
	depends('data:objectives');

	if (!locals.user) {
		return { user: null };
	}

	const timezone = locals.user.timezone || 'UTC';
	const weekStartDay = locals.user.weekStartDay || 'monday';

	// Get today's date in the user's timezone
	const todayStr = getTodayInTimezone(timezone);
	const today = getTodayDateInTimezone(timezone);
	const currentYear = getWeekYear(today, weekStartDay);
	const currentWeek = getWeekNumber(today, weekStartDay);
	const currentMonth = getCurrentMonthInTimezone(timezone);

	const services = await getDatabase();

	// Get today's tasks (period + batched attributes)
	const todayPeriod = await services.timePeriods.find({
		userId: locals.user.id,
		type: 'daily',
		day: todayStr
	});

	let todayTasks: any[] = [];
	if (todayPeriod) {
		const periodTasks = await services.tasks.listByPeriod(todayPeriod.id);
		const attrMap = await services.taskAttributes.listByTasks(periodTasks.map((t) => t.id));
		todayTasks = periodTasks.map((task) => ({
			...task,
			attributes: (attrMap.get(task.id) ?? []).reduce(
				(acc, attr) => {
					acc[attr.key] = attr.value;
					return acc;
				},
				{} as Record<string, string>
			)
		}));
	}

	// Get this week's tasks stats
	const weekStart = getWeekStartDate(currentYear, currentWeek, weekStartDay);
	let weekTotalTasks = 0;
	let weekCompletedTasks = 0;

	for (let i = 0; i < 7; i++) {
		const date = addDays(weekStart, i);
		const dateStr = formatDate(date);

		const period = await services.timePeriods.find({
			userId: locals.user.id,
			type: 'daily',
			day: dateStr
		});

		if (period) {
			const dayTasks = await services.tasks.listByPeriod(period.id);
			weekTotalTasks += dayTasks.length;
			weekCompletedTasks += dayTasks.filter((t) => t.completed).length;
		}
	}

	// Get yearly objectives with key results (owned, via boundary)
	const allObjectives = await services.objectives.listByUser(locals.user.id);
	const yearlyObjectives = allObjectives.filter(
		(o) => o.level === 'yearly' && o.year === currentYear
	);

	const yearlyObjectivesWithKRs = await Promise.all(
		yearlyObjectives.map(async (obj) => {
			const krs = await services.keyResults.listByObjective(obj.id);
			const avgScore =
				krs.length > 0 ? krs.reduce((sum, kr) => sum + kr.score * kr.weight, 0) / krs.reduce((sum, kr) => sum + kr.weight, 0) : 0;
			return {
				...obj,
				keyResults: krs,
				averageScore: avgScore
			};
		})
	);

	// Get monthly objectives with key results for current month
	const monthlyObjectives = allObjectives.filter(
		(o) => o.level === 'monthly' && o.year === currentYear && o.month === currentMonth
	);

	const monthlyObjectivesWithKRs = await Promise.all(
		monthlyObjectives.map(async (obj) => {
			const krs = await services.keyResults.listByObjective(obj.id);
			const avgScore =
				krs.length > 0 ? krs.reduce((sum, kr) => sum + kr.score * kr.weight, 0) / krs.reduce((sum, kr) => sum + kr.weight, 0) : 0;
			return {
				...obj,
				keyResults: krs,
				averageScore: avgScore
			};
		})
	);

	// Load dashboard widgets
	const widgets = await services.dashboardWidgets.listByUserAndPage(locals.user.id, 'dashboard');

	// Load saved queries for widget selector
	const queries = await services.savedQueries.listByUser(locals.user.id);

	return {
		user: locals.user,
		today: {
			date: todayStr,
			tasks: todayTasks,
			completedCount: todayTasks.filter((t) => t.completed).length,
			totalCount: todayTasks.length
		},
		week: {
			year: currentYear,
			week: currentWeek,
			completedCount: weekCompletedTasks,
			totalCount: weekTotalTasks
		},
		yearlyObjectives: yearlyObjectivesWithKRs,
		monthlyObjectives: monthlyObjectivesWithKRs,
		currentMonth,
		currentYear,
		widgets: widgets.map(w => ({
			id: w.id,
			title: w.title,
			widgetType: w.widgetType,
			config: JSON.parse(w.config),
			sortOrder: w.sortOrder
		})),
		savedQueries: queries.map(q => ({
			id: q.id,
			name: q.name,
			code: q.code
		}))
	};
};
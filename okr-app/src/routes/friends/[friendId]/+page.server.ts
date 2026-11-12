import type { PageServerLoad } from './$types';
import { redirect, error } from '@sveltejs/kit';
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

export const load: PageServerLoad = async ({ locals, params, url }) => {
	if (!locals.user) {
		throw redirect(302, '/login');
	}

	const userId = locals.user.id;
	const friendId = params.friendId;
	const services = await getDatabase();

	// Verify friendship exists
	const friendship = await services.friendships.findBetween(userId, friendId);

	if (!friendship) {
		throw error(403, 'Not friends with this user');
	}

	// Get friend's user info
	const friend = await services.users.findById(friendId);

	if (!friend) {
		throw error(404, 'User not found');
	}

	// Get private note about this friend
	const friendNote = await services.friendNotes.findByUserAndFriend(userId, friendId);

	// Use friend's timezone and week settings for calculations
	const timezone = friend.timezone || 'UTC';
	const weekStartDay = friend.weekStartDay || 'monday';

	const todayStr = getTodayInTimezone(timezone);
	const today = getTodayDateInTimezone(timezone);
	const currentYear = getWeekYear(today, weekStartDay);
	const currentWeek = getWeekNumber(today, weekStartDay);
	const currentMonth = getCurrentMonthInTimezone(timezone);

	// Optional month parameter for monthly objectives
	const requestedMonth = url.searchParams.get('month');
	const monthForObjectives = requestedMonth ? parseInt(requestedMonth, 10) : currentMonth;

	// Get today's tasks for the friend
	const todayPeriod = await services.timePeriods.find({
		userId: friendId,
		type: 'daily',
		day: todayStr
	});

	let todayTasks: any[] = [];
	if (todayPeriod) {
		const periodTasks = await services.tasks.listByPeriod(todayPeriod.id);

		// Get friend's tags
		const friendTags = await services.tags.listByUser(friendId);

		todayTasks = await Promise.all(
			periodTasks.map(async (task) => {
				const attributes = await services.taskAttributes.listByTask(task.id);

				const taskTagLinks = await services.taskTags.listByTask(task.id);

				const taskTagIds = taskTagLinks.map((tt) => tt.tagId);
				const taskTagsData = friendTags.filter((t) => taskTagIds.includes(t.id));

				return {
					...task,
					attributes: attributes.reduce(
						(acc, attr) => {
							acc[attr.key] = attr.value;
							return acc;
						},
						{} as Record<string, string>
					),
					tags: taskTagsData
				};
			})
		);
	}

	// Get this week's tasks stats
	const weekStart = getWeekStartDate(currentYear, currentWeek, weekStartDay);
	let weekTotalTasks = 0;
	let weekCompletedTasks = 0;

	for (let i = 0; i < 7; i++) {
		const date = addDays(weekStart, i);
		const dateStr = formatDate(date);

		const period = await services.timePeriods.find({
			userId: friendId,
			type: 'daily',
			day: dateStr
		});

		if (period) {
			const dayTasks = await services.tasks.listByPeriod(period.id);
			weekTotalTasks += dayTasks.length;
			weekCompletedTasks += dayTasks.filter((t) => t.completed).length;
		}
	}

	// Get yearly objectives with key results
	const allObjectives = await services.objectives.listByUser(friendId);
	const yearlyObjectives = allObjectives.filter(
		(o) => o.level === 'yearly' && o.year === currentYear
	);

	const yearlyObjectivesWithKRs = await Promise.all(
		yearlyObjectives.map(async (obj) => {
			const krs = await services.keyResults.listByObjective(obj.id);
			const avgScore =
				krs.length > 0
					? krs.reduce((sum, kr) => sum + kr.score * kr.weight, 0) /
					  krs.reduce((sum, kr) => sum + kr.weight, 0)
					: 0;
			return {
				...obj,
				keyResults: krs,
				averageScore: avgScore
			};
		})
	);

	// Get monthly objectives with key results
	const monthlyObjectives = allObjectives.filter(
		(o) => o.level === 'monthly' && o.year === currentYear && o.month === monthForObjectives
	);

	const monthlyObjectivesWithKRs = await Promise.all(
		monthlyObjectives.map(async (obj) => {
			const krs = await services.keyResults.listByObjective(obj.id);
			const avgScore =
				krs.length > 0
					? krs.reduce((sum, kr) => sum + kr.score * kr.weight, 0) /
					  krs.reduce((sum, kr) => sum + kr.weight, 0)
					: 0;
			return {
				...obj,
				keyResults: krs,
				averageScore: avgScore
			};
		})
	);

	return {
		user: locals.user,
		friend: {
			id: friend.id,
			username: friend.username
		},
		note: friendNote?.note || '',
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
		currentMonth: monthForObjectives,
		currentYear
	};
};
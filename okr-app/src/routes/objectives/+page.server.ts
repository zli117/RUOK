import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDatabase } from '$lib/server/database';

export const load: PageServerLoad = async ({ locals, url, depends }) => {
	// Register dependency for invalidation
	depends('data:objectives');

	if (!locals.user) {
		throw redirect(302, '/login');
	}

	const year = parseInt(url.searchParams.get('year') || String(new Date().getFullYear()));
	const level = (url.searchParams.get('level') as 'yearly' | 'monthly') || 'yearly';
	const month = level === 'monthly'
		? parseInt(url.searchParams.get('month') || String(new Date().getMonth() + 1))
		: null;

	const services = await getDatabase();

	// Get objectives for the selected year and level (and month if monthly)
	const allObjectives = await services.objectives.listByUser(locals.user.id);
	const userObjectives = allObjectives.filter(
		(o) =>
			o.year === year &&
			o.level === level &&
			(level === 'monthly' && month ? o.month === month : true)
	);

	// Get key results for each objective
	const objectivesWithKRs = await Promise.all(
		userObjectives.map(async (obj) => {
			const krs = await services.keyResults.listByObjective(obj.id);

			// Calculate weighted average score
			const totalWeight = krs.reduce((sum, kr) => sum + kr.weight, 0);
			const avgScore = totalWeight > 0
				? krs.reduce((sum, kr) => sum + kr.score * kr.weight, 0) / totalWeight
				: 0;

			return {
				...obj,
				keyResults: krs,
				averageScore: avgScore
			};
		})
	);

	// Calculate overall score for the year
	const totalWeight = objectivesWithKRs.reduce((sum, obj) => sum + obj.weight, 0);
	const overallScore = totalWeight > 0
		? objectivesWithKRs.reduce((sum, obj) => sum + obj.averageScore * obj.weight, 0) / totalWeight
		: 0;

	// Get all saved queries for the progress query selector
	const allSavedQueries = await services.savedQueries.listByUser(locals.user.id);

	// Get distinct years that have objectives for this user
	const yearsSet = new Set(allObjectives.map((o) => o.year));
	let availableYears = [...yearsSet].sort((a, b) => a - b);

	const currentYear = new Date().getFullYear();

	// If no years found, default to current year
	if (availableYears.length === 0) {
		availableYears = [currentYear];
	}
	// If current year not in list and we're viewing it, add it
	else if (!availableYears.includes(year)) {
		availableYears = [...availableYears, year].sort((a, b) => a - b);
	}

	// Get reflection for current year/level/month
	const reflection = await services.objectiveReflections.findByUserLevelYearMonth({
		userId: locals.user.id,
		level,
		year,
		month: level === 'monthly' && month ? month : null
	});

	return {
		year,
		level,
		month,
		objectives: objectivesWithKRs,
		overallScore,
		years: availableYears,
		savedQueries: allSavedQueries.map(q => ({ id: q.id, name: q.name, code: q.code })),
		reflection: reflection?.reflection || ''
	};
};
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDatabase } from '$lib/server/database';
import { v4 as uuidv4 } from 'uuid';

// GET /api/metrics/daily/[date] - Get metrics for a specific date
export const GET: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const dateStr = params.date;

	if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
		return json({ error: 'Invalid date format. Use YYYY-MM-DD' }, { status: 400 });
	}

	const services = await getDatabase();

	// Find the time period for this date
	const period = await services.timePeriods.find({
		userId: locals.user.id,
		type: 'daily',
		day: dateStr
	});

	if (!period) {
		return json({ metrics: null });
	}

	const metrics = await services.dailyMetrics.findByPeriod(locals.user.id, period.id);

	return json({ metrics });
};

// PUT /api/metrics/daily/[date] - Update or create metrics for a specific date
export const PUT: RequestHandler = async ({ locals, params, request }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const dateStr = params.date;

	if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
		return json({ error: 'Invalid date format. Use YYYY-MM-DD' }, { status: 400 });
	}

	try {
		const body = await request.json();
		const {
			previousNightBedTime,
			wakeUpTime,
			sleepLength,
			cardioLoad,
			fitbitReadiness,
			steps,
			heartPoints,
			restingHeartRate,
			customMetrics
		} = body;

		const services = await getDatabase();

		// Find or create the time period for this date
		let period = await services.timePeriods.find({
			userId: locals.user.id,
			type: 'daily',
			day: dateStr
		});

		if (!period) {
			const date = new Date(dateStr);
			period = await services.timePeriods.create({
				id: uuidv4(),
				userId: locals.user.id,
				periodType: 'daily',
				year: date.getFullYear(),
				month: date.getMonth() + 1,
				week: null,
				day: dateStr,
				createdAt: new Date(),
				updatedAt: new Date()
			});
		}

		if (!period) {
			return json({ error: 'Failed to create time period' }, { status: 500 });
		}

		// Check if metrics already exist
		const existing = await services.dailyMetrics.findByPeriod(locals.user.id, period.id);

		if (existing) {
			const updated = await services.dailyMetrics.update(existing.id, {
				previousNightBedTime:
					previousNightBedTime !== undefined ? previousNightBedTime : existing.previousNightBedTime,
				wakeUpTime: wakeUpTime !== undefined ? wakeUpTime : existing.wakeUpTime,
				sleepLength: sleepLength !== undefined ? sleepLength : existing.sleepLength,
				cardioLoad: cardioLoad !== undefined ? cardioLoad : existing.cardioLoad,
				fitbitReadiness:
					fitbitReadiness !== undefined ? fitbitReadiness : existing.fitbitReadiness,
				steps: steps !== undefined ? steps : existing.steps,
				heartPoints: heartPoints !== undefined ? heartPoints : existing.heartPoints,
				restingHeartRate:
					restingHeartRate !== undefined ? restingHeartRate : existing.restingHeartRate,
				customMetrics:
					customMetrics !== undefined
						? JSON.stringify(customMetrics)
						: existing.customMetrics
			});

			return json({ metrics: updated });
		} else {
			const metrics = await services.dailyMetrics.create({
				id: uuidv4(),
				userId: locals.user.id,
				timePeriodId: period.id,
				previousNightBedTime: previousNightBedTime || null,
				wakeUpTime: wakeUpTime || null,
				sleepLength: sleepLength || null,
				cardioLoad: cardioLoad || null,
				fitbitReadiness: fitbitReadiness || null,
				steps: steps || null,
				heartPoints: heartPoints || null,
				restingHeartRate: restingHeartRate || null,
				customMetrics: customMetrics ? JSON.stringify(customMetrics) : null
			});

			return json({ metrics }, { status: 201 });
		}
	} catch (error) {
		console.error('Error updating metrics:', error);
		return json({ error: 'Failed to update metrics' }, { status: 500 });
	}
};
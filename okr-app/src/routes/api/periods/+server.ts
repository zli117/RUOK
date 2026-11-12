import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDatabase } from '$lib/server/database';
import { v4 as uuidv4 } from 'uuid';
import type { PeriodType } from '$lib/db/models';

// GET /api/periods - List time periods
export const GET: RequestHandler = async ({ locals, url }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const periodType = url.searchParams.get('type') as PeriodType | null;
	const year = url.searchParams.get('year');
	const month = url.searchParams.get('month');
	const week = url.searchParams.get('week');

	const services = await getDatabase();
	const periods = await services.timePeriods.listByUser(locals.user.id, {
		type: periodType ?? undefined,
		year: year ? parseInt(year) : undefined,
		month: month ? parseInt(month) : undefined,
		week: week ? parseInt(week) : undefined
	});

	return json({ periods });
};

// POST /api/periods - Create or get a time period
export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	try {
		const body = await request.json();
		const { periodType, year, month, week, day } = body;

		// Validate required fields
		if (!periodType || !['yearly', 'monthly', 'weekly', 'daily'].includes(periodType)) {
			return json({ error: 'Valid period type is required' }, { status: 400 });
		}

		if (!year || typeof year !== 'number') {
			return json({ error: 'Year is required' }, { status: 400 });
		}

		// Validate based on period type
		if (periodType === 'monthly' && (month === undefined || month < 1 || month > 12)) {
			return json({ error: 'Month (1-12) is required for monthly periods' }, { status: 400 });
		}

		if (periodType === 'weekly' && (week === undefined || week < 1 || week > 53)) {
			return json({ error: 'Week (1-53) is required for weekly periods' }, { status: 400 });
		}

		if (periodType === 'daily' && !day) {
			return json({ error: 'Day (ISO date) is required for daily periods' }, { status: 400 });
		}

		const services = await getDatabase();

		// Check if period already exists (using the typed lookup, preserving
		// backend-independent null/absent filtering).
		const existing = await services.timePeriods.find({
			userId: locals.user.id,
			type: periodType,
			year,
			month: periodType === 'yearly' ? undefined : (month ?? null),
			week: periodType === 'weekly' ? week : periodType === 'daily' ? null : undefined,
			day: periodType === 'daily' ? day : undefined
		});

		if (existing) {
			return json({ period: existing, created: false });
		}

		// Create new period
		const id = uuidv4();
		const now = new Date();

		const period = await services.timePeriods.create({
			id,
			userId: locals.user.id,
			periodType,
			year,
			month: periodType !== 'yearly' ? month : null,
			week: periodType === 'weekly' ? week : null,
			day: periodType === 'daily' ? day : null,
			createdAt: now,
			updatedAt: now
		});

		return json({ period, created: true }, { status: 201 });
	} catch (error) {
		console.error('Error creating time period:', error);
		return json({ error: 'Failed to create time period' }, { status: 500 });
	}
};
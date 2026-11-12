/**
 * Shared helpers used by multiple tool handlers to resolve or create a
 * time period (yearly/monthly/weekly/daily) for the current user.
 */

import { getDatabase } from '$lib/server/database';
import { v4 as uuidv4 } from 'uuid';
import { getWeekNumber, getWeekYear, type WeekStartDay } from '$lib/utils/week';

export async function findOrCreateDailyPeriod(userId: string, day: string): Promise<string> {
	const services = await getDatabase();
	const existing = await services.timePeriods.find({ userId, type: 'daily', day });
	if (existing) return existing.id;

	const date = new Date(day);
	const id = uuidv4();
	const now = new Date();
	await services.timePeriods.create({
		id,
		userId,
		periodType: 'daily',
		year: date.getUTCFullYear(),
		month: date.getUTCMonth() + 1,
		week: null,
		day,
		createdAt: now,
		updatedAt: now
	});
	return id;
}

export async function findOrCreateWeeklyPeriod(
	userId: string,
	year: number,
	week: number
): Promise<string> {
	const services = await getDatabase();
	const existing = await services.timePeriods.find({ userId, type: 'weekly', year, week });
	if (existing) return existing.id;

	const id = uuidv4();
	const now = new Date();
	await services.timePeriods.create({
		id,
		userId,
		periodType: 'weekly',
		year,
		month: null,
		week,
		day: null,
		createdAt: now,
		updatedAt: now
	});
	return id;
}

export function weekFromDate(day: string, weekStartDay: WeekStartDay): { year: number; week: number } {
	const date = new Date(`${day}T00:00:00Z`);
	return { year: getWeekYear(date, weekStartDay), week: getWeekNumber(date, weekStartDay) };
}
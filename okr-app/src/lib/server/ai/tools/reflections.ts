import { getDatabase } from '$lib/server/database';
import { v4 as uuidv4 } from 'uuid';
import { broadcastDataChange } from '$lib/server/events';
import { findOrCreateDailyPeriod, findOrCreateWeeklyPeriod } from './periods';
import type { ToolDef } from './types';

interface GetReflectionArgs {
	level: 'yearly' | 'monthly';
	year: number;
	month?: number;
}

export const getObjectiveReflection: ToolDef<GetReflectionArgs> = {
	name: 'get_objective_reflection',
	category: 'read',
	description: 'Fetch the user\'s reflection text for a yearly or monthly objective page.',
	parameters: {
		type: 'object',
		properties: {
			level: { type: 'string', enum: ['yearly', 'monthly'] },
			year: { type: 'integer' },
			month: { type: 'integer', description: '1-12, required when level=monthly' }
		},
		required: ['level', 'year']
	},
	preview: (a) =>
		`Get reflection: ${a.level} ${a.year}${a.level === 'monthly' ? `-${a.month}` : ''}`,
	async execute(ctx, args) {
		if (args.level === 'monthly' && !args.month) throw new Error('month required when level=monthly');
		const services = await getDatabase();
		const r = await services.objectiveReflections.findByUserLevelYearMonth({
			userId: ctx.userId,
			level: args.level,
			year: args.year,
			month: args.level === 'monthly' && args.month ? args.month : null
		});
		return { reflection: r?.reflection ?? '' };
	}
};

interface SetReflectionArgs {
	level: 'yearly' | 'monthly';
	year: number;
	month?: number;
	reflection: string;
}

export const setObjectiveReflection: ToolDef<SetReflectionArgs> = {
	name: 'set_objective_reflection',
	category: 'write',
	description:
		'Set the reflection text for a yearly or monthly objective page. Replaces existing reflection — pass the full new text.',
	parameters: {
		type: 'object',
		properties: {
			level: { type: 'string', enum: ['yearly', 'monthly'] },
			year: { type: 'integer' },
			month: { type: 'integer' },
			reflection: { type: 'string', description: 'Markdown body' }
		},
		required: ['level', 'year', 'reflection']
	},
	preview: (a) => {
		const where = a.level === 'monthly' ? `${a.year}-${a.month}` : String(a.year);
		const preview = a.reflection.length > 60 ? a.reflection.slice(0, 60) + '…' : a.reflection;
		return `Set ${a.level} reflection for ${where}: "${preview}"`;
	},
	async execute(ctx, args) {
		if (args.level === 'monthly' && !args.month) throw new Error('month required when level=monthly');
		const services = await getDatabase();
		const existing = await services.objectiveReflections.findByUserLevelYearMonth({
			userId: ctx.userId,
			level: args.level,
			year: args.year,
			month: args.level === 'monthly' && args.month ? args.month : null
		});
		const now = new Date();
		if (existing) {
			await services.objectiveReflections.update(existing.id, { reflection: args.reflection, updatedAt: now });
		} else {
			await services.objectiveReflections.create({
				id: uuidv4(),
				userId: ctx.userId,
				level: args.level,
				year: args.year,
				month: args.level === 'monthly' ? args.month! : null,
				reflection: args.reflection,
				createdAt: now,
				updatedAt: now
			});
		}
		broadcastDataChange(ctx.userId, 'data:objectives');
		return { ok: true };
	}
};

interface GetPeriodNotesArgs {
	scope: 'day' | 'week';
	day?: string;
	year?: number;
	week?: number;
}

export const getPeriodNotes: ToolDef<GetPeriodNotesArgs> = {
	name: 'get_period_notes',
	category: 'read',
	description:
		'Read the free-text notes/journal entry attached to a daily or weekly period. Empty string if none.',
	parameters: {
		type: 'object',
		properties: {
			scope: { type: 'string', enum: ['day', 'week'] },
			day: { type: 'string', description: 'YYYY-MM-DD when scope=day' },
			year: { type: 'integer' },
			week: { type: 'integer' }
		},
		required: ['scope']
	},
	preview: (a) =>
		a.scope === 'day' ? `Get notes for ${a.day}` : `Get notes for ${a.year}-W${a.week}`,
	async execute(ctx, args) {
		const services = await getDatabase();
		let period;
		if (args.scope === 'day') {
			if (!args.day) throw new Error('day required for scope=day');
			period = await services.timePeriods.find({ userId: ctx.userId, type: 'daily', day: args.day });
		} else {
			if (!args.year || !args.week) throw new Error('year and week required for scope=week');
			period = await services.timePeriods.find({ userId: ctx.userId, type: 'weekly', year: args.year, week: args.week });
		}
		return { notes: period?.notes ?? '' };
	}
};

interface SetPeriodNotesArgs {
	scope: 'day' | 'week';
	day?: string;
	year?: number;
	week?: number;
	notes: string;
}

export const setPeriodNotes: ToolDef<SetPeriodNotesArgs> = {
	name: 'set_period_notes',
	category: 'write',
	description:
		"Set the free-text notes/journal entry on a daily or weekly period. Replaces existing notes — pass the full new text. Creates the period if it doesn't exist yet.",
	parameters: {
		type: 'object',
		properties: {
			scope: { type: 'string', enum: ['day', 'week'] },
			day: { type: 'string' },
			year: { type: 'integer' },
			week: { type: 'integer' },
			notes: { type: 'string' }
		},
		required: ['scope', 'notes']
	},
	preview: (a) => {
		const where = a.scope === 'day' ? a.day : `${a.year}-W${a.week}`;
		const preview = a.notes.length > 60 ? a.notes.slice(0, 60) + '…' : a.notes;
		return `Set notes for ${where}: "${preview}"`;
	},
	async execute(ctx, args) {
		let periodId: string;
		if (args.scope === 'day') {
			if (!args.day) throw new Error('day required for scope=day');
			periodId = await findOrCreateDailyPeriod(ctx.userId, args.day);
		} else {
			if (!args.year || !args.week) throw new Error('year and week required for scope=week');
			periodId = await findOrCreateWeeklyPeriod(ctx.userId, args.year, args.week);
		}
		const services = await getDatabase();
		await services.timePeriods.update(periodId, { notes: args.notes, updatedAt: new Date() });
		broadcastDataChange(ctx.userId, 'data:daily', 'data:weekly');
		return { ok: true };
	}
};
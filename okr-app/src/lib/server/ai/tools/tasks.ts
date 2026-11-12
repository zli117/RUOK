import { getDatabase } from '$lib/server/database';
import { v4 as uuidv4 } from 'uuid';
import { broadcastDataChange } from '$lib/server/events';
import { findOrCreateDailyPeriod, findOrCreateWeeklyPeriod, weekFromDate } from './periods';
import type { ToolDef } from './types';

interface ListTasksArgs {
	scope: 'day' | 'week';
	day?: string;
	year?: number;
	week?: number;
	includeCompleted?: boolean;
}

export const listTasks: ToolDef<ListTasksArgs> = {
	name: 'list_tasks',
	category: 'read',
	description:
		"List the user's tasks in a given scope. Use scope='day' with a YYYY-MM-DD day, or scope='week' with year and week.",
	parameters: {
		type: 'object',
		properties: {
			scope: { type: 'string', enum: ['day', 'week'], description: "Period scope" },
			day: { type: 'string', description: 'YYYY-MM-DD, required when scope=day' },
			year: { type: 'integer', description: 'Required when scope=week' },
			week: { type: 'integer', description: 'Required when scope=week' },
			includeCompleted: { type: 'boolean', description: 'Default false' }
		},
		required: ['scope']
	},
	preview: (args) =>
		args.scope === 'day' ? `List tasks for ${args.day}` : `List tasks for ${args.year}-W${args.week}`,
	async execute(ctx, args) {
		let periodType: 'daily' | 'weekly';
		const services = await getDatabase();
		let period;
		if (args.scope === 'day') {
			if (!args.day) throw new Error('day is required for scope=day');
			periodType = 'daily';
			period = await services.timePeriods.find({ userId: ctx.userId, type: 'daily', day: args.day });
		} else {
			if (!args.year || !args.week) throw new Error('year and week required for scope=week');
			periodType = 'weekly';
			period = await services.timePeriods.find({ userId: ctx.userId, type: 'weekly', year: args.year, week: args.week });
		}
		if (!period) return { tasks: [] };

		let list = await services.tasks.listByPeriod(period.id);
		if (!args.includeCompleted) {
			list = list.filter((t) => !t.completed);
		}
		list.sort((a, b) => a.sortOrder - b.sortOrder);

		const result = await Promise.all(
			list.map(async (t) => {
				const attrs = await services.taskAttributes.listByTask(t.id);
				return {
					id: t.id,
					title: t.title,
					completed: t.completed,
					timeSpentMs: t.timeSpentMs,
					attributes: Object.fromEntries(attrs.map((a) => [a.key, a.value]))
				};
			})
		);
		return { periodType, tasks: result };
	}
};

interface CreateTaskArgs {
	title: string;
	scope: 'day' | 'week';
	day?: string;
	year?: number;
	week?: number;
	expectedHours?: number;
}

export const createTask: ToolDef<CreateTaskArgs, { taskId: string }> = {
	name: 'create_task',
	category: 'write',
	description:
		'Create a new task. Provide scope=day with a YYYY-MM-DD day to attach it to that daily plan, or scope=week with year+week for the weekly plan. expectedHours is optional.',
	parameters: {
		type: 'object',
		properties: {
			title: { type: 'string', description: 'Task title' },
			scope: { type: 'string', enum: ['day', 'week'] },
			day: { type: 'string', description: 'YYYY-MM-DD; required when scope=day' },
			year: { type: 'integer' },
			week: { type: 'integer' },
			expectedHours: { type: 'number', description: 'Optional estimate in hours' }
		},
		required: ['title', 'scope']
	},
	preview: (a) => {
		const where = a.scope === 'day' ? a.day : `${a.year}-W${a.week}`;
		const hours = a.expectedHours ? ` · ${a.expectedHours}h` : '';
		return `Create task: "${a.title}" → ${where}${hours}`;
	},
	async execute(ctx, args) {
		let periodId: string;
		if (args.scope === 'day') {
			if (!args.day) throw new Error('day is required for scope=day');
			periodId = await findOrCreateDailyPeriod(ctx.userId, args.day);
		} else {
			let year = args.year;
			let week = args.week;
			if ((!year || !week) && args.day) {
				const wk = weekFromDate(args.day, ctx.weekStartDay);
				year = wk.year;
				week = wk.week;
			}
			if (!year || !week) throw new Error('year and week required for scope=week');
			periodId = await findOrCreateWeeklyPeriod(ctx.userId, year, week);
		}

		const services = await getDatabase();
		const existing = await services.tasks.listByPeriod(periodId);
		const maxSortOrder = existing.reduce((m, t) => Math.max(m, t.sortOrder), -1);

		const taskId = uuidv4();
		const now = new Date();
		const attributes =
			args.expectedHours !== undefined
				? { expected_hours: args.expectedHours }
				: undefined;

		await services.createTaskWithDetails({
			task: {
				id: taskId,
				userId: ctx.userId,
				timePeriodId: periodId,
				title: args.title,
				sortOrder: maxSortOrder + 1,
				createdAt: now,
				updatedAt: now
			},
			attributes
		});

		broadcastDataChange(ctx.userId, 'data:tasks', 'data:weekly');
		return { taskId };
	}
};

interface UpdateTaskArgs {
	taskId: string;
	title?: string;
	completed?: boolean;
	expectedHours?: number;
}

export const updateTask: ToolDef<UpdateTaskArgs> = {
	name: 'update_task',
	category: 'write',
	description: 'Update an existing task. Use the task id from list_tasks.',
	parameters: {
		type: 'object',
		properties: {
			taskId: { type: 'string', description: 'Task ID' },
			title: { type: 'string' },
			completed: { type: 'boolean' },
			expectedHours: { type: 'number' }
		},
		required: ['taskId']
	},
	preview: (a) => {
		const parts: string[] = [];
		if (a.title !== undefined) parts.push(`title="${a.title}"`);
		if (a.completed !== undefined) parts.push(a.completed ? 'mark complete' : 'mark incomplete');
		if (a.expectedHours !== undefined) parts.push(`${a.expectedHours}h`);
		return `Update task ${a.taskId.slice(0, 8)}: ${parts.join(', ') || '(no changes)'}`;
	},
	async execute(ctx, args) {
		const services = await getDatabase();
		const existing = await services.tasks.findById(args.taskId);
		if (!existing || existing.userId !== ctx.userId) throw new Error('Task not found');

		const updates: {
			title?: string;
			completed?: boolean;
			completedAt?: Date | null;
			updatedAt?: Date;
		} = { updatedAt: new Date() };
		if (args.title !== undefined) updates.title = args.title;
		if (args.completed !== undefined) {
			updates.completed = args.completed;
			updates.completedAt = args.completed ? new Date() : null;
		}
		if (Object.keys(updates).length > 1) {
			await services.tasks.update(args.taskId, updates);
		}

		if (args.expectedHours !== undefined) {
			await services.taskAttributes.upsertByTaskAndKey({
				taskId: args.taskId,
				key: 'expected_hours',
				value: String(args.expectedHours),
				valueType: 'number'
			});
		}

		broadcastDataChange(ctx.userId, 'data:tasks', 'data:weekly');
		return { ok: true };
	}
};

interface SetTaskAttributeArgs {
	taskId: string;
	key: string;
	value: string | number | null;
}

export const setTaskAttribute: ToolDef<SetTaskAttributeArgs> = {
	name: 'set_task_attribute',
	category: 'write',
	description:
		'Set a flexible attribute on a task. Common keys: "progress" (0..100 number), "hour" (HH:MM string), "expected_hours" (number). Pass value=null to remove.',
	parameters: {
		type: 'object',
		properties: {
			taskId: { type: 'string' },
			key: { type: 'string' },
			value: { type: 'string' }
		},
		required: ['taskId', 'key']
	},
	preview: (a) => `Set ${a.key}=${a.value === null ? '∅' : a.value} on task ${a.taskId.slice(0, 8)}`,
	async execute(ctx, args) {
		const services = await getDatabase();
		const task = await services.tasks.findById(args.taskId);
		if (!task || task.userId !== ctx.userId) throw new Error('Task not found');

		if (args.value === null) {
			await services.taskAttributes.removeByTaskAndKey(args.taskId, args.key);
		} else {
			const valueType = typeof args.value === 'number' ? 'number' : 'text';
			await services.taskAttributes.upsertByTaskAndKey({
				taskId: args.taskId,
				key: args.key,
				value: String(args.value),
				valueType
			});
		}
		broadcastDataChange(ctx.userId, 'data:tasks', 'data:weekly');
		return { ok: true };
	}
};

interface TaskTimerArgs {
	taskId: string;
	action: 'start' | 'stop';
}

export const controlTaskTimer: ToolDef<TaskTimerArgs> = {
	name: 'control_task_timer',
	category: 'write',
	description: 'Start or stop the time-tracking timer on a task.',
	parameters: {
		type: 'object',
		properties: {
			taskId: { type: 'string' },
			action: { type: 'string', enum: ['start', 'stop'] }
		},
		required: ['taskId', 'action']
	},
	preview: (a) => `${a.action === 'start' ? 'Start' : 'Stop'} timer on task ${a.taskId.slice(0, 8)}`,
	async execute(ctx, args) {
		const services = await getDatabase();
		const task = await services.tasks.findById(args.taskId);
		if (!task || task.userId !== ctx.userId) throw new Error('Task not found');
		const now = new Date();
		if (args.action === 'start') {
			if (task.timerStartedAt) throw new Error('Timer already running');
			await services.tasks.startTimer(args.taskId, now);
		} else {
			if (!task.timerStartedAt) throw new Error('Timer is not running');
			await services.tasks.stopTimer(args.taskId, now);
		}
		broadcastDataChange(ctx.userId, 'data:tasks', 'data:weekly');
		return { ok: true };
	}
};

interface DeleteTaskArgs {
	taskId: string;
}

export const deleteTask: ToolDef<DeleteTaskArgs> = {
	name: 'delete_task',
	category: 'write',
	description: 'Delete a task by id.',
	parameters: {
		type: 'object',
		properties: { taskId: { type: 'string' } },
		required: ['taskId']
	},
	preview: (a) => `Delete task ${a.taskId.slice(0, 8)}`,
	async execute(ctx, args) {
		const services = await getDatabase();
		const existing = await services.tasks.findById(args.taskId);
		if (!existing || existing.userId !== ctx.userId) throw new Error('Task not found');
		await services.tasks.remove(args.taskId);
		broadcastDataChange(ctx.userId, 'data:tasks', 'data:weekly');
		return { ok: true };
	}
};
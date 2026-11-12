import { getDatabase } from '$lib/server/database';
import type { MetricDefinition } from '$lib/db/models';
import { v4 as uuidv4 } from 'uuid';
import { broadcastDataChange } from '$lib/server/events';
import type { ToolDef } from './types';

type DefinitionInput = {
	name: string;
	label: string;
	type: 'input' | 'computed' | 'external';
	inputType?: 'number' | 'time' | 'text' | 'boolean';
	unit?: string;
	expression?: string;
	source?: string;
};

async function getActiveTemplate(userId: string, date: string) {
	const services = await getDatabase();
	return services.metricsTemplates.findActiveByDate(userId, date);
}

interface ListMetricsArgs {
	date: string;
}

export const listMetrics: ToolDef<ListMetricsArgs> = {
	name: 'list_metrics',
	category: 'read',
	description:
		"List the user's tracked metric definitions plus stored values for a given date (YYYY-MM-DD). Returns the metrics template and current values.",
	parameters: {
		type: 'object',
		properties: { date: { type: 'string', description: 'YYYY-MM-DD' } },
		required: ['date']
	},
	preview: (a) => `List metrics for ${a.date}`,
	async execute(ctx, args) {
		const template = await getActiveTemplate(ctx.userId, args.date);
		if (!template) return { template: null, values: {} };
		const definitions: MetricDefinition[] = JSON.parse(template.metricsDefinition);
		const services = await getDatabase();
		const stored = await services.dailyMetricValues.listByUserAndDate(ctx.userId, args.date);
		const values: Record<string, string | null> = {};
		for (const v of stored) values[v.metricName] = v.value;
		return {
			metrics: definitions.map((d) => ({
				name: d.name,
				label: d.label,
				type: d.type,
				inputType: d.inputType,
				unit: d.unit,
				value: values[d.name] ?? null
			}))
		};
	}
};

interface SetMetricValueArgs {
	date: string;
	name: string;
	value: string | number | boolean | null;
}

export const setMetricValue: ToolDef<SetMetricValueArgs> = {
	name: 'set_metric_value',
	category: 'write',
	description:
		"Set the value of one input-type metric for a date. Only metrics with type='input' can be set; computed/external metrics cannot.",
	parameters: {
		type: 'object',
		properties: {
			date: { type: 'string', description: 'YYYY-MM-DD' },
			name: { type: 'string', description: 'Metric name (machine identifier, not label)' },
			value: { type: 'string', description: 'Value as string; numbers/booleans will be stringified' }
		},
		required: ['date', 'name', 'value']
	},
	preview: (a) => `Set ${a.name} = ${a.value} on ${a.date}`,
	async execute(ctx, args) {
		const template = await getActiveTemplate(ctx.userId, args.date);
		if (!template) throw new Error('No metrics template active for this date');
		const definitions: MetricDefinition[] = JSON.parse(template.metricsDefinition);
		const def = definitions.find((d) => d.name === args.name);
		if (!def) throw new Error(`Unknown metric: ${args.name}`);
		if (def.type !== 'input') throw new Error(`Metric "${args.name}" is ${def.type}, cannot be set directly`);

		const stringValue = args.value === null ? null : String(args.value);
		const services = await getDatabase();
		await services.dailyMetricValues.upsert({
			id: uuidv4(),
			userId: ctx.userId,
			date: args.date,
			metricName: args.name,
			value: stringValue,
			source: 'user'
		});
		broadcastDataChange(ctx.userId, 'data:metrics');
		return { ok: true };
	}
};

export const listMetricsTemplates: ToolDef = {
	name: 'list_metrics_templates',
	category: 'read',
	description:
		"List all the user's metrics templates (versioned by effectiveFrom date). The template active for a given date is the one with the latest effectiveFrom <= that date.",
	parameters: { type: 'object', properties: {} },
	preview: () => 'List metrics templates',
	async execute(ctx) {
		const services = await getDatabase();
		const rows = await services.metricsTemplates.listByUser(ctx.userId);
		rows.sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
		return {
			templates: rows.map((t) => ({
				id: t.id,
				name: t.name,
				effectiveFrom: t.effectiveFrom,
				metricsDefinition: JSON.parse(t.metricsDefinition) as MetricDefinition[]
			}))
		};
	}
};

interface CreateTemplateArgs {
	effectiveFrom: string;
	metricsDefinition: DefinitionInput[];
	name?: string;
}

export const createMetricsTemplate: ToolDef<CreateTemplateArgs, { templateId: string }> = {
	name: 'create_metrics_template',
	category: 'write',
	description:
		"Create a new metrics template. effectiveFrom is YYYY-MM-DD — from this date forward the new template controls what fields show on the daily metrics page. metricsDefinition is an array of {name, label, type, inputType?, unit?, expression?, source?} objects.",
	parameters: {
		type: 'object',
		properties: {
			effectiveFrom: { type: 'string', description: 'YYYY-MM-DD' },
			name: { type: 'string' },
			metricsDefinition: {
				type: 'array',
				description: 'Array of MetricDefinition objects',
				items: { type: 'object', description: '{name, label, type, ...}' }
			}
		},
		required: ['effectiveFrom', 'metricsDefinition']
	},
	preview: (a) => `Create metrics template (effective ${a.effectiveFrom}, ${a.metricsDefinition.length} fields)`,
	async execute(ctx, args) {
		const id = uuidv4();
		const services = await getDatabase();
		await services.metricsTemplates.create({
			id,
			userId: ctx.userId,
			name: args.name ?? 'default',
			effectiveFrom: args.effectiveFrom,
			metricsDefinition: JSON.stringify(args.metricsDefinition)
		});
		broadcastDataChange(ctx.userId, 'data:metrics');
		return { templateId: id };
	}
};

interface UpdateTemplateArgs {
	templateId: string;
	name?: string;
	effectiveFrom?: string;
	metricsDefinition?: DefinitionInput[];
}

export const updateMetricsTemplate: ToolDef<UpdateTemplateArgs> = {
	name: 'update_metrics_template',
	category: 'write',
	description:
		'Update an existing metrics template. Passing metricsDefinition replaces the entire array.',
	parameters: {
		type: 'object',
		properties: {
			templateId: { type: 'string' },
			name: { type: 'string' },
			effectiveFrom: { type: 'string' },
			metricsDefinition: { type: 'array', items: { type: 'object' } }
		},
		required: ['templateId']
	},
	preview: (a) => `Update metrics template ${a.templateId.slice(0, 8)}`,
	async execute(ctx, args) {
		const services = await getDatabase();
		const existing = await services.metricsTemplates.findById(args.templateId);
		if (!existing || existing.userId !== ctx.userId) throw new Error('Template not found');
		const updates: { name?: string; effectiveFrom?: string; metricsDefinition?: string; updatedAt?: Date } = { updatedAt: new Date() };
		if (args.name !== undefined) updates.name = args.name;
		if (args.effectiveFrom !== undefined) updates.effectiveFrom = args.effectiveFrom;
		if (args.metricsDefinition !== undefined)
			updates.metricsDefinition = JSON.stringify(args.metricsDefinition);
		await services.metricsTemplates.update(args.templateId, updates);
		broadcastDataChange(ctx.userId, 'data:metrics');
		return { ok: true };
	}
};

interface DeleteTemplateArgs {
	templateId: string;
}

export const deleteMetricsTemplate: ToolDef<DeleteTemplateArgs> = {
	name: 'delete_metrics_template',
	category: 'write',
	description: 'Delete a metrics template.',
	parameters: {
		type: 'object',
		properties: { templateId: { type: 'string' } },
		required: ['templateId']
	},
	preview: (a) => `Delete metrics template ${a.templateId.slice(0, 8)}`,
	async execute(ctx, args) {
		const services = await getDatabase();
		const existing = await services.metricsTemplates.findById(args.templateId);
		if (!existing || existing.userId !== ctx.userId) throw new Error('Template not found');
		await services.metricsTemplates.remove(args.templateId);
		broadcastDataChange(ctx.userId, 'data:metrics');
		return { ok: true };
	}
};
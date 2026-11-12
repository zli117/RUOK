import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDatabase } from '$lib/server/database';
import type { MetricDefinition } from '$lib/db/models';
import { v4 as uuidv4 } from 'uuid';
import { evaluateMetrics, type MetricValues } from '$lib/server/metrics/evaluator';
import { fetchExternalMetrics, getExternalSourceIds } from '$lib/server/metrics/external';

/**
 * Get stored metric values for a date
 */
async function getStoredValues(userId: string, date: string): Promise<MetricValues> {
	const services = await getDatabase();
	const values = await services.dailyMetricValues.listByUserAndDate(userId, date);

	const result: MetricValues = {};
	for (const v of values) {
		result[v.metricName] = v.value;
	}
	return result;
}

// GET /api/metrics/flexible/[date] - Get metrics with template for a date
export const GET: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const date = params.date;
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
		return json({ error: 'Invalid date format. Use YYYY-MM-DD' }, { status: 400 });
	}

	const services = await getDatabase();

	// Get the active template (version selected by effectiveFrom <= date)
	const template = await services.metricsTemplates.findActiveByDate(locals.user.id, date);

	if (!template) {
		return json({
			template: null,
			metrics: [],
			values: {},
			computedValues: {},
			errors: {}
		});
	}

	const metricsDefinition: MetricDefinition[] = JSON.parse(template.metricsDefinition);

	// Get stored user input values
	const storedValues = await getStoredValues(locals.user.id, date);

	// Get external source values
	const externalSourceIds = getExternalSourceIds(metricsDefinition);
	const externalValues = externalSourceIds.length > 0
		? await fetchExternalMetrics(locals.user.id, date, externalSourceIds)
		: {};

	// Map external values to metric names
	const mappedExternalValues: MetricValues = {};
	for (const metric of metricsDefinition) {
		if (metric.type === 'external' && metric.source) {
			mappedExternalValues[metric.name] = externalValues[metric.source] ?? null;
		}
	}

	// Evaluate all metrics (inputs, computed, external)
	const { values, errors } = await evaluateMetrics(
		metricsDefinition,
		storedValues,
		mappedExternalValues,
		date
	);

	return json({
		template: {
			id: template.id,
			name: template.name,
			effectiveFrom: template.effectiveFrom
		},
		metrics: metricsDefinition,
		values,
		errors
	});
};

// PUT /api/metrics/flexible/[date] - Save metric values
export const PUT: RequestHandler = async ({ locals, params, request }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const date = params.date;
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
		return json({ error: 'Invalid date format. Use YYYY-MM-DD' }, { status: 400 });
	}

	try {
		const body = await request.json();
		const { values } = body as { values: Record<string, string | number | boolean | null> };

		if (!values || typeof values !== 'object') {
			return json({ error: 'Values object required' }, { status: 400 });
		}

		const services = await getDatabase();

		// Get the active template to validate metric names
		const template = await services.metricsTemplates.findActiveByDate(locals.user.id, date);
		if (!template) {
			return json({ error: 'No active template for this date' }, { status: 400 });
		}

		const metricsDefinition: MetricDefinition[] = JSON.parse(template.metricsDefinition);
		const inputMetricNames = metricsDefinition
			.filter((m) => m.type === 'input')
			.map((m) => m.name);

		// Only save input-type metrics (not computed or external)
		for (const [metricName, value] of Object.entries(values)) {
			if (!inputMetricNames.includes(metricName)) continue;

			const stringValue = value === null ? null : String(value);
			await services.dailyMetricValues.upsert({
				id: uuidv4(),
				userId: locals.user.id,
				date,
				metricName,
				value: stringValue,
				source: 'user'
			});
		}

		// Re-evaluate all metrics and return
		const storedValues = await getStoredValues(locals.user.id, date);

		const externalSourceIds = getExternalSourceIds(metricsDefinition);
		const externalValues = externalSourceIds.length > 0
			? await fetchExternalMetrics(locals.user.id, date, externalSourceIds)
			: {};

		const mappedExternalValues: MetricValues = {};
		for (const metric of metricsDefinition) {
			if (metric.type === 'external' && metric.source) {
				mappedExternalValues[metric.name] = externalValues[metric.source] ?? null;
			}
		}

		const { values: evaluatedValues, errors } = await evaluateMetrics(
			metricsDefinition,
			storedValues,
			mappedExternalValues,
			date
		);

		return json({
			success: true,
			values: evaluatedValues,
			errors
		});
	} catch (error) {
		console.error('Error saving metrics:', error);
		return json({ error: 'Failed to save metrics' }, { status: 500 });
	}
};
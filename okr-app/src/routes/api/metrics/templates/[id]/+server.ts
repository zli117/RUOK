import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDatabase } from '$lib/server/database';

// GET /api/metrics/templates/[id] - Get a specific template
export const GET: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const services = await getDatabase();
	const template = await services.metricsTemplates.findById(params.id);

	if (!template || template.userId !== locals.user.id) {
		return json({ error: 'Template not found' }, { status: 404 });
	}

	return json({ template });
};

// PUT /api/metrics/templates/[id] - Update a template
export const PUT: RequestHandler = async ({ locals, params, request }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const services = await getDatabase();
	const existing = await services.metricsTemplates.findById(params.id);
	if (!existing || existing.userId !== locals.user.id) {
		return json({ error: 'Template not found' }, { status: 404 });
	}

	try {
		const body = await request.json();
		const { name, effectiveFrom, metricsDefinition } = body;

		const updates: Record<string, unknown> = {
			updatedAt: new Date()
		};

		if (name !== undefined) updates.name = name;
		if (effectiveFrom !== undefined) updates.effectiveFrom = effectiveFrom;
		if (metricsDefinition !== undefined) {
			if (!Array.isArray(metricsDefinition)) {
				return json({ error: 'metricsDefinition must be an array' }, { status: 400 });
			}
			updates.metricsDefinition = JSON.stringify(metricsDefinition);
		}

		const updated = await services.metricsTemplates.update(params.id, updates);

		return json({ template: updated });
	} catch (error) {
		console.error('Error updating template:', error);
		return json({ error: 'Failed to update template' }, { status: 500 });
	}
};

// DELETE /api/metrics/templates/[id] - Delete a template
export const DELETE: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const services = await getDatabase();
	const existing = await services.metricsTemplates.findById(params.id);
	if (!existing || existing.userId !== locals.user.id) {
		return json({ error: 'Template not found' }, { status: 404 });
	}

	await services.metricsTemplates.remove(params.id);

	return json({ success: true });
};
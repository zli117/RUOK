import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDatabase } from '$lib/server/database';
import { v4 as uuidv4 } from 'uuid';

// GET /api/dashboard/widgets - Get all widgets for the current user
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const services = await getDatabase();
	const widgets = await services.dashboardWidgets.listByUserAndPage(locals.user.id, 'dashboard');

	return json({
		widgets: widgets.map(w => ({
			id: w.id,
			title: w.title,
			widgetType: w.widgetType,
			config: JSON.parse(w.config),
			sortOrder: w.sortOrder
		}))
	});
};

// POST /api/dashboard/widgets - Create a new widget
export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	try {
		const body = await request.json();
		const { title, code, queryId } = body;

		const services = await getDatabase();
		// Get max sort order
		const existing = await services.dashboardWidgets.listByUserAndPage(locals.user.id, 'dashboard');
		const maxSortOrder = existing.reduce((max, w) => Math.max(max, w.sortOrder), -1);

		const id = uuidv4();
		const widgetType = queryId ? 'saved' : 'custom';
		const config = JSON.stringify(queryId ? { queryId } : { code: code || '' });

		await services.dashboardWidgets.create({
			id,
			userId: locals.user.id,
			title: title || 'New Widget',
			widgetType,
			config,
			sortOrder: maxSortOrder + 1,
			page: 'dashboard'
		});

		const widget = await services.dashboardWidgets.findById(id);

		return json({
			widget: {
				id: widget!.id,
				title: widget!.title,
				widgetType: widget!.widgetType,
				config: JSON.parse(widget!.config),
				sortOrder: widget!.sortOrder
			}
		}, { status: 201 });
	} catch (error) {
		console.error('Error creating widget:', error);
		return json({ error: 'Failed to create widget' }, { status: 500 });
	}
};
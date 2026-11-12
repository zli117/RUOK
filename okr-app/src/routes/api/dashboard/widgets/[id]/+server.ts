import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDatabase } from '$lib/server/database';

// PUT /api/dashboard/widgets/[id] - Update a widget
export const PUT: RequestHandler = async ({ locals, params, request }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const services = await getDatabase();
	const widget = await services.dashboardWidgets.findByIdForUser(params.id, locals.user.id);

	if (!widget) {
		return json({ error: 'Widget not found' }, { status: 404 });
	}

	try {
		const body = await request.json();
		const { title, code, queryId, sortOrder } = body;

		const updates: {
			title?: string;
			widgetType?: 'builtin' | 'custom' | 'saved';
			config?: string;
			sortOrder?: number;
		} = {};

		if (title !== undefined) {
			updates.title = title;
		}

		if (code !== undefined || queryId !== undefined) {
			const widgetType = queryId ? 'saved' : 'custom';
			updates.widgetType = widgetType;
			updates.config = JSON.stringify(queryId ? { queryId } : { code });
		}

		if (sortOrder !== undefined) {
			updates.sortOrder = sortOrder;
		}

		if (Object.keys(updates).length === 0) {
			return json({ error: 'No updates provided' }, { status: 400 });
		}

		await services.dashboardWidgets.update(params.id, updates);

		const updatedWidget = await services.dashboardWidgets.findById(params.id);

		return json({
			widget: {
				id: updatedWidget!.id,
				title: updatedWidget!.title,
				widgetType: updatedWidget!.widgetType,
				config: JSON.parse(updatedWidget!.config),
				sortOrder: updatedWidget!.sortOrder
			}
		});
	} catch (error) {
		console.error('Error updating widget:', error);
		return json({ error: 'Failed to update widget' }, { status: 500 });
	}
};

// DELETE /api/dashboard/widgets/[id] - Delete a widget
export const DELETE: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const services = await getDatabase();
	const widget = await services.dashboardWidgets.findByIdForUser(params.id, locals.user.id);

	if (!widget) {
		return json({ error: 'Widget not found' }, { status: 404 });
	}

	await services.dashboardWidgets.remove(params.id);

	return json({ success: true });
};
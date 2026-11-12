import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDatabase } from '$lib/server/database';
import { executeQuery } from '$lib/server/query/executor';

// GET /api/queries/[id] - Get a single saved query
export const GET: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const services = await getDatabase();
	const query = await services.savedQueries.findByIdForUser(params.id, locals.user.id);

	if (!query) {
		return json({ error: 'Query not found' }, { status: 404 });
	}

	return json({ query });
};

// PUT /api/queries/[id] - Update a saved query
export const PUT: RequestHandler = async ({ locals, params, request }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const services = await getDatabase();
	const existing = await services.savedQueries.findByIdForUser(params.id, locals.user.id);

	if (!existing) {
		return json({ error: 'Query not found' }, { status: 404 });
	}

	try {
		const body = await request.json();
		const { name, description, code, queryType } = body;

		const updates: {
			name?: string;
			description?: string | null;
			code?: string;
			queryType?: 'progress' | 'widget' | 'general';
			updatedAt?: Date;
		} = {
			updatedAt: new Date()
		};

		if (name !== undefined) updates.name = name.trim();
		if (description !== undefined) updates.description = description?.trim() || null;
		if (code !== undefined) updates.code = code;
		if (queryType !== undefined) {
			const validTypes = ['progress', 'widget', 'general'];
			if (validTypes.includes(queryType)) {
				updates.queryType = queryType;
			}
		}

		await services.savedQueries.update(params.id, updates);

		const query = await services.savedQueries.findById(params.id);

		return json({ query });
	} catch (error) {
		console.error('Error updating query:', error);
		return json({ error: 'Failed to update query' }, { status: 500 });
	}
};

// DELETE /api/queries/[id] - Delete a saved query
export const DELETE: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const services = await getDatabase();
	const existing = await services.savedQueries.findByIdForUser(params.id, locals.user.id);

	if (!existing) {
		return json({ error: 'Query not found' }, { status: 404 });
	}

	await services.savedQueries.remove(params.id);

	return json({ success: true });
};

// POST /api/queries/[id]/run - Run a saved query with params
export const POST: RequestHandler = async ({ locals, params, request }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const services = await getDatabase();
	const query = await services.savedQueries.findByIdForUser(params.id, locals.user.id);

	if (!query) {
		return json({ error: 'Query not found' }, { status: 404 });
	}

	try {
		const body = await request.json().catch(() => ({}));
		const { params: queryParams } = body;

		const result = await executeQuery(query.code, locals.user.id, queryParams || {});

		if (result.error) {
			return json({ error: result.error }, { status: 400 });
		}

		return json({ result: result.result });
	} catch (error) {
		console.error('Error running query:', error);
		return json({ error: 'Failed to run query' }, { status: 500 });
	}
};
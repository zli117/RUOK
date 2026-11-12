import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDatabase } from '$lib/server/database';
import { v4 as uuidv4 } from 'uuid';

// GET /api/tags - List all tags for the current user
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const services = await getDatabase();
	const userTags = await services.tags.listByUser(locals.user.id);

	return json({ tags: userTags });
};

// POST /api/tags - Create a new tag
export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	try {
		const body = await request.json();
		const { name, color, category } = body;

		if (!name || typeof name !== 'string') {
			return json({ error: 'Name is required' }, { status: 400 });
		}

		const services = await getDatabase();

		// Check if tag already exists (owner scope preserved)
		const existing = await services.tags.findByUserAndName(locals.user.id, name.trim());
		if (existing) {
			return json({ error: 'Tag already exists' }, { status: 409 });
		}

		const tag = await services.tags.create({
			id: uuidv4(),
			userId: locals.user.id,
			name: name.trim(),
			color: color || null,
			category: category || null
		});

		return json({ tag }, { status: 201 });
	} catch (error) {
		console.error('Error creating tag:', error);
		return json({ error: 'Failed to create tag' }, { status: 500 });
	}
};
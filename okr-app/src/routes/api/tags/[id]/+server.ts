import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDatabase } from '$lib/server/database';

// PUT /api/tags/[id] - Update a tag
export const PUT: RequestHandler = async ({ locals, params, request }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	try {
		const { id } = params;
		const body = await request.json();
		const { name, color, category } = body;

		const services = await getDatabase();

		// Verify tag belongs to user
		const existing = await services.tags.findById(id);
		if (!existing || existing.userId !== locals.user.id) {
			return json({ error: 'Tag not found' }, { status: 404 });
		}

		// Check for duplicate name (excluding current tag)
		if (name && name.trim() !== existing.name) {
			const duplicate = await services.tags.findByUserAndName(locals.user.id, name.trim());
			if (duplicate && duplicate.id !== id) {
				return json({ error: 'Tag with this name already exists' }, { status: 409 });
			}
		}

		const tag = await services.tags.update(id, {
			name: name?.trim() ?? existing.name,
			color: color !== undefined ? color : existing.color,
			category: category !== undefined ? category : existing.category
		});

		return json({ tag });
	} catch (error) {
		console.error('Error updating tag:', error);
		return json({ error: 'Failed to update tag' }, { status: 500 });
	}
};

// DELETE /api/tags/[id] - Delete a tag
export const DELETE: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	try {
		const { id } = params;

		const services = await getDatabase();

		// Verify tag belongs to user
		const existing = await services.tags.findById(id);
		if (!existing || existing.userId !== locals.user.id) {
			return json({ error: 'Tag not found' }, { status: 404 });
		}

		await services.tags.remove(id);

		return json({ success: true });
	} catch (error) {
		console.error('Error deleting tag:', error);
		return json({ error: 'Failed to delete tag' }, { status: 500 });
	}
};
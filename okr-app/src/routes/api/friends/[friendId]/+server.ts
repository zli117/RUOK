import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDatabase } from '$lib/server/database';

// DELETE /api/friends/[friendId] - Unfriend a user
export const DELETE: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	try {
		const friendId = params.friendId;
		const userId = locals.user.id;
		const services = await getDatabase();

		// Find the friendship (could be in either direction)
		const friendship = await services.friendships.findBetween(userId, friendId);

		if (!friendship) {
			return json({ error: 'Friendship not found' }, { status: 404 });
		}

		// Delete the friendship
		await services.friendships.remove(friendship.id);

		// Optionally delete the notes (from both sides)
		await services.friendNotes.removeBetween(userId, friendId);

		return json({ success: true });
	} catch (error) {
		console.error('Error unfriending user:', error);
		return json({ error: 'Failed to unfriend user' }, { status: 500 });
	}
};
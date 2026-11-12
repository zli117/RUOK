import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDatabase } from '$lib/server/database';
import { v4 as uuidv4 } from 'uuid';

// Helper to verify friendship exists
async function verifyFriendship(userId: string, friendId: string) {
	const services = await getDatabase();
	return services.friendships.findBetween(userId, friendId);
}

// GET /api/friends/[friendId]/notes - Get private notes about a friend
export const GET: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	try {
		const friendId = params.friendId;
		const userId = locals.user.id;
		const services = await getDatabase();

		// Verify friendship exists
		const friendship = await verifyFriendship(userId, friendId);
		if (!friendship) {
			return json({ error: 'Not friends with this user' }, { status: 403 });
		}

		// Get the note
		const note = await services.friendNotes.findByUserAndFriend(userId, friendId);

		return json({ note: note?.note || '' });
	} catch (error) {
		console.error('Error getting friend notes:', error);
		return json({ error: 'Failed to get notes' }, { status: 500 });
	}
};

// PUT /api/friends/[friendId]/notes - Update private notes about a friend
export const PUT: RequestHandler = async ({ locals, request, params }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	try {
		const body = await request.json();
		const { note } = body;
		const friendId = params.friendId;
		const userId = locals.user.id;
		const services = await getDatabase();

		if (typeof note !== 'string') {
			return json({ error: 'Note must be a string' }, { status: 400 });
		}

		// Verify friendship exists
		const friendship = await verifyFriendship(userId, friendId);
		if (!friendship) {
			return json({ error: 'Not friends with this user' }, { status: 403 });
		}

		const now = new Date();

		// Upsert the private note for (userId, friendId)
		await services.friendNotes.upsert({
			id: uuidv4(),
			userId,
			friendId,
			note,
			updatedAt: now
		});

		return json({ note, updatedAt: now });
	} catch (error) {
		console.error('Error updating friend notes:', error);
		return json({ error: 'Failed to update notes' }, { status: 500 });
	}
};
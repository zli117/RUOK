import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDatabase } from '$lib/server/database';
import { v4 as uuidv4 } from 'uuid';

// POST /api/friends/requests/[id] - Accept or decline a friend request
export const POST: RequestHandler = async ({ locals, request, params }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	try {
		const body = await request.json();
		const { action } = body;
		const requestId = params.id;
		const userId = locals.user.id;
		const services = await getDatabase();

		if (!action || !['accept', 'decline'].includes(action)) {
			return json({ error: 'Invalid action. Must be "accept" or "decline"' }, { status: 400 });
		}

		// Find the request - must be sent TO this user and be pending
		const friendRequest = await services.friendRequests.findPendingTo(requestId, userId);

		if (!friendRequest) {
			return json({ error: 'Friend request not found or already processed' }, { status: 404 });
		}

		const now = new Date();

		if (action === 'decline') {
			// Update request status to declined
			await services.friendRequests.update(requestId, { status: 'declined', respondedAt: now });

			return json({ success: true, status: 'declined' });
		}

		// Accept: Update request and create friendship
		await services.friendRequests.update(requestId, { status: 'accepted', respondedAt: now });

		// Create friendship (ensure userId1 < userId2 for consistency)
		const [id1, id2] =
			friendRequest.fromUserId < userId
				? [friendRequest.fromUserId, userId]
				: [userId, friendRequest.fromUserId];

		const friendshipId = uuidv4();
		await services.friendships.create({
			id: friendshipId,
			userId1: id1,
			userId2: id2,
			createdAt: now
		});

		// Get friend info
		const friend = await services.users.findById(friendRequest.fromUserId);

		return json({
			success: true,
			status: 'accepted',
			friendship: {
				id: friendshipId,
				friendId: friend?.id,
				friendUsername: friend?.username
			}
		});
	} catch (error) {
		console.error('Error processing friend request:', error);
		return json({ error: 'Failed to process friend request' }, { status: 500 });
	}
};

// DELETE /api/friends/requests/[id] - Cancel an outgoing friend request
export const DELETE: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	try {
		const requestId = params.id;
		const userId = locals.user.id;
		const services = await getDatabase();

		// Find the request - must be sent BY this user and be pending
		const friendRequest = await services.friendRequests.findPendingFrom(requestId, userId);

		if (!friendRequest) {
			return json({ error: 'Friend request not found or cannot be cancelled' }, { status: 404 });
		}

		// Delete the request
		await services.friendRequests.remove(requestId);

		return json({ success: true });
	} catch (error) {
		console.error('Error cancelling friend request:', error);
		return json({ error: 'Failed to cancel friend request' }, { status: 500 });
	}
};
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDatabase } from '$lib/server/database';

// GET /api/friends/requests - List pending friend requests (incoming and outgoing)
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const userId = locals.user.id;
	const services = await getDatabase();

	// Get incoming pending requests (sent to this user)
	const incomingRequests = await services.friendRequests.listIncomingPending(userId);

	// Get outgoing pending requests (sent by this user)
	const outgoingRequests = await services.friendRequests.listOutgoingPending(userId);

	// Enrich incoming requests with sender username
	const incoming = await Promise.all(
		incomingRequests.map(async (req) => {
			const fromUser = await services.users.findById(req.fromUserId);
			return {
				id: req.id,
				fromUserId: req.fromUserId,
				fromUsername: fromUser?.username,
				createdAt: req.createdAt
			};
		})
	);

	// Enrich outgoing requests with recipient username
	const outgoing = await Promise.all(
		outgoingRequests.map(async (req) => {
			const toUser = await services.users.findById(req.toUserId);
			return {
				id: req.id,
				toUserId: req.toUserId,
				toUsername: toUser?.username,
				createdAt: req.createdAt
			};
		})
	);

	return json({ incoming, outgoing });
};
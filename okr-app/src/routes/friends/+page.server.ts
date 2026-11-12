import type { PageServerLoad } from './$types';
import { redirect } from '@sveltejs/kit';
import { getDatabase } from '$lib/server/database';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) {
		throw redirect(302, '/login');
	}

	const userId = locals.user.id;
	const services = await getDatabase();

	// Get all friendships
	const userFriendships = await services.friendships.listForUser(userId);

	// Get friend IDs
	const friendIds = userFriendships.map((f) => (f.userId1 === userId ? f.userId2 : f.userId1));

	// Get friend details
	const friends = await Promise.all(
		friendIds.map(async (friendId) => {
			const friend = await services.users.findById(friendId);

			const note = await services.friendNotes.findByUserAndFriend(userId, friendId);

			const friendship = userFriendships.find(
				(f) =>
					(f.userId1 === userId && f.userId2 === friendId) ||
					(f.userId1 === friendId && f.userId2 === userId)
			);

			return {
				id: friend?.id,
				username: friend?.username,
				friendshipCreatedAt: friendship?.createdAt,
				note: note?.note || ''
			};
		})
	);

	// Get pending incoming requests
	const incomingRequests = await services.friendRequests.listIncomingPending(userId);

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

	// Get pending outgoing requests
	const outgoingRequests = await services.friendRequests.listOutgoingPending(userId);

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

	return {
		user: locals.user,
		friends: friends.filter((f) => f.id), // Filter out any nulls
		requests: {
			incoming,
			outgoing
		}
	};
};
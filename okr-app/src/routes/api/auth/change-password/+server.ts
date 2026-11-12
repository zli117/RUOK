import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { verifyPassword, hashPassword, createSession } from '$lib/server/auth';
import { getDatabase } from '$lib/server/database';

export const POST: RequestHandler = async ({ locals, request, cookies }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	try {
		const { currentPassword, newPassword } = await request.json();

		if (!currentPassword || !newPassword) {
			return json({ error: 'Current password and new password are required' }, { status: 400 });
		}

		if (newPassword.length < 8) {
			return json({ error: 'New password must be at least 8 characters' }, { status: 400 });
		}

		const db = await getDatabase();

		// Get the user's current password hash
		const user = await db.users.findById(locals.user.id);

		if (!user) {
			return json({ error: 'User not found' }, { status: 404 });
		}

		// Verify current password
		const valid = await verifyPassword(currentPassword, user.passwordHash);
		if (!valid) {
			return json({ error: 'Current password is incorrect' }, { status: 403 });
		}

		// Hash and save new password
		const newHash = await hashPassword(newPassword);
		await db.users.update(locals.user.id, { passwordHash: newHash });

		// Invalidate all existing sessions and create a fresh one
		await db.sessions.deleteByUser(locals.user.id);
		const newSessionId = await createSession(locals.user.id);
		cookies.set('session', newSessionId, {
			path: '/',
			httpOnly: true,
			sameSite: 'lax',
			secure: process.env.NODE_ENV === 'production',
			maxAge: 60 * 60 * 24 * 30 // 30 days
		});

		return json({ success: true });
	} catch (error) {
		console.error('Error changing password:', error);
		return json({ error: 'Failed to change password' }, { status: 500 });
	}
};
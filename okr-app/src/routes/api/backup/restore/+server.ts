import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDatabase } from '$lib/server/database';
import { BackupValidationError, buildRestorePlan } from '$lib/db/backup';

// POST /api/backup/restore - Restore from a version-2 backup.
//
// The incoming document is validated and remapped by the canonical
// `backup/validate` module into a fully-resolved command plan BEFORE any
// mutation. The adapter then executes the plan atomically (one transaction on
// both backends), so an injected failure rolls the whole restore back and
// leaves the target user's original data (and other accounts) intact.
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const userId = locals.user.id;

	try {
		let raw: unknown;
		try {
			raw = await request.json();
		} catch {
			return json({ error: 'Invalid JSON body' }, { status: 400 });
		}

		let plan;
		try {
			plan = buildRestorePlan(raw, userId);
		} catch (err) {
			if (err instanceof BackupValidationError) {
				return json({ error: err.message }, { status: 400 });
			}
			throw err;
		}

		const services = await getDatabase();
		const stats = await services.backup.restore(plan);

		return json({
			success: true,
			message: 'Backup restored successfully. All previous data was replaced.',
			stats
		});
	} catch (error) {
		console.error('Restore failed:', error);
		return json(
			{ error: error instanceof Error ? error.message : 'Failed to restore backup' },
			{ status: 500 }
		);
	}
};
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDatabase } from '$lib/server/database';
import { buildExportDocument } from '$lib/db/backup';

// GET /api/backup - Create a version-2 backup of the user's data.
//
// The export is produced by the canonical backup boundary: the adapter builds
// a *consistent* snapshot (one transaction), then the shared `backup/export`
// module converts it to the version-2 wire document. No raw driver or dialect
// schema is touched in this route.
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const userId = locals.user.id;

	try {
		const services = await getDatabase();
		const snapshot = await services.backup.exportSnapshot(userId);
		const backup = buildExportDocument(snapshot);

		const filename = `okr-backup-${new Date().toISOString().split('T')[0]}.json`;

		return new Response(JSON.stringify(backup, null, 2), {
			headers: {
				'Content-Type': 'application/json',
				'Content-Disposition': `attachment; filename="${filename}"`
			}
		});
	} catch (error) {
		console.error('Backup failed:', error);
		return json({ error: 'Failed to create backup' }, { status: 500 });
	}
};
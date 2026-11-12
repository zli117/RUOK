import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDatabase } from '$lib/server/database';

export const load: PageServerLoad = async ({ locals, depends }) => {
	// Register dependency for invalidation
	depends('data:queries');

	if (!locals.user) {
		throw redirect(302, '/login');
	}

	const services = await getDatabase();
	const queries = await services.savedQueries.listByUser(locals.user.id);

	return {
		savedQueries: queries
	};
};
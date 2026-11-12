import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDatabase } from '$lib/server/database';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) {
		throw redirect(302, '/login');
	}

	const services = await getDatabase();
	const userTags = await services.tags.listByUser(locals.user.id);

	return {
		tags: userTags
	};
};
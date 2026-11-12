import type { PageServerLoad } from './$types';
import { getDatabase } from '$lib/server/database';
import { redirect } from '@sveltejs/kit';
import { getRegisteredPlugins } from '$lib/server/plugins/manager';

export const load: PageServerLoad = async ({ locals, depends }) => {
	depends('data:metrics');

	if (!locals.user) {
		throw redirect(302, '/login');
	}

	// Get all templates for this user (ordered by effectiveFrom descending)
	const services = await getDatabase();
	const templates = await services.metricsTemplates.listByUser(locals.user.id);

	// Get available external sources from plugins
	const plugins = getRegisteredPlugins();
	const externalSources = plugins.map(plugin => ({
		pluginId: plugin.id,
		pluginName: plugin.name,
		fields: plugin.getAvailableFields().map(field => ({
			id: `${plugin.id}.${field.id}`,
			name: field.name,
			description: field.description,
			type: field.type,
			unit: field.unit
		}))
	}));

	return {
		templates: templates.map(t => ({
			...t,
			metricsDefinition: JSON.parse(t.metricsDefinition)
		})),
		externalSources
	};
};
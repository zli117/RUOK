import type { LayoutServerLoad } from './$types';
import { getDatabase } from '$lib/server/database';

export const load: LayoutServerLoad = async ({ locals }) => {
	let aiConfig = {
		hasAiConfig: false,
		configuredProviders: [] as string[],
		activeProvider: 'anthropic',
		providerModels: {} as Record<string, string[]>
	};

	if (locals.user) {
		const services = await getDatabase();
		const config = await services.userAiConfig.findByUser(locals.user.id);

		if (config) {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const providersConfig: Record<string, Record<string, any>> =
				config.providersConfig ? JSON.parse(config.providersConfig) : {};
			const configuredProviders = Object.entries(providersConfig)
				.filter(([key, conf]) => conf.apiKey || key === 'ollama')
				.map(([name]) => name);

			// Build provider → models mapping
			const providerModels: Record<string, string[]> = {};
			for (const [name, conf] of Object.entries(providersConfig)) {
				// Normalize old model → models
				const models: string[] = conf.models || (conf.model ? [conf.model] : []);
				if (models.length > 0) {
					providerModels[name] = models;
				}
			}

			aiConfig = {
				hasAiConfig: configuredProviders.length > 0,
				configuredProviders,
				activeProvider: config.provider || 'anthropic',
				providerModels
			};
		}
	}

	return {
		user: locals.user ?? null,
		aiConfig
	};
};
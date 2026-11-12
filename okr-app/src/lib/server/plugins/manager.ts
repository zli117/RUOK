/**
 * Plugin Manager - handles registration and coordination of data import plugins
 */

import type { DataImportPlugin, PluginConfig, OAuthCredentials, SyncResult, ImportedDataRecord } from './types';
import { getDatabase } from '$lib/server/database';
import { v4 as uuidv4 } from 'uuid';

// Plugin registry
const registeredPlugins: Map<string, DataImportPlugin> = new Map();

/**
 * Register a plugin
 */
export function registerPlugin(plugin: DataImportPlugin): void {
	registeredPlugins.set(plugin.id, plugin);
	console.log(`Plugin registered: ${plugin.name} (${plugin.id})`);
}

/**
 * Get all registered plugins
 */
export function getRegisteredPlugins(): DataImportPlugin[] {
	return Array.from(registeredPlugins.values());
}

/**
 * Get a specific plugin by ID
 */
export function getPlugin(pluginId: string): DataImportPlugin | undefined {
	return registeredPlugins.get(pluginId);
}

/**
 * Get user's plugin configuration
 */
export async function getUserPluginConfig(userId: string, pluginId: string): Promise<PluginConfig | null> {
	const services = await getDatabase();
	const record = await services.plugins.findByUserAndPlugin(userId, pluginId);

	if (!record) return null;

	const config = record.config ? JSON.parse(record.config) : {};

	return {
		id: record.id,
		userId: record.userId,
		enabled: record.enabled,
		credentials: config.credentials,
		settings: config.settings,
		lastSync: record.lastSync ?? undefined
	};
}

/**
 * Save user's plugin configuration
 */
export async function saveUserPluginConfig(
	userId: string,
	pluginId: string,
	credentials: OAuthCredentials,
	settings?: Record<string, unknown>
): Promise<void> {
	const services = await getDatabase();
	const existing = await services.plugins.findByUserAndPlugin(userId, pluginId);

	const config = JSON.stringify({ credentials, settings });

	if (existing) {
		await services.plugins.update(existing.id, { config, enabled: true });
	} else {
		await services.plugins.create({
			id: uuidv4(),
			userId,
			pluginId,
			enabled: true,
			config,
			createdAt: new Date()
		});
	}
}

/**
 * Disable a plugin for a user
 */
export async function disableUserPlugin(userId: string, pluginId: string): Promise<void> {
	const services = await getDatabase();
	await services.plugins.updateByUserAndPlugin(userId, pluginId, { enabled: false, config: null });
}

/**
 * Sync data from a plugin for a user
 */
export async function syncPluginData(
	userId: string,
	pluginId: string,
	startDate: string,
	endDate: string
): Promise<SyncResult> {
	const plugin = getPlugin(pluginId);
	if (!plugin) {
		return { success: false, recordsImported: 0, errors: ['Plugin not found'] };
	}

	const config = await getUserPluginConfig(userId, pluginId);
	if (!config || !config.credentials) {
		return { success: false, recordsImported: 0, errors: ['Plugin not configured'] };
	}

	let credentials = config.credentials;

	// Check if tokens need refresh
	if (credentials.expiresAt < Date.now() / 1000) {
		try {
			credentials = await plugin.refreshTokens(credentials);
			await saveUserPluginConfig(userId, pluginId, credentials, config.settings);
		} catch (error) {
			return { success: false, recordsImported: 0, errors: ['Failed to refresh tokens'] };
		}
	}

	// Validate credentials
	const valid = await plugin.validateCredentials(credentials);
	if (!valid) {
		return { success: false, recordsImported: 0, errors: ['Invalid credentials'] };
	}

	// Fetch data
	const fields = plugin.getAvailableFields().map(f => f.id);
	let records: ImportedDataRecord[];

	try {
		records = await plugin.fetchData(credentials, startDate, endDate, fields);
	} catch (error) {
		return {
			success: false,
			recordsImported: 0,
			errors: [`Failed to fetch data: ${error instanceof Error ? error.message : 'Unknown error'}`]
		};
	}

	// Import records into database
	let importedCount = 0;
	const errors: string[] = [];

	for (const record of records) {
		try {
			await importDailyMetrics(userId, pluginId, record);
			importedCount++;
		} catch (error) {
			errors.push(`Failed to import ${record.date}: ${error instanceof Error ? error.message : 'Unknown error'}`);
		}
	}

	// Update last sync time
	const services = await getDatabase();
	await services.plugins.updateByUserAndPlugin(userId, pluginId, { lastSync: new Date() });

	return {
		success: errors.length === 0,
		recordsImported: importedCount,
		errors: errors.length > 0 ? errors : undefined,
		lastSyncDate: endDate
	};
}

/**
 * Import daily metrics from plugin data.
 * Writes to both the legacy dailyMetrics table and the new dailyMetricValues table
 * so the flexible template system can read synced data.
 */
async function importDailyMetrics(userId: string, pluginId: string, record: ImportedDataRecord): Promise<void> {
	const services = await getDatabase();

	// Find or create the time period for this date
	let period = await services.timePeriods.find({ userId, type: 'daily', day: record.date });

	if (!period) {
		const date = new Date(record.date);
		const periodId = uuidv4();
		const now = new Date();

		period = await services.timePeriods.create({
			id: periodId,
			userId,
			periodType: 'daily',
			year: date.getFullYear(),
			month: date.getMonth() + 1,
			day: record.date,
			createdAt: now,
			updatedAt: now
		});
	}

	if (!period) {
		throw new Error('Failed to create time period');
	}

	// Check if metrics already exist
	const existing = await services.dailyMetrics.findByPeriod(userId, period.id);

	// Map plugin fields to database columns
	const metricsData: {
		sleepLength?: string;
		wakeUpTime?: string;
		previousNightBedTime?: string;
		steps?: number;
		cardioLoad?: number;
		restingHeartRate?: number;
	} = {};

	if (record.fields.sleepLength !== undefined) {
		metricsData.sleepLength = String(record.fields.sleepLength);
	}
	if (record.fields.wakeUpTime !== undefined) {
		metricsData.wakeUpTime = String(record.fields.wakeUpTime);
	}
	if (record.fields.bedTime !== undefined) {
		metricsData.previousNightBedTime = String(record.fields.bedTime);
	}
	if (record.fields.steps !== undefined) {
		metricsData.steps = Number(record.fields.steps);
	}
	if (record.fields.cardioLoad !== undefined) {
		metricsData.cardioLoad = Number(record.fields.cardioLoad);
	}
	if (record.fields.restingHeartRate !== undefined) {
		metricsData.restingHeartRate = Number(record.fields.restingHeartRate);
	}

	if (existing) {
		// Update existing metrics
		await services.dailyMetrics.update(existing.id, metricsData);
	} else {
		// Create new metrics
		await services.dailyMetrics.create({
			id: uuidv4(),
			userId,
			timePeriodId: period.id,
			...metricsData
		});
	}

	// Also write to dailyMetricValues for the flexible template system.
	// Each field is stored with the source key "pluginId.fieldId" (e.g. "fitbit.sleepLength")
	// so the template system can find them via external source references.
	for (const [fieldId, value] of Object.entries(record.fields)) {
		if (value === undefined) continue;

		const metricName = `${pluginId}.${fieldId}`;
		const stringValue = value === null ? null : String(value);

		await services.dailyMetricValues.upsert({
			id: uuidv4(),
			userId,
			date: record.date,
			metricName,
			value: stringValue,
			source: pluginId
		});
	}
}
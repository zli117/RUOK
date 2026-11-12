/**
 * Plugin Sync Scheduler
 * Automatically syncs data from connected plugins at regular intervals
 */

import { getDatabase } from '$lib/server/database';
import { getPlugin, syncPluginData } from './manager';

// Default sync interval: 1 hour
const DEFAULT_SYNC_INTERVAL_MS = 60 * 60 * 1000;

// Track if scheduler is running
let schedulerInterval: ReturnType<typeof setInterval> | null = null;
// Track the initial (one-shot) sync timeout so stop/restart never leaves a
// stale timer that would fire a duplicate sync on a later start (T030).
let schedulerTimeout: ReturnType<typeof setTimeout> | null = null;
let isRunning = false;

/**
 * Start the plugin sync scheduler.
 *
 * Both the initial one-shot sync and the recurring interval are tracked and
 * cleared by `stopScheduler`, so shutdown/recovery never leaks a duplicate
 * timer. `initialDelayMs` defaults to 5000ms (let the server fully start);
 * tests may pass a small value to drive the scheduled callback deterministically.
 */
export function startScheduler(
	intervalMs: number = DEFAULT_SYNC_INTERVAL_MS,
	initialDelayMs: number = 5000
): void {
	if (schedulerInterval) {
		console.log('Scheduler already running');
		return;
	}

	// A prior stop may have raced; never leave a stale one-shot pending.
	if (schedulerTimeout) {
		clearTimeout(schedulerTimeout);
		schedulerTimeout = null;
	}

	console.log(`Starting plugin sync scheduler (interval: ${intervalMs / 1000}s)`);

	// Run initial sync after a short delay to let the server fully start
	schedulerTimeout = setTimeout(() => {
		schedulerTimeout = null;
		runScheduledSync().catch(console.error);
	}, initialDelayMs);

	// Set up recurring sync
	schedulerInterval = setInterval(() => {
		runScheduledSync().catch(console.error);
	}, intervalMs);
}

/**
 * Stop the scheduler: clear both the recurring interval and the pending
 * one-shot initial sync so no duplicate timer survives a later restart.
 */
export function stopScheduler(): void {
	if (schedulerTimeout) {
		clearTimeout(schedulerTimeout);
		schedulerTimeout = null;
	}
	if (schedulerInterval) {
		clearInterval(schedulerInterval);
		schedulerInterval = null;
		console.log('Plugin sync scheduler stopped');
	}
}

/**
 * Run a scheduled sync for all enabled plugins
 */
async function runScheduledSync(): Promise<void> {
	if (isRunning) {
		console.log('Sync already in progress, skipping');
		return;
	}

	isRunning = true;
	console.log('Starting scheduled plugin sync...');

	try {
		// Get all enabled plugin configurations
		const services = await getDatabase();
		const enabledPlugins = await services.plugins.listEnabled();

		if (enabledPlugins.length === 0) {
			console.log('No enabled plugins to sync');
			return;
		}

		console.log(`Found ${enabledPlugins.length} enabled plugin(s)`);

		// Calculate date range (last 7 days by default)
		const endDate = new Date();
		const startDate = new Date();
		startDate.setDate(startDate.getDate() - 7);

		const startDateStr = startDate.toISOString().split('T')[0];
		const endDateStr = endDate.toISOString().split('T')[0];

		// Sync each plugin for each user
		for (const pluginConfig of enabledPlugins) {
			const plugin = getPlugin(pluginConfig.pluginId);
			if (!plugin) {
				console.warn(`Plugin ${pluginConfig.pluginId} not found, skipping`);
				continue;
			}

			console.log(`Syncing ${plugin.name} for user ${pluginConfig.userId}...`);

			try {
				const result = await syncPluginData(
					pluginConfig.userId,
					pluginConfig.pluginId,
					startDateStr,
					endDateStr
				);

				if (result.success) {
					console.log(`  Synced ${result.recordsImported} records`);
				} else {
					console.warn(`  Sync had errors: ${result.errors?.join(', ')}`);
				}
			} catch (error) {
				console.error(`  Sync failed:`, error);
			}
		}

		console.log('Scheduled sync complete');
	} finally {
		isRunning = false;
	}
}

/**
 * Manually trigger a sync for a specific user and plugin
 */
export async function triggerSync(
	userId: string,
	pluginId: string,
	options?: { startDate?: string; endDate?: string }
): Promise<{ success: boolean; recordsImported: number; errors?: string[] }> {
	const endDate = options?.endDate || new Date().toISOString().split('T')[0];
	const startDate = options?.startDate || (() => {
		const d = new Date();
		d.setDate(d.getDate() - 30);
		return d.toISOString().split('T')[0];
	})();

	return syncPluginData(userId, pluginId, startDate, endDate);
}

/**
 * Check if the scheduler is currently running
 */
export function isSchedulerRunning(): boolean {
	return schedulerInterval !== null;
}

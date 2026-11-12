/**
 * Server-side access to the typed persistence boundary.
 *
 * Lazily opens the configured backend (via `$lib/db`) on first use and returns
 * the process-wide {@link DatabaseServices} instance. Application server code
 * (auth, configuration, goals) consumes repositories through this accessor and
 * never imports a raw driver handle or a dialect schema.
 *
 * This module DELEGATES ownership to the single lifecycle owner
 * (`openDatabase` in `$lib/db`): it keeps no second rejected-promise cache. The
 * lifecycle owns the shared opening attempt, retry cooldown, generation fencing
 * and partial-resource cleanup. Opening is deferred so importing this module
 * performs no filesystem/network I/O; the first caller triggers `openDatabase`,
 * which runs the selected backend's checked migration history (or read-only
 * verification when `MIGRATION_MODE=verify`) before publishing ready
 * repositories.
 */
import { loadConfig, openDatabase, parseMigrationMode } from '$lib/db';
import type { DatabaseServices } from '$lib/db';

let services: DatabaseServices | undefined;

export function getDatabase(): Promise<DatabaseServices> {
	if (services) return Promise.resolve(services);
	// Resolve the shared WP03 migration mode so verify reaches the no-DDL path
	// and an absent mode retains the historical migrate default.
	const config = loadConfig();
	const mode = parseMigrationMode(process.env.MIGRATION_MODE);
	return openDatabase(config, { mode }).then((s) => {
		services = s;
		return s;
	});
}
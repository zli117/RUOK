/**
 * Build/import-time initialization probe (FR-005 / T012).
 *
 * Imported in a SEPARATE process. It imports the full persistence + migration
 * surface and asserts that nothing was opened: no database, no readiness, no
 * config. The runner test bundles this probe and executes it to prove that
 * importing the new modules performs no I/O (no file/socket at build/import).
 *
 * `getReadiness` is asynchronous (WP04 / D-05); with no config it resolves
 * `ready:false` immediately without any live check, so this stays I/O-free.
 */
import { getOpenConfig, getReadiness, isDatabaseOpen } from '../../src/lib/db'

const result = await (async () => {
	const readiness = await getReadiness()
	return {
		readinessReady: readiness.ready,
		open: isDatabaseOpen(),
		config: getOpenConfig() ?? null
	}
})()
console.log(`PROBE:${JSON.stringify(result)}`)
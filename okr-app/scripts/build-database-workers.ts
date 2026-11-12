/**
 * SQLite worker build helper (WP10 / T047).
 *
 * Bundles the worker-private SQLite entrypoints into standalone `.mjs` assets
 * using the installed esbuild. `packages: 'external'` keeps native/runtime
 * dependencies (better-sqlite3, drizzle-orm, ...) as runtime imports resolved
 * from node_modules, so no SQLite driver is bundled into the HTTP bundle.
 *
 * Usage:
 *  - CLI:      `node scripts/build-database-workers.ts`  (emits build/workers/*.mjs)
 *  - Library:  `import { buildAllWorkers } from './build-database-workers'`
 *              integrated through the Vite build hook (`closeBundle`).
 *
 * The emitted assets land inside `build/`, which the Dockerfile already copies
 * into the production image unchanged. Build performs no worker spawn and opens
 * no database.
 */
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
	WORKER_ENTRY_SOURCES,
	type SqliteWorkerRole
} from '../src/lib/db/adapters/sqlite-worker-protocol';

/** Default output directory (relative to the project root). */
export const DEFAULT_WORKER_OUT_DIR = join('build', 'workers');

export interface BundleWorkerOptions {
	/** esbuild target (defaults to the Node 22 production runtime). */
	target?: string;
	/** Emit a source map for debugging. */
	sourcemap?: boolean;
}

/** Bundle one worker entrypoint to `outfile`. Resolves to the output path. */
export async function bundleWorker(
	role: SqliteWorkerRole,
	outfile: string,
	options: BundleWorkerOptions = {}
): Promise<string> {
	await build({
		entryPoints: [join(process.cwd(), WORKER_ENTRY_SOURCES[role])],
		bundle: true,
		platform: 'node',
		format: 'esm',
		packages: 'external',
		target: options.target ?? 'node22',
		sourcemap: options.sourcemap ?? false,
		logLevel: 'silent',
		outfile
	});
	return outfile;
}

/**
 * Bundle every SQLite worker entrypoint into `outDir/<role>.mjs`. Resolves to
 * the emitted files.
 */
export async function buildAllWorkers(
	outDir: string = DEFAULT_WORKER_OUT_DIR,
	options: BundleWorkerOptions = {}
): Promise<string[]> {
	mkdirSync(outDir, { recursive: true });
	const roles = Object.keys(WORKER_ENTRY_SOURCES) as SqliteWorkerRole[];
	const outputs: string[] = [];
	for (const role of roles) {
		const outfile = join(outDir, `${role}.mjs`);
		await bundleWorker(role, outfile, options);
		outputs.push(outfile);
	}
	return outputs;
}

// CLI entry point.
const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (isMain) {
	const outDir = process.argv[2] ?? DEFAULT_WORKER_OUT_DIR;
	const outputs = await buildAllWorkers(outDir);
	// eslint-disable-next-line no-console
	console.log(`Built SQLite worker assets:\n${outputs.map((o) => `  ${o}`).join('\n')}`);
}
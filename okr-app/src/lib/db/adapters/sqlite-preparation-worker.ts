/**
 * SQLite preparation worker (WP10 / T045).
 *
 * Runs WP03 migrate/verify (`migrateDatabase`) for SQLite in a SEPARATE worker
 * thread and exits before the runtime worker opens its handle. This guarantees
 * that schema preparation performs no SQLite I/O on the HTTP thread or at
 * import time, and that a preparation failure can never leak a handle into the
 * runtime worker.
 *
 * The runtime `runSqlitePreparation` (in `sqlite-worker-client.ts`) spawns this
 * worker, awaits one preparation command, then terminates it.
 */
import { parentPort } from 'node:worker_threads';
import { migrateDatabase } from '../migrations';
import type { MigrationResult } from '../migrations/contracts';
import type { DatabaseConfig } from '../contracts';
import type { SqliteWorkerRole } from './sqlite-worker-protocol';

// The preparation worker is referenced only as a worker entry point.
export const ROLE: SqliteWorkerRole = 'preparation';

export interface SqlitePreparationCommand {
	type: 'preparation';
	requestId: number;
	config: DatabaseConfig;
	mode: 'migrate' | 'verify';
}

export interface SqlitePreparationReply {
	type: 'reply';
	requestId: number;
	ok: boolean;
	value?: MigrationResult;
	error?: { name: string; message: string };
}

const port = parentPort;
if (!port) {
	throw new Error('sqlite-preparation-worker.ts must run as a worker thread (parentPort is null)');
}

function redactError(err: unknown): { name: string; message: string } {
	if (err instanceof Error) {
		return { name: err.name, message: err.message };
	}
	return { name: 'Error', message: String(err) };
}

port.on('message', async (msg: SqlitePreparationCommand) => {
	if (!msg || msg.type !== 'preparation') {
		port.postMessage({
			type: 'reply',
			requestId: msg?.requestId ?? -1,
			ok: false,
			error: { name: 'ProtocolError', message: 'Unknown preparation command' }
		} satisfies SqlitePreparationReply);
		return;
	}
	try {
		const result = await migrateDatabase(msg.config, { mode: msg.mode });
		port.postMessage({
			type: 'reply',
			requestId: msg.requestId,
			ok: true,
			value: result
		} satisfies SqlitePreparationReply);
	} catch (err) {
		port.postMessage({
			type: 'reply',
			requestId: msg.requestId,
			ok: false,
			error: redactError(err)
		} satisfies SqlitePreparationReply);
	}
});
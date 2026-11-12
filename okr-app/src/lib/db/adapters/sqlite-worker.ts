/**
 * SQLite runtime worker thread (WP10 / U1 / D-07).
 *
 * Owns the sole runtime SQLite handle for a process. It receives allowlisted
 * commands over structured clone and executes them serially against the
 * worker-private {@link SqliteLocalServices} engine. Every synchronous
 * better-sqlite3 call — including busy-timeout waits on a locked database —
 * happens HERE, on the worker thread, never on the HTTP event loop.
 *
 * Lifecycle:
 *  - `open`   -> construct + open the engine handle (applies configured pragmas
 *                incl. the preserved busy timeout, even >5s), reply.
 *  - `command`-> dispatch one allowlisted method, reply with cloned value or a
 *                redacted error. Commands are serialized (at most one active).
 *  - `close`  -> close the engine handle, reply; generation fences any late work.
 *
 * No SQLite I/O occurs at import time; the handle only exists after `open`.
 */
import { parentPort } from 'node:worker_threads';
import { SqliteLocalServices } from './sqlite-local';
import type {
	SqliteClosedMessage,
	SqliteReadyMessage,
	SqliteReplyMessage,
	SqliteWorkerCommand,
	SqliteWorkerMessage
} from './sqlite-worker-protocol';

const port = parentPort;
if (!port) {
	throw new Error('sqlite-worker.ts must run as a worker thread (parentPort is null)');
}

let services: SqliteLocalServices | null = null;
let openGeneration = -1;

/** Serialize all command execution so at most one operation touches the handle. */
let tail: Promise<unknown> = Promise.resolve();

function enqueue(task: () => Promise<void>): Promise<void> {
	const run = tail.then(task);
	tail = run.catch(() => undefined);
	return run;
}

function reply(message: SqliteReplyMessage): void {
	port!.postMessage(message satisfies SqliteWorkerMessage);
}

function redactError(err: unknown): { name: string; message: string } {
	if (err instanceof Error) {
		return { name: err.name, message: err.message };
	}
	return { name: 'Error', message: String(err) };
}

function handleOpen(msg: Extract<SqliteWorkerCommand, { type: 'open' }>): Promise<void> {
	if (services) {
		reply({
			type: 'reply',
			generation: msg.generation,
			requestId: msg.requestId,
			ok: false,
			error: { name: 'StateError', message: 'SQLite worker is already open' }
		});
		return Promise.resolve();
	}
	const next = new SqliteLocalServices({
		type: 'sqlite',
		path: msg.config.path,
		journalMode: msg.config.journalMode,
		busyTimeoutMs: msg.config.busyTimeoutMs
	});
	return next
		.open()
		.then(() => {
			services = next;
			openGeneration = msg.generation;
			const ready: SqliteReadyMessage = { type: 'ready', generation: msg.generation };
			port!.postMessage(ready);
			reply({
				type: 'reply',
				generation: msg.generation,
				requestId: msg.requestId,
				ok: true
			});
		})
		.catch((err) => {
			reply({
				type: 'reply',
				generation: msg.generation,
				requestId: msg.requestId,
				ok: false,
				error: redactError(err)
			});
		});
}

function handleCommand(msg: Extract<SqliteWorkerCommand, { type: 'command' }>): Promise<void> {
	if (!services) {
		reply({
			type: 'reply',
			generation: msg.generation,
			requestId: msg.requestId,
			ok: false,
			error: { name: 'StateError', message: 'SQLite worker is not open' }
		});
		return Promise.resolve();
	}
	if (msg.generation !== openGeneration) {
		// Stale/fenced generation: reject without executing against a closed handle.
		reply({
			type: 'reply',
			generation: msg.generation,
			requestId: msg.requestId,
			ok: false,
			error: { name: 'FencedGenerationError', message: 'Generation fenced' }
		});
		return Promise.resolve();
	}
	return services
		.dispatch(msg.method, msg.args)
		.then((value) => {
			reply({ type: 'reply', generation: msg.generation, requestId: msg.requestId, ok: true, value });
		})
		.catch((err) => {
			reply({
				type: 'reply',
				generation: msg.generation,
				requestId: msg.requestId,
				ok: false,
				error: redactError(err)
			});
		});
}

function handleClose(msg: Extract<SqliteWorkerCommand, { type: 'close' }>): Promise<void> {
	const current = services;
	services = null;
	openGeneration = -1;
	if (!current) {
		reply({
			type: 'reply',
			generation: msg.generation,
			requestId: msg.requestId,
			ok: true
		});
		const closed: SqliteClosedMessage = { type: 'closed', generation: msg.generation };
		port!.postMessage(closed);
		return Promise.resolve();
	}
	return current
		.close()
		.then(() => {
			reply({ type: 'reply', generation: msg.generation, requestId: msg.requestId, ok: true });
			const closed: SqliteClosedMessage = { type: 'closed', generation: msg.generation };
			port!.postMessage(closed);
		})
		.catch((err) => {
			reply({
				type: 'reply',
				generation: msg.generation,
				requestId: msg.requestId,
				ok: false,
				error: redactError(err)
			});
			const closed: SqliteClosedMessage = { type: 'closed', generation: msg.generation };
			port!.postMessage(closed);
		});
}

port.on('message', (msg: SqliteWorkerCommand) => {
	void enqueue(() => {
		switch (msg.type) {
			case 'open':
				return handleOpen(msg);
			case 'command':
				return handleCommand(msg);
			case 'close':
				return handleClose(msg);
		}
	});
});
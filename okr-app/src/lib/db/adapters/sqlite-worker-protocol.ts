/**
 * SQLite worker protocol (WP10 / U1 / D-07, D-08, D-09).
 *
 * Internal transport between the awaitable {@link DatabaseServices} facade on
 * the HTTP thread and the worker-private synchronous SQLite engine. It exists
 * solely to keep every synchronous better-sqlite3 call — ordinary repository
 * reads/writes, atomic operations, backup export/restore, schema preparation
 * and handle open/close — off the main event loop.
 *
 * Guarantees:
 *  - Structured clone (not JSON) preserves Date, Map, null, undefined and
 *    numeric semantics across the thread boundary.
 *  - No generic arbitrary method invocation: the worker only ever executes a
 *    statically enumerated allowlist ({@link REPO_METHODS}) bound to typed
 *    repository methods. An unknown method string is denied.
 *  - Every atomic user/task command and each backup snapshot/restore is ONE
 *    complete worker command; its synchronous transaction stays wholly inside
 *    the worker.
 *  - Each message carries a generation + requestId so stale replies from a
 *    fenced/closed generation can be discarded.
 *
 * Importing this module performs no I/O and pulls in no SQLite driver.
 */
import type { SqliteConfig } from '../contracts';

/** Increment when the wire shape changes (breaks worker/client compatibility). */
export const WORKER_PROTOCOL_VERSION = 1;

/** Bounded ordinary-request queue depth (WP10 / T046). */
export const MAX_ORDINARY_QUEUE = 128;

/** Host readiness deadline including queue time (WP10 / T046, NFR-002). */
export const AVAILABILITY_TIMEOUT_MS = 3000;

/** Worker entry roles. */
export type SqliteWorkerRole = 'runtime' | 'preparation';

/**
 * Source entry point for each worker role (relative to the project root, i.e.
 * the process cwd). Used both by `scripts/build-database-workers.ts` and by the
 * client's dev/Vitest on-demand bundling.
 */
export const WORKER_ENTRY_SOURCES: Record<SqliteWorkerRole, string> = {
	runtime: 'src/lib/db/adapters/sqlite-worker.ts',
	preparation: 'src/lib/db/adapters/sqlite-preparation-worker.ts'
};

/**
 * Structured-cloneable subset of {@link SqliteConfig} carried to the worker.
 * `path`, `journalMode` and `busyTimeoutMs` are plain data; the configured busy
 * timeout (including values > 5s) is preserved verbatim inside the worker.
 */
export interface SqliteWorkerConfig {
	path: string;
	journalMode: 'wal' | 'delete';
	busyTimeoutMs: number;
}

/** Open the runtime engine handle in the worker. */
export interface SqliteOpenCommand {
	type: 'open';
	generation: number;
	requestId: number;
	config: SqliteWorkerConfig;
}

/** Execute one allowlisted repository/service method. */
export interface SqliteCommand {
	type: 'command';
	generation: number;
	requestId: number;
	/** Allowlisted method path, e.g. `users.create` or `createUserWithInitialData`. */
	method: string;
	/** Structured-cloneable positional arguments. */
	args: unknown[];
}

/** Close the engine handle and fence the worker generation. */
export interface SqliteCloseCommand {
	type: 'close';
	generation: number;
	requestId: number;
}

export type SqliteWorkerCommand = SqliteOpenCommand | SqliteCommand | SqliteCloseCommand;

/** Emitted by the worker once the engine handle has been opened. */
export interface SqliteReadyMessage {
	type: 'ready';
	generation: number;
}

/** Emitted by the worker as the result of a command. */
export interface SqliteReplyMessage {
	type: 'reply';
	generation: number;
	requestId: number;
	ok: boolean;
	/** Structured-cloneable result (preserves Date/Map/null/undefined). */
	value?: unknown;
	/** Redacted error (name + message; never stack or connection data). */
	error?: { name: string; message: string };
}

/** Emitted by the worker AFTER it has finished closing its handle. */
export interface SqliteClosedMessage {
	type: 'closed';
	generation: number;
}

export type SqliteWorkerMessage = SqliteReadyMessage | SqliteReplyMessage | SqliteClosedMessage;

/**
 * Statically enumerated allowlist of repository/service methods the worker may
 * execute. Shared by the worker (to build its dispatch table) and the client
 * (to mirror the repository surface over the transport). Every entry must exist
 * on the corresponding repository implemented by `SqliteLocalServices`.
 *
 * "Typed allowlisted requests": the method string is resolved against this
 * fixed table — any other string is denied before execution.
 */
export const REPO_METHODS: Record<string, string[]> = {
	users: ['create', 'findById', 'findByUsername', 'list', 'update', 'remove', 'count'],
	sessions: ['create', 'findById', 'delete', 'deleteByUser', 'deleteExpired'],
	systemConfig: ['all', 'upsert'],
	objectives: [
		'create',
		'findById',
		'listByUser',
		'listByUserWithKeyResults',
		'update',
		'upsert',
		'remove',
		'count'
	],
	keyResults: ['create', 'findById', 'listByObjective', 'update', 'remove'],
	objectiveReflections: ['create', 'findByUserLevelYearMonth', 'update'],
	tasks: [
		'create',
		'findById',
		'update',
		'remove',
		'count',
		'listByPeriod',
		'listByUser',
		'startTimer',
		'stopTimer'
	],
	taskAttributes: ['listByTask', 'listByTasks', 'upsertByTaskAndKey', 'removeByTaskAndKey'],
	tags: ['create', 'findById', 'listByUser', 'findByUserAndName', 'update', 'remove'],
	taskTags: ['listByTask', 'listByTasks'],
	timePeriods: ['create', 'findById', 'find', 'listByUser', 'update', 'count'],
	dailyMetrics: ['findByPeriod', 'create', 'update'],
	metricsTemplates: ['create', 'findById', 'listByUser', 'findActiveByDate', 'update', 'remove'],
	dailyMetricValues: [
		'listByUserAndDate',
		'listByUserAndDateAndNames',
		'findByUserDateName',
		'upsert'
	],
	savedQueries: ['create', 'findById', 'findByIdForUser', 'listByUser', 'update', 'remove'],
	dashboardWidgets: ['create', 'findById', 'findByIdForUser', 'listByUserAndPage', 'update', 'remove'],
	plugins: ['findByUserAndPlugin', 'listEnabled', 'create', 'update', 'updateByUserAndPlugin'],
	userAiConfig: ['findByUser', 'upsert'],
	queryExecutionLogs: ['create', 'listByUser', 'list', 'count', 'listSince'],
	friendRequests: [
		'create',
		'findPendingBetween',
		'listIncomingPending',
		'listOutgoingPending',
		'findPendingTo',
		'findPendingFrom',
		'update',
		'remove'
	],
	friendships: ['create', 'findBetween', 'listForUser', 'remove'],
	friendNotes: ['findByUserAndFriend', 'upsert', 'removeBetween'],
	backup: ['exportSnapshot', 'restore']
};

/** Lifecycle + bounded atomic operations exposed directly on the services. */
export const SERVICE_METHODS = [
	'open',
	'close',
	'checkAvailability',
	'createUserWithInitialData',
	'createTaskWithDetails',
	'updateTaskWithDetails'
] as const;

export type SqliteServiceMethod = (typeof SERVICE_METHODS)[number];

/** Compose every allowlisted method path, e.g. `users.create`, `backup.restore`. */
export function allowlistedMethods(): string[] {
	const methods: string[] = [];
	for (const [repo, names] of Object.entries(REPO_METHODS)) {
		for (const name of names) methods.push(`${repo}.${name}`);
	}
	methods.push(...SERVICE_METHODS);
	return methods;
}

export function isAllowlisted(method: string): boolean {
	if (SERVICE_METHODS.includes(method as SqliteServiceMethod)) return true;
	const dot = method.indexOf('.');
	if (dot === -1) return false;
	const repo = method.slice(0, dot);
	const name = method.slice(dot + 1);
	return REPO_METHODS[repo]?.includes(name) ?? false;
}

/** Build a structured-clone-safe worker config from the validated app config. */
export function toWorkerConfig(config: SqliteConfig): SqliteWorkerConfig {
	return {
		path: config.path,
		journalMode: config.journalMode,
		busyTimeoutMs: config.busyTimeoutMs
	};
}
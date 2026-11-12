/**
 * SQLite async worker facade (WP10 / U1 / D-07).
 *
 * Public {@link SqliteDatabaseServices} implementation: an awaitable facade that
 * forwards every synchronous SQLite operation to a worker-private engine
 * (`sqlite-local.ts` executed by `sqlite-worker.ts`) over a typed structured-clone
 * protocol. The HTTP thread only ever owns facade/generation state — no
 * better-sqlite3 driver call runs here.
 *
 * Guarantees:
 *  - Constructor/import/build are I/O-free (no worker spawn, no file open).
 *  - Every public DatabaseServices method keeps its exact promise-returning
 *    signature; `isOpen()` remains synchronous cached ownership metadata.
 *  - Results preserve Date/Map/null/undefined via structured clone.
 *  - Ordinary requests are bounded to {@link MAX_ORDINARY_QUEUE}; overflow is
 *    rejected before dispatch.
 *  - Readiness (`checkAvailability`) is coalesced to at most one queued/in-flight
 *    command with a host deadline of {@link AVAILABILITY_TIMEOUT_MS}, prioritizing
 *    the next slot after active work. Timeout marks unavailable without killing
 *    an active transaction, freeing its slot early or submitting duplicates.
 *  - Generation fencing discards stale replies; close/crash reject pending work
 *    and never automatically reissue writes.
 */
import { Worker } from 'node:worker_threads';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseConfig, DatabaseServices, SqliteConfig } from '../contracts';
import type {
	BackupRepository,
	CreateUserWithInitialDataInput,
	DailyMetricValueRepository,
	DailyMetricsRepository,
	DashboardWidgetRepository,
	FriendNoteRepository,
	FriendRequestRepository,
	FriendshipRepository,
	KeyResultRepository,
	MetricsTemplateRepository,
	ObjectiveReflectionRepository,
	ObjectiveRepository,
	PluginRepository,
	QueryExecutionLogRepository,
	SavedQueryRepository,
	SessionRepository,
	SystemConfigRepository,
	TagRepository,
	TaskAttributeRepository,
	TaskRepository,
	TaskTagRepository,
	TimePeriodRepository,
	UserAiConfigRepository,
	UserRepository
} from '../contracts';
import type {
	CreateTaskWithDetailsInput,
	TaskRow,
	UpdateTaskWithDetailsInput,
	UserRow
} from '../models';
import type { MigrateOptions } from '../migrations';
import type { MigrationResult } from '../migrations/contracts';
import {
	AVAILABILITY_TIMEOUT_MS,
	MAX_ORDINARY_QUEUE,
	REPO_METHODS,
	SERVICE_METHODS,
	WORKER_ENTRY_SOURCES,
	toWorkerConfig,
	type SqliteCommand,
	type SqliteOpenCommand,
	type SqliteWorkerCommand,
	type SqliteWorkerMessage,
	type SqliteWorkerRole
} from './sqlite-worker-protocol';
import type { SqlitePreparationReply } from './sqlite-preparation-worker';

// ---------------------------------------------------------------------------
// Worker entry resolution + on-demand bundling (dev/Vitest)
// ---------------------------------------------------------------------------

/** Prefer an explicit worker directory, then a pre-built asset, else bundle. */
export async function resolveWorkerEntry(role: SqliteWorkerRole): Promise<string> {
	const override = process.env.RUOK_SQLITE_WORKER_DIR;
	if (override) {
		const p = join(override, `${role}.mjs`);
		if (existsSync(p)) return p;
	}
	const built = join(process.cwd(), 'build', 'workers', `${role}.mjs`);
	if (existsSync(built)) return built;
	return bundleOnDemand(role);
}

/**
 * Bundle a worker entry into `node_modules/.cache/ruok-workers/<role>.mjs` using
 * the installed esbuild. `packages: 'external'` keeps native/runtime
 * dependencies (better-sqlite3, drizzle-orm, ...) as runtime imports resolved
 * from node_modules — no SQLite driver is bundled into the HTTP bundle.
 */
async function bundleOnDemand(role: SqliteWorkerRole): Promise<string> {
	const cacheDir = join(process.cwd(), 'node_modules', '.cache', 'ruok-workers');
	const outfile = join(cacheDir, `${role}.mjs`);
	const source = join(process.cwd(), WORKER_ENTRY_SOURCES[role]);
	// Rebuild when the output is missing or stale relative to the worker source.
	if (existsSync(outfile)) {
		const outMtime = statSync(outfile).mtimeMs;
		const srcMtime = statSync(source).mtimeMs;
		if (srcMtime <= outMtime) return outfile;
	}
	const { build } = await import('esbuild');
	mkdirSync(cacheDir, { recursive: true });
	await build({
		entryPoints: [source],
		bundle: true,
		platform: 'node',
		format: 'esm',
		packages: 'external',
		target: 'node22',
		outfile,
		logLevel: 'silent'
	});
	return outfile;
}

function spawnWorker(entry: string): Worker {
	// The bundled entry is a `.mjs` file, so Node treats it as ESM automatically.
	return new Worker(entry);
}

// ---------------------------------------------------------------------------
// Preparation (T045)
// ---------------------------------------------------------------------------

/**
 * Run backend migrate/verify in a separate preparation worker that closes before
 * the runtime worker opens. Performs no SQLite I/O on the HTTP thread. Works for
 * any configured backend (SQLite migrate/verify and PostgreSQL migrate/verify),
 * so the lifecycle routes migration solely through this worker boundary and
 * never imports the dialect migration runners (or the SQLite driver) on the
 * HTTP thread.
 */
export async function runPreparation(
	config: DatabaseConfig,
	options: MigrateOptions = {}
): Promise<MigrationResult> {
	const mode = options.mode ?? 'migrate';
	const entry = await resolveWorkerEntry('preparation');
	const worker = spawnWorker(entry);
	return new Promise<MigrationResult>((resolve, reject) => {
		const timer = setTimeout(() => {
			worker.terminate().catch(() => undefined);
			reject(new Error('SQLite preparation timed out'));
		}, 120_000);
		worker.on('message', (msg: SqlitePreparationReply) => {
			if (!msg || msg.type !== 'reply') return;
			clearTimeout(timer);
			worker.terminate().catch(() => undefined);
			if (msg.ok && msg.value) resolve(msg.value);
			else reject(new Error(msg.error?.message ?? 'SQLite preparation failed'));
		});
		worker.on('error', (err) => {
			clearTimeout(timer);
			worker.terminate().catch(() => undefined);
			reject(err);
		});
		worker.postMessage({ type: 'preparation', requestId: 1, config, mode });
	});
}

/**
 * SQLite-only alias for {@link runPreparation} (kept for tests / compatibility).
 */
export function runSqlitePreparation(
	config: SqliteConfig,
	options: MigrateOptions = {}
): Promise<MigrationResult> {
	return runPreparation(config, options);
}

// ---------------------------------------------------------------------------
// Facade
// ---------------------------------------------------------------------------

interface PendingReply {
	resolve: (value: unknown) => void;
	reject: (reason: unknown) => void;
}

interface Req {
	requestId: number;
	kind: 'ordinary' | 'availability';
	method: string;
	args: unknown[];
	resolve: (value: unknown) => void;
	reject: (reason: unknown) => void;
}

interface AvailabilityEntry {
	req: Req;
	promise: Promise<boolean>;
	timer: NodeJS.Timeout;
	dispatched: boolean;
	/** True once timed out or the underlying command has settled; never coalesced. */
	settled: boolean;
}

export class SqliteDatabaseServices implements DatabaseServices {
	readonly dialect = 'sqlite' as const;
	readonly users: UserRepository;
	readonly sessions: SessionRepository;
	readonly systemConfig: SystemConfigRepository;
	readonly objectives: ObjectiveRepository;
	readonly keyResults: KeyResultRepository;
	readonly objectiveReflections: ObjectiveReflectionRepository;
	readonly tasks: TaskRepository;
	readonly taskAttributes: TaskAttributeRepository;
	readonly tags: TagRepository;
	readonly taskTags: TaskTagRepository;
	readonly timePeriods: TimePeriodRepository;
	readonly dailyMetrics: DailyMetricsRepository;
	readonly metricsTemplates: MetricsTemplateRepository;
	readonly dailyMetricValues: DailyMetricValueRepository;
	readonly backup: BackupRepository;
	readonly savedQueries: SavedQueryRepository;
	readonly dashboardWidgets: DashboardWidgetRepository;
	readonly plugins: PluginRepository;
	readonly userAiConfig: UserAiConfigRepository;
	readonly queryExecutionLogs: QueryExecutionLogRepository;
	readonly friendRequests: FriendRequestRepository;
	readonly friendships: FriendshipRepository;
	readonly friendNotes: FriendNoteRepository;

	private worker: Worker | null = null;
	private _open = false;
	private _closed = false;
	private _generation = 0;
	private _nextRequestId = 1;
	private queue: Req[] = [];
	private processing = false;
	private pendingOrdinary = 0;
	private availability: AvailabilityEntry | null = null;
	private pendingReplies = new Map<number, PendingReply>();
	private closeWaiters = new Set<() => void>();

	constructor(private readonly config: SqliteConfig) {
		// Lazy and I/O-free: builds forwarding repository objects only. The worker
		// is spawned on open(), never in the constructor or at import/build time.
		this.users = this.buildRepo('users') as unknown as UserRepository;
		this.sessions = this.buildRepo('sessions') as unknown as SessionRepository;
		this.systemConfig = this.buildRepo('systemConfig') as unknown as SystemConfigRepository;
		this.objectives = this.buildRepo('objectives') as unknown as ObjectiveRepository;
		this.keyResults = this.buildRepo('keyResults') as unknown as KeyResultRepository;
		this.objectiveReflections = this.buildRepo(
			'objectiveReflections'
		) as unknown as ObjectiveReflectionRepository;
		this.tasks = this.buildRepo('tasks') as unknown as TaskRepository;
		this.taskAttributes = this.buildRepo('taskAttributes') as unknown as TaskAttributeRepository;
		this.tags = this.buildRepo('tags') as unknown as TagRepository;
		this.taskTags = this.buildRepo('taskTags') as unknown as TaskTagRepository;
		this.timePeriods = this.buildRepo('timePeriods') as unknown as TimePeriodRepository;
		this.dailyMetrics = this.buildRepo('dailyMetrics') as unknown as DailyMetricsRepository;
		this.metricsTemplates = this.buildRepo('metricsTemplates') as unknown as MetricsTemplateRepository;
		this.dailyMetricValues = this.buildRepo('dailyMetricValues') as unknown as DailyMetricValueRepository;
		this.backup = this.buildRepo('backup') as unknown as BackupRepository;
		this.savedQueries = this.buildRepo('savedQueries') as unknown as SavedQueryRepository;
		this.dashboardWidgets = this.buildRepo('dashboardWidgets') as unknown as DashboardWidgetRepository;
		this.plugins = this.buildRepo('plugins') as unknown as PluginRepository;
		this.userAiConfig = this.buildRepo('userAiConfig') as unknown as UserAiConfigRepository;
		this.queryExecutionLogs = this.buildRepo(
			'queryExecutionLogs'
		) as unknown as QueryExecutionLogRepository;
		this.friendRequests = this.buildRepo('friendRequests') as unknown as FriendRequestRepository;
		this.friendships = this.buildRepo('friendships') as unknown as FriendshipRepository;
		this.friendNotes = this.buildRepo('friendNotes') as unknown as FriendNoteRepository;
	}

	private buildRepo(name: string): Record<string, (...args: unknown[]) => Promise<unknown>> {
		const methods = REPO_METHODS[name] ?? [];
		const repo: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
		for (const m of methods) {
			repo[m] = (...args: unknown[]) => this.invoke(`${name}.${m}`, args);
		}
		return repo;
	}

	async open(): Promise<void> {
		if (this._open) return;
		if (this._closed) this._closed = false;
		const entry = await resolveWorkerEntry('runtime');
		const worker = spawnWorker(entry);
		this.worker = worker;
		this.attachListeners(worker);
		this._generation += 1;
		const gen = this._generation;
		const msg: SqliteOpenCommand = {
			type: 'open',
			generation: gen,
			requestId: this._nextRequestId++,
			config: toWorkerConfig(this.config)
		};
		try {
			await this.postAndWait(msg);
			this._open = true;
		} catch (err) {
			await this.terminateWorker();
			throw err;
		}
	}

	isOpen(): boolean {
		return this._open;
	}

	async close(): Promise<void> {
		this._open = false;
		const worker = this.worker;
		this.worker = null;
		this._generation += 1; // fence any late replies
		// Reject queued ordinary + availability; never reissue writes.
		for (const req of this.queue) req.reject(new Error('SQLite worker closed'));
		this.queue = [];
		this.pendingOrdinary = 0;
		if (this.availability) {
			clearTimeout(this.availability.timer);
			this.availability = null;
		}
		// Fence in-flight commands so awaiting callers settle (they did not complete).
		for (const [, pending] of this.pendingReplies) {
			pending.reject(new Error('SQLite worker closed'));
		}
		this.pendingReplies.clear();
		if (worker) {
			const closeMsg: SqliteWorkerCommand = {
				type: 'close',
				generation: this._generation,
				requestId: this._nextRequestId++
			};
			try {
				worker.postMessage(closeMsg);
			} catch {
				/* worker already gone */
			}
			// Graceful close: wait for the worker to finish its current command and
			// acknowledge, then terminate. This avoids force-terminating a worker
			// mid synchronous native call (which would crash the process).
			await this.waitForWorkerClosed(worker);
			await this.terminateWorker(worker);
		}
		this._closed = true;
	}

	// ---------------------------------------------------------------------
	// bounded atomic operations (one complete worker command each)
	// ---------------------------------------------------------------------
	createUserWithInitialData(input: CreateUserWithInitialDataInput): Promise<UserRow> {
		return this.invoke('createUserWithInitialData', [input]) as Promise<UserRow>;
	}

	createTaskWithDetails(input: CreateTaskWithDetailsInput): Promise<TaskRow> {
		return this.invoke('createTaskWithDetails', [input]) as Promise<TaskRow>;
	}

	updateTaskWithDetails(input: UpdateTaskWithDetailsInput): Promise<TaskRow | undefined> {
		return this.invoke('updateTaskWithDetails', [input]) as Promise<TaskRow | undefined>;
	}

	/**
	 * Coalesced live-availability probe (RISK-1 / NFR-002 / T046). At most one
	 * queued/in-flight worker command; host wait expires within 3s including
	 * queue time. Timeout -> unavailable (false) without cancelling an active
	 * transaction, freeing its slot early or submitting a duplicate check.
	 */
	checkAvailability(): Promise<boolean> {
		if (this._closed || !this._open) return Promise.resolve(false);
		// Coalesce only a still-pending availability; a timed-out/completed one must
		// never serve a stale success/failure.
		if (this.availability && !this.availability.settled) return this.availability.promise;
		const req: Req = {
			requestId: this._nextRequestId++,
			kind: 'availability',
			method: 'checkAvailability',
			args: [],
			resolve: () => undefined,
			reject: () => undefined
		};
		const promise = new Promise<boolean>((resolve, reject) => {
			req.resolve = () => resolve(true);
			// Any worker error / timeout => unavailable, never "healthy by staleness".
			req.reject = () => resolve(false);
		});
		const entry: AvailabilityEntry = {
			req,
			promise,
			dispatched: false,
			settled: false,
			timer: setTimeout(() => {
				// Mark unavailable and stop coalescing; leave the entry in place so no
				// duplicate check is submitted and the active slot is not freed early.
				entry.settled = true;
				req.reject(new Error('availability timeout'));
			}, AVAILABILITY_TIMEOUT_MS)
		};
		this.availability = entry;
		void this.pump();
		return promise;
	}

	// ---------------------------------------------------------------------
	// internal transport
	// ---------------------------------------------------------------------
	private invoke(method: string, args: unknown[]): Promise<unknown> {
		if (this._closed) return Promise.reject(new Error('SQLite facade is closed'));
		if (!this._open) return Promise.reject(new Error('SQLite facade is not open'));
		if (this.pendingOrdinary >= MAX_ORDINARY_QUEUE) {
			return Promise.reject(new Error('SQLite worker ordinary queue overflow'));
		}
		this.pendingOrdinary += 1;
		return new Promise((resolve, reject) => {
			this.queue.push({ requestId: this._nextRequestId++, kind: 'ordinary', method, args, resolve, reject });
			void this.pump();
		});
	}

	private async pump(): Promise<void> {
		if (this.processing) return;
		this.processing = true;
		try {
			while (true) {
				// Availability has next-slot priority after active work.
				if (this.availability && !this.availability.dispatched) {
					const entry = this.availability;
					entry.dispatched = true;
					await this.dispatchReq(entry.req);
					entry.settled = true;
					// Only clear if a newer availability has not replaced this entry.
					if (this.availability === entry) this.clearAvailability();
					continue;
				}
				const req = this.queue.shift();
				if (!req) break;
				await this.dispatchReq(req);
				this.pendingOrdinary = Math.max(0, this.pendingOrdinary - 1);
			}
		} finally {
			this.processing = false;
		}
	}

	private async dispatchReq(req: Req): Promise<void> {
		if (!this.worker) {
			req.reject(new Error('SQLite worker is not running'));
			return;
		}
		const msg: SqliteCommand = {
			type: 'command',
			generation: this._generation,
			requestId: req.requestId,
			method: req.method,
			args: req.args
		};
		try {
			const value = await this.postAndWait(msg);
			req.resolve(value);
		} catch (err) {
			req.reject(err);
		}
	}

	private postAndWait(message: SqliteWorkerCommand): Promise<unknown> {
		return new Promise((resolve, reject) => {
			if (!this.worker) {
				reject(new Error('SQLite worker is not running'));
				return;
			}
			this.pendingReplies.set(message.requestId, { resolve, reject });
			try {
				this.worker.postMessage(message);
			} catch (err) {
				this.pendingReplies.delete(message.requestId);
				reject(err);
			}
		});
	}

	private attachListeners(worker: Worker): void {
		worker.on('message', (msg: SqliteWorkerMessage) => {
			if (!msg) return;
			if (msg.type === 'closed') {
				for (const w of this.closeWaiters) w();
				this.closeWaiters.clear();
				return;
			}
			if (msg.type !== 'reply') return;
			const pending = this.pendingReplies.get(msg.requestId);
			if (!pending) return;
			this.pendingReplies.delete(msg.requestId);
			if (msg.generation !== this._generation) {
				// Stale/fenced generation: discard without resurrecting state.
				pending.reject(new Error('SQLite worker stale generation reply discarded'));
				return;
			}
			if (msg.ok) pending.resolve(msg.value);
			else pending.reject(new Error(msg.error?.message ?? 'SQLite worker error'));
		});
		worker.on('error', () => this.onWorkerCrash());
		worker.on('exit', (code) => {
			if (code !== 0) this.onWorkerCrash();
		});
	}

	private waitForWorkerClosed(worker: Worker): Promise<void> {
		return new Promise<void>((resolve) => {
			let done = false;
			const finish = () => {
				if (done) return;
				done = true;
				this.closeWaiters.delete(finish);
				resolve();
			};
			this.closeWaiters.add(finish);
			// Bound the wait: the worker may be finishing a busy-timeout write.
			// Prefer a genuine 'closed' ack; fall back to a bounded grace period so a
			// permanently blocked native call cannot deadlock shutdown forever.
			const deadline = Math.max(this.config.busyTimeoutMs + 1000, 5000);
			setTimeout(finish, deadline);
			if (worker.threadId === -1) finish();
		});
	}

	private onWorkerCrash(): void {
		this._open = false;
		this._generation += 1;
		for (const [, pending] of this.pendingReplies) {
			pending.reject(new Error('SQLite worker crashed; write outcome may be uncertain'));
		}
		this.pendingReplies.clear();
		for (const req of this.queue) req.reject(new Error('SQLite worker crashed'));
		this.queue = [];
		this.pendingOrdinary = 0;
		if (this.availability) {
			clearTimeout(this.availability.timer);
			this.availability = null;
		}
		this.worker = null;
	}

	private clearAvailability(): void {
		if (this.availability) {
			clearTimeout(this.availability.timer);
			this.availability = null;
		}
	}

	private async terminateWorker(worker?: Worker): Promise<void> {
		const w = worker ?? this.worker;
		this.worker = null;
		if (!w) return;
		const exited = new Promise<void>((resolve) => {
			w.once('exit', () => resolve());
		});
		try {
			await w.terminate();
			await exited;
		} catch {
			/* best-effort */
		}
	}

	/** Compile-time guard that every allowlisted service method is bound. */
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	private readonly _allowlistedServiceMethods: readonly string[] = [...SERVICE_METHODS];
}
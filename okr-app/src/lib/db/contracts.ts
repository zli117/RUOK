/**
 * Typed persistence boundary (FR-003 / persistence contract).
 *
 * This module defines the *port* the rest of the application depends on. It
 * deliberately exposes NO Drizzle tables, no raw driver handles, and no
 * SQLite|Postgres union. Each concrete adapter (`adapters/sqlite.ts`,
 * `adapters/postgres.ts`) implements this interface against a real backend.
 *
 * Conventions:
 *  - all public methods are async and return canonical {@link models} values;
 *  - missing single rows resolve to `undefined` (consistent with findFirst);
 *  - optional SQL NULL maps to `null`, never `false`/`0`;
 *  - mutations return domain rows or explicit affected counts, never a
 *    driver-specific `.changes` / `.rowCount` object;
 *  - backend faults become controlled errors with redacted connection data.
 */
import type {
	CreateTaskWithDetailsInput,
	DailyMetricValuePatch,
	DailyMetricValueRow,
	DailyMetricsPatch,
	DailyMetricsRow,
	DashboardWidgetRow,
	FriendNoteRow,
	FriendRequestRow,
	FriendRequestStatus,
	FriendshipRow,
	KeyResultPatch,
	KeyResultRow,
	MetricsTemplatePatch,
	MetricsTemplateRow,
	NewDailyMetricValueRow,
	NewDailyMetricsRow,
	NewDashboardWidgetRow,
	NewFriendNoteRow,
	NewFriendRequestRow,
	NewFriendshipRow,
	NewKeyResultRow,
	NewMetricsTemplateRow,
	NewObjectiveReflectionRow,
	NewObjectiveRow,
	NewPluginRow,
	NewQueryExecutionLogRow,
	NewSavedQueryRow,
	NewSessionRow,
	NewSystemConfigRow,
	NewTagRow,
	NewTaskAttributeRow,
	NewTaskRow,
	NewTimePeriodRow,
	NewUserAiConfigRow,
	NewUserRow,
	ObjectivePatch,
	ObjectiveReflectionRow,
	ObjectiveRow,
	ObjectiveWithKeyResults,
	PeriodType,
	PluginPatch,
	PluginRow,
	QueryExecutionLogRow,
	SavedQueryRow,
	SavedQueryType,
	SessionRow,
	SystemConfigRow,
	TagPatch,
	TagRow,
	TaskAttributeRow,
	TaskAttributeValueType,
	TaskPatch,
	TaskRow,
	TaskTagRow,
	TimePeriodPatch,
	TimePeriodRow,
	UpdateTaskWithDetailsInput,
	UserAiConfigRow,
	UserPatch,
	UserRow,
	WidgetType
} from './models';
import type { BackupSnapshot, RestoreCommandPlan, RestoreStats } from './backup/types';

export type DatabaseDialect = 'sqlite' | 'postgres';

// ---------------------------------------------------------------------------
// Configuration (FR-001 / FR-009 / FR-010)
// ---------------------------------------------------------------------------

/** SQLite journal modes supported at runtime (FR-010). */
export type SqliteJournalMode = 'wal' | 'delete';

export interface SqliteConfig {
	type: 'sqlite';
	/** Absolute or relative path to the SQLite database file. */
	path: string;
	/** Journal mode. `wal` is the default; `delete` is a supported operational choice. */
	journalMode: SqliteJournalMode;
	/** Bounded busy timeout in milliseconds. */
	busyTimeoutMs: number;
}

/** Verified TLS only; no silent downgrade (FR-009). */
export type PostgresSslMode = 'disable' | 'verify-full';

export interface PostgresConfig {
	type: 'postgres';
	/** postgres:// connection URL. Never logged. */
	connectionString: string;
	/** Bounded pool size. */
	poolMax: number;
	/** Bounded startup/connection wait in milliseconds. */
	connectTimeoutMs: number;
	/** Bounded per-statement timeout in milliseconds. */
	statementTimeoutMs: number;
	/** Explicit TLS mode; `verify-full` performs hostname + CA verification. */
	sslMode: PostgresSslMode;
	/** Optional path to a PEM CA file (mounted secret) for verify-full. */
	sslCaFile?: string;
}

export type DatabaseConfig = SqliteConfig | PostgresConfig;

// ---------------------------------------------------------------------------
// Domain repositories
// ---------------------------------------------------------------------------

export interface UserRepository {
	create(input: NewUserRow): Promise<UserRow>;
	findById(id: string): Promise<UserRow | undefined>;
	findByUsername(username: string): Promise<UserRow | undefined>;
	list(): Promise<UserRow[]>;
	update(id: string, patch: UserPatch): Promise<UserRow | undefined>;
	remove(id: string): Promise<number>;
	count(): Promise<number>;
}

export interface SessionRepository {
	create(input: NewSessionRow): Promise<SessionRow>;
	findById(id: string): Promise<SessionRow | undefined>;
	delete(id: string): Promise<number>;
	/** Delete every session belonging to a user (used on password change / disable). */
	deleteByUser(userId: string): Promise<number>;
	/** Delete every session that expires on or before `now`. Returns the count removed. */
	deleteExpired(now: Date): Promise<number>;
}

export interface SystemConfigRepository {
	/** All rows (raw values incl. secrets; secret masking lives in the server layer). */
	all(): Promise<SystemConfigRow[]>;
	/** Insert or update keyed on `key`. Returns the resulting row. */
	upsert(input: NewSystemConfigRow): Promise<SystemConfigRow>;
}

export interface ObjectiveReflectionRepository {
	create(input: NewObjectiveReflectionRow): Promise<ObjectiveReflectionRow>;
	findByUserLevelYearMonth(input: {
		userId: string;
		level: 'yearly' | 'monthly';
		year: number;
		month: number | null;
	}): Promise<ObjectiveReflectionRow | undefined>;
	update(id: string, patch: { reflection: string; updatedAt?: Date }): Promise<ObjectiveReflectionRow | undefined>;
}

export interface ObjectiveRepository {
	create(input: NewObjectiveRow): Promise<ObjectiveRow>;
	findById(id: string): Promise<ObjectiveRow | undefined>;
	listByUser(userId: string): Promise<ObjectiveRow[]>;
	/** Objective rows joined with their key results (demonstrates real JOIN). */
	listByUserWithKeyResults(userId: string): Promise<ObjectiveWithKeyResults[]>;
	update(id: string, patch: ObjectivePatch): Promise<ObjectiveRow | undefined>;
	/** insert-or-update keyed on the primary key (demonstrates real UPSERT). */
	upsert(input: NewObjectiveRow & { id: string }): Promise<ObjectiveRow>;
	remove(id: string): Promise<number>;
	count(): Promise<number>;
}

export interface KeyResultRepository {
	create(input: NewKeyResultRow): Promise<KeyResultRow>;
	findById(id: string): Promise<KeyResultRow | undefined>;
	listByObjective(objectiveId: string): Promise<KeyResultRow[]>;
	update(id: string, patch: KeyResultPatch): Promise<KeyResultRow | undefined>;
	remove(id: string): Promise<number>;
}

export interface TaskListFilters {
	timePeriodId?: string;
	completed?: boolean;
}

export interface TaskRepository {
	create(input: NewTaskRow): Promise<TaskRow>;
	findById(id: string): Promise<TaskRow | undefined>;
	update(id: string, patch: TaskPatch): Promise<TaskRow | undefined>;
	remove(id: string): Promise<number>;
	count(): Promise<number>;
	/** All tasks in a period, ordered by `sortOrder` ascending. */
	listByPeriod(timePeriodId: string): Promise<TaskRow[]>;
	/** Tasks for a user with optional period/completion filters, ordered by sortOrder. */
	listByUser(userId: string, filters?: TaskListFilters): Promise<TaskRow[]>;
	/**
	 * Atomic timer start (T018). Sets `timerStartedAt = at`. Rejects/undefined if
	 * the timer is already running. The update is atomic on both backends, so a
	 * concurrent client cannot clobber the running state.
	 */
	startTimer(id: string, at: Date): Promise<TaskRow | undefined>;
	/**
	 * Atomic timer stop (T018). Reads the current row inside the backend
	 * transaction and accumulates the elapsed milliseconds (safe bigint on
	 * PostgreSQL) into `timeSpentMs`, clearing `timerStartedAt`. No
	 * read-modify-write lost update under network latency.
	 */
	stopTimer(id: string, at: Date): Promise<TaskRow | undefined>;
}

export interface TaskAttributeRepository {
	listByTask(taskId: string): Promise<TaskAttributeRow[]>;
	/** Batch: taskId -> rows. Returns an entry for every requested taskId. */
	listByTasks(taskIds: string[]): Promise<Map<string, TaskAttributeRow[]>>;
	/** Insert or update a single attribute keyed on (taskId, key). Returns the row. */
	upsertByTaskAndKey(input: { taskId: string; key: string; value: string; valueType: TaskAttributeValueType }): Promise<TaskAttributeRow>;
	/** Delete a single attribute by (taskId, key). Returns rows removed. */
	removeByTaskAndKey(taskId: string, key: string): Promise<number>;
}

export interface TagRepository {
	create(input: NewTagRow): Promise<TagRow>;
	findById(id: string): Promise<TagRow | undefined>;
	listByUser(userId: string): Promise<TagRow[]>;
	findByUserAndName(userId: string, name: string): Promise<TagRow | undefined>;
	update(id: string, patch: TagPatch): Promise<TagRow | undefined>;
	remove(id: string): Promise<number>;
}

export interface TaskTagRepository {
	listByTask(taskId: string): Promise<TaskTagRow[]>;
	/** Batch: taskId -> links. Returns an entry for every requested taskId. */
	listByTasks(taskIds: string[]): Promise<Map<string, TaskTagRow[]>>;
}

export interface TimePeriodLookup {
	userId: string;
	type: PeriodType;
	year?: number;
	month?: number | null;
	week?: number | null;
	day?: string;
}

export interface TimePeriodListFilters {
	type?: PeriodType;
	year?: number;
	month?: number;
	week?: number;
}

export interface TimePeriodRepository {
	create(input: NewTimePeriodRow): Promise<TimePeriodRow>;
	findById(id: string): Promise<TimePeriodRow | undefined>;
	/** Find a single period matching the lookup (used for daily/weekly/monthly lookups). */
	find(lookup: TimePeriodLookup): Promise<TimePeriodRow | undefined>;
	/** List a user's periods, optionally filtered, ordered by year/month/week descending. */
	listByUser(userId: string, filters?: TimePeriodListFilters): Promise<TimePeriodRow[]>;
	update(id: string, patch: TimePeriodPatch): Promise<TimePeriodRow | undefined>;
	count(): Promise<number>;
}

// ---------------------------------------------------------------------------
// metrics repositories (T019)
// ---------------------------------------------------------------------------

export interface DailyMetricsRepository {
	findByPeriod(userId: string, timePeriodId: string): Promise<DailyMetricsRow | undefined>;
	create(input: NewDailyMetricsRow): Promise<DailyMetricsRow>;
	update(id: string, patch: DailyMetricsPatch): Promise<DailyMetricsRow | undefined>;
}

export interface MetricsTemplateRepository {
	create(input: NewMetricsTemplateRow): Promise<MetricsTemplateRow>;
	findById(id: string): Promise<MetricsTemplateRow | undefined>;
	listByUser(userId: string): Promise<MetricsTemplateRow[]>;
	/** Latest template with `effectiveFrom <= date` (version selection by effective date). */
	findActiveByDate(userId: string, date: string): Promise<MetricsTemplateRow | undefined>;
	update(id: string, patch: MetricsTemplatePatch): Promise<MetricsTemplateRow | undefined>;
	remove(id: string): Promise<number>;
}

export interface DailyMetricValueRepository {
	listByUserAndDate(userId: string, date: string): Promise<DailyMetricValueRow[]>;
	/** Fetch values for a specific set of metric names on one date (external-source check). */
	listByUserAndDateAndNames(
		userId: string,
		date: string,
		metricNames: string[]
	): Promise<DailyMetricValueRow[]>;
	findByUserDateName(
		userId: string,
		date: string,
		metricName: string
	): Promise<DailyMetricValueRow | undefined>;
	/** Insert or update keyed on (userId, date, metricName). */
	upsert(input: NewDailyMetricValueRow): Promise<DailyMetricValueRow>;
}

// ---------------------------------------------------------------------------
// backup export/restore (WP06 / FR-008)
//
// `exportSnapshot` returns a *consistent* snapshot taken inside a single
// backend transaction (repeatable-read on PostgreSQL, a synchronous read
// transaction on SQLite). `restore` executes a fully-validated
// {@link RestoreCommandPlan} atomically: SQLite runs all statements in one
// better-sqlite3 transaction; PostgreSQL runs them with awaits on a single
// transaction-scoped client. No query escapes the transaction.
//
// The time_commitments read (deferred from WP05) is performed inside the
// adapter's snapshot/restore transaction (dialect code), so no standalone
// TimeCommitmentRepository is introduced here; a general-purpose repository
// will be added in WP07 when application consumers need it.
// ---------------------------------------------------------------------------

export interface BackupRepository {
	exportSnapshot(userId: string): Promise<BackupSnapshot>;
	restore(plan: RestoreCommandPlan): Promise<RestoreStats>;
}

// ---------------------------------------------------------------------------
// saved_queries (WP07 / T025)
// ---------------------------------------------------------------------------

export interface SavedQueryListFilters {
	queryType?: SavedQueryType;
}

export interface SavedQueryRepository {
	create(input: NewSavedQueryRow): Promise<SavedQueryRow>;
	findById(id: string): Promise<SavedQueryRow | undefined>;
	/** Find a saved query owned by `userId` (per-user scope). */
	findByIdForUser(id: string, userId: string): Promise<SavedQueryRow | undefined>;
	listByUser(userId: string, filters?: SavedQueryListFilters): Promise<SavedQueryRow[]>;
	update(id: string, patch: { name?: string; description?: string | null; code?: string; queryType?: SavedQueryType; updatedAt?: Date }): Promise<SavedQueryRow | undefined>;
	remove(id: string): Promise<number>;
}

// ---------------------------------------------------------------------------
// dashboard_widgets (WP07 / T025)
// ---------------------------------------------------------------------------

export interface DashboardWidgetRepository {
	create(input: NewDashboardWidgetRow): Promise<DashboardWidgetRow>;
	findById(id: string): Promise<DashboardWidgetRow | undefined>;
	/** Find a widget owned by `userId` (per-user scope). */
	findByIdForUser(id: string, userId: string): Promise<DashboardWidgetRow | undefined>;
	listByUserAndPage(userId: string, page: string): Promise<DashboardWidgetRow[]>;
	update(id: string, patch: { title?: string; widgetType?: WidgetType; config?: string; sortOrder?: number }): Promise<DashboardWidgetRow | undefined>;
	remove(id: string): Promise<number>;
}

// ---------------------------------------------------------------------------
// plugins (WP07 / T026)
// ---------------------------------------------------------------------------

export interface PluginRepository {
	/** The user's plugin row for `pluginId`, if any. */
	findByUserAndPlugin(userId: string, pluginId: string): Promise<PluginRow | undefined>;
	/** All enabled plugin configurations (used by the sync scheduler). */
	listEnabled(): Promise<PluginRow[]>;
	create(input: NewPluginRow): Promise<PluginRow>;
	update(id: string, patch: PluginPatch): Promise<PluginRow | undefined>;
	/** Update a plugin by (userId, pluginId); resolves undefined when absent. */
	updateByUserAndPlugin(userId: string, pluginId: string, patch: PluginPatch): Promise<PluginRow | undefined>;
}

// ---------------------------------------------------------------------------
// user_ai_config (WP07 / T026)
// ---------------------------------------------------------------------------

export interface UserAiConfigRepository {
	findByUser(userId: string): Promise<UserAiConfigRow | undefined>;
	/** Insert-or-update keyed on userId. Returns the resulting row. */
	upsert(input: NewUserAiConfigRow & { id: string }): Promise<UserAiConfigRow>;
}

// ---------------------------------------------------------------------------
// query_execution_logs (WP07 / T026)
// ---------------------------------------------------------------------------

export interface QueryExecutionLogFilters {
	userId?: string;
	success?: boolean;
	from?: Date;
	to?: Date;
}

export interface QueryExecutionLogRepository {
	create(input: NewQueryExecutionLogRow): Promise<QueryExecutionLogRow>;
	/** Recent logs for a user, newest first (admin/debugging). */
	listByUser(userId: string, limit?: number): Promise<QueryExecutionLogRow[]>;
	/** Paginated, filtered logs for the admin UI (newest first). */
	list(filters: QueryExecutionLogFilters, opts: { limit: number; offset: number }): Promise<QueryExecutionLogRow[]>;
	/** Total rows matching the filters (pagination). */
	count(filters: QueryExecutionLogFilters): Promise<number>;
	/** All rows with `createdAt >= since` (stats aggregation). */
	listSince(since: Date): Promise<QueryExecutionLogRow[]>;
}

// ---------------------------------------------------------------------------
// social / friends (WP07 / T025, FR-006)
// ---------------------------------------------------------------------------

export interface FriendRequestRepository {
	create(input: NewFriendRequestRow): Promise<FriendRequestRow>;
	/** Pending request between two users in either direction. */
	findPendingBetween(a: string, b: string): Promise<FriendRequestRow | undefined>;
	/** Requests sent to `userId` that are pending (incoming). */
	listIncomingPending(userId: string): Promise<FriendRequestRow[]>;
	/** Requests sent by `userId` that are pending (outgoing). */
	listOutgoingPending(userId: string): Promise<FriendRequestRow[]>;
	/** Find a request by id that is pending and addressed to `toUserId`. */
	findPendingTo(id: string, toUserId: string): Promise<FriendRequestRow | undefined>;
	/** Find a request by id that is pending and sent by `fromUserId`. */
	findPendingFrom(id: string, fromUserId: string): Promise<FriendRequestRow | undefined>;
	update(id: string, patch: { status: FriendRequestStatus; respondedAt: Date }): Promise<FriendRequestRow | undefined>;
	remove(id: string): Promise<number>;
}

export interface FriendshipRepository {
	create(input: NewFriendshipRow): Promise<FriendshipRow>;
	/** A friendship between two users in either direction. */
	findBetween(a: string, b: string): Promise<FriendshipRow | undefined>;
	/** All friendships involving `userId` (as userId1 or userId2). */
	listForUser(userId: string): Promise<FriendshipRow[]>;
	remove(id: string): Promise<number>;
}

export interface FriendNoteRepository {
	findByUserAndFriend(userId: string, friendId: string): Promise<FriendNoteRow | undefined>;
	/** Upsert a note for (userId, friendId). Returns the resulting row. */
	upsert(input: NewFriendNoteRow): Promise<FriendNoteRow>;
	/** Delete notes in either direction between two users (used on unfriend). */
	removeBetween(a: string, b: string): Promise<number>;
}

// ---------------------------------------------------------------------------
// Bounded atomic operation (persistence contract: "Atomic operation contract")
//
// A backend-independent command plan is built by canonical orchestration and
// executed atomically by each adapter:
//  - SQLite: all statements run synchronously inside one better-sqlite3
//    transaction (never `await` inside the callback).
//  - PostgreSQL: all statements run with awaits on a single transaction-scoped
//    client; the public promise resolves only after COMMIT and rejects only
//    after ROLLBACK/cleanup.
// ---------------------------------------------------------------------------

export interface CreateUserWithInitialDataInput {
	user: NewUserRow;
	objectives: Array<{ objective: NewObjectiveRow; keyResults: NewKeyResultRow[] }>;
}

export interface DatabaseServices {
	readonly dialect: DatabaseDialect;

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

	/** Open the backend and make it ready for use. Idempotent. */
	open(): Promise<void>;
	/** Whether `open()` has completed successfully. */
	isOpen(): boolean;
	/** Release all resources (pool/sqlite file). Idempotent. */
	close(): Promise<void>;
	/**
	 * Bounded live-availability probe (FR-008 / NFR-002 / D-05).
	 *
	 * Runs a real query against a required application table within a bounded
	 * probe budget (at most 3s total including checkout/queue time). Resolves
	 * `true` only when the backend can answer; `false` on outage, pool
	 * saturation, idle errors or probe timeout. Never throws and never serves a
	 * cached successful result. Implementations must release/destroy timed-out
	 * resources and share in-flight checks without repeating a completed one.
	 */
	checkAvailability(): Promise<boolean>;

	/**
	 * Bounded atomic operation: create a user together with their initial
	 * objectives and key results. Either everything commits or nothing does.
	 * On failure the created user (and any partial data) is rolled back.
	 */
	createUserWithInitialData(input: CreateUserWithInitialDataInput): Promise<UserRow>;

	/**
	 * Bounded atomic operation (T018): create a task together with its flexible
	 * attributes and tag links in one transaction. Either all rows commit or
	 * nothing does. The created {@link TaskRow} is returned.
	 */
	createTaskWithDetails(input: CreateTaskWithDetailsInput): Promise<TaskRow>;

	/**
	 * Bounded atomic operation (T018): update a task's base fields and,
	 * optionally, atomically replace its attributes and/or tag links. Missing
	 * rows resolve to `undefined`.
	 */
	updateTaskWithDetails(input: UpdateTaskWithDetailsInput): Promise<TaskRow | undefined>;
}
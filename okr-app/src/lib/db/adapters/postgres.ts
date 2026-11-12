/**
 * Concrete PostgreSQL adapter (node-postgres `pg` + drizzle-orm/node-postgres).
 *
 * Implements the typed {@link DatabaseServices} boundary against a real
 * PostgreSQL server through a bounded pool. Only dialect query/transaction
 * code lives here; canonical ownership/validation lives in shared models.
 *
 * Lifecycle (T007): the adapter is a *lazy* factory — the constructor stores
 * config and performs no network I/O. `open()` creates the pool (with verified
 * TLS from {@link buildPostgresPoolConfig}) and performs a bounded readiness
 * probe. PostgreSQL mode never touches a SQLite file.
 *
 * PostgreSQL reads are async and use a bounded pool; transactions use a single
 * pinned client (BEGIN ... COMMIT/ROLLBACK). All awaited work inside a
 * transaction runs on that pinned client, never the pool.
 */
import { Pool, type PoolClient, type PoolConfig } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { and, asc, count, desc, eq, gte, inArray, isNull, lte, or, type SQL } from 'drizzle-orm';
import * as schema from '../schema/postgres';
import { buildPostgresPoolConfig } from '../config';
import { toSecondPrecision } from '../models';
import type {
	BackupRepository,
	CreateUserWithInitialDataInput,
	DailyMetricValueRepository,
	DailyMetricsRepository,
	DatabaseServices,
	DashboardWidgetRepository,
	FriendNoteRepository,
	FriendRequestRepository,
	FriendshipRepository,
	KeyResultRepository,
	MetricsTemplateRepository,
	ObjectiveReflectionRepository,
	ObjectiveRepository,
	PluginRepository,
	PostgresConfig,
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
	CreateTaskWithDetailsInput as CreateTaskInput,
	DailyMetricValueRow,
	DailyMetricsPatch,
	DailyMetricsRow,
	DashboardWidgetRow,
	FriendNoteRow,
	FriendRequestRow,
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
	NewPrincipleRow,
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
	NewValueRow,
	ObjectiveReflectionRow,
	ObjectiveRow,
	ObjectiveWithKeyResults,
	PluginPatch,
	PluginRow,
	PrincipleRow,
	QueryExecutionLogRow,
	SavedQueryRow,
	SessionRow,
	SystemConfigRow,
	TagRow,
	TaskAttributeRow,
	TaskPatch,
	TaskRow,
	TaskTagRow,
	TimeCommitmentRow,
	TimePeriodPatch,
	TimePeriodRow,
	UpdateTaskWithDetailsInput as UpdateTaskInput,
	UserRow,
	UserAiConfigRow,
	ValueRow
} from '../models';
import type { BackupSnapshot, RestoreCommandPlan, RestoreStats } from '../backup/types';

type PgUser = typeof schema.users.$inferSelect;
type PgSession = typeof schema.sessions.$inferSelect;
type PgSystemConfig = typeof schema.systemConfig.$inferSelect;
type PgObjective = typeof schema.objectives.$inferSelect;
type PgKeyResult = typeof schema.keyResults.$inferSelect;
type PgObjectiveReflection = typeof schema.objectiveReflections.$inferSelect;
type PgTask = typeof schema.tasks.$inferSelect;
type PgTimePeriod = typeof schema.timePeriods.$inferSelect;
type PgTaskAttribute = typeof schema.taskAttributes.$inferSelect;
type PgTag = typeof schema.tags.$inferSelect;
type PgTaskTag = typeof schema.taskTags.$inferSelect;
type PgDailyMetrics = typeof schema.dailyMetrics.$inferSelect;
type PgMetricsTemplate = typeof schema.metricsTemplates.$inferSelect;
type PgDailyMetricValue = typeof schema.dailyMetricValues.$inferSelect;
type PgValue = typeof schema.values.$inferSelect;
type PgPrinciple = typeof schema.principles.$inferSelect;
type PgSavedQuery = typeof schema.savedQueries.$inferSelect;
type PgDashboardWidget = typeof schema.dashboardWidgets.$inferSelect;
type PgTimeCommitment = typeof schema.timeCommitments.$inferSelect;
type PgPlugin = typeof schema.plugins.$inferSelect;
type PgUserAiConfig = typeof schema.userAiConfig.$inferSelect;
type PgQueryExecutionLog = typeof schema.queryExecutionLogs.$inferSelect;
type PgFriendRequest = typeof schema.friendRequests.$inferSelect;
type PgFriendship = typeof schema.friendships.$inferSelect;
type PgFriendNote = typeof schema.friendNotes.$inferSelect;

function toUser(row: PgUser): UserRow {
	return {
		id: row.id,
		username: row.username,
		passwordHash: row.passwordHash,
		weekStartDay: row.weekStartDay,
		timezone: row.timezone,
		bgColor: row.bgColor,
		isAdmin: row.isAdmin,
		isDisabled: row.isDisabled,
		createdAt: toSecondPrecision(row.createdAt)
	};
}

function toSession(row: PgSession): SessionRow {
	return {
		id: row.id,
		userId: row.userId,
		expiresAt: toSecondPrecision(row.expiresAt)
	};
}

function toSystemConfig(row: PgSystemConfig): SystemConfigRow {
	return {
		key: row.key,
		value: row.value,
		isSecret: row.isSecret,
		updatedAt: toSecondPrecision(row.updatedAt)
	};
}

function toObjective(row: PgObjective): ObjectiveRow {
	return {
		id: row.id,
		userId: row.userId,
		title: row.title,
		description: row.description,
		level: row.level,
		year: row.year,
		month: row.month,
		weight: row.weight,
		parentId: row.parentId,
		category: row.category,
		colorIndex: row.colorIndex,
		createdAt: toSecondPrecision(row.createdAt),
		updatedAt: toSecondPrecision(row.updatedAt)
	};
}

function toKeyResult(row: PgKeyResult): KeyResultRow {
	return {
		id: row.id,
		objectiveId: row.objectiveId,
		title: row.title,
		details: row.details,
		weight: row.weight,
		score: row.score,
		scoreLabel: row.scoreLabel,
		expectedHours: row.expectedHours,
		sortOrder: row.sortOrder,
		measurementType: row.measurementType,
		checkboxItems: row.checkboxItems,
		progressQueryId: row.progressQueryId,
		progressQueryCode: row.progressQueryCode,
		widgetQueryId: row.widgetQueryId,
		widgetQueryCode: row.widgetQueryCode,
		createdAt: toSecondPrecision(row.createdAt),
		updatedAt: toSecondPrecision(row.updatedAt)
	};
}

function toObjectiveReflection(row: PgObjectiveReflection): ObjectiveReflectionRow {
	return {
		id: row.id,
		userId: row.userId,
		level: row.level,
		year: row.year,
		month: row.month,
		reflection: row.reflection,
		createdAt: toSecondPrecision(row.createdAt),
		updatedAt: toSecondPrecision(row.updatedAt)
	};
}

function toTask(row: PgTask): TaskRow {
	return {
		id: row.id,
		userId: row.userId,
		timePeriodId: row.timePeriodId,
		title: row.title,
		completed: row.completed,
		completedAt: row.completedAt ? toSecondPrecision(row.completedAt) : null,
		sortOrder: row.sortOrder,
		timeSpentMs: row.timeSpentMs,
		timerStartedAt: row.timerStartedAt ? toSecondPrecision(row.timerStartedAt) : null,
		createdAt: toSecondPrecision(row.createdAt),
		updatedAt: toSecondPrecision(row.updatedAt)
	};
}

function toTimePeriod(row: PgTimePeriod): TimePeriodRow {
	return {
		id: row.id,
		userId: row.userId,
		periodType: row.periodType,
		year: row.year,
		month: row.month,
		week: row.week,
		day: row.day,
		notes: row.notes,
		reviewWhatWorked: row.reviewWhatWorked,
		reviewImprovements: row.reviewImprovements,
		createdAt: toSecondPrecision(row.createdAt),
		updatedAt: toSecondPrecision(row.updatedAt)
	};
}

function toTaskAttribute(row: PgTaskAttribute): TaskAttributeRow {
	return {
		id: row.id,
		taskId: row.taskId,
		key: row.key,
		value: row.value,
		valueType: row.valueType
	};
}

function toTag(row: PgTag): TagRow {
	return {
		id: row.id,
		userId: row.userId,
		name: row.name,
		color: row.color,
		category: row.category
	};
}

function toTaskTag(row: PgTaskTag): TaskTagRow {
	return {
		taskId: row.taskId,
		tagId: row.tagId
	};
}

function toDailyMetrics(row: PgDailyMetrics): DailyMetricsRow {
	return {
		id: row.id,
		userId: row.userId,
		timePeriodId: row.timePeriodId,
		previousNightBedTime: row.previousNightBedTime,
		wakeUpTime: row.wakeUpTime,
		sleepLength: row.sleepLength,
		cardioLoad: row.cardioLoad,
		fitbitReadiness: row.fitbitReadiness,
		steps: row.steps,
		heartPoints: row.heartPoints,
		restingHeartRate: row.restingHeartRate,
		customMetrics: row.customMetrics
	};
}

function toMetricsTemplate(row: PgMetricsTemplate): MetricsTemplateRow {
	return {
		id: row.id,
		userId: row.userId,
		name: row.name,
		effectiveFrom: row.effectiveFrom,
		metricsDefinition: row.metricsDefinition,
		createdAt: toSecondPrecision(row.createdAt),
		updatedAt: toSecondPrecision(row.updatedAt)
	};
}

function toDailyMetricValue(row: PgDailyMetricValue): DailyMetricValueRow {
	return {
		id: row.id,
		userId: row.userId,
		date: row.date,
		metricName: row.metricName,
		value: row.value,
		source: row.source
	};
}

function toValue(row: PgValue): ValueRow {
	return {
		id: row.id,
		userId: row.userId,
		title: row.title,
		rank: row.rank,
		description: row.description,
		createdAt: toSecondPrecision(row.createdAt),
		updatedAt: toSecondPrecision(row.updatedAt)
	};
}

function toPrinciple(row: PgPrinciple): PrincipleRow {
	return {
		id: row.id,
		userId: row.userId,
		valueId: row.valueId,
		title: row.title,
		description: row.description,
		examples: row.examples,
		createdAt: toSecondPrecision(row.createdAt),
		updatedAt: toSecondPrecision(row.updatedAt)
	};
}

function toSavedQuery(row: PgSavedQuery): SavedQueryRow {
	return {
		id: row.id,
		userId: row.userId,
		name: row.name,
		description: row.description,
		queryType: row.queryType,
		code: row.code,
		createdAt: toSecondPrecision(row.createdAt),
		updatedAt: toSecondPrecision(row.updatedAt)
	};
}

function toDashboardWidget(row: PgDashboardWidget): DashboardWidgetRow {
	return {
		id: row.id,
		userId: row.userId,
		title: row.title,
		widgetType: row.widgetType,
		config: row.config,
		sortOrder: row.sortOrder,
		page: row.page,
		createdAt: toSecondPrecision(row.createdAt)
	};
}

function toTimeCommitment(row: PgTimeCommitment): TimeCommitmentRow {
	return {
		timePeriodId: row.timePeriodId,
		numberOfWeeks: row.numberOfWeeks,
		availableHoursPerWeekday: row.availableHoursPerWeekday,
		availableHoursPerWeekend: row.availableHoursPerWeekend
	};
}

function toPlugin(row: PgPlugin): PluginRow {
	return {
		id: row.id,
		userId: row.userId,
		pluginId: row.pluginId,
		enabled: row.enabled,
		config: row.config,
		lastSync: row.lastSync ? toSecondPrecision(row.lastSync) : null,
		createdAt: toSecondPrecision(row.createdAt)
	};
}

function toUserAiConfig(row: PgUserAiConfig): UserAiConfigRow {
	return {
		id: row.id,
		userId: row.userId,
		provider: row.provider,
		providersConfig: row.providersConfig,
		customSystemPrompt: row.customSystemPrompt,
		maxAgentRounds: row.maxAgentRounds,
		createdAt: toSecondPrecision(row.createdAt),
		updatedAt: toSecondPrecision(row.updatedAt)
	};
}

function toQueryExecutionLog(row: PgQueryExecutionLog): QueryExecutionLogRow {
	return {
		id: row.id,
		userId: row.userId,
		codeSnippet: row.codeSnippet,
		success: row.success,
		errorMessage: row.errorMessage,
		executionTimeMs: row.executionTimeMs,
		createdAt: toSecondPrecision(row.createdAt)
	};
}

function toFriendRequest(row: PgFriendRequest): FriendRequestRow {
	return {
		id: row.id,
		fromUserId: row.fromUserId,
		toUserId: row.toUserId,
		status: row.status,
		createdAt: toSecondPrecision(row.createdAt),
		respondedAt: row.respondedAt ? toSecondPrecision(row.respondedAt) : null
	};
}

function toFriendship(row: PgFriendship): FriendshipRow {
	return {
		id: row.id,
		userId1: row.userId1,
		userId2: row.userId2,
		createdAt: toSecondPrecision(row.createdAt)
	};
}

function toFriendNote(row: PgFriendNote): FriendNoteRow {
	return {
		id: row.id,
		userId: row.userId,
		friendId: row.friendId,
		note: row.note,
		updatedAt: toSecondPrecision(row.updatedAt)
	};
}

/** Canonical derivation of a task-attribute row from a JS value (T018). */
function attributeRowsFor(taskId: string, attributes: Record<string, unknown>): NewTaskAttributeRow[] {
	const rows: NewTaskAttributeRow[] = [];
	for (const [key, value] of Object.entries(attributes)) {
		if (value === null || value === undefined) continue;
		rows.push({
			id: crypto.randomUUID(),
			taskId,
			key,
			value: String(value),
			valueType: typeof value === 'number' ? 'number' : 'text'
		});
	}
	return rows;
}

export class PostgresDatabaseServices implements DatabaseServices {
	readonly dialect = 'postgres' as const;
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

	private pool!: Pool;
	private db!: NodePgDatabase<typeof schema>;
	private _open = false;
	private openPromise: Promise<void> | null = null;
	private closePromise: Promise<void> | null = null;

	constructor(private readonly config: PostgresConfig) {
		// Lazy: no network I/O until open().
		this.users = this.createUserRepository();
		this.sessions = this.createSessionRepository();
		this.systemConfig = this.createSystemConfigRepository();
		this.objectives = this.createObjectiveRepository();
		this.keyResults = this.createKeyResultRepository();
		this.objectiveReflections = this.createObjectiveReflectionRepository();
		this.tasks = this.createTaskRepository();
		this.taskAttributes = this.createTaskAttributeRepository();
		this.tags = this.createTagRepository();
		this.taskTags = this.createTaskTagRepository();
		this.timePeriods = this.createTimePeriodRepository();
		this.dailyMetrics = this.createDailyMetricsRepository();
		this.metricsTemplates = this.createMetricsTemplateRepository();
		this.dailyMetricValues = this.createDailyMetricValueRepository();
		this.backup = this.createBackupRepository();
		this.savedQueries = this.createSavedQueryRepository();
		this.dashboardWidgets = this.createDashboardWidgetRepository();
		this.plugins = this.createPluginRepository();
		this.userAiConfig = this.createUserAiConfigRepository();
		this.queryExecutionLogs = this.createQueryExecutionLogRepository();
		this.friendRequests = this.createFriendRequestRepository();
		this.friendships = this.createFriendshipRepository();
		this.friendNotes = this.createFriendNoteRepository();
	}

	/** Total live-probe budget (checkout + query + response overhead), <=3s (NFR-002). */
	private readonly availabilityTimeoutMs = 3000;

	async open(): Promise<void> {
		// A new pool cannot replace one still draining, and concurrent reopen
		// callers must share the same opening attempt rather than leak a pool.
		while (this.closePromise) {
			const closing = this.closePromise;
			await closing;
			if (this.openPromise) await this.openPromise;
			if (this.closePromise === closing) this.closePromise = null;
		}
		if (this._open) return;
		if (this.openPromise) return this.openPromise;
		const pool = new Pool(buildPostgresPoolConfig(this.config));
		// Idle-client errors must never crash the process (T015): an idle pool
		// connection that dies is surfaced by the next checkAvailability()/statement
		// rather than raising an unhandled 'error' event. Log a redacted message.
		pool.on('error', (err: Error) => {
			console.error('[postgres] idle pool error:', err.message);
		});
		this.pool = pool;
		this.db = drizzle(pool, { schema });

		this.openPromise = (async () => {
			// Bounded readiness probe: acquire a client and release it. This surfaces
			// connection errors at open() (startup/readiness) rather than at first use.
			const client = await pool.connect();
			try {
				await client.query('SELECT 1');
			} finally {
				client.release();
			}
			if (this.closePromise) throw new Error('PostgreSQL open attempt superseded by close');
			this._open = true;
		})().finally(() => {
			this.openPromise = null;
		});
		return this.openPromise;
	}

	isOpen(): boolean {
		return this._open;
	}

	/**
	 * Bounded live-availability probe (T015 / NFR-002).
	 *
	 * Runs a real query against a required application table (`users`) within a
	 * 3-second total budget covering checkout + query. On timeout or error it
	 * destroys the checked-out client (never returns a possibly-stuck connection
	 * to the pool) and reports `false`, so saturation, outage and idle errors
	 * report unavailable without process termination or leaked work. A later
	 * success can recover. Uses the real application pool — no separate healthy
	 * pool masks exhaustion.
	 */
	async checkAvailability(): Promise<boolean> {
		if (!this._open || !this.pool) return false;
		let client: PoolClient | undefined;
		let destroyed = false;
		let settled = false;
		const releaseOrDestroy = () => {
			if (!client || destroyed) return;
			destroyed = true;
			try {
				client.release(true); // destroy: never pool a possibly-stuck client
			} catch {
				/* already released/destroyed */
			}
		};
		return new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				releaseOrDestroy();
				resolve(false);
			}, this.availabilityTimeoutMs);
			(async () => {
				try {
					client = await this.pool!.connect();
					if (settled) {
						releaseOrDestroy(); // late checkout after timeout -> clean up
						return;
					}
					await client.query('SELECT 1 FROM users LIMIT 1');
					if (settled) {
						releaseOrDestroy();
						return;
					}
					settled = true;
					destroyed = true;
					try {
						client.release(); // healthy: return to the pool
					} catch {
						/* already destroyed */
					}
					resolve(true);
				} catch {
					if (!settled) {
						settled = true;
						releaseOrDestroy();
						resolve(false);
					}
				} finally {
					clearTimeout(timer);
				}
			})();
		});
	}

	close(): Promise<void> {
		// Keep the completed promise until reopen, so every close of this pool
		// shares its one drain operation, including concurrent callers.
		this._open = false;
		if (!this.closePromise) this.closePromise = this.pool ? this.pool.end() : Promise.resolve();
		return this.closePromise;
	}

	// ---------------------------------------------------------------------
	// users
	// ---------------------------------------------------------------------
	private createUserRepository(): UserRepository {
		const table = schema.users;
		return {
			create: async (input) => toUser((await this.db.insert(table).values(input).returning())[0]),
			findById: async (id) => {
				const rows = await this.db.select().from(table).where(eq(table.id, id)).limit(1);
				return rows[0] ? toUser(rows[0]) : undefined;
			},
			findByUsername: async (username) => {
				const rows = await this.db.select().from(table).where(eq(table.username, username)).limit(1);
				return rows[0] ? toUser(rows[0]) : undefined;
			},
			list: async () => (await this.db.select().from(table)).map(toUser),
			update: async (id, patch) => {
				const rows = await this.db.update(table).set(patch).where(eq(table.id, id)).returning();
				return rows[0] ? toUser(rows[0]) : undefined;
			},
			remove: async (id) => {
				const rows = await this.db.delete(table).where(eq(table.id, id)).returning({ id: table.id });
				return rows.length;
			},
			count: async () => (await this.db.select({ c: count() }).from(table))[0]?.c ?? 0
		};
	}

	// ---------------------------------------------------------------------
	// sessions
	// ---------------------------------------------------------------------
	private createSessionRepository(): SessionRepository {
		const table = schema.sessions;
		return {
			create: async (input: NewSessionRow) =>
				toSession((await this.db.insert(table).values(input).returning())[0]),
			findById: async (id) => {
				const rows = await this.db.select().from(table).where(eq(table.id, id)).limit(1);
				return rows[0] ? toSession(rows[0]) : undefined;
			},
			delete: async (id) => {
				const rows = await this.db.delete(table).where(eq(table.id, id)).returning({ id: table.id });
				return rows.length;
			},
			deleteByUser: async (userId) => {
				const rows = await this.db
					.delete(table)
					.where(eq(table.userId, userId))
					.returning({ id: table.id });
				return rows.length;
			},
			deleteExpired: async (now) => {
				const rows = await this.db
					.delete(table)
					.where(lte(table.expiresAt, now))
					.returning({ id: table.id });
				return rows.length;
			}
		};
	}

	// ---------------------------------------------------------------------
	// system_config
	// ---------------------------------------------------------------------
	private createSystemConfigRepository(): SystemConfigRepository {
		const table = schema.systemConfig;
		return {
			all: async () => (await this.db.select().from(table)).map(toSystemConfig),
			upsert: async (input: NewSystemConfigRow) => {
				const { key, ...rest } = input;
				const rows = await this.db
					.insert(table)
					.values({ key, ...rest })
					.onConflictDoUpdate({ target: table.key, set: { ...rest } })
					.returning();
				return toSystemConfig(rows[0]);
			}
		};
	}

	// ---------------------------------------------------------------------
	// objectives
	// ---------------------------------------------------------------------
	private createObjectiveRepository(): ObjectiveRepository {
		const table = schema.objectives;
		return {
			create: async (input) => toObjective((await this.db.insert(table).values(input).returning())[0]),
			findById: async (id) => {
				const rows = await this.db.select().from(table).where(eq(table.id, id)).limit(1);
				return rows[0] ? toObjective(rows[0]) : undefined;
			},
			listByUser: async (userId) =>
				(await this.db.select().from(table).where(eq(table.userId, userId))).map(toObjective),
			listByUserWithKeyResults: async (userId) => {
				const rows = await this.db
					.select()
					.from(table)
					.innerJoin(schema.keyResults, eq(schema.keyResults.objectiveId, table.id))
					.where(eq(table.userId, userId));
				const grouped = new Map<string, ObjectiveWithKeyResults>();
				for (const r of rows) {
					const obj = toObjective(r.objectives);
					let entry = grouped.get(obj.id);
					if (!entry) {
						entry = { objective: obj, keyResults: [] };
						grouped.set(obj.id, entry);
					}
					entry.keyResults.push(toKeyResult(r.key_results));
				}
				return [...grouped.values()];
			},
			update: async (id, patch) => {
				const rows = await this.db.update(table).set(patch).where(eq(table.id, id)).returning();
				return rows[0] ? toObjective(rows[0]) : undefined;
			},
			upsert: async (input: NewObjectiveRow & { id: string }) => {
				const { id, ...rest } = input;
				const rows = await this.db
					.insert(table)
					.values({ id, ...rest })
					.onConflictDoUpdate({ target: table.id, set: { ...rest } })
					.returning();
				return toObjective(rows[0]);
			},
			remove: async (id) => {
				const rows = await this.db.delete(table).where(eq(table.id, id)).returning({ id: table.id });
				return rows.length;
			},
			count: async () => (await this.db.select({ c: count() }).from(table))[0]?.c ?? 0
		};
	}

	// ---------------------------------------------------------------------
	// key results
	// ---------------------------------------------------------------------
	private createKeyResultRepository(): KeyResultRepository {
		const table = schema.keyResults;
		return {
			create: async (input) => toKeyResult((await this.db.insert(table).values(input).returning())[0]),
			findById: async (id) => {
				const rows = await this.db.select().from(table).where(eq(table.id, id)).limit(1);
				return rows[0] ? toKeyResult(rows[0]) : undefined;
			},
			listByObjective: async (objectiveId) =>
				(
					await this.db
						.select()
						.from(table)
						.where(eq(table.objectiveId, objectiveId))
						.orderBy(asc(table.sortOrder))
				).map(toKeyResult),
			update: async (id, patch: KeyResultPatch) => {
				const rows = await this.db.update(table).set(patch).where(eq(table.id, id)).returning();
				return rows[0] ? toKeyResult(rows[0]) : undefined;
			},
			remove: async (id) => {
				const rows = await this.db.delete(table).where(eq(table.id, id)).returning({ id: table.id });
				return rows.length;
			}
		};
	}

	// ---------------------------------------------------------------------
	// objective_reflections
	// ---------------------------------------------------------------------
	private createObjectiveReflectionRepository(): ObjectiveReflectionRepository {
		const table = schema.objectiveReflections;
		return {
			create: async (input: NewObjectiveReflectionRow) =>
				toObjectiveReflection((await this.db.insert(table).values(input).returning())[0]),
			findByUserLevelYearMonth: async ({ userId, level, year, month }) => {
				const conditions = [eq(table.userId, userId), eq(table.level, level), eq(table.year, year)];
				if (month === null) {
					conditions.push(isNull(table.month));
				} else {
					conditions.push(eq(table.month, month));
				}
				const rows = await this.db.select().from(table).where(and(...conditions)).limit(1);
				return rows[0] ? toObjectiveReflection(rows[0]) : undefined;
			},
			update: async (id, patch) => {
				const rows = await this.db.update(table).set(patch).where(eq(table.id, id)).returning();
				return rows[0] ? toObjectiveReflection(rows[0]) : undefined;
			}
		};
	}

	// ---------------------------------------------------------------------
	// time periods
	// ---------------------------------------------------------------------
	private createTimePeriodRepository(): TimePeriodRepository {
		const table = schema.timePeriods;
		return {
			create: async (input) =>
				toTimePeriod((await this.db.insert(table).values(input).returning())[0]),
			findById: async (id) => {
				const rows = await this.db.select().from(table).where(eq(table.id, id)).limit(1);
				return rows[0] ? toTimePeriod(rows[0]) : undefined;
			},
			find: async (lookup) => {
				const conditions = [eq(table.userId, lookup.userId), eq(table.periodType, lookup.type)];
				if (lookup.year !== undefined) conditions.push(eq(table.year, lookup.year));
				if (lookup.month !== undefined) {
					conditions.push(lookup.month === null ? isNull(table.month) : eq(table.month, lookup.month));
				}
				if (lookup.week !== undefined) {
					conditions.push(lookup.week === null ? isNull(table.week) : eq(table.week, lookup.week));
				}
				if (lookup.day !== undefined) conditions.push(eq(table.day, lookup.day));
				const rows = await this.db.select().from(table).where(and(...conditions)).limit(1);
				return rows[0] ? toTimePeriod(rows[0]) : undefined;
			},
			listByUser: async (userId, filters) => {
				const conditions = [eq(table.userId, userId)];
				if (filters?.type) conditions.push(eq(table.periodType, filters.type));
				if (filters?.year !== undefined) conditions.push(eq(table.year, filters.year));
				if (filters?.month !== undefined) conditions.push(eq(table.month, filters.month));
				if (filters?.week !== undefined) conditions.push(eq(table.week, filters.week));
				const rows = await this.db
					.select()
					.from(table)
					.where(and(...conditions))
					.orderBy(desc(table.year), desc(table.month), desc(table.week));
				return rows.map(toTimePeriod);
			},
			update: async (id, patch: TimePeriodPatch) => {
				const rows = await this.db.update(table).set(patch).where(eq(table.id, id)).returning();
				return rows[0] ? toTimePeriod(rows[0]) : undefined;
			},
			count: async () => (await this.db.select({ c: count() }).from(table))[0]?.c ?? 0
		};
	}

	// ---------------------------------------------------------------------
	// tasks
	// ---------------------------------------------------------------------
	private createTaskRepository(): TaskRepository {
		const table = schema.tasks;
		return {
			create: async (input) => toTask((await this.db.insert(table).values(input).returning())[0]),
			findById: async (id) => {
				const rows = await this.db.select().from(table).where(eq(table.id, id)).limit(1);
				return rows[0] ? toTask(rows[0]) : undefined;
			},
			update: async (id, patch) => {
				const rows = await this.db.update(table).set(patch).where(eq(table.id, id)).returning();
				return rows[0] ? toTask(rows[0]) : undefined;
			},
			remove: async (id) => {
				const rows = await this.db.delete(table).where(eq(table.id, id)).returning({ id: table.id });
				return rows.length;
			},
			count: async () => (await this.db.select({ c: count() }).from(table))[0]?.c ?? 0,
			listByPeriod: async (timePeriodId) =>
				(
					await this.db
						.select()
						.from(table)
						.where(eq(table.timePeriodId, timePeriodId))
						.orderBy(asc(table.sortOrder))
				).map(toTask),
			listByUser: async (userId, filters) => {
				const conditions = [eq(table.userId, userId)];
				if (filters?.timePeriodId) conditions.push(eq(table.timePeriodId, filters.timePeriodId));
				if (filters?.completed !== undefined) conditions.push(eq(table.completed, filters.completed));
				const rows = await this.db
					.select()
					.from(table)
					.where(and(...conditions))
					.orderBy(asc(table.sortOrder));
				return rows.map(toTask);
			},
			startTimer: async (id, at) => {
				// Atomic: refuse if already running (WHERE timer_started_at IS NULL).
				const rows = await this.db
					.update(table)
					.set({ timerStartedAt: at, updatedAt: at })
					.where(and(eq(table.id, id), isNull(table.timerStartedAt)))
					.returning();
				return rows[0] ? toTask(rows[0]) : undefined;
			},
			stopTimer: async (id, at) => {
				// Atomic accumulation on a pinned transaction client: add the elapsed
				// milliseconds to the stored bigint without a read-modify-write race.
				const client: PoolClient = await this.pool.connect();
				try {
					await client.query('BEGIN');
					const res = await client.query<{
						id: string;
						time_spent_ms: string;
						timer_started_at: Date | null;
					}>(
						'SELECT id, time_spent_ms, timer_started_at FROM tasks WHERE id = $1 FOR UPDATE',
						[id]
					);
					const row = res.rows[0];
					if (!row || !row.timer_started_at) {
						await client.query('ROLLBACK');
						return undefined;
					}
					const elapsedMs = Math.max(0, at.getTime() - new Date(row.timer_started_at).getTime());
					const newTotal = Number(row.time_spent_ms) + elapsedMs;
					const updated = await client.query(
						'UPDATE tasks SET time_spent_ms = $1, timer_started_at = NULL, updated_at = $2 WHERE id = $3 RETURNING *',
						[newTotal, at, id]
					);
					await client.query('COMMIT');
					const t = updated.rows[0];
					return {
						id: t.id,
						userId: t.user_id,
						timePeriodId: t.time_period_id,
						title: t.title,
						completed: t.completed,
						completedAt: t.completed_at ? toSecondPrecision(t.completed_at) : null,
						sortOrder: t.sort_order,
						timeSpentMs: Number(t.time_spent_ms),
						timerStartedAt: null,
						createdAt: toSecondPrecision(t.created_at),
						updatedAt: toSecondPrecision(t.updated_at)
					};
				} catch (err) {
					try {
						await client.query('ROLLBACK');
					} catch {
						// connection lost
					}
					throw err;
				} finally {
					client.release();
				}
			}
		};
	}

	// ---------------------------------------------------------------------
	// task_attributes
	// ---------------------------------------------------------------------
	private createTaskAttributeRepository(): TaskAttributeRepository {
		const table = schema.taskAttributes;
		return {
			listByTask: async (taskId) =>
				(
					await this.db
						.select()
						.from(table)
						.where(eq(table.taskId, taskId))
						.orderBy(asc(table.key))
				).map(toTaskAttribute),
			listByTasks: async (taskIds) => {
				if (taskIds.length === 0) return new Map();
				const rows = await this.db
					.select()
					.from(table)
					.where(inArray(table.taskId, taskIds))
					.orderBy(asc(table.key));
				const map = new Map<string, TaskAttributeRow[]>();
				for (const id of taskIds) map.set(id, []);
				for (const row of rows) {
					map.get(row.taskId)?.push(toTaskAttribute(row));
				}
				return map;
			},
			upsertByTaskAndKey: async (input) => {
				const existing = await this.db
					.select()
					.from(table)
					.where(and(eq(table.taskId, input.taskId), eq(table.key, input.key)))
					.limit(1);
				if (existing[0]) {
					const rows = await this.db
						.update(table)
						.set({ value: input.value, valueType: input.valueType })
						.where(eq(table.id, existing[0].id))
						.returning();
					return toTaskAttribute(rows[0]);
				}
				return toTaskAttribute(
					(
						await this.db
							.insert(table)
							.values({
								id: crypto.randomUUID(),
								taskId: input.taskId,
								key: input.key,
								value: input.value,
								valueType: input.valueType
							})
							.returning()
					)[0]
				);
			},
			removeByTaskAndKey: async (taskId, key) => {
				const rows = await this.db
					.delete(table)
					.where(and(eq(table.taskId, taskId), eq(table.key, key)))
					.returning({ id: table.id });
				return rows.length;
			}
		};
	}

	// ---------------------------------------------------------------------
	// tags
	// ---------------------------------------------------------------------
	private createTagRepository(): TagRepository {
		const table = schema.tags;
		return {
			create: async (input: NewTagRow) => toTag((await this.db.insert(table).values(input).returning())[0]),
			findById: async (id) => {
				const rows = await this.db.select().from(table).where(eq(table.id, id)).limit(1);
				return rows[0] ? toTag(rows[0]) : undefined;
			},
			listByUser: async (userId) =>
				(
					await this.db
						.select()
						.from(table)
						.where(eq(table.userId, userId))
						.orderBy(asc(table.category), asc(table.name))
				).map(toTag),
			findByUserAndName: async (userId, name) => {
				const rows = await this.db
					.select()
					.from(table)
					.where(and(eq(table.userId, userId), eq(table.name, name)))
					.limit(1);
				return rows[0] ? toTag(rows[0]) : undefined;
			},
			update: async (id, patch) => {
				const rows = await this.db.update(table).set(patch).where(eq(table.id, id)).returning();
				return rows[0] ? toTag(rows[0]) : undefined;
			},
			remove: async (id) => {
				const rows = await this.db.delete(table).where(eq(table.id, id)).returning({ id: table.id });
				return rows.length;
			}
		};
	}

	// ---------------------------------------------------------------------
	// task_tags
	// ---------------------------------------------------------------------
	private createTaskTagRepository(): TaskTagRepository {
		const table = schema.taskTags;
		return {
			listByTask: async (taskId) =>
				(await this.db.select().from(table).where(eq(table.taskId, taskId))).map(toTaskTag),
			listByTasks: async (taskIds) => {
				if (taskIds.length === 0) return new Map();
				const rows = await this.db
					.select()
					.from(table)
					.where(inArray(table.taskId, taskIds));
				const map = new Map<string, TaskTagRow[]>();
				for (const id of taskIds) map.set(id, []);
				for (const row of rows) {
					map.get(row.taskId)?.push(toTaskTag(row));
				}
				return map;
			}
		};
	}

	// ---------------------------------------------------------------------
	// daily_metrics (fixed)
	// ---------------------------------------------------------------------
	private createDailyMetricsRepository(): DailyMetricsRepository {
		const table = schema.dailyMetrics;
		return {
			findByPeriod: async (userId, timePeriodId) => {
				const rows = await this.db
					.select()
					.from(table)
					.where(and(eq(table.timePeriodId, timePeriodId), eq(table.userId, userId)))
					.limit(1);
				return rows[0] ? toDailyMetrics(rows[0]) : undefined;
			},
			create: async (input: NewDailyMetricsRow) =>
				toDailyMetrics((await this.db.insert(table).values(input).returning())[0]),
			update: async (id, patch: DailyMetricsPatch) => {
				const rows = await this.db.update(table).set(patch).where(eq(table.id, id)).returning();
				return rows[0] ? toDailyMetrics(rows[0]) : undefined;
			}
		};
	}

	// ---------------------------------------------------------------------
	// metrics_templates
	// ---------------------------------------------------------------------
	private createMetricsTemplateRepository(): MetricsTemplateRepository {
		const table = schema.metricsTemplates;
		return {
			create: async (input: NewMetricsTemplateRow) =>
				toMetricsTemplate((await this.db.insert(table).values(input).returning())[0]),
			findById: async (id) => {
				const rows = await this.db.select().from(table).where(eq(table.id, id)).limit(1);
				return rows[0] ? toMetricsTemplate(rows[0]) : undefined;
			},
			listByUser: async (userId) =>
				(
					await this.db
						.select()
						.from(table)
						.where(eq(table.userId, userId))
						.orderBy(desc(table.effectiveFrom))
				).map(toMetricsTemplate),
			findActiveByDate: async (userId, date) => {
				const rows = await this.db
					.select()
					.from(table)
					.where(and(eq(table.userId, userId), lte(table.effectiveFrom, date)))
					.orderBy(desc(table.effectiveFrom))
					.limit(1);
				return rows[0] ? toMetricsTemplate(rows[0]) : undefined;
			},
			update: async (id, patch: MetricsTemplatePatch) => {
				const rows = await this.db.update(table).set(patch).where(eq(table.id, id)).returning();
				return rows[0] ? toMetricsTemplate(rows[0]) : undefined;
			},
			remove: async (id) => {
				const rows = await this.db.delete(table).where(eq(table.id, id)).returning({ id: table.id });
				return rows.length;
			}
		};
	}

	// ---------------------------------------------------------------------
	// daily_metric_values (flexible)
	// ---------------------------------------------------------------------
	private createDailyMetricValueRepository(): DailyMetricValueRepository {
		const table = schema.dailyMetricValues;
		return {
			listByUserAndDate: async (userId, date) =>
				(
					await this.db
						.select()
						.from(table)
						.where(and(eq(table.userId, userId), eq(table.date, date)))
				).map(toDailyMetricValue),
			listByUserAndDateAndNames: async (userId, date, metricNames) => {
				if (metricNames.length === 0) return [];
				return (
					await this.db
						.select()
						.from(table)
						.where(
							and(
								eq(table.userId, userId),
								eq(table.date, date),
								inArray(table.metricName, metricNames)
							)
						)
				).map(toDailyMetricValue);
			},
			findByUserDateName: async (userId, date, metricName) => {
				const rows = await this.db
					.select()
					.from(table)
					.where(
						and(
							eq(table.userId, userId),
							eq(table.date, date),
							eq(table.metricName, metricName)
						)
					)
					.limit(1);
				return rows[0] ? toDailyMetricValue(rows[0]) : undefined;
			},
			upsert: async (input: NewDailyMetricValueRow) => {
				// No unique index on (userId, date, metricName); emulate the original
				// find-then-update-or-insert behavior (matches the legacy SQLite path).
				const existing = await this.db
					.select()
					.from(table)
					.where(
						and(
							eq(table.userId, input.userId),
							eq(table.date, input.date),
							eq(table.metricName, input.metricName)
						)
					)
					.limit(1);
				if (existing[0]) {
					const rows = await this.db
						.update(table)
						.set({ value: input.value ?? null, source: input.source })
						.where(eq(table.id, existing[0].id))
						.returning();
					return toDailyMetricValue(rows[0]);
				}
				const created = await this.db.insert(table).values(input).returning();
				return toDailyMetricValue(created[0]);
			}
		};
	}

	// ---------------------------------------------------------------------
	// saved queries (WP07 / T025)
	// ---------------------------------------------------------------------
	private buildLogConditions(filters: {
		userId?: string;
		success?: boolean;
		from?: Date;
		to?: Date;
	}): SQL | undefined {
		const conds: SQL[] = [];
		if (filters.userId !== undefined) conds.push(eq(schema.queryExecutionLogs.userId, filters.userId));
		if (filters.success !== undefined)
			conds.push(eq(schema.queryExecutionLogs.success, filters.success));
		if (filters.from !== undefined)
			conds.push(gte(schema.queryExecutionLogs.createdAt, filters.from));
		if (filters.to !== undefined) conds.push(lte(schema.queryExecutionLogs.createdAt, filters.to));
		return conds.length > 0 ? and(...conds) : undefined;
	}

	private createSavedQueryRepository(): SavedQueryRepository {
		const table = schema.savedQueries;
		return {
			create: async (input) => toSavedQuery((await this.db.insert(table).values(input).returning())[0]),
			findById: async (id) => {
				const rows = await this.db.select().from(table).where(eq(table.id, id)).limit(1);
				return rows[0] ? toSavedQuery(rows[0]) : undefined;
			},
			findByIdForUser: async (id, userId) => {
				const rows = await this.db
					.select()
					.from(table)
					.where(and(eq(table.id, id), eq(table.userId, userId)))
					.limit(1);
				return rows[0] ? toSavedQuery(rows[0]) : undefined;
			},
			listByUser: async (userId, filters) => {
				const cond = filters?.queryType
					? and(eq(table.userId, userId), eq(table.queryType, filters.queryType))
					: eq(table.userId, userId);
				return (await this.db.select().from(table).where(cond)).map(toSavedQuery);
			},
			update: async (id, patch) => {
				const rows = await this.db.update(table).set(patch).where(eq(table.id, id)).returning();
				return rows[0] ? toSavedQuery(rows[0]) : undefined;
			},
			remove: async (id) => {
				const rows = await this.db.delete(table).where(eq(table.id, id)).returning({ id: table.id });
				return rows.length;
			}
		};
	}

	// ---------------------------------------------------------------------
	// dashboard widgets (WP07 / T025)
	// ---------------------------------------------------------------------
	private createDashboardWidgetRepository(): DashboardWidgetRepository {
		const table = schema.dashboardWidgets;
		return {
			create: async (input) =>
				toDashboardWidget((await this.db.insert(table).values(input).returning())[0]),
			findById: async (id) => {
				const rows = await this.db.select().from(table).where(eq(table.id, id)).limit(1);
				return rows[0] ? toDashboardWidget(rows[0]) : undefined;
			},
			findByIdForUser: async (id, userId) => {
				const rows = await this.db
					.select()
					.from(table)
					.where(and(eq(table.id, id), eq(table.userId, userId)))
					.limit(1);
				return rows[0] ? toDashboardWidget(rows[0]) : undefined;
			},
			listByUserAndPage: async (userId, page) =>
				(
					await this.db
						.select()
						.from(table)
						.where(and(eq(table.userId, userId), eq(table.page, page)))
						.orderBy(asc(table.sortOrder))
				).map(toDashboardWidget),
			update: async (id, patch) => {
				const rows = await this.db.update(table).set(patch).where(eq(table.id, id)).returning();
				return rows[0] ? toDashboardWidget(rows[0]) : undefined;
			},
			remove: async (id) => {
				const rows = await this.db.delete(table).where(eq(table.id, id)).returning({ id: table.id });
				return rows.length;
			}
		};
	}

	// ---------------------------------------------------------------------
	// plugins (WP07 / T026)
	// ---------------------------------------------------------------------
	private createPluginRepository(): PluginRepository {
		const table = schema.plugins;
		return {
			findByUserAndPlugin: async (userId, pluginId) => {
				const rows = await this.db
					.select()
					.from(table)
					.where(and(eq(table.userId, userId), eq(table.pluginId, pluginId)))
					.limit(1);
				return rows[0] ? toPlugin(rows[0]) : undefined;
			},
			listEnabled: async () => (await this.db.select().from(table).where(eq(table.enabled, true))).map(toPlugin),
			create: async (input) => toPlugin((await this.db.insert(table).values(input).returning())[0]),
			update: async (id, patch) => {
				const rows = await this.db.update(table).set(patch).where(eq(table.id, id)).returning();
				return rows[0] ? toPlugin(rows[0]) : undefined;
			},
			updateByUserAndPlugin: async (userId, pluginId, patch) => {
				const rows = await this.db
					.update(table)
					.set(patch)
					.where(and(eq(table.userId, userId), eq(table.pluginId, pluginId)))
					.returning();
				return rows[0] ? toPlugin(rows[0]) : undefined;
			}
		};
	}

	// ---------------------------------------------------------------------
	// user AI config (WP07 / T026)
	// ---------------------------------------------------------------------
	private createUserAiConfigRepository(): UserAiConfigRepository {
		const table = schema.userAiConfig;
		return {
			findByUser: async (userId) => {
				const rows = await this.db.select().from(table).where(eq(table.userId, userId)).limit(1);
				return rows[0] ? toUserAiConfig(rows[0]) : undefined;
			},
			upsert: async (input) => {
				const existing = await this.db
					.select()
					.from(table)
					.where(eq(table.userId, input.userId))
					.limit(1);
				if (existing[0]) {
					const rows = await this.db
						.update(table)
						.set({
							provider: input.provider ?? existing[0].provider,
							providersConfig:
								input.providersConfig !== undefined
									? input.providersConfig
									: existing[0].providersConfig,
							customSystemPrompt:
								input.customSystemPrompt !== undefined
									? input.customSystemPrompt
									: existing[0].customSystemPrompt,
							maxAgentRounds: input.maxAgentRounds ?? existing[0].maxAgentRounds,
							updatedAt: input.updatedAt ?? new Date()
						})
						.where(eq(table.id, existing[0].id))
						.returning();
					return toUserAiConfig(rows[0]);
				}
				return toUserAiConfig((await this.db.insert(table).values(input).returning())[0]);
			}
		};
	}

	// ---------------------------------------------------------------------
	// query execution logs (WP07 / T026)
	// ---------------------------------------------------------------------
	private createQueryExecutionLogRepository(): QueryExecutionLogRepository {
		const table = schema.queryExecutionLogs;
		return {
			create: async (input) =>
				toQueryExecutionLog((await this.db.insert(table).values(input).returning())[0]),
			listByUser: async (userId, limit = 50) =>
				(
					await this.db
						.select()
						.from(table)
						.where(eq(table.userId, userId))
						.orderBy(desc(table.createdAt))
						.limit(limit)
				).map(toQueryExecutionLog),
			list: async (filters, opts) => {
				const cond = this.buildLogConditions(filters);
				return (
					await this.db
						.select()
						.from(table)
						.where(cond)
						.orderBy(desc(table.createdAt))
						.limit(opts.limit)
						.offset(opts.offset)
				).map(toQueryExecutionLog);
			},
			count: async (filters) => {
				const cond = this.buildLogConditions(filters);
				return (await this.db.select({ c: count() }).from(table).where(cond))[0]?.c ?? 0;
			},
			listSince: async (since) =>
				(await this.db.select().from(table).where(gte(table.createdAt, since))).map(toQueryExecutionLog)
		};
	}

	// ---------------------------------------------------------------------
	// friend requests (WP07 / T025)
	// ---------------------------------------------------------------------
	private createFriendRequestRepository(): FriendRequestRepository {
		const table = schema.friendRequests;
		return {
			create: async (input) =>
				toFriendRequest((await this.db.insert(table).values(input).returning())[0]),
			findPendingBetween: async (a, b) => {
				const rows = await this.db
					.select()
					.from(table)
					.where(
						and(
							or(
								and(eq(table.fromUserId, a), eq(table.toUserId, b)),
								and(eq(table.fromUserId, b), eq(table.toUserId, a))
							),
							eq(table.status, 'pending')
						)
					)
					.limit(1);
				return rows[0] ? toFriendRequest(rows[0]) : undefined;
			},
			listIncomingPending: async (userId) =>
				(
					await this.db
						.select()
						.from(table)
						.where(and(eq(table.toUserId, userId), eq(table.status, 'pending')))
				).map(toFriendRequest),
			listOutgoingPending: async (userId) =>
				(
					await this.db
						.select()
						.from(table)
						.where(and(eq(table.fromUserId, userId), eq(table.status, 'pending')))
				).map(toFriendRequest),
			findPendingTo: async (id, toUserId) => {
				const rows = await this.db
					.select()
					.from(table)
					.where(and(eq(table.id, id), eq(table.toUserId, toUserId), eq(table.status, 'pending')))
					.limit(1);
				return rows[0] ? toFriendRequest(rows[0]) : undefined;
			},
			findPendingFrom: async (id, fromUserId) => {
				const rows = await this.db
					.select()
					.from(table)
					.where(
						and(eq(table.id, id), eq(table.fromUserId, fromUserId), eq(table.status, 'pending'))
					)
					.limit(1);
				return rows[0] ? toFriendRequest(rows[0]) : undefined;
			},
			update: async (id, patch) => {
				const rows = await this.db
					.update(table)
					.set({ status: patch.status, respondedAt: patch.respondedAt })
					.where(eq(table.id, id))
					.returning();
				return rows[0] ? toFriendRequest(rows[0]) : undefined;
			},
			remove: async (id) => {
				const rows = await this.db.delete(table).where(eq(table.id, id)).returning({ id: table.id });
				return rows.length;
			}
		};
	}

	// ---------------------------------------------------------------------
	// friendships (WP07 / T025)
	// ---------------------------------------------------------------------
	private createFriendshipRepository(): FriendshipRepository {
		const table = schema.friendships;
		return {
			create: async (input) =>
				toFriendship((await this.db.insert(table).values(input).returning())[0]),
			findBetween: async (a, b) => {
				const rows = await this.db
					.select()
					.from(table)
					.where(
						or(
							and(eq(table.userId1, a), eq(table.userId2, b)),
							and(eq(table.userId1, b), eq(table.userId2, a))
						)
					)
					.limit(1);
				return rows[0] ? toFriendship(rows[0]) : undefined;
			},
			listForUser: async (userId) =>
				(
					await this.db
						.select()
						.from(table)
						.where(or(eq(table.userId1, userId), eq(table.userId2, userId)))
				).map(toFriendship),
			remove: async (id) => {
				const rows = await this.db.delete(table).where(eq(table.id, id)).returning({ id: table.id });
				return rows.length;
			}
		};
	}

	// ---------------------------------------------------------------------
	// friend notes (WP07 / T025)
	// ---------------------------------------------------------------------
	private createFriendNoteRepository(): FriendNoteRepository {
		const table = schema.friendNotes;
		return {
			findByUserAndFriend: async (userId, friendId) => {
				const rows = await this.db
					.select()
					.from(table)
					.where(and(eq(table.userId, userId), eq(table.friendId, friendId)))
					.limit(1);
				return rows[0] ? toFriendNote(rows[0]) : undefined;
			},
			upsert: async (input) => {
				const existing = await this.db
					.select()
					.from(table)
					.where(and(eq(table.userId, input.userId), eq(table.friendId, input.friendId)))
					.limit(1);
				if (existing[0]) {
					const rows = await this.db
						.update(table)
						.set({ note: input.note ?? existing[0].note, updatedAt: input.updatedAt ?? new Date() })
						.where(eq(table.id, existing[0].id))
						.returning();
					return toFriendNote(rows[0]);
				}
				return toFriendNote((await this.db.insert(table).values(input).returning())[0]);
			},
			removeBetween: async (a, b) => {
				const rows = await this.db
					.delete(table)
					.where(
						or(
							and(eq(table.userId, a), eq(table.friendId, b)),
							and(eq(table.userId, b), eq(table.friendId, a))
						)
					)
					.returning({ id: table.id });
				return rows.length;
			}
		};
	}

	// ---------------------------------------------------------------------
	// backup export / restore (WP06 / FR-008)
	//
	// exportSnapshot reads the whole user scoped on a SINGLE pinned client in
	// REPEATABLE READ isolation (a consistent read snapshot). restore executes
	// the validated command plan on a single transaction client: deletes +
	// inserts + preference update either all commit or all roll back.
	// ---------------------------------------------------------------------
	private createBackupRepository(): BackupRepository {
		return {
			exportSnapshot: async (userId) => {
				const client: PoolClient = await this.pool.connect();
				try {
					await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
					const tx = drizzle(client, { schema });

					const userRows = await tx.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
					if (!userRows[0]) throw new Error(`User ${userId} not found for backup export`);

					const objectives = await tx
						.select()
						.from(schema.objectives)
						.where(eq(schema.objectives.userId, userId));
					const objectiveIds = objectives.map((o) => o.id);
					const keyResults =
						objectiveIds.length > 0
							? await tx
									.select()
									.from(schema.keyResults)
									.where(inArray(schema.keyResults.objectiveId, objectiveIds))
							: [];

					const timePeriods = await tx
						.select()
						.from(schema.timePeriods)
						.where(eq(schema.timePeriods.userId, userId));
					const timePeriodIds = timePeriods.map((tp) => tp.id);
					const tasks = await tx
						.select()
						.from(schema.tasks)
						.where(eq(schema.tasks.userId, userId));
					const taskIds = tasks.map((t) => t.id);
					const taskAttributes =
						taskIds.length > 0
							? await tx
									.select()
									.from(schema.taskAttributes)
									.where(inArray(schema.taskAttributes.taskId, taskIds))
							: [];
					const taskTags =
						taskIds.length > 0
							? await tx
									.select()
									.from(schema.taskTags)
									.where(inArray(schema.taskTags.taskId, taskIds))
							: [];
					const timeCommitments =
						timePeriodIds.length > 0
							? await tx
									.select()
									.from(schema.timeCommitments)
									.where(inArray(schema.timeCommitments.timePeriodId, timePeriodIds))
							: [];

					const values = await tx.select().from(schema.values).where(eq(schema.values.userId, userId));
					const principles = await tx
						.select()
						.from(schema.principles)
						.where(eq(schema.principles.userId, userId));
					const tags = await tx.select().from(schema.tags).where(eq(schema.tags.userId, userId));
					const savedQueries = await tx
						.select()
						.from(schema.savedQueries)
						.where(eq(schema.savedQueries.userId, userId));
					const dashboardWidgets = await tx
						.select()
						.from(schema.dashboardWidgets)
						.where(eq(schema.dashboardWidgets.userId, userId));
					const dailyMetrics = await tx
						.select()
						.from(schema.dailyMetrics)
						.where(eq(schema.dailyMetrics.userId, userId));
					const metricsTemplates = await tx
						.select()
						.from(schema.metricsTemplates)
						.where(eq(schema.metricsTemplates.userId, userId));
					const dailyMetricValues = await tx
						.select()
						.from(schema.dailyMetricValues)
						.where(eq(schema.dailyMetricValues.userId, userId));
					const objectiveReflections = await tx
						.select()
						.from(schema.objectiveReflections)
						.where(eq(schema.objectiveReflections.userId, userId));

					const snapshot: BackupSnapshot = {
						user: toUser(userRows[0]),
						values: values.map(toValue),
						principles: principles.map(toPrinciple),
						tags: tags.map(toTag),
						savedQueries: savedQueries.map(toSavedQuery),
						objectives: objectives.map(toObjective),
						keyResults: keyResults.map(toKeyResult),
						timePeriods: timePeriods.map(toTimePeriod),
						timeCommitments: timeCommitments.map(toTimeCommitment),
						tasks: tasks.map(toTask),
						taskAttributes: taskAttributes.map(toTaskAttribute),
						taskTags: taskTags.map(toTaskTag),
						dailyMetrics: dailyMetrics.map(toDailyMetrics),
						dashboardWidgets: dashboardWidgets.map(toDashboardWidget),
						metricsTemplates: metricsTemplates.map(toMetricsTemplate),
						dailyMetricValues: dailyMetricValues.map(toDailyMetricValue),
						objectiveReflections: objectiveReflections.map(toObjectiveReflection)
					};
					await client.query('COMMIT');
					return snapshot;
				} catch (err) {
					try {
						await client.query('ROLLBACK');
					} catch {
						// connection already lost
					}
					throw err;
				} finally {
					client.release();
				}
			},

			restore: async (plan) => {
				const client: PoolClient = await this.pool.connect();
				try {
					await client.query('BEGIN');
					const tx = drizzle(client, { schema });
					const uid = plan.userId;

					// STEP 1: delete all of the target user's data (children first).
					await tx
						.delete(schema.taskAttributes)
						.where(
							inArray(
								schema.taskAttributes.taskId,
								tx.select({ id: schema.tasks.id }).from(schema.tasks).where(eq(schema.tasks.userId, uid))
							)
						)
						.returning();
					await tx
						.delete(schema.taskTags)
						.where(
							inArray(
								schema.taskTags.taskId,
								tx.select({ id: schema.tasks.id }).from(schema.tasks).where(eq(schema.tasks.userId, uid))
							)
						)
						.returning();
					await tx
						.delete(schema.keyResults)
						.where(
							inArray(
								schema.keyResults.objectiveId,
								tx
									.select({ id: schema.objectives.id })
									.from(schema.objectives)
									.where(eq(schema.objectives.userId, uid))
							)
						)
						.returning();
					await tx.delete(schema.dailyMetrics).where(eq(schema.dailyMetrics.userId, uid)).returning();
					await tx
						.delete(schema.timeCommitments)
						.where(
							inArray(
								schema.timeCommitments.timePeriodId,
								tx
									.select({ id: schema.timePeriods.id })
									.from(schema.timePeriods)
									.where(eq(schema.timePeriods.userId, uid))
							)
						)
						.returning();
					await tx.delete(schema.tasks).where(eq(schema.tasks.userId, uid)).returning();
					await tx.delete(schema.timePeriods).where(eq(schema.timePeriods.userId, uid)).returning();
					await tx.delete(schema.objectives).where(eq(schema.objectives.userId, uid)).returning();
					await tx.delete(schema.principles).where(eq(schema.principles.userId, uid)).returning();
					await tx.delete(schema.values).where(eq(schema.values.userId, uid)).returning();
					await tx.delete(schema.tags).where(eq(schema.tags.userId, uid)).returning();
					await tx.delete(schema.savedQueries).where(eq(schema.savedQueries.userId, uid)).returning();
					await tx.delete(schema.dashboardWidgets).where(eq(schema.dashboardWidgets.userId, uid)).returning();
					await tx.delete(schema.metricsTemplates).where(eq(schema.metricsTemplates.userId, uid)).returning();
					await tx.delete(schema.dailyMetricValues).where(eq(schema.dailyMetricValues.userId, uid)).returning();
					await tx
						.delete(schema.objectiveReflections)
						.where(eq(schema.objectiveReflections.userId, uid))
						.returning();

					// STEP 2: insert from the validated, resolved plan.
					if (plan.tags.length > 0) {
						await tx.insert(schema.tags).values(plan.tags).returning();
					}
					for (const entry of plan.values) {
						await tx.insert(schema.values).values(entry.value).returning();
						if (entry.principles.length > 0) {
							await tx.insert(schema.principles).values(entry.principles).returning();
						}
					}
					if (plan.orphanPrinciples.length > 0) {
						await tx.insert(schema.principles).values(plan.orphanPrinciples).returning();
					}
					if (plan.savedQueries.length > 0) {
						await tx.insert(schema.savedQueries).values(plan.savedQueries).returning();
					}
					for (const entry of plan.objectives) {
						await tx.insert(schema.objectives).values(entry.objective).returning();
						if (entry.keyResults.length > 0) {
							await tx.insert(schema.keyResults).values(entry.keyResults).returning();
						}
					}
					for (const tp of plan.timePeriods) {
						await tx.insert(schema.timePeriods).values(tp.period).returning();
						if (tp.commitment) {
							await tx.insert(schema.timeCommitments).values(tp.commitment).returning();
						}
						if (tp.dailyMetrics) {
							await tx.insert(schema.dailyMetrics).values(tp.dailyMetrics).returning();
						}
						for (const task of tp.tasks) {
							await tx.insert(schema.tasks).values(task.task).returning();
							if (task.attributes.length > 0) {
								await tx.insert(schema.taskAttributes).values(task.attributes).returning();
							}
							for (const tagId of task.tagIds) {
								await tx.insert(schema.taskTags).values({ taskId: task.task.id, tagId }).returning();
							}
						}
					}
					if (plan.dashboardWidgets.length > 0) {
						await tx.insert(schema.dashboardWidgets).values(plan.dashboardWidgets).returning();
					}
					if (plan.metricsTemplates.length > 0) {
						await tx.insert(schema.metricsTemplates).values(plan.metricsTemplates).returning();
					}
					if (plan.dailyMetricValues.length > 0) {
						await tx.insert(schema.dailyMetricValues).values(plan.dailyMetricValues).returning();
					}
					if (plan.objectiveReflections.length > 0) {
						await tx.insert(schema.objectiveReflections).values(plan.objectiveReflections).returning();
					}

					// STEP 3: restore user preferences (shares the transaction).
					const prefs = plan.preferences;
					const userPatch: Partial<typeof schema.users.$inferInsert> = {};
					if (prefs.timezone !== undefined) userPatch.timezone = prefs.timezone;
					userPatch.weekStartDay = prefs.weekStartDay;
					userPatch.bgColor = prefs.bgColor;
					await tx.update(schema.users).set(userPatch).where(eq(schema.users.id, uid)).returning();

					await client.query('COMMIT');
					return plan.stats;
				} catch (err) {
					try {
						await client.query('ROLLBACK');
					} catch {
						// connection already lost
					}
					throw err;
				} finally {
					client.release();
				}
			}
		};
	}

	// ---------------------------------------------------------------------
	// bounded atomic operation (single pinned transaction client)
	// ---------------------------------------------------------------------
	async createUserWithInitialData(input: CreateUserWithInitialDataInput): Promise<UserRow> {
		const client: PoolClient = await this.pool.connect();
		try {
			await client.query('BEGIN');
			const tx = drizzle(client, { schema });
			const user = toUser((await tx.insert(schema.users).values(input.user).returning())[0]);
			for (const entry of input.objectives) {
				await tx.insert(schema.objectives).values(entry.objective).returning();
				for (const kr of entry.keyResults) {
					await tx.insert(schema.keyResults).values(kr).returning();
				}
			}
			await client.query('COMMIT');
			return user;
		} catch (err) {
			try {
				await client.query('ROLLBACK');
			} catch {
				// connection already lost; nothing further to roll back
			}
			throw err;
		} finally {
			client.release();
		}
	}

	async createTaskWithDetails(input: CreateTaskInput): Promise<TaskRow> {
		const client: PoolClient = await this.pool.connect();
		try {
			await client.query('BEGIN');
			const tx = drizzle(client, { schema });
			const task = toTask((await tx.insert(schema.tasks).values(input.task).returning())[0]);
			const attrs = attributeRowsFor(task.id, (input.attributes ?? {}) as Record<string, unknown>);
			if (attrs.length > 0) {
				await tx.insert(schema.taskAttributes).values(attrs).returning();
			}
			for (const tagId of input.tagIds ?? []) {
				await tx.insert(schema.taskTags).values({ taskId: task.id, tagId }).returning();
			}
			await client.query('COMMIT');
			return task;
		} catch (err) {
			try {
				await client.query('ROLLBACK');
			} catch {
				// ignore
			}
			throw err;
		} finally {
			client.release();
		}
	}

	async updateTaskWithDetails(input: UpdateTaskInput): Promise<TaskRow | undefined> {
		const client: PoolClient = await this.pool.connect();
		try {
			await client.query('BEGIN');
			const tx = drizzle(client, { schema });
			const existing = await tx.select().from(schema.tasks).where(eq(schema.tasks.id, input.id)).limit(1);
			if (!existing[0]) {
				await client.query('ROLLBACK');
				return undefined;
			}
			const updated = toTask(
				(await tx.update(schema.tasks).set(input.patch).where(eq(schema.tasks.id, input.id)).returning())[0]
			);
			if (input.attributes !== undefined) {
				await tx
					.delete(schema.taskAttributes)
					.where(eq(schema.taskAttributes.taskId, input.id))
					.returning();
				const attrs = attributeRowsFor(input.id, input.attributes as Record<string, unknown>);
				if (attrs.length > 0) {
					await tx.insert(schema.taskAttributes).values(attrs).returning();
				}
			}
			if (input.tagIds !== undefined) {
				await tx.delete(schema.taskTags).where(eq(schema.taskTags.taskId, input.id)).returning();
				for (const tagId of input.tagIds) {
					await tx.insert(schema.taskTags).values({ taskId: input.id, tagId }).returning();
				}
			}
			await client.query('COMMIT');
			return updated;
		} catch (err) {
			try {
				await client.query('ROLLBACK');
			} catch {
				// ignore
			}
			throw err;
		} finally {
			client.release();
		}
	}
}

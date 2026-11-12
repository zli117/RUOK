/**
 * Worker-private synchronous SQLite engine (WP10 / U1 / D-07).
 *
 * This module holds the real better-sqlite3 + drizzle-orm/better-sqlite3
 * implementation. It is imported ONLY by the worker thread (`sqlite-worker.ts`)
 * and the preparation worker — never by the HTTP bundle. It is deliberately
 * *not* exported from `src/lib/db/index.ts` and is not part of the public
 * surface. The public {@link SqliteDatabaseServices} facade in
 * `sqlite-worker-client.ts` forwards every command here over structured clone.
 *
 * Only dialect query/transaction code lives here; canonical
 * ownership/validation lives in the shared models/contracts. Lifecycle (T007):
 * lazy factory — the constructor performs no filesystem I/O; `open()` creates
 * the connection, applies validated pragmas and builds repositories.
 *
 * IMPORTANT: better-sqlite3 transactions are synchronous. Never `await` inside
 * a `db.transaction(...)` callback.
 */
import Database from 'better-sqlite3';
import { REPO_METHODS, SERVICE_METHODS } from './sqlite-worker-protocol';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { and, asc, count, desc, eq, gte, inArray, isNull, lte, or, type SQL } from 'drizzle-orm';
import * as schema from '../schema/sqlite';
import { buildSqlitePragmas } from '../config';
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
	QueryExecutionLogRepository,
	SavedQueryRepository,
	SessionRepository,
	SqliteConfig,
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
	ObjectivePatch,
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
	UserPatch,
	UserRow,
	UserAiConfigRow,
	ValueRow
} from '../models';
import type { BackupSnapshot, RestoreCommandPlan, RestoreStats } from '../backup/types';

type SqliteUser = typeof schema.users.$inferSelect;
type SqliteSession = typeof schema.sessions.$inferSelect;
type SqliteSystemConfig = typeof schema.systemConfig.$inferSelect;
type SqliteObjective = typeof schema.objectives.$inferSelect;
type SqliteKeyResult = typeof schema.keyResults.$inferSelect;
type SqliteObjectiveReflection = typeof schema.objectiveReflections.$inferSelect;
type SqliteTask = typeof schema.tasks.$inferSelect;
type SqliteTimePeriod = typeof schema.timePeriods.$inferSelect;
type SqliteTaskAttribute = typeof schema.taskAttributes.$inferSelect;
type SqliteTag = typeof schema.tags.$inferSelect;
type SqliteTaskTag = typeof schema.taskTags.$inferSelect;
type SqliteDailyMetrics = typeof schema.dailyMetrics.$inferSelect;
type SqliteMetricsTemplate = typeof schema.metricsTemplates.$inferSelect;
type SqliteDailyMetricValue = typeof schema.dailyMetricValues.$inferSelect;
type SqliteValue = typeof schema.values.$inferSelect;
type SqlitePrinciple = typeof schema.principles.$inferSelect;
type SqliteSavedQuery = typeof schema.savedQueries.$inferSelect;
type SqliteDashboardWidget = typeof schema.dashboardWidgets.$inferSelect;
type SqliteTimeCommitment = typeof schema.timeCommitments.$inferSelect;
type SqlitePlugin = typeof schema.plugins.$inferSelect;
type SqliteUserAiConfig = typeof schema.userAiConfig.$inferSelect;
type SqliteQueryExecutionLog = typeof schema.queryExecutionLogs.$inferSelect;
type SqliteFriendRequest = typeof schema.friendRequests.$inferSelect;
type SqliteFriendship = typeof schema.friendships.$inferSelect;
type SqliteFriendNote = typeof schema.friendNotes.$inferSelect;

function toUser(row: SqliteUser): UserRow {
	return {
		id: row.id,
		username: row.username,
		passwordHash: row.passwordHash,
		weekStartDay: row.weekStartDay,
		timezone: row.timezone,
		bgColor: row.bgColor,
		isAdmin: row.isAdmin,
		isDisabled: row.isDisabled,
		createdAt: row.createdAt
	};
}

function toSession(row: SqliteSession): SessionRow {
	return {
		id: row.id,
		userId: row.userId,
		expiresAt: row.expiresAt
	};
}

function toSystemConfig(row: SqliteSystemConfig): SystemConfigRow {
	return {
		key: row.key,
		value: row.value,
		isSecret: row.isSecret,
		updatedAt: row.updatedAt
	};
}

function toObjective(row: SqliteObjective): ObjectiveRow {
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
		createdAt: row.createdAt,
		updatedAt: row.updatedAt
	};
}

function toKeyResult(row: SqliteKeyResult): KeyResultRow {
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
		createdAt: row.createdAt,
		updatedAt: row.updatedAt
	};
}

function toObjectiveReflection(row: SqliteObjectiveReflection): ObjectiveReflectionRow {
	return {
		id: row.id,
		userId: row.userId,
		level: row.level,
		year: row.year,
		month: row.month,
		reflection: row.reflection,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt
	};
}

function toTask(row: SqliteTask): TaskRow {
	return {
		id: row.id,
		userId: row.userId,
		timePeriodId: row.timePeriodId,
		title: row.title,
		completed: row.completed,
		completedAt: row.completedAt,
		sortOrder: row.sortOrder,
		timeSpentMs: row.timeSpentMs,
		timerStartedAt: row.timerStartedAt,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt
	};
}

function toTimePeriod(row: SqliteTimePeriod): TimePeriodRow {
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
		createdAt: row.createdAt,
		updatedAt: row.updatedAt
	};
}

function toTaskAttribute(row: SqliteTaskAttribute): TaskAttributeRow {
	return {
		id: row.id,
		taskId: row.taskId,
		key: row.key,
		value: row.value,
		valueType: row.valueType
	};
}

function toTag(row: SqliteTag): TagRow {
	return {
		id: row.id,
		userId: row.userId,
		name: row.name,
		color: row.color,
		category: row.category
	};
}

function toTaskTag(row: SqliteTaskTag): TaskTagRow {
	return {
		taskId: row.taskId,
		tagId: row.tagId
	};
}

function toDailyMetrics(row: SqliteDailyMetrics): DailyMetricsRow {
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

function toMetricsTemplate(row: SqliteMetricsTemplate): MetricsTemplateRow {
	return {
		id: row.id,
		userId: row.userId,
		name: row.name,
		effectiveFrom: row.effectiveFrom,
		metricsDefinition: row.metricsDefinition,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt
	};
}

function toDailyMetricValue(row: SqliteDailyMetricValue): DailyMetricValueRow {
	return {
		id: row.id,
		userId: row.userId,
		date: row.date,
		metricName: row.metricName,
		value: row.value,
		source: row.source
	};
}

function toValue(row: SqliteValue): ValueRow {
	return {
		id: row.id,
		userId: row.userId,
		title: row.title,
		rank: row.rank,
		description: row.description,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt
	};
}

function toPrinciple(row: SqlitePrinciple): PrincipleRow {
	return {
		id: row.id,
		userId: row.userId,
		valueId: row.valueId,
		title: row.title,
		description: row.description,
		examples: row.examples,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt
	};
}

function toSavedQuery(row: SqliteSavedQuery): SavedQueryRow {
	return {
		id: row.id,
		userId: row.userId,
		name: row.name,
		description: row.description,
		queryType: row.queryType,
		code: row.code,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt
	};
}

function toDashboardWidget(row: SqliteDashboardWidget): DashboardWidgetRow {
	return {
		id: row.id,
		userId: row.userId,
		title: row.title,
		widgetType: row.widgetType,
		config: row.config,
		sortOrder: row.sortOrder,
		page: row.page,
		createdAt: row.createdAt
	};
}

function toTimeCommitment(row: SqliteTimeCommitment): TimeCommitmentRow {
	return {
		timePeriodId: row.timePeriodId,
		numberOfWeeks: row.numberOfWeeks,
		availableHoursPerWeekday: row.availableHoursPerWeekday,
		availableHoursPerWeekend: row.availableHoursPerWeekend
	};
}

function toPlugin(row: SqlitePlugin): PluginRow {
	return {
		id: row.id,
		userId: row.userId,
		pluginId: row.pluginId,
		enabled: row.enabled,
		config: row.config,
		lastSync: row.lastSync,
		createdAt: row.createdAt
	};
}

function toUserAiConfig(row: SqliteUserAiConfig): UserAiConfigRow {
	return {
		id: row.id,
		userId: row.userId,
		provider: row.provider,
		providersConfig: row.providersConfig,
		customSystemPrompt: row.customSystemPrompt,
		maxAgentRounds: row.maxAgentRounds,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt
	};
}

function toQueryExecutionLog(row: SqliteQueryExecutionLog): QueryExecutionLogRow {
	return {
		id: row.id,
		userId: row.userId,
		codeSnippet: row.codeSnippet,
		success: row.success,
		errorMessage: row.errorMessage,
		executionTimeMs: row.executionTimeMs,
		createdAt: row.createdAt
	};
}

function toFriendRequest(row: SqliteFriendRequest): FriendRequestRow {
	return {
		id: row.id,
		fromUserId: row.fromUserId,
		toUserId: row.toUserId,
		status: row.status,
		createdAt: row.createdAt,
		respondedAt: row.respondedAt
	};
}

function toFriendship(row: SqliteFriendship): FriendshipRow {
	return {
		id: row.id,
		userId1: row.userId1,
		userId2: row.userId2,
		createdAt: row.createdAt
	};
}

function toFriendNote(row: SqliteFriendNote): FriendNoteRow {
	return {
		id: row.id,
		userId: row.userId,
		friendId: row.friendId,
		note: row.note,
		updatedAt: row.updatedAt
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

export class SqliteLocalServices implements DatabaseServices {
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

	private sqlite?: Database.Database;
	private db!: BetterSQLite3Database<typeof schema>;
	private _open = false;

	constructor(private readonly config: SqliteConfig) {
		// Lazy: no filesystem I/O until open().
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

	async open(): Promise<void> {
		if (this._open) return;
		const sqlite = new Database(this.config.path);
		for (const pragma of buildSqlitePragmas(this.config)) {
			sqlite.pragma(pragma);
		}
		this.sqlite = sqlite;
		this.db = drizzle(sqlite, { schema });
		this._open = true;
	}

	isOpen(): boolean {
		return this._open;
	}

	async close(): Promise<void> {
		if (!this.sqlite?.open) return;
		this.sqlite.close();
		this._open = false;
	}

	// ---------------------------------------------------------------------
	// users
	// ---------------------------------------------------------------------
	private createUserRepository(): UserRepository {
		const table = schema.users;
		return {
			create: (input) => {
				const row = this.db.insert(table).values(input).returning().get();
				return Promise.resolve(toUser(row));
			},
			findById: (id) => {
				const row = this.db.select().from(table).where(eq(table.id, id)).get();
				return Promise.resolve(row ? toUser(row) : undefined);
			},
			findByUsername: (username) => {
				const row = this.db.select().from(table).where(eq(table.username, username)).get();
				return Promise.resolve(row ? toUser(row) : undefined);
			},
			list: () => Promise.resolve(this.db.select().from(table).all().map(toUser)),
			update: (id, patch) => {
				const row = this.db.update(table).set(patch).where(eq(table.id, id)).returning().get();
				return Promise.resolve(row ? toUser(row) : undefined);
			},
			remove: (id) => {
				const res = this.db.delete(table).where(eq(table.id, id)).run();
				return Promise.resolve(res.changes);
			},
			count: () => {
				const row = this.db.select({ c: count() }).from(table).get();
				return Promise.resolve(row?.c ?? 0);
			}
		};
	}

	// ---------------------------------------------------------------------
	// sessions
	// ---------------------------------------------------------------------
	private createSessionRepository(): SessionRepository {
		const table = schema.sessions;
		return {
			create: (input) => {
				const row = this.db.insert(table).values(input).returning().get();
				return Promise.resolve(toSession(row));
			},
			findById: (id) => {
				const row = this.db.select().from(table).where(eq(table.id, id)).get();
				return Promise.resolve(row ? toSession(row) : undefined);
			},
			delete: (id) => {
				const res = this.db.delete(table).where(eq(table.id, id)).run();
				return Promise.resolve(res.changes);
			},
			deleteByUser: (userId) => {
				const res = this.db.delete(table).where(eq(table.userId, userId)).run();
				return Promise.resolve(res.changes);
			},
			deleteExpired: (now) => {
				const res = this.db.delete(table).where(lte(table.expiresAt, now)).run();
				return Promise.resolve(res.changes);
			}
		};
	}

	// ---------------------------------------------------------------------
	// system_config
	// ---------------------------------------------------------------------
	private createSystemConfigRepository(): SystemConfigRepository {
		const table = schema.systemConfig;
		return {
			all: () => Promise.resolve(this.db.select().from(table).all().map(toSystemConfig)),
			upsert: (input) => {
				const { key, ...rest } = input;
				const row = this.db
					.insert(table)
					.values({ key, ...rest })
					.onConflictDoUpdate({
						target: table.key,
						set: { ...rest }
					})
					.returning()
					.get();
				return Promise.resolve(toSystemConfig(row));
			}
		};
	}

	// ---------------------------------------------------------------------
	// objectives
	// ---------------------------------------------------------------------
	private createObjectiveRepository(): ObjectiveRepository {
		const table = schema.objectives;
		return {
			create: (input) => {
				const row = this.db.insert(table).values(input).returning().get();
				return Promise.resolve(toObjective(row));
			},
			findById: (id) => {
				const row = this.db.select().from(table).where(eq(table.id, id)).get();
				return Promise.resolve(row ? toObjective(row) : undefined);
			},
			listByUser: (userId) =>
				Promise.resolve(this.db.select().from(table).where(eq(table.userId, userId)).all().map(toObjective)),
			listByUserWithKeyResults: (userId) => {
				const rows = this.db
					.select()
					.from(table)
					.innerJoin(schema.keyResults, eq(schema.keyResults.objectiveId, table.id))
					.where(eq(table.userId, userId))
					.all();
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
				return Promise.resolve([...grouped.values()]);
			},
			update: (id, patch) => {
				const row = this.db.update(table).set(patch).where(eq(table.id, id)).returning().get();
				return Promise.resolve(row ? toObjective(row) : undefined);
			},
			upsert: (input) => {
				const { id, ...rest } = input;
				const row = this.db
					.insert(table)
					.values({ id, ...rest })
					.onConflictDoUpdate({
						target: table.id,
						set: { ...rest }
					})
					.returning()
					.get();
				return Promise.resolve(toObjective(row));
			},
			remove: (id) => {
				const res = this.db.delete(table).where(eq(table.id, id)).run();
				return Promise.resolve(res.changes);
			},
			count: () => {
				const row = this.db.select({ c: count() }).from(table).get();
				return Promise.resolve(row?.c ?? 0);
			}
		};
	}

	// ---------------------------------------------------------------------
	// key results
	// ---------------------------------------------------------------------
	private createKeyResultRepository(): KeyResultRepository {
		const table = schema.keyResults;
		return {
			create: (input) => {
				const row = this.db.insert(table).values(input).returning().get();
				return Promise.resolve(toKeyResult(row));
			},
			findById: (id) => {
				const row = this.db.select().from(table).where(eq(table.id, id)).get();
				return Promise.resolve(row ? toKeyResult(row) : undefined);
			},
			listByObjective: (objectiveId) =>
				Promise.resolve(
					this.db
						.select()
						.from(table)
						.where(eq(table.objectiveId, objectiveId))
						.orderBy(asc(table.sortOrder))
						.all()
						.map(toKeyResult)
				),
			update: (id, patch: KeyResultPatch) => {
				const row = this.db.update(table).set(patch).where(eq(table.id, id)).returning().get();
				return Promise.resolve(row ? toKeyResult(row) : undefined);
			},
			remove: (id) => {
				const res = this.db.delete(table).where(eq(table.id, id)).run();
				return Promise.resolve(res.changes);
			}
		};
	}

	// ---------------------------------------------------------------------
	// objective_reflections
	// ---------------------------------------------------------------------
	private createObjectiveReflectionRepository(): ObjectiveReflectionRepository {
		const table = schema.objectiveReflections;
		return {
			create: (input: NewObjectiveReflectionRow) => {
				const row = this.db.insert(table).values(input).returning().get();
				return Promise.resolve(toObjectiveReflection(row));
			},
			findByUserLevelYearMonth: ({ userId, level, year, month }) => {
				const conditions = [eq(table.userId, userId), eq(table.level, level), eq(table.year, year)];
				if (month === null) {
					conditions.push(isNull(table.month));
				} else {
					conditions.push(eq(table.month, month));
				}
				const row = this.db.select().from(table).where(and(...conditions)).get();
				return Promise.resolve(row ? toObjectiveReflection(row) : undefined);
			},
			update: (id, patch) => {
				const row = this.db.update(table).set(patch).where(eq(table.id, id)).returning().get();
				return Promise.resolve(row ? toObjectiveReflection(row) : undefined);
			}
		};
	}

	// ---------------------------------------------------------------------
	// time periods
	// ---------------------------------------------------------------------
	private createTimePeriodRepository(): TimePeriodRepository {
		const table = schema.timePeriods;
		return {
			create: (input) => {
				const row = this.db.insert(table).values(input).returning().get();
				return Promise.resolve(toTimePeriod(row));
			},
			findById: (id) => {
				const row = this.db.select().from(table).where(eq(table.id, id)).get();
				return Promise.resolve(row ? toTimePeriod(row) : undefined);
			},
			find: (lookup) => {
				const conditions = [eq(table.userId, lookup.userId), eq(table.periodType, lookup.type)];
				if (lookup.year !== undefined) conditions.push(eq(table.year, lookup.year));
				if (lookup.month !== undefined) {
					conditions.push(lookup.month === null ? isNull(table.month) : eq(table.month, lookup.month));
				}
				if (lookup.week !== undefined) {
					conditions.push(lookup.week === null ? isNull(table.week) : eq(table.week, lookup.week));
				}
				if (lookup.day !== undefined) conditions.push(eq(table.day, lookup.day));
				const row = this.db.select().from(table).where(and(...conditions)).get();
				return Promise.resolve(row ? toTimePeriod(row) : undefined);
			},
			listByUser: (userId, filters) => {
				const conditions = [eq(table.userId, userId)];
				if (filters?.type) conditions.push(eq(table.periodType, filters.type));
				if (filters?.year !== undefined) conditions.push(eq(table.year, filters.year));
				if (filters?.month !== undefined) conditions.push(eq(table.month, filters.month));
				if (filters?.week !== undefined) conditions.push(eq(table.week, filters.week));
				return Promise.resolve(
					this.db
						.select()
						.from(table)
						.where(and(...conditions))
						.orderBy(desc(table.year), desc(table.month), desc(table.week))
						.all()
						.map(toTimePeriod)
				);
			},
			update: (id, patch: TimePeriodPatch) => {
				const row = this.db.update(table).set(patch).where(eq(table.id, id)).returning().get();
				return Promise.resolve(row ? toTimePeriod(row) : undefined);
			},
			count: () => {
				const row = this.db.select({ c: count() }).from(table).get();
				return Promise.resolve(row?.c ?? 0);
			}
		};
	}

	// ---------------------------------------------------------------------
	// tasks
	// ---------------------------------------------------------------------
	private createTaskRepository(): TaskRepository {
		const table = schema.tasks;
		return {
			create: (input) => {
				const row = this.db.insert(table).values(input).returning().get();
				return Promise.resolve(toTask(row));
			},
			findById: (id) => {
				const row = this.db.select().from(table).where(eq(table.id, id)).get();
				return Promise.resolve(row ? toTask(row) : undefined);
			},
			update: (id, patch) => {
				const row = this.db.update(table).set(patch).where(eq(table.id, id)).returning().get();
				return Promise.resolve(row ? toTask(row) : undefined);
			},
			remove: (id) => {
				const res = this.db.delete(table).where(eq(table.id, id)).run();
				return Promise.resolve(res.changes);
			},
			count: () => {
				const row = this.db.select({ c: count() }).from(table).get();
				return Promise.resolve(row?.c ?? 0);
			},
			listByPeriod: (timePeriodId) =>
				Promise.resolve(
					this.db
						.select()
						.from(table)
						.where(eq(table.timePeriodId, timePeriodId))
						.orderBy(asc(table.sortOrder))
						.all()
						.map(toTask)
				),
			listByUser: (userId, filters) => {
				const conditions = [eq(table.userId, userId)];
				if (filters?.timePeriodId) conditions.push(eq(table.timePeriodId, filters.timePeriodId));
				if (filters?.completed !== undefined) conditions.push(eq(table.completed, filters.completed));
				return Promise.resolve(
					this.db
						.select()
						.from(table)
						.where(and(...conditions))
						.orderBy(asc(table.sortOrder))
						.all()
						.map(toTask)
				);
			},
			startTimer: (id, at) => {
				// Atomic: refuse if already running; set the start instant.
				const row = this.db
					.update(table)
					.set({ timerStartedAt: at, updatedAt: at })
					.where(and(eq(table.id, id), isNull(table.timerStartedAt)))
					.returning()
					.get();
				return Promise.resolve(row ? toTask(row) : undefined);
			},
			stopTimer: (id, at) => {
				// Atomic within a single better-sqlite3 transaction: read the current
				// row, accumulate elapsed milliseconds, clear the start instant.
				const result = this.db.transaction(() => {
					const current = this.db
						.select()
						.from(table)
						.where(eq(table.id, id))
						.get();
					if (!current || !current.timerStartedAt) return undefined;
					const elapsedMs = Math.max(0, at.getTime() - current.timerStartedAt.getTime());
					const newTotal = (current.timeSpentMs || 0) + elapsedMs;
					const updated = this.db
						.update(table)
						.set({ timeSpentMs: newTotal, timerStartedAt: null, updatedAt: at })
						.where(eq(table.id, id))
						.returning()
						.get();
					return updated ? toTask(updated) : undefined;
				});
				return Promise.resolve(result);
			}
		};
	}

	// ---------------------------------------------------------------------
	// task_attributes
	// ---------------------------------------------------------------------
	private createTaskAttributeRepository(): TaskAttributeRepository {
		const table = schema.taskAttributes;
		return {
			listByTask: (taskId) =>
				Promise.resolve(
					this.db
						.select()
						.from(table)
						.where(eq(table.taskId, taskId))
						.orderBy(asc(table.key))
						.all()
						.map(toTaskAttribute)
				),
			listByTasks: (taskIds) => {
				if (taskIds.length === 0) return Promise.resolve(new Map());
				const rows = this.db
					.select()
					.from(table)
					.where(inArray(table.taskId, taskIds))
					.orderBy(asc(table.key))
					.all()
					.map(toTaskAttribute);
				const map = new Map<string, TaskAttributeRow[]>();
				for (const id of taskIds) map.set(id, []);
				for (const row of rows) {
					map.get(row.taskId)?.push(row);
				}
				return Promise.resolve(map);
			},
			upsertByTaskAndKey: (input) => {
				const existing = this.db
					.select()
					.from(table)
					.where(and(eq(table.taskId, input.taskId), eq(table.key, input.key)))
					.get();
				const row = existing
					? this.db
							.update(table)
							.set({ value: input.value, valueType: input.valueType })
							.where(eq(table.id, existing.id))
							.returning()
							.get()
					: this.db
							.insert(table)
							.values({
								id: crypto.randomUUID(),
								taskId: input.taskId,
								key: input.key,
								value: input.value,
								valueType: input.valueType
							})
							.returning()
							.get();
				return Promise.resolve(toTaskAttribute(row));
			},
			removeByTaskAndKey: (taskId, key) => {
				const res = this.db
					.delete(table)
					.where(and(eq(table.taskId, taskId), eq(table.key, key)))
					.run();
				return Promise.resolve(res.changes);
			}
		};
	}

	// ---------------------------------------------------------------------
	// tags
	// ---------------------------------------------------------------------
	private createTagRepository(): TagRepository {
		const table = schema.tags;
		return {
			create: (input: NewTagRow) => {
				const row = this.db.insert(table).values(input).returning().get();
				return Promise.resolve(toTag(row));
			},
			findById: (id) => {
				const row = this.db.select().from(table).where(eq(table.id, id)).get();
				return Promise.resolve(row ? toTag(row) : undefined);
			},
			listByUser: (userId) =>
				Promise.resolve(
					this.db
						.select()
						.from(table)
						.where(eq(table.userId, userId))
						.orderBy(asc(table.category), asc(table.name))
						.all()
						.map(toTag)
				),
			findByUserAndName: (userId, name) => {
				const row = this.db
					.select()
					.from(table)
					.where(and(eq(table.userId, userId), eq(table.name, name)))
					.get();
				return Promise.resolve(row ? toTag(row) : undefined);
			},
			update: (id, patch) => {
				const row = this.db.update(table).set(patch).where(eq(table.id, id)).returning().get();
				return Promise.resolve(row ? toTag(row) : undefined);
			},
			remove: (id) => {
				const res = this.db.delete(table).where(eq(table.id, id)).run();
				return Promise.resolve(res.changes);
			}
		};
	}

	// ---------------------------------------------------------------------
	// task_tags
	// ---------------------------------------------------------------------
	private createTaskTagRepository(): TaskTagRepository {
		const table = schema.taskTags;
		return {
			listByTask: (taskId) =>
				Promise.resolve(
					this.db.select().from(table).where(eq(table.taskId, taskId)).all().map(toTaskTag)
				),
			listByTasks: (taskIds) => {
				if (taskIds.length === 0) return Promise.resolve(new Map());
				const rows = this.db
					.select()
					.from(table)
					.where(inArray(table.taskId, taskIds))
					.all()
					.map(toTaskTag);
				const map = new Map<string, TaskTagRow[]>();
				for (const id of taskIds) map.set(id, []);
				for (const row of rows) {
					map.get(row.taskId)?.push(row);
				}
				return Promise.resolve(map);
			}
		};
	}

	// ---------------------------------------------------------------------
	// daily_metrics (fixed)
	// ---------------------------------------------------------------------
	private createDailyMetricsRepository(): DailyMetricsRepository {
		const table = schema.dailyMetrics;
		return {
			findByPeriod: (userId, timePeriodId) => {
				const row = this.db
					.select()
					.from(table)
					.where(and(eq(table.timePeriodId, timePeriodId), eq(table.userId, userId)))
					.get();
				return Promise.resolve(row ? toDailyMetrics(row) : undefined);
			},
			create: (input: NewDailyMetricsRow) => {
				const row = this.db.insert(table).values(input).returning().get();
				return Promise.resolve(toDailyMetrics(row));
			},
			update: (id, patch: DailyMetricsPatch) => {
				const row = this.db.update(table).set(patch).where(eq(table.id, id)).returning().get();
				return Promise.resolve(row ? toDailyMetrics(row) : undefined);
			}
		};
	}

	// ---------------------------------------------------------------------
	// metrics_templates
	// ---------------------------------------------------------------------
	private createMetricsTemplateRepository(): MetricsTemplateRepository {
		const table = schema.metricsTemplates;
		return {
			create: (input: NewMetricsTemplateRow) => {
				const row = this.db.insert(table).values(input).returning().get();
				return Promise.resolve(toMetricsTemplate(row));
			},
			findById: (id) => {
				const row = this.db.select().from(table).where(eq(table.id, id)).get();
				return Promise.resolve(row ? toMetricsTemplate(row) : undefined);
			},
			listByUser: (userId) =>
				Promise.resolve(
					this.db
						.select()
						.from(table)
						.where(eq(table.userId, userId))
						.orderBy(desc(table.effectiveFrom))
						.all()
						.map(toMetricsTemplate)
				),
			findActiveByDate: (userId, date) => {
				const row = this.db
					.select()
					.from(table)
					.where(and(eq(table.userId, userId), lte(table.effectiveFrom, date)))
					.orderBy(desc(table.effectiveFrom))
					.get();
				return Promise.resolve(row ? toMetricsTemplate(row) : undefined);
			},
			update: (id, patch: MetricsTemplatePatch) => {
				const row = this.db.update(table).set(patch).where(eq(table.id, id)).returning().get();
				return Promise.resolve(row ? toMetricsTemplate(row) : undefined);
			},
			remove: (id) => {
				const res = this.db.delete(table).where(eq(table.id, id)).run();
				return Promise.resolve(res.changes);
			}
		};
	}

	// ---------------------------------------------------------------------
	// daily_metric_values (flexible)
	// ---------------------------------------------------------------------
	private createDailyMetricValueRepository(): DailyMetricValueRepository {
		const table = schema.dailyMetricValues;
		return {
			listByUserAndDate: (userId, date) =>
				Promise.resolve(
					this.db
						.select()
						.from(table)
						.where(and(eq(table.userId, userId), eq(table.date, date)))
						.all()
						.map(toDailyMetricValue)
				),
			listByUserAndDateAndNames: (userId, date, metricNames) => {
				if (metricNames.length === 0) return Promise.resolve([]);
				return Promise.resolve(
					this.db
						.select()
						.from(table)
						.where(
							and(
								eq(table.userId, userId),
								eq(table.date, date),
								inArray(table.metricName, metricNames)
							)
						)
						.all()
						.map(toDailyMetricValue)
				);
			},
			findByUserDateName: (userId, date, metricName) => {
				const row = this.db
					.select()
					.from(table)
					.where(
						and(
							eq(table.userId, userId),
							eq(table.date, date),
							eq(table.metricName, metricName)
						)
					)
					.get();
				return Promise.resolve(row ? toDailyMetricValue(row) : undefined);
			},
			upsert: (input: NewDailyMetricValueRow) => {
				const existing = this.db
					.select()
					.from(table)
					.where(
						and(
							eq(table.userId, input.userId),
							eq(table.date, input.date),
							eq(table.metricName, input.metricName)
						)
					)
					.get();
				if (existing) {
					const updated = this.db
						.update(table)
						.set({ value: input.value ?? null, source: input.source })
						.where(eq(table.id, existing.id))
						.returning()
						.get();
					return Promise.resolve(toDailyMetricValue(updated));
				}
				const created = this.db.insert(table).values(input).returning().get();
				return Promise.resolve(toDailyMetricValue(created));
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
			create: (input) => {
				const row = this.db.insert(table).values(input).returning().get();
				return Promise.resolve(toSavedQuery(row));
			},
			findById: (id) => {
				const row = this.db.select().from(table).where(eq(table.id, id)).get();
				return Promise.resolve(row ? toSavedQuery(row) : undefined);
			},
			findByIdForUser: (id, userId) => {
				const row = this.db
					.select()
					.from(table)
					.where(and(eq(table.id, id), eq(table.userId, userId)))
					.get();
				return Promise.resolve(row ? toSavedQuery(row) : undefined);
			},
			listByUser: (userId, filters) => {
				const cond = filters?.queryType
					? and(eq(table.userId, userId), eq(table.queryType, filters.queryType))
					: eq(table.userId, userId);
				const rows = this.db.select().from(table).where(cond).all();
				return Promise.resolve(rows.map(toSavedQuery));
			},
			update: (id, patch) => {
				const row = this.db.update(table).set(patch).where(eq(table.id, id)).returning().get();
				return Promise.resolve(row ? toSavedQuery(row) : undefined);
			},
			remove: (id) => {
				const res = this.db.delete(table).where(eq(table.id, id)).run();
				return Promise.resolve(res.changes);
			}
		};
	}

	// ---------------------------------------------------------------------
	// dashboard widgets (WP07 / T025)
	// ---------------------------------------------------------------------
	private createDashboardWidgetRepository(): DashboardWidgetRepository {
		const table = schema.dashboardWidgets;
		return {
			create: (input) => {
				const row = this.db.insert(table).values(input).returning().get();
				return Promise.resolve(toDashboardWidget(row));
			},
			findById: (id) => {
				const row = this.db.select().from(table).where(eq(table.id, id)).get();
				return Promise.resolve(row ? toDashboardWidget(row) : undefined);
			},
			findByIdForUser: (id, userId) => {
				const row = this.db
					.select()
					.from(table)
					.where(and(eq(table.id, id), eq(table.userId, userId)))
					.get();
				return Promise.resolve(row ? toDashboardWidget(row) : undefined);
			},
			listByUserAndPage: (userId, page) => {
				const rows = this.db
					.select()
					.from(table)
					.where(and(eq(table.userId, userId), eq(table.page, page)))
					.orderBy(asc(table.sortOrder))
					.all();
				return Promise.resolve(rows.map(toDashboardWidget));
			},
			update: (id, patch) => {
				const row = this.db.update(table).set(patch).where(eq(table.id, id)).returning().get();
				return Promise.resolve(row ? toDashboardWidget(row) : undefined);
			},
			remove: (id) => {
				const res = this.db.delete(table).where(eq(table.id, id)).run();
				return Promise.resolve(res.changes);
			}
		};
	}

	// ---------------------------------------------------------------------
	// plugins (WP07 / T026)
	// ---------------------------------------------------------------------
	private createPluginRepository(): PluginRepository {
		const table = schema.plugins;
		return {
			findByUserAndPlugin: (userId, pluginId) => {
				const row = this.db
					.select()
					.from(table)
					.where(and(eq(table.userId, userId), eq(table.pluginId, pluginId)))
					.get();
				return Promise.resolve(row ? toPlugin(row) : undefined);
			},
			listEnabled: () => {
				const rows = this.db.select().from(table).where(eq(table.enabled, true)).all();
				return Promise.resolve(rows.map(toPlugin));
			},
			create: (input) => {
				const row = this.db.insert(table).values(input).returning().get();
				return Promise.resolve(toPlugin(row));
			},
			update: (id, patch) => {
				const row = this.db.update(table).set(patch).where(eq(table.id, id)).returning().get();
				return Promise.resolve(row ? toPlugin(row) : undefined);
			},
			updateByUserAndPlugin: (userId, pluginId, patch) => {
				const row = this.db
					.update(table)
					.set(patch)
					.where(and(eq(table.userId, userId), eq(table.pluginId, pluginId)))
					.returning()
					.get();
				return Promise.resolve(row ? toPlugin(row) : undefined);
			}
		};
	}

	// ---------------------------------------------------------------------
	// user AI config (WP07 / T026)
	// ---------------------------------------------------------------------
	private createUserAiConfigRepository(): UserAiConfigRepository {
		const table = schema.userAiConfig;
		return {
			findByUser: (userId) => {
				const row = this.db.select().from(table).where(eq(table.userId, userId)).get();
				return Promise.resolve(row ? toUserAiConfig(row) : undefined);
			},
			upsert: (input) => {
				const existing = this.db
					.select()
					.from(table)
					.where(eq(table.userId, input.userId))
					.get();
				const row = existing
					? this.db
							.update(table)
							.set({
								provider: input.provider ?? existing.provider,
								providersConfig:
									input.providersConfig !== undefined
										? input.providersConfig
										: existing.providersConfig,
								customSystemPrompt:
									input.customSystemPrompt !== undefined
										? input.customSystemPrompt
										: existing.customSystemPrompt,
								maxAgentRounds: input.maxAgentRounds ?? existing.maxAgentRounds,
								updatedAt: input.updatedAt ?? new Date()
							})
							.where(eq(table.id, existing.id))
							.returning()
							.get()
					: this.db.insert(table).values(input).returning().get();
				return Promise.resolve(toUserAiConfig(row));
			}
		};
	}

	// ---------------------------------------------------------------------
	// query execution logs (WP07 / T026)
	// ---------------------------------------------------------------------
	private createQueryExecutionLogRepository(): QueryExecutionLogRepository {
		const table = schema.queryExecutionLogs;
		return {
			create: (input) => {
				const row = this.db.insert(table).values(input).returning().get();
				return Promise.resolve(toQueryExecutionLog(row));
			},
			listByUser: (userId, limit = 50) => {
				const rows = this.db
					.select()
					.from(table)
					.where(eq(table.userId, userId))
					.orderBy(desc(table.createdAt))
					.limit(limit)
					.all();
				return Promise.resolve(rows.map(toQueryExecutionLog));
			},
			list: (filters, opts) => {
				const cond = this.buildLogConditions(filters);
				const rows = this.db
					.select()
					.from(table)
					.where(cond)
					.orderBy(desc(table.createdAt))
					.limit(opts.limit)
					.offset(opts.offset)
					.all();
				return Promise.resolve(rows.map(toQueryExecutionLog));
			},
			count: (filters) => {
				const cond = this.buildLogConditions(filters);
				const row = this.db.select({ c: count() }).from(table).where(cond).get();
				return Promise.resolve(row?.c ?? 0);
			},
			listSince: (since) => {
				const rows = this.db
					.select()
					.from(table)
					.where(gte(table.createdAt, since))
					.all();
				return Promise.resolve(rows.map(toQueryExecutionLog));
			}
		};
	}

	// ---------------------------------------------------------------------
	// friend requests (WP07 / T025)
	// ---------------------------------------------------------------------
	private createFriendRequestRepository(): FriendRequestRepository {
		const table = schema.friendRequests;
		return {
			create: (input) => {
				const row = this.db.insert(table).values(input).returning().get();
				return Promise.resolve(toFriendRequest(row));
			},
			findPendingBetween: (a, b) => {
				const row = this.db
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
					.get();
				return Promise.resolve(row ? toFriendRequest(row) : undefined);
			},
			listIncomingPending: (userId) => {
				const rows = this.db
					.select()
					.from(table)
					.where(and(eq(table.toUserId, userId), eq(table.status, 'pending')))
					.all();
				return Promise.resolve(rows.map(toFriendRequest));
			},
			listOutgoingPending: (userId) => {
				const rows = this.db
					.select()
					.from(table)
					.where(and(eq(table.fromUserId, userId), eq(table.status, 'pending')))
					.all();
				return Promise.resolve(rows.map(toFriendRequest));
			},
			findPendingTo: (id, toUserId) => {
				const row = this.db
					.select()
					.from(table)
					.where(and(eq(table.id, id), eq(table.toUserId, toUserId), eq(table.status, 'pending')))
					.get();
				return Promise.resolve(row ? toFriendRequest(row) : undefined);
			},
			findPendingFrom: (id, fromUserId) => {
				const row = this.db
					.select()
					.from(table)
					.where(
						and(eq(table.id, id), eq(table.fromUserId, fromUserId), eq(table.status, 'pending'))
					)
					.get();
				return Promise.resolve(row ? toFriendRequest(row) : undefined);
			},
			update: (id, patch) => {
				const row = this.db
					.update(table)
					.set({ status: patch.status, respondedAt: patch.respondedAt })
					.where(eq(table.id, id))
					.returning()
					.get();
				return Promise.resolve(row ? toFriendRequest(row) : undefined);
			},
			remove: (id) => {
				const res = this.db.delete(table).where(eq(table.id, id)).run();
				return Promise.resolve(res.changes);
			}
		};
	}

	// ---------------------------------------------------------------------
	// friendships (WP07 / T025)
	// ---------------------------------------------------------------------
	private createFriendshipRepository(): FriendshipRepository {
		const table = schema.friendships;
		return {
			create: (input) => {
				const row = this.db.insert(table).values(input).returning().get();
				return Promise.resolve(toFriendship(row));
			},
			findBetween: (a, b) => {
				const row = this.db
					.select()
					.from(table)
					.where(
						or(
							and(eq(table.userId1, a), eq(table.userId2, b)),
							and(eq(table.userId1, b), eq(table.userId2, a))
						)
					)
					.get();
				return Promise.resolve(row ? toFriendship(row) : undefined);
			},
			listForUser: (userId) => {
				const rows = this.db
					.select()
					.from(table)
					.where(or(eq(table.userId1, userId), eq(table.userId2, userId)))
					.all();
				return Promise.resolve(rows.map(toFriendship));
			},
			remove: (id) => {
				const res = this.db.delete(table).where(eq(table.id, id)).run();
				return Promise.resolve(res.changes);
			}
		};
	}

	// ---------------------------------------------------------------------
	// friend notes (WP07 / T025)
	// ---------------------------------------------------------------------
	private createFriendNoteRepository(): FriendNoteRepository {
		const table = schema.friendNotes;
		return {
			findByUserAndFriend: (userId, friendId) => {
				const row = this.db
					.select()
					.from(table)
					.where(and(eq(table.userId, userId), eq(table.friendId, friendId)))
					.get();
				return Promise.resolve(row ? toFriendNote(row) : undefined);
			},
			upsert: (input) => {
				const existing = this.db
					.select()
					.from(table)
					.where(and(eq(table.userId, input.userId), eq(table.friendId, input.friendId)))
					.get();
				const row = existing
					? this.db
							.update(table)
							.set({ note: input.note ?? existing.note, updatedAt: input.updatedAt ?? new Date() })
							.where(eq(table.id, existing.id))
							.returning()
							.get()
					: this.db.insert(table).values(input).returning().get();
				return Promise.resolve(toFriendNote(row));
			},
			removeBetween: (a, b) => {
				const res = this.db
					.delete(table)
					.where(
						or(
							and(eq(table.userId, a), eq(table.friendId, b)),
							and(eq(table.userId, b), eq(table.friendId, a))
						)
					)
					.run();
				return Promise.resolve(res.changes);
			}
		};
	}

	// ---------------------------------------------------------------------
	// backup export / restore (WP06 / FR-008)
	//
	// exportSnapshot reads the whole user scoped in ONE better-sqlite3
	// transaction (a consistent read snapshot). restore executes the validated
	// command plan in one transaction: deletes + inserts + preference update
	// either all commit or all roll back.
	// ---------------------------------------------------------------------
	private createBackupRepository(): BackupRepository {
		return {
			exportSnapshot: async (userId) => {
				const snapshot = this.db.transaction(() => {
					const user = this.db
						.select()
						.from(schema.users)
						.where(eq(schema.users.id, userId))
						.get();
					if (!user) throw new Error(`User ${userId} not found for backup export`);

					const objectives = this.db
						.select()
						.from(schema.objectives)
						.where(eq(schema.objectives.userId, userId))
						.all();
					const objectiveIds = objectives.map((o) => o.id);
					const keyResults =
						objectiveIds.length > 0
							? this.db
									.select()
									.from(schema.keyResults)
									.where(inArray(schema.keyResults.objectiveId, objectiveIds))
									.all()
							: [];

					const timePeriods = this.db
						.select()
						.from(schema.timePeriods)
						.where(eq(schema.timePeriods.userId, userId))
						.all();
					const timePeriodIds = timePeriods.map((tp) => tp.id);
					const tasks = this.db
						.select()
						.from(schema.tasks)
						.where(eq(schema.tasks.userId, userId))
						.all();
					const taskIds = tasks.map((t) => t.id);
					const taskAttributes =
						taskIds.length > 0
							? this.db
									.select()
									.from(schema.taskAttributes)
									.where(inArray(schema.taskAttributes.taskId, taskIds))
									.all()
							: [];
					const taskTags =
						taskIds.length > 0
							? this.db
									.select()
									.from(schema.taskTags)
									.where(inArray(schema.taskTags.taskId, taskIds))
									.all()
							: [];
					const timeCommitments =
						timePeriodIds.length > 0
							? this.db
									.select()
									.from(schema.timeCommitments)
									.where(inArray(schema.timeCommitments.timePeriodId, timePeriodIds))
									.all()
							: [];

					const values = this.db
						.select()
						.from(schema.values)
						.where(eq(schema.values.userId, userId))
						.all();
					const principles = this.db
						.select()
						.from(schema.principles)
						.where(eq(schema.principles.userId, userId))
						.all();
					const tags = this.db
						.select()
						.from(schema.tags)
						.where(eq(schema.tags.userId, userId))
						.all();
					const savedQueries = this.db
						.select()
						.from(schema.savedQueries)
						.where(eq(schema.savedQueries.userId, userId))
						.all();
					const dashboardWidgets = this.db
						.select()
						.from(schema.dashboardWidgets)
						.where(eq(schema.dashboardWidgets.userId, userId))
						.all();
					const dailyMetrics = this.db
						.select()
						.from(schema.dailyMetrics)
						.where(eq(schema.dailyMetrics.userId, userId))
						.all();
					const metricsTemplates = this.db
						.select()
						.from(schema.metricsTemplates)
						.where(eq(schema.metricsTemplates.userId, userId))
						.all();
					const dailyMetricValues = this.db
						.select()
						.from(schema.dailyMetricValues)
						.where(eq(schema.dailyMetricValues.userId, userId))
						.all();
					const objectiveReflections = this.db
						.select()
						.from(schema.objectiveReflections)
						.where(eq(schema.objectiveReflections.userId, userId))
						.all();

					const snapshot: BackupSnapshot = {
						user: toUser(user),
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
					return snapshot;
				});
				return Promise.resolve(snapshot);
			},

			restore: async (plan) => {
				const result = this.db.transaction(() => {
					const uid = plan.userId;

					// STEP 1: delete all of the target user's data (children first).
					this.db
						.delete(schema.taskAttributes)
						.where(
							inArray(
								schema.taskAttributes.taskId,
								this.db
									.select({ id: schema.tasks.id })
									.from(schema.tasks)
									.where(eq(schema.tasks.userId, uid))
							)
						)
						.run();
					this.db
						.delete(schema.taskTags)
						.where(
							inArray(
								schema.taskTags.taskId,
								this.db
									.select({ id: schema.tasks.id })
									.from(schema.tasks)
									.where(eq(schema.tasks.userId, uid))
							)
						)
						.run();
					this.db
						.delete(schema.keyResults)
						.where(
							inArray(
								schema.keyResults.objectiveId,
								this.db
									.select({ id: schema.objectives.id })
									.from(schema.objectives)
									.where(eq(schema.objectives.userId, uid))
							)
						)
						.run();
					this.db
						.delete(schema.dailyMetrics)
						.where(eq(schema.dailyMetrics.userId, uid))
						.run();
					this.db
						.delete(schema.timeCommitments)
						.where(
							inArray(
								schema.timeCommitments.timePeriodId,
								this.db
									.select({ id: schema.timePeriods.id })
									.from(schema.timePeriods)
									.where(eq(schema.timePeriods.userId, uid))
							)
						)
						.run();
					this.db.delete(schema.tasks).where(eq(schema.tasks.userId, uid)).run();
					this.db.delete(schema.timePeriods).where(eq(schema.timePeriods.userId, uid)).run();
					this.db.delete(schema.objectives).where(eq(schema.objectives.userId, uid)).run();
					this.db.delete(schema.principles).where(eq(schema.principles.userId, uid)).run();
					this.db.delete(schema.values).where(eq(schema.values.userId, uid)).run();
					this.db.delete(schema.tags).where(eq(schema.tags.userId, uid)).run();
					this.db.delete(schema.savedQueries).where(eq(schema.savedQueries.userId, uid)).run();
					this.db
						.delete(schema.dashboardWidgets)
						.where(eq(schema.dashboardWidgets.userId, uid))
						.run();
					this.db
						.delete(schema.metricsTemplates)
						.where(eq(schema.metricsTemplates.userId, uid))
						.run();
					this.db
						.delete(schema.dailyMetricValues)
						.where(eq(schema.dailyMetricValues.userId, uid))
						.run();
					this.db
						.delete(schema.objectiveReflections)
						.where(eq(schema.objectiveReflections.userId, uid))
						.run();

					// STEP 2: insert from the validated, resolved plan.
					if (plan.tags.length > 0) {
						this.db.insert(schema.tags).values(plan.tags).run();
					}
					for (const entry of plan.values) {
						this.db.insert(schema.values).values(entry.value).run();
						if (entry.principles.length > 0) {
							this.db.insert(schema.principles).values(entry.principles).run();
						}
					}
					if (plan.orphanPrinciples.length > 0) {
						this.db.insert(schema.principles).values(plan.orphanPrinciples).run();
					}
					if (plan.savedQueries.length > 0) {
						this.db.insert(schema.savedQueries).values(plan.savedQueries).run();
					}
					for (const entry of plan.objectives) {
						this.db.insert(schema.objectives).values(entry.objective).run();
						if (entry.keyResults.length > 0) {
							this.db.insert(schema.keyResults).values(entry.keyResults).run();
						}
					}
					for (const tp of plan.timePeriods) {
						this.db.insert(schema.timePeriods).values(tp.period).run();
						if (tp.commitment) {
							this.db.insert(schema.timeCommitments).values(tp.commitment).run();
						}
						if (tp.dailyMetrics) {
							this.db.insert(schema.dailyMetrics).values(tp.dailyMetrics).run();
						}
						for (const task of tp.tasks) {
							this.db.insert(schema.tasks).values(task.task).run();
							if (task.attributes.length > 0) {
								this.db.insert(schema.taskAttributes).values(task.attributes).run();
							}
							for (const tagId of task.tagIds) {
								this.db.insert(schema.taskTags).values({ taskId: task.task.id, tagId }).run();
							}
						}
					}
					if (plan.dashboardWidgets.length > 0) {
						this.db.insert(schema.dashboardWidgets).values(plan.dashboardWidgets).run();
					}
					if (plan.metricsTemplates.length > 0) {
						this.db.insert(schema.metricsTemplates).values(plan.metricsTemplates).run();
					}
					if (plan.dailyMetricValues.length > 0) {
						this.db.insert(schema.dailyMetricValues).values(plan.dailyMetricValues).run();
					}
					if (plan.objectiveReflections.length > 0) {
						this.db.insert(schema.objectiveReflections).values(plan.objectiveReflections).run();
					}

					// STEP 3: restore user preferences (shares the transaction).
					const prefs = plan.preferences;
					const userPatch: Partial<typeof schema.users.$inferInsert> = {};
					if (prefs.timezone !== undefined) userPatch.timezone = prefs.timezone;
					userPatch.weekStartDay = prefs.weekStartDay;
					userPatch.bgColor = prefs.bgColor;
					this.db.update(schema.users).set(userPatch).where(eq(schema.users.id, uid)).run();

					return plan.stats;
				});
				return Promise.resolve(result);
			}
		};
	}

	// ---------------------------------------------------------------------
	// bounded atomic operation (single synchronous transaction)
	// ---------------------------------------------------------------------
	async createUserWithInitialData(input: CreateUserWithInitialDataInput): Promise<UserRow> {
		const result = this.db.transaction((tx) => {
			const user = tx.insert(schema.users).values(input.user).returning().get();
			for (const entry of input.objectives) {
				const obj = tx.insert(schema.objectives).values(entry.objective).returning().get();
				for (const kr of entry.keyResults) {
					tx.insert(schema.keyResults).values(kr).returning().get();
				}
			}
			return toUser(user);
		});
		return result;
	}

	async createTaskWithDetails(input: CreateTaskInput): Promise<TaskRow> {
		const result = this.db.transaction(() => {
			const task = this.db.insert(schema.tasks).values(input.task).returning().get();
			const attrs = attributeRowsFor(task.id, (input.attributes ?? {}) as Record<string, unknown>);
			if (attrs.length > 0) {
				this.db.insert(schema.taskAttributes).values(attrs).run();
			}
			for (const tagId of input.tagIds ?? []) {
				this.db.insert(schema.taskTags).values({ taskId: task.id, tagId }).run();
			}
			return toTask(task);
		});
		return result;
	}

	async updateTaskWithDetails(input: UpdateTaskInput): Promise<TaskRow | undefined> {
		const result = this.db.transaction(() => {
			const current = this.db.select().from(schema.tasks).where(eq(schema.tasks.id, input.id)).get();
			if (!current) return undefined;
			const updated = this.db
				.update(schema.tasks)
				.set(input.patch)
				.where(eq(schema.tasks.id, input.id))
				.returning()
				.get();
			if (input.attributes !== undefined) {
				this.db.delete(schema.taskAttributes).where(eq(schema.taskAttributes.taskId, input.id)).run();
				const attrs = attributeRowsFor(input.id, input.attributes as Record<string, unknown>);
				if (attrs.length > 0) {
					this.db.insert(schema.taskAttributes).values(attrs).run();
				}
			}
			if (input.tagIds !== undefined) {
				this.db.delete(schema.taskTags).where(eq(schema.taskTags.taskId, input.id)).run();
				for (const tagId of input.tagIds) {
					this.db.insert(schema.taskTags).values({ taskId: input.id, tagId }).run();
				}
			}
			return updated ? toTask(updated) : undefined;
		});
		return result;
	}

	// ---------------------------------------------------------------------
	// worker dispatch allowlist (WP10 / T044)
	//
	// A statically enumerated, typed allowlist of methods the worker may
	// execute. Every method path is bound to the corresponding repository
	// method declared in the persistence contract. An unknown/denied method
	// string rejects before any execution — no generic `obj[method]` invocation
	// is ever accepted from the wire.
	// ---------------------------------------------------------------------
	private _allowlist: Map<string, (args: unknown[]) => unknown> | undefined;

	private buildAllowlist(): Map<string, (args: unknown[]) => unknown> {
		const map = new Map<string, (args: unknown[]) => unknown>();
		const repos: Record<string, Record<string, (...a: unknown[]) => unknown>> = {
			users: this.users as unknown as Record<string, (...a: unknown[]) => unknown>,
			sessions: this.sessions as unknown as Record<string, (...a: unknown[]) => unknown>,
			systemConfig: this.systemConfig as unknown as Record<string, (...a: unknown[]) => unknown>,
			objectives: this.objectives as unknown as Record<string, (...a: unknown[]) => unknown>,
			keyResults: this.keyResults as unknown as Record<string, (...a: unknown[]) => unknown>,
			objectiveReflections: this.objectiveReflections as unknown as Record<string, (...a: unknown[]) => unknown>,
			tasks: this.tasks as unknown as Record<string, (...a: unknown[]) => unknown>,
			taskAttributes: this.taskAttributes as unknown as Record<string, (...a: unknown[]) => unknown>,
			tags: this.tags as unknown as Record<string, (...a: unknown[]) => unknown>,
			taskTags: this.taskTags as unknown as Record<string, (...a: unknown[]) => unknown>,
			timePeriods: this.timePeriods as unknown as Record<string, (...a: unknown[]) => unknown>,
			dailyMetrics: this.dailyMetrics as unknown as Record<string, (...a: unknown[]) => unknown>,
			metricsTemplates: this.metricsTemplates as unknown as Record<string, (...a: unknown[]) => unknown>,
			dailyMetricValues: this.dailyMetricValues as unknown as Record<string, (...a: unknown[]) => unknown>,
			savedQueries: this.savedQueries as unknown as Record<string, (...a: unknown[]) => unknown>,
			dashboardWidgets: this.dashboardWidgets as unknown as Record<string, (...a: unknown[]) => unknown>,
			plugins: this.plugins as unknown as Record<string, (...a: unknown[]) => unknown>,
			userAiConfig: this.userAiConfig as unknown as Record<string, (...a: unknown[]) => unknown>,
			queryExecutionLogs: this.queryExecutionLogs as unknown as Record<string, (...a: unknown[]) => unknown>,
			friendRequests: this.friendRequests as unknown as Record<string, (...a: unknown[]) => unknown>,
			friendships: this.friendships as unknown as Record<string, (...a: unknown[]) => unknown>,
			friendNotes: this.friendNotes as unknown as Record<string, (...a: unknown[]) => unknown>,
			backup: this.backup as unknown as Record<string, (...a: unknown[]) => unknown>
		};
		for (const [repo, methods] of Object.entries(REPO_METHODS)) {
			const target = repos[repo];
			if (!target) throw new Error(`Allowlist references unknown repository '${repo}'`);
			for (const method of methods) {
				const fn = target[method];
				if (typeof fn !== 'function') {
					throw new Error(`Allowlist method '${repo}.${method}' is missing on SqliteLocalServices`);
				}
				map.set(`${repo}.${method}`, (args) => fn.apply(target, args));
			}
		}
		for (const method of SERVICE_METHODS) {
			const fn = (this as unknown as Record<string, (...a: unknown[]) => unknown>)[method];
			if (typeof fn !== 'function') {
				throw new Error(`Allowlist service method '${method}' is missing on SqliteLocalServices`);
			}
			map.set(method, (args) => fn.apply(this, args));
		}
		return map;
	}

	private allowlist(): Map<string, (args: unknown[]) => unknown> {
		this._allowlist ??= this.buildAllowlist();
		return this._allowlist;
	}

	/**
	 * Execute one allowlisted method with structured-cloneable positional
	 * arguments. Unknown/denied methods reject before any SQL runs. This is the
	 * ONLY entry point the worker uses to touch this engine.
	 */
	async dispatch(method: string, args: unknown[]): Promise<unknown> {
		const handler = this.allowlist().get(method);
		if (!handler) {
			throw new Error(`Unknown or disallowed SQLite method '${method}'`);
		}
		return handler(args);
	}

	/**
	 * Bounded live-availability query on a required application table (RISK-1 /
	 * NFR-002 / WP10 T046). Resolves true when the runtime handle can serve a read;
	 * rejects when storage is blocked/unavailable. Never used as a cached
	 * success shortcut.
	 */
	async checkAvailability(): Promise<boolean> {
		if (!this._open) throw new Error('SQLite is not open');
		this.db.select({ c: count() }).from(schema.users).get();
		return true;
	}
}

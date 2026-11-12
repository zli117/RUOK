/**
 * PostgreSQL dialect schema (drizzle pg-core).
 *
 * Mirrors `schema/sqlite.ts` so both dialects represent every current
 * application table and field (25 tables) with matched names, defaults,
 * nullability, foreign keys and indexes. A structural parity test keeps the
 * two dialects from drifting apart.
 *
 * Codec strategy (see data-model.md):
 *  - text IDs            -> `text` PK/FK (preserved, opaque)
 *  - booleans            -> `boolean`
 *  - timestamps          -> `timestamptz` (`{ mode: 'date', withTimezone: true }`),
 *                           normalized to second precision by the adapter
 *  - reals               -> `doublePrecision`
 *  - millisecond totals  -> `bigint(..., { mode: 'number' })` (may exceed 32 bits)
 *  - JSON                -> `text` (stored string, unchanged)
 *  - enum-like           -> `text` with a literal union (no one-backend-only checks)
 */
import {
	bigint,
	boolean,
	doublePrecision,
	integer,
	pgTable,
	text,
	timestamp,
	uniqueIndex
} from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------
export const users = pgTable('users', {
	id: text('id').primaryKey(),
	username: text('username').notNull().unique(),
	passwordHash: text('password_hash').notNull(),
	weekStartDay: text('week_start_day', { enum: ['sunday', 'monday'] }).notNull().default('monday'),
	timezone: text('timezone').notNull().default('UTC'),
	bgColor: text('bg_color'),
	isAdmin: boolean('is_admin').notNull().default(false),
	isDisabled: boolean('is_disabled').notNull().default(false),
	createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
		.notNull()
		.$defaultFn(() => new Date())
});

// ---------------------------------------------------------------------------
// sessions
// ---------------------------------------------------------------------------
export const sessions = pgTable('sessions', {
	id: text('id').primaryKey(),
	userId: text('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	expiresAt: timestamp('expires_at', { mode: 'date', withTimezone: true }).notNull()
});

// ---------------------------------------------------------------------------
// values
// ---------------------------------------------------------------------------
export const values = pgTable('values', {
	id: text('id').primaryKey(),
	userId: text('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	title: text('title').notNull(),
	rank: integer('rank').notNull(),
	description: text('description'),
	createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
		.notNull()
		.$defaultFn(() => new Date()),
	updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true })
		.notNull()
		.$defaultFn(() => new Date())
});

// ---------------------------------------------------------------------------
// principles
// ---------------------------------------------------------------------------
export const principles = pgTable('principles', {
	id: text('id').primaryKey(),
	userId: text('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	valueId: text('value_id').references(() => values.id, { onDelete: 'set null' }),
	title: text('title').notNull(),
	description: text('description'),
	examples: text('examples'),
	createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
		.notNull()
		.$defaultFn(() => new Date()),
	updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true })
		.notNull()
		.$defaultFn(() => new Date())
});

// ---------------------------------------------------------------------------
// objectives
// ---------------------------------------------------------------------------
export const objectives = pgTable('objectives', {
	id: text('id').primaryKey(),
	userId: text('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	title: text('title').notNull(),
	description: text('description'),
	level: text('level', { enum: ['yearly', 'monthly'] }).notNull(),
	year: integer('year').notNull(),
	month: integer('month'),
	weight: doublePrecision('weight').notNull().default(1.0),
	parentId: text('parent_id'),
	category: text('category'),
	colorIndex: integer('color_index'),
	createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
		.notNull()
		.$defaultFn(() => new Date()),
	updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true })
		.notNull()
		.$defaultFn(() => new Date())
});

// ---------------------------------------------------------------------------
// key_results
// ---------------------------------------------------------------------------
export const keyResults = pgTable('key_results', {
	id: text('id').primaryKey(),
	objectiveId: text('objective_id')
		.notNull()
		.references(() => objectives.id, { onDelete: 'cascade' }),
	title: text('title').notNull(),
	details: text('details'),
	weight: doublePrecision('weight').notNull().default(1.0),
	score: doublePrecision('score').notNull().default(0),
	scoreLabel: text('score_label'),
	expectedHours: doublePrecision('expected_hours').default(0),
	sortOrder: integer('sort_order').notNull().default(0),
	measurementType: text('measurement_type', {
		enum: ['slider', 'checkboxes', 'custom_query']
	})
		.notNull()
		.default('slider'),
	checkboxItems: text('checkbox_items'),
	progressQueryId: text('progress_query_id'),
	progressQueryCode: text('progress_query_code'),
	widgetQueryId: text('widget_query_id'),
	widgetQueryCode: text('widget_query_code'),
	createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
		.notNull()
		.$defaultFn(() => new Date()),
	updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true })
		.notNull()
		.$defaultFn(() => new Date())
});

// ---------------------------------------------------------------------------
// time_periods
// ---------------------------------------------------------------------------
export const timePeriods = pgTable('time_periods', {
	id: text('id').primaryKey(),
	userId: text('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	periodType: text('period_type', {
		enum: ['yearly', 'monthly', 'weekly', 'daily']
	}).notNull(),
	year: integer('year').notNull(),
	month: integer('month'),
	week: integer('week'),
	day: text('day'),
	notes: text('notes'),
	reviewWhatWorked: text('review_what_worked'),
	reviewImprovements: text('review_improvements'),
	createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
		.notNull()
		.$defaultFn(() => new Date()),
	updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true })
		.notNull()
		.$defaultFn(() => new Date())
});

// ---------------------------------------------------------------------------
// time_commitments
// ---------------------------------------------------------------------------
export const timeCommitments = pgTable('time_commitments', {
	timePeriodId: text('time_period_id')
		.primaryKey()
		.references(() => timePeriods.id, { onDelete: 'cascade' }),
	numberOfWeeks: integer('number_of_weeks').notNull().default(4),
	availableHoursPerWeekday: doublePrecision('available_hours_per_weekday').notNull().default(1.5),
	availableHoursPerWeekend: doublePrecision('available_hours_per_weekend').notNull().default(8.0)
});

// ---------------------------------------------------------------------------
// tasks
// ---------------------------------------------------------------------------
export const tasks = pgTable('tasks', {
	id: text('id').primaryKey(),
	userId: text('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	timePeriodId: text('time_period_id')
		.notNull()
		.references(() => timePeriods.id, { onDelete: 'cascade' }),
	title: text('title').notNull(),
	completed: boolean('completed').notNull().default(false),
	completedAt: timestamp('completed_at', { mode: 'date', withTimezone: true }),
	sortOrder: integer('sort_order').notNull().default(0),
	timeSpentMs: bigint('time_spent_ms', { mode: 'number' }).notNull().default(0),
	timerStartedAt: timestamp('timer_started_at', { mode: 'date', withTimezone: true }),
	createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
		.notNull()
		.$defaultFn(() => new Date()),
	updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true })
		.notNull()
		.$defaultFn(() => new Date())
});

// ---------------------------------------------------------------------------
// task_attributes
// ---------------------------------------------------------------------------
export const taskAttributes = pgTable('task_attributes', {
	id: text('id').primaryKey(),
	taskId: text('task_id')
		.notNull()
		.references(() => tasks.id, { onDelete: 'cascade' }),
	key: text('key').notNull(),
	value: text('value').notNull(),
	valueType: text('value_type', {
		enum: ['number', 'time', 'text', 'boolean']
	})
		.notNull()
		.default('number')
});

// ---------------------------------------------------------------------------
// tags
// ---------------------------------------------------------------------------
export const tags = pgTable('tags', {
	id: text('id').primaryKey(),
	userId: text('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	name: text('name').notNull(),
	color: text('color'),
	category: text('category')
});

// ---------------------------------------------------------------------------
// task_tags (composite link; duplicate pairs permitted by the current schema)
// ---------------------------------------------------------------------------
export const taskTags = pgTable('task_tags', {
	taskId: text('task_id')
		.notNull()
		.references(() => tasks.id, { onDelete: 'cascade' }),
	tagId: text('tag_id')
		.notNull()
		.references(() => tags.id, { onDelete: 'cascade' })
});

// ---------------------------------------------------------------------------
// daily_metrics
// ---------------------------------------------------------------------------
export const dailyMetrics = pgTable('daily_metrics', {
	id: text('id').primaryKey(),
	userId: text('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	timePeriodId: text('time_period_id')
		.notNull()
		.references(() => timePeriods.id, { onDelete: 'cascade' }),
	previousNightBedTime: text('previous_night_bed_time'),
	wakeUpTime: text('wake_up_time'),
	sleepLength: text('sleep_length'),
	cardioLoad: integer('cardio_load'),
	fitbitReadiness: integer('fitbit_readiness'),
	steps: integer('steps'),
	heartPoints: integer('heart_points'),
	restingHeartRate: integer('resting_heart_rate'),
	customMetrics: text('custom_metrics')
});

// ---------------------------------------------------------------------------
// saved_queries
// ---------------------------------------------------------------------------
export const savedQueries = pgTable('saved_queries', {
	id: text('id').primaryKey(),
	userId: text('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	name: text('name').notNull(),
	description: text('description'),
	queryType: text('query_type', { enum: ['progress', 'widget', 'general'] })
		.notNull()
		.default('general'),
	code: text('code').notNull(),
	createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
		.notNull()
		.$defaultFn(() => new Date()),
	updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true })
		.notNull()
		.$defaultFn(() => new Date())
});

// ---------------------------------------------------------------------------
// dashboard_widgets
// ---------------------------------------------------------------------------
export const dashboardWidgets = pgTable('dashboard_widgets', {
	id: text('id').primaryKey(),
	userId: text('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	title: text('title').notNull(),
	widgetType: text('widget_type', { enum: ['builtin', 'custom', 'saved'] }).notNull(),
	config: text('config').notNull(),
	sortOrder: integer('sort_order').notNull().default(0),
	page: text('page').notNull().default('dashboard'),
	createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
		.notNull()
		.$defaultFn(() => new Date())
});

// ---------------------------------------------------------------------------
// plugins
// ---------------------------------------------------------------------------
export const plugins = pgTable('plugins', {
	id: text('id').primaryKey(),
	userId: text('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	pluginId: text('plugin_id').notNull(),
	enabled: boolean('enabled').notNull().default(true),
	config: text('config'),
	lastSync: timestamp('last_sync', { mode: 'date', withTimezone: true }),
	createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
		.notNull()
		.$defaultFn(() => new Date())
});

// ---------------------------------------------------------------------------
// system_config
// ---------------------------------------------------------------------------
export const systemConfig = pgTable('system_config', {
	key: text('key').primaryKey(),
	value: text('value').notNull(),
	isSecret: boolean('is_secret').notNull().default(false),
	updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true })
		.notNull()
		.$defaultFn(() => new Date())
});

// ---------------------------------------------------------------------------
// user_ai_config
// ---------------------------------------------------------------------------
export const userAiConfig = pgTable('user_ai_config', {
	id: text('id').primaryKey(),
	userId: text('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' })
		.unique(),
	provider: text('provider', {
		enum: ['anthropic', 'openai', 'gemini', 'openrouter', 'ollama']
	})
		.notNull()
		.default('anthropic'),
	providersConfig: text('providers_config'),
	customSystemPrompt: text('custom_system_prompt'),
	maxAgentRounds: integer('max_agent_rounds').notNull().default(20),
	createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
		.notNull()
		.$defaultFn(() => new Date()),
	updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true })
		.notNull()
		.$defaultFn(() => new Date())
});

// ---------------------------------------------------------------------------
// metrics_templates
// ---------------------------------------------------------------------------
export const metricsTemplates = pgTable('metrics_templates', {
	id: text('id').primaryKey(),
	userId: text('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	name: text('name').notNull().default('default'),
	effectiveFrom: text('effective_from').notNull(),
	metricsDefinition: text('metrics_definition').notNull(),
	createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
		.notNull()
		.$defaultFn(() => new Date()),
	updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true })
		.notNull()
		.$defaultFn(() => new Date())
});

// ---------------------------------------------------------------------------
// daily_metric_values
// ---------------------------------------------------------------------------
export const dailyMetricValues = pgTable('daily_metric_values', {
	id: text('id').primaryKey(),
	userId: text('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	date: text('date').notNull(),
	metricName: text('metric_name').notNull(),
	value: text('value'),
	source: text('source').notNull()
});

// ---------------------------------------------------------------------------
// objective_reflections
//
// Unique index includes the nullable `month` column. PostgreSQL's default
// NULLS DISTINCT uniqueness permits multiple rows with NULL month, matching the
// SQLite behavior. Nullable composite uniqueness is preserved on both sides.
// ---------------------------------------------------------------------------
export const objectiveReflections = pgTable(
	'objective_reflections',
	{
		id: text('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		level: text('level', { enum: ['yearly', 'monthly'] }).notNull(),
		year: integer('year').notNull(),
		month: integer('month'),
		reflection: text('reflection').notNull().default(''),
		createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
			.notNull()
			.$defaultFn(() => new Date()),
		updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true })
			.notNull()
			.$defaultFn(() => new Date())
	},
	(table) => [
		uniqueIndex('objective_reflections_unique').on(table.userId, table.level, table.year, table.month)
	]
);

// ---------------------------------------------------------------------------
// friend_requests
// ---------------------------------------------------------------------------
export const friendRequests = pgTable('friend_requests', {
	id: text('id').primaryKey(),
	fromUserId: text('from_user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	toUserId: text('to_user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	status: text('status', { enum: ['pending', 'accepted', 'declined'] }).notNull().default('pending'),
	createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
		.notNull()
		.$defaultFn(() => new Date()),
	respondedAt: timestamp('responded_at', { mode: 'date', withTimezone: true })
});

// ---------------------------------------------------------------------------
// friendships
// ---------------------------------------------------------------------------
export const friendships = pgTable('friendships', {
	id: text('id').primaryKey(),
	userId1: text('user_id_1')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	userId2: text('user_id_2')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
		.notNull()
		.$defaultFn(() => new Date())
});

// ---------------------------------------------------------------------------
// friend_notes
// ---------------------------------------------------------------------------
export const friendNotes = pgTable('friend_notes', {
	id: text('id').primaryKey(),
	userId: text('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	friendId: text('friend_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	note: text('note').notNull().default(''),
	updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true })
		.notNull()
		.$defaultFn(() => new Date())
});

// ---------------------------------------------------------------------------
// query_execution_logs
// ---------------------------------------------------------------------------
export const queryExecutionLogs = pgTable('query_execution_logs', {
	id: text('id').primaryKey(),
	userId: text('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	codeSnippet: text('code_snippet').notNull(),
	success: boolean('success').notNull(),
	errorMessage: text('error_message'),
	executionTimeMs: integer('execution_time_ms'),
	createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
		.notNull()
		.$defaultFn(() => new Date())
});
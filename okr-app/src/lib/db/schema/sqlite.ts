/**
 * SQLite dialect schema (drizzle sqlite-core).
 *
 * Represents EVERY current application table and field (25 tables) with the
 * same names, defaults, nullability, foreign keys and indexes as the
 * production schema (`../schema.ts`). SQLite remains the default backend.
 *
 * Codec strategy (see data-model.md):
 *  - text IDs            -> `text` PK/FK (preserved, opaque)
 *  - booleans            -> `integer(..., { mode: 'boolean' })`
 *  - timestamps          -> `integer(..., { mode: 'timestamp' })` (unix seconds)
 *  - reals               -> `real`
 *  - millisecond totals  -> `integer` (SQLite stores full 64-bit ints natively)
 *  - JSON                -> `text` (stored string, parsed by the application)
 *  - enum-like           -> `text` with a literal union
 *
 * The table names/column names below are the canonical SQLite surface. The
 * PostgreSQL mirror lives in `schema/postgres.ts`; a structural parity test
 * keeps the two dialects from drifting apart.
 */
import { integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

// ---------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------
export const users = sqliteTable('users', {
	id: text('id').primaryKey(),
	username: text('username').notNull().unique(),
	passwordHash: text('password_hash').notNull(),
	weekStartDay: text('week_start_day', { enum: ['sunday', 'monday'] }).notNull().default('monday'),
	timezone: text('timezone').notNull().default('UTC'),
	bgColor: text('bg_color'),
	isAdmin: integer('is_admin', { mode: 'boolean' }).notNull().default(false),
	isDisabled: integer('is_disabled', { mode: 'boolean' }).notNull().default(false),
	createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date())
});

// ---------------------------------------------------------------------------
// sessions
// ---------------------------------------------------------------------------
export const sessions = sqliteTable('sessions', {
	id: text('id').primaryKey(),
	userId: text('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull()
});

// ---------------------------------------------------------------------------
// values
// ---------------------------------------------------------------------------
export const values = sqliteTable('values', {
	id: text('id').primaryKey(),
	userId: text('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	title: text('title').notNull(),
	rank: integer('rank').notNull(),
	description: text('description'),
	createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
	updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date())
});

// ---------------------------------------------------------------------------
// principles
// ---------------------------------------------------------------------------
export const principles = sqliteTable('principles', {
	id: text('id').primaryKey(),
	userId: text('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	valueId: text('value_id').references(() => values.id, { onDelete: 'set null' }),
	title: text('title').notNull(),
	description: text('description'),
	examples: text('examples'),
	createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
	updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date())
});

// ---------------------------------------------------------------------------
// objectives
// ---------------------------------------------------------------------------
export const objectives = sqliteTable('objectives', {
	id: text('id').primaryKey(),
	userId: text('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	title: text('title').notNull(),
	description: text('description'),
	level: text('level', { enum: ['yearly', 'monthly'] }).notNull(),
	year: integer('year').notNull(),
	month: integer('month'),
	weight: real('weight').notNull().default(1.0),
	parentId: text('parent_id'),
	category: text('category'),
	colorIndex: integer('color_index'),
	createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
	updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date())
});

// ---------------------------------------------------------------------------
// key_results
// ---------------------------------------------------------------------------
export const keyResults = sqliteTable('key_results', {
	id: text('id').primaryKey(),
	objectiveId: text('objective_id')
		.notNull()
		.references(() => objectives.id, { onDelete: 'cascade' }),
	title: text('title').notNull(),
	details: text('details'),
	weight: real('weight').notNull().default(1.0),
	score: real('score').notNull().default(0),
	scoreLabel: text('score_label'),
	expectedHours: real('expected_hours').default(0),
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
	createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
	updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date())
});

// ---------------------------------------------------------------------------
// time_periods
// ---------------------------------------------------------------------------
export const timePeriods = sqliteTable('time_periods', {
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
	createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
	updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date())
});

// ---------------------------------------------------------------------------
// time_commitments
// ---------------------------------------------------------------------------
export const timeCommitments = sqliteTable('time_commitments', {
	timePeriodId: text('time_period_id')
		.primaryKey()
		.references(() => timePeriods.id, { onDelete: 'cascade' }),
	numberOfWeeks: integer('number_of_weeks').notNull().default(4),
	availableHoursPerWeekday: real('available_hours_per_weekday').notNull().default(1.5),
	availableHoursPerWeekend: real('available_hours_per_weekend').notNull().default(8.0)
});

// ---------------------------------------------------------------------------
// tasks
// ---------------------------------------------------------------------------
export const tasks = sqliteTable('tasks', {
	id: text('id').primaryKey(),
	userId: text('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	timePeriodId: text('time_period_id')
		.notNull()
		.references(() => timePeriods.id, { onDelete: 'cascade' }),
	title: text('title').notNull(),
	completed: integer('completed', { mode: 'boolean' }).notNull().default(false),
	completedAt: integer('completed_at', { mode: 'timestamp' }),
	sortOrder: integer('sort_order').notNull().default(0),
	timeSpentMs: integer('time_spent_ms').notNull().default(0),
	timerStartedAt: integer('timer_started_at', { mode: 'timestamp' }),
	createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
	updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date())
});

// ---------------------------------------------------------------------------
// task_attributes
// ---------------------------------------------------------------------------
export const taskAttributes = sqliteTable('task_attributes', {
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
export const tags = sqliteTable('tags', {
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
export const taskTags = sqliteTable('task_tags', {
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
export const dailyMetrics = sqliteTable('daily_metrics', {
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
export const savedQueries = sqliteTable('saved_queries', {
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
	createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
	updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date())
});

// ---------------------------------------------------------------------------
// dashboard_widgets
// ---------------------------------------------------------------------------
export const dashboardWidgets = sqliteTable('dashboard_widgets', {
	id: text('id').primaryKey(),
	userId: text('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	title: text('title').notNull(),
	widgetType: text('widget_type', { enum: ['builtin', 'custom', 'saved'] }).notNull(),
	config: text('config').notNull(),
	sortOrder: integer('sort_order').notNull().default(0),
	page: text('page').notNull().default('dashboard'),
	createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date())
});

// ---------------------------------------------------------------------------
// plugins
// ---------------------------------------------------------------------------
export const plugins = sqliteTable('plugins', {
	id: text('id').primaryKey(),
	userId: text('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	pluginId: text('plugin_id').notNull(),
	enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
	config: text('config'),
	lastSync: integer('last_sync', { mode: 'timestamp' }),
	createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date())
});

// ---------------------------------------------------------------------------
// system_config
// ---------------------------------------------------------------------------
export const systemConfig = sqliteTable('system_config', {
	key: text('key').primaryKey(),
	value: text('value').notNull(),
	isSecret: integer('is_secret', { mode: 'boolean' }).notNull().default(false),
	updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date())
});

// ---------------------------------------------------------------------------
// user_ai_config
// ---------------------------------------------------------------------------
export const userAiConfig = sqliteTable('user_ai_config', {
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
	createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
	updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date())
});

// ---------------------------------------------------------------------------
// metrics_templates
// ---------------------------------------------------------------------------
export const metricsTemplates = sqliteTable('metrics_templates', {
	id: text('id').primaryKey(),
	userId: text('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	name: text('name').notNull().default('default'),
	effectiveFrom: text('effective_from').notNull(),
	metricsDefinition: text('metrics_definition').notNull(),
	createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
	updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date())
});

// ---------------------------------------------------------------------------
// daily_metric_values
// ---------------------------------------------------------------------------
export const dailyMetricValues = sqliteTable('daily_metric_values', {
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
// The unique index includes the nullable `month` column. Under SQLite's
// default NULLS DISTINCT uniqueness, multiple rows with a NULL month are
// permitted; PostgreSQL's default NULLS DISTINCT matches that behavior. This
// nullable composite uniqueness semantic is deliberately preserved.
// ---------------------------------------------------------------------------
export const objectiveReflections = sqliteTable(
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
		createdAt: integer('created_at', { mode: 'timestamp' })
			.notNull()
			.$defaultFn(() => new Date()),
		updatedAt: integer('updated_at', { mode: 'timestamp' })
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
export const friendRequests = sqliteTable('friend_requests', {
	id: text('id').primaryKey(),
	fromUserId: text('from_user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	toUserId: text('to_user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	status: text('status', { enum: ['pending', 'accepted', 'declined'] }).notNull().default('pending'),
	createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
	respondedAt: integer('responded_at', { mode: 'timestamp' })
});

// ---------------------------------------------------------------------------
// friendships
// ---------------------------------------------------------------------------
export const friendships = sqliteTable('friendships', {
	id: text('id').primaryKey(),
	userId1: text('user_id_1')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	userId2: text('user_id_2')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date())
});

// ---------------------------------------------------------------------------
// friend_notes
// ---------------------------------------------------------------------------
export const friendNotes = sqliteTable('friend_notes', {
	id: text('id').primaryKey(),
	userId: text('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	friendId: text('friend_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	note: text('note').notNull().default(''),
	updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date())
});

// ---------------------------------------------------------------------------
// query_execution_logs
// ---------------------------------------------------------------------------
export const queryExecutionLogs = sqliteTable('query_execution_logs', {
	id: text('id').primaryKey(),
	userId: text('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	codeSnippet: text('code_snippet').notNull(),
	success: integer('success', { mode: 'boolean' }).notNull(),
	errorMessage: text('error_message'),
	executionTimeMs: integer('execution_time_ms'),
	createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date())
});
/**
 * Canonical, dialect-agnostic persistence models.
 *
 * These types are the single source of truth for domain rows crossing the
 * persistence boundary. They are intentionally free of any Drizzle / driver /
 * dialect types so that application code, repositories and tests never leak a
 * raw connection or a SQLite|Postgres union.
 *
 * Codec contract (shared by both adapters):
 *  - id            : opaque string (text PK/FK), preserved as supplied
 *  - booleans      : `boolean` (SQLite integer / PG boolean)
 *  - timestamps    : `Date` at *second* precision (SQLite integer seconds;
 *                    PG timestamptz normalized to seconds). Use
 *                    {@link toSecondPrecision} to normalize.
 *  - optional NULL : `null`, never `false`/`0`/missing
 *  - millisecond   : safe JS `number`, may exceed 32 bits (bigint on PG)
 *  - reals         : finite JS `number`
 *  - JSON          : stored string, parsed by the application
 */

export type WeekStartDay = 'sunday' | 'monday';

/** Normalize a Date to second precision (matches the SQLite integer-seconds codec). */
export function toSecondPrecision(date: Date): Date {
	const ms = date.getTime();
	if (Number.isNaN(ms)) return date;
	return new Date(Math.floor(ms / 1000) * 1000);
}

// ---------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------

export interface UserRow {
	id: string;
	username: string;
	passwordHash: string;
	weekStartDay: WeekStartDay;
	timezone: string;
	bgColor: string | null;
	isAdmin: boolean;
	isDisabled: boolean;
	createdAt: Date;
}

export interface NewUserRow {
	id: string;
	username: string;
	passwordHash: string;
	weekStartDay?: WeekStartDay;
	timezone?: string;
	bgColor?: string | null;
	isAdmin?: boolean;
	isDisabled?: boolean;
	createdAt?: Date;
}

export interface UserPatch {
	username?: string;
	passwordHash?: string;
	weekStartDay?: WeekStartDay;
	timezone?: string;
	bgColor?: string | null;
	isAdmin?: boolean;
	isDisabled?: boolean;
}

// ---------------------------------------------------------------------------
// sessions
// ---------------------------------------------------------------------------

export interface SessionRow {
	id: string;
	userId: string;
	expiresAt: Date;
}

export interface NewSessionRow {
	id: string;
	userId: string;
	expiresAt: Date;
}

// ---------------------------------------------------------------------------
// system_config
// ---------------------------------------------------------------------------

export interface SystemConfigRow {
	key: string;
	value: string;
	isSecret: boolean;
	updatedAt: Date;
}

export interface NewSystemConfigRow {
	key: string;
	value: string;
	isSecret: boolean;
	updatedAt: Date;
}

export interface SystemConfigPatch {
	value?: string;
	isSecret?: boolean;
	updatedAt?: Date;
}

// ---------------------------------------------------------------------------
// objectives
// ---------------------------------------------------------------------------

export type ObjectiveLevel = 'yearly' | 'monthly';

export interface ObjectiveRow {
	id: string;
	userId: string;
	title: string;
	description: string | null;
	level: ObjectiveLevel;
	year: number;
	month: number | null;
	weight: number;
	parentId: string | null;
	category: string | null;
	colorIndex: number | null;
	createdAt: Date;
	updatedAt: Date;
}

export interface NewObjectiveRow {
	id: string;
	userId: string;
	title: string;
	description?: string | null;
	level: ObjectiveLevel;
	year: number;
	month?: number | null;
	weight?: number;
	parentId?: string | null;
	category?: string | null;
	colorIndex?: number | null;
	createdAt?: Date;
	updatedAt?: Date;
}

export interface ObjectivePatch {
	title?: string;
	description?: string | null;
	level?: ObjectiveLevel;
	year?: number;
	month?: number | null;
	weight?: number;
	parentId?: string | null;
	category?: string | null;
	colorIndex?: number | null;
	updatedAt?: Date;
}

export interface ObjectiveWithKeyResults {
	objective: ObjectiveRow;
	keyResults: KeyResultRow[];
}

// ---------------------------------------------------------------------------
// key_results
// ---------------------------------------------------------------------------

export type KeyResultMeasurementType = 'slider' | 'checkboxes' | 'custom_query';

export interface KeyResultRow {
	id: string;
	objectiveId: string;
	title: string;
	details: string | null;
	weight: number;
	score: number;
	scoreLabel: string | null;
	expectedHours: number | null;
	sortOrder: number;
	measurementType: KeyResultMeasurementType;
	checkboxItems: string | null;
	progressQueryId: string | null;
	progressQueryCode: string | null;
	widgetQueryId: string | null;
	widgetQueryCode: string | null;
	createdAt: Date;
	updatedAt: Date;
}

export interface NewKeyResultRow {
	id: string;
	objectiveId: string;
	title: string;
	details?: string | null;
	weight?: number;
	score?: number;
	scoreLabel?: string | null;
	expectedHours?: number | null;
	sortOrder?: number;
	measurementType?: KeyResultMeasurementType;
	checkboxItems?: string | null;
	progressQueryId?: string | null;
	progressQueryCode?: string | null;
	widgetQueryId?: string | null;
	widgetQueryCode?: string | null;
	createdAt?: Date;
	updatedAt?: Date;
}

export interface KeyResultPatch {
	title?: string;
	details?: string | null;
	weight?: number;
	score?: number;
	scoreLabel?: string | null;
	expectedHours?: number | null;
	sortOrder?: number;
	measurementType?: KeyResultMeasurementType;
	checkboxItems?: string | null;
	progressQueryId?: string | null;
	progressQueryCode?: string | null;
	widgetQueryId?: string | null;
	widgetQueryCode?: string | null;
	updatedAt?: Date;
}

// ---------------------------------------------------------------------------
// objective_reflections
// ---------------------------------------------------------------------------

export interface ObjectiveReflectionRow {
	id: string;
	userId: string;
	level: ObjectiveLevel;
	year: number;
	month: number | null;
	reflection: string;
	createdAt: Date;
	updatedAt: Date;
}

export interface NewObjectiveReflectionRow {
	id: string;
	userId: string;
	level: ObjectiveLevel;
	year: number;
	month?: number | null;
	reflection?: string;
	createdAt?: Date;
	updatedAt?: Date;
}

// ---------------------------------------------------------------------------
// time_periods
// ---------------------------------------------------------------------------

export type PeriodType = 'yearly' | 'monthly' | 'weekly' | 'daily';

export interface TimePeriodRow {
	id: string;
	userId: string;
	periodType: PeriodType;
	year: number;
	month: number | null;
	week: number | null;
	day: string | null;
	notes: string | null;
	reviewWhatWorked: string | null;
	reviewImprovements: string | null;
	createdAt: Date;
	updatedAt: Date;
}

export interface NewTimePeriodRow {
	id: string;
	userId: string;
	periodType: PeriodType;
	year: number;
	month?: number | null;
	week?: number | null;
	day?: string | null;
	notes?: string | null;
	reviewWhatWorked?: string | null;
	reviewImprovements?: string | null;
	createdAt?: Date;
	updatedAt?: Date;
}

// ---------------------------------------------------------------------------
// tasks
//
// Mirrors the full `tasks` table: every current field is represented, including
// the `time_period_id` FK, timer/attribute fields and the large-duration
// `time_spent_ms` codec (a safe JS integer that may exceed 32 bits).
// ---------------------------------------------------------------------------

export interface TaskRow {
	id: string;
	userId: string;
	timePeriodId: string;
	title: string;
	completed: boolean;
	completedAt: Date | null;
	sortOrder: number;
	/** Cumulative milliseconds; a safe JS integer that may exceed 32 bits. */
	timeSpentMs: number;
	timerStartedAt: Date | null;
	createdAt: Date;
	updatedAt: Date;
}

export interface NewTaskRow {
	id: string;
	userId: string;
	timePeriodId: string;
	title: string;
	completed?: boolean;
	completedAt?: Date | null;
	sortOrder?: number;
	timeSpentMs?: number;
	timerStartedAt?: Date | null;
	createdAt?: Date;
	updatedAt?: Date;
}

export interface TaskPatch {
	title?: string;
	completed?: boolean;
	completedAt?: Date | null;
	sortOrder?: number;
	timeSpentMs?: number;
	timerStartedAt?: Date | null;
	updatedAt?: Date;
}

/** A task enriched with its flexible attributes map and tag links (T018/T019). */
export interface TaskWithDetails extends TaskRow {
	attributes: Record<string, string>;
	tagIds: string[];
}

/**
 * Flexible task attributes as supplied by the API. Null/undefined entries are
 * skipped; `valueType` is derived from the JS type (`number` -> 'number',
 * anything else -> 'text'), matching the existing route behavior exactly.
 */
export interface TaskAttributesInput {
	[key: string]: string | number | boolean | null | undefined;
}

/** Input for the bounded atomic task-create operation (task + attributes + tags). */
export interface CreateTaskWithDetailsInput {
	task: NewTaskRow;
	attributes?: TaskAttributesInput;
	tagIds?: string[];
}

/** Input for the bounded atomic task-update operation. */
export interface UpdateTaskWithDetailsInput {
	id: string;
	patch: TaskPatch;
	attributes?: TaskAttributesInput;
	tagIds?: string[];
}

// ---------------------------------------------------------------------------
// time_periods patch
// ---------------------------------------------------------------------------

export interface TimePeriodPatch {
	notes?: string | null;
	reviewWhatWorked?: string | null;
	reviewImprovements?: string | null;
	updatedAt?: Date;
}

// ---------------------------------------------------------------------------
// time_commitments
// ---------------------------------------------------------------------------

export interface TimeCommitmentRow {
	timePeriodId: string;
	numberOfWeeks: number;
	availableHoursPerWeekday: number;
	availableHoursPerWeekend: number;
}

export interface NewTimeCommitmentRow {
	timePeriodId: string;
	numberOfWeeks?: number;
	availableHoursPerWeekday?: number;
	availableHoursPerWeekend?: number;
}

// ---------------------------------------------------------------------------
// task_attributes
// ---------------------------------------------------------------------------

export type TaskAttributeValueType = 'number' | 'time' | 'text' | 'boolean';

export interface TaskAttributeRow {
	id: string;
	taskId: string;
	key: string;
	value: string;
	valueType: TaskAttributeValueType;
}

export interface NewTaskAttributeRow {
	id: string;
	taskId: string;
	key: string;
	value: string;
	valueType?: TaskAttributeValueType;
}

// ---------------------------------------------------------------------------
// tags
// ---------------------------------------------------------------------------

export interface TagRow {
	id: string;
	userId: string;
	name: string;
	color: string | null;
	category: string | null;
}

export interface NewTagRow {
	id: string;
	userId: string;
	name: string;
	color?: string | null;
	category?: string | null;
}

export interface TagPatch {
	name?: string;
	color?: string | null;
	category?: string | null;
}

// ---------------------------------------------------------------------------
// task_tags (composite link; duplicate pairs permitted by the current schema)
// ---------------------------------------------------------------------------

export interface TaskTagRow {
	taskId: string;
	tagId: string;
}

// ---------------------------------------------------------------------------
// daily_metrics (fixed columns)
// ---------------------------------------------------------------------------

export interface DailyMetricsRow {
	id: string;
	userId: string;
	timePeriodId: string;
	previousNightBedTime: string | null;
	wakeUpTime: string | null;
	sleepLength: string | null;
	cardioLoad: number | null;
	fitbitReadiness: number | null;
	steps: number | null;
	heartPoints: number | null;
	restingHeartRate: number | null;
	customMetrics: string | null;
}

export interface NewDailyMetricsRow {
	id: string;
	userId: string;
	timePeriodId: string;
	previousNightBedTime?: string | null;
	wakeUpTime?: string | null;
	sleepLength?: string | null;
	cardioLoad?: number | null;
	fitbitReadiness?: number | null;
	steps?: number | null;
	heartPoints?: number | null;
	restingHeartRate?: number | null;
	customMetrics?: string | null;
}

export interface DailyMetricsPatch {
	previousNightBedTime?: string | null;
	wakeUpTime?: string | null;
	sleepLength?: string | null;
	cardioLoad?: number | null;
	fitbitReadiness?: number | null;
	steps?: number | null;
	heartPoints?: number | null;
	restingHeartRate?: number | null;
	customMetrics?: string | null;
}

// ---------------------------------------------------------------------------
// metrics_templates (versioned by effectiveFrom)
// ---------------------------------------------------------------------------

export interface MetricsTemplateRow {
	id: string;
	userId: string;
	name: string;
	effectiveFrom: string;
	metricsDefinition: string;
	createdAt: Date;
	updatedAt: Date;
}

export interface NewMetricsTemplateRow {
	id: string;
	userId: string;
	name?: string;
	effectiveFrom: string;
	metricsDefinition: string;
	createdAt?: Date;
	updatedAt?: Date;
}

export interface MetricsTemplatePatch {
	name?: string;
	effectiveFrom?: string;
	metricsDefinition?: string;
	updatedAt?: Date;
}

// ---------------------------------------------------------------------------
// daily_metric_values (flexible metrics; value stored as text)
// ---------------------------------------------------------------------------

export interface DailyMetricValueRow {
	id: string;
	userId: string;
	date: string;
	metricName: string;
	value: string | null;
	source: string;
}

export interface NewDailyMetricValueRow {
	id: string;
	userId: string;
	date: string;
	metricName: string;
	value?: string | null;
	source: string;
}

export interface DailyMetricValuePatch {
	value?: string | null;
	source?: string;
}

// ---------------------------------------------------------------------------
// values (WP06 backup/restore; no standalone repository yet)
// ---------------------------------------------------------------------------

export interface ValueRow {
	id: string;
	userId: string;
	title: string;
	rank: number;
	description: string | null;
	createdAt: Date;
	updatedAt: Date;
}

export interface NewValueRow {
	id: string;
	userId: string;
	title: string;
	rank: number;
	description?: string | null;
	createdAt?: Date;
	updatedAt?: Date;
}

// ---------------------------------------------------------------------------
// principles (nested under values; orphan rows have valueId null)
// ---------------------------------------------------------------------------

export interface PrincipleRow {
	id: string;
	userId: string;
	valueId: string | null;
	title: string;
	description: string | null;
	examples: string | null;
	createdAt: Date;
	updatedAt: Date;
}

export interface NewPrincipleRow {
	id: string;
	userId: string;
	valueId?: string | null;
	title: string;
	description?: string | null;
	examples?: string | null;
	createdAt?: Date;
	updatedAt?: Date;
}

// ---------------------------------------------------------------------------
// saved_queries (referenced by name from key results and widgets on restore)
// ---------------------------------------------------------------------------

export type SavedQueryType = 'progress' | 'widget' | 'general';

export interface SavedQueryRow {
	id: string;
	userId: string;
	name: string;
	description: string | null;
	queryType: SavedQueryType;
	code: string;
	createdAt: Date;
	updatedAt: Date;
}

export interface NewSavedQueryRow {
	id: string;
	userId: string;
	name: string;
	description?: string | null;
	queryType: SavedQueryType;
	code: string;
	createdAt?: Date;
	updatedAt?: Date;
}

// ---------------------------------------------------------------------------
// dashboard_widgets (config is a JSON string that may reference a saved query)
// ---------------------------------------------------------------------------

export type WidgetType = 'builtin' | 'custom' | 'saved';

export interface DashboardWidgetRow {
	id: string;
	userId: string;
	title: string;
	widgetType: WidgetType;
	config: string;
	sortOrder: number;
	page: string;
	createdAt: Date;
}

export interface NewDashboardWidgetRow {
	id: string;
	userId: string;
	title: string;
	widgetType: WidgetType;
	config: string;
	sortOrder?: number;
	page: string;
	createdAt?: Date;
}

// ---------------------------------------------------------------------------
// plugins
// ---------------------------------------------------------------------------

export interface PluginRow {
	id: string;
	userId: string;
	pluginId: string;
	enabled: boolean;
	/** JSON string of `{ credentials, settings }`; null when absent. */
	config: string | null;
	lastSync: Date | null;
	createdAt: Date;
}

export interface NewPluginRow {
	id: string;
	userId: string;
	pluginId: string;
	enabled?: boolean;
	config?: string | null;
	lastSync?: Date | null;
	createdAt?: Date;
}

export interface PluginPatch {
	enabled?: boolean;
	config?: string | null;
	lastSync?: Date | null;
}

// ---------------------------------------------------------------------------
// user_ai_config
// ---------------------------------------------------------------------------

/** Supported AI provider identifiers (matches the schema enum and the server `AiProvider` union). */
export type AiProviderId = 'anthropic' | 'openai' | 'gemini' | 'openrouter' | 'ollama';

export interface UserAiConfigRow {
	id: string;
	userId: string;
	provider: AiProviderId;
	/** JSON string of `{ provider: { apiKey?, models?, baseUrl?, model? } }`. */
	providersConfig: string | null;
	customSystemPrompt: string | null;
	maxAgentRounds: number;
	createdAt: Date;
	updatedAt: Date;
}

export interface NewUserAiConfigRow {
	id: string;
	userId: string;
	provider?: AiProviderId;
	providersConfig?: string | null;
	customSystemPrompt?: string | null;
	maxAgentRounds?: number;
	createdAt?: Date;
	updatedAt?: Date;
}

export interface UserAiConfigPatch {
	provider?: AiProviderId;
	providersConfig?: string | null;
	customSystemPrompt?: string | null;
	maxAgentRounds?: number;
	updatedAt?: Date;
}

// ---------------------------------------------------------------------------
// query_execution_logs
// ---------------------------------------------------------------------------

export interface QueryExecutionLogRow {
	id: string;
	userId: string;
	codeSnippet: string;
	success: boolean;
	errorMessage: string | null;
	executionTimeMs: number | null;
	createdAt: Date;
}

export interface NewQueryExecutionLogRow {
	id: string;
	userId: string;
	codeSnippet: string;
	success: boolean;
	errorMessage?: string | null;
	executionTimeMs?: number | null;
	createdAt?: Date;
}

// ---------------------------------------------------------------------------
// friend_requests
// ---------------------------------------------------------------------------

export type FriendRequestStatus = 'pending' | 'accepted' | 'declined';

export interface FriendRequestRow {
	id: string;
	fromUserId: string;
	toUserId: string;
	status: FriendRequestStatus;
	createdAt: Date;
	respondedAt: Date | null;
}

export interface NewFriendRequestRow {
	id: string;
	fromUserId: string;
	toUserId: string;
	status?: FriendRequestStatus;
	createdAt?: Date;
	respondedAt?: Date | null;
}

// ---------------------------------------------------------------------------
// friendships
// ---------------------------------------------------------------------------

export interface FriendshipRow {
	id: string;
	userId1: string;
	userId2: string;
	createdAt: Date;
}

export interface NewFriendshipRow {
	id: string;
	userId1: string;
	userId2: string;
	createdAt?: Date;
}

// ---------------------------------------------------------------------------
// friend_notes (private, visible only to their author)
// ---------------------------------------------------------------------------

export interface FriendNoteRow {
	id: string;
	userId: string;
	friendId: string;
	note: string;
	updatedAt: Date;
}

export interface NewFriendNoteRow {
	id: string;
	userId: string;
	friendId: string;
	note?: string;
	updatedAt?: Date;
}

// ---------------------------------------------------------------------------
// Shared metric / key-result types (moved from the legacy `schema.ts`).
//
// These are plain canonical types used by the metrics template system and key
// result checkbox items. Moving them here lets frontend `.svelte` files and
// server modules import them from the canonical models instead of the legacy
// dialect schema, so no consumer depends on a raw Drizzle table definition.
// ---------------------------------------------------------------------------

export interface MetricDefinition {
	name: string;
	label: string;
	type: 'input' | 'computed' | 'external';
	inputType?: 'number' | 'time' | 'text' | 'boolean';
	unit?: string;
	/** JS code for computed metrics */
	expression?: string;
	/** e.g. 'fitbit.sleep_length' for external metrics */
	source?: string;
}

/** Checkbox item for Key Results */
export interface CheckboxItem {
	id: string;
	label: string;
	completed: boolean;
}
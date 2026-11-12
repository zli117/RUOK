/**
 * Canonical snapshot → version-2 document conversion (FR-008 / T021 / T022).
 *
 * Converts a {@link BackupSnapshot} (produced by an adapter inside a single
 * consistent transaction) into the version-2 wire document. All reference
 * resolution here is *logical* (id → name/index) so the resulting document is
 * backend-independent and can be restored into either backend.
 *
 * Field coverage ledger (version-2 export scope):
 *  - values + nested principles, orphan principles
 *  - tags (name/color/category)
 *  - saved queries
 *  - objectives (title/description/level/year/month/weight/category/colorIndex
 *    + parentIndex) with nested key results (title/details/weight/score/
 *    scoreLabel/expectedHours/sortOrder/measurementType/checkboxItems +
 *    progress/widget query name + code)
 *  - time periods with nested timeCommitment, dailyMetrics and tasks (with
 *    attributes + tag names)
 *  - dashboard widgets (config JSON references a saved query by name)
 *  - metrics templates, daily metric values, objective reflections
 *  - user preferences (timezone / weekStartDay / bgColor)
 *
 * Intentionally excluded (installation-wide, not user-scoped): users/sessions
 * beyond the exporting user's preferences, friendships, friend notes, query
 * execution logs, global system config, plugin credentials, AI configuration
 * and secret material. Installation secrets are never exported.
 */
import { BACKUP_VERSION } from './types';
import type {
	BackupData,
	BackupDocumentV2,
	BackupPreferences,
	BackupSnapshot,
	DailyMetricsExport,
	KeyResultExport,
	ObjectiveExport,
	PrincipleExport,
	ReflectionExport,
	SavedQueryExport,
	TagExport,
	TaskExport,
	TimeCommitmentExport,
	TimePeriodExport,
	ValueExport,
	WidgetExport
} from './types';
import type {
	DailyMetricsRow,
	KeyResultRow,
	PrincipleRow,
	TaskAttributeRow,
	TaskRow,
	TaskTagRow,
	TimeCommitmentRow,
	UserRow
} from '../models';

/** ISO-8601 timestamp string as produced by the existing export. */
function iso(date: Date): string {
	return date instanceof Date && !Number.isNaN(date.getTime()) ? date.toISOString() : '';
}

function preferencesFromUser(user: UserRow): BackupPreferences {
	return {
		timezone: user.timezone ?? 'UTC',
		weekStartDay: user.weekStartDay ?? 'monday',
		bgColor: user.bgColor ?? null
	};
}

/**
 * Rewrite a dashboard widget's JSON `config` so a saved-query reference is
 * carried by *name* (stable across backend restores) instead of the volatile
 * id. The existing format is `{ "queryId": "...", "code": "..." }`; the
 * exported form becomes `{ "queryName": "...", "code": "..." }`. Unparseable
 * or non-object configs are preserved verbatim; a query id that cannot be
 * resolved is dropped deterministically (never exported).
 */
function remapWidgetConfigForExport(config: string, queryIdToName: Map<string, string>): string {
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(config);
	} catch {
		return config;
	}
	if (!parsed || typeof parsed !== 'object') return config;
	const queryId = parsed['queryId'];
	delete parsed['queryId'];
	if (typeof queryId === 'string') {
		const name = queryIdToName.get(queryId);
		parsed['queryName'] = name ?? null;
	}
	return JSON.stringify(parsed);
}

/** Build the complete version-2 backup document from a consistent snapshot. */
export function buildExportDocument(snapshot: BackupSnapshot): BackupDocumentV2 {
	const {
		user,
		values,
		principles,
		tags,
		savedQueries,
		objectives,
		keyResults,
		timePeriods,
		timeCommitments,
		tasks,
		taskAttributes,
		taskTags,
		dailyMetrics,
		dashboardWidgets,
		metricsTemplates,
		dailyMetricValues,
		objectiveReflections
	} = snapshot;

	const tagIdToName = new Map(tags.map((t) => [t.id, t.name]));
	const queryIdToName = new Map(savedQueries.map((q) => [q.id, q.name]));
	const objectiveIdToIndex = new Map(objectives.map((o, i) => [o.id, i]));

	const valuesExport: ValueExport[] = values.map((v) => ({
		title: v.title,
		rank: v.rank,
		description: v.description,
		createdAt: iso(v.createdAt),
		updatedAt: iso(v.updatedAt),
		principles: principles.filter((p) => p.valueId === v.id).map(toPrincipleExport)
	}));

	const orphanPrinciples: PrincipleExport[] = principles
		.filter((p) => !p.valueId)
		.map(toPrincipleExport);

	const tagsExport: TagExport[] = tags.map((t) => ({
		name: t.name,
		color: t.color,
		category: t.category
	}));

	const savedQueriesExport: SavedQueryExport[] = savedQueries.map((q) => ({
		name: q.name,
		description: q.description,
		queryType: q.queryType,
		code: q.code,
		createdAt: iso(q.createdAt),
		updatedAt: iso(q.updatedAt)
	}));

	const objectivesExport: ObjectiveExport[] = objectives.map((o) => ({
		title: o.title,
		description: o.description,
		level: o.level,
		year: o.year,
		month: o.month,
		weight: o.weight,
		category: o.category,
		colorIndex: o.colorIndex,
		parentIndex: o.parentId ? (objectiveIdToIndex.get(o.parentId) ?? null) : null,
		createdAt: iso(o.createdAt),
		updatedAt: iso(o.updatedAt),
		keyResults: keyResults
			.filter((kr) => kr.objectiveId === o.id)
			.map((kr) => toKeyResultExport(kr, queryIdToName))
	}));

	const timePeriodsExport: TimePeriodExport[] = timePeriods.map((tp) => {
		const tpTasks = tasks.filter((t) => t.timePeriodId === tp.id);
		const tpMetrics = dailyMetrics.find((m) => m.timePeriodId === tp.id) ?? null;
		const tpCommitment = timeCommitments.find((c) => c.timePeriodId === tp.id) ?? null;

		return {
			periodType: tp.periodType,
			year: tp.year,
			month: tp.month,
			week: tp.week,
			day: tp.day,
			notes: tp.notes,
			reviewWhatWorked: tp.reviewWhatWorked,
			reviewImprovements: tp.reviewImprovements,
			createdAt: iso(tp.createdAt),
			updatedAt: iso(tp.updatedAt),
			timeCommitment: tpCommitment ? toTimeCommitmentExport(tpCommitment) : null,
			dailyMetrics: tpMetrics ? toDailyMetricsExport(tpMetrics) : null,
			tasks: tpTasks.map((t) => toTaskExport(t, taskAttributes, taskTags, tagIdToName))
		};
	});

	const widgetsExport: WidgetExport[] = dashboardWidgets.map((w) => ({
		title: w.title,
		widgetType: w.widgetType,
		config: remapWidgetConfigForExport(w.config, queryIdToName),
		sortOrder: w.sortOrder,
		page: w.page,
		createdAt: iso(w.createdAt)
	}));

	const metricsTemplatesExport = metricsTemplates.map((mt) => ({
		name: mt.name,
		effectiveFrom: mt.effectiveFrom,
		metricsDefinition: mt.metricsDefinition,
		createdAt: iso(mt.createdAt),
		updatedAt: iso(mt.updatedAt)
	}));

	const dailyMetricValuesExport = dailyMetricValues.map((mv) => ({
		date: mv.date,
		metricName: mv.metricName,
		value: mv.value,
		source: mv.source
	}));

	const reflectionsExport: ReflectionExport[] = objectiveReflections.map((r) => ({
		level: r.level,
		year: r.year,
		month: r.month,
		reflection: r.reflection,
		createdAt: iso(r.createdAt),
		updatedAt: iso(r.updatedAt)
	}));

	const data: BackupData = {
		values: valuesExport,
		orphanPrinciples,
		tags: tagsExport,
		savedQueries: savedQueriesExport,
		objectives: objectivesExport,
		timePeriods: timePeriodsExport,
		dashboardWidgets: widgetsExport,
		metricsTemplates: metricsTemplatesExport,
		dailyMetricValues: dailyMetricValuesExport,
		objectiveReflections: reflectionsExport
	};

	return {
		version: BACKUP_VERSION,
		exportedAt: new Date().toISOString(),
		preferences: preferencesFromUser(user),
		data
	};
}

function toPrincipleExport(p: PrincipleRow): PrincipleExport {
	return {
		title: p.title,
		description: p.description,
		examples: p.examples,
		createdAt: iso(p.createdAt),
		updatedAt: iso(p.updatedAt)
	};
}

function toKeyResultExport(kr: KeyResultRow, queryIdToName: Map<string, string>): KeyResultExport {
	return {
		title: kr.title,
		details: kr.details,
		weight: kr.weight,
		score: kr.score,
		scoreLabel: kr.scoreLabel,
		expectedHours: kr.expectedHours,
		sortOrder: kr.sortOrder,
		measurementType: kr.measurementType,
		checkboxItems: kr.checkboxItems,
		progressQueryName: kr.progressQueryId ? (queryIdToName.get(kr.progressQueryId) ?? null) : null,
		progressQueryCode: kr.progressQueryCode,
		widgetQueryName: kr.widgetQueryId ? (queryIdToName.get(kr.widgetQueryId) ?? null) : null,
		widgetQueryCode: kr.widgetQueryCode,
		createdAt: iso(kr.createdAt),
		updatedAt: iso(kr.updatedAt)
	};
}

function toTimeCommitmentExport(c: TimeCommitmentRow): TimeCommitmentExport {
	return {
		numberOfWeeks: c.numberOfWeeks,
		availableHoursPerWeekday: c.availableHoursPerWeekday,
		availableHoursPerWeekend: c.availableHoursPerWeekend
	};
}

function toDailyMetricsExport(m: DailyMetricsRow): DailyMetricsExport {
	return {
		previousNightBedTime: m.previousNightBedTime,
		wakeUpTime: m.wakeUpTime,
		sleepLength: m.sleepLength,
		cardioLoad: m.cardioLoad,
		fitbitReadiness: m.fitbitReadiness,
		steps: m.steps,
		heartPoints: m.heartPoints,
		restingHeartRate: m.restingHeartRate,
		customMetrics: m.customMetrics
	};
}

function toTaskExport(
	t: TaskRow,
	attributes: TaskAttributeRow[],
	links: TaskTagRow[],
	tagIdToName: Map<string, string>
): TaskExport {
	return {
		title: t.title,
		completed: t.completed,
		completedAt: t.completedAt ? iso(t.completedAt) : null,
		sortOrder: t.sortOrder,
		timeSpentMs: t.timeSpentMs,
		timerStartedAt: t.timerStartedAt ? iso(t.timerStartedAt) : null,
		createdAt: iso(t.createdAt),
		updatedAt: iso(t.updatedAt),
		attributes: attributes
			.filter((a) => a.taskId === t.id)
			.map((a) => ({ key: a.key, value: a.value, valueType: a.valueType })),
		tagNames: links
			.filter((l) => l.taskId === t.id)
			.map((l) => tagIdToName.get(l.tagId))
			.filter((name): name is string => Boolean(name))
	};
}
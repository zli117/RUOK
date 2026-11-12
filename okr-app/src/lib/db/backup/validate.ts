/**
 * Version-2 backup validation + restore command planning (FR-008 / T021 / T022).
 *
 * `buildRestorePlan` parses an incoming backup document, validates the *whole*
 * document (version, types, names, references, sizes) and produces a fully
 * resolved, typed {@link RestoreCommandPlan} BEFORE any row is mutated.
 *
 * Deterministic rejection rules (pre-mutation validation errors):
 *  - unsupported `version` (only 2) is rejected immediately;
 *  - duplicate tag names (ambiguous task→tag link) are rejected;
 *  - duplicate saved-query names (ambiguous KR/widget reference) are rejected;
 *  - a key-result `progressQueryName` / `widgetQueryName` that does not resolve
 *    to a saved query in the backup is rejected;
 *  - an objective `parentIndex` that is out of range is rejected;
 *  - a task `tagNames` entry that does not resolve to a tag in the backup is
 *    rejected;
 *  - a widget config `queryName` that does not resolve to a saved query in the
 *    backup is rejected.
 *
 * Every produced id is a fresh `crypto.randomUUID()` and every reference in the
 * returned plan is an explicit, resolvable id/value. The adapter only executes
 * the plan inside a single atomic transaction.
 */
import crypto from 'node:crypto';
import { BACKUP_VERSION } from './types';
import type {
	BackupDocumentV2,
	BackupPreferences,
	ObjectiveRestoreEntry,
	RestoreCommandPlan,
	RestoreStats,
	TaskRestoreEntry,
	TimePeriodRestoreEntry,
	ValueRestoreEntry
} from './types';
import type {
	NewDailyMetricValueRow,
	NewDailyMetricsRow,
	NewDashboardWidgetRow,
	NewKeyResultRow,
	NewMetricsTemplateRow,
	NewObjectiveReflectionRow,
	NewObjectiveRow,
	NewPrincipleRow,
	NewSavedQueryRow,
	NewTagRow,
	NewTaskAttributeRow,
	NewTaskRow,
	NewTimePeriodRow,
	NewValueRow,
	WeekStartDay
} from '../models';

/** A validation failure. `code` lets callers distinguish deterministic reasons. */
export class BackupValidationError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = 'BackupValidationError';
		this.code = code;
	}
}

function newId(): string {
	return crypto.randomUUID();
}

function fail(code: string, message: string): never {
	throw new BackupValidationError(code, message);
}

function requireString(value: unknown, what: string): string {
	if (typeof value !== 'string' || value.length === 0) {
		fail('invalid_field', `${what} must be a non-empty string`);
	}
	return value;
}

function optionalString(value: unknown): string | null {
	return typeof value === 'string' ? value : null;
}

function requireNumber(value: unknown, what: string): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		fail('invalid_field', `${what} must be a finite number`);
	}
	return value;
}

function optionalNumber(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function requireBoolean(value: unknown, what: string): boolean {
	if (typeof value !== 'boolean') fail('invalid_field', `${what} must be a boolean`);
	return value;
}

function requireArray(value: unknown, what: string): unknown[] {
	if (!Array.isArray(value)) fail('invalid_field', `${what} must be an array`);
	return value;
}

function toDate(value: unknown): Date | null {
	if (value === undefined || value === null) return null;
	if (value instanceof Date) return value;
	if (typeof value === 'string') {
		const d = new Date(value);
		return Number.isNaN(d.getTime()) ? null : d;
	}
	if (typeof value === 'number') {
		const d = new Date(value);
		return Number.isNaN(d.getTime()) ? null : d;
	}
	return null;
}

function toDateRequired(value: unknown, what: string): Date {
	const d = toDate(value);
	if (!d) fail('invalid_field', `${what} must be a valid date`);
	return d;
}

/** Structural parse of the raw wire document (version + top-level shape). */
export function parseBackupDocument(raw: unknown): BackupDocumentV2 {
	if (typeof raw !== 'object' || raw === null) {
		fail('invalid_format', 'Backup must be a JSON object');
	}
	const doc = raw as Record<string, unknown>;
	if (doc.version === undefined || doc.data === undefined) {
		fail('invalid_format', 'Backup must include version and data');
	}
	if (typeof doc.version !== 'number' || doc.version !== BACKUP_VERSION) {
		fail(
			'unsupported_version',
			`Unsupported backup version: ${String(doc.version)}. Only version 2 is supported.`
		);
	}
	return doc as unknown as BackupDocumentV2;
}

/**
 * Validate the full document and produce the resolved command plan for
 * `userId`. No database mutation happens here.
 */
export function buildRestorePlan(raw: unknown, userId: string): RestoreCommandPlan {
	const doc = parseBackupDocument(raw);
	const data = (doc.data as unknown as Record<string, unknown>) ??
		fail('invalid_format', 'Backup data is missing');

	const preferences = normalizePreferences(doc.preferences);

	// ---- tags: id per unique name (reject collisions) ---------------------
	const tags: NewTagRow[] = [];
	const tagNameToId = new Map<string, string>();
	for (const t of requireArray(data['tags'] ?? [], 'data.tags') as Array<Record<string, unknown>>) {
		const name = requireString(t?.name, 'tag.name');
		if (tagNameToId.has(name)) fail('duplicate_tag_name', `Duplicate tag name '${name}'`);
		const id = newId();
		tagNameToId.set(name, id);
		tags.push({ id, userId, name, color: optionalString(t?.color), category: optionalString(t?.category) });
	}

	// ---- saved queries: id per unique name (reject collisions) -------------
	const savedQueries: NewSavedQueryRow[] = [];
	const queryNameToId = new Map<string, string>();
	for (const q of requireArray(data['savedQueries'] ?? [], 'data.savedQueries') as Array<
		Record<string, unknown>
	>) {
		const name = requireString(q?.name, 'savedQuery.name');
		if (queryNameToId.has(name)) fail('duplicate_query_name', `Duplicate saved query name '${name}'`);
		const id = newId();
		queryNameToId.set(name, id);
		savedQueries.push({
			id,
			userId,
			name,
			description: optionalString(q?.description),
			queryType: (q?.queryType as NewSavedQueryRow['queryType']) ?? 'general',
			code: (q?.code as string) ?? '',
			createdAt: toDateRequired(q?.createdAt, 'savedQuery.createdAt'),
			updatedAt: toDateRequired(q?.updatedAt, 'savedQuery.updatedAt')
		});
	}

	// ---- values (with nested principles) + orphan principles ----------------
	const values: ValueRestoreEntry[] = [];
	const orphanPrinciples: NewPrincipleRow[] = [];
	{
		const valueExports = requireArray(data['values'] ?? [], 'data.values') as Array<Record<string, unknown>>;
		for (const v of valueExports) {
			const valueId = newId();
			const value: NewValueRow = {
				id: valueId,
				userId,
				title: requireString(v?.title, 'value.title'),
				rank: (optionalNumber(v?.rank) as number | null) ?? 0,
				description: optionalString(v?.description),
				createdAt: toDateRequired(v?.createdAt, 'value.createdAt'),
				updatedAt: toDateRequired(v?.updatedAt, 'value.updatedAt')
			};
			const principles: NewPrincipleRow[] = [];
			for (const p of requireArray(v?.principles ?? [], 'value.principles') as Array<
				Record<string, unknown>
			>) {
				principles.push(makePrinciple(p, userId, valueId));
			}
			values.push({ value, principles });
		}
		for (const p of requireArray(data['orphanPrinciples'] ?? [], 'data.orphanPrinciples') as Array<
			Record<string, unknown>
		>) {
			orphanPrinciples.push(makePrinciple(p, userId, null));
		}
	}

	// ---- objectives (with nested key results + parentIndex) -----------------
	const objectives: ObjectiveRestoreEntry[] = [];
	{
		const objExports = requireArray(data['objectives'] ?? [], 'data.objectives') as Array<
			Record<string, unknown>
		>;
		for (const o of objExports) {
			const objective: NewObjectiveRow = {
				id: newId(),
				userId,
				title: requireString(o?.title, 'objective.title'),
				description: optionalString(o?.description),
				level: (o?.level as NewObjectiveRow['level']) ?? 'yearly',
				year: requireNumber(o?.year, 'objective.year'),
				month: optionalNumber(o?.month),
				weight: (optionalNumber(o?.weight) as number | null) ?? 1.0,
				parentId: null,
				category: optionalString(o?.category),
				colorIndex: optionalNumber(o?.colorIndex),
				createdAt: toDateRequired(o?.createdAt, 'objective.createdAt'),
				updatedAt: toDateRequired(o?.updatedAt, 'objective.updatedAt')
			};
			const keyResults: NewKeyResultRow[] = [];
			for (const kr of requireArray(o?.keyResults ?? [], 'objective.keyResults') as Array<
				Record<string, unknown>
			>) {
				keyResults.push(makeKeyResult(kr, objective.id, userId, queryNameToId));
			}
			objectives.push({ objective, keyResults });
		}
		// Resolve parentIndex → parentId (second pass, deterministic).
		for (let i = 0; i < objExports.length; i++) {
			const parentIndex = (objExports[i] as Record<string, unknown>)?.parentIndex;
			if (parentIndex === null || parentIndex === undefined) continue;
			if (
				typeof parentIndex !== 'number' ||
				!Number.isInteger(parentIndex) ||
				parentIndex < 0 ||
				parentIndex >= objectives.length
			) {
				fail('invalid_parent_index', `Objective at index ${i} has out-of-range parentIndex`);
			}
			objectives[i].objective.parentId = objectives[parentIndex].objective.id;
		}
	}

	// ---- time periods (with commitment, metrics, tasks) ---------------------
	const timePeriods: TimePeriodRestoreEntry[] = [];
	{
		const tpExports = requireArray(data['timePeriods'] ?? [], 'data.timePeriods') as Array<
			Record<string, unknown>
		>;
		for (const tp of tpExports) {
			timePeriods.push(makeTimePeriod(tp, userId, tagNameToId));
		}
	}

	// ---- dashboard widgets (config queryName → new query id) ----------------
	const dashboardWidgets: NewDashboardWidgetRow[] = [];
	{
		const widgetExports = requireArray(data['dashboardWidgets'] ?? [], 'data.dashboardWidgets') as Array<
			Record<string, unknown>
		>;
		for (const w of widgetExports) {
			dashboardWidgets.push({
				id: newId(),
				userId,
				title: requireString(w?.title, 'widget.title'),
				widgetType: (w?.widgetType as NewDashboardWidgetRow['widgetType']) ?? 'custom',
				config: remapWidgetConfigForRestore(w?.config, queryNameToId),
				sortOrder: (optionalNumber(w?.sortOrder) as number | null) ?? 0,
				page: (w?.page as string) ?? 'dashboard',
				createdAt: toDateRequired(w?.createdAt, 'widget.createdAt')
			});
		}
	}

	// ---- flat tables ---------------------------------------------------------
	const metricsTemplates: NewMetricsTemplateRow[] = (
		requireArray(data['metricsTemplates'] ?? [], 'data.metricsTemplates') as Array<
			Record<string, unknown>
		>
	).map((mt) => ({
		id: newId(),
		userId,
		name: (mt?.name as string) ?? 'default',
		effectiveFrom: requireString(mt?.effectiveFrom, 'metricsTemplate.effectiveFrom'),
		metricsDefinition: requireString(mt?.metricsDefinition, 'metricsTemplate.metricsDefinition'),
		createdAt: toDateRequired(mt?.createdAt, 'metricsTemplate.createdAt'),
		updatedAt: toDateRequired(mt?.updatedAt, 'metricsTemplate.updatedAt')
	}));

	const dailyMetricValues: NewDailyMetricValueRow[] = (
		requireArray(data['dailyMetricValues'] ?? [], 'data.dailyMetricValues') as Array<
			Record<string, unknown>
		>
	).map((mv) => ({
		id: newId(),
		userId,
		date: requireString(mv?.date, 'dailyMetricValue.date'),
		metricName: requireString(mv?.metricName, 'dailyMetricValue.metricName'),
		value: optionalString(mv?.value),
		source: (mv?.source as string) ?? 'user'
	}));

	const objectiveReflections: NewObjectiveReflectionRow[] = (
		requireArray(data['objectiveReflections'] ?? [], 'data.objectiveReflections') as Array<
			Record<string, unknown>
		>
	).map((r) => ({
		id: newId(),
		userId,
		level: (r?.level as NewObjectiveReflectionRow['level']) ?? 'yearly',
		year: requireNumber(r?.year, 'reflection.year'),
		month: optionalNumber(r?.month),
		reflection: (r?.reflection as string) ?? '',
		createdAt: toDateRequired(r?.createdAt, 'reflection.createdAt'),
		updatedAt: toDateRequired(r?.updatedAt, 'reflection.updatedAt')
	}));

	const stats = computeStats(
		values,
		orphanPrinciples,
		tags,
		savedQueries,
		objectives,
		timePeriods,
		dashboardWidgets,
		metricsTemplates,
		dailyMetricValues,
		objectiveReflections
	);

	return {
		userId,
		preferences,
		tags,
		values,
		orphanPrinciples,
		savedQueries,
		objectives,
		timePeriods,
		dashboardWidgets,
		metricsTemplates,
		dailyMetricValues,
		objectiveReflections,
		stats
	};
}

// ---------------------------------------------------------------------------

function normalizePreferences(prefs: BackupPreferences | undefined): BackupPreferences {
	const source = prefs ?? ({} as BackupPreferences);
	const weekStartDay = source.weekStartDay === 'sunday' ? 'sunday' : 'monday';
	return {
		timezone: source.timezone ?? 'UTC',
		weekStartDay: weekStartDay as WeekStartDay,
		bgColor: optionalString(source.bgColor)
	};
}

function makePrinciple(p: Record<string, unknown>, userId: string, valueId: string | null): NewPrincipleRow {
	return {
		id: newId(),
		userId,
		valueId,
		title: requireString(p?.title, 'principle.title'),
		description: optionalString(p?.description),
		examples: optionalString(p?.examples),
		createdAt: toDateRequired(p?.createdAt, 'principle.createdAt'),
		updatedAt: toDateRequired(p?.updatedAt, 'principle.updatedAt')
	};
}

function makeKeyResult(
	kr: Record<string, unknown>,
	objectiveId: string,
	userId: string,
	queryNameToId: Map<string, string>
): NewKeyResultRow {
	return {
		id: newId(),
		objectiveId,
		title: requireString(kr?.title, 'keyResult.title'),
		details: optionalString(kr?.details),
		weight: (optionalNumber(kr?.weight) as number | null) ?? 1.0,
		score: (optionalNumber(kr?.score) as number | null) ?? 0,
		scoreLabel: optionalString(kr?.scoreLabel),
		expectedHours: optionalNumber(kr?.expectedHours),
		sortOrder: (optionalNumber(kr?.sortOrder) as number | null) ?? 0,
		measurementType: (kr?.measurementType as NewKeyResultRow['measurementType']) ?? 'slider',
		checkboxItems: optionalString(kr?.checkboxItems),
		progressQueryId: resolveQuery(optionalString(kr?.progressQueryName), queryNameToId),
		progressQueryCode: optionalString(kr?.progressQueryCode),
		widgetQueryId: resolveQuery(optionalString(kr?.widgetQueryName), queryNameToId),
		widgetQueryCode: optionalString(kr?.widgetQueryCode),
		createdAt: toDateRequired(kr?.createdAt, 'keyResult.createdAt'),
		updatedAt: toDateRequired(kr?.updatedAt, 'keyResult.updatedAt')
	};
}

function resolveQuery(name: string | null, queryNameToId: Map<string, string>): string | null {
	if (name === null) return null;
	const id = queryNameToId.get(name);
	if (!id) fail('unresolved_query_reference', `Saved query '${name}' referenced but not present in backup`);
	return id;
}

function makeTimePeriod(
	tp: Record<string, unknown>,
	userId: string,
	tagNameToId: Map<string, string>
): TimePeriodRestoreEntry {
	const tpId = newId();
	const period: NewTimePeriodRow = {
		id: tpId,
		userId,
		periodType: (tp?.periodType as NewTimePeriodRow['periodType']) ?? 'yearly',
		year: requireNumber(tp?.year, 'timePeriod.year'),
		month: optionalNumber(tp?.month),
		week: optionalNumber(tp?.week),
		day: optionalString(tp?.day),
		notes: optionalString(tp?.notes),
		reviewWhatWorked: optionalString(tp?.reviewWhatWorked),
		reviewImprovements: optionalString(tp?.reviewImprovements),
		createdAt: toDateRequired(tp?.createdAt, 'timePeriod.createdAt'),
		updatedAt: toDateRequired(tp?.updatedAt, 'timePeriod.updatedAt')
	};

	const tc = tp?.timeCommitment;
	const commitment: TimePeriodRestoreEntry['commitment'] =
		tc && typeof tc === 'object'
			? {
					timePeriodId: tpId,
					numberOfWeeks:
						(optionalNumber((tc as Record<string, unknown>).numberOfWeeks) as number | null) ?? 4,
					availableHoursPerWeekday:
						(optionalNumber((tc as Record<string, unknown>).availableHoursPerWeekday) as
							| number
							| null) ?? 1.5,
					availableHoursPerWeekend:
						(optionalNumber((tc as Record<string, unknown>).availableHoursPerWeekend) as
							| number
							| null) ?? 8.0
				}
			: null;

	const dm = tp?.dailyMetrics;
	let dailyMetrics: NewDailyMetricsRow | null = null;
	if (dm && typeof dm === 'object') {
		const m = dm as Record<string, unknown>;
		dailyMetrics = {
			id: newId(),
			userId,
			timePeriodId: tpId,
			previousNightBedTime: optionalString(m?.previousNightBedTime),
			wakeUpTime: optionalString(m?.wakeUpTime),
			sleepLength: optionalString(m?.sleepLength),
			cardioLoad: optionalNumber(m?.cardioLoad),
			fitbitReadiness: optionalNumber(m?.fitbitReadiness),
			steps: optionalNumber(m?.steps),
			heartPoints: optionalNumber(m?.heartPoints),
			restingHeartRate: optionalNumber(m?.restingHeartRate),
			customMetrics: optionalString(m?.customMetrics)
		};
	}

	const tasks: TaskRestoreEntry[] = [];
	for (const t of requireArray(tp?.tasks ?? [], 'timePeriod.tasks') as Array<Record<string, unknown>>) {
		tasks.push(makeTask(t, tpId, userId, tagNameToId));
	}

	return { period, commitment, dailyMetrics, tasks };
}

function makeTask(
	t: Record<string, unknown>,
	timePeriodId: string,
	userId: string,
	tagNameToId: Map<string, string>
): TaskRestoreEntry {
	const taskId = newId();
	const task: NewTaskRow = {
		id: taskId,
		userId,
		timePeriodId,
		title: requireString(t?.title, 'task.title'),
		completed: t?.completed === undefined ? false : requireBoolean(t?.completed, 'task.completed'),
		completedAt: toDate(t?.completedAt),
		sortOrder: (optionalNumber(t?.sortOrder) as number | null) ?? 0,
		timeSpentMs: (optionalNumber(t?.timeSpentMs) as number | null) ?? 0,
		timerStartedAt: toDate(t?.timerStartedAt),
		createdAt: toDateRequired(t?.createdAt, 'task.createdAt'),
		updatedAt: toDateRequired(t?.updatedAt, 'task.updatedAt')
	};

	const attributes: NewTaskAttributeRow[] = [];
	for (const a of requireArray(t?.attributes ?? [], 'task.attributes') as Array<Record<string, unknown>>) {
		attributes.push({
			id: newId(),
			taskId,
			key: requireString(a?.key, 'taskAttribute.key'),
			value: (a?.value as string) ?? '',
			valueType: (a?.valueType as NewTaskAttributeRow['valueType']) ?? 'number'
		});
	}

	const tagIds: string[] = [];
	for (const tagName of requireArray(t?.tagNames ?? [], 'task.tagNames') as unknown[]) {
		if (typeof tagName !== 'string') fail('invalid_field', 'task.tagNames entries must be strings');
		const tagId = tagNameToId.get(tagName);
		if (!tagId) fail('unresolved_tag_reference', `Tag '${tagName}' referenced but not present in backup`);
		tagIds.push(tagId);
	}

	return { task, attributes, tagIds };
}

/** Rewrite a widget config so a saved-query *name* is mapped to the new id. */
function remapWidgetConfigForRestore(config: unknown, queryNameToId: Map<string, string>): string {
	const raw = typeof config === 'string' ? config : config === undefined ? '{}' : JSON.stringify(config);
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return raw;
	}
	if (!parsed || typeof parsed !== 'object') return raw;
	const queryName = parsed['queryName'];
	delete parsed['queryName'];
	if (typeof queryName === 'string') {
		const id = queryNameToId.get(queryName);
		if (!id) {
			fail(
				'unresolved_query_reference',
				`Widget references saved query '${queryName}' not present in backup`
			);
		}
		parsed['queryId'] = id;
	} else if (queryName !== undefined && queryName !== null) {
		fail('invalid_field', 'widget.config.queryName must be a string');
	}
	return JSON.stringify(parsed);
}

// ---------------------------------------------------------------------------

function computeStats(
	values: ValueRestoreEntry[],
	orphanPrinciples: NewPrincipleRow[],
	tags: NewTagRow[],
	savedQueries: NewSavedQueryRow[],
	objectives: ObjectiveRestoreEntry[],
	timePeriods: TimePeriodRestoreEntry[],
	dashboardWidgets: NewDashboardWidgetRow[],
	metricsTemplates: NewMetricsTemplateRow[],
	dailyMetricValues: NewDailyMetricValueRow[],
	objectiveReflections: NewObjectiveReflectionRow[]
): RestoreStats {
	let taskCount = 0;
	let taskAttrCount = 0;
	let taskTagCount = 0;
	let metricsCount = 0;
	let commitmentCount = 0;
	for (const tp of timePeriods) {
		if (tp.commitment) commitmentCount++;
		if (tp.dailyMetrics) metricsCount++;
		for (const task of tp.tasks) {
			taskCount++;
			taskAttrCount += task.attributes.length;
			taskTagCount += task.tagIds.length;
		}
	}
	let principleCount = 0;
	for (const v of values) principleCount += v.principles.length;
	principleCount += orphanPrinciples.length;
	let krCount = 0;
	for (const o of objectives) krCount += o.keyResults.length;
	return {
		tags: tags.length,
		values: values.length,
		principles: principleCount,
		savedQueries: savedQueries.length,
		objectives: objectives.length,
		keyResults: krCount,
		timePeriods: timePeriods.length,
		tasks: taskCount,
		taskAttributes: taskAttrCount,
		taskTags: taskTagCount,
		dailyMetrics: metricsCount,
		timeCommitments: commitmentCount,
		dashboardWidgets: dashboardWidgets.length,
		metricsTemplates: metricsTemplates.length,
		dailyMetricValues: dailyMetricValues.length,
		objectiveReflections: objectiveReflections.length
	};
}
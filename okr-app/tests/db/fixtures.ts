/**
 * Isolated real-backend fixtures for the shared persistence contract suite.
 *
 * - SQLite    : a fresh temp database file (created + dropped per fixture).
 * - PostgreSQL: a disposable database created + dropped per fixture using an
 *   admin connection (`RUOK_TEST_PG_ADMIN_URL`, which must have CREATEDB).
 *
 * The table DDL mirrors the dialect schemas in `src/lib/db/schema/` for the
 * tables the contract suite exercises (users/objectives/key_results/
 * time_periods/tasks). The shared suite never substitutes SQLite for a missing
 * PostgreSQL service — if PostgreSQL is requested but unreachable, the test
 * fails.
 */
import Database from 'better-sqlite3';
import { Client } from 'pg';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createDatabaseServices } from '../../src/lib/db';
import type { DatabaseServices } from '../../src/lib/db/contracts';

export interface DbFixture {
	services: DatabaseServices;
	teardown(): Promise<void>;
}

// ---------------------------------------------------------------------------
// SQLite DDL
// ---------------------------------------------------------------------------
const SQLITE_DDL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  week_start_day TEXT NOT NULL DEFAULT 'monday',
  timezone TEXT NOT NULL DEFAULT 'UTC',
  bg_color TEXT,
  is_admin INTEGER NOT NULL DEFAULT 0,
  is_disabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS objectives (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  level TEXT NOT NULL,
  year INTEGER NOT NULL,
  month INTEGER,
  weight REAL NOT NULL DEFAULT 1.0,
  parent_id TEXT,
  category TEXT,
  color_index INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS key_results (
  id TEXT PRIMARY KEY,
  objective_id TEXT NOT NULL REFERENCES objectives(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  details TEXT,
  weight REAL NOT NULL DEFAULT 1.0,
  score REAL NOT NULL DEFAULT 0,
  score_label TEXT,
  expected_hours REAL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  measurement_type TEXT NOT NULL DEFAULT 'slider',
  checkbox_items TEXT,
  progress_query_id TEXT,
  progress_query_code TEXT,
  widget_query_id TEXT,
  widget_query_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS time_periods (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period_type TEXT NOT NULL,
  year INTEGER NOT NULL,
  month INTEGER,
  week INTEGER,
  day TEXT,
  notes TEXT,
  review_what_worked TEXT,
  review_improvements TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  time_period_id TEXT NOT NULL REFERENCES time_periods(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0,
  completed_at INTEGER,
  sort_order INTEGER NOT NULL DEFAULT 0,
  time_spent_ms INTEGER NOT NULL DEFAULT 0,
  timer_started_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS system_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  is_secret INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS objective_reflections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  level TEXT NOT NULL,
  year INTEGER NOT NULL,
  month INTEGER,
  reflection TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS task_attributes (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  value_type TEXT NOT NULL DEFAULT 'number'
);
CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT,
  category TEXT
);
CREATE TABLE IF NOT EXISTS task_tags (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS daily_metrics (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  time_period_id TEXT NOT NULL REFERENCES time_periods(id) ON DELETE CASCADE,
  previous_night_bed_time TEXT,
  wake_up_time TEXT,
  sleep_length TEXT,
  cardio_load INTEGER,
  fitbit_readiness INTEGER,
  steps INTEGER,
  heart_points INTEGER,
  resting_heart_rate INTEGER,
  custom_metrics TEXT
);
CREATE TABLE IF NOT EXISTS metrics_templates (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'default',
  effective_from TEXT NOT NULL,
  metrics_definition TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS daily_metric_values (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  metric_name TEXT NOT NULL,
  value TEXT,
  source TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS saved_queries (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  query_type TEXT NOT NULL DEFAULT 'general',
  code TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS dashboard_widgets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  widget_type TEXT NOT NULL,
  config TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  page TEXT NOT NULL DEFAULT 'dashboard',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS plugins (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plugin_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  config TEXT,
  last_sync INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS user_ai_config (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'anthropic',
  providers_config TEXT,
  custom_system_prompt TEXT,
  max_agent_rounds INTEGER NOT NULL DEFAULT 20,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS query_execution_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_snippet TEXT NOT NULL,
  success INTEGER NOT NULL,
  error_message TEXT,
  execution_time_ms INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS friend_requests (
  id TEXT PRIMARY KEY,
  from_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  responded_at INTEGER
);
CREATE TABLE IF NOT EXISTS friendships (
  id TEXT PRIMARY KEY,
  user_id_1 TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_id_2 TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS friend_notes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friend_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);
`;

// ---------------------------------------------------------------------------
// PostgreSQL DDL
// ---------------------------------------------------------------------------
const POSTGRES_DDL = `
CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  username text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  week_start_day text NOT NULL DEFAULT 'monday',
  timezone text NOT NULL DEFAULT 'UTC',
  bg_color text,
  is_admin boolean NOT NULL DEFAULT false,
  is_disabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS objectives (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text,
  level text NOT NULL,
  year integer NOT NULL,
  month integer,
  weight double precision NOT NULL DEFAULT 1.0,
  parent_id text,
  category text,
  color_index integer,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS key_results (
  id text PRIMARY KEY,
  objective_id text NOT NULL REFERENCES objectives(id) ON DELETE CASCADE,
  title text NOT NULL,
  details text,
  weight double precision NOT NULL DEFAULT 1.0,
  score double precision NOT NULL DEFAULT 0,
  score_label text,
  expected_hours double precision DEFAULT 0,
  sort_order integer NOT NULL DEFAULT 0,
  measurement_type text NOT NULL DEFAULT 'slider',
  checkbox_items text,
  progress_query_id text,
  progress_query_code text,
  widget_query_id text,
  widget_query_code text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS time_periods (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period_type text NOT NULL,
  year integer NOT NULL,
  month integer,
  week integer,
  day text,
  notes text,
  review_what_worked text,
  review_improvements text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  time_period_id text NOT NULL REFERENCES time_periods(id) ON DELETE CASCADE,
  title text NOT NULL,
  completed boolean NOT NULL DEFAULT false,
  completed_at timestamptz,
  sort_order integer NOT NULL DEFAULT 0,
  time_spent_ms bigint NOT NULL DEFAULT 0,
  timer_started_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS system_config (
  key text PRIMARY KEY,
  value text NOT NULL,
  is_secret boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS objective_reflections (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  level text NOT NULL,
  year integer NOT NULL,
  month integer,
  reflection text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS task_attributes (
  id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  key text NOT NULL,
  value text NOT NULL,
  value_type text NOT NULL DEFAULT 'number'
);
CREATE TABLE IF NOT EXISTS tags (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  color text,
  category text
);
CREATE TABLE IF NOT EXISTS task_tags (
  task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  tag_id text NOT NULL REFERENCES tags(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS daily_metrics (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  time_period_id text NOT NULL REFERENCES time_periods(id) ON DELETE CASCADE,
  previous_night_bed_time text,
  wake_up_time text,
  sleep_length text,
  cardio_load integer,
  fitbit_readiness integer,
  steps integer,
  heart_points integer,
  resting_heart_rate integer,
  custom_metrics text
);
CREATE TABLE IF NOT EXISTS metrics_templates (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL DEFAULT 'default',
  effective_from text NOT NULL,
  metrics_definition text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS daily_metric_values (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date text NOT NULL,
  metric_name text NOT NULL,
  value text,
  source text NOT NULL
);
CREATE TABLE IF NOT EXISTS saved_queries (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  query_type text NOT NULL DEFAULT 'general',
  code text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS dashboard_widgets (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL,
  widget_type text NOT NULL,
  config text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  page text NOT NULL DEFAULT 'dashboard',
  created_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS plugins (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plugin_id text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  config text,
  last_sync timestamptz,
  created_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS user_ai_config (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'anthropic',
  providers_config text,
  custom_system_prompt text,
  max_agent_rounds integer NOT NULL DEFAULT 20,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS query_execution_logs (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_snippet text NOT NULL,
  success boolean NOT NULL,
  error_message text,
  execution_time_ms integer,
  created_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS friend_requests (
  id text PRIMARY KEY,
  from_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL,
  responded_at timestamptz
);
CREATE TABLE IF NOT EXISTS friendships (
  id text PRIMARY KEY,
  user_id_1 text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_id_2 text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS friend_notes (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friend_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL
);
`;

function randomHex(length: number): string {
	const bytes = new Uint8Array(length);
	const crypto = globalThis.crypto;
	for (let i = 0; i < length; i++) bytes[i] = crypto.getRandomValues(new Uint8Array(1))[0];
	return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function createSqliteFixture(): Promise<DbFixture> {
	const dir = mkdtempSync(join(tmpdir(), 'ruok-wp01-'));
	const filePath = join(dir, 'okr.db');
	const ddl = new Database(filePath);
	try {
		ddl.exec(SQLITE_DDL);
	} finally {
		ddl.close();
	}
	const services = createDatabaseServices({
		type: 'sqlite',
		path: filePath,
		journalMode: 'wal',
		busyTimeoutMs: 5000
	});
	await services.open();
	return {
		services,
		teardown: async () => {
			await services.close();
			rmSync(dir, { recursive: true, force: true });
		}
	};
}

export async function createPostgresFixture(): Promise<DbFixture> {
	const adminUrl = process.env.RUOK_TEST_PG_ADMIN_URL;
	if (!adminUrl) {
		throw new Error(
			'createPostgresFixture requires RUOK_TEST_PG_ADMIN_URL (postgres://... with CREATEDB) to create a disposable database'
		);
	}
	const dbName = `ruok_wp01_${randomHex(8)}`;

	const admin = new Client({ connectionString: adminUrl });
	await admin.connect();
	try {
		await admin.query(`CREATE DATABASE ${dbName}`);
	} finally {
		await admin.end();
	}

	const appUrl = new URL(adminUrl);
	appUrl.pathname = `/${dbName}`;
	const connectionString = appUrl.toString();

	// Create the proof schema on the fresh database.
	const ddl = new Client({ connectionString });
	await ddl.connect();
	try {
		await ddl.query(POSTGRES_DDL);
	} finally {
		await ddl.end();
	}

	const services = createDatabaseServices({
		type: 'postgres',
		connectionString,
		poolMax: 5,
		connectTimeoutMs: 10000,
		statementTimeoutMs: 30000,
		sslMode: 'disable'
	});
	await services.open();

	return {
		services,
		teardown: async () => {
			await services.close();
			const admin2 = new Client({ connectionString: adminUrl });
			await admin2.connect();
			try {
				await admin2.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
			} finally {
				await admin2.end();
			}
		}
	};
}
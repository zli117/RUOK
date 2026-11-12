# RUOK Databases

How RUOK's database layer works, how to configure **either** backend, how
migrations are run, and how to back up and recover data with native tools.

RUOK supports exactly two mutually exclusive backends:

| Backend | `DATABASE_TYPE` | Data location | Best for |
|---|---|---|---|
| SQLite | `sqlite` (default) | a single local file (`DATABASE_PATH`) | a single small/self-hosted installation |
| PostgreSQL | `postgres` | an externally managed server (`DATABASE_URL`) | one RUOK replica backed by an externally managed PostgreSQL server |

Each deployment uses **exactly one** configured backend. Switching the
`DATABASE_TYPE` environment variable does **not** transfer data and is not a
supported way to move an installation (see
[Backend switching is not a migration](#backend-switching-is-not-a-migration)).

This guide is the source of truth for database operations. The other docs link
here rather than duplicating it.

- [Configuration reference](#configuration-reference)
- [Environment variable precedence](#environment-variable-precedence)
- [SQLite mode](#sqlite-mode)
- [PostgreSQL mode](#postgresql-mode)
- [Migrations and startup protocol](#migrations-and-startup-protocol)
- [Backup and recovery](#backup-and-recovery)
- [Backend switching is not a migration](#backend-switching-is-not-a-migration)
- [Command reference](#command-reference)

---

## Configuration reference

All settings are environment/bootstrap variables. They are read and validated
by `loadConfig` at startup and by the standalone migration CLI. Unknown or
contradictory values are rejected with an actionable message — there is **never**
a silent fallback to the other backend.

| Variable | Applies to | Default | Notes |
|---|---|---|---|
| `DATABASE_TYPE` | both | `sqlite` | `sqlite` or `postgres` only; anything else is rejected |
| `DATABASE_PATH` | SQLite | `data/okr.db` | Filesystem path to the SQLite file. **Ignored in PostgreSQL mode.** |
| `SQLITE_JOURNAL_MODE` | SQLite | `wal` | `wal` or `delete`. `wal` needs suitable local/block storage; no NFS correctness is claimed. |
| `SQLITE_BUSY_TIMEOUT_MS` | SQLite | `5000` | Non-negative bounded busy timeout. |
| `DATABASE_URL` | PostgreSQL | *(none)* | **Required** in PostgreSQL mode. Full `postgresql://user:pass@host:5432/db` URL. Never logged. |
| `DATABASE_SSL_MODE` | PostgreSQL | `disable` | `disable` or `verify-full`. `verify-full` requires hostname/CA validation; never silently downgraded. |
| `DATABASE_SSL_CA_FILE` | PostgreSQL | *(none)* | Container path to a PEM CA file (mounted secret) when using verified TLS. |
| `DATABASE_POOL_MAX` | PostgreSQL | `5` | Bounded positive integer pool size. |
| `DATABASE_CONNECT_TIMEOUT_MS` | PostgreSQL | `10000` | Bounded startup connect wait. |
| `DATABASE_STATEMENT_TIMEOUT_MS` | PostgreSQL | `30000` | Bounded per-statement timeout (see [migration timeout](#migration-timeout)). |
| `MIGRATION_MODE` | both | `migrate` | `migrate` applies checked history; `verify` only inspects existing storage and performs no DDL. Invalid values fail before database work. |

`PORT`, `HOST`, `ADMIN_USERNAME` and `DATA_DIR` are not database settings; they
are described in [SETUP.md](SETUP.md).

See `.env.example` for a ready-to-copy template with inline comments.

---

## Environment variable precedence

There is exactly one place where an environment object becomes a validated
database config: `loadConfig`. Because RUOK does not use a dotenv library at
runtime, precedence is simple and deterministic:

1. `DATABASE_TYPE` selects the backend (`sqlite` default).
2. For the selected backend, each explicit environment variable takes the value
   you set. An unset optional variable uses its documented default.
3. `DATABASE_PATH` is **only** meaningful when `DATABASE_TYPE=sqlite`. In
   PostgreSQL mode it is deliberately ignored (the legacy Docker environment
   sets it); it does not open or create a SQLite file.

For TLS there are two sources that must not contradict each other:

- An explicit `DATABASE_SSL_MODE`.
- TLS hints in `DATABASE_URL` (`sslmode=require|verify-ca|verify-full`) and the
  presence of `DATABASE_SSL_CA_FILE`.

The rules that prevent silent TLS downgrade are enforced with errors:

- `DATABASE_SSL_MODE=disable` **plus** a URL asking for verification, or
  **plus** a `DATABASE_SSL_CA_FILE`, is rejected (refusing to silently disable
  verification).
- A CA file set while no explicit mode is present implies `verify-full`.
- A URL with a verifying `sslmode` while no explicit mode is present implies
  `verify-full`.

A missing `DATABASE_URL` in PostgreSQL mode is rejected before any connection
attempt.

URL TLS controls are parsed once. Duplicate controls, unsupported modes
(`no-verify`, `prefer`) and URL fields `ssl`, `sslcert`, `sslkey`, `sslrootcert`
or `sslnegotiation` are rejected. Accepted `sslmode` hints are removed before
the connection string reaches `pg`; the explicit canonical TLS object supplies
verification and the CA to both the runtime pool and migration client. This
prevents the driver's URL parser from overwriting the verified policy.

---

## SQLite mode

SQLite is the default and keeps the legacy `DATABASE_PATH`/`data/okr.db`
behavior. It is best for a single installation on local or block storage.

```bash
cd okr-app
export DATABASE_TYPE=sqlite                 # optional; this is the default
export DATABASE_PATH=/path/to/okr.db        # optional; default data/okr.db
npm install
npm run db:migrate                          # create/upgrade the schema
npm run dev
```

### Journal mode and WAL

SQLite runs with foreign-key enforcement enabled, a bounded busy timeout and a
configured journal mode (`wal` by default). WAL gives better concurrency but
requires suitable **local/block storage**. RUOK makes **no claim of NFS
correctness**: do not place the SQLite file (or its `-wal`/`-shm` side files)
on a network filesystem. If a `DELETE` journal is required for a supported
operational reason, set `SQLITE_JOURNAL_MODE=delete`.

### Legacy preflight

RUOK supports upgrading a supported existing SQLite file, including a known
`db:push`-era layout. On startup/migration the layout is fingerprinted and, for
a recognized legacy layout, adopted only after structural + data-integrity
checks, recording the reconciled migration journal atomically. An **unknown** or
incompatible layout **fails with an actionable message before serving
requests** — there is no warn-and-continue repair and no partially-applied
history.

Compatibility compares definitions, including index uniqueness/ordered columns,
column types/nullability/defaults/primary keys, foreign-key mappings/actions,
constraints and recorded migration hashes/timestamps. An expected index name
alone is insufficient. Rejections preserve the incompatible catalog and journal;
the runner does not repair unknown schemas. Supported journal-managed,
`db:push`, missing-additive-column and incomplete-journal layouts are tested
alongside harmless SQL formatting differences.

SQLite preparation and runtime operations execute in dedicated workers. A
configured busy timeout (including 0, 5000 or 30000 ms) is not clamped to the
probe deadline. Concurrent readiness probes coalesce behind a bounded check;
timing out a probe does not cancel, replay or commit a business transaction.

> **Production `db:push` is replaced.** `db:push` (Drizzle Kit) creates/alters
> schema directly and is unsuitable for a running installation. Use the
> versioned migration runner (`npm run db:migrate` / `npm run db:verify`) shown
> below. `db:push` remains only as a dev convenience for a throwaway database.

---

## PostgreSQL mode

Set `DATABASE_TYPE=postgres` and provide `DATABASE_URL`. PostgreSQL keeps all
data in the external server; RUOK never opens or creates a SQLite file in this
mode.

```bash
cd okr-app
export DATABASE_TYPE=postgres
export DATABASE_URL='postgresql://ruok:CHANGE_ME@db.example.com:5432/ruok'
export DATABASE_SSL_MODE=verify-full
export DATABASE_SSL_CA_FILE=/run/secrets/ca.pem   # mounted CA, verified TLS
npm install
npm run db:migrate
npm run dev
```

### Supported versions and privileges

The original mission declared PostgreSQL 16/17. The remediation evidence records
live PostgreSQL 18.6; this guide does not turn that observation into a new CI or
deployment support claim. Required disposable-database and native-recovery
verification commands currently require PostgreSQL 18 or newer plus compatible
`pg_dump`, `pg_restore` and `psql` on the test process's PATH. See
[verification prerequisites](DATABASE-VERIFICATION.md#required-command-matrix).
The production runtime does not need CREATEDB or superuser: a separately migrated
installation can use the data-only role described below.

### TLS (verified, custom CA)

TLS is either `disable` (default) or `verify-full`. `verify-full` performs
hostname + CA validation and **never** silently downgrades (see
[precedence](#environment-variable-precedence)). To use a private CNPG CA,
mount the PEM into the container (for example `./secrets:/run/secrets:ro` in
[`compose.postgres.yml`](../compose.postgres.yml)) and set both
`DATABASE_SSL_MODE=verify-full` and `DATABASE_SSL_CA_FILE`. The CA file is a
mounted secret, never baked into the image. A missing CA file fails before
connect.

### Connection pool limits

`DATABASE_POOL_MAX` bounds concurrent connections (default `5`). The default
deployment is **one** application replica, so this is the total connection
demand RUOK makes on the server. `DATABASE_CONNECT_TIMEOUT_MS` bounds startup
connect waits and `DATABASE_STATEMENT_TIMEOUT_MS` bounds individual statements.

### Migration timeout

A long migration may exceed the default 30 s statement timeout. If you run
migrations on a large dataset, you may raise `DATABASE_STATEMENT_TIMEOUT_MS`
for the migration run specifically (documented override); the value is read from
the environment so you can set it just for the migration job and leave the
runtime at the default.

---

## Migrations and startup protocol

Migrations are **independent, versioned per dialect** and executed by the same
canonical runner used at startup. Historical SQLite migration files are
**preserved and never rewritten**. A migration never marks unapplied migrations
as applied.

Two distinct entry points, both shipped in the production image:

- **`npm run db:migrate`** — the standalone migration CLI (default mode). Runs
  the selected backend's checked migration history. No app server needed.
- **`MIGRATION_MODE=verify npm run db:migrate`** (or **`npm run db:verify`**) —
  schema **verification only**; no DDL. It classifies the database as ready or
  fails if it is not at the expected schema version. Useful for a
  migration-role workflow where runtime DDL is not permitted.

In `migrate` mode the startup protocol is:

1. A database-free build imports only definitions/lazy factories; filesystem
   and network I/O begin at runtime.
2. Resolve and validate config; open **only** the selected backend with
   redacted diagnostics and bounded timeouts.
3. Acquire a backend migration lock (pg advisory lock on a pinned connection;
   SQLite supported exclusive startup/adoption transaction) so competing
   startup/CLI runs serialize.
4. Classify the database as fresh, journal-managed, recognized legacy or unknown
   drift; fresh databases apply their own history, recognized legacy layouts are
   adopted after fingerprint + integrity checks, and unknown layouts fail before
   mutation.
5. Enable/check foreign keys and verify the schema version. A migration error
   aborts readiness — no warn-and-continue repair.
6. Publish ready repositories. Business requests await successful opening;
   liveness/readiness routes remain reachable during initialization failure.
   On shutdown, jobs stop and DB resources are released.

In `verify` mode the runner branches before object creation. PostgreSQL uses a
read-only transaction to inspect the existing journal and physical catalog;
SQLite opens an existing file read-only without creating its parent directory.
Missing, outdated, corrupt or incompatible storage fails with a migration-role
diagnostic. Verification does not create a journal, apply history or acquire
the DDL migration lock.

### Separate migration and runtime roles

Run migrations once with a role that can create/alter the application's objects,
then start the server with the runtime connection and `MIGRATION_MODE=verify`.
The PostgreSQL runtime role should own no schema/table objects and lack CREATE
on the database and application schemas (also revoke PUBLIC CREATE). Grant
CONNECT, schema USAGE, required table DML, sequence privileges and SELECT on
`drizzle.__drizzle_migrations`. Test grants against your deployment's schema;
the application's regression fixture captures zero attempted DDL plus unchanged
inventories for migrated, empty, outdated and incompatible storage.

In a production image the standalone CLI is `node build/db-migrate.mjs`; development
checkouts use `npm run db:migrate` or `npm run db:verify`. Set the role URL
privately rather than placing credentials in recorded commands or logs.

### Readiness and liveness probes

- `GET /api/health` — process liveness, independent of the database. Returns
  `200 {"status":"ok",...}` while the process is up.
- `GET /api/ready` — backend readiness. Returns `200` only when the selected
  backend is **open and migrated/verified at the expected schema version**;
  otherwise `503`. Body is redacted (dialect, open flag, schema version only).
  The response checks current availability rather than a cached startup success.
  Availability checks have a three-second deadline; the HTTP contract requires
  probes within five seconds, outage detection within ten seconds and recovery
  within thirty seconds once storage is available.

Failed initialization releases its shared opening attempt and resources. Later
requests can retry after a one-second cooldown without restarting the server;
idle PostgreSQL pool errors are handled. A later outage makes readiness 503
while health stays 200, and storage recovery restores readiness on the same PID.
These are verified contracts, not a promise that a failed migration is silently
repaired: operators must first restore compatible storage/schema/privileges.

Use `/api/ready` for orchestrator readiness/health checks. In
[`compose.postgres.yml`](../compose.postgres.yml) and the SQLite compose file,
the Docker healthcheck already gates on `/api/ready`.

### Migration example

```bash
# Fresh SQLite install
DATABASE_PATH=/tmp/okr.db npm run db:migrate
# -> backend=sqlite mode=migrate OK classification=fresh applied=7 recorded=7 schemaVersion=6

# Verify the same database (no DDL)
DATABASE_PATH=/tmp/okr.db npm run db:verify
# -> backend=sqlite mode=verify OK classification=ready applied=7 recorded=0 schemaVersion=6
```

PostgreSQL migration uses the same commands with `DATABASE_TYPE=postgres` +
`DATABASE_URL`. A migration-role workflow can run `db:migrate` with a DDL-capable
role, then the app's runtime role starts with `db:verify`/readiness checks.

---

## Backup and recovery

There are **two distinct kinds of backup**. Do not confuse them:

| Kind | What it captures | Cross-engine | Use for |
|---|---|---|---|
| **Version-2 user export** (`GET /api/backup`) | one user's data (see [scope](#version-2-user-export-scope)) | **yes** — portable across SQLite ↔ PostgreSQL | moving a *user's* data between instances/backends |
| **Native installation backup** | the whole installation incl. accounts, secrets, config | **no** — engine-specific | complete recovery of an installation |

### Version-2 user export

The in-app backup (Settings → Download Backup) calls `GET /api/backup` and
produces a version-2 JSON document (`version: 2`) from a **consistent
snapshot** (one transaction). Restore is `POST /api/backup/restore` and is
**validated before any mutation, then applied atomically** — a failure after
rows were deleted rolls the whole restore back on both backends.

**Portable across all four directions:** SQLite→SQLite, SQLite→PostgreSQL,
PostgreSQL→SQLite, PostgreSQL→PostgreSQL. Restored content matches within the
documented version-2 scope. A version other than `2` is rejected before
mutation.

#### Version-2 user export scope

**Included** (per exporting user): values + principles, tags, saved queries,
objectives + key results (with progress, widget-query name and code),
time periods with commitments, daily metrics and tasks (attributes + tag
names), dashboard widgets, metrics templates, daily metric values, objective
reflections, and user preferences (timezone / weekStartDay / bgColor).

**Intentionally excluded** (installation-wide, not user-scoped): other users'
data and sessions, friendships and friend notes, query execution logs, global
system config, plugin credentials, AI configuration and secret material.
Installation secrets are **never** exported.

> **Restoring a user export is not an installation migration.** It replaces the
> restored user's data within the documented scope and leaves other users and
> installation-wide data unchanged. It cannot carry accounts, credentials or
> friendships. Use native backups for full installation recovery, and a
> separately scoped converter (out of scope here) for a full-installation
> backend switch.

### Native installation backup (SQLite)

The safe way to copy a SQLite database is SQLite's **online backup API** or
`sqlite3` CLI `.backup`, which produce a consistent copy even with active
writers. Do **not** copy the live database file (or its `-wal`/`-shm` side
files) with `cp`/`rsync` while the app is writing — that is unsafe and may
produce a torn or inconsistent file.

Use the online backup API (this is what RUOK's own recovery rehearsal uses):

```js
import Database from 'better-sqlite3'
const src = new Database('/path/to/okr.db', { readonly: true })
await src.backup('/backups/okr-2026-01-01.db')   // consistent copy
src.close()
```

or the `sqlite3` CLI, which does the same thing:

```bash
sqlite3 /path/to/okr.db ".backup /backups/okr-2026-01-01.db"
```

If you cannot use the online API/CLI (for example a bare `cp` in a script), you
must first **stop the writers** so no transaction is in flight, then copy the
file (and, if present, checkpoint the WAL). Stopping writers is the explicit
requirement that replaces the old unsafe live `cp` recipe.

To restore a SQLite native backup: stop the app, replace `DATABASE_PATH` with
the backup file, then start the app. RUOK's startup migration check classifies
the restored copy as already-ready (schema + journal aligned) and publishes
readiness. The restore is verified by the `/api/ready` probe and by exercising
your data.

```bash
# restore a SQLite native backup
systemctl stop ruok                 # or: docker compose stop ruok
cp /backups/okr-2026-01-01.db /path/to/okr.db
systemctl start ruok                # or: docker compose start ruok
curl -fsS http://localhost:3000/api/ready   # 200 = ready
```

### Native installation backup (PostgreSQL)

Use PostgreSQL-native tools: `pg_dump`/`pg_restore` for point-in-time copies, or
CNPG backups (managed volume snapshots / base backups + WAL) for ongoing
recovery of the cluster. Native dumps preserve accounts, secrets and
configuration.

```bash
# logical dump (full installation)
pg_dump -Fc -h db.example.com -U ruok ruok > ruok.dump

# restore into an empty target database (create it first; not superuser)
pg_restore -d ruok ruok.dump
```

Orchestrated recovery for CNPG is covered in [CNPG-HANDOFF.md](CNPG-HANDOFF.md)
(backup retention and recovery rehearsal). As with SQLite, a native PostgreSQL
backup restores **only to PostgreSQL**.

### Restore validation

Every documented restore path is validated the same way:

1. Run the restore (SQLite online-backup copy, `pg_restore`, or `POST
   /api/backup/restore` for user data).
2. Start the app and confirm `GET /api/ready` returns `200` with the expected
   `dialect` and `schemaVersion`.
3. Exercise the data you care about (login, an objective, a task, a metric).
4. For user exports, confirm the restore was atomic and left other users
   unchanged.

### Why native dumps cannot switch backend engines

A SQLite `.backup()`/CLI backup restores only to SQLite; a PostgreSQL
`pg_dump`/`pg_restore` or CNPG backup restores only to PostgreSQL. Neither format
carries cross-engine DDL semantics or the dialect migration history
compatibly. **A native backup cannot be used to migrate an installation from one
engine to the other.** Backend switching of a full installation is a separately
scoped converter and is an explicit non-goal.

---

## Backend switching is not a migration

Setting a different `DATABASE_TYPE` selects a different backend; it does not
move data. Concretely:

- Switching `sqlite` → `postgres` leaves the SQLite file untouched and connects
  RUOK to the (possibly empty) PostgreSQL database. Nothing is copied.
- Switching `postgres` → `sqlite` connects RUOK to the local file. **Any data
  written to PostgreSQL after you cut over is not in that file.** Merely
  reverting `DATABASE_TYPE` after writing to the new backend loses those writes;
  recovering them requires a deliberate export/import decision, not a config
  flip.

To move a **user's** data across backends, use the version-2 user export
(Settings → Download Backup → restore on the target). To move a **whole
installation**, use native backup only within the same engine, or a separately
scoped converter for cross-engine (not provided here).

---

## Command reference

From `okr-app/`. Success conditions are shown; actual command exits belong to
the execution evidence. Use an exact-lock development install (`npm ci`).

| Task | Command | Expected success / prerequisite |
|---|---|---|
| Create/upgrade schema (selected backend) | `npm run db:migrate` | 0 |
| Verify schema, no DDL | `npm run db:verify` | 0 |
| Native SQLite backup (online API) | `node` script using `better-sqlite3` `.backup()` | 0 |
| Native SQLite backup (CLI) | `sqlite3 db ".backup out.db"` | — |
| v2 user export | Settings → Download Backup (`GET /api/backup`) | — |
| v2 user restore | `POST /api/backup/restore` | — |
| SQLite native-recovery test | `npm run test:recovery:sqlite` | 0 |
| SQLite backup/restore contract tests | `npm run test:db:sqlite` | 0 |
| PostgreSQL contract/recovery tests | `npm run test:db:postgres` / `npm run test:recovery:postgres` | Live disposable PG18+, admin URL and matching native clients; fail-closed preflight |

The full validation matrix, version ledger, live execution prerequisites and
recorded results are in [DATABASE-VERIFICATION.md](DATABASE-VERIFICATION.md).

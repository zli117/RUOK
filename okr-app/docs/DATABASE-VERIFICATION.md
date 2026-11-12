# Database verification

Reproducible checks for RUOK database behavior, recovery, and production images.

## Required command matrix

Run from `okr-app/` using the committed lockfile and supported Node build
runtime. Use disposable databases and isolated ports. Never point destructive
fixtures at production or paste credentials into logs.

| Command | What must execute | Prerequisites |
|---|---|---|
| `npm test` | Full SQLite database/domain/backup suite plus HTTP/auth/probes and application integrations | Exact-lock dependencies; production build is created when needed |
| `npm run test:db:sqlite` | SQLite contract, schemas, lifecycle isolation, domains, upgrade and native recovery | Real writable temporary SQLite storage |
| `npm run test:db:postgres` | PostgreSQL contract, migrations, operations, domains, backup and native recovery | Live disposable PostgreSQL 18+, DBA/CREATEDB admin URL, native client tools |
| `npm run test:application:sqlite` | Both SQLite HTTP and integrations entrypoints | Built server, native SQLite module |
| `npm run test:application:postgres` | Both PostgreSQL HTTP and integrations entrypoints | Built server and PostgreSQL preflight |
| `npm run test:recovery:postgres` | Native full-installation dump/drop/recreate/restore/typed reads | PostgreSQL preflight, `pg_dump`, `pg_restore`, `psql` |
| `npm run build` | Adapter-node production output plus preparation/runtime workers | Exact-lock dependencies |
| `npm run check` | Svelte/TypeScript diagnostics | Same dependency lock and diagnostic comparison against the inspected baseline |

Supply `RUOK_TEST_PG_ADMIN_URL` privately. `preflight:postgres` precedes every
required PostgreSQL command and exits nonzero for an absent admin URL,
unreachable/older server or missing/incompatible native tools. `pg_dump` and
`pg_restore` must support the server major; `psql` must be present. A tool inside
some unrelated container does not satisfy the preflight's PATH checks. Required
runs do not substitute SQLite or silently skip missing prerequisites.

### Additional focused gates

```bash
DB_BACKEND=sqlite node_modules/.bin/vitest run \
  tests/db/sqlite-integrity.test.ts tests/db/readiness-mode.test.ts tests/db/runtime-mode.test.ts \
  tests/db/postgres-no-ddl.test.ts tests/db/availability.test.ts \
  tests/db/sqlite-worker.test.ts tests/verification/command-coverage.test.ts --retry=0
DB_BACKEND=sqlite node_modules/.bin/vitest run \
  tests/db/concurrency.test.ts tests/db/no-init.test.ts --retry=0
```

The last two stability tests each perform ten independent attempts internally,
with fresh storage and isolated bundle paths. A failure stops the series; do
not retry until green or weaken timing/child-process assertions. Supplying the
live admin URL also executes the focused no-DDL and availability cases that
older owner records accurately labelled pending.

`tests/verification/command-coverage.test.ts` guards package entrypoints, missing
files, zero-test failure and fail-closed preflight.

## Static diagnostics

Run `npm run check` and preserve its exit status. Compare diagnostics against the
base revision using the same lockfile and toolchain; a production build alone
does not establish that the type check passes.

## Feature-to-contract coverage ledger

The canonical 25-table inventory is machine-checked by
`tests/db/coverage-ledger.test.ts`. Shared scenarios use real selected backend
fixtures; external provider responses may be stubbed, but storage is real.

| # | Table | Feature / API family | Concrete shared scenario (sqlite + postgres) | Suite |
|---|---|---|---|---|
| 1 | `users` | auth / accounts / admin | account CRUD, admin/disabled flags, per-user isolation | `tests/domains/auth/auth.suite.ts`, `tests/db/contract.suite.ts` |
| 2 | `sessions` | auth sessions | create/find/delete/deleteByUser/deleteExpired | `tests/domains/auth/auth.suite.ts` |
| 3 | `system_config` | admin / global config | keyed upsert incl. secret flag, `all()` | `tests/domains/auth/auth.suite.ts` |
| 4 | `objectives` | goals | CRUD/upsert/listByUser/join-KRs/parent links | `tests/domains/goals/goals.suite.ts`, `tests/db/contract.suite.ts` |
| 5 | `key_results` | goals / KR progress | CRUD, ordering, scoreLabel, custom-query refs | `tests/domains/goals/goals.suite.ts`, `tests/db/contract.suite.ts` |
| 6 | `objective_reflections` | reflections | null-month + per-user lookup | `tests/domains/goals/goals.suite.ts` |
| 7 | `time_periods` | planning / journal | find/list/update, week/year filtering | `tests/domains/planning/planning.suite.ts` |
| 8 | `time_commitments` | planning (backup) | version-2 backup round-trip | `tests/backup/backup.suite.ts` |
| 9 | `tasks` | planning / timers | CRUD, atomic timers (safe bigint), per-period | `tests/domains/planning/planning.suite.ts` |
| 10 | `task_attributes` | planning / flexible attrs | atomic create/update of attributes | `tests/domains/planning/planning.suite.ts` |
| 11 | `tags` | planning / tags | owner scope, duplicate names | `tests/domains/planning/planning.suite.ts` |
| 12 | `task_tags` | planning / tag links | duplicate-pair links, cascade delete | `tests/domains/planning/planning.suite.ts` |
| 13 | `daily_metrics` | metrics (fixed) | create/update/findByPeriod | `tests/domains/metrics/metrics.suite.ts` |
| 14 | `metrics_templates` | metrics / versioning | `effectiveFrom <= date` selection | `tests/domains/metrics/metrics.suite.ts` |
| 15 | `daily_metric_values` | metrics (flexible) | upsert, timezone-boundary date strings | `tests/domains/metrics/metrics.suite.ts` |
| 16 | `values` | values / principles | version-2 backup round-trip | `tests/backup/backup.suite.ts` |
| 17 | `principles` | values / principles | version-2 backup round-trip | `tests/backup/backup.suite.ts` |
| 18 | `saved_queries` | custom queries | per-user scope, update/remove | `tests/domains/integrations/integrations.suite.ts` |
| 19 | `dashboard_widgets` | dashboards | per-user scope | `tests/domains/integrations/integrations.suite.ts` |
| 20 | `plugins` | plugin config / sync | persist config, listEnabled | `tests/domains/integrations/integrations.suite.ts` |
| 21 | `user_ai_config` | AI config | per-user upsert | `tests/domains/integrations/integrations.suite.ts` |
| 22 | `query_execution_logs` | admin / audit | create/list/count/listSince | `tests/domains/integrations/integrations.suite.ts` |
| 23 | `friend_requests` | social | create/accept/decline, per-user scope | `tests/domains/integrations/integrations.suite.ts` |
| 24 | `friendships` | social | findBetween/listForUser | `tests/domains/integrations/integrations.suite.ts` |
| 25 | `friend_notes` | social / privacy | author-only note, unfriend cleanup | `tests/domains/integrations/integrations.suite.ts` |


## Manual production images

See [the container guide](../tests/container/README.md) for the current commands.
With Podman, build using `--format docker` to retain the declared HEALTHCHECK.
Resolve one `RUOK_SMOKE_IMAGE` to an immutable local image ID and reuse it with
`RUOK_SMOKE_SKIP_BUILD=1` for both scripts. PostgreSQL requires a live
`DATABASE_URL` reachable from inside the application container. A local image ID
is not a registry digest.

Both scripts require readiness/liveness, bundled migration, actual account and
objective creation, restart and exact read under the original account. Missing
or changed data, invalid JSON/status and readiness deadlines fail nonzero.
Controlled lost-write and never-ready cases must reach their intended assertions;
fixture setup errors cannot count as valid negatives. Host-only SQLite checks
are supplemental and do not replace production-image verification.

## Recovery

Version-2 user backup portability and native installation recovery are separate
contracts. Native SQLite backup restores only to SQLite; PostgreSQL dumps restore
only to PostgreSQL. The recovery fixtures seed full installation data, restore
it into fresh storage and verify schema/history plus typed reads; native dumps
are not a backend conversion mechanism.

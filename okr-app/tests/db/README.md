# Real-database contract harness (WP01)

This directory proves the typed persistence boundary (FR-003/FR-011) against
real SQLite and real PostgreSQL backends. Later work packages reuse these exact
commands as the canonical invocation.

## Commands (run from `okr-app/`)

Schema-only structural parity (no database required):

```bash
npm run test:db:parity
```

Real SQLite contract suite (mandatory backend selection; refuses to run unless
`DB_BACKEND=sqlite`):

```bash
npm run test:db:sqlite
```

Real PostgreSQL contract suite (mandatory backend selection; refuses to run
unless `DB_BACKEND=postgres`. Fails — never falls back to SQLite — if
PostgreSQL is unreachable). Requires an admin URL with `CREATEDB` to create and
drop a disposable database per fixture:

```bash
RUOK_TEST_PG_ADMIN_URL='postgres://user:pass@host:5432/postgres' \
  npm run test:db:postgres
```

## Environment

| Variable                  | Required for           | Purpose                                          |
| ------------------------- | ---------------------- | ------------------------------------------------ |
| `DB_BACKEND`              | sqlite / postgres runs | Mandatory backend selection; no silent fallback  |
| `RUOK_TEST_PG_ADMIN_URL`  | postgres run           | Admin connection (`CREATEDB`) for disposable DBs |

## Layout

- `fixtures.ts` — isolated lifecycle: SQLite temp file, PostgreSQL disposable
  database + schema DDL, safe teardown.
- `contract.suite.ts` — the shared behavioral contract (CRUD, JOIN, UPSERT,
  COUNT, atomic rollback, codec: boolean / Date second precision / null /
  >32-bit milliseconds) executed identically on both backends.
- `schema-parity.test.ts` — structural dialect-drift guard between the SQLite
  and PostgreSQL proof schemas.
- `sqlite.contract.test.ts` / `postgres.contract.test.ts` — backend entry
  points that enforce `DB_BACKEND` selection.

Note: the table DDL here is WP01 proof scaffolding that mirrors the proof
schemas in `src/lib/db/schema/`. Full production schema + migration lineage are
owned by later work packages.
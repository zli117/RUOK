# RUOK → CloudNativePG (CNPG) deployment handoff

This is the actionable handoff for deploying the RUOK production image in
PostgreSQL mode backed by an existing CloudNativePG cluster, and for wiring
that deployment into the external infrastructure repository.

The RUOK side of the database feature (SQLite + PostgreSQL, migrations,
readiness, image, backup/recovery) is implemented and tested in this
repository. This document hands off the **remaining external** work and lists,
explicitly as **MISSING**, every input the external deployer must provide.

- [What is already done (RUOK side)](#what-is-already-done-ruok-side)
- [Overall deployment shape](#overall-deployment-shape)
- [Required environment inputs (MISSING)](#required-environment-inputs-missing)
- [Deployment steps](#deployment-steps)
- [Migration Job / run ordering](#migration-job--run-ordering)
- [Probes, replica count, and PostgreSQL volume](#probes-replica-count-and-postgresql-volume)
- [HTTPS and backup recovery](#https-and-backup-recovery)
- [Validation checklist](#validation-checklist)
- [Status: task 115 and the external deployment remain PENDING](#status-task-115-and-the-external-deployment-remain-pending)

---

## What is already done (RUOK side)

The RUOK application image is database-agnostic and is published per
[`.github/workflows/ruok-image.yml`](../../.github/workflows/ruok-image.yml)
(release/trusted branches). It runs identically in SQLite or PostgreSQL mode:

- Both dialect migration histories (`drizzle/` + `drizzle-postgres/`) and the
  compiled migration CLI (`build/db-migrate.mjs`) are inside the image.
- Configuration is via environment variables only — **no secrets baked in**:
  `DATABASE_TYPE`, `DATABASE_URL`, `DATABASE_SSL_MODE`, `DATABASE_SSL_CA_FILE`,
  `DATABASE_POOL_MAX`, `DATABASE_CONNECT_TIMEOUT_MS`,
  `DATABASE_STATEMENT_TIMEOUT_MS`.
- Readiness `/api/ready` (backend open + migrated) and liveness `/api/health`.
- PostgreSQL mode requires **no SQLite data volume**.
- Configuration reference: [DATABASES.md](DATABASES.md).

The external deployment's job is to consume this image and wire it to the CNPG
cluster. Everything below that is not already a concrete RUOK setting is listed
as a **MISSING** input the operator must fill in from their environment.

---

## Overall deployment shape

```
                       ┌──────────────────────────────┐
   HTTPS (TLS)  ─────▶ │  RUOK Deployment (1 replica)  │
                       │  image: <MISSING>              │
                       │  DATABASE_TYPE=postgres        │
                       │  DATABASE_URL → CNPG write svc │
                       └──────────────┬───────────────┘
                                      │ verified TLS / custom CA
                                      ▼
                 ┌────────────────────────────────────┐
                 │  CNPG cluster (external, managed)  │
                 │  write service / database / role   │
                 └────────────────────────────────────┘
```

- One RUOK application replica.
- One CNPG-managed PostgreSQL (verified major version before deploy).
- SQLite volume: **removed** — PostgreSQL mode does not use it.

---

## Required environment inputs (MISSING)

None of the following has a value supplied in this document. Each is a required
input the operator must obtain from their environment before the external
deployment is complete. Mark each as resolved when provided.

### Cluster / connectivity

- **MISSING** — CNPG write-service **hostname** (the read/write Service DNS the
  app connects to, e.g. the `<cluster>-rw` service of the managed cluster).
- **MISSING** — **Port** for the write service.
- **MISSING** — **Database name** RUOK should use.
- **MISSING** — **Role / user** RUOK connects as.
- **MISSING** — **Server major version** (must be a tested major — 16 or 17 —
  or explicitly confirmed; do not claim untested versions).

### Secrets (Kubernetes Secret keys)

- **MISSING** — Secret **name** containing the connection credential.
- **MISSING** — Secret **key** holding the password (or the full URL).
- **MISSING** — Secret **key** holding the TLS **CA** certificate material.
- **MISSING** — Whether the secret is created by CNPG (managed) or must be
  created separately.

### TLS / CA

- **MISSING** — **CA certificate** content or file reference (CNPG `ca.crt`) to
  mount at `DATABASE_SSL_CA_FILE`.
- **MISSING** — Confirm `DATABASE_SSL_MODE=verify-full` and that the write
  service hostname matches the certificate SANs (verify-full validates
  hostname).

### Image

- **MISSING** — Image **repository/owner** (registry owner).
- **MISSING** — Image **digest** (immutable) or tag to deploy.
- **MISSING** — **Architecture** of the deploy target (must match a built
  platform; the release pipeline publishes linux/amd64, and linux/arm64 only
  once native builds are validated — confirm before deploy).
- **MISSING** — **Pull credentials**: registry **public** (image publicly
  pullable) or **private** (requires an imagePullSecret name) — provide the
  correct one.

### Deployment metadata

- **MISSING** — **Namespace** to deploy into.
- **MISSING** — Resource limits/requests that fit the target node.

---

## Deployment steps

Once the inputs above are supplied, the external deployer should:

1. Set the RUOK image (owner + digest) and `imagePullSecrets` per the
   **MISSING** image inputs.
2. Mount the CA Secret at `DATABASE_SSL_CA_FILE` and set
   `DATABASE_SSL_MODE=verify-full`.
3. Set `DATABASE_TYPE=postgres` and `DATABASE_URL` from the write-service /
   database / role inputs.
4. Apply the migration Job/run **before** the app rollout (see next section).
5. Deploy one app replica with the probes described below.
6. Remove the SQLite data volume for PostgreSQL mode.
7. Enable HTTPS (Ingress/TLS) to the app.
8. Validate backup recovery and create the two-account fixture (see
   [Validation checklist](#validation-checklist)).

---

## Migration Job / run ordering

Migrations must run **once, before the app rolls out**, using the DDL-capable
role. The migration command is inside the image:

```bash
node build/db-migrate.mjs
```

(`MIGRATION_MODE=verify` verifies schema without DDL and is useful for the app's
own startup check.)

Ordering requirements:

1. Run the migration Job to completion against the CNPG database
   (`node build/db-migrate.mjs` with `DATABASE_TYPE=postgres` + `DATABASE_URL`).
2. Confirm the migration Job succeeded and the schema version is correct.
3. Then roll out the app; its startup verifies schema version and readiness.

If the runtime role is **not** DDL-capable, use exactly one migration runner (a
Job with a DDL role) and make the app's startup a **schema-verify** (readiness)
check. Deployment instructions must choose exactly one runner and make the
startup version check explicit — do not run migrations from multiple replicas.

---

## Probes, replica count, and PostgreSQL volume

- **Replica count:** `1`. RUOK's default deployment is one application replica;
  PostgreSQL storage does not make its in-memory scheduler/events/caches
  distributed. Multi-replica application correctness is out of scope.
- **Liveness:** `/api/health` (process up; login-independent).
- **Readiness:** `/api/ready` (backend open **and** migrated; login-independent;
  returns `503` until ready). Use `/api/ready` for the readiness probe and as the
  gate for rolling updates.
- **PostgreSQL volume:** do **not** mount a SQLite data volume in PostgreSQL
  mode. The image has no SQLite filesystem dependency in this mode. Remove any
  SQLite `PersistentVolumeClaim`/`volume` wiring for the PostgreSQL deployment.

---

## HTTPS and backup recovery

- **HTTPS:** terminate TLS at the ingress/reverse proxy (preserve
  `X-Forwarded-Proto` / set `ORIGIN` correctly for the SvelteKit app).
  PostgreSQL client-side TLS to CNPG is separate and covered by the CA/verify-full
  inputs above.
- **Backup retention:** rely on the CNPG cluster's native backup/retention
  configuration for the managed database (base backups + WAL). Do not rely on
  the app's user export for installation recovery.
- **Native recovery rehearsal:** before cutover, rehearse restoring the CNPG
  database from a backup and confirm `/api/ready` returns `200` with the
  expected schema version and the two-account fixture is readable. (See
  [DATABASES.md](DATABASES.md) → "Native installation backup (PostgreSQL)" and
  the CI-only recovery rehearsal in
  [DATABASE-VERIFICATION.md](DATABASE-VERIFICATION.md).)

---

## Validation checklist

A reviewer/operator can mark the handoff actionable only when:

- [ ] All **MISSING** inputs above are supplied with real values.
- [ ] Migration Job ran successfully once; app rollout followed it.
- [ ] `/api/ready` returns `200` with the expected `dialect=postgres` and
      `schemaVersion`.
- [ ] A two-account fixture exists and privacy/ownership boundaries hold.
- [ ] Native CNPG backup restore was rehearsed and validated.
- [ ] No SQLite volume is attached in PostgreSQL mode.
- [ ] One replica is running; probes use `/api/health` + `/api/ready`.
- [ ] HTTPS works end-to-end with the correct `ORIGIN`.

---

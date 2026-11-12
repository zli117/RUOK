# Manual production-image verification

For maintainers validating a local production image before acceptance. These
checks run manually; they do not change CI/CD or publish/deploy anything.

Requirements: Docker or Podman, host Bash/curl/Node, a free local port (3180 by
default), and a disposable live PostgreSQL database for the PostgreSQL run.
The production Dockerfile uses its committed lockfile and Node 22 Alpine base.
Do not run these destructive cleanup/test scripts against production databases.

Build once, then reuse the **same local image ID** for both backend scenarios:

```bash
# Set RUOK_CONTAINER_ENGINE=podman when using Podman; default is docker.
export RUOK_CONTAINER_ENGINE=podman
podman build --format docker -t localhost/ruok:smoke .
export RUOK_SMOKE_IMAGE=$(podman image inspect --format '{{.Id}}' localhost/ruok:smoke)
export RUOK_SMOKE_SKIP_BUILD=1
bash tests/container/smoke-sqlite.sh
# Supply DATABASE_URL privately in the environment; never paste credentials into logs.
bash tests/container/smoke-postgres.sh
```

Without `RUOK_SMOKE_SKIP_BUILD=1`, each entrypoint builds its selected image.
Podman builds use Docker format to retain the Dockerfile HEALTHCHECK.
Both resolve the image to an immutable local ID before starting containers and
print that ID; a local ID is not a registry manifest digest. PostgreSQL requires
an explicit `DATABASE_URL` reachable **from inside the application container**.
A host-loopback URL alone generally does not reach the host from a container.
The PostgreSQL check never accepts an absent URL or substitutes SQLite.

Each run checks readiness and liveness, runs the bundled migration command with
production dependencies, registers a unique account and creates an objective,
then validates exact ID and title before and after restart. After restart it
logs into the same account without recreating the objective. SQLite uses a named
data volume; PostgreSQL uses no SQLite volume and checks absence of the SQLite
file before and after restart. Container/volume cleanup is best effort and never
changes a primary failure into success. The SQLite volume check uses the same
production image, requiring no extra helper image.

Every required HTTP status, JSON response, nonempty ID, readiness deadline and
exact stored-value assertion is fatal on failure. Curl transport calls are
bounded (`RUOK_SMOKE_HTTP_TIMEOUT`, default 10 seconds); each readiness request
is bounded to 5 seconds and the complete readiness loop to
`RUOK_SMOKE_READY_TIMEOUT` (default 120 seconds). Set `RUOK_SMOKE_PORT` to choose a
different host port. Cookie jars are temporary and are removed on exit; response
bodies, account passwords and connection URLs are not printed.

Health means the process is alive; readiness reflects storage availability.
A missing/unavailable PostgreSQL backend is a failed full verification, not a
passing no-SQLite-only scenario. Both live backend positives and controlled
lost-write/never-ready negatives are required for image evidence. A negative is
valid only when the intended fault is reached and the script exits nonzero.

## Supplemental host SQLite runtime check

After an existing `npm run build` and standalone migration bundle are available:

```bash
bash tests/container/smoke-host-sqlite.sh
```

This uses the shared strict HTTP and exact persistence assertions with the
compiled Node runtime. It is supplemental host proof and does **not** replace
mandatory production-image runs on both backends. `RUOK_SMOKE_DATA_DIR` selects
its disposable storage; server logs remain there for diagnosis.

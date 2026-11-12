#!/usr/bin/env bash
# Manual production-image PostgreSQL persistence check; requires a live backend.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"
[ -n "${DATABASE_URL:-}" ] || { fail 'DATABASE_URL is required for live PostgreSQL verification'; exit 1; }
NAME="ruok-smoke-postgres"
COOKIE_JAR=$(mktemp)
trap 'rm -f "$COOKIE_JAR"; smoke_cleanup "$NAME"' EXIT
smoke_build
smoke_cleanup "$NAME"
engine run -d --name "$NAME" \
  -e DATABASE_TYPE=postgres -e DATABASE_URL -e DATABASE_CONNECT_TIMEOUT_MS=3000 \
  -e NODE_ENV=production -p "$SMOKE_PORT":3000 "$IMAGE_ID"
wait_ready "$SMOKE_PORT"
http_json GET /api/health 200 >/dev/null
engine exec "$NAME" test ! -e /app/data/okr.db
engine exec "$NAME" node build/db-migrate.mjs
smoke_account
smoke_write
engine restart "$NAME" >/dev/null
wait_ready "$SMOKE_PORT"
smoke_reauthenticate
smoke_read
engine exec "$NAME" test ! -e /app/data/okr.db
echo "### [postgres] PASS image=$IMAGE_ID"

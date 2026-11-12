#!/usr/bin/env bash
# Manual production-image SQLite persistence check.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"
NAME="ruok-smoke-sqlite"
VOL="$NAME-data"
COOKIE_JAR=$(mktemp)
trap 'rm -f "$COOKIE_JAR"; smoke_cleanup "$NAME"' EXIT
smoke_build
smoke_cleanup "$NAME"
engine run -d --name "$NAME" -v "$VOL":/app/data \
  -e DATABASE_TYPE=sqlite -e DATABASE_PATH=/app/data/okr.db -e NODE_ENV=production \
  -p "$SMOKE_PORT":3000 "$IMAGE_ID"
wait_ready "$SMOKE_PORT"
http_json GET /api/health 200 >/dev/null
engine exec "$NAME" node build/db-migrate.mjs
smoke_account
smoke_write
engine exec "$NAME" test -f /app/data/okr.db
# Inspect the persistent volume using the SAME production image (no helper image).
engine run --rm -v "$VOL":/app/data --entrypoint sh "$IMAGE_ID" -c 'test -f /app/data/okr.db'
engine restart "$NAME" >/dev/null
wait_ready "$SMOKE_PORT"
smoke_reauthenticate
smoke_read
echo "### [sqlite] PASS image=$IMAGE_ID"

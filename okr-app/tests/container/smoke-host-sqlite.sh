#!/usr/bin/env bash
# Supplemental host-runtime proof; does not replace production-image verification.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"
cd "$OKR_APP_DIR"
SMOKE_PORT="${RUOK_SMOKE_PORT:-3181}"
DATA_DIR="${RUOK_SMOKE_DATA_DIR:-$(mktemp -d)}"
SERVER_PID=""
COOKIE_JAR=$(mktemp)
cleanup() {
  rm -f "$COOKIE_JAR"
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT
start_server() {
  PORT="$SMOKE_PORT" HOST=127.0.0.1 NODE_ENV=production DATABASE_TYPE=sqlite \
    DATABASE_PATH="$DATA_DIR/okr.db" node build > "$DATA_DIR/server.log" 2>&1 &
  SERVER_PID=$!
}
DATABASE_TYPE=sqlite DATABASE_PATH="$DATA_DIR/okr.db" node build/db-migrate.mjs
start_server
wait_ready "$SMOKE_PORT"
http_json GET /api/health 200 >/dev/null
smoke_account
smoke_write
test -f "$DATA_DIR/okr.db"
kill "$SERVER_PID"
wait "$SERVER_PID" 2>/dev/null || true
SERVER_PID=""
start_server
wait_ready "$SMOKE_PORT"
smoke_reauthenticate
smoke_read
echo '### [host sqlite] PASS (supplemental host runtime, not image proof)'

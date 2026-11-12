#!/usr/bin/env bash
# Shared manual production-runtime checks. Never print credentials or cookie jars.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OKR_APP_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
CONTAINER_ENGINE="${RUOK_CONTAINER_ENGINE:-docker}"
IMAGE_NAME="${RUOK_SMOKE_IMAGE:-ruok:smoke}"
SMOKE_PORT="${RUOK_SMOKE_PORT:-3180}"
READY_TIMEOUT="${RUOK_SMOKE_READY_TIMEOUT:-120}"
HTTP_TIMEOUT="${RUOK_SMOKE_HTTP_TIMEOUT:-10}"
for value in "$READY_TIMEOUT" "$HTTP_TIMEOUT"; do
  [[ "$value" =~ ^[1-9][0-9]*$ ]] || { echo 'FAIL timeouts must be positive integer seconds' >&2; exit 1; }
done

fail() { echo "FAIL $*" >&2; return 1; }
engine() { "$CONTAINER_ENGINE" "$@"; }

smoke_build() {
  if [ "${RUOK_SMOKE_SKIP_BUILD:-0}" != 1 ]; then
    if [ "${CONTAINER_ENGINE##*/}" = podman ]; then
      (cd "$OKR_APP_DIR" && engine build --format docker -t "$IMAGE_NAME" .) || return 1
    else
      (cd "$OKR_APP_DIR" && engine build -t "$IMAGE_NAME" .) || return 1
    fi
  fi
  IMAGE_ID=$(engine image inspect --format '{{.Id}}' "$IMAGE_NAME") || return 1
  [ -n "$IMAGE_ID" ] || { fail 'image identity missing'; return 1; }
  echo "    local image ID=$IMAGE_ID (not a registry digest)"
}

wait_ready() {
  local port="$1" code remaining
  local deadline=$(( $(date +%s) + READY_TIMEOUT ))
  while :; do
    remaining=$(( deadline - $(date +%s) ))
    [ "$remaining" -gt 0 ] || { fail "readiness deadline exceeded (${READY_TIMEOUT}s)"; return 1; }
    [ "$remaining" -le 5 ] || remaining=5
    code=$(curl -s --connect-timeout 2 --max-time "$remaining" -o /dev/null -w '%{http_code}' \
      "http://127.0.0.1:${port}/api/ready") || code=000
    if [ "$code" = 200 ]; then echo '    /api/ready -> 200'; return 0; fi
    sleep 1
  done
}

# Validate status and JSON independently; bodies may contain secrets, so never log them.
http_json() {
  local method="$1" path="$2" expected="$3" body_file code
  shift 3
  body_file=$(mktemp) || return 1
  if ! code=$(curl -sS --connect-timeout 2 --max-time "$HTTP_TIMEOUT" \
    -X "$method" -b "$COOKIE_JAR" -c "$COOKIE_JAR" -o "$body_file" -w '%{http_code}' \
    -H 'Content-Type: application/json' "$@" "http://127.0.0.1:${SMOKE_PORT}${path}"); then
    rm -f "$body_file"
    fail "$method $path transport/timeout error"; return 1
  fi
  if [ "$code" != "$expected" ]; then
    rm -f "$body_file"
    fail "$method $path HTTP $code (expected $expected)"; return 1
  fi
  if ! node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$body_file" >/dev/null 2>&1; then
    rm -f "$body_file"
    fail "$method $path invalid JSON"; return 1
  fi
  cat "$body_file"
  rm -f "$body_file"
}

smoke_account() {
  SMOKE_USER="smoke_$(node -e 'console.log(require("crypto").randomBytes(8).toString("hex"))')"
  SMOKE_PASSWORD=$(node -e 'console.log(require("crypto").randomBytes(24).toString("hex"))')
  AUTH_BODY=$(node -e 'console.log(JSON.stringify({username:process.argv[1],password:process.argv[2]}))' "$SMOKE_USER" "$SMOKE_PASSWORD")
  http_json POST /api/auth/register 200 --data "$AUTH_BODY" >/dev/null
}

smoke_write() {
  OBJECTIVE_TITLE="WP08 persistence $SMOKE_USER"
  local response
  response=$(http_json POST /api/objectives 201 --data \
    "$(node -e 'console.log(JSON.stringify({title:process.argv[1],level:"yearly",year:2026}))' "$OBJECTIVE_TITLE")") || return 1
  OBJ_ID=$(printf '%s' "$response" | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      const o=JSON.parse(s).objective;
      if(!o || typeof o.id!=="string" || !o.id.trim() || o.title!==process.argv[1]) process.exit(1);
      console.log(o.id);
    });' "$OBJECTIVE_TITLE") || { fail 'objective create returned missing ID or wrong title'; return 1; }
  echo "    created objective id=$OBJ_ID"
  smoke_read
}

smoke_read() {
  local response
  response=$(http_json GET /api/objectives 200) || return 1
  if ! printf '%s' "$response" | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      const a=JSON.parse(s).objectives;
      if(!Array.isArray(a) || a.filter(o=>o.id===process.argv[1] && o.title===process.argv[2]).length!==1) process.exit(1);
    });' "$OBJ_ID" "$OBJECTIVE_TITLE"; then
    fail 'original objective ID/title missing or changed'; return 1
  fi
  echo "    exact objective verified: id=$OBJ_ID title=$OBJECTIVE_TITLE"
}

smoke_reauthenticate() {
  http_json POST /api/auth/login 200 --data "$AUTH_BODY" >/dev/null
}

smoke_cleanup() {
  engine rm -f "$1" >/dev/null 2>&1 || true
  engine volume rm "$1-data" >/dev/null 2>&1 || true
}

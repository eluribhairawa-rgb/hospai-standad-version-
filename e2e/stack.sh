#!/usr/bin/env bash
# Disposable HospAI test stack for the Selenium suite. Nothing here touches the live
# containers or database: it starts its own PostgreSQL container on a private network,
# runs the backend from this working tree and serves a fresh frontend build, all bound
# to 127.0.0.1 only.
#
#   e2e/stack.sh up      # start (prints the env vars the tests need)
#   e2e/stack.sh status
#   e2e/stack.sh down    # stop everything and delete the test database
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${E2E_WORK:-/tmp/hospai-e2e}"
NET=hospai-e2e-net
PG=hospai-e2e-pg
API_PORT="${E2E_API_PORT:-8198}"
WEB_PORT="${E2E_WEB_PORT:-8199}"
OCR_PORT="${E2E_OCR_PORT:-8197}"
PY="$ROOT/backend/.venv/bin/python"
ENV_FILE="$WORK/stack.env"

pg_ip() { docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$PG"; }

wait_http() {  # url, seconds
  for _ in $(seq 1 "$2"); do curl -fsS -o /dev/null "$1" 2>/dev/null && return 0; sleep 1; done
  echo "timed out waiting for $1" >&2; return 1
}

up() {
  mkdir -p "$WORK"
  for port in "$API_PORT" "$WEB_PORT" "$OCR_PORT"; do
    if ss -ltn | awk '{print $4}' | grep -qE "[:.]$port\$"; then echo "port $port is already in use" >&2; exit 1; fi
  done
  docker network inspect "$NET" >/dev/null 2>&1 || docker network create "$NET" >/dev/null
  docker run -d --name "$PG" --network "$NET" -e POSTGRES_USER=e2e -e POSTGRES_PASSWORD=e2e \
    -e POSTGRES_DB=hospai_e2e_test -e TZ=Asia/Kolkata -e PGTZ=Asia/Kolkata postgres:16-alpine >/dev/null
  for _ in $(seq 1 40); do docker exec "$PG" pg_isready -U e2e -d hospai_e2e_test >/dev/null 2>&1 && break; sleep 1; done
  sleep 2
  local db_url="postgresql://e2e:e2e@$(pg_ip):5432/hospai_e2e_test"
  local admin_pass; admin_pass="E2e-$(head -c 9 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')"

  # Every variable backend/.env defines is set explicitly, so the live values there are never used.
  cat > "$ENV_FILE" <<EOF
export E2E_BASE_URL=http://127.0.0.1:$WEB_PORT
export E2E_API_URL=http://127.0.0.1:$API_PORT
export E2E_OCR_STUB_URL=http://127.0.0.1:$OCR_PORT
export E2E_DATABASE_URL=$db_url
export E2E_ADMIN_USERNAME=e2e_admin
export E2E_ADMIN_PASSWORD=$admin_pass
EOF

  # Servers are exec'd (so the recorded PID is the server itself) and fully detached from
  # this shell's stdin/stdout, otherwise `stack.sh up | ...` would never return.
  ( cd "$ROOT/backend" && exec env DATABASE_URL="$db_url" SESSION_PEPPER=e2e-pepper \
      DEFAULT_ADMIN_USERNAME=e2e_admin DEFAULT_ADMIN_PASSWORD="$admin_pass" \
      CORS_ALLOWED_ORIGINS="http://127.0.0.1:$WEB_PORT" QWEN_OCR_URL="http://127.0.0.1:$OCR_PORT/v1" \
      QWEN_OCR_MODEL=e2e-stub TZ=Asia/Kolkata \
      setsid "$PY" -m uvicorn main:app --host 127.0.0.1 --port "$API_PORT" ) < /dev/null > "$WORK/backend.log" 2>&1 &
  echo $! > "$WORK/backend.pid"
  setsid "$PY" "$ROOT/e2e/ocr_stub.py" "$OCR_PORT" < /dev/null > "$WORK/ocr_stub.log" 2>&1 &
  echo $! > "$WORK/ocr_stub.pid"

  ( cd "$ROOT/frontend" && node_modules/.bin/vite build --outDir "$WORK/dist" --emptyOutDir > "$WORK/frontend_build.log" 2>&1 )
  ( cd "$ROOT/frontend" && API_TARGET="http://127.0.0.1:$API_PORT" exec setsid node_modules/.bin/vite preview \
      --outDir "$WORK/dist" --host 127.0.0.1 --port "$WEB_PORT" --strictPort ) < /dev/null > "$WORK/frontend.log" 2>&1 &
  echo $! > "$WORK/frontend.pid"

  wait_http "http://127.0.0.1:$API_PORT/health" 90
  wait_http "http://127.0.0.1:$WEB_PORT/" 60
  echo "stack up -- load the test settings with:  source $ENV_FILE"
}

down() {
  for name in frontend backend ocr_stub; do
    if [ -f "$WORK/$name.pid" ]; then kill "$(cat "$WORK/$name.pid")" 2>/dev/null || true; rm -f "$WORK/$name.pid"; fi
  done
  docker rm -f "$PG" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -f "$ENV_FILE"
  echo "stack down"
}

status() {
  docker ps --filter "name=$PG" --format '{{.Names}} {{.Status}}'
  for name in backend frontend ocr_stub; do
    pid_file="$WORK/$name.pid"
    if [ -f "$pid_file" ] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then echo "$name running"; else echo "$name stopped"; fi
  done
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  status) status ;;
  *) echo "usage: $0 up|down|status" >&2; exit 2 ;;
esac

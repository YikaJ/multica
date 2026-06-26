#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

missing=()
command -v node >/dev/null 2>&1 || missing+=("node")
command -v go >/dev/null 2>&1 || missing+=("go")
command -v docker >/dev/null 2>&1 || missing+=("docker")
command -v curl >/dev/null 2>&1 || missing+=("curl")

PNPM_BIN="${PNPM_BIN:-}"
if [ -z "$PNPM_BIN" ]; then
  package_manager="$(node -p "require('./package.json').packageManager || ''" 2>/dev/null || true)"
  if [[ "$package_manager" == pnpm@* ]]; then
    pnpm_version="${package_manager#pnpm@}"
    candidate="$HOME/Library/pnpm/.tools/pnpm/${pnpm_version}/bin/pnpm"
    if [ -x "$candidate" ]; then
      PNPM_BIN="$candidate"
    fi
  fi
fi
if [ -z "$PNPM_BIN" ]; then
  PNPM_BIN="$(command -v pnpm 2>/dev/null || true)"
fi
if [ -z "$PNPM_BIN" ]; then
  missing+=("pnpm")
fi

if [ ${#missing[@]} -gt 0 ]; then
  echo "Missing prerequisites: ${missing[*]}"
  echo "Install Node.js, pnpm, Go, and Docker before running desktop dev."
  exit 1
fi

ENV_FILE="${1:-}"
if [ -z "$ENV_FILE" ]; then
  if [ -f .git ]; then
    ENV_FILE=".env.worktree"
  else
    ENV_FILE=".env"
  fi
fi

if [ "$ENV_FILE" = ".env.worktree" ] && [ ! -f "$ENV_FILE" ]; then
  echo "==> Generating $ENV_FILE with isolated worktree ports..."
  bash scripts/init-worktree-env.sh "$ENV_FILE"
elif [ "$ENV_FILE" = ".env" ] && [ ! -f "$ENV_FILE" ]; then
  echo "==> Creating $ENV_FILE from .env.example..."
  cp .env.example "$ENV_FILE"
fi

if [ ! -f "$ENV_FILE" ]; then
  echo "Missing env file: $ENV_FILE"
  exit 1
fi

echo "==> Using $ENV_FILE"
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

# shellcheck disable=SC1091
. scripts/local-env.sh

desktop_api_url="${NEXT_PUBLIC_API_URL:-http://localhost:${PORT:-8080}}"
desktop_ws_url="${NEXT_PUBLIC_WS_URL:-ws://localhost:${PORT:-8080}/ws}"
desktop_app_url="${MULTICA_APP_URL:-${FRONTEND_ORIGIN:-http://localhost:${FRONTEND_PORT:-3000}}}"
backend_ready_url="${desktop_api_url%/}/readyz"

cat > apps/desktop/.env.development.local <<EOF
VITE_API_URL=${desktop_api_url}
VITE_WS_URL=${desktop_ws_url}
VITE_APP_URL=${desktop_app_url}
EOF

if [ ! -d node_modules ]; then
  echo "==> Installing dependencies..."
  "$PNPM_BIN" install
fi

bash scripts/ensure-postgres.sh "$ENV_FILE"

echo "==> Running migrations..."
(cd server && go run ./cmd/migrate up)

server_fingerprint() {
  find server \
    \( -path "server/bin" -o -path "server/bin/*" -o -path "server/tmp" -o -path "server/tmp/*" \) -prune -o \
    -type f \( -name "*.go" -o -name "*.sql" -o -name "*.json" -o -name "go.mod" -o -name "go.sum" \) -print |
    LC_ALL=C sort |
    while IFS= read -r file; do
      shasum "$file"
    done |
    shasum
}

SERVER_PID=""
WATCH_PID=""
DESKTOP_PID=""
SERVER_PID_FILE="${TMPDIR:-/tmp}/multica-dev-desktop-${PORT:-8080}-$$.server.pid"

child_pids() {
  local pid="$1"
  pgrep -P "$pid" 2>/dev/null || true
}

descendant_pids() {
  local pid="$1"
  local child
  for child in $(child_pids "$pid"); do
    echo "$child"
    descendant_pids "$child"
  done
}

terminate_pid_tree() {
  local pid="$1"
  if [ -z "${pid:-}" ] || ! kill -0 "$pid" 2>/dev/null; then
    return 0
  fi

  local pids
  pids="$(descendant_pids "$pid" | awk 'NF { seen[$1] = 1 } END { for (p in seen) print p }')"
  pids="${pids}
${pid}"

  # Terminate children first so wrappers such as pnpm/turbo do not leave
  # electron-vite or Electron helper processes behind after Ctrl+C.
  echo "$pids" | awk 'NF' | while IFS= read -r p; do
    kill "$p" 2>/dev/null || true
  done

  local deadline=$((SECONDS + 5))
  while [ "$SECONDS" -lt "$deadline" ]; do
    local alive=""
    while IFS= read -r p; do
      [ -z "$p" ] && continue
      if kill -0 "$p" 2>/dev/null; then
        alive=1
        break
      fi
    done <<EOF
$pids
EOF
    [ -z "$alive" ] && return 0
    sleep 0.2
  done

  echo "$pids" | awk 'NF' | while IFS= read -r p; do
    kill -9 "$p" 2>/dev/null || true
  done
}

cleanup_checkout_desktop_processes() {
  ps -axo pid=,command= |
    awk -v root="$REPO_ROOT" '
      index($0, root) > 0 &&
      ($0 ~ /pnpm dev:desktop/ || $0 ~ /turbo dev --filter=@multica\/desktop/ ||
       $0 ~ /electron-vite.* dev/ || $0 ~ /Electron \./ ||
       $0 ~ /apps\/desktop\/resources\/bin\/multica daemon start --foreground/) {
        print $1
      }
    ' |
    while IFS= read -r pid; do
      terminate_pid_tree "$pid"
    done
}

pid_cwd_under_repo() {
  local pid="$1"
  local cwd
  cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1)"
  [ -n "$cwd" ] && [[ "$cwd" == "$REPO_ROOT"* ]]
}

cleanup_checkout_backend_processes() {
  local port="${PORT:-8080}"
  local pid
  while IFS= read -r pid; do
    [ -z "$pid" ] && continue
    if pid_cwd_under_repo "$pid"; then
      echo "==> Stopping stale backend process on port ${port}: ${pid}"
      terminate_pid_tree "$pid"
    fi
  done < <(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)
}

start_server() {
  echo "==> Starting backend on http://localhost:${PORT:-8080}"
  (cd server && go run ./cmd/server) &
  SERVER_PID=$!
  printf "%s\n" "$SERVER_PID" >"$SERVER_PID_FILE"
}

stop_server() {
  local pid="${SERVER_PID:-}"
  if [ -z "$pid" ] && [ -f "$SERVER_PID_FILE" ]; then
    pid="$(cat "$SERVER_PID_FILE" 2>/dev/null || true)"
  fi

  terminate_pid_tree "$pid"
  if [ -n "$pid" ]; then
    wait "$pid" 2>/dev/null || true
  fi
  rm -f "$SERVER_PID_FILE"
}

wait_for_backend_ready() {
  local timeout="${BACKEND_READY_TIMEOUT:-90}"
  local deadline=$((SECONDS + timeout))

  echo "==> Waiting for backend to be ready at ${backend_ready_url}..."
  while [ "$SECONDS" -lt "$deadline" ]; do
    if curl -sf "$backend_ready_url" >/dev/null 2>&1; then
      echo "==> Backend is ready."
      return 0
    fi

    if [ -n "${WATCH_PID:-}" ] && ! kill -0 "$WATCH_PID" 2>/dev/null; then
      wait "$WATCH_PID" 2>/dev/null || true
      echo "Backend exited before it became ready."
      return 1
    fi

    sleep 1
  done

  echo "Backend did not become ready within ${timeout}s."
  echo "Check the backend output above, then retry."
  return 1
}

cleanup() {
  trap - INT TERM EXIT
  stop_server
  terminate_pid_tree "${WATCH_PID:-}"
  wait "${WATCH_PID:-}" 2>/dev/null || true
  terminate_pid_tree "${DESKTOP_PID:-}"
  wait "${DESKTOP_PID:-}" 2>/dev/null || true
  cleanup_checkout_desktop_processes
  rm -f "$SERVER_PID_FILE"
}

watch_server() {
  local last
  local next
  last="$(server_fingerprint)"
  start_server

  while true; do
    sleep "${SERVER_RELOAD_POLL_INTERVAL:-1}"

    if [ -n "${SERVER_PID:-}" ] && ! kill -0 "$SERVER_PID" 2>/dev/null; then
      wait "$SERVER_PID"
      exit $?
    fi

    next="$(server_fingerprint)"
    if [ "$next" != "$last" ]; then
      echo "==> Backend files changed. Restarting server..."
      stop_server
      (cd server && go run ./cmd/migrate up)
      start_server
      last="$next"
    fi
  done
}

trap cleanup INT TERM EXIT

echo ""
echo "Desktop dev is starting with hot reload:"
echo "  Backend:  http://localhost:${PORT:-8080} (restarts on server file changes)"
echo "  Desktop:  pnpm dev:desktop (Electron/Vite HMR)"
echo "  API env:  ${desktop_api_url}"
echo ""

other_desktops="$(
  ps -axo pid=,command= |
    awk -v root="$REPO_ROOT" '
      /pnpm dev:desktop|electron-vite.* dev|Electron \.$/ {
        if (index($0, root) == 0) print
      }
    ' || true
)"
if [ -n "$other_desktops" ]; then
  echo "Warning: another desktop dev process from a different checkout is running."
  echo "Make sure you use this worktree app window, not the other one:"
  echo "$other_desktops"
  echo ""
fi

cleanup_checkout_backend_processes

watch_server &
WATCH_PID=$!

wait_for_backend_ready

CI=true "$PNPM_BIN" dev:desktop &
DESKTOP_PID=$!

wait "$DESKTOP_PID"

#!/usr/bin/env bash
# Requirements: Docker Compose, uv, Node.js/npm, installed server/web npm
# dependencies, a valid server/.env, and the LM Studio models from README.md.
set -euo pipefail
set -m

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
log_dir="${TMPDIR:-/tmp}/borealis-dev"
mkdir -p "$log_dir"

for required_command in docker uv node npm; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    printf 'Missing required command: %s\n' "$required_command" >&2
    exit 1
  fi
done

if [[ ! -f "$root/server/.env" ]]; then
  printf 'Missing server/.env. Copy server/.env.example and set JWT_SECRET first.\n' >&2
  exit 1
fi
if [[ ! -d "$root/server/node_modules" || ! -d "$root/web/node_modules" ]]; then
  printf 'Missing npm dependencies. Run npm install in server/ and web/ first.\n' >&2
  exit 1
fi

# Match the server's required-secret/model validation before starting anything.
(
  cd "$root/server"
  node --input-type=module <<'NODE'
import "dotenv/config";

const secret = process.env.JWT_SECRET ?? "";
const weak = new Set(["", "dev-secret-change-me", "please-change-me", "change-me"]);
if (weak.has(secret) || secret.length < 32) {
  console.error("Configuration error: JWT_SECRET must be a random value of at least 32 characters");
  process.exit(1);
}

const chat = (process.env.LITELLM_CHAT_MODEL ?? "qwen-chat").trim();
const embed = (process.env.LITELLM_EMBED_MODEL ?? "nomic-embed").trim();
if (!chat || chat.length > 256 || !embed || embed.length > 256 || chat === embed) {
  console.error("Configuration error: LITELLM chat and embedding model IDs must be distinct and 1-256 characters");
  process.exit(1);
}
NODE
)

if [[ ! -d "$root/python/.venv" || "$root/python/pyproject.toml" -nt "$root/python/.venv" ]]; then
  (cd "$root/python" && uv sync)
fi

docker compose --project-directory "$root" -f "$root/docker-compose.yml" config >/dev/null
docker compose --project-directory "$root" -f "$root/docker-compose.yml" up -d postgres
until docker compose --project-directory "$root" -f "$root/docker-compose.yml" exec -T postgres pg_isready -U borealis >/dev/null 2>&1; do
  sleep 1
done

prefix_logs() {
  local service="$1"
  local line
  while IFS= read -r line || [[ -n "$line" ]]; do
    printf '[%s] %s\n' "$service" "$line"
  done
}

child_pids=()
child_services=()
start_service() {
  local service="$1"
  local directory="$2"
  shift 2
  (
    cd "$directory"
    "$@" 2>&1 | prefix_logs "$service" | tee "$log_dir/$service.log"
  ) &
  child_pids+=("$!")
  child_services+=("$service")
}

cleanup() {
  trap - EXIT INT TERM
  local child_pid
  for child_pid in "${child_pids[@]}"; do
    kill -- "-$child_pid" 2>/dev/null || true
  done
  wait "${child_pids[@]}" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

start_service litellm "$root/python" uv run litellm --config litellm.yaml --port 4000
if [[ "$(uname -s)" == "Darwin" ]]; then
  start_service python "$root/python" env DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib .venv/bin/uvicorn app.main:app --port 8000
else
  start_service python "$root/python" .venv/bin/uvicorn app.main:app --port 8000
fi
start_service server "$root/server" npm run dev
start_service web "$root/web" npm run dev

printf 'Borealis development stack is starting.\n'
printf '  Web:            http://127.0.0.1:5173\n'
printf '  Server:         http://127.0.0.1:3000\n'
printf '  Python service: http://127.0.0.1:8000\n'
printf '  LiteLLM proxy:  http://127.0.0.1:4000\n'
printf '  Logs:           %s\n' "$log_dir"

# Portable fail-fast supervision (macOS ships a Bash without `wait -n`).
while true; do
  for index in "${!child_pids[@]}"; do
    child_pid="${child_pids[$index]}"
    if ! kill -0 "$child_pid" 2>/dev/null; then
      set +e
      wait "$child_pid"
      child_status=$?
      set -e
      if [[ "$child_status" -eq 0 ]]; then
        child_status=1
      fi
      printf '[%s] service exited; stopping the development stack.\n' "${child_services[$index]}" >&2
      exit "$child_status"
    fi
  done
  sleep 1
done

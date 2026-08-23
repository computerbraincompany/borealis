#!/usr/bin/env bash
# Requirements: Docker Compose, uv, Node.js/npm, curl, a valid server/.env,
# and the LM Studio models from README.md. Locked dependencies are synchronized.
set -euo pipefail
set -m

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
log_dir="${TMPDIR:-/tmp}/borealis-dev"
mkdir -p "$log_dir"

for required_command in docker uv node npm curl openssl; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    printf 'Missing required command: %s\n' "$required_command" >&2
    exit 1
  fi
done

if ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major === 22 && minor >= 13 ? 0 : 1)'; then
  printf 'Unsupported Node.js version: expected 22.13 or newer 22.x, found %s.\n' "$(node --version)" >&2
  exit 1
fi

if [[ ! -f "$root/server/.env" ]]; then
  printf 'Missing server/.env. Copy server/.env.example and set JWT_SECRET, PYTHON_SERVICE_TOKEN, and LITELLM_API_KEY.\n' >&2
  exit 1
fi

sync_node_dependencies() {
  local directory="$1"
  local expected_hash
  local stamp="$directory/node_modules/.borealis-lock-hash"
  expected_hash="$(node -e 'const fs=require("fs"),crypto=require("crypto"); const hash=crypto.createHash("sha256"); for (const file of process.argv.slice(1)) hash.update(fs.readFileSync(file)); process.stdout.write(hash.digest("hex"))' "$directory/package.json" "$directory/package-lock.json")"
  if [[ ! -d "$directory/node_modules" || ! -f "$stamp" || "$(<"$stamp")" != "$expected_hash" ]]; then
    (cd "$directory" && npm ci --no-audit --no-fund)
    printf '%s' "$expected_hash" > "$stamp"
  fi
}

sync_node_dependencies "$root/server"
sync_node_dependencies "$root/web"
(cd "$root/python" && uv sync --locked)
python_version="$(cd "$root/python" && uv run --no-sync python -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
if [[ "$python_version" != "3.12" ]]; then
  printf 'Unsupported Python version: expected 3.12.x, found %s.\n' "$python_version" >&2
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

const serviceToken = process.env.PYTHON_SERVICE_TOKEN ?? "";
if (weak.has(serviceToken) || serviceToken.length < 32) {
  console.error("Configuration error: PYTHON_SERVICE_TOKEN must be a random value of at least 32 characters");
  process.exit(1);
}

const proxyKey = process.env.LITELLM_API_KEY ?? "";
if (weak.has(proxyKey) || proxyKey.length < 32) {
  console.error("Configuration error: LITELLM_API_KEY must be a random value of at least 32 characters");
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

python_service_token="$({ cd "$root/server" && node --input-type=module -e 'import "dotenv/config"; process.stdout.write(process.env.PYTHON_SERVICE_TOKEN ?? "")'; })"
export BOREALIS_SERVICE_TOKEN="$python_service_token"
litellm_master_key="$({ cd "$root/server" && node --input-type=module -e 'import "dotenv/config"; process.stdout.write(process.env.LITELLM_API_KEY ?? "")'; })"
export LITELLM_MASTER_KEY="$litellm_master_key"
export LM_STUDIO_API_KEY="${LM_STUDIO_API_KEY:-$(openssl rand -hex 32)}"
python_storage_dir="$({ cd "$root/server" && node --input-type=module -e 'import "dotenv/config"; import path from "node:path"; process.stdout.write(path.resolve(process.env.UPLOAD_DIR || "../uploads"))'; })"
export BOREALIS_STORAGE_DIR="$python_storage_dir"

docker compose --project-directory "$root" -f "$root/docker-compose.yml" config >/dev/null
docker compose --project-directory "$root" -f "$root/docker-compose.yml" up -d postgres
postgres_ready=false
for _ in {1..120}; do
  if docker compose --project-directory "$root" -f "$root/docker-compose.yml" exec -T postgres pg_isready -U borealis >/dev/null 2>&1; then
    postgres_ready=true
    break
  fi
  if ! docker compose --project-directory "$root" -f "$root/docker-compose.yml" ps --status running --services postgres 2>/dev/null | grep -qx postgres; then
    break
  fi
  sleep 1
done
if [[ "$postgres_ready" != true ]]; then
  printf 'PostgreSQL did not become ready within 120 seconds.\n' >&2
  docker compose --project-directory "$root" -f "$root/docker-compose.yml" ps postgres >&2 || true
  docker compose --project-directory "$root" -f "$root/docker-compose.yml" logs --tail=50 postgres >&2 || true
  exit 1
fi

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

start_service litellm "$root/python" uv run litellm --config litellm.yaml --host 127.0.0.1 --port 4000
if [[ "$(uname -s)" == "Darwin" ]]; then
  mac_library_path="${DYLD_FALLBACK_LIBRARY_PATH:-}"
  if command -v brew >/dev/null 2>&1; then
    homebrew_library_path="$(brew --prefix)/lib"
    mac_library_path="${homebrew_library_path}${mac_library_path:+:${mac_library_path}}"
  fi
  if [[ -n "$mac_library_path" ]]; then
    start_service python "$root/python" env DYLD_FALLBACK_LIBRARY_PATH="$mac_library_path" .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000
  else
    start_service python "$root/python" .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000
  fi
else
  start_service python "$root/python" .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000
fi

python_ready=false
for _ in {1..120}; do
  if curl --fail --silent --show-error http://127.0.0.1:8000/health >/dev/null 2>&1; then
    python_ready=true
    break
  fi
  sleep 1
done
if [[ "$python_ready" != true ]]; then
  printf 'Python service did not become ready within 120 seconds. See %s/python.log.\n' "$log_dir" >&2
  exit 1
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

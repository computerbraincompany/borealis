#!/usr/bin/env bash
# Requirements: Node.js 22.13+ and npm 10.9+. Borealis uses embedded
# SQLite, LanceDB, and DuckDB; no Docker service is required.
set -euo pipefail
set -m

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
log_dir="${TMPDIR:-/tmp}/borealis-dev"
mkdir -p "$log_dir"

for required_command in node npm; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    printf 'Missing required command: %s\n' "$required_command" >&2
    exit 1
  fi
done

if ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major === 22 && minor >= 13 ? 0 : 1)'; then
  printf 'Unsupported Node.js version: expected 22.13 or newer 22.x, found %s.\n' "$(node --version)" >&2
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

start_service server "$root/server" npm run dev
start_service web "$root/web" npm run dev

printf 'Borealis development stack is starting.\n'
printf '  Web:            http://127.0.0.1:5173\n'
printf '  Server:         http://127.0.0.1:3000\n'
printf '  Storage:        %s\n' "$root/.borealis"
printf '  Model endpoint: configured in Settings (default http://127.0.0.1:1234)\n'
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

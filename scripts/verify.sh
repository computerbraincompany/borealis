#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# macOS strips DYLD_* variables while launching system-protected shell
# interpreters. Reconstruct the Homebrew library path inside this process so
# the canonical gate actually exercises WeasyPrint instead of silently
# skipping its PDF tests.
if [[ "$(uname -s)" == "Darwin" ]] && command -v brew >/dev/null 2>&1; then
  homebrew_library_path="$(brew --prefix)/lib"
  export DYLD_FALLBACK_LIBRARY_PATH="${homebrew_library_path}${DYLD_FALLBACK_LIBRARY_PATH:+:${DYLD_FALLBACK_LIBRARY_PATH}}"
fi

(cd "$root/server" && \
  npm run typecheck && \
  npm run lint && \
  npm run format:check && \
  npm test && \
  npm run build)

(cd "$root/web" && npm run verify)

(cd "$root/python" && \
  uv run --locked ruff check . && \
  uv run --locked ruff format --check . && \
  uv run --locked pytest -q)

if [[ -n "${TEST_DATABASE_URL:-}" ]]; then
  (cd "$root/server" && npm run test:integration)
  echo "ALL GATES GREEN"
else
  echo "LOCAL GATES GREEN (PostgreSQL integration skipped: set TEST_DATABASE_URL to include it)"
fi

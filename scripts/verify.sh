#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

(cd "$root/server" && npm run typecheck && npm test)
(cd "$root/web" && npm run typecheck)
(cd "$root/python" && uv run pytest -q)

echo "ALL GATES GREEN"

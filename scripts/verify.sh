#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if rg -n '"xlsx"' "$root/server/package.json" "$root/server/package-lock.json"; then
  echo 'SheetJS is forbidden; use the bounded ExcelJS reader.' >&2
  exit 1
fi

(cd "$root/server" && \
  npx --no-install tsc --noEmit --strict --target ES2022 --module ESNext --moduleResolution Bundler \
    --types node ../data/generate_sample.ts && \
  npx --no-install prettier --check ../data/generate_sample.ts)

sample_check_dir="$(mktemp -d "${TMPDIR:-/tmp}/borealis-sample-check.XXXXXX")"
cleanup_sample_check() {
  rm -rf -- "$sample_check_dir"
}
trap cleanup_sample_check EXIT
mkdir -p "$sample_check_dir/data"
cp "$root/data/generate_sample.ts" "$sample_check_dir/data/generate_sample.ts"
(cd "$root/server" && npx --no-install tsx "$sample_check_dir/data/generate_sample.ts" >/dev/null)
for fixture in accounts.csv budget.csv networth.csv transactions.csv; do
  cmp "$sample_check_dir/data/sample/$fixture" "$root/data/sample/$fixture"
done
cleanup_sample_check
trap - EXIT

(cd "$root/server" && \
  npm run typecheck && \
  npm run lint && \
  npm run format:check && \
  npm test && \
  npm run test:integration && \
  npm run build)

(cd "$root/web" && npm run verify)

# The desktop test command performs a clean TypeScript build before running the
# compiled Node tests. Keep the GUI render smoke in its focused macOS gate; the
# repository-wide gate still proves the Electron ABI for every native engine.
(cd "$root/desktop" && \
  npm run typecheck && \
  npm test && \
  npm run format:check && \
  npm run native:smoke)

if rg -n \
  'uvicor[n]|weasyprin[t]|openpyx[l]|lite[l]lm|PYTHON_SERVIC[E]_|BOREALIS_SERVICE_TOKE[N]|from openpyx[l]|uv ru[n]|LiteL[L]M gateway|Python data servic[e]' \
  "$root" --hidden --glob '!.git/**' --glob '!plans/**' --glob '!docs/cohere-north/**' --glob '!scripts/verify.sh'; then
  echo 'Removed runtime or service references remain outside historical plans.' >&2
  exit 1
fi

if rg -ni \
  'postgre(s|sql)|\bpg\b|DATABASE_URL|TEST_DATABASE_URL|pgvector|SKIP LOCKED|FOR UPDATE|::(uuid|jsonb|vector|timestamptz)|jsonb_' \
  "$root/server" "$root/web" "$root/scripts" "$root/.github" \
  --glob '!**/node_modules/**' --glob '!**/dist/**' --glob '!**/data/assets/**' \
  --glob '!package-lock.json' --glob '!scripts/verify.sh'; then
  echo 'Removed database runtime or test references remain in the embedded-storage path.' >&2
  exit 1
fi

if rg -ni \
  'postgre(s|sql)|pgvector|docker[- ]compose|TEST_DATABASE_URL|LiteLLM (proxy|gateway|service|runtime)|Python (data|report) service' \
  "$root/README.md" "$root/AGENTS.md" "$root/docs" "$root/server/.env.example" "$root/desktop/README.md" \
  --glob '!cohere-north/**'; then
  echo 'Stale external-service documentation remains outside historical plans.' >&2
  exit 1
fi

echo "ALL GATES GREEN"

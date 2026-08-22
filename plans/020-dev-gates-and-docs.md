# Plan 020: One command to run it, one command to verify it — and docs that tell the truth

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 567481d..HEAD -- AGENTS.md README.md docker-compose.yml server/src/index.ts server/src/config.ts server/.env.example`
> On any diff, compare "Current state" excerpts against live code; mismatch → STOP.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW (one behavior change: default bind host narrows to loopback)
- **Depends on**: none
- **Category**: dx / docs / security-hardening
- **Planned at**: commit `567481d`, 2026-08-23

## Why this matters

The repo's own docs are wrong in ways that cost every new clone (human or
agent): AGENTS.md says "There are no tests yet" although two suites landed in
commit `e82c75c` — so executors following AGENTS.md never run them;
docker-compose points to `scripts/dev.sh`, which has never existed; README
claims LM Studio "works out of the box" without saying WHICH two models must
be loaded (chat + a 768-dim embedding model), so the first chat request fails
with an unactionable "model not found"; and there is no Linux note for
WeasyPrint's system libraries even though PDFs are a headline feature. On top,
getting started takes ~5 commands across 4 terminals with ordering constraints.
Finally, the stack binds wider than its local-first threat model: Fastify
listens on `0.0.0.0` and Postgres publishes on all interfaces with committed
dev credentials — anything on the LAN can reach both.

## Current state

Files and their roles:

- `AGENTS.md` — instructions every executor/agent reads first.
- `README.md` — public getting-started doc.
- `docker-compose.yml` — Postgres + pgvector (:5433).
- `server/src/config.ts` — env parsing; exports `config`.
- `server/src/index.ts` — app boot/listen.

Current exact facts:

- `AGENTS.md:41`: `There are no tests yet. The docker-compose comment references \`scripts/dev.sh\`` — both halves stale once this plan lands. No `scripts/` dir exists (`ls scripts` → No such file).
- `AGENTS.md` Commands block lists no test commands; same for README.
- `docker-compose.yml` ports block:
```yaml
    ports:
      # host 5433 (local Postgres may own 5432) -> container 5432
      - "5433:5432"
```
  (publishes on all interfaces; credentials `north`/`north_password` are
  committed dev defaults).
- `server/src/index.ts:17`: `await app.listen({ port: config.port, host: "0.0.0.0" });`
- `server/src/config.ts` style to match:
```ts
export const config = {
  port: Number(process.env.PORT || 3000),
  ...
  pythonServiceUrl: process.env.PYTHON_SERVICE_URL || "http://localhost:8000",
```
- `python/litellm.yaml` aliases (verified): `qwen-chat` → `openai/qwen/qwen3.6-35b-a3b`,
  `nomic-embed` → `openai/text-embedding-nomic-embed-text-v1.5`; `.env.example`
  sets `EMBEDDING_DIM=768` (coupled to nomic-embed — changing models changes
  the dim and breaks pgvector queries against existing tables).
- Test gates that exist today but are undocumented: `cd server && npm test`
  (vitest), `cd python && uv run pytest`, `cd web && npm run typecheck`.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Server typecheck | `cd server && npm run typecheck` | exit 0 |
| Server tests | `cd server && npm test` | all pass |
| Python tests | `cd python && uv run pytest` | all pass |
| Web typecheck | `cd web && npm run typecheck` | exit 0 |
| Compose syntax check | `docker compose -f docker-compose.yml config >/dev/null` | exit 0 |

## Scope

**In scope**:
- `scripts/dev.sh` (create), `scripts/verify.sh` (create)
- `AGENTS.md`, `README.md`, `server/.env.example`
- `docker-compose.yml` (ports line only)
- `server/src/config.ts`, `server/src/index.ts` (HOST var + listen + log line)
- `plans/README.md` (status row)

**Out of scope (do NOT touch)**:
- CI workflows (deferred direction item — this plan makes CI trivial later, doesn't add it).
- Lint/formatter tooling (separate decision).
- Any auth/credential values — compose creds stay as documented dev defaults.
- LiteLLM/LM Studio configuration files.

## Git workflow

- Branch: `advisor/020-dev-gates-and-docs`
- Commits per step, conventional style (e.g. `docs: replace stale "no tests" note with real gates`).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Write scripts/dev.sh

Create `scripts/dev.sh` (bash, `set -euo pipefail`) that:
1. `docker compose up -d postgres`, then wait for health:
   `until docker compose exec -T postgres pg_isready -U north >/dev/null 2>&1; do sleep 1; done`
2. If `python/.venv` is missing or `pyproject.toml` is newer: `cd python && uv sync`.
3. Launch with per-service prefixed logs into a log dir under `/tmp/borealis-dev/`
   (or `scripts/.logs/`, gitignored): litellm (`uv run litellm --config litellm.yaml --port 4000`),
   uvicorn (on macOS prefix `DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib`;
   detect with `[[ "$(uname)" == "Darwin" ]]`), server (`npm run dev`),
   web (`npm run dev`). Use absolute repo-root-relative cd paths derived from
   `$(dirname "$0")/..`.
4. `trap 'kill 0' EXIT INT TERM` so Ctrl-C tears down children; print the four
   URLs at the end and `wait`.

Add `chmod +x`. Update `docker-compose.yml`'s comment from "(see
scripts/dev.sh)" so it stays true (it now does).

**Verify**: `bash -n scripts/dev.sh` → exit 0; `docker compose -f docker-compose.yml config >/dev/null` → 0.

### Step 2: Write scripts/verify.sh

Create `scripts/verify.sh` running ALL gates with early exit:

```bash
#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
(cd "$root/server" && npm run typecheck && npm test)
(cd "$root/web" && npm run typecheck)
(cd "$root/python" && uv run pytest -q)
echo "ALL GATES GREEN"
```

`chmod +x`.

**Verify**: `bash -n scripts/verify.sh` → 0; run it once with services NOT required (tests are offline) → `ALL GATES GREEN`.

### Step 3: Fix the stale docs

1. Replace `AGENTS.md`'s "There are no tests yet..." sentence with:

```markdown
Test/typecheck gates (all offline, no services needed):
`cd server && npm test`, `cd python && uv run pytest`, `cd web && npm run typecheck`
— or run everything via `scripts/verify.sh`. Dev orchestration: `scripts/dev.sh`
(brings up postgres, python service, litellm proxy, server, web).
```

2. README getting-started: add a callout right before the numbered steps:
   "One-command alternative: `./scripts/dev.sh` starts everything (see
   script header for requirements). The steps below explain each piece."
3. README prerequisites paragraph: after the LM Studio sentence add:

```markdown
Two models must be loaded in LM Studio with ids matching `python/litellm.yaml`:
a CHAT model (default alias `qwen-chat` → `openai/qwen/qwen3.6-35b-a3b`) and an
EMBEDDING model (default alias `nomic-embed` → `text-embedding-nomic-embed-text-v1.5`,
768 dims). Using different models? Edit the aliases in `litellm.yaml` and set
`LITELLM_*` env vars accordingly — if you change the embedding model you MUST
also change `EMBEDDING_DIM` BEFORE first ingest (the vector column size is fixed
at schema creation).
```

4. Next to the existing macOS WeasyPrint note add:
   "On Linux install the system libraries instead (e.g. Debian/Ubuntu:
   `sudo apt install libpango-1.0-0 libpangoft2-1.0-0 libglib2.0-0`); no
   DYLD variable is needed. See WeasyPrint's dependency docs."

**Verify**: `grep -n "no tests yet" AGENTS.md` → no matches; `grep -n "qwen-chat" README.md` → present; `grep -rn "libpango" README.md` → present.

### Step 4: Bind services to loopback by default

1. `server/src/config.ts`: add `host: process.env.HOST || "127.0.0.1",` next to `port`.
2. `server/src/index.ts`: `await app.listen({ port: config.port, host: config.host });`
   and change the boot log to include the host
   (`console.log(\`North server listening on ${config.host}:${config.port}\`)`).
3. `server/.env.example`: document `# HOST=127.0.0.1  # set 0.0.0.0 only if you deliberately want LAN access`.
4. `docker-compose.yml` ports: `- "127.0.0.1:5433:5432"` (keep the comment).

**Verify**: `cd server && npm run typecheck` → 0; restart server → boot line shows `127.0.0.1:3000`; `docker compose up -d postgres && docker compose port postgres 5432` → output starts with `127.0.0.1:`.

### Step 5: Run the whole gate

**Verify**: `./scripts/verify.sh` → `ALL GATES GREEN` (this also proves Step 3's documented commands are accurate).

## Test plan

No product tests added (docs/tooling plan). Verification IS the gate suite +
Step 1/4 live checks. Existing tests must stay green (they do not touch HOST).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `test -x scripts/dev.sh && test -x scripts/verify.sh` → true
- [ ] `grep -c "no tests yet" AGENTS.md` → 0
- [ ] `grep -n "127.0.0.1:5433:5432" docker-compose.yml` → present
- [ ] Server boots with `listening on 127.0.0.1:3000` log line (or report why not)
- [ ] `./scripts/verify.sh` exits 0 with `ALL GATES GREEN`
- [ ] `grep -n "EMBEDDING_DIM" README.md` → present
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The operator's environment needs LAN access to any of these services right
  now (ask — don't silently keep 0.0.0.0 OR silently break their setup).
- `uv sync`/`npm install` state on this machine makes verify.sh fail for
  environment reasons (report the failing command verbatim).
- Any documented gate command itself fails — that contradicts the plan's
  premise; report instead of editing tests.

## Maintenance notes

- When CI lands (still a deferred direction item), it should call
  `scripts/verify.sh` plus a postgres service container for any future
  route-level integration tests — one canonical gate, two consumers.
- HOST default change is observable by anything that previously relied on LAN
  access; the .env.example override is the escape hatch to document in release notes.

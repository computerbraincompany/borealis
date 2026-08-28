# Plan 029: Replace Python 100% with TypeScript / Node.js

> **Completed historical plan.** The [ledger](README.md) records this plan as
> DONE. The original instructions, code excerpts, paths, and checklists below
> describe its implementation-era tree; do not execute them against the current
> checkout. For supported behavior and commands, use the [project README](../README.md),
> [API reference](../docs/API.md), and [desktop guide](../desktop/README.md).

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Do not implement this as one unreviewable dump.** Ship the six phases
> below as sequential changes. Each phase must leave `scripts/verify.sh`
> green. Do not delete `python/` until Phase 5.
>
> **Drift check (run first)**:
> `git diff --stat 130481b..HEAD -- python/ server/src/pythonClient.ts server/src/ingest.ts server/src/ingestionFailures.ts server/src/systemHealth.ts server/src/routes/system.ts server/src/tools.ts server/src/agent.ts server/src/llm.ts server/src/config.ts server/src/networkPolicy.ts server/src/storageArtifacts.ts server/src/routes/connectors.ts server/src/routes/sources.ts scripts/dev.sh scripts/verify.sh .github/workflows/ci.yml README.md AGENTS.md docs/API.md server/.env.example data/generate_sample.py web/src/lib/chartOption.ts web/src/components/SystemHealthPanel.tsx web/src/pages/SettingsView.tsx plans/README.md`
> Reconcile live code with "Current state", "Tree since this plan was written",
> and "Node-facing contracts". Any unexplained mismatch is a STOP condition.

## Status

- **Priority**: P2
- **Status**: DONE (implemented and verified 2026-08-26)
- **Effort**: XL
- **Risk**: HIGH (a partial port would split DuckDB/PDF/XLSX contracts)
- **Depends on**: `plans/028-deep-audit-remediation.md`
- **Category**: architecture / ops
- **Planned at**: commit `7d5576d`, 2026-08-25
- **Reconciled against**: commit `130481b`, 2026-08-26

## Why this matters

The FastAPI service and the LiteLLM proxy exist because DuckDB, matplotlib,
WeasyPrint, OpenPyXL, and LiteLLM were the cheapest libraries for those jobs,
not because TypeScript cannot do them. The cost is a second runtime, uv,
WeasyPrint system libs, a service token, ports 8000/4000, and a split-brain
registry whenever Node is up and Python is not.

This plan folds that work into the existing Fastify process and deletes
Python from the repo. It is a **contract-preserving rewrite**, not a
redesign. Agent tools, RAG, auth, public HTTP, and the staged connector
protocol stay the same.

## Locked decisions

1. **In-process Fastify** — not a port-8000 TypeScript sidecar. DuckDB/XLSX
   run in a dedicated **worker thread** so a 30s query cannot stall chat SSE.
   Playwright already isolates Chromium in a child process.
2. **Playwright/Chromium** for chart PNGs and report PDFs. Pixel-identical
   matplotlib/WeasyPrint output is not the bar. Same spec, valid PNG, same
   ECharts option, PDF opens, no egress — that is the bar.
3. **LM Studio directly** — delete LiteLLM. Keep the current model aliases
   in Node. Default `LITELLM_BASE_URL` to `http://127.0.0.1:1234`.

## Current vs target

```
Today:  web → Fastify:3000 → HTTP+bearer → FastAPI:8000 (DuckDB, matplotlib, WeasyPrint)
                    ↘ LiteLLM:4000 → LM Studio:1234

Target: web → Fastify:3000 → datasets worker (DuckDB, ExcelJS)
                           → Playwright Chromium (PNG, PDF)
                           → LM Studio:1234
```

## Current state (commit `7d5576d`)

- `python/app/main.py` — FastAPI on :8000; bearer `BOREALIS_SERVICE_TOKEN`;
  `/health` public; connector SSRF + staged refresh; path ownership.
- `python/app/datasets.py` — in-memory DuckDB registry; scoped catalogs;
  SQL guard; XLSX→CSV via OpenPyXL; numeric JSON normalization.
- `python/app/charts.py` — canonical spec + ECharts option + matplotlib PNG.
- `python/app/reports.py` — HTML/CSP + WeasyPrint deny-by-default fetcher.
- `python/litellm.yaml` — aliases `qwen-chat`, `qwen-27b`, `nemotron`,
  `nomic-embed` → `http://127.0.0.1:1234/v1`.
- `server/src/pythonClient.ts` — `py.*` HTTP client; 65s default, 120s
  prepare/PDF; `PythonServiceError` never copies response bodies.
- `server/src/ingest.ts` / `routes/connectors.ts` / `tools.ts` / `agent.ts`
  / `routes/sources.ts` — all production `py.` call sites.
- `server/src/networkPolicy.ts` — agent `fetch_url` SSRF (1 MB / 15s).
  Connector download is a **separate** Python path (50 MiB / 60s).
- `server/src/storageArtifacts.ts` — UUID upload/report dirs and
  `url_cache/<sha256[:24]>/<table>/<32hex>.{csv,json}` cleanup proofs.
- `scripts/dev.sh` starts uvicorn :8000 and `uv run litellm` :4000.
- CI installs pango/glib + uv; Node tests mock `pythonClient`.

## Tree since this plan was written (`7d5576d` → `130481b`)

Do not treat these as optional. They landed after the first draft:

- `9521180` — public ingest failures (`server/src/ingestionFailures.ts`).
  `PythonServiceError` 422 → `DATASET_PARSE_FAILED`, 404 →
  `SOURCE_UNAVAILABLE`, 429/5xx → `DATA_SERVICE_UNAVAILABLE`. Sources UI
  shows `summary` / `detail` / `stage`. Keep these **codes and envelopes**.
  In-process DuckDB/XLSX must map the same statuses. After Python is gone,
  rewrite `DATA_SERVICE_UNAVAILABLE` copy (it still says “restore the
  local data-processing service”).
- `2f63da0` — authenticated `GET /api/health` (`systemHealth.ts`,
  `routes/system.ts`, Settings → System). Probes: `api`, `database`
  (Postgres `SELECT 1`), `data_service` (`py.health()` → :8000),
  `model_gateway` (`${LITELLM_BASE_URL}/health/liveliness`),
  `model_runtime` (`${LM_STUDIO_BASE_URL}/v1/models`). New env
  `LM_STUDIO_BASE_URL` (default `http://localhost:1234`). Docs in
  `docs/API.md`. **User-visible names still say “LiteLLM gateway”.**
- `dd003f4` / later — Settings is a **workspace modal**
  (`SettingsView.tsx`: System, Models, Appearance, Account), not a page
  to invent later.
- `130481b` — unify selection chrome (`border-l-2` → `bg-accent`).
  Cosmetic only. Settings sections, health cards, and ingest envelopes
  are unchanged. Tests still assert the user-visible name
  “LiteLLM gateway”.

Phase 1: `data_service` health becomes the DuckDB worker smoke test;
keep the service id. Phase 4: LiteLLM’s `/health/liveliness` goes away.
Retarget `model_gateway` at `config.llmBaseUrl` (OpenAI-compatible
`/v1/models` or `/health` if present). If `llmBaseUrl` and
`lmStudioBaseUrl` are the same origin after the default moves to :1234,
do **not** show two identical cards — keep `model_runtime` as the local
LM Studio probe only when the configured chat endpoint is a different
origin (cloud). Update `SystemHealthPanel` / API.md copy so “LiteLLM”
and “Python data service” are gone by Phase 5. Keep `LM_STUDIO_BASE_URL`.

Characterization tests that **are** the spec:

- `python/tests/test_datasets.py`
- `python/tests/test_charts.py`
- `python/tests/test_reports.py`
- `python/tests/test_main.py`

## What must be preserved (do not “simplify”)

Port as-is from `python/app/datasets.py`, `charts.py`, `reports.py`, `main.py`:

- Scoped DuckDB catalogs keyed `(account_id, sorted allowed_tables)`, max 8
  scopes/account LRU, file-signature reload (`st_size:st_mtime_ns`). Load
  trusted files, then `SET enable_external_access=false`. User SQL cannot
  turn it back on. Threads 4, memory 512MB, temp 512MB.
- Read-only SQL: exactly one statement; type SELECT; leading keyword
  `SELECT` / `WITH` / `VALUES` after comment-stripping; trailing semicolon
  stripped without eating quoted or dollar-quoted semicolons.
- Result bounds: query 30s / 500 rows / 100 cols / 50k cells / 1M chars;
  extract 2k rows / 500 cols; describe 100k profiled rows / 128k chars.
- Numeric JSON: finite Decimals as trimmed strings; `Inf`/`NaN` → `null`;
  ints beyond `Number.MAX_SAFE_INTEGER` as strings.
- XLSX: ZIP member/expand limits first; reject encrypted and `.xls`; first
  sheet only; row/col/cell/output caps; convert to temp CSV. **Never** add
  npm `xlsx` (SheetJS). **Never** auto-install DuckDB extensions.
- European `;` CSV sniff on the first 4KiB (`_is_european_semicolon_csv`).
- Staged URL refresh: prepare → extract → activate / abort. Version bound
  to URL+format via hard-linked `.meta`. CAS deactivate by exact location.
- Path ownership via `storageArtifacts.ts`: lexical parent + realpath + no
  symlink components before any read or delete.
- Connector SSRF: generalize `networkPolicy.ts` (same NAT64/6to4/private
  ranges, DNS pin, HTTPS→HTTP block). Binary download: 50 MiB, 60s, 3
  redirects, format sniff. Do not use `fetch()`.
- Chart spec (`charts.py` docstring): types, palette, `1e15` magnitude,
  pie total > 0. ECharts option must stay compatible with
  `web/src/lib/chartOption.ts` and stored `charts.echarts` rows.
- Report HTML: same CSP as `reports.py` / the Node report route; vendored
  ECharts only; neutralize non-http(s)/mailto/# links; strip markdown
  images; no CDN.
- PDF: deny-by-default. Playwright `page.route` aborts everything except
  `about:blank` and `data:image/png;base64,...`. Offline context. Never
  `page.goto` user URLs.

## Node-facing contracts that must not drift

If any of these change, ready sources, connector refresh, or agent tools
regress.

**`py` method I/O (keep names and fields through Phase 4):**

- `registerDataset` path: `{ location, kind: "path", originalName, sourceId }`.
  URL/reconciliation only: `{ location, kind: "url", url, originalName, expectedFormat }`.
  Response includes `previous_location` when the active file changed.
- `prepareDatasetRefresh` (120s): `{ version, location, previous_location, rows, columns, preview, preview_truncated, size_bytes }`.
  Node requires `prepared.version === refreshVersion` and a non-empty `location`.
- `extractPreparedDataset` / `extractDataset`: must return **`total_row_count`**.
  `datasetPreviewText` builds RAG text from `columns`, `rows`, `total_row_count`, `truncated`.
- `activateDatasetRefresh`: return `version` + `location` matching the
  candidate; **409** if the active row changed (CAS on `previous_location`).
- `abortDatasetRefresh` / `cleanupDatasetCache`: `{ status: "deleted" | "missing" }`.
- `deactivateDatasetLocation`: `{ status: "dropped" | "unchanged" }` — exact
  `safe_location` only. Never drop by `(account_id, name)` alone.
- `query` / `describe` / `catalog` / `extract`: `allowed_tables` required.
  Empty allowlist is a valid scope (`SELECT 1` works; no tables loaded).
- `chart`: `{ png_base64, echarts, spec }` with **normalized** spec. Invalid spec is 400.
- `buildReport`: `{ title, html }`. `pdf`: raw PDF `Buffer`. Failures stay opaque 422.

**Status codes ingest/connectors already branch on:**

- `PythonServiceError` **429 or ≥500** → retry (`isRetryableIngestError`,
  connector `PREPARE_TRANSIENT`). Other statuses → terminal
  `"Connector sync failed."` / `"Connector indexing failed."`
- Failure after a confirmed `activate` → `ConnectorRefreshActivatedError`
  and **always retry**.
- 409 on version-manifest mismatch, stale activate, or abort-while-preparing.
- 504 on DuckDB 30s deadline (close that scope) and connector 60s deadline.

**Refresh internals to port, not invent:**

- Pending refcounts for in-flight prepare/activate block abort/cleanup.
- Cache `{uploads}/url_cache/{sha256(account)[:24]}/{table}/{uuid_hex32}.{csv|json}`
  plus sibling `.meta` (SHA-256 of canonical `{"url","expected_format"}`)
  created with `fs.link`.
- Download: pin DNS, `Accept-Encoding: identity`,
  `User-Agent: Borealis-Connector/1`, 64 KiB chunks, hard-link temp → version
  path, re-inspect after promote.
- `POST /datasets/resync`, `POST /html-to-pdf`, and unversioned
  `DELETE /datasets/:name` stay gone.

**Locks:** global lock only for the connection map; per-account mutex for
registry CAS; never hold either during DuckDB I/O, XLSX convert, or network
download.

**Unchanged Node ownership:** agent tools, SSE summaries, pending→published
chart/report rows, `makeReportPayload` 12-char chart-id prefix, `fetch_url`
(1 MB / 15s), public `/api/reports` and `/api/charts`. The frontend never
called Python.

## Target module layout

Add under `server/src/data/`:

- `datasets.ts` + `datasetsWorker.ts` — registry, scoped catalogs,
  query/describe/extract/register/refresh
- `xlsx.ts` — ZIP preflight + ExcelJS streaming first-sheet → temp CSV
- `charts.ts` — `normalize`, `echartsOption` (new chart-spec home)
- `reports.ts` — `buildHtml({ static })`
- `playwrightRender.ts` — chart PNG (1330×728 = 9.5×5.2in @ 140dpi) and
  `page.pdf()` from **static** HTML
- `connectorFetch.ts` — binary public download on `networkPolicy`
- `errors.ts` — keep `PYTHON_SERVICE_ERROR` *code* during the facade phase
- `assets/echarts.min.js` — move from `python/app/assets/echarts.min.js`

Keep the `py` facade in `server/src/pythonClient.ts` until Phase 5 so
ingest/tools/connectors and existing vitest mocks do not churn twice.
`py.health()` becomes a worker `SELECT 1`. `restoreDatasets` no longer
polls port 8000; the in-memory registry is empty on boot and the existing
Postgres ledger restore still re-registers ready tables.

## New dependencies (and one hard ban)

Add to `server/package.json`:

- `@duckdb/node-api`
- `exceljs` (streaming; not SheetJS)
- `playwright` (Chromium only)
- `marked` or `markdown-it` (same link/image neutralization tests)

**Ban:** npm package `xlsx`. Add a `scripts/verify.sh` grep so it cannot return.

Do **not** add DuckDB HTTP/XLSX extensions or any auto-install.

## Implementation phases

Each phase is a reviewable change. Do not skip ahead.

### Phase 0 — Spike (no behavior change)

Confirm on Node 22.13 + `@duckdb/node-api`:

1. `extractStatements` exposes SELECT vs other types. If not, combine
   `count === 1` with the existing `_leading_sql_keyword` parser — do not
   weaken the guard.
2. `interrupt()` stops a sleeping query within the 30s test.
3. Load from CSV, then `SET enable_external_access=false`, and user
   `SET enable_external_access=true` fails.
4. A worker thread can open DuckDB and pass bounded row arrays over
   `postMessage` without losing bigint/decimal fidelity.

If any item fails, STOP. Do not write the registry on a guessed binding.

**Verify:** a checked-in spike test or a short note in the PR describing
each of the four results with the exact package version.

### Phase 1 — Datasets + connectors in-process behind `py`

- Implement `datasets`, `xlsx`, connector download/cache.
- Port `test_datasets.py` and the connector/path tests from `test_main.py`
  (drop FastAPI-only token/body-size tests).
- Point `py.registerDataset` / `query` / `describe` / refresh / catalog /
  cleanup at the worker. Keep method names, timeouts (65s default, 120s
  prepare), and `AbortSignal` behavior.
- Ingest/tools/connectors keep importing `py`.
- Keep `ingestionFailureCode` mapping from `PythonServiceError` statuses
  (or the in-process equivalent) onto the public codes in
  `ingestionFailures.ts`. `py.health()` / `GET /api/health` `data_service`
  becomes the worker `SELECT 1`.

**Verify:**

```bash
cd server && npm test
```

Ported dataset/connector tests must pass. Existing ingest/connector mocks
must still pass.

### Phase 2 — Charts + HTML reports

- Port `normalize` + `echartsOption` + HTML builder.
- Port chart/report unit tests that do not need a browser.
- Retarget the sync comment in `web/src/lib/chartOption.ts` to
  `server/src/data/charts.ts`.

**Verify:** `cd server && npm test` plus the new chart/HTML suites.

### Phase 3 — Playwright PNG + PDF

- Isolated Chromium: offline, route-deny except `data:image/png;base64,`
  and `about:blank`.
- `render_chart` stores Playwright PNG + ECharts option as today.
- `create_report` still writes `report.html` (interactive) and `report.pdf`
  (static HTML → `page.pdf`).
- Port PDF smoke (`%PDF`), no-network spy, and PNG magic-byte tests.
- CI installs Chromium; WeasyPrint system libs may remain until Phase 5
  only if Python is still in the verify matrix.

**Verify:** PNG/PDF tests are not skippable. `scripts/verify.sh` still green.

### Phase 4 — Delete LiteLLM

- Add `server/src/llmAliases.ts` from `python/litellm.yaml`.
- Rewrite `model` on chat/embed calls; discovery still lists aliases and
  hides the embedding model.
- Default `LITELLM_BASE_URL` to `http://127.0.0.1:1234`. Accept
  `LLM_BASE_URL` as an alias. Keep `encoding_format: "float"`.
- Keep `LM_STUDIO_BASE_URL` for the Settings runtime probe.
- Retarget `systemHealth.ts` `model_gateway` off LiteLLM
  `/health/liveliness`. Deduplicate gateway vs runtime when both URLs
  are loopback :1234.
- Remove LiteLLM from `scripts/dev.sh`. Update Settings / API.md strings
  that say “LiteLLM”.

**Verify:** `cd server && npm test` (llm + config). Manual: chat + embed
against a running LM Studio still work.

### Phase 5 — Delete Python

- Remove `python/`, uv pin, `PYTHON_SERVICE_*`, `BOREALIS_SERVICE_TOKEN`.
- Rewrite `data/generate_sample.py` → `data/generate_sample.ts` (`npx tsx`).
- Update `scripts/dev.sh`, `scripts/verify.sh`, `.github/workflows/ci.yml`,
  `server/.env.example`, `server/src/config.ts`, `README.md`, `AGENTS.md`,
  `docs/API.md`. Chart-spec comments move to `server/src/data/charts.ts`.
- Optionally rename `pythonClient.ts` → `dataService.ts` and
  `PYTHON_SERVICE_ERROR` → `DATA_SERVICE_ERROR` in this phase only.

**Verify:** the grep gate and full `scripts/verify.sh` (with
`TEST_DATABASE_URL` in CI).

## Files that will change (by phase)

Phase 0–3 (additive, Python still present): `server/package.json`,
`server/src/data/**`, `server/src/pythonClient.ts`,
`server/src/networkPolicy.ts`, `server/src/storageArtifacts.ts`,
`server/src/systemHealth.ts`, `server/src/ingestionFailures.ts`,
`server/src/tests/**`, `web/src/lib/chartOption.ts` (comment only).

Phase 4: `server/src/llm.ts`, `server/src/llmAliases.ts`,
`server/src/config.ts`, `server/src/systemHealth.ts`,
`web/src/components/SystemHealthPanel.tsx`, `web/src/pages/SettingsView.tsx`
(copy only), `scripts/dev.sh`, `docs/API.md`.

Phase 5: delete `python/`; `scripts/verify.sh`; `.github/workflows/ci.yml`;
`server/.env.example`; `data/generate_sample.ts`; `README.md`; `AGENTS.md`;
`docs/API.md`; `ingestionFailures.ts` copy; this index.

Do not change agent tool names, SSE event shapes, or public `/api/*` routes
except env/docs that mention Python/LiteLLM.

## Done criteria

- [x] Phase 0 spike recorded; DuckDB statement guard, interrupt, and
  `enable_external_access` sequence match Python tests.
- [x] Ported `test_datasets.py` / connector-path / SSRF / CAS tests pass in
  vitest.
- [x] `py.*` field names and 429/5xx retry behavior are unchanged through
  Phase 4.
- [x] Chart normalize + ECharts option tests pass; web fallback comment
  points at `server/src/data/charts.ts`.
- [x] Playwright PNG is a valid PNG; PDF starts with `%PDF`; route spy
  proves no network/file fetch; tests are not skipped.
- [x] LiteLLM process is gone; LM Studio aliases still work; embeddings
  still send `encoding_format: "float"`.
- [x] `python/` is deleted. `rg -n "uvicorn|weasyprint|openpyxl|litellm|PYTHON_SERVICE_|BOREALIS_SERVICE_TOKEN|from openpyxl|uv run|LiteLLM gateway|Python data service" --glob '!plans/**' --glob '!docs/cohere-north/**'`
  returns no runtime/docs hits outside historical plan text.
- [x] `GET /api/health` still returns the same service **ids**; copy no
  longer names Python or LiteLLM. Public ingest failure **codes** are
  unchanged.
- [x] `rg -n '"xlsx"' server/package.json server/package-lock.json` returns
  no SheetJS dependency.
- [x] At the Plan 029 boundary, `scripts/dev.sh` started only Postgres + server
  + web (plus requiring LM Studio externally); Plan 030 subsequently removed
  Postgres from this path.
- [x] `scripts/verify.sh` and CI have no uv/Python/pango steps; CI installs
  Chromium.
- [x] At the Plan 029 boundary, `scripts/verify.sh` was green and CI included
  the pgvector suite; Plan 030 subsequently replaced that suite.
- [x] `plans/README.md` status row updated.

These criteria record the Plan 029 boundary. Plan 030 subsequently replaced
Postgres/pgvector and its guarded test path with SQLite + LanceDB.

### Completion record (2026-08-26)

The final Node-only tree passed the complete server, web, integration, build,
lint, format, and Playwright renderer matrix before Plan 030 began. Python,
FastAPI, WeasyPrint, uv, LiteLLM, service-token wiring, and ports 8000/4000 were
removed. DuckDB, bounded XLSX parsing, charts, self-contained HTML, PNG/PDF
rendering, direct model calls, aliases, health IDs, and public error contracts
moved in-process without changing the public agent tool or SSE surface.

## STOP conditions

Stop and report (do not improvise) if:

- Phase 0 cannot prove SELECT-only extraction, `interrupt()`, or
  load-then-`enable_external_access=false` on `@duckdb/node-api`.
- A worker thread cannot pass bigint/decimal cells without precision loss.
- DuckDB would require HTTP/XLSX extension auto-install to load a supported
  file.
- The only XLSX library that works is npm `xlsx` (SheetJS).
- Playwright cannot be locked to deny-by-default resource loading (any
  `page.goto` of user content, or a route that allows `file:` / `http:`).
- `allowed_tables` would be enforced only in the prompt or UI.
- Deactivate/cleanup would key on table name without an exact location.
- URL register would fetch the network (that path is reconciliation-only).
- Empty `allowed_tables` would be widened to all account tables.
- Chart spec validation or ECharts option shape would diverge from
  `charts.py` / `web/src/lib/chartOption.ts`.
- Existing public API, SSE summaries, or pending→published artifact
  lifecycle would need to change to make the port work.
- Product policy changes to keep a Python sidecar after all; that is a
  different plan.

## Maintenance notes

- After Phase 5, the chart-spec contract lives in `server/src/data/charts.ts`.
  Keep `web/src/lib/chartOption.ts` as a fallback for legacy rows missing
  `echarts`.
- At the Plan 029 boundary, the in-memory DuckDB registry reloaded from the
  Postgres ledger through `restoreDatasets`. Plan 030 superseded that boundary:
  SQLite is now authoritative, LanceDB boot repair reconciles vectors, and
  `restoreDatasets` reloads ready tabular sources from SQLite.
- New data-access tools must call the datasets worker with the immutable
  turn `allowed_tables`, not a freshly loaded account catalog.
- Vendored `server/src/data/assets/echarts.min.js` must stay in lockstep
  with the web `echarts` major (same note as the old Python asset).
- Historical plans 008–028 that mention Python/WeasyPrint/LiteLLM are
  left as-is; they describe the tree they were executed against.

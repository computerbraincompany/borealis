# Borealis — open-source agentic data workspace

Agentic chat over uploaded documents and tabular data, plus HTML/PDF report generation,
backed by a local LiteLLM proxy that talks to LM Studio (any OpenAI-compatible API).

Repo: `computerbraincompany/borealis` on GitHub (formerly *north-clone*).

## Architecture

- `server/` — Node.js (TypeScript, ESM) Fastify API on port 3000. Agent loop,
  durable ingestion jobs, RAG chunking, embeddings, cancellable chat SSE runs,
  report file storage. Resource routes live under `server/src/routes/`.
- `python/` — FastAPI "report service" (uv-managed, port 8000): DuckDB query layer,
  chart rendering (matplotlib PNG / ECharts option), HTML + PDF report building
  (WeasyPrint), and the LiteLLM proxy (port 4000) used by the agent.
- `web/` — Vite + React + TS + Tailwind + shadcn-style UI, port 5173 (dev proxy
  `/api` → 3000). Pages: auth, chat (SSE streaming, tool feed, ECharts charts,
  report link), sources, URL connectors, reports (preview + PDF download).
  Build with `npm run build` (tsc -b + vite), run with `npm run dev`.
- `docker-compose.yml` — Postgres with pgvector (required). Zitadel/Redpanda are
  intentional non-goals for the MVP.
- `data/` — `generate_sample.py` + `data/sample/*.csv` (personal finance sample
  data used to verify the end-to-end use case).
- `uploads/` and `reports_storage/` — runtime dirs for ingest files and reports.

## Commands

```bash
docker compose up -d postgres                  # database (only service required)
cd python
uv sync --locked                               # first time; installs deps (fastapi pinned, see gotchas)
export BOREALIS_SERVICE_TOKEN='<same random value as server PYTHON_SERVICE_TOKEN>'
env DYLD_FALLBACK_LIBRARY_PATH="$(brew --prefix)/lib${DYLD_FALLBACK_LIBRARY_PATH:+:$DYLD_FALLBACK_LIBRARY_PATH}" .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000
                                               # report service (8000); DYLD is required on macOS; use separate terminals
export LITELLM_MASTER_KEY='<same random value as server LITELLM_API_KEY>'
export LM_STUDIO_API_KEY='<random local upstream value>'
uv run litellm --config litellm.yaml --host 127.0.0.1 --port 4000
                                               # LLM proxy (4000); must run from uv env
cd ../server
npm ci && cp .env.example .env                 # set all three required random credentials
npm run dev                                    # server (3000); reconciles durable jobs and datasets
npm run typecheck                              # tsc --noEmit
npm run build                                  # tsc
cd ../web
npm ci && npm run dev                          # frontend (5173)
npm run build                                  # frontend typecheck + production build
```

Run the full local typecheck, lint, format, unit-test, and build matrix with
`scripts/verify.sh`. Set `TEST_DATABASE_URL` to an explicitly disposable database
whose name ends in `_test` to include the PostgreSQL isolation/concurrency suite.
CI always includes that suite. Dev orchestration: `scripts/dev.sh` (validates
Node 22.13+/Python 3.12/uv 0.11.26, syncs every lockfile, brings up postgres, waits for
Python, then starts the remaining services).

## Data flow

1. Uploaded files land in UUID-scoped `uploads/<account-id>/<source-id>/`
   directories. A `sources` row and durable `ingestion_jobs` entry are created;
   workers extract within configured budgets, stage embeddings incrementally,
   then atomically replace live `chunks` (pgvector, HNSW index). Tabular preview
   extraction is delegated to Python instead of loading workbooks into Node.
2. Chat at `POST /api/chats/:id/messages` accepts the model, source mode,
   concrete ready source IDs, user message, and one durable `chat_runs` row in a
   repeatable-read transaction, then streams sanitized SSE events from
   `server/src/agent.ts` (max 8 iterations). One active run is allowed per chat;
   `DELETE /api/chats/:id/runs/:runId` requests cancellation.
3. Agent tools (`server/src/tools.ts`): `retrieve`, `list_sources`, `query_data`,
   `describe_data`, `render_chart`, `create_report`, `fetch_url`. Every stored-data
   tool consumes that immutable source snapshot; `fetch_url` is the separate web
   capability and does not use stored-source scope. It may fetch only a public
   HTTP(S) URL written explicitly in the current user turn, with redirects and
   response size bounded.
4. Reports: agent assembles markdown sections + chart ids; Python builds a
   self-contained HTML (ECharts inlined) and a PDF (matplotlib PNGs + WeasyPrint);
   both are written to `reports_storage/` by the server.

## Conventions & gotchas

- Server is ESM (`"type": "module"`): always import local modules with the `.js`
  extension (e.g. `./config.js`) and use `import`, not `require`.
- Auth: JWT over bcrypt in `server/src/auth.ts`. Registration and login are the
  explicit public `/api/*` exceptions; resource routes use `requireAuth`. The
  FastAPI service separately requires `Authorization: Bearer` with
  `BOREALIS_SERVICE_TOKEN` on every route except `/health`; Node supplies the same
  value from `PYTHON_SERVICE_TOKEN`. Both services propagate a sanitized
  `X-Request-ID` and must never log tokens, prompts, SQL results, signed URLs, or
  uploaded content.
- Credentialed browser CORS uses the exact `CORS_ORIGINS` allowlist (the two
  loopback Vite origins by default); never restore arbitrary origin reflection.
- Chart canonical spec is defined in `python/app/charts.py` docstring and mirrored
  in `tools.ts` — a single spec drives ECharts (UI/HTML) and matplotlib (PDF).
- Python keeps an in-memory DuckDB registry, while Postgres is the durable source
  and ingestion ledger. Node retries/reconciles ready tables after service loss and
  safely resumes interrupted ingestion leases. Files already registered are
  signature-checked and reload into a scoped catalog on the next query or describe
  call after they change.
- XLSX ingestion is deliberately offline and bounded through OpenPyXL's read-only
  mode plus ZIP/row/cell/output limits. Legacy `.xls` and `.doc` inputs are not
  supported. Do not reintroduce DuckDB extension auto-install or Node SheetJS.
- Chat source state has three load-bearing meanings: `all` dynamically includes
  current/future account sources; `selected` plus rows is a stable allowlist;
  `selected` plus zero rows means none and must never widen to all. New web chats
  start selected-empty; legacy API omission remains all. Only ready attachments
  enter a turn's concrete source/table arrays.
- Python `/query`, `/describe`, and `/datasets/extract` require the server-derived
  `allowed_tables` list. Scoped DuckDB catalogs are keyed by account and sorted
  allowlist, capped at eight per account, protected by per-account locks, and
  disable external access after trusted files load.
  New data-access tools must enforce the same immutable scope at their lowest
  boundary rather than relying on UI filtering or prompt text.
- `python/pyproject.toml` pins `fastapi>=0.140.6,<0.140.7`: fastapi 0.140.7 removed
  `get_flat_dependant`, which litellm 1.97.0's proxy still imports. Don't bump fastapi.
- openai-node (>=4.104) defaults `encoding_format` to `base64` and blindly decodes
  the response — with litellm/LM Studio returning plain floats this corrupts vectors
  (768 floats → 192). `server/src/llm.ts` sends `encoding_format: "float"` explicitly.
- Agent tools are wired via `TOOL_DEFS` in the single streaming loop (`agent.ts`).
  Never expose provider reasoning fields, raw tool arguments/results, or exception
  text in SSE events; UI activity receives only the stable summaries defined by
  the server.
  The model sometimes garbles long chart uuids — `makeReportPayload` falls back to a
  12-char prefix match, and Python's `reports.py` strips inline `chart:`/`:::` tokens.
- Embedding dimension is set at DB init time (schema uses `vector(${dim})`); changing
  `EMBEDDING_DIM` or the embed model after tables exist breaks queries.
- OpenAI-compatible everywhere: `server/src/llm.ts` points at
  `${LITELLM_BASE_URL}/v1`; the LiteLLM proxy in turn points at LM Studio
  `http://localhost:1234/v1`. Model names are the LiteLLM aliases (`qwen-chat`,
  `nomic-embed`). `LITELLM_API_KEY`/`LITELLM_MASTER_KEY` is required and must not
  be a committed placeholder; the proxy and application services bind to loopback
  by default.
- Storage paths are derived relative to the repo root in `server/src/config.ts`
  (`uploads/`, `reports_storage/`) and `python/app/main.py` + `datasets.py`
  (`BOREALIS_STORAGE_DIR`, with legacy `NORTH_STORAGE_DIR` fallback; default
  `<repo>/uploads`). Override via env vars.
  `.env` is gitignored; `server/.env.example` documents every variable.
- Upload, message, history, extracted-text, and chunk-count budgets are configured
  in `server/.env.example`. Connector, query/extract, chart, report, outbound-web,
  and tool-duration limits are fixed at their lowest processing boundary and
  summarized in `docs/API.md`; keep tests for over-limit and partial/truncated
  input whenever changing them.

## Before touching sensitive areas

- Read `python/app/charts.py` docstring before changing the chart spec — it is the
  contract between the LLM, Node tools, ECharts and matplotlib.
- Read `server/src/agent.ts` + `tools.ts` before changing agent behavior.
- Schema lives in `server/src/db.ts` SCHEMA (idempotent, created at startup).
- File deletion and reads must prove a path belongs to the exact UUID-scoped
  account/resource directory before touching it. Never derive a recursive deletion
  target from an unvalidated database path or filename.

## E2E verification

Goal use case: `data/generate_sample.py` → upload CSVs → chat asks for a personal
finance analysis → agent queries DuckDB, renders charts, creates a report → open
HTML/PDF from `reports_storage/` or the `/api/reports/:id` endpoints, or from the
web UI (Reports page / chat report link). Verified end-to-end on 2026-08-22 with
`data/sample/*.csv` (4 tables, 697 transactions) producing two charts and an HTML+PDF
report (`has_html`/`has_pdf` true, PDF downloads as a valid v1.7 document).
PDF depends on WeasyPrint system libs: on macOS run uvicorn with
`DYLD_FALLBACK_LIBRARY_PATH="$(brew --prefix)/lib${DYLD_FALLBACK_LIBRARY_PATH:+:$DYLD_FALLBACK_LIBRARY_PATH}"`
after `brew install pango glib`.

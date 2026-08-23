# Borealis — open-source agentic data workspace

Agentic chat over uploaded documents and tabular data, plus HTML/PDF report generation,
backed by a local LiteLLM proxy that talks to LM Studio (any OpenAI-compatible API).

Repo: `computerbraincompany/borealis` on GitHub (formerly *north-clone*).

## Architecture

- `server/` — Node.js (TypeScript, ESM) Fastify API on port 3000. Agent loop,
  uploads, RAG chunking, embeddings, chat SSE stream, report file storage.
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
cd python && uv sync                           # first time; installs deps (fastapi pinned, see gotchas)
cd python && env DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib .venv/bin/uvicorn app.main:app --port 8000
                                               # report service (8000); on macOS the DYLD var is REQUIRED so WeasyPrint finds glib/pango
cd python && uv run litellm --config litellm.yaml --port 4000   # LLM proxy (4000); must run from uv env (Docker route commented out)
cd server && npm install && cp .env.example .env   # then set JWT_SECRET using: openssl rand -base64 32
cd server && npm run dev                       # server (3000); on boot it re-registers tabular sources with the python service
cd server && npm run typecheck                 # tsc --noEmit
cd server && npm run build                     # tsc
cd web && npm install && npm run dev           # frontend (5173)
cd web && npm run build                        # frontend typecheck + production build
```

Test/typecheck gates (all offline, no services needed):
`cd server && npm test`, `cd python && uv run pytest`, `cd web && npm run typecheck`
— or run everything via `scripts/verify.sh`. Dev orchestration: `scripts/dev.sh`
(brings up postgres, python service, litellm proxy, server, web).

## Data flow

1. Uploaded files land in `uploads/<account-id-prefix>/`, get a `sources` row, then
   `ingestSource` runs async: tabular files register with the Python service (which
   makes them DuckDB tables), all files are chunked and embedded into Postgres
   `chunks` (pgvector, HNSW index).
2. Chat at `POST /api/chats/:id/messages` accepts the model, source mode,
   concrete ready source IDs, and user message in one repeatable-read transaction,
   then streams SSE agent events from `server/src/agent.ts` (max 8 iterations).
3. Agent tools (`server/src/tools.ts`): `retrieve`, `list_sources`, `query_data`,
   `describe_data`, `render_chart`, `create_report`, `fetch_url`. Every stored-data
   tool consumes that immutable source snapshot; `fetch_url` is the separate web
   capability and does not use stored-source scope.
4. Reports: agent assembles markdown sections + chart ids; Python builds a
   self-contained HTML (ECharts inlined) and a PDF (matplotlib PNGs + WeasyPrint);
   both are written to `reports_storage/` by the server.

## Conventions & gotchas

- Server is ESM (`"type": "module"`): always import local modules with the `.js`
  extension (e.g. `./config.js`) and use `import`, not `require`.
- Auth: JWT over bcrypt in `server/src/auth.ts`; every `/api/*` route uses
  `requireAuth` preHandler. A throw `{ message: "unauthorized" }` is converted to a 401
  by the `onError` hook in `routes.ts`.
- Chart canonical spec is defined in `python/app/charts.py` docstring and mirrored
  in `tools.ts` — a single spec drives ECharts (UI/HTML) and matplotlib (PDF).
- Python service keeps an in-memory DuckDB dataset registry. Durable re-registration
  now happens on **server boot**: `restoreDatasets()` in `ingest.ts` re-registers every
  `ready` tabular source from the DB. So after restarting the python service, restart
  the server (or re-upload) to repopulate the registry. Manual CSVs still need a
  register via the API (or a server restart) because new files are not auto-discovered.
  Files that are already registered are signature-checked and reload into a scoped
  catalog on the next query or describe call after they change.
- Chat source state has three load-bearing meanings: `all` dynamically includes
  current/future account sources; `selected` plus rows is a stable allowlist;
  `selected` plus zero rows means none and must never widen to all. New web chats
  start selected-empty; legacy API omission remains all. Only ready attachments
  enter a turn's concrete source/table arrays.
- Python `/query` and `/describe` require the server-derived `allowed_tables`
  list. Scoped DuckDB catalogs are keyed by account and sorted allowlist, capped
  at eight per account, and disable external access after trusted files load.
  New data-access tools must enforce the same immutable scope at their lowest
  boundary rather than relying on UI filtering or prompt text.
- `python/pyproject.toml` pins `fastapi>=0.140.6,<0.140.7`: fastapi 0.140.7 removed
  `get_flat_dependant`, which litellm 1.97.0's proxy still imports. Don't bump fastapi.
- openai-node (>=4.104) defaults `encoding_format` to `base64` and blindly decodes
  the response — with litellm/LM Studio returning plain floats this corrupts vectors
  (768 floats → 192). `server/src/llm.ts` sends `encoding_format: "float"` explicitly.
- Agent tools are wired via `TOOL_DEFS` in `chatOnce`/`streamingChat` (`agent.ts`).
  The model sometimes garbles long chart uuids — `makeReportPayload` falls back to a
  12-char prefix match, and Python's `reports.py` strips inline `chart:`/`:::` tokens.
- Embedding dimension is set at DB init time (schema uses `vector(${dim})`); changing
  `EMBEDDING_DIM` or the embed model after tables exist breaks queries.
- OpenAI-compatible everywhere: `server/src/llm.ts` points at
  `${LITELLM_BASE_URL}/v1`; the LiteLLM proxy in turn points at LM Studio
  `http://localhost:1234/v1`. Model names are the LiteLLM aliases (`qwen-chat`,
  `nomic-embed`).
- Storage paths are derived relative to the repo root in `server/src/config.ts`
  (`uploads/`, `reports_storage/`) and `python/app/main.py` + `datasets.py`
  (`BOREALIS_STORAGE_DIR`, with legacy `NORTH_STORAGE_DIR` fallback; default
  `<repo>/uploads`). Override via env vars.
  `.env` is gitignored; `server/.env.example` documents every variable.
- Body limit is 20MB (server) / 150MB (uploads route).

## Before touching sensitive areas

- Read `python/app/charts.py` docstring before changing the chart spec — it is the
  contract between the LLM, Node tools, ECharts and matplotlib.
- Read `server/src/agent.ts` + `tools.ts` before changing agent behavior.
- Schema lives in `server/src/db.ts` SCHEMA (idempotent, created at startup).

## E2E verification

Goal use case: `data/generate_sample.py` → upload CSVs → chat asks for a personal
finance analysis → agent queries DuckDB, renders charts, creates a report → open
HTML/PDF from `reports_storage/` or the `/api/reports/:id` endpoints, or from the
web UI (Reports page / chat report link). Verified end-to-end on 2026-08-22 with
`data/sample/*.csv` (4 tables, 697 transactions) producing two charts and an HTML+PDF
report (`has_html`/`has_pdf` true, PDF downloads as a valid v1.7 document).
PDF depends on WeasyPrint system libs: on macOS run uvicorn with
`DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib` (`brew install pango glib`).

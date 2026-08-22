# Borealis — Cohere North open-source MVP clone

Agentic chat over uploaded documents and tabular data, plus HTML/PDF report generation,
backed by a local LiteLLM proxy that talks to LM Studio (any OpenAI-compatible API).

Repo: `computerbraincompany/borealis` on GitHub (formerly *north-clone*).

## Architecture

- `server/` — Node.js (TypeScript, ESM) Fastify API on port 3000. Agent loop,
  uploads, RAG chunking, embeddings, chat SSE stream, report file storage.
- `python/` — FastAPI "report service" (uv-managed, port 8000): DuckDB query layer,
  chart rendering (matplotlib PNG / ECharts option), HTML + PDF report building
  (WeasyPrint), and the LiteLLM proxy (port 4000) used by the agent.
- `web/` — frontend. **Not built yet**: `web/src/` is empty, no package.json.
  Target stack is Vite + React + Tailwind + shadcn; do not assume any frontend exists.
- `docker-compose.yml` — Postgres with pgvector (required). Zitadel/Redpanda are
  intentional non-goals for the MVP.
- `data/` — `generate_sample.py` + `data/sample/*.csv` (personal finance sample
  data used to verify the end-to-end use case).
- `uploads/` and `reports_storage/` — runtime dirs for ingest files and reports.

## Commands

```bash
docker compose up -d postgres                  # database (only service required)
cd python && uv run uvicorn app.main:app --port 8000   # report service (8000)
cd python && uv run litellm --config litellm.yaml --port 4000   # LLM proxy (4000); has to run from uv env, Docker route is commented out in compose
cd server && npm install && cp .env.example .env   # server setup
cd server && npm run dev                       # server (3000)
cd server && npm run typecheck                 # tsc --noEmit
cd server && npm run build                     # tsc
```

There are no tests yet. The docker-compose comment references `scripts/dev.sh`
but that script does not exist.

## Data flow

1. Uploaded files land in `uploads/<account-id-prefix>/`, get a `sources` row, then
   `ingestSource` runs async: tabular files register with the Python service (which
   makes them DuckDB tables), all files are chunked and embedded into Postgres
   `chunks` (pgvector, HNSW index).
2. Chat at `POST /api/chats/:id/messages` streams SSE agent events from
   `server/src/agent.ts` (tool loop, max 8 iterations).
3. Agent tools (`server/src/tools.ts`): `retrieve`, `list_sources`, `query_data`,
   `describe_data`, `render_chart`, `create_report`, `fetch_url`.
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
- Python service keeps an in-memory DuckDB dataset registry; datasets are re-loaded
  from the files on disk at each boot. If you add CSVs manually, restart the python
  service or register via the API — don't expect file drops to hot-reload.
- Embedding dimension is set at DB init time (schema uses `vector(${dim})`); changing
  `EMBEDDING_DIM` or the embed model after tables exist breaks queries.
- OpenAI-compatible everywhere: `server/src/llm.ts` points at
  `${LITELLM_BASE_URL}/v1`; the LiteLLM proxy in turn points at LM Studio
  `http://localhost:1234/v1`. Model names are the LiteLLM aliases (`qwen-chat`,
  `nomic-embed`).
- Paths are hardcoded to this workspace in `server/src/config.ts` and
  `python/app/main.py` + `datasets.py` (STORAGE_DIR). `.env` is gitignored;
  `server/.env.example` documents every variable.
- Body limit is 20MB (server) / 150MB (uploads route).

## Before touching sensitive areas

- Read `python/app/charts.py` docstring before changing the chart spec — it is the
  contract between the LLM, Node tools, ECharts and matplotlib.
- Read `server/src/agent.ts` + `tools.ts` before changing agent behavior.
- Schema lives in `server/src/db.ts` SCHEMA (idempotent, created at startup).

## E2E verification

Goal use case: `data/generate_sample.py` → upload CSVs → chat asks for a personal
finance analysis → agent queries DuckDB, renders charts, creates a report → open
HTML/PDF from `reports_storage/` or the `/api/reports/:id` endpoints. Also verify
PDF downloads (WeasyPrint needs system libs; if PDF fails, check WeasyPrint deps).

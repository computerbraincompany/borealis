# Borealis ⚡

*Borealis — after the Aurora Borealis, the northern lights. A free and open-source
agentic workspace: chat with your uploaded documents and connected data
sources, then turn the answers into polished HTML and PDF reports.*

**Borealis** is an agentic "ask your data" platform. Point it at tabular files
(CSV, XLSX, parquet…), documents (PDF, DOCX, TXT) or URL connectors, then chat:
the agent writes SQL, makes charts, and can assemble a full report (HTML + PDF) —
e.g. ingest personal-finance CSVs and ask for a financial analysis with charts.

The default stack runs locally through LiteLLM and LM Studio. Borealis can also
target a remote OpenAI-compatible provider; in that configuration, prompts and
the selected context are sent to that provider according to its data policy.

## Architecture

```
web/        React + Vite + Tailwind + shadcn UI · port 5173
            auth, chat (SSE streaming), sources, URL connectors, reports
server/     Node.js (TypeScript, ESM) Fastify API · port 3000
            agent loop, uploads, RAG chunks (pgvector), chat SSE, reports
python/     FastAPI report service (uv) · port 8000
            DuckDB query layer, charts (matplotlib PNG + ECharts), HTML/PDF reports
docker-compose.yml
            PostgreSQL + pgvector; LiteLLM (port 4000) runs from python/
            and proxies LM Studio (port 1234) or any OpenAI-compatible API
```

```
                 ┌────────────┐   SSE    ┌────────────────────┐   HTTP   ┌──────────────────────┐
  Browser ──────▶│  server/   │─────────▶│   agent.ts agent   │────────▶│ python/ (DuckDB +    │
  (chat, charts) │  Fastify   │  upload  │ (tool loop, ≤8 it) │  tools  │  matplotlib + reports)│
                 └────────────┘          └────────────────────┘         └──────────────────────┘
                       │ LLM calls (OpenAI-compatible /v1)                     │
                       ▼                                                        │
                 ┌────────────┐                                       HTML + PDF artifacts
                 │ Litellm    │◀── LM Studio / any OpenAI API         (reports_storage/)
                 │ proxy :4000│
                 └────────────┘
```

## Getting started

Prerequisites: Node 22.13 or newer 22.x, Python 3.12, [uv 0.11.26](https://docs.astral.sh/uv/), Docker, and a running
OpenAI-compatible endpoint for the LLM (LM Studio on `http://localhost:1234/v1`
works out of the box — see `python/litellm.yaml`).

Two models must be loaded in LM Studio with ids matching `python/litellm.yaml`:
a CHAT model (default alias `qwen-chat` → `openai/qwen/qwen3.6-35b-a3b`) and an
EMBEDDING model (default alias `nomic-embed` → `text-embedding-nomic-embed-text-v1.5`,
768 dims). Using different models? Edit the aliases in `litellm.yaml` and set
`LITELLM_*` env vars accordingly — if you change the embedding model you MUST
also change `EMBEDDING_DIM` BEFORE first ingest (the vector column size is fixed
at schema creation).

Borealis discovers model choices through the configured OpenAI-compatible
endpoint's standard [`GET /v1/models`](https://developers.openai.com/api/reference/typescript/resources/models/methods/list)
catalog. The model selected in the composer is durable per chat and is
snapshotted when each turn begins, so changing it never changes an in-flight or
historical answer. The configured embedding model is intentionally excluded
from this picker: `LITELLM_CHAT_MODEL` and `LITELLM_EMBED_MODEL` must be distinct,
and each ID must contain 1–256 characters.

The standard model catalog advertises identities, not chat or tool-use
capabilities. A listed model can therefore still be unsuitable for the agent
loop. Borealis returns a correlated, non-sensitive generation failure in that
case and keeps the saved selection; it never silently retries the turn with the
process default.

Each chat also has a durable stored-source scope. `All sources` dynamically
includes every current and future source in the account; an explicit selection
includes only those sources; `No sources` is a deliberate empty selection and
never falls back to all. New chats created in the web app start with no sources,
while existing chats and API callers that omit scope retain the legacy all-source
behavior. Processing or failed sources stay visibly attached but cannot enter a
turn until they are ready.

At message acceptance, Borealis snapshots the chat model, source mode, and
concrete ready source IDs in one repeatable-read transaction. That immutable
snapshot filters the model prompt, pgvector retrieval, source listing, DuckDB
query/describe catalogs, and report chart provenance for the entire turn.
Changing a model or source selection affects the next answer only; earlier chat
text and artifacts are not retroactively erased. The `fetch_url` tool is a
separate web capability and is intentionally independent of stored-source scope.

> Recommended: configure `server/.env`, then run `./scripts/dev.sh`. It verifies
> runtime versions and secrets, synchronizes locked dependencies, starts services
> on loopback, waits for Python readiness, and supervises the stack. The manual
> sequence below explains each piece.

```bash
# 1. database
docker compose up -d postgres

# 2. Configure the Node server. Generate separate random values for JWT_SECRET,
# PYTHON_SERVICE_TOKEN, and LITELLM_API_KEY; do not reuse them elsewhere.
cd server
npm ci
cp .env.example .env
openssl rand -base64 32  # paste into JWT_SECRET
openssl rand -base64 32  # paste into PYTHON_SERVICE_TOKEN
openssl rand -base64 32  # paste into LITELLM_API_KEY
# CORS_ORIGINS defaults to the two loopback Vite origins. Add an exact HTTP(S)
# origin only when serving the web app somewhere else.

# 3. Python report service + loopback-only LiteLLM proxy (share the uv env)
cd ../python
uv sync --locked

# Export the same service credential configured in server/.env without logging it.
export BOREALIS_SERVICE_TOKEN="$(sed -n 's/^PYTHON_SERVICE_TOKEN=//p' ../server/.env)"
export LITELLM_MASTER_KEY="$(sed -n 's/^LITELLM_API_KEY=//p' ../server/.env)"
export LM_STUDIO_API_KEY="$(openssl rand -hex 32)"  # LM Studio accepts an ephemeral local key
export BOREALIS_STORAGE_DIR="$(cd .. && pwd)/uploads"
# If UPLOAD_DIR is customized, use the same absolute path for both variables.
uv run litellm --config litellm.yaml --host 127.0.0.1 --port 4000 &

# macOS: preserve any existing fallback and derive the active Homebrew prefix.
# Install the libraries first with: brew install pango glib
env DYLD_FALLBACK_LIBRARY_PATH="$(brew --prefix)/lib${DYLD_FALLBACK_LIBRARY_PATH:+:$DYLD_FALLBACK_LIBRARY_PATH}" \
  .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000 &

# 4. Node server
cd ../server
npm run dev                                            # http://localhost:3000

# 5. Frontend
cd ../web
npm ci
npm run dev                                            # http://localhost:5173
```

On Linux install the system libraries instead (e.g. Debian/Ubuntu:
`sudo apt install libpango-1.0-0 libpangoft2-1.0-0 libglib2.0-0`); no
DYLD variable is needed. See WeasyPrint's dependency docs.

> The LiteLLM **proxy must run from the uv environment**, not Docker (the compose
> entry is commented out by design). If you don't need a proxy, point
> `LITELLM_BASE_URL` at any OpenAI-compatible API directly.
>
> The Python service authenticates every non-health request with the shared
> service credential. Node durably reconciles queued ingestion and ready tabular
> sources after restarts; failed reconciliation is reported rather than silently
> declaring a source restored.

## Verify end to end

```bash
python data/generate_sample.py            # creates data/sample/*.csv
curl http://localhost:3000/health         # expect {"status":"ok",...}
```

Then in the UI (or via the [authenticated API](docs/API.md)): upload
`data/sample/*.csv`, ask something like
*"Analyze my spending and produce a financial report with charts"*, open the chat,
then fetch the generated report:

- HTML: `GET /api/reports/:id/html` · PDF: `GET /api/reports/:id/pdf`

Stored-data tools are account- and source-scoped, and Borealis preserves their
query/evidence artifacts with the answer. Model prose remains generative: inspect
the attached evidence and query tables before relying on important figures.

## Features

- **Agentic chat**: tool loop (retrieve / list_sources / query_data / describe_data /
  render_chart / create_report / fetch_url), SSE streaming, cancellable per-chat
  runs, safe execution summaries, and per-account data. Web fetches are restricted
  to explicit user-supplied public HTTP(S) URLs.
- **Per-chat models**: discover IDs from the configured endpoint, persist the
  selected model per conversation, and retain model attribution on each answer.
- **Per-chat sources**: choose all, a stable subset, or deliberately none; one
  immutable turn snapshot is enforced in prompts, RAG, SQL, describe, and reports.
- **Tabular SQL**: DuckDB-backed; upload CSV/XLSX/parquet/JSON/JSONL or connect a
  `url_csv` / `url_json` connector with one-click resync.
- **RAG over documents**: PDF, DOCX, TXT, plus natural text extracted from
  spreadsheets, chunked + embedded (pgvector, HNSW) for retrieval.
- **Charts**: one canonical spec renders interactively (ECharts) in chat/HTML and
  statically (matplotlib) in the PDF.
- **Reports**: agent-written markdown sections + live data tables + charts → a
  self-contained interactive HTML and a print-ready PDF.
- **Auth**: JWT + bcrypt, per-account data isolation, pgvector embeddings per user.

## Project layout & conventions

See [AGENTS.md](AGENTS.md) for the full agent-facing guide and [docs/API.md](docs/API.md)
for the REST/SSE contract. Highlights:

- `server/` uses **ESM** — import local modules with `.js` extension.
- The **chart spec** in `python/app/charts.py` is the contract between LLM, Node,
  ECharts and matplotlib — read it before changing.
- Datasets live in an **in-memory DuckDB registry** reconciled from the durable
  Postgres source ledger on startup and after Python service recovery. Query and
  describe use bounded account-and-allowlist catalogs; already registered files
  reload when their signatures change. XLSX is parsed offline through a bounded
  streaming reader; legacy `.xls` and `.doc` files are intentionally rejected.
- `server/src/config.ts`, `python/app/main.py` and `python/app/datasets.py` derive
  storage paths **relative to the repo** (`uploads/`, `reports_storage/`). If you
  override `UPLOAD_DIR`, set Python's `BOREALIS_STORAGE_DIR` to the same resolved
  absolute path; `scripts/dev.sh` does this automatically.

## License

Licensed under the [MIT License](LICENSE) — free to use, modify and self-host.
Built with open-source parts:
Fastify, React, DuckDB, matplotlib, WeasyPrint, ECharts, pgvector, LiteLLM.

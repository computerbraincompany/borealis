# Borealis ⚡

*Borealis — after the Aurora Borealis, the northern lights. A free and open-source
agentic workspace: chat with your uploaded documents and connected data
sources, then turn the answers into polished HTML and PDF reports.*

**Borealis** is an agentic "ask your data" platform. Point it at tabular files
(CSV, XLSX, parquet…), documents (PDF, DOCX, TXT) or URL connectors, then chat:
the agent writes SQL, makes charts, and can assemble a full report (HTML + PDF) —
e.g. ingest personal-finance CSVs and ask for a financial analysis with charts.

It runs 100% locally on an OpenAI-compatible stack (LiteLLM → LM Studio), so any
LiteLLM-backed provider works — OpenAI, local LLMs, etc. — and the data never has
to leave your machine.

## Architecture

```
web/        React + Vite + Tailwind + shadcn UI · port 5173
            auth, chat (SSE streaming), sources, URL connectors, reports
server/     Node.js (TypeScript, ESM) Fastify API · port 3000
            agent loop, uploads, RAG chunks (pgvector), chat SSE, reports
python/     FastAPI report service (uv) · port 8000
            DuckDB query layer, charts (matplotlib PNG + ECharts), HTML/PDF reports
docker/     PostgreSQL + pgvector (via docker-compose)
            LiteLLM proxy (port 4000) → LM Studio (port 1234) or any OpenAI API
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

Prerequisites: Node 22+, [uv](https://docs.astral.sh/uv/), Docker, and a running
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
loop. Borealis surfaces the provider error in that case and keeps the saved
selection; it never silently retries the turn with the process default.

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

> One-command alternative: `./scripts/dev.sh` starts everything (see the script
> header for requirements). The steps below explain each piece.

```bash
# 1. database
docker compose up -d postgres

# 2. Python report service + LiteLLM proxy (share the uv env)
cd python
uv sync
uv run litellm --config litellm.yaml --port 4000 &   # LLM proxy → LM Studio

# macOS: this DYLD var is REQUIRED so WeasyPrint finds glib/pango (brew install pango glib)
env DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib .venv/bin/uvicorn app.main:app --port 8000 &

# 3. Node server
cd ../server
npm install
cp .env.example .env
# Generate a secret, then paste it after JWT_SECRET= in .env.
openssl rand -base64 32
npm run dev                                            # http://localhost:3000

# 4. Frontend
cd ../web
npm install
npm run dev                                            # http://localhost:5173
```

On Linux install the system libraries instead (e.g. Debian/Ubuntu:
`sudo apt install libpango-1.0-0 libpangoft2-1.0-0 libglib2.0-0`); no
DYLD variable is needed. See WeasyPrint's dependency docs.

> The LiteLLM **proxy must run from the uv environment**, not Docker (the compose
> entry is commented out by design). If you don't need a proxy, point
> `LITELLM_BASE_URL` at any OpenAI-compatible API directly.
>
> The Node server re-registers tabular sources with the Python service on boot; if
> you restart the Python service, restart the Node server afterwards.

## Verify end to end

```bash
python data/generate_sample.py            # creates data/sample/*.csv
curl http://localhost:3000/health         # expect {"status":"ok",...}
```

Then in the UI (or via the API): upload `data/sample/*.csv`, ask something like
*"Analyze my spending and produce a financial report with charts"*, open the chat,
then fetch the generated report:

- HTML: `GET /api/reports/:id/html` · PDF: `GET /api/reports/:id/pdf`

The agent grounds every answer in your data via DuckDB SQL and pgvector retrieval —
it never invents numbers.

## Features

- **Agentic chat**: tool loop (retrieve / list_sources / query_data / describe_data /
  render_chart / create_report / fetch_url), SSE streaming, per-account data.
- **Per-chat models**: discover IDs from the configured endpoint, persist the
  selected model per conversation, and retain model attribution on each answer.
- **Per-chat sources**: choose all, a stable subset, or deliberately none; one
  immutable turn snapshot is enforced in prompts, RAG, SQL, describe, and reports.
- **Tabular SQL**: DuckDB-backed; upload CSV/XLSX/parquet/JSONL or connect a
  `url_csv` / `url_json` connector with one-click resync.
- **RAG over documents**: PDF, DOCX, TXT, plus natural text extracted from
  spreadsheets, chunked + embedded (pgvector, HNSW) for retrieval.
- **Charts**: one canonical spec renders interactively (ECharts) in chat/HTML and
  statically (matplotlib) in the PDF.
- **Reports**: agent-written markdown sections + live data tables + charts → a
  self-contained interactive HTML and a print-ready PDF.
- **Auth**: JWT + bcrypt, per-account data isolation, pgvector embeddings per user.

## Project layout & conventions

See [AGENTS.md](AGENTS.md) for the full agent-facing guide (commands, data flow,
gotchas). Highlights:

- `server/` uses **ESM** — import local modules with `.js` extension.
- The **chart spec** in `python/app/charts.py` is the contract between LLM, Node,
  ECharts and matplotlib — read it before changing.
- Datasets live in an **in-memory DuckDB registry** re-loaded from disk on boot.
  Query and describe use bounded account-and-allowlist catalogs; already
  registered files reload when their signatures change.
- `server/src/config.ts`, `python/app/main.py` and `python/app/datasets.py` derive
  storage paths **relative to the repo** (`uploads/`, `reports_storage/`); override
  via `UPLOAD_DIR`/`REPORT_DIR` or `BOREALIS_STORAGE_DIR`.

## License

MIT — free to use, modify and self-host. Built with open-source parts:
Fastify, React, DuckDB, matplotlib, WeasyPrint, ECharts, pgvector, LiteLLM.

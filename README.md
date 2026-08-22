# Borealis ⚡

*Borealis — after the Aurora Borealis, the northern lights. A free and open-source
MVP clone of Cohere North: chat with your uploaded documents and connected data
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
web/        React + Vite + Tailwind + shadcn UI (in progress)
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

```bash
# 1. database
docker compose up -d postgres

# 2. Python report service + LiteLLM proxy (share the uv env)
cd python
uv sync
uv run litellm --config litellm.yaml --port 4000 &   # LLM proxy → LM Studio
uv run uvicorn app.main:app --reload --port 8000 &      # report service

# 3. Node server
cd ../server
npm install
cp .env.example .env
npm run dev                                            # http://localhost:3000
```

> The LiteLLM **proxy must run from the uv environment**, not Docker (the compose
> entry is commented out by design). If you don't need a proxy, point
> `LITELLM_BASE_URL` at any OpenAI-compatible API directly.

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
- Datasets live in an **in-memory DuckDB registry** re-loaded from disk on boot;
  copy files + restart (or register via API) so they appear.
- `server/src/config.ts`, `python/app/main.py` and `python/app/datasets.py` derive
  storage paths **relative to the repo** (`uploads/`, `reports_storage/`); override
  via `UPLOAD_DIR`/`REPORT_DIR` or `NORTH_STORAGE_DIR`.

## License

MIT — free to use, modify and self-host. Built with open-source parts:
Fastify, React, DuckDB, matplotlib, WeasyPrint, ECharts, pgvector, LiteLLM.

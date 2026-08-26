# Borealis ⚡

_Borealis — after the Aurora Borealis, the northern lights. A free and
open-source agentic workspace for chatting with documents and tabular data, then
turning answers into polished HTML and PDF reports._

Borealis accepts CSV, XLSX, Parquet, JSON, JSONL, PDF, DOCX, TXT, Markdown, and
bounded public URL connectors. Its agent can retrieve evidence, query tabular
sources with SQL, render charts, and assemble reports. Model calls go directly
to LM Studio or another OpenAI-compatible endpoint.

## Architecture

```text
desktop/    Electron shell for Apple Silicon macOS 13+
web/        React + Vite UI: chat, sources, reports, and Settings
server/     Fastify API, agent loop, ingestion, retrieval, and rendering
data/       deterministic personal-finance fixtures
```

The durable store is deliberately split by job:

- SQLite stores users, chats, runs, sources, jobs, and chunk text.
- LanceDB stores scoped embedding vectors for retrieval.
- DuckDB runs bounded analytical SQL against uploaded tabular data.
- The filesystem stores uploads, reports, settings, and the generated JWT
  signing secret.

The browser development stack uses an isolated Playwright Chromium instance for
chart PNG and report PDF output. The packaged app does not include that browser;
it renders through a hidden, network-denied Electron window instead.

## Desktop app

The desktop build supports Apple Silicon Macs running macOS 13 or later. It
starts the Fastify backend in an Electron utility process on an OS-assigned
`127.0.0.1` port and serves the built React UI from that same origin. First
launch creates a local account and hands a fresh session to the trusted preload,
so the normal desktop path does not show a registration form. The bootstrap JWT
is kept only in Chromium session storage; quitting and reopening the app mints a
fresh session for the same local account.

Durable files live under:

```text
~/Library/Application Support/Borealis/
  borealis.sqlite
  lancedb/
  uploads/
  reports/
  settings.json
  jwt.secret
```

The JWT secret is generated once with mode `0600`, and provider settings are
also written with mode `0600`. No `.env` file is required.

Install dependencies and launch a development build:

```bash
npm ci --prefix server
npm ci --prefix web
npm ci --prefix desktop
npm --prefix desktop run dev
```

Build unsigned arm64 installers for local testing:

```bash
npm --prefix desktop run package:unsigned
```

Artifacts are written to `desktop/release/` as
`Borealis-<version>-macOS-arm64.dmg` and `.zip`. The unsigned target is for local
testing, deterministically disables signing/notarization, and currently uses
Electron's default application icon. Distribution builds use
`npm --prefix desktop run package:mac` and need a Developer ID Application
certificate plus notarization credentials supplied only in the release
environment; certificates and credentials must never be committed. See
`desktop/README.md` for the exact variables and package verification commands.

Signed distribution builds use Apple's hardened runtime. The unsigned local-test
artifacts are neither signed nor notarized. Version 1 deliberately does not
enable the Mac App Store application sandbox because its native SQLite, LanceDB,
and DuckDB modules and direct application-data storage need a separate sandbox
design.

## Model setup and privacy boundary

Borealis does not bundle model weights. Start LM Studio with a chat model and an
embedding model, or configure a remote OpenAI-compatible provider in the
existing Settings modal. Local defaults are:

- endpoint: `http://127.0.0.1:1234`
- chat model: `qwen-chat`
- embedding model: `nomic-embed`

Settings can save the endpoint, API key, model IDs, and an optional distinct LM
Studio health endpoint. API keys are redacted in responses and are never sent in
health payloads, logs, or chat events. Environment overrides remain available
for operators and CI and make their corresponding Settings fields read-only.
Canonical overrides are `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_CHAT_MODEL`, and
`LLM_EMBED_MODEL`. Retained `LITELLM_*` names are lower-precedence compatibility
aliases only; Borealis no longer starts or requires a LiteLLM process.

Saving a different embedding model does not rewrite existing vectors. Keep
`EMBEDDING_DIM` compatible with the model and reingest existing sources after a
change; the LanceDB table dimension is fixed when it is first created.

When a remote provider is configured, prompts and the selected source context
leave this Mac and are governed by that provider's data policy. Source parsing,
analytical SQL, the durable stores, and report rendering remain local. Remote
provider URLs must use HTTPS; plain HTTP is accepted only for validated loopback
origins.

## Browser development

Prerequisites are Node.js 22.13 or newer 22.x and npm 10.9.x. Start the model
endpoint separately, then run:

```bash
./scripts/dev.sh
```

The script synchronizes the server and web lockfiles and supervises the API at
`http://127.0.0.1:3000` and Vite UI at `http://127.0.0.1:5173`. Embedded data is
stored in `.borealis/`. Install Chromium once before using browser-development
chart or PDF rendering:

```bash
(cd server && npx playwright install chromium)
```

To start the two processes manually:

```bash
npm ci --prefix server
npm ci --prefix web
(cd server && npm run dev)
(cd web && npm run dev)
```

No container, external database, manually generated credential, or copied
`.env` file is part of the development happy path. `server/.env.example`
documents optional operator overrides and resource budgets.

## Verify end to end

Generate the deterministic fixtures:

```bash
npx --prefix server --no-install tsx data/generate_sample.ts
curl http://127.0.0.1:3000/health
```

Upload `data/sample/*.csv` in Sources, attach the ready sources to a chat, and
ask: _“Analyze my spending and produce a financial report with charts.”_ Open the
report from chat or Reports. The same artifacts are available from:

- `GET /api/reports/:id/html`
- `GET /api/reports/:id/pdf`

Run the complete repository gate with:

```bash
./scripts/verify.sh
```

It checks fixture equivalence, server and web typecheck/lint/format/tests/builds,
embedded-storage integration tests, and desktop TypeScript, tests, build, and
native Electron ABI smoke coverage. CI additionally packages the unsigned arm64
DMG and ZIP on an Apple Silicon runner.

On macOS, also run the renderer and packaged-native checks when changing the
desktop shell or packaging inputs:

```bash
npm --prefix desktop run verify
npm --prefix desktop run package:unsigned
npm --prefix desktop run package:native:smoke
```

## Backups

Quit Borealis before copying its data directory. The SQLite ledger and LanceDB
vector directory are one logical store and must be backed up and restored
together; restoring only one side can produce missing or orphaned retrieval
entries. Copying the entire `Borealis/` application-data directory also preserves
uploads, reports, provider settings, and the JWT secret.

For browser development, apply the same rule to `.borealis/borealis.sqlite` and
`.borealis/lancedb/` (or to the configured `BOREALIS_DATA_DIR`).

## Features and invariants

- One bounded streaming tool loop with cancellation, durable run ownership, and
  sanitized activity summaries.
- Dynamic all-source scope, a stable selected allowlist, or deliberately no
  stored sources. Each accepted turn keeps one immutable ready-source snapshot.
- Account- and source-prefiltered LanceDB retrieval joined fail-closed to SQLite
  chunk text.
- Bounded DuckDB SQL for CSV, TSV, XLSX, Parquet, JSON, and JSONL plus staged URL
  connector refreshes.
- One canonical ECharts contract shared by the UI, report HTML, chart PNG, and
  report PDF renderers.
- Self-contained report HTML with restrictive CSP and renderer policies that
  deny network and local-file requests.
- JWT/bcrypt authentication, exact-origin browser CORS, same-origin desktop UI,
  per-account storage, and path-ownership checks before file access or deletion.

See [AGENTS.md](AGENTS.md) for implementation guidance and
[docs/API.md](docs/API.md) for the REST/SSE contract.

## License

Licensed under the [MIT License](LICENSE). Built with Fastify, React, Electron,
SQLite, LanceDB, DuckDB, ExcelJS, Playwright, and ECharts.

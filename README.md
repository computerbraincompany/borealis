# Borealis ⚡

_Borealis — after the Aurora Borealis, the northern lights. A free and
open-source agentic workspace for chatting with documents and tabular data, then
turning answers into polished HTML and PDF reports._

Borealis accepts CSV, TSV, XLSX, Parquet, JSON, JSONL, PDF, DOCX, TXT, Markdown, and
bounded public URL connectors. Its agent can retrieve evidence, query tabular
sources with SQL, render charts, and assemble reports. Model calls go directly
to LM Studio or another OpenAI-compatible endpoint.

## Documentation

| Guide                                        | Contents                                                                   |
| -------------------------------------------- | -------------------------------------------------------------------------- |
| [This README](#desktop-app)                  | Setup, model configuration, daily use, verification, and backups           |
| [Product vision](docs/VISION.md)             | What Borealis is becoming: local data intelligence as a desktop platform   |
| [API reference](docs/API.md)                 | REST endpoints, SSE events, lifecycle, errors, and resource limits         |
| [Desktop guide](desktop/README.md)           | Development profiles, native modules, packaging, signing, and smoke checks |
| [Contributor instructions](AGENTS.md)        | Architecture, commands, and security invariants                            |
| [Configuration example](server/.env.example) | Optional environment overrides, defaults, and valid ranges                 |
| [Milestones](milestones/README.md)           | Active implementation ledger toward the product vision                     |

[Milestones](milestones/README.md) are the active implementation ledger toward
the vision. [Completed implementation plans](plans/README.md) and the dated
[product research archive](docs/cohere-north/README.md) preserve historical
decisions and proposals; they are not current setup instructions or a list of
unimplemented requirements.

## Architecture

```text
desktop/    Electron shell for Apple Silicon macOS 13+
web/        React + Vite UI: chat, sources, connectors, reports, and Settings
server/     Fastify API, agent loop, ingestion, retrieval, and rendering
data/       deterministic personal-finance fixtures
```

Install once from the repository root with pnpm. The root `preinstall` script
rejects npm. Turborepo runs package `dev` and `build` graphs; the complete
repository gate is the root `pnpm verify` script. Do not install `server`,
`web`, or `desktop` as separate npm trees.

The durable store is deliberately split by job:

- SQLite stores users, chats, runs, sources, jobs, and chunk text.
- LanceDB stores scoped embedding vectors for retrieval.
- DuckDB runs bounded analytical SQL against uploaded tabular data.
- The filesystem stores uploads, reports, settings, and the generated JWT
  signing secret.

The browser development stack uses an isolated Playwright Chromium instance for
chart PNG and report PDF output. The packaged app does not include that browser;
it renders through a hidden, network-denied Electron window instead.

All source-build commands below run from the repository root unless a working
directory is shown. Use Node.js 22.13 or newer **22.x** and pnpm **10.x**;
[.nvmrc](.nvmrc) pins Node.js 22.22.3. Enable Corepack once with
`corepack enable` so the repository `packageManager` pin is used.

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
pnpm install
pnpm dev:desktop
```

Development builds use the same application-data directory as the installed
app and rebuild before launch; they do not run Vite with hot reload. For an
isolated test profile, follow the [desktop guide](desktop/README.md).

Build unsigned arm64 installers for local testing:

```bash
pnpm package:unsigned
```

Artifacts are written to `desktop/release/` as
`Borealis-<version>-macOS-arm64.dmg` and `.zip`. The unsigned target is for local
testing, deterministically disables signing/notarization, and currently uses
Electron's default application icon. Distribution builds use
`pnpm --filter borealis-desktop package:mac` and need a Developer ID Application
certificate plus notarization credentials supplied only in the release
environment; certificates and credentials must never be committed. See
[desktop/README.md](desktop/README.md) for the exact variables and package
verification commands. A successful `package:mac` command alone does not prove
that signing and notarization happened; verify the resulting artifact.

Signed distribution builds use Apple's hardened runtime. The unsigned local-test
artifacts are neither signed nor notarized. Version 1 deliberately does not
enable the Mac App Store application sandbox because its native SQLite, LanceDB,
and DuckDB modules and direct application-data storage need a separate sandbox
design.

## Model setup and privacy boundary

Borealis does not bundle model weights. Start LM Studio with a chat model that
supports streaming tool calls and a separate embedding model, or configure a
remote OpenAI-compatible provider under **Settings → Models**. The same provider
origin serves `/v1/models`, `/v1/chat/completions`, and `/v1/embeddings`; the
optional LM Studio URL is only a separate health probe, not an embedding endpoint.
Local defaults are:

- endpoint: `http://127.0.0.1:1234`
- chat model: `qwen-chat`
- embedding model: `nomic-embed`

These model names are aliases defined in
[server/src/llmAliases.ts](server/src/llmAliases.ts):

| Alias         | Model ID sent to the provider          |
| ------------- | -------------------------------------- |
| `qwen-chat`   | `qwen/qwen3.6-35b-a3b`                 |
| `qwen-27b`    | `qwen3.8-27b-obliterated`              |
| `nemotron`    | `nvidia/nemotron-3-nano`               |
| `nomic-embed` | `text-embedding-nomic-embed-text-v1.5` |

Other model IDs pass through unchanged. Configure IDs your provider actually
serves; the chat and embedding identities must be distinct. Model discovery
hides the configured embedding model, but does not prove that every remaining
model supports tool calling. A chat keeps its saved model when the default changes.

Enter a bare origin such as `http://127.0.0.1:1234`, without `/v1`, other paths,
credentials, query parameters, or fragments. Borealis adds `/v1` itself.
**Test connection** checks HTTP success from `/v1/models` without saving the
draft, reading the response body, or running chat/embedding inference. Use
**Save changes** to apply changes to subsequent model operations without a
restart.

The workspace sidebar always shows where inference runs — **On this Mac**,
**Private network**, or **Remote provider** — together with endpoint
reachability and the configured chat model. When a remote provider is
configured, the sidebar keeps a standing disclosure that ingestion text,
prompts, retrieval queries, and selected tool context leave the machine under
that provider's policy, linking to Settings. The snapshot comes from the
authenticated `GET /api/status` endpoint and never contains the endpoint URL,
key, provider errors, or model lists.

Provider settings are shared by all accounts using the same server. A saved API
key is stored in `settings.json` with mode `0600`, not encrypted or held in the
macOS Keychain. Responses expose only whether a key is configured; they never
return the key. Leave its input blank to preserve it or use **Clear saved key**.
Health responses, logs, and chat events do not contain keys.

Environment overrides remain available for operators and CI and make their
corresponding Settings fields read-only; changing these requires a restart.
Canonical overrides are `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_CHAT_MODEL`, and
`LLM_EMBED_MODEL`. Retained `LITELLM_*` names are lower-precedence compatibility
aliases only; Borealis no longer starts or requires a LiteLLM process.

Saving a different embedding model does not rewrite existing vectors. For a
model with the same output dimension, reingest every source before relying on
retrieval. The UI's **Retry** action appears only for failed sources; ready
sources can be reingested with authenticated `POST /api/sources/:id/reingest`
(see [Sources](docs/API.md#sources)). `EMBEDDING_DIM` defaults to 768 and must
match the model's output.
Changing it against an existing LanceDB table prevents startup; reingestion
alone cannot resize that table. A dimension change needs a new, separate data
directory and fresh ingestion, or an explicit storage migration. Preserve the
old SQLite/LanceDB pair and never delete only the vector directory as a reset.

When a remote provider is configured, source text sent for embeddings during
ingestion, retrieval queries, prompts, chat history, and selected source/tool
context leave the machine under that provider's data policy. Uploading a source
can therefore send text for embedding even before it is attached to a chat.
Source parsing, analytical SQL, the durable stores, and report rendering remain
local. Remote provider URLs must use HTTPS; plain HTTP is accepted only for
validated loopback origins.

## Browser development

Start the model endpoint separately, then run:

```bash
pnpm install
pnpm dev
```

Turborepo starts the API at `http://127.0.0.1:3000` and Vite normally on port
5173. Open Vite's printed local URL (normally `http://localhost:5173`). Ctrl-C
stops both processes. Embedded data is stored in `.borealis/`.

Install Chromium after installing dependencies, before using browser
chart/PDF rendering or running server tests:

```bash
pnpm --filter borealis-server exec playwright install chromium
```

On Linux, CI uses `pnpm --filter borealis-server exec playwright install --with-deps chromium`
to install the required system libraries too. Repeat the browser installation
when the locked Playwright version changes. Desktop rendering does not need it.

To start the two processes without Turborepo:

```bash
pnpm --filter borealis-server dev
pnpm --filter borealis-web dev
```

No container, external database, manually generated credential, or copied
`.env` file is part of the development happy path. Browser users register or log
in on first use; their seven-day session is kept in browser local storage.
[server/.env.example](server/.env.example) documents optional operator overrides
and resource budgets. If using an environment file, place it at `server/.env`
and start the server from `server/`. The desktop backend does not read `.env`.

To serve a built browser UI from the API's exact origin without Vite:

```bash
pnpm --filter borealis-server build
pnpm --filter borealis-web build
(cd server && STATIC_WEB_DIR=../web/dist node dist/index.js)
```

This uses Playwright for rendering and normal browser login. CORS headers are
omitted in this mode; without `STATIC_WEB_DIR`, browser development uses the
exact `CORS_ORIGINS` allowlist. Keep the default loopback binding unless you
intend to expose the API and its shared provider settings to other users. If
you expose `HOST`, this does not add TLS or restrict public registration; every
authenticated account can modify provider settings. If you change the API port
in Vite development, also update the proxy target in
[web/vite.config.ts](web/vite.config.ts).

## Using the workspace

Upload through **Sources** or the chat source picker. Supported file extensions
are `.csv`, `.tsv`, `.xlsx`, `.parquet`, `.json`, `.jsonl`, `.pdf`, `.docx`,
`.txt`, `.md`, `.markdown`, `.text`, and `.log`. Legacy `.xls` and `.doc` files
are rejected; XLSX imports only the first worksheet. PDF ingestion extracts
existing text, not OCR. Uploads default to 25 MiB; parsing and output have
additional bounds documented in the [API reference](docs/API.md).

New UI chats start with no sources. Select particular sources or choose **All
sources** to include current and future sources for each new turn. An empty
selection means no stored data; only ready sources are included in a turn's
fixed snapshot. Uploads are processed asynchronously, so wait for **ready**
before asking about them. Failed sources show a safe explanation and a **Retry**
action. Tabular retrieval uses a bounded row preview; ask quantitative questions
through SQL so the agent can query the full registered table.

**Connectors** import public CSV or JSON URLs and provide **Sync now** for
refreshing them; they are not a scheduled sync service. Private/loopback URLs,
URL credentials, and arbitrary request headers are unsupported. The separate
chat `fetch_url` tool can fetch only public URLs explicitly written in the
current message.

Answers can show retrieved passages, charts, and saved query-result previews.
**Download CSV** exports the saved preview, not an unlimited rerun of the SQL.
Open generated HTML/PDF from chat or **Reports**. Chat history supports title
search, rename, and deletion; **Settings** also contains system readiness,
Light/Dark/System appearance, and account controls.

## Verify end to end

With server dependencies installed, regenerate the four deterministic fixtures
(already tracked in `data/sample/`):

```bash
pnpm --filter borealis-server exec tsx ../data/generate_sample.ts
curl http://127.0.0.1:3000/health
```

The curl command applies to the running browser-development server. `/health`
is a public liveness check, not proof that models or rendering work. Inspect
**Settings → System** (authenticated `GET /api/health`) and **Models**, then:

1. Upload `accounts.csv`, `budget.csv`, `networth.csv`, and `transactions.csv`
   from `data/sample/`, and wait until all four are ready.
2. Attach all four to a chat and ask: _“Analyze my spending and produce a
   financial report with charts.”_
3. Verify that the agent uses `query_data`, `render_chart`, and `create_report`;
   inspect the saved query previews and chart values.
4. Open the report from chat or Reports. Confirm the HTML works without external
   assets, downloaded PDFs begin with `%PDF-`, and chart PNGs have the PNG signature.

The report artifacts are also available through authenticated requests to:

- `GET /api/reports/:id/html`
- `GET /api/reports/:id/pdf`

After installing dependencies and Playwright Chromium, run the complete
repository gate:

```bash
pnpm verify
```

It runs the policy/fixture gate, then server, web, and desktop typecheck, lint,
format, tests, and builds, plus embedded-storage integration tests. Desktop
`native:smoke` resolves isolated addon production dependencies under Node, opens
SQLite/LanceDB/DuckDB through Electron's ABI, and loads the same addons from an
Electron utility process. Root `pnpm verify` does not run the GUI renderer
smoke. CI additionally packages the unsigned arm64 DMG and ZIP on an Apple
Silicon runner.

The gate uses fixtures and provider mocks; it does not run live-model analysis,
desktop first-launch interaction, or a signed release check. Perform the manual
flow above when validating a provider or an end-to-end release.

On macOS, also run the renderer and packaged-native checks when changing the
desktop shell or packaging inputs:

```bash
pnpm --filter borealis-desktop verify
pnpm package:unsigned
pnpm --filter borealis-desktop package:native:smoke
```

## Backups

Quit Borealis before copying its data directory. The SQLite ledger and LanceDB
vector directory are one logical store and must be backed up and restored
together; restoring only one side can produce missing or orphaned retrieval
entries. Copying the entire `Borealis/` application-data directory also preserves
uploads, reports, provider settings, and the JWT secret.

For browser development, stop both development processes and copy all of
`.borealis/` (or the configured `BOREALIS_DATA_DIR`). Include any files relocated
by individual path overrides. Keep any SQLite `-wal`/`-shm` files with the ledger.
To restore, keep Borealis stopped and restore the matching directory together.
Protect backups as sensitive data: they include source content, reports, any
saved provider key, and the signing secret. Losing or replacing that secret
invalidates existing sessions.
Preserve and reapply environment-managed configuration separately, especially
an explicit `JWT_SECRET` and `EMBEDDING_DIM`; those values are not saved in the
settings file or generated-secret file.

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

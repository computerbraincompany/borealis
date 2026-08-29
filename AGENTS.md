# Borealis — open-source agentic data workspace

Agentic chat over uploaded documents and tabular data, plus HTML/PDF report
generation. Model calls go directly to LM Studio or another OpenAI-compatible
API.

Repo: `computerbraincompany/borealis` on GitHub (formerly _north-clone_).
Product direction lives in [docs/VISION.md](docs/VISION.md); it is the intended
destination, not a list of current features or an implementation backlog.

## Architecture

- `server/` — Node.js 22 (TypeScript, ESM) Fastify API. It owns authentication,
  the agent loop, durable ingestion and chat runs, retrieval, connectors,
  reports, and static web hosting. Resource routes live under
  `server/src/routes/`; data internals live under `server/src/data/`.
- `server/src/db/` — SQLite migrations, codecs, and async store facades for the
  relational ledger and chunk text. `server/src/storageRuntime.ts` composes the
  SQLite stores with LanceDB.
- LanceDB — vector-only index keyed by stable chunk UUID, account, source, and
  ingestion generation. It never stores passage text.
- DuckDB — analytical engine for user tabular files only, isolated in a worker
  thread. It is not the application ledger.
- `web/` — Vite + React + TypeScript + Tailwind UI. Pages cover auth, chat,
  sources, URL connectors, reports, and the workspace Settings modal. Browser
  development proxies `/api` to port 3000.
- `desktop/` — Electron main/preload shell for Apple Silicon macOS 13+. It runs
  the compiled Fastify backend in a utility process and serves the built web UI
  from the backend's exact loopback origin.
- `data/` — deterministic TypeScript generator and personal-finance CSV fixtures
  used by end-to-end verification.

The repository is a pnpm workspace (`server`, `web`, `desktop`) with a root
Turborepo graph and a single `pnpm-lock.yaml`. Install once from the repository
root after `corepack enable`. The root `preinstall` script rejects npm. Do not
add npm lockfiles, hoist the workspace, or install a workspace package in
isolation. Desktop duplicates server runtime dependencies and must not
workspace-link `borealis-server`; shared versions are pinned in root
`pnpm.overrides`. `desktop/scripts/render-smoke-app` is not a workspace package.

## Commands

Use Node.js 22.13 or newer 22.x and pnpm 10.x; `.nvmrc` pins 22.22.3.
Enable Corepack once with `corepack enable`. Run the commands below from the
repository root.

```bash
# Install once (all workspace packages)
pnpm install
pnpm --filter borealis-server exec playwright install chromium

# Browser development; embedded engines need no external service.
pnpm dev

# Server
pnpm --filter borealis-server typecheck
pnpm --filter borealis-server lint
pnpm --filter borealis-server format:check
pnpm --filter borealis-server test
pnpm --filter borealis-server test:integration
pnpm --filter borealis-server build

# Web
pnpm --filter borealis-web typecheck
pnpm --filter borealis-web test
pnpm --filter borealis-web lint
pnpm --filter borealis-web format:check
pnpm --filter borealis-web build

# Desktop (Apple Silicon macOS 13+)
pnpm --filter borealis-desktop verify
pnpm dev:desktop
pnpm package:unsigned
pnpm --filter borealis-desktop package:native:smoke

# Policy / fixture gate only
pnpm policy

# Complete repository gate
pnpm verify
```

No `.env` file or manually created credential is required. The model endpoint
defaults to loopback LM Studio and can be changed in Settings. Browser
development renders PNG/PDF with Playwright; the packaged app uses Electron and
does not include Playwright's Chromium download.

The complete gate is `scripts/policy-check.mjs` plus Turborepo
`typecheck`, `lint`, `format:check`, `test`, `test:integration`, `build`, and
`native:smoke`. It requires workspace dependencies and Playwright Chromium;
Linux CI installs it with `pnpm --filter borealis-server exec playwright install --with-deps chromium`.
`native:smoke` resolves isolated addon production dependencies under Node, opens
SQLite/LanceDB/DuckDB through Electron's ABI, and loads the same addons from an
Electron utility process. `ELECTRON_RUN_AS_NODE` alone is not enough: that path
can still see the pnpm virtual store after isolation. Root `pnpm verify` does
not run `render:smoke`, packaging, signed-release checks, or live-model
analysis. `desktop`'s `verify` adds the GUI PNG/PDF smoke.

Desktop development rebuilds before launch and uses the installed app's default
data directory. Use an absolute `--user-data-dir` argument for an isolated
profile; see [desktop/README.md](desktop/README.md). Browser development loads
`server/.env` when started from `server/`; desktop skips dotenv and owns its
bind, storage, static-UI, and renderer environment values.

## Durable storage

Browser development defaults to `<repo>/.borealis/`. Electron passes exact paths
below `~/Library/Application Support/Borealis/`:

- `borealis.sqlite` — relational ledger and chunk text;
- `lancedb/` — embedding vectors;
- `uploads/` — account/source-scoped input and connector files;
- `reports/` — HTML/PDF artifacts;
- `settings.json` — provider settings, atomically written with mode `0600`;
- `jwt.secret` — generated once with mode `0600`.

Environment overrides are documented in `server/.env.example`. A configured
`JWT_SECRET` wins and must be strong. Without one, `config.ts` opens or creates
the secret file without following symlinks and repairs its mode to `0600`.

SQLite and LanceDB are one logical store. Back them up and restore them together,
with Borealis stopped. Prefer copying the complete application-data directory so
SQLite WAL state, uploads, reports, settings, and the signing secret stay with
the matching vector index.

## Data flow

1. Uploaded files land in UUID-scoped
   `uploads/<account-id>/<source-id>/` directories. SQLite records the source and
   durable ingestion job. Workers extract within configured budgets, assign
   stable chunk UUIDs, stage text in SQLite and vectors in LanceDB, then promote
   one generation using the two-store protocol.
2. `POST /api/chats/:id/messages` commits the user message, model, source mode,
   concrete ready source IDs, and durable run in one SQLite transaction. It then
   streams sanitized SSE events from `server/src/agent.ts` for at most eight
   iterations. One active run is allowed per chat; deletion of the run requests
   cancellation. Activity events arrive during execution, but the answer's
   `delta` is sent as a complete string after persistence, not token by token.
3. Agent tools in `server/src/tools.ts` are `retrieve`, `list_sources`,
   `query_data`, `describe_data`, `render_chart`, `create_report`, and
   `fetch_url`. Every stored-data tool consumes the immutable source snapshot.
   `fetch_url` is separate and can access only a public HTTP(S) URL written
   explicitly in the current user turn, within redirect, time, and byte limits.
4. Retrieval prefilters LanceDB by account and ready source allowlist before
   KNN, then joins hits to SQLite by stable chunk UUID under the same scope.
   Missing SQLite text drops the vector hit.
5. The agent assembles markdown sections, tables, and chart IDs. The server
   builds self-contained ECharts HTML and a static PDF, then stores both below
   the report directory. Reports carry per-chat lineage: creation assigns
   `version` = newest *published* report for that chat plus 1 and records
   `supersedes`; pending artifacts from failed runs never join the chain, and
   superseded reports are never auto-deleted. The normalized report payload is
   stored with the row (dropped oversize, never fatal) and is exposed only on
   the detail endpoint. Rename updates the title only.

## Two-store consistency

- A chunk UUID is assigned at staging time and used in both engines.
- A new generation may be visible to retrieval only after SQLite promotion
  commits. SQLite `ready_generation` is authoritative.
- Failed or superseded jobs delete only their staged generation's vectors.
- Source deletion records durable pending cleanup before removing vector and
  filesystem artifacts.
- Startup repair removes stale generations, orphan vectors, and unfinished
  source deletions. Log only aggregate counts, never IDs, paths, or content.
- Do not scan a broad vector set and filter it in JavaScript. Account and source
  predicates belong in the LanceDB search itself; the SQLite join is an
  additional fail-closed check.
- Do not put embeddings into SQLite or application ledger tables into DuckDB.

## Conventions and security invariants

- Server code is ESM. Local imports always include the `.js` extension and use
  `import`, not `require`.
- Authentication uses seven-day HS256 JWTs and bcrypt password hashes.
  Registration, login, and `/health` are public; resource, Settings,
  `/api/health`, and `/api/openapi.json` routes use `requireAuth`. Electron creates
  one local user and sends a fresh bootstrap session exactly once through the
  context-isolated preload. The desktop happy path is register-free.
- The desktop backend binds exactly `127.0.0.1` on an OS-assigned port. Fastify
  serves the production UI from that origin, so it needs no cross-origin
  headers. Vite development keeps the exact `CORS_ORIGINS` allowlist. Never
  reflect arbitrary origins. Browser builds can use `STATIC_WEB_DIR` for the
  same static-hosting path without enabling desktop bootstrap or Electron rendering.
- Requests propagate a sanitized `X-Request-ID`. Never log credentials, prompts,
  uploaded content, SQL results, signed URLs, raw tool arguments/results, or
  provider exception bodies.
- `server/src/dataService.ts` is the opaque facade over in-process dataset,
  connector, chart, and report operations. Its public internal error is
  `DataServiceError` with code `DATA_SERVICE_ERROR`; ingest deliberately keeps
  the public `DATA_SERVICE_UNAVAILABLE` envelope.
- The canonical chart contract lives in `server/src/data/charts.ts` and is
  consumed by the agent, stored charts, web fallback, interactive reports, and
  both static render backends. One spec must keep every renderer in sync.
- Rendering is deny-by-default. Both Playwright and the Electron hidden window
  accept only `about:blank` and bounded canonical PNG data. They must not
  navigate to user content or load local files, HTTP(S), WebSocket, or other
  resources. Electron render replies must validate PNG/PDF magic bytes.
- Scoped DuckDB catalogs are keyed by account plus sorted table allowlist,
  capped at eight scopes per account, and protected by per-account locks.
  Trusted files load before external access is disabled; user SQL cannot
  re-enable it.
- Query, describe, catalog, and extraction enforce server-derived
  `allowed_tables` at the worker boundary. Selected-empty is a valid empty scope
  and must never widen to all sources.
- SQL is exactly one read-only SELECT/WITH/VALUES statement. Query and extraction
  time, rows, columns, cells, and returned characters are bounded at the worker
  boundary.
- XLSX ingestion is offline and bounded: ZIP member and expansion checks precede
  the streaming ExcelJS first-sheet reader. Legacy `.xls` and `.doc` inputs are
  unsupported. Never add npm `xlsx` or enable DuckDB extension auto-install.
- Connector refresh is prepare → extract → activate/abort. Downloads use the
  shared SSRF policy, DNS pinning, identity encoding, bounded redirects/time,
  and immutable version-cache files. Activation is exact-location
  compare-and-swap; cleanup never keys on table name alone.
- File reads and deletions must prove lexical and real paths belong to the exact
  UUID-scoped account/resource directory, with no symlink component. Never build
  a recursive deletion target from an unvalidated stored path or filename.
- Chat source state has three meanings: `all` dynamically includes current and
  future sources; `selected` with rows is a stable allowlist; `selected` with no
  rows means none. New web chats start selected-empty. Only ready attachments
  enter a turn snapshot. API clients omitting scope at chat creation retain
  legacy `all` behavior. Scope resolution is capped at 100 attached sources,
  including unready sources; it must fail rather than silently truncate a scope.
- Libraries (`server/src/db/stores/libraryStore.ts`, schema v5) reference
  sources without copying them. Attaching a library expands its ready members
  into an explicit `selected` scope at attach time through the normal
  chat-creation contract; never add a server-side dynamic chat↔library
  resolution path without speccing it against the scope semantics above.
  Library deletion cascades membership only — never sources or their data.
- The OpenAI Node client defaults embeddings to base64 and decodes responses.
  Compatible local runtimes return float arrays, so `server/src/llm.ts` must
  continue sending `encoding_format: "float"` explicitly.
- Agent tools are wired through `TOOL_DEFS` in one streaming loop. Never expose
  provider reasoning, raw tool payloads, or exceptions in SSE. The UI receives
  only stable server-defined summaries.
- `makeReportPayload` keeps its 12-character chart-ID prefix fallback because
  models can garble long UUIDs. Report normalization strips inline
  `chart:`/`:::` tokens.
- Changing the embedding model after ingestion requires reingesting all sources
  even when its dimension is unchanged. The LanceDB table dimension is fixed at
  creation; a different `EMBEDDING_DIM` makes reopening it fail. A dimension
  change needs a fresh complete data directory or an explicit migration, not
  reingestion alone or deletion of just the vector index.

## Model endpoint and Settings

Settings persist the OpenAI-compatible endpoint, optional API key, optional
distinct LM Studio health endpoint, and default chat/embed model IDs. They are
process-wide, shared by all authenticated accounts. The key is stored as text in
the mode-`0600` settings file; public responses expose only a configured boolean.
The local endpoint default is `http://127.0.0.1:1234`; non-loopback endpoints
require HTTPS. Endpoints must be bare origins: Borealis appends `/v1`, so paths,
queries, fragments, and URL credentials are rejected. The optional LM Studio
endpoint is a health probe only; chat and embeddings use the provider endpoint.
Saving through Settings updates later model operations without a restart;
environment changes or direct file edits need a restart to reliably update the
cached runtime configuration.

Environment values win over `settings.json` and disable the corresponding field.
`PATCH /api/settings` never returns the key; an omitted key preserves it and
`null` clears it. `POST /api/settings/test` performs a body-free `GET /v1/models`
against the draft effective configuration without persisting it. It checks HTTP
success, not model availability, tool support, or embedding compatibility.

The ambient chrome strip is fed by `GET /api/status`
(`server/src/workspaceStatus.ts`). Keep its probe body-free, bounded, and
redirect-refusing via `server/src/endpointProbe.ts`; the response carries
locality (`local`/`private`/`remote`), reachability, and configured chat/embed
model IDs, and must never include the endpoint URL, credentials, provider
errors, or model lists. The strip is informational chrome, not an
authorization surface, and its egress wording must stay consistent with the
Settings privacy text.

Remote model-provider egress is fail-closed
(`server/src/egressPolicy.ts`): while a remote provider is configured and the
account has not acknowledged remote egress (`users.remote_egress_ack_at` from
schema v4), chat messages, source upload/reingest, and connector
create/sync return `403 REMOTE_EGRESS_CONSENT_REQUIRED` before any payload
processing. Never weaken or bypass the gate in a handler; loopback and
private providers never gate; acknowledgment unblocks without a restart. The
consent response may name the configured `endpoint_host` to the authenticated
account, but `endpoint_host` must never be logged. Consent-card, sidebar, and
Settings payload-class wording must stay identical.

Canonical operator overrides are `LLM_BASE_URL`, `LLM_API_KEY`,
`LLM_CHAT_MODEL`, and `LLM_EMBED_MODEL`. The corresponding `LITELLM_*` names
remain lower-precedence compatibility aliases only. Do not infer or reintroduce
an intermediary model-proxy process from those legacy environment names.

When a remote provider is configured, ingestion text sent for embeddings,
retrieval queries, prompts, chat history, and selected source/tool context leave
the machine under that provider's data policy. A source need not be attached to
a chat for its ingestion text to be sent. Parsing, DuckDB analytics, embedded
stores, and report rendering remain local. Keep that boundary visible in
Settings and user documentation.

Stable logical aliases live in `server/src/llmAliases.ts`. Outbound chat and
embedding calls resolve known aliases to physical model IDs. Discovery maps
known physical IDs back to aliases, preserves unknown IDs, and hides the
embedding identity from the chat picker. Chat and embedding roles must remain
distinct.

## Electron and packaging

- `desktop/src/main.ts` resolves every durable path under Electron `userData`,
  starts the copied `runtime/server/dist/desktopHost.js` in `utilityProcess`, and
  loads the exact Fastify loopback URL in a hardened `BrowserWindow`.
- Renderer windows use context isolation, sandboxing, no Node integration, deny
  permission requests and arbitrary navigation/popups. The main window may open
  only the controlled `about:blank` report-preview window; that child has an
  empty preload and embeds report HTML in an opaque-origin sandbox. The main
  preload exposes only the one-shot bootstrap operation.
- On quit, main requests orderly backend shutdown. The backend aborts active
  runs, stops ingestion, closes DuckDB, LanceDB, and SQLite, then acknowledges;
  main applies a bounded kill timeout.
- `RENDER_BACKEND=electron` sends bounded self-contained documents to the hidden
  renderer. Browser development and headless server CI use Playwright.
- Rebuild `better-sqlite3`, `@lancedb/lancedb`, and `@duckdb/node-api` for
  Electron's ABI. `desktop/scripts/isolate-native-addons.mjs` copies those
  packages out of the pnpm store and nests each copy's production dependencies
  (for example LanceDB's `reflect-metadata`) before
  `electron-builder install-app-deps`, so the Electron rebuild cannot overwrite
  the server Node bindings and the utility process can resolve modules without
  the pnpm virtual store. Keep native assets unpacked from the application
  archive. Do not workspace-link `borealis-server` into Electron.
- Packaging targets arm64 DMG and ZIP with minimum macOS 13. Signed distribution
  builds use Apple's hardened runtime; version 1 intentionally does not enable
  the Mac App Store sandbox. `package:unsigned` explicitly disables identity and
  notarization, while `package:mac` consumes signing/notarization credentials
  only from the release environment. The latter can succeed without signing or
  notarization when credentials are absent; verify artifacts before distribution.
- `desktop/build/entitlements.mac*.plist` are tracked packaging inputs. Keep the
  root `.gitignore` exceptions for that directory; a clean checkout must be able
  to package without locally generated entitlement files.
- Never copy Playwright's downloaded browser into the packaged application.

## Resource budgets

Upload, message, history, extracted-text, and chunk-count budgets are documented
in `server/.env.example`. Connector, query/extract, chart, report, outbound-web,
render-payload, and tool-duration limits are fixed at their lowest processing
boundary and summarized in `docs/API.md`. Keep over-limit, partial-input,
cancellation, and safe-error tests whenever changing them.

## Before touching sensitive areas

- Read `server/src/data/charts.ts` before changing the chart contract.
- Read `server/src/agent.ts` and `server/src/tools.ts` before changing agent
  behavior.
- Read `server/src/data/datasets.ts`, `datasetsWorker.ts`, and `xlsx.ts` before
  changing data access or file parsing.
- Read `server/src/db/migrations.ts`, the relevant store, and
  `server/src/storageRuntime.ts` before changing durable state.
- Read `server/src/ingest.ts`, `server/src/retrieve.ts`, and their crash/repair
  tests before changing the SQLite/LanceDB protocol.
- Read `server/src/data/playwrightRender.ts`, `server/src/electronRender.ts`, and
  `desktop/src/electronRenderer.ts` before changing static rendering.
- Read `server/src/serverApp.ts`, `server/src/desktopHost.ts`, and
  `desktop/src/main.ts` before changing startup or shutdown.
- Read `desktop/scripts/isolate-native-addons.mjs` and
  `desktop/scripts/copy-runtime.mjs` before changing desktop native isolation
  or the copied runtime.

## End-to-end use case

Run `pnpm --filter borealis-server exec tsx ../data/generate_sample.ts`, upload
the four CSV fixtures, and ask for a personal-finance analysis. Verify that the
agent queries DuckDB, renders charts, and creates a report. Report routes must
return self-contained HTML and a PDF beginning with `%PDF`; chart PNGs must
have the PNG signature. In the desktop build, also verify first-launch
bootstrap, exact loopback/same-origin hosting, offline Electron rendering, and
clean utility-process shutdown.

## Documentation maintenance

Keep [README.md](README.md), [docs/API.md](docs/API.md),
[docs/VISION.md](docs/VISION.md), [desktop/README.md](desktop/README.md),
[server/.env.example](server/.env.example), and
[milestones/](milestones/README.md) aligned with implementation changes. Check
package scripts, route schemas and runtime validation, environment precedence,
resource limits, and verification coverage rather than copying claims from old
plans. Document provider-bound ingestion text as well as chat context when
describing privacy. Root `scripts/policy-check.mjs` is the current
remnant/fixture gate; do not reintroduce `scripts/verify.sh` or per-package npm
lockfiles.

[docs/VISION.md](docs/VISION.md) is the product destination. Update it when the
intended product changes; do not treat it as current architecture or a work
queue. [milestones/](milestones/README.md) is the active implementation ledger.
[plans/](plans/README.md) contains completed historical specifications, not an
active backlog. [docs/cohere-north/](docs/cohere-north/README.md) is dated
product research and proposed designs, not the current Borealis architecture.
Preserve that boundary and do not present historical checklists as current
instructions.

Use `git ls-files` when auditing all tracked docs: ordinary `rg --files` omits
the intentionally ignored, but still tracked, research archive.

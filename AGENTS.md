# Borealis — open-source agentic data workspace

Agentic chat over uploaded documents and tabular data, plus HTML/PDF report
generation. Model calls go directly to LM Studio or another OpenAI-compatible
API.

Repo: `computerbraincompany/borealis` on GitHub (formerly _north-clone_).
Product direction lives in [docs/VISION.md](docs/VISION.md); it is the intended
destination, not a list of current features or an implementation backlog.

## Architecture

- `server/` — Node.js 22 (TypeScript, ESM) Fastify API. It owns authentication,
  account preferences, the agent loop, durable ingestion and chat runs,
  retrieval, libraries, connected agents, analyses, documents, research, reviewed
  briefs, automations, connectors, artifact sharing and audit metadata, reports,
  and static web hosting. Resource routes live under
  `server/src/routes/`; data internals live under `server/src/data/`.
- `server/src/db/` — SQLite migrations, codecs, and async store facades for the
  relational ledger and chunk text. `server/src/storageRuntime.ts` composes the
  SQLite stores with LanceDB.
- LanceDB — vector-only index keyed by stable chunk UUID, account, source, and
  ingestion generation. It never stores passage text.
- DuckDB — analytical engine for user tabular files only, isolated in a worker
  thread. It is not the application ledger.
- `web/` — Vite + React + TypeScript + Tailwind UI. Pages cover auth, chat,
  sources, libraries, agents, analyses, documents, research, review inbox,
  automations, URL connectors, reports, and the
  workspace Settings modal. Browser development proxies `/api` to port 3000.
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

# Browser development; embedded stores need no external database.
# Start the configured model endpoint separately for live inference.
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
pnpm --filter borealis-desktop package:entitlements:smoke

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
Linux CI installs it with `pnpm --filter borealis-server exec playwright install --with-deps chromium`,
sets Electron’s `chrome-sandbox` helper to root-owned mode `4755`, and runs the
gate under Xvfb with `TURBO_CONCURRENCY=2` to avoid oversubscribing the hosted
runner. Keep the Electron sandbox enabled.
`native:smoke` resolves isolated addon production dependencies under Node, opens
SQLite/LanceDB/DuckDB through Electron's ABI, and loads the same addons from an
Electron utility process. `ELECTRON_RUN_AS_NODE` alone is not enough: that path
can still see the pnpm virtual store after isolation. Root `pnpm verify` does
not run `render:smoke`, packaging, signed-release checks, or live-model
analysis. `desktop`'s `verify` adds the GUI PNG/PDF smoke. After packaging,
`package:native:smoke` checks the packaged fuse/ASAR/native/OCR path and
`package:entitlements:smoke` ad-hoc signs disposable hardened-runtime variants,
requiring the exact retained entitlement pair and both negative removals.

Desktop development rebuilds before launch and uses the installed app's default
data directory. Use an absolute `--user-data-dir` argument for an isolated
profile; see [desktop/README.md](desktop/README.md). Browser development loads
`server/.env` when started from `server/`; desktop skips dotenv and owns its
bind, storage, static-UI, and renderer environment values.

## Durable storage

Browser development defaults to `<repo>/.borealis/`. Electron passes exact paths
below `~/Library/Application Support/Borealis/`:

- `borealis.sqlite` — relational ledger and chunk text;
- `lancedb/` — embedding vectors plus the private mode-`0600`
  `.borealis-embedding-index.json` resolved-model/dimension marker and its
  independent first-binding receipt;
- `uploads/` — account/source-scoped input and connector files;
- `reports/` — HTML/PDF artifacts;
- `models/` — verified contained-model downloads;
- `.lancedb-migrations/` and `embedding-migration.json` — private staging and
  aggregate state while a managed embedding migration is active;
- `settings.json` — provider settings, atomically written with mode `0600`;
- `contained.json` — contained-engine configuration, atomically replaced in the
  same directory with mode `0600` (a pre-existing widened mode is repaired);
- `jwt.secret` — generated once with mode `0600`;
- `secrets/` — mode-`0700` account-scoped directories of AES-256-GCM sealed
  connection credential records (mode `0600`, AAD-bound to the exact
  account/connection) for MCP and WebDAV custody; machine-bound and never
  archived;
- `connections.key` — browser-development operator connection custody key,
  mode `0600`; machine-bound and never archived;
- `connection-custody/sealed-key.bin` — desktop-only connection custody data
  key sealed through Electron main's `safeStorage`; the envelope unseals only
  on the same machine's login keychain, and main answers only schema-checked
  `read`/`ensure` custody requests over the utility-process port.

The connected-agent ledger itself stays in SQLite: schema v17 owns the
`connections` rows and published `connection_tool_snapshots`, and schema v21
owns the per-run frozen `chat_runs.agent_mcp_tools` snapshot; only the sealed
credential records and their custody key live outside the ledger.

Environment overrides are documented in `server/.env.example`. A configured
`JWT_SECRET` wins and must be strong. Without one, `config.ts` opens or creates
the secret file without following symlinks and repairs its mode to `0600`.
Configuration import is path-only: server startup must acquire the exact
workspace lock before it creates or canonicalizes any durable directory, opens,
creates, or repairs `jwt.secret`, or initializes Settings/stores. The normal
Electron main process must not pre-create those workspace paths before starting
the backend.

SQLite and LanceDB are one logical store and must be archived/restored together
with Borealis stopped. Prefer the supported offline
`pnpm workspace:archive -- <command>` flow: workspace-touching commands acquire
the exact server instance lock and refuse a live workspace. That lock uses a
persistent private mode-`0700` namespace with atomically published,
never-reused mode-`0600` owner records; preserve its fail-closed identity and
process-liveness checks. Encrypted archives hash and verify the complete pair
plus ready tabular artifacts and every artifact tree in the stopped root —
including the `reports/documents/` publication namespace and knowledge refresh
staging under `uploads/` — while intentionally excluding the machine-bound
`secrets/` credential namespace and `connections.key` (those two names are
never archived and may never be named as relocated additions). Because custody
never ports, restore transitions every previously `ready` MCP or knowledge
connection to `disconnected` with an actionable code
(`CONNECTION_RESTORE_RECONNECT_REQUIRED`, `KNOWLEDGE_RESTORE_RECONNECT_REQUIRED`,
or `KNOWLEDGE_FOLDER_RESELECT_REQUIRED`), clears WebDAV
`credential_configured`, and rebases the new document-publication and
knowledge-staging path columns; nothing else is discarded. The manual fallback is a complete
stopped-directory copy, including SQLite WAL state, uploads, reports,
contained-model state, settings, migration state, and the signing secret;
include any intentionally relocated paths explicitly (custody material is a
deliberate exception: never copy it between machines). Never present either
method as a live backup.
Offline archive verification must open the existing Lance table without
creating one. It may accept a valid dimension-matching first-binding receipt
when marker publication was interrupted, but must remain read-only; exact-model
runtime startup alone republishes that matching marker.

## Data flow

1. Uploaded files land in UUID-scoped
   `uploads/<account-id>/<source-id>/` directories. SQLite records the source and
   durable ingestion job. Workers extract within configured budgets, assign
   stable chunk UUIDs, stage text in SQLite and vectors in LanceDB, then promote
   one generation using the two-store protocol.
2. `POST /api/chats/:id/messages` commits the user message, model, source mode,
   concrete ready source IDs, bound-agent instruction revision, and durable run
   in one SQLite transaction. It then streams sanitized SSE events from
   `server/src/agent.ts` for at most sixteen tool rounds plus one reserved final synthesis call. One active run is allowed
   per chat; deletion of the run requests cancellation. Activity events arrive
   during execution, but the answer's `delta` is sent as a complete string after
   persistence, not token by token.
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
   `version` = newest _published_ report for that chat plus 1 and records
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
- Protected-route authentication belongs in Fastify's `onRequest` phase before
  JSON or multipart parsing. The global 8 KiB fail-safe and every larger
  schema-derived route body ceiling are security boundaries; unauthenticated
  malformed or oversized bodies must still return `401` without parser, store,
  or handler work.
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
  boundary. The query deadline begins before scoped-catalog acquisition and
  trusted-file loading, covers lexical/native preflight and result
  materialization, and cancellation interrupts the active DuckDB connection;
  every exit must release prepared statements, mutexes, leases, readers, and
  timers.
- XLSX ingestion is offline and bounded: ZIP member and expansion checks precede
  the streaming ExcelJS first-sheet reader. Legacy `.xls` and `.doc` inputs are
  unsupported. Never add npm `xlsx` or enable DuckDB extension auto-install.
- PDF OCR is local macOS PDFKit/Vision fallback only for pages without embedded
  text. Keep page/raster/observation/character/time/output limits at the helper
  boundary, preserve partial text-PDF success, and copy the fixed JXA helper as
  a physically unpacked packaged runtime asset. It must never gain network or
  renderer privileges.
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
- Connected agents (`server/src/connections/`, `server/src/mcp/`, routes in
  `server/src/routes/connections.ts`) freeze one per-run MCP binding map in
  `chat_runs.agent_mcp_tools` (schema v21) inside the accept transaction: a
  deterministic `mcp_<32 hex>` alias, the captured discovery descriptor, and
  a non-secret `authorization_reference` (`absent`, or an `oauth:`/`secret:`
  custody digest that excludes volatile token entries). Tokens, endpoints, and
  credential values never enter the ledger, DTOs, SSE, agent revisions, or run
  metadata. Dispatch re-checks connection existence, enablement, and live
  custody against the captured reference before every call — revocation or
  credential replacement blocks the next call while the turn continues — and a
  failed call reaches the model only as a stable `CONNECTION_*` code.
  Arguments validate against the frozen captured schema under a 30-second tool
  deadline inside the run budget with 32 KiB/64 KiB argument/result ceilings,
  and non-text content is reported, never auto-fetched. Selection defaults
  write-oriented tools to deny (conservative `agentConfiguration.ts`
  classifier; explicit `allow_write` acknowledgement required; a server's
  `readOnlyHint` is never trusted). The MCP client registers no sampling,
  roots, elicitation, or delegation capabilities, and reserved `MCP_OAUTH_*`
  custody entries never enter a stdio child environment. Custody is one
  injectable interface: browser development uses `secrets/` records
  AES-256-GCM-sealed by `connections.key`; packaged desktop answers only
  schema-checked `read`/`ensure` custody requests with main's
  `safeStorage`-sealed key (no list, no per-record crypto); missing custody is
  always an actionable disconnected state, never plaintext and never a crash.
  OAuth is authorization-code with PKCE/S256, one-use state, a five-minute
  window, and RFC 8707 resource binding through the SDK 1.30.0 auth layer
  (negotiated protocol `2025-11-25`); the only callback surface is the
  backend-owned loopback `GET /callback` listener (no session credentials, no
  reflection, replay-refusing), and desktop reaches it from the system browser
  only through the one-time open-intent flow.
- Schema v12 owns the current keyset-catalog indexes. Schema v13 adds agent identity,
  versioned capability configuration, skills, and accepted-turn tool snapshots,
  ahead of the remaining remediation work by the September 5 sequencing decision. Schema
  v14 ships provider-bound remote-egress consent: one nullable
  `users.remote_egress_ack_origin` column holding only the canonical bare remote
  origin, bounded by a column CHECK to the Settings endpoint ceiling, with no
  backfill (timestamp-only rows are intentionally unacknowledged). Schemas v15
  and v16 ship automation target ownership and typed connector-refresh/repair
  state. Product migrations v17–v28 follow that contiguous applied history;
  never reuse, reorder, or edit those migrations. Account catalogs use opaque endpoint-bound
  keyset cursors, while source/connector transition polling uses only bounded
  exact-ID status batches with non-starving round-robin reconciliation.
- Web asynchronous surfaces must give each load/mutation an exact target plus
  request generation and, where supported, an `AbortController`; stale success,
  error, loading, navigation, and finalizer effects cannot mutate a newer or
  closed target. A create/rename dialog whose failure slot or committed row
  would go invisible when dismissed must block dismissal while its request is
  in flight (the `ConfirmDialog` busy pattern); dialogs that re-fetch
  authoritative state on open may close mid-flight. A local delete must bump the
  catalog request generation before filtering, so a still-in-flight list
  response cannot resurrect the deleted row (as in `AgentsView`). Unexpected
  React `act` warnings fail the shared test harness.
- Shell `main` is `overflow-hidden`, so every page view root owns its own scroll
  (`h-full overflow-y-auto` around the `mx-auto max-w-5xl …` content wrapper).
  The source ingestion status label/tone comes only from
  `web/src/lib/sourceStatus.ts` — never hand-render the `ready|index|error` enum
  per surface. Long-running status polls (contained engine, embedding
  migration) must be visibility-aware and widen their interval on consecutive
  failures rather than hammering a failing endpoint.
- Noninitial routes and ECharts stay lazy. The Vite manifest/bundle gate enforces
  the committed 240 KiB initial-gzip and 130 KiB maximum-lazy-gzip budgets plus
  separate route/chart entries; packaged static hosting must copy and serve the
  complete content-hashed lazy graph from the exact loopback origin.
- Small-team surfaces (schema v7–v9) stay inside the local trust boundary:
  report shares link sibling accounts of one instance and grant exactly
  read-only detail/HTML/PDF access with owner-only revoke — the stored
  normalized payload never leaves the owner's detail route; egress audit
  events (`server/src/egressAudit.ts`) are content-free, best-effort, and
  never logged; automations (`server/src/automationStore.ts`,
  `automationRunner.ts`) reuse the consent gate and one-run-per-chat
  constraints — `connector_sync` creation/update gate the mutation and
  scheduled executions recheck consent like agent turns — record bounded
  generic run details, pause after five consecutive failures, and their
  scheduler is unref'd and stopped during orderly shutdown.
- Connector schedules are a derived convenience surface over `connector_sync`
  automations (at most one per connector, enforced in the automation store);
  the Automations view stays authoritative. Connector deletion cascades the
  linked automations and sync-history rows; history entries are content-free
  and best-effort, never load-bearing.
- Agents (`server/src/db/stores/agentStore.ts`, schemas v6 and v13) are named,
  versioned instruction sets. The chat binding is write-once at creation
  (`chats.agent_id`, `SET NULL` on agent deletion) and cannot change
  afterwards. `acceptChatTurn` snapshots the agent's current revision onto
  `chat_runs.agent_instructions` inside the accept transaction, so later
  edits or deletion never change a running turn. Instructions are bounded at
  8,000 characters and appended to the system prompt only through
  `agentSection` in `server/src/agent.ts`, which must keep the
  fixed-workspace-policy sentence. Agent capability selections can restrict the
  built-in tool set; instruction text never changes retrieval scope or authorization.
  Selected skill contents and tool allowlists are captured at turn acceptance,
  with a 32,000-character combined prompt budget. Instruction text is never logged.
  Job output templates support compatible `instruction` text and a `template_id`
  reference to a built-in or account-owned M13 template. Agent save and turn
  acceptance resolve only the template structure inside the SQLite transaction;
  the 8,000-character template and 32,000-character combined prompt ceilings
  remain enforced. The accepted `agent_instructions` snapshot is immutable;
  missing/deleted/foreign templates block later acceptance without rewriting
  earlier runs. Template choice adds no sources, tool permissions, or publication.
- Research (`server/src/researchRunner.ts`, schema v25) pins source generations
  and captures evidence before synthesis. Typed non-null comparison cells must
  cite captured evidence from the same row source; an uncited output is retained
  as `invalid`, never presented as supported. Human corrections overlay immutable
  machine values. Model calls receive at most 8,192 output tokens with the
  existing separate content/reasoning caps; the run still permits at most 40
  model requests and 15 minutes. Missing summaries, unsupported cells, and
  exhausted budgets produce honest `needs_review` with retained partial work.
- The OpenAI Node client defaults embeddings to base64 and decodes responses.
  Compatible local runtimes return float arrays, so `server/src/llm.ts` must
  continue sending `encoding_format: "float"` explicitly.
- Model qualification must exercise bounded streaming SSE through the same
  tool-call accumulator and call-ID/name validation as real turns, with its
  stricter one-call and 256-character synthetic-argument budgets.
  Qualification, ingestion, migration, Lance upsert, and Lance search must all
  normalize vectors at the finite-positive float32 accumulated squared-norm
  boundary; a finite JavaScript number alone is not a usable cosine vector.
- Agent tools are wired through `TOOL_DEFS` in one streaming loop. Never expose
  provider reasoning, raw tool payloads, or exceptions in SSE. The UI receives
  only stable server-defined summaries.
- Model resolution precedence for new chats: the composer's explicit choice,
  else the account's `default_chat_model` (schema v11), else the workspace
  `default_model`. The model of an existing chat never changes implicitly.
  New web chats still start selected-empty — that fail-closed scope default
  is an invariant, not a preference.
- Citation metadata (`server/src/citations.ts`) is derived only from the run's
  own sanitized evidence array; the 1-based evidence position is the citation
  number. Markers that do not resolve stay plain text in the UI, and passages
  dropped by the evidence cap carry no number and must never be citable.
- `makeReportPayload` keeps its 12-character chart-ID prefix fallback because
  models can garble long UUIDs. Report normalization strips inline
  `chart:`/`:::` tokens.
- Once the live fixed-schema vector index exists, changing the embedding model
  or dimension is always a managed workspace migration, not a Settings toggle
  or per-source reingest. Generic `PATCH /api/settings` must reject an embedding-
  identity change with `EMBEDDING_REINDEX_REQUIRED`, including in an empty
  workspace. Qualify the target pair, build and verify a separate LanceDB index
  from one immutable SQLite generation snapshot, then request live apply. Hold
  chat/source admission, drain durable and in-process active turns (bounded to
  60 seconds), close only vector handles, revalidate provider identity and
  environment precedence, perform the journaled swap, reopen vectors and replace
  the ingestion lifecycle/cache, verify row/dimension counts, and run a scoped
  retrieval smoke when the snapshot is nonempty. Keep SQLite/server open; restore
  the old pair on failure. Startup still recovers interrupted journaled swaps. A zero-source workspace uses the same
  managed path with a verified zero-row target index; never delete only the
  vector index or expose mixed embedding identities. Migration start
  uses the persisted provider, credential, and chat-model settings; the UI must
  gate mixed unsaved drafts rather than qualify one provider revision and build
  against another. Migration admission must reread and match the exact qualified
  baseline/target snapshot before it writes durable state.
  Each Lance directory records the resolved outbound model ID and dimension in
  `.borealis-embedding-index.json`; startup and every staged/live/backup
  migration phase must validate it, including for same-dimension model changes.
  An independent binding receipt makes first publication durable: only that
  exact receipt may repair a missing marker, while corruption, disagreement,
  or identity drift fails closed and cannot reopen adoption. Model-less offline
  verification may accept a valid dimension-matching receipt-only publication
  crash read-only; exact-model startup performs the repair.
  A populated staged migration index is never eligible for legacy adoption;
  build resume and every startup swap phase require its marker or exact receipt.
  A populated pre-marker index may be adopted only by the explicit one-release
  legacy policy (persisted Settings or pinned defaults, no embedding environment
  override); ambiguous identity fails closed. Offline verification must never
  create a missing Lance table.
  `LLM_EMBED_MODEL` and `EMBEDDING_DIM` remain higher-precedence operator
  overrides and disable the corresponding Settings-managed migration.

## Model endpoint and Settings

Settings persist the OpenAI-compatible endpoint, optional API key, optional
distinct LM Studio health endpoint, and default chat/embed model IDs. They are
process-wide, shared by all authenticated accounts. The key is stored as text in
the mode-`0600` settings file; public responses expose only a configured boolean.
The local endpoint default is `http://127.0.0.1:1234`; endpoints other than loopback and `.local` hostnames
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

Contained-model invariants (`server/src/contained/`): the engine binds
loopback only and is spawned with the llama-server arg contract; its output is
never read or logged. Auto-apply switches the provider origin only through the
live settings store, never when `LLM_BASE_URL` is environment-managed, and
always restores the prior origin on stop. Downloads require SHA-256
verification before atomic rename; `.part` artifacts never count as model
files. Engine stop is part of the orderly shutdown path (`closeDb`).
`contained.json` is replaced by a same-directory atomic rename that keeps mode
`0600` and repairs a pre-existing widened mode; spawn failures reach the
child-process `error` listener and land in the bounded `crashed` state, and
missing-path diagnostics are deterministic (binary before model). The Settings
→ Local engine panel owns configuration, verified downloads, and engine
start/stop through `containedApi`.

The ambient chrome strip is fed by `GET /api/status`
(`server/src/workspaceStatus.ts`). Keep its probe body-free, bounded, and
redirect-refusing via `server/src/endpointProbe.ts`; the response carries
locality (`local`/`private`/`remote`), reachability, and configured chat/embed
model IDs, and must never include the endpoint URL, credentials, provider
errors, or model lists. The strip is informational chrome, not an
authorization surface, and its egress wording must stay consistent with the
Settings privacy text.

Remote model-provider egress is fail-closed and provider-origin-bound
(`server/src/egressPolicy.ts`): consent is the account's durable
timestamp/canonical-origin pair (`users.remote_egress_ack_at` plus schema v14's
`users.remote_egress_ack_origin`), and while the configured provider's canonical
origin is not exactly that pair, chat messages, source upload/reingest, and
connector create/sync return `403 REMOTE_EGRESS_CONSENT_REQUIRED` before any
payload processing. Acknowledgment writes the pair atomically; consent for one
remote origin never authorizes another, changing remote origins requires consent
again, and timestamp-only pre-v14 rows are intentionally unacknowledged until
re-consent. The stored origin is never returned publicly: `GET
/api/consent/remote-egress` keeps its `{required,acknowledged_at,endpoint_host}`
shape, where `acknowledged_at` is non-null for a remote provider only when the
pair names that exact origin. Never weaken or bypass the gate in a handler;
loopback and private providers never gate; acknowledgment unblocks without a
restart. The consent response may name the configured `endpoint_host` to the
authenticated account, but no endpoint URL or host may be logged, and no audit
helper may re-read live Settings — audit uses the host of the exact authorized
target. Consent-card, sidebar, and Settings payload-class wording must stay
identical.
Ordinary account-owned workspace-content model traffic (chat, title, retrieval
query embeddings through `server/src/llm.ts`) captures `getRuntimeSettings()`
exactly once, authorizes that revision's credential-free target against the
account's pair, and transports through the client built from that same snapshot;
a later Settings edit cannot retarget an authorized in-flight call, and the next
capture sees the new origin. Plan 034's request-local draft acknowledgment
authorizes only its fixed synthetic qualification probes and is never durable
workspace consent. Model discovery stays body-free and ungated.
Durable ingestion must also recheck the exact account against that exact origin
immediately before its first embedding transport and bind every batch (parsed
and OCR text alike) to that one authorized immutable runtime-settings snapshot.
A queued local job resumed under an unacknowledged remote provider makes no
transport call and records `REMOTE_EGRESS_CONSENT_REQUIRED`; a mid-job Settings
edit must not redirect it. Managed embedding migration checks every affected
account's pair against the exact target origin at start/retry admission and
immediately before each provider batch, persisting only the stable aggregate
code, and scheduled `connector_sync` runs gate before connector lookup,
reservation, or download.
The three surfaces use the shared `web/src/lib/egressDisclosure.ts` payload-class
constant. Preserve that shared wording.

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
  preload exposes exactly three narrow operations: the one-shot bootstrap
  (`borealisDesktop.consumeBootstrap`); the M14 selected-folder chooser
  (`chooseFolder`), which returns an opaque `{grant_id,label,preview}` and
  never a path, listing, read, or general IPC, with main forwarding the
  resolved canonical root to the backend grant registry over the private
  utility-process channel only; and the Connected-agents sign-in opener
  (`openSignInLink`), which opens the system browser only for an exact URL
  paired with the one-time intent token the backend minted for it — main
  verifies-and-consumes that token with the backend over the utility-process
  channel before `shell.openExternal` ever runs, so a renderer cannot open an
  arbitrary URL. There is no path, directory-listing, file-read, or general
  IPC surface.
- On quit, main requests orderly backend shutdown. The backend aborts active
  runs, stops ingestion, and joins knowledge preview/refresh/watch abort
  finalizers before closing DuckDB, LanceDB, and SQLite, then acknowledges;
  main applies a bounded kill timeout. HTTP drain must close keep-alive sockets
  that become idle after an admitted request completes, without interrupting
  its response. Clearing watch timers alone is not a drain: pending catalog
  scans and refresh promises must settle before storage closure.
  Brief narrative cancellation uses the execution's own abort signal, including
  SDK `APIUserAbortError`; shutdown preserves its committed stage for resume,
  while requested cancellation and deadlines keep their distinct outcomes.
- `RENDER_BACKEND=electron` sends bounded self-contained documents to the hidden
  renderer. Browser development and headless server CI use Playwright.
- Production fuses must keep `RunAsNode`, `NODE_OPTIONS`, inspector arguments,
  browser-process V8 snapshots, and extra `file:` privileges disabled while
  requiring cookie encryption, embedded-ASAR integrity, ASAR-only loading, and
  WebAssembly trap handlers. The utility process receives only the positive
  environment allowlist plus shell-owned exact runtime paths; packaged smoke
  must fail closed on any unreviewed fuse.
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
  to package without locally generated entitlement files. The current exact
  retained pair is `allow-jit` plus `disable-library-validation`; the tracked
  entitlement matrix must prove the positive pair and fail when either key is
  removed.
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

The selected September 6 functional wave is specified in
[docs/DEVELOPMENT_HANDOFF.md](docs/DEVELOPMENT_HANDOFF.md),
[docs/MCP_CONNECTIONS.md](docs/MCP_CONNECTIONS.md), and milestones M12–M16.
The runtime implements these contracts across schema v17–v28 after the real
v14–v16 prerequisite migrations. The handoff records that scope, coordination
rules, and the narrow desktop capability boundaries. Keep
[milestones/EXECUTION.md](milestones/EXECUTION.md) and
[docs/END_TO_END_ACCEPTANCE.md](docs/END_TO_END_ACCEPTANCE.md) aligned with actual
implementation and evidence. Do not claim completion from specification-only
changes or skip required packaged/live-model validation.

Keep [README.md](README.md), [docs/API.md](docs/API.md),
[docs/VISION.md](docs/VISION.md), [desktop/README.md](desktop/README.md),
[server/.env.example](server/.env.example), and
[milestones/](milestones/README.md) aligned with implementation changes. Keep
[advisor-plans/](advisor-plans/README.md) current as its remediation work lands.
Check package scripts, route schemas and runtime validation, environment
precedence, resource limits, and verification coverage rather than copying
claims from old plans. Document provider-bound ingestion text as well as chat
context when describing privacy. Root `scripts/policy-check.mjs` is the current
remnant/fixture gate; do not reintroduce `scripts/verify.sh` or per-package npm
lockfiles.

[docs/VISION.md](docs/VISION.md) is the product destination. Update it when the
intended product changes; do not treat it as current architecture or a work
queue. [milestones/](milestones/README.md) is the active implementation ledger.
[advisor-plans/](advisor-plans/README.md) is the separate active
engineering-remediation ledger from the 2026-08-30 audit.
[plans/](plans/README.md) contains completed historical specifications, not an
active backlog. [docs/cohere-north/](docs/cohere-north/README.md) is dated
product research and proposed designs, not the current Borealis architecture.
Preserve those boundaries and do not present historical checklists as current
instructions.

Use `git ls-files` when auditing all tracked docs: ordinary `rg --files` omits
the intentionally ignored, but still tracked, research archive.

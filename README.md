# Borealis ⚡

_Borealis — after the Aurora Borealis, the northern lights. A free and
open-source agentic workspace for grounding chat and reusable agents in documents
and tabular data, then turning answers into durable charts and reports._

Borealis accepts CSV, TSV, XLSX, Parquet, JSON, JSONL, PDF, DOCX, TXT, Markdown, and
bounded public URL connectors. Its agent can retrieve evidence, query tabular
sources with SQL, render charts, and assemble reports. Model calls go directly
to LM Studio or another OpenAI-compatible endpoint.

## Documentation

| Guide                                        | Contents                                                                    |
| -------------------------------------------- | --------------------------------------------------------------------------- |
| [This README](#desktop-app)                  | Setup, model configuration, daily use, verification, and workspace archives |
| [Product vision](docs/VISION.md)             | What Borealis is becoming: local data intelligence as a desktop platform    |
| [API reference](docs/API.md)                 | REST endpoints, SSE events, lifecycle, errors, and resource limits          |
| [Desktop guide](desktop/README.md)           | Development profiles, native modules, packaging, signing, and smoke checks  |
| [Contributor instructions](AGENTS.md)        | Architecture, commands, and security invariants                             |
| [Configuration example](server/.env.example) | Optional environment overrides, defaults, and valid ranges                  |
| [Milestones](milestones/README.md)           | Active implementation ledger toward the product vision                      |
| [Functional product review](docs/PRODUCT_REVIEW.md) | Current capability gaps, North/Portable Computer comparison, and roadmap rationale |
| [Advisor plans](advisor-plans/README.md)     | Active engineering-remediation ledger from the 2026-08-30 audit             |
| [Coding-agent handoff](docs/DEVELOPMENT_HANDOFF.md) | Selected scope, implementation specs, dependencies and completion rules |
| [End-to-end acceptance](docs/END_TO_END_ACCEPTANCE.md) | Required browser, packaged desktop and live-model proof for the selected wave |

[Milestones](milestones/README.md) are the active product implementation ledger
toward the vision. [Advisor plans](advisor-plans/README.md) track the separate
active engineering-remediation audit. [Completed implementation
plans](plans/README.md) and the dated [product research
archive](docs/cohere-north/README.md) preserve historical decisions and
proposals; they are not current setup instructions or a list of unimplemented
requirements.

The completed baseline is M01–M11 plus the agent-editor foundation and later
bounded extensions. MCP/OAuth remains pending. The
[selected functional wave](milestones/README.md#selected-functional-wave)
specifies connected agents, saved analyses, editable reports, living libraries,
scoped research, and reviewed recurring briefs for implementation. These are
not shipping features. Coding agents should start with the
[development handoff](docs/DEVELOPMENT_HANDOFF.md) and keep
[execution evidence](milestones/EXECUTION.md) current.

## Architecture

```text
desktop/    Electron shell for Apple Silicon macOS 13+
web/        React + Vite UI: chat, sources, libraries, agents, automations,
            connectors, reports, and Settings
server/     Fastify API, agent loop, ingestion, retrieval, and rendering
data/       deterministic personal-finance fixtures
```

Install once from the repository root with pnpm. The root `preinstall` script
rejects npm. Turborepo runs package `dev` and `build` graphs; the complete
repository gate is the root `pnpm verify` script. Do not install `server`,
`web`, or `desktop` as separate npm trees.

The durable store is deliberately split by job:

- SQLite stores account preferences, chats and runs, sources and jobs, libraries,
  agents, automations, artifact metadata, shares, audit receipts, and chunk text.
- LanceDB stores scoped embedding vectors for retrieval.
- DuckDB runs bounded analytical SQL against uploaded tabular data.
- The filesystem stores uploads, reports, contained-model configuration and
  downloads, provider settings, and the generated JWT signing secret.

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
  models/
  .lancedb-migrations/
  embedding-migration.json
  settings.json
  contained.json
  jwt.secret
```

The JWT secret is generated once with mode `0600`; provider settings and
contained-engine configuration are written by same-directory atomic replacement
with mode `0600`. Replacing contained configuration also repairs a pre-existing
widened mode. No `.env` file is required.

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
`pnpm exec turbo run package:mac --filter=borealis-desktop` and need a Developer
ID Application certificate plus notarization credentials supplied only in the
release environment; certificates and credentials must never be committed. See
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
remote OpenAI-compatible provider under **Settings → Provider**. Agents with enabled tools need
**native** tool calling: a model that answers tool calls as plain text (for
example `Action: list_sources()`) cannot drive the loop — pick a model whose
runtime emits OpenAI `tool_calls`. The same provider
origin serves `/v1/models`, `/v1/chat/completions`, and `/v1/embeddings`; the
optional LM Studio URL is only a separate health probe, not an embedding endpoint.
Local defaults are:

- endpoint: `http://127.0.0.1:1234`
- chat model: `qwen-chat`
- embedding model: `nomic-embed`
- embedding dimension: `768`

Settings separates **Provider**, **Chat models**, **Embeddings**, and **Local engine**.
Chat and embedding models use provider-discovered dropdowns with full model names.
In Embeddings, **Check model** detects the dimension automatically from a validated
response; no dimension entry is needed. It checks embeddings before chat compatibility
and reports timeouts separately. After a successful check, **Save and rebuild search**
starts the managed index rebuild. Once it is ready, choose **Apply now** to activate the new embedding model without restarting.
Drafts remain when switching panels; saving or discarding affects only the current
panel. Provider and chat changes must be saved or discarded before embedding
qualification and migration. Personal chat-model overrides remain in **Account**.

The contained-mode backend is an authenticated, API-driven local path beside
those options. Point Borealis at a `llama-server` binary and model file (which
it can download and SHA-256-verify into the app's own data directory), then use
the [contained-model API](docs/API.md#contained-models) to start and stop the
engine. Borealis health-checks and stops that process as part of the workspace,
switches the provider to its loopback origin, and restores whatever was there
before. **Settings → Local engine** provides the contained setup and lifecycle
controls — configuration, verified downloads, and engine start/stop with live
state. When the endpoint is managed by an environment override, Borealis
reports the stand-down instead of overriding it.

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
draft, reading the response body, or running chat/embedding inference.
**Qualify pair** goes further: it sends fixed synthetic, content-free chat/tool
and embedding requests. The chat check uses bounded streaming SSE and the same
tool-call accumulator as a real turn, requiring one bounded call ID, the exact
tool name, and valid JSON arguments. The embedding check requires the configured
dimension and a finite positive norm after float32 coordinate, square, and
accumulation rounding—the numeric contract LanceDB cosine search actually uses.
Qualification does not save the draft or authorize later work. A remote draft
requires a separate acknowledgment bound to that draft's canonical origin.
Editing any endpoint, key, model, or dimension field invalidates the displayed
result. Use **Save changes** to apply compatible changes to subsequent model
operations without a restart.

The workspace sidebar always shows where inference runs — **On this Mac**,
**Private network**, or **Remote provider** — together with endpoint
reachability and the configured chat model. When a remote provider is
configured, the sidebar keeps a standing disclosure that the upload and
ingestion text, prompts, chat history, retrieval queries, and selected tool
context leave the machine under that provider's policy, linking to Settings.
The snapshot comes from the
authenticated `GET /api/status` endpoint and never contains the endpoint URL,
key, provider errors, or model lists.

Remote egress is intended to be fail-closed: before the first chat turn, source
upload or reingest, or connector creation, manual sync, or schedule change
against a remote provider, Borealis stops with a consent card naming the
current destination host and payload classes. The acknowledgment is per
account, not per host, and remains stored across provider changes; switching to
a local provider makes the gate inapplicable immediately. `connector_sync`
automations are part of the same fail-closed boundary: creating or changing one
requires the same acknowledgment, and a scheduled run without it is recorded as
skipped rather than executed against the provider.

Ingestion is durable, so the worker also checks consent immediately before its
first embedding call. It captures one provider/model snapshot for the whole
job: a job queued while local but resumed after an unacknowledged remote switch
makes no provider request and ends with
`REMOTE_EGRESS_CONSENT_REQUIRED`, while a permitted job cannot be redirected to
a different provider between embedding batches by a concurrent Settings edit.

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

Once the live fixed-schema vector index exists, a normal Settings save cannot
change the embedding model or dimension: the API returns `409
EMBEDDING_REINDEX_REQUIRED`, even when the workspace has no sources. Use the
managed embedding migration in **Settings → Embeddings** instead. Borealis qualifies
the target pair against the persisted provider, credential, and chat model
settings and rechecks that exact baseline/target snapshot when start is
admitted. It then freezes one source/generation snapshot, builds and verifies a
separate LanceDB index, and keeps retrieval on the old model/index while the
build runs.
Every LanceDB directory carries a private
`lancedb/.borealis-embedding-index.json` marker containing the resolved outbound
model ID and dimension, plus an independent private binding receipt that records
that first publication. Startup therefore rejects a different same-dimension
model as well as a dimension mismatch. If marker publication was interrupted or
the marker is later missing, only the exact matching binding receipt can repair
it; corrupt or mismatched identity files fail closed and cannot reopen adoption.
Aliases that resolve to the same physical model remain equivalent. New and empty
indexes bind automatically. A populated pre-marker
index has a one-release trust-on-first-upgrade path only when the identity comes
from loaded persisted Settings, or the pinned legacy defaults, with no embedding
environment override; ambiguous legacy identities fail closed and must not be
guessed.
Save compatible provider-draft changes before starting; the migration never
mixes an unsaved endpoint, key, or chat model into its target. The same path
creates and verifies an empty target index for a zero-source workspace. Source
uploads, reingestion, connector changes, and scheduled connector refreshes pause
for the operation. Applying the verified index enters `apply_pending`. Borealis pauses admission,
waits up to one minute for active chats to finish, and performs the journaled
swap while keeping the server and SQLite database open. It revalidates provider
identity and environment overrides, opens the replacement vector index, checks
dimension and row counts, and runs a scoped retrieval smoke before retiring the
old index. If chats are still running after one minute, the index stays ready
to apply and you can try again. Failed installation restores the old pair;
startup recovery also handles an interrupted swap. Status remains content-free, exposing the target
identity, phase, aggregate counts, stable failure code, and available actions;
failed builds can be retried or cancelled before apply. `EMBEDDING_DIM` remains
a higher-precedence operator override; an environment-managed model or
dimension cannot be migrated in the UI. Never delete only the vector directory
as a reset.

When a remote provider is configured, source text sent for embeddings during
ingestion, retrieval queries, prompts, chat history, and selected source/tool
context leave the machine under that provider's data policy. Uploading a source
can therefore send text for embedding even before it is attached to a chat.
Source parsing, analytical SQL, the durable stores, and report rendering remain
local. Remote provider URLs must use HTTPS; plain HTTP is accepted only for
validated loopback origins and `.local` hostnames.

## Browser development

Start the model endpoint separately, then run:

```bash
pnpm install
pnpm dev
```

Turborepo starts the API at `http://127.0.0.1:3000` and Vite normally on port 5173. Open Vite's printed local URL (normally `http://localhost:5173`). Ctrl-C
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
existing text first. On macOS, pages without meaningful embedded text can then
use local Vision/PDFKit OCR through a fixed, network-free helper. The bounded
classifier considers page size, text geometry, interior glyphs, words, and
density so a sparse footer or watermark does not hide scanned content; genuine
text pages are not re-OCRed. OCR is bounded by page, raster, observation,
character, and time budgets, and other server platforms report a stable
unavailable result for a fully image-only PDF. Uploads default to 25 MiB;
parsing and output have additional bounds documented in the [API
reference](docs/API.md).

New UI chats start with no sources. Select particular sources or choose **All
sources** to include current and future sources for each new turn. An empty
selection means no stored data; only ready sources are included in a turn's
fixed snapshot. Uploads are processed asynchronously, so wait for **ready**
before asking about them. Failed sources show a safe explanation and a **Retry**
action. Tabular retrieval uses a bounded row preview; ask quantitative questions
through SQL so the agent can query the full registered table.

**Connectors** import public CSV or JSON URLs and support both **Sync now** and a
refresh schedule (Off / 15 min / hourly / 6 hours / daily). Schedules are backed
by the same `connector_sync` automation rows shown in **Automations** — one per
connector, deleted with the connector. The card also shows a content-free sync
history (trigger, outcome, time). Private/loopback URLs, URL credentials, and
arbitrary request headers are unsupported. The separate chat `fetch_url` tool
can fetch only public URLs explicitly written in the current message.

Answers can show retrieved passages, charts, and saved query-result previews.
Passages are retrieved with stable citation numbers, so grounded claims carry
clickable `[n]` chips that open the evidence panel and highlight the supporting
passage; markers that do not resolve stay plain text. **Download CSV** exports
the saved preview, not an unlimited rerun of the SQL.
Open generated HTML/PDF from chat or **Reports**. Reports keep per-chat
versions with a supersedes chain, can be renamed in place, and the Reports
surface lists the account's chart artifacts. **Libraries** group sources into
named, account-scoped collections you can curate and attach to a new chat as
an explicit selected scope — from the Libraries surface or directly in the
chat composer's source picker, which expands a library's ready members into
the chat's selection at attach time. **Agents** use a shared create/edit modal with a name, description, icon, color,
system prompt, reusable Markdown skills, and individual built-in tool controls.
Bind an agent when creating a chat; edits apply to its next message while running
messages retain their original configuration. Source scope and account
authorization remain enforced. MCP connections and OAuth are not implemented yet;
see the [agent rollout plan](docs/AGENT_EDITOR_ROLLOUT.md). Each account can set a **personal
default chat model** in Settings → Account; new chats start from it and fall
back to the workspace default when it is unset. For small teams on one Borealis
instance, reports can be shared with sibling accounts as read-only snapshots,
Settings shows a best-effort, content-free activity log for consent and selected
remote-capable operation attempts, and **Automations** run scheduled connector
refreshes and chat digest turns — five consecutive failures pause them.
Shares grant recipients read-only detail/HTML/PDF access (the stored payload
stays owner-only), and `connector_sync` automations apply the same
remote-egress consent gate as human connector actions. The
[API reference](docs/API.md#workspace-audit-shares-and-automations) records
the full sharing, audit, and automation contracts. Chat history supports title
search, rename, and deletion; Open **Settings** from the account menu for system readiness,
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
**Settings → System** (authenticated `GET /api/health`) and **Provider**, then:

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

It runs the policy/fixture gate, then each workspace package's available
typecheck, lint, format, test, integration, build, and native-smoke tasks. The web
build also validates its Vite manifest, lazy route/chart split, and committed
gzip budgets. Desktop
`native:smoke` resolves isolated addon production dependencies under Node, opens
SQLite/LanceDB/DuckDB through Electron's ABI, and loads the same addons from an
Electron utility process. Root `pnpm verify` does not run the GUI renderer
smoke or the packaged fuse/ASAR check. CI additionally packages the unsigned
arm64 DMG and ZIP on an Apple Silicon runner; run
`pnpm --filter borealis-desktop package:native:smoke` against that package to
inspect fuses/ASAR integrity, exercise native addons through the packaged
executable, and recognize a generated one-page PDF through the physically
unpacked JXA helper and macOS PDFKit/Vision.
For a disposable ad-hoc hardened-runtime matrix over that packaged app, run
`pnpm --filter borealis-desktop package:entitlements:smoke`; the retained
`allow-jit`/`disable-library-validation` pair must pass, and removing either one
must fail the same packaged native/OCR smoke.

The gate uses fixtures and provider mocks; it does not run live-model analysis,
desktop first-launch interaction, or a signed release check. Perform the manual
flow above when validating a provider or an end-to-end release.

On macOS, also run the renderer and packaged-native checks when changing the
desktop shell or packaging inputs:

```bash
pnpm --filter borealis-desktop verify
pnpm package:unsigned
pnpm --filter borealis-desktop package:native:smoke
pnpm --filter borealis-desktop package:entitlements:smoke
```

## Workspace archives and restore

Quit Borealis before archiving, verifying, restoring, or removing a workspace
backup. The workspace-touching operator commands take explicit absolute paths
and acquire the same instance lock as the server, so they refuse a live
workspace. The lock path is a persistent private mode-`0700` namespace;
acquisitions atomically publish never-reused mode-`0600` owner records inside
it, so crash recovery and release never unlink a shared lock pathname. Server
configuration import is path-only, and neither normal Electron startup nor the
backend creates durable directories or creates/repairs `jwt.secret` before that
lock is held; a losing process returns `WORKSPACE_LOCKED` without touching the
live workspace.
`inspect` reads only the archive and needs no workspace lock:

```bash
# Prompts for and confirms an archive passphrase on an interactive TTY.
pnpm workspace:archive -- create \
  --workspace '/absolute/path/to/Borealis' \
  --output '/absolute/path/to/backup.borealis-workspace'

pnpm workspace:archive -- inspect \
  --archive '/absolute/path/to/backup.borealis-workspace'

pnpm workspace:archive -- restore \
  --archive '/absolute/path/to/backup.borealis-workspace' \
  --target '/absolute/path/to/Restored Borealis'
```

Archives are versioned, gzip-compressed, and encrypted/authenticated by default
with AES-256-GCM and an scrypt-derived key. Passphrases may also come from
`BOREALIS_ARCHIVE_PASSPHRASE` or `--passphrase-fd <number>`; never put one in an
argument or committed file. They must encode to 12–4,096 bytes without NUL.
There is no passphrase recovery. Plaintext creation and reading require the
explicit `--unsafe-plaintext` flag.

The manifest hashes every file and preserves the complete stopped workspace,
including SQLite WAL state, LanceDB, uploads, reports, default model files,
settings, contained configuration, and the signing secret. Add an explicitly
relocated file or directory as `--include name=/absolute/path`. The reserved
names `borealis.sqlite`, `lancedb`, `uploads`, `reports`, `models`,
`settings.json`, `contained.json`, and `jwt.secret` restore to those portable
paths at the target root; `borealis.sqlite` also captures its adjacent WAL,
SHM, and rollback-journal sidecars, while `lancedb` captures an adjacent active
`.<external-name>-migrations/` directory and restores it as canonical
`.lancedb-migrations/`. Other names restore below `relocated/<name>/`. Wrong
kinds, overlaps, mixed SQLite roots, and collisions with an existing canonical
`.lancedb-migrations/` are rejected. Restore rebases supported durable paths, creates
private `0700` directories, and restores non-executable files as `0600` and
owner-executable files as `0700`.

After restoring, point `BOREALIS_DATA_DIR` at the new target and remove or
update old `SQLITE_PATH`, `LANCEDB_DIR`, `UPLOAD_DIR`, `REPORT_DIR`,
`CONTAINED_DIR`, `SETTINGS_FILE`, legacy `SETTINGS_PATH`, and `JWT_SECRET_FILE`
overrides so the server opens the portable root. Preserve environment-managed
values such as an explicit `JWT_SECRET` separately.

Restore extracts into a private sibling staging directory, rejects unsafe or
oversized members, caps decompressed bytes to the manifest-derived tar shape,
and applies one deadline across read, decrypt, gunzip, and extraction. It then
checks free space and every hash, opens SQLite/LanceDB and ready tabular
datasets offline, and swaps the exact target atomically. An existing target
remains as a verified hidden sibling backup named
`.<target>.backup.<uuid>`; it is never deleted automatically. After validating
the restored workspace, remove that exact backup with:

```bash
pnpm workspace:archive -- remove-backup \
  --target '/absolute/path/to/Restored Borealis' \
  --backup '/absolute/path/to/.Restored Borealis.backup.<uuid>'
```

Backup removal is itself crash-resumable. It first renames the verified backup
to the deterministic hidden sibling
`.<target>.backup-remove.<uuid>` and retains the provenance marker until both
recursive deletion and marker cleanup finish. Repeating the same command resumes
that exact marker-authorized tombstone; a replacement that appears at the old
backup pathname is never touched.

Use `pnpm workspace:archive -- verify --workspace <absolute-path>` for an
offline store check. The verifier opens an existing Lance table without creating
one and validates the embedding marker/first-binding receipt. A valid
dimension-matching receipt-only crash state is accepted read-only; normal
startup still requires the exact model identity and republishes only its matching
marker. An existing index with neither identity file is rejected. Version-2
`settings.json` supplies the embedding dimension;
pass the exact live value as `--dimension` to `restore`, `verify`, and
`remove-backup` for a legacy workspace without it or when an
environment-managed dimension differs from the stored value. An explicit CLI
value wins; the CLI does not infer `EMBEDDING_DIM`. Protect archives as highly
sensitive: they can contain all source content, reports, provider credentials,
model weights, and the JWT signing secret. See the [API
reference](docs/API.md#storage-and-workspace-archives) for limits, relocation,
restore, and forward-version behavior.

## Features and invariants

- One bounded streaming tool loop with cancellation, durable run ownership, and
  sanitized activity summaries.
- Cursor-paginated catalogs with explicit “load more” controls; no older
  sources, chats, connectors, agents, libraries, automations, or reports are
  silently hidden by a newest-only cap.
- Dynamic all-source scope, a stable selected allowlist, or deliberately no
  stored sources. Each accepted turn keeps one immutable ready-source snapshot.
- Account- and source-prefiltered LanceDB retrieval joined fail-closed to SQLite
  chunk text.
- Bounded DuckDB SQL for CSV, TSV, XLSX, Parquet, JSON, and JSONL plus staged URL
  connector refreshes.
- One canonical ECharts contract shared by the UI, report HTML, chart PNG, and
  report PDF renderers.
- Durable artifact lineage, chart and query receipts, and read-only report
  sharing inside one Borealis instance.
- Account-scoped libraries, versioned agent identity, Markdown skills and tool
  selections, and personal model
  defaults that never widen a chat's source scope or authorization.
- Durable chat-turn and connector-sync automations, connector schedules, and
  content-free egress/sync audit history.
- Ambient provider locality, direct-route remote-egress consent, and an
  API-managed loopback `llama-server` lifecycle for contained models with
  Settings → Local engine lifecycle controls.
- Synthetic model-pair qualification, managed crash-recoverable embedding-index
  migration, bounded local macOS PDF OCR, and encrypted verified workspace
  archives.
- Self-contained report HTML with restrictive CSP and renderer policies that
  deny network and local-file requests.
- JWT/bcrypt authentication, exact-origin browser CORS, same-origin desktop UI,
  per-account storage, and path-ownership checks before file access or deletion.

See [AGENTS.md](AGENTS.md) for implementation guidance and
[docs/API.md](docs/API.md) for the REST/SSE contract.

## License

Licensed under the [MIT License](LICENSE). Built with Fastify, React, Electron,
SQLite, LanceDB, DuckDB, ExcelJS, Playwright, and ECharts.

Changing the model provider in Settings clears the workspace chat default. Choose
a model advertised by the new provider in Chat models or the composer. Existing
chats retain their saved model.

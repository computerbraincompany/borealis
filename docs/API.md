# Borealis API

The Fastify API listens on `http://127.0.0.1:3000` by default in browser/server
mode. Electron instead chooses an available port on `127.0.0.1`. Registration
and login are public; every other `/api/*` endpoint requires a JWT in
`Authorization: Bearer <token>`. Dataset processing and report rendering are
in-process implementation details and are not separate public services. In
particular, the internal `/query`, `/datasets/*`, and `/reports/build` operation
labels are not HTTP routes.

Clients may send `X-Request-ID` containing only letters, digits, `.`, `_`, or `-`
(maximum 128 characters); invalid values are replaced. Use the response header
when present to correlate a request with server logs. Normal error envelopes are
`{"error":"..."}`, sometimes with `request_id`, and exclude provider responses,
SQL, local paths, and exception text. The Settings connection test and connector
creation have the specific failure shapes documented below.

Successful requests return `200` unless stated otherwise. Bodies are JSON except
for SSE, report HTML, and report PDF. Resource IDs are UUIDs; message IDs and
history cursors are positive integers. Send only the documented request fields.

Browser origins are not reflected. Configure an exact comma-separated
`CORS_ORIGINS` allowlist when the frontend is not served from the default
loopback Vite origins. The packaged UI is served by Fastify from the same exact
loopback origin and does not use cross-origin headers.

An authenticated OpenAPI snapshot is available at `GET /api/openapi.json`.
It describes registered routes and schemas; the lifecycle and response details
below also cover contracts enforced by runtime validation.

Authentication for protected routes runs in Fastify's `onRequest` phase, before
JSON or multipart parsing. An unauthenticated malformed or oversized protected
request therefore returns `401` without invoking the parser, validator, store,
or handler. The server-wide fallback body ceiling is 8 KiB; every route that
intentionally accepts a larger body declares its own derived limit.

The account catalog endpoints `GET /api/chats`, `/api/sources`,
`/api/connectors`, `/api/agents`, `/api/libraries`, `/api/automations`,
`/api/reports`, and `/api/reports/shared` use keyset pagination. Their response
shape is always:

```json
{ "items": [], "next_cursor": null }
```

Send `limit=1..100` (default 50) and pass a non-null `next_cursor` back as the
opaque `cursor` query parameter to read the next older page. Cursors are
versioned, canonical base64url values bound to one endpoint and its
timestamp/UUID ordering; they are at most 512 characters and must not be
decoded, modified, or reused on another catalog. An invalid, empty, noncanonical,
or cross-endpoint cursor returns the normal `400 {"error":"invalid request"}`
envelope. `next_cursor: null` means the catalog is exhausted.

Source and connector transition polling has an exact bounded companion:
`POST /api/sources/status` and `POST /api/connectors/status` accept
`{"ids":["<uuid>"]}` with 1–50 unique UUIDs. Both are authenticated and
account-scoped and return `{"items":[],"missing_ids":[]}`; `missing_ids`
does not distinguish a deleted ID from one outside the account. These endpoints
exist only to reconcile already visible transitional rows and are not an
alternative unbounded catalog. The web client polls a persistent round-robin
queue, advances it even when a batch fails, and reconciles the head page and
exact status request independently so one failure or continuous newer inserts
cannot starve older work.

The public `GET /health` endpoint is a fast process-liveness probe. Authenticated
clients can use `GET /api/health` for dependency readiness. It reports bounded
status and latency for the Borealis API, embedded SQLite ledger, in-process
DuckDB service, configured model endpoint, and an optional distinct LM Studio
runtime without returning service URLs, credentials, model IDs, or raw upstream
errors. The `data_service` readiness folds in one operational prerequisite: after
a restart, while the dataset-registry restoration is still rebuilding the DuckDB
registry from the ledger, it honestly reports `unavailable` and self-heals when
that restoration settles, including its failed-open unwind. A degraded dependency
does not change the liveness endpoint, which avoids restarting a healthy API
process because an upstream service is temporarily unavailable.

Authenticated clients can also use `GET /api/status` for the ambient workspace
snapshot the application chrome displays. It classifies the configured model
endpoint as `local` (loopback, this machine), `private` (private-network
cluster), or `remote` (public provider), reports model endpoint and optional
LM Studio reachability with bounded latency, and names the configured chat and
embed model IDs. Its 20-second single-flight cache reuses the same body-free
catalog probe as `/api/health`. The response never contains the endpoint URL,
credentials, provider errors, or model lists; reachability loss is a status
field, not an HTTP error.

The direct/manual remote-provider payload routes are fail-closed and
provider-origin-bound. While a remote (public) provider is configured and the
account's stored acknowledgment pair does not name that exact canonical origin,
chat messages, source upload, source reingest, connector create/manual sync,
connector schedule changes, and manual brief execution refuse with `403
{"error":"...","code":"REMOTE_EGRESS_CONSENT_REQUIRED"}` before any payload is
processed. `GET /api/consent/remote-egress` returns
`{required,acknowledged_at,endpoint_host}`; for a remote provider
`acknowledged_at` is non-null only when the stored schema-v4 timestamp and
schema-v14 canonical origin match the current exact origin. `POST
/api/consent/remote-egress` atomically records the account's timestamp/origin
pair for the current provider and unblocks the gated routes immediately;
acknowledging one remote origin never authorizes another, so switching remote
origins re-gates the routes until they are acknowledged again. A pre-v14
timestamp-only row is intentionally unacknowledged until re-consent. The stored
origin is never a public field: `endpoint_host` names the currently configured
remote host only, is a response field only, and never appears in logs. Loopback
and private-network providers never gate, and a loopback/private `POST` neither
rewrites the remembered pair nor emits a consent audit event.

Ordinary account-owned chat and retrieval calls authorize the exact captured
provider revision they are about to use and transport through the client built
from that same snapshot, so a Settings switch cannot silently retarget an
authorized request mid-flight; the next call captures and gates the new origin.
Plan 034's request-local draft acknowledgment authorizes only its fixed synthetic
qualification probes and is never durable workspace consent. Model discovery
stays body-free and ungated.

Durable ingestion repeats the check against the exact acknowledged origin in the
worker immediately before the first embedding transport. One immutable
provider/model snapshot is then used for all batches in that job, and parsed and
OCR-recognized text both stay bound to that authorized session. If a job queued
under a local provider resumes after an unacknowledged remote switch, no provider
request is made and the source records the stable asynchronous failure
`REMOTE_EGRESS_CONSENT_REQUIRED`; a concurrent Settings edit cannot redirect an
already authorized job between batches.

`connector_sync` automations are consent-gated end to end, matching the
human connector surfaces: `POST /api/automations` with
`kind: "connector_sync"` and any `PATCH /api/automations/:id` on a
`connector_sync` row refuse with the same `403
REMOTE_EGRESS_CONSENT_REQUIRED` envelope while a remote provider is
configured and its origin is not exactly acknowledged, and a scheduled connector
execution rechecks consent before every run — with a stale or missing
acknowledgment it records a `skipped` run (`remote egress consent is required`)
before any connector lookup, refresh reservation, download, or provider call.
`agent_turn` creation and mutation stay ungated because those automations
recheck consent at execution time like a human turn;
`PUT /api/connectors/:id/schedule` gates the schedule mutation itself.

### Workspace: audit, shares, and automations

Small-team surfaces on one Borealis instance. All routes require
authentication and stay account-scoped.

| Endpoint                                    | Response                                                                                                               |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `GET /api/audit/egress?limit<=200`          | Content-free egress events: `{id,kind,endpoint_host,created_at}`, newest first.                                        |
| `GET /api/accounts`                         | `[{id,email}]` — the workspace accounts available for snapshot sharing.                                                |
| `POST /api/reports/:id/shares`              | Body `{recipient_account_id}`; `201` with `{recipient_account_id,shared_at}`.                                          |
| `GET /api/reports/:id/shares`               | Shares of one owned report, recipient emails included.                                                                 |
| `DELETE /api/reports/:id/shares/:recipient` | `{"ok":true}` — owner-only revocation.                                                                                 |
| `GET /api/reports/shared`                   | Paginated reports shared with the caller: read-only snapshots with `owner_email`.                                      |
| `GET /api/automations`                      | Paginated account automations with schedule, state, and failure counters.                                              |
| `POST /api/automations`                     | `{name,kind,target_id,schedule_minutes,prompt?}`; returns `201` (15–10,080 minutes; prompt required for `agent_turn`; `connector_sync` creation is consent-gated). |
| `PATCH /api/automations/:id`                | `{name?,state?,schedule_minutes?}`; mutations of a `connector_sync` row are consent-gated.                             |
| `DELETE /api/automations/:id`               | `{"ok":true}`; run history cascades.                                                                                   |
| `GET /api/automations/:id/runs`             | Run history `{id,outcome,detail,started_at,finished_at}`; newest first, default 20 and maximum 50.                     |
| `GET /api/automations/_scheduler`           | `{running:boolean}` for the in-process scheduler.                                                                      |

Shares exist only between accounts of this instance and are created for
published reports. Recipients get read-only access to the report detail, the
self-contained HTML document, and the PDF — the HTML/PDF artifacts resolve in
the owner's storage scope — while rename, delete, the stored normalized
payload, and share management remain owner-only. Recipient detail responses
carry `shared_by_account: true` and never include `payload`. Revocation of
all recipient access is immediate; without a share row every recipient route
returns `404`.

Automation history records are content-free; details use generic phrases of at
most 500 characters, and five consecutive failures pause the automation. Names
are trimmed, unique per account, and contain 1–80 characters. `target_id` must
name an owned connector for `connector_sync` or an owned chat for `agent_turn`;
prompts contain at most 8,000 characters. The scheduler checks once per minute
and claims at most 20 due rows per tick. Agent-turn automations go through the
same acceptance path as a human turn — the consent gate, one-run-per-chat, and
durable run records all apply — and a busy chat or missing consent records a
`skipped` run. Cancellation also records exactly one `skipped` history row with
the fixed detail `the run was cancelled`; it neither resets nor increments the
consecutive-failure count, even when cancellation wins the assistant-persistence
race. Scheduled connector executions recheck consent before every run and
write the same best-effort `remote_ingest` receipt the connector routes write.

Audit events never contain prompts, source text, SQL, or model output, and are
best-effort: a failed audit write never fails the request that produced it.
They are activity receipts for consent acknowledgments and selected
remote-capable turn/ingestion attempts, not proof that data reached or was
accepted by a provider and not an exhaustive network-egress audit.

### Contained models

Contained mode lets Borealis own a local model engine end to end: verified
weight downloads, a managed loopback `llama-server` process, and first-class
provider switching. These mutations write global host configuration, start or
stop a host process, and drive model downloads, so they are desktop-operator
only: every mutating endpoint requires **both** a valid signed
desktop-operator capability — carried exclusively by the one-shot Electron
bootstrap session handed to the trusted preload; registration and login never
issue it, it is never serializable through any API response, and it is not a
user-manageable token — **and** the server instance's trusted desktop
composition mode. Missing either returns a stable generic `403` before any
body parsing, config access, download, or process work. The stable desktop
account email alone grants nothing. Browser/server deployments therefore
configure contained mode only out-of-band; an ordinary JWT can never gain
process control. `GET /api/contained` stays ordinary-authenticated for status
chrome and returns a redacted config projection:
`{enabled,binary,model,binary_digest_configured,extra_arg_count}` with binary
and model reduced to basenames, the digest exposed only as a presence flag,
and never `binary_path`, `model_path`, `binary_sha256`, or the raw argument
array. `PUT /api/contained/config` returns the same projection.

| Endpoint                                    | Response                                                                                                                   |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/contained`                        | `{config,engine,downloads}` — redacted config projection, engine state, and in-process download states.                     |
| `PUT /api/contained/config`                 | Body `{enabled,binary_path?,model_path?,binary_sha256?,extra_args?}`; returns the redacted projection. Desktop operator.     |
| `POST /api/contained/downloads`             | Body `{url,filename,sha256}`; `202` with the download state. Desktop operator.                                              |
| `DELETE /api/contained/downloads/:filename` | `{"ok":true}`; cancels the active download for that filename (matched under ASCII case folding) and removes only the internal partial it owns; a filename with no active reservation — including a completed or failed terminal row, and a cancel that arrives after publication began (which returns `false` internally) — returns `404`. Desktop operator. |
| `POST /api/contained/engine/start`          | `202` with the engine state; health is polled in the background. Desktop operator.                                          |
| `POST /api/contained/engine/stop`           | Engine state after an orderly SIGTERM with bounded SIGKILL escalation. Desktop operator.                                    |

Configuration is stored at `<BOREALIS_DATA_DIR>/contained.json`. Writes replace
the file atomically within the same directory with mode `0600` — a pre-existing
widened mode is repaired, and a failed write leaves the previous configuration
intact with no temporary artifacts.
Disabling needs only `{enabled:false}` and normalizes the path/argument fields
to empty values. Enabling requires absolute `binary_path` and `model_path`
values (no `~` or NUL) plus a `binary_sha256` 64-character hex digest of the
engine binary; the digest is verified against the open file handle on every
start and is never returned through HTTP or logged. Enabled configurations
written before the digest requirement fail closed with a generic
reconfiguration error rather than spawning. `model_path` must be a non-symlink
regular file lexically and really below `CONTAINED_DIR`, and its basename can
never be dot-only, the reserved internal `.borealis-partials` directory name,
or end in `.part` under ASCII case folding — download partials can never be
selected as models. `extra_args` accepts at most 32 strings of 1–200
characters of llama tuning flags; arguments that could restate or override the
fixed process authority (`-m`, `--model`, `--host`, `--port`, including any
`--flag=value`/`-m=value` spelling) are rejected at config write and again
before spawn. `config` is `null` before one is saved. `engine` contains
`{state,model,endpoint_host,endpoint_managed_by_env,pid,started_at,error}`, with
state in `off|starting|healthy|crashed|stopped`; download rows contain
`{filename,url_host,state,bytes_received,total_bytes,error}`, with state in
`downloading|verifying|complete|failed|canceled`.

Download contract: `filename` is 1–180 characters of `[A-Za-z0-9._-]`, cannot
contain `..`, and contains no path separators; dot-only names, the reserved
`.borealis-partials` basename, and any name ending in `.part` under ASCII case
folding are rejected through the shared reserved-artifact predicate. Filenames
are owned under a synchronous ASCII-case-folded reservation, so concurrent
`Model.gguf` and `model.gguf` starts are mutually exclusive before any
filesystem or network work, and cancel/retry address that exact owner.
`sha256` is mandatory and verified before the file is atomically renamed into
place — a mismatch removes only the still-owned internal partial and records a
failed state. Downloads live under `CONTAINED_DIR` (default
`<BOREALIS_DATA_DIR>/models`); resumable partials live only below the real,
non-symlink `.borealis-partials` directory beneath it, opened once with
`O_NOFOLLOW`: resume size, writes, `fsync`, SHA-256, and the publication
identity check all use that single verified handle, the pathnames reject
symlinks and non-regular or multiply-linked entries, and ambiguous legacy
root-level `*.part` entries are left byte-for-byte untouched. A resume is
issued only after that proof and is honored only by a `200` (restart,
truncating through the same handle) or a single terminal-tail `206` whose
`Content-Range` starts exactly at the opened partial's size, ends at
`TOTAL - 1`, and stays within the maximum; declared `Content-Length` must be
consistent, and premature EOF fails rather than resuming. The size default is
64 GiB, configurable with the positive safe integer
`CONTAINED_MAX_DOWNLOAD_BYTES`. Transport is DNS-pinned, never global fetch:
`https:` requires every resolved address to pass the public-destination policy
and the socket is pinned to that validated result (DNS address pinning — TLS
hostname verification remains in force; this is not certificate pinning), and
`http:` is accepted only for exact loopback IP literals or `localhost`
resolving solely to loopback. The URL may contain a path but cannot contain
credentials, a query, or a fragment; redirects and non-`identity` encoded
responses are refused. One bounded operation signal covers DNS through the
final body byte, configured by `CONTAINED_DOWNLOAD_TIMEOUT_MS` — milliseconds,
default 86400000 (24 hours), accepted only as a safe integer in the closed
range 60000 (1 minute) to 604800000 (7 days), falling back to the default
otherwise. Publication is the atomic rename after fsync plus SHA-256; a cancel
accepted before the synchronous publication point prevents the rename entirely
and leaves no owned partial, while a cancel arriving after the rename begins
cannot relabel or delete the publication. Orderly application shutdown
quiesces admission and joins every download run — transport, hashing,
publication, and both directory fsyncs — before reporting stopped, and a later
lifecycle may resume admission only after that drain settles. Download
snapshots are process-local observability, never ownership; canceling never
deletes an already verified final model file. These proofs close application
races and symlink attacks; they do not protect against another local user who
can mutate the model directory.

Engine contract: Borealis spawns the configured binary as
`<binary> -m <model_path> --host 127.0.0.1 --port <os-assigned>
[extra_args...]` (the llama.cpp `llama-server` shape), polls body-free
`GET /v1/models` until healthy within a 180-second budget, and reports
`off/starting/healthy/crashed/stopped`. When healthy, and only when the
provider endpoint is not environment-managed, the engine's keyless loopback
origin is applied through the live settings store — a saved remote credential
is explicitly cleared and never follows the switch — and the prior
origin/key pair is restored on stop. The apply and the restore are atomic
full-snapshot compare-and-swaps inside the settings write queue, guarded by an
opaque process-local mutation token that advances on every durable write: an
intervening endpoint, key-only, model, health-endpoint, or same-value change,
or an A→human→A value cycle, makes the restore a no-op that preserves the
human choice. Reapplying after a crashed engine preserves the original
pre-engine pair, and a conditional apply that loses a race discards the whole
restore chain rather than keeping a stale expectation. An
environment-managed endpoint is reported via `endpoint_managed_by_env` instead
of being overridden. Engine process output and provider credentials are never
read or logged, and orderly shutdown stops the engine before the embedded
stores close.

Engine start proves the files immediately before spawning: the binary's
configured components must resolve exactly (the final entry is a non-symlink
executable regular file), it is opened without following the final symlink,
its SHA-256 is streamed from that handle and compared in constant time with
`binary_sha256`, and the model is re-proven contained below `CONTAINED_DIR`.
Immediately before `spawn`, both canonical paths are re-statted and their
device, inode, size, and high-resolution modification/change timestamps are
compared with the retained open-handle identities; any replacement rejects
without spawning and releases the proof handles. This final check closes
deterministic application races; it is not an OS sandbox and makes no claim
against a hostile process with the same OS-user filesystem authority in the
remaining kernel-open window. Spawn arguments and errors are checked again
(full reserved-flag validation) in the same pass.

One start owns one synchronous reservation plus a generation-bound setup
promise covering config read, file proof, port reservation, final identity
check, and spawn, with an identity recheck after every await; stop
synchronously invalidates the generation, signals the exact captured child,
and drains both the setup promise and the health/auto-apply pump before
restoring the provider origin or acknowledging shutdown. A late probe or
apply result for a dead or replaced child is inert. For a running child stop
sends `SIGTERM`, waits a bounded deadline, escalates to `SIGKILL`, and waits a
second bounded deadline for that exact child's `exit`/`close` — a child that
cannot be observed exited fails stop with a stable lifecycle error, retains
its exact identity, and permanently rejects new starts for that process rather
than risking a second engine beside an unobserved first one. The child `error`
event still lands in the bounded `crashed` state.

`GET /api/status` carries the ambient `contained` section
(`{state,model,endpoint_host,endpoint_managed_by_env}` or `null`) so the
workspace chrome can say "On this Mac · contained".

### Agents

| Endpoint | Response |
| --- | --- |
| `GET /api/agents` | Paginated `{items,next_cursor}` of account-owned summaries, newest first; includes identity, instructions, and capability selections. |
| `POST /api/agents` | Required `{name,instructions}` plus optional configuration below; name 1–80 characters unique per account; returns `201`. |
| `GET /api/agents/:id` | `{...summary,revisions}` with immutable prompt/configuration revisions, newest first. |
| `PATCH /api/agents/:id` | Partial identity, name, instructions, or capability fields; every successful patch creates one atomic revision. |
| `DELETE /api/agents/:id` | `{"ok":true}`; active runs retain their snapshots and later messages continue unbound. |

A chat may bind one owned agent at creation using `agent_id`. Unknown or foreign
IDs return `400`. This binding cannot be edited; agent deletion sets it to null.
Chat DTOs carry `agent: {id,name,icon,color} | null`. Each accepted message uses the
current agent revision and selected skill contents, captured within the acceptance
transaction. Existing chats therefore pick up edits on their next message, while
running messages retain their exact prompt and tool selection. Agent instructions
are never logged and cannot override fixed workspace policy or source and account
authorization. Unbound chats retain the default seven built-in tools.

#### Configuration and skills

Agent create and patch bodies accept `description` (up to 240 characters), `icon`,
`color`, `tools`, `skill_ids`, `mcp_tools`, and `job_setup` alongside `name` and
`instructions`. Patches save one atomic revision. Instructions retain the
8,000-character limit. Omitted capability fields preserve defaults on creation
and existing values on edits; `tools: []` explicitly disables every built-in
tool. `tools` keeps its exact built-in-only meaning; connected-tool selections
live in the separate `mcp_tools` collection and job presets in `job_setup`,
both defined under "Connected tools in durable chat turns" and "Jobs" in the
Connections section, where their server-side validation is also specified.
Agent list/detail responses include this configuration, and revisions include
their original configuration. Bound chat responses include the agent's icon
and color.

`GET /api/agent-capabilities` returns the seven supported built-in tool IDs.
Selected skills belong to the authenticated account. Up to eight skills may be
assigned, each with at most 8,000 characters; the combined agent prompt, skill
contents, and section labels must fit 32,000 characters. Missing skills or an
oversized combination produce an actionable configuration error. Message
acceptance captures skill text and the tool allowlist in the same transaction as
the run, so later edits cannot change an active run. The model receives only
enabled tool definitions, and dispatch independently rejects disabled tools.

| Endpoint | Behavior |
| --- | --- |
| `GET /api/agent-skills` | Account-owned skill library, maximum 200 records; numeric versions |
| `POST /api/agent-skills` | Create `{name, description?, content}` and revision 1 |
| `PUT /api/agent-skills/:id` | Replace skill fields and append a revision atomically |
| `DELETE /api/agent-skills/:id` | Remove an owned skill; agents retaining its ID fail configuration validation |

All endpoints authenticate before body parsing. Create/update bodies use the
bounded long-text JSON ceiling. Markdown import in the editor extracts simple
`name`/`description` front matter and submits the remaining instructions through
the same skill-create endpoint. It does not install packages or execute files.
Connected-tool bindings and the durable turn snapshot ship with stage 4 (see
"Connected tools in durable chat turns" under Connections); the agent-editor
selection UI remains a later stage of `docs/AGENT_EDITOR_ROLLOUT.md`.

### Libraries

| Endpoint                                        | Response                                                                                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/libraries`                            | Paginated `{items,next_cursor}` of `{id,name,member_count,created_at,updated_at}`, newest first.                                      |
| `POST /api/libraries`                           | Body `{name}` (1–120 chars, unique per account); returns `201` with the library.                                                      |
| `GET /api/libraries/:id`                        | `{id,name,revision,created_at,updated_at,members}`; members use the full source resource DTO described below.                          |
| `PATCH /api/libraries/:id`                      | Body `{name}`; returns the renamed library.                                                                                           |
| `PUT /api/libraries/:id/sources`                | Body `{source_ids}` (≤100, distinct, all owned by the account); replaces membership exactly.                                          |
| `POST /api/libraries/:id/directory-imports`     | Copied-directory manifest commit; see below.                                                                                          |
| `DELETE /api/libraries/:id`                     | `{"ok":true}`; membership rows cascade. Sources and their data are never touched.                                                     |

Libraries reference sources; they never copy or move them. There is no server
side chat–library binding: attaching a library expands its ready members into
a chat's explicit `selected` scope through the normal chat-creation contract,
so the three-meaning source-scope semantics are unchanged. Member rows include
the source's `account_id`, connector, URL, metadata, and ready generation, as
upload/reingest responses do; no source or library DTO ever exposes a local
`file_path` (the durable path remains internal to ingestion and cleanup).
Replacing membership returns `{"ok":true}` and rejects an unknown or
foreign source with `404` without changing the existing membership.

`GET /api/libraries/:id` also returns `revision`, a collision-resistant digest
of the exact member set. Browser copied-directory import uses it as a
compare-and-swap token.

#### Browser copied-directory import

`POST /api/libraries/:id/directory-imports` is the browser counterpart of the
desktop folder picker: files first arrive through the ordinary
`POST /api/sources/upload` flow, then one manifest commit binds them to a
library with their normalized relative paths. This is a one-shot copied
snapshot — it creates no refreshable folder connection and no durable import
kind. The body is `{operation_id, expected_revision, items:[{source_id,
relative_path}]}` (1–100 items):

- `operation_id` is a caller-chosen UUID that makes the commit idempotent — a
  retry whose every item already carries the operation's stamp and membership
  returns `{added:0, idempotent:true}` instead of failing its own stale
  revision;
- `expected_revision` must equal the library's current `revision`; any
  membership change between the client's read and the commit returns `409
  LIBRARY_REVISION_CONFLICT`;
- the server re-validates the manifest: relative paths re-run managed identity
  normalization (traversal, absolute, and hidden-segment paths refuse with
  `400`), and only ready, owned, upload-backed, non-connector sources commit
  (foreign `404 SOURCE_NOT_FOUND`, unready `409
  DIRECTORY_IMPORT_SOURCE_NOT_READY`, connector `400
  DIRECTORY_IMPORT_SOURCE_CONNECTOR`, aggregate over 100 MiB `413
  DIRECTORY_IMPORT_SIZE_EXCEEDED`, capacity `409
  DIRECTORY_IMPORT_LIBRARY_FULL`);
- a successful commit returns `{operation_id, library_id, revision, added,
  idempotent:false}`, adds the sources to membership through normal rules, and
  stamps each source's `meta.directory_import` with content-free provenance
  (`operation_id`, `relative_path`, `library_id`, `committed_at`).

Failed or cancelled imports leave the already-uploaded sources visible in
Sources with their normal explicit removal action; the server never deletes
them implicitly.

#### Library source search

`POST /api/libraries/:id/search` searches the library's ready members without
widening chat scope and without ever exposing file paths. Body
(48 KiB ceiling): `{query, mode?, source_ids?, kind?}` where `query` is
1–1,000 characters, `mode` is `keyword` (default) or `semantic`, `source_ids`
is an optional filter of ≤100 UUIDs, and `kind` is `document` or `tabular`.
Filter IDs are validated against library membership and account: non-member
IDs never widen the scope and are reported in `ignored_source_ids`; a filter
that resolves to nothing is an empty page (`hits: []`), never all library or
account content. Invalid query/mode/filter grammar returns `400`.

- **Keyword** is the default and makes no model request. It is a scoped
  SQLite FTS5 search whose account and exact `(source_id, generation)`
  predicates ride inside the search itself. The user query is compiled into a
  literal-only grammar: whitespace-separated tokens, each one double-quoted
  phrase with quotes doubled, `*` never acting as the prefix operator; FTS5
  keywords (`AND`, `OR`, `NEAR`), parentheses, and column specifiers can only
  ever match as literal text. More than 64 tokens are truncated honestly and
  reported as `query_truncated: true`.
- **Semantic** embeds the query through the ordinary account-authorized
  embedding boundary, so a remote model provider requires the same
  remote-egress acknowledgment as chat turns — without it the request returns
  `403 REMOTE_EGRESS_CONSENT_REQUIRED` before any search work. The vector
  side reuses the scoped LanceDB KNN restricted to the captured pairs.

Acceptance captures the concrete ready `(source_id, generation)` set and the
response echoes it as `captured_scope` entries with `status`: `ready`,
`source_changed` (a captured generation was superseded or removed — its newer
content is never searched or returned), or `unavailable` (the member had no
ready generation at acceptance). A refresh promoting mid-search can therefore
only make captured text disappear from a stale capture, never leak newer text.

`hits` are ranked (`rank` is 1-based; `score` is bm25 relevance for keyword
or cosine similarity for semantic) and carry `source_id`, `generation`,
`chunk_id`, a sanitized `label`, an `excerpt` that is a verbatim prefix of the
chunk (≤2,000 characters), and typed `locators`. Budgets: at most 50 hits and
100,000 total returned characters (`truncated: true` when any budget cut the
page). Locators are honest or absent — chunk-level typed spans recorded at
ingestion:

| Locator kind      | Meaning                                                                          |
| ----------------- | -------------------------------------------------------------------------------- |
| `pdf_page`        | Real 1-based `page`, `ocr` flag, and `char_start`/`char_len` inside that page's extracted text (OCR-stamped pages keep their page number and flag) |
| `text_span`       | `char_start`/`char_len` inside the normalized extracted document text, plus `heading` only when Markdown extraction saw an ATX heading |
| `tabular_rows`    | `sheet`/table name and inclusive 1-based `row_start`/`row_end` only when the tabular preview actually knows the rows |

Chunks ingested before this feature (or without known structure) simply carry
no `locators` — an explicit location-unavailable state; there is no implicit
reingest or mass embedding request.

### Knowledge connections (folder and WebDAV transports)

Living knowledge libraries (M14) are driven by two read-only transports whose
bytes are staged through ordinary account/source upload storage and normal
ingestion admission:

- **`desktop_folder`** scans a directory selected through the native macOS
  picker. Electron main owns the dialog, resolves the canonical real path, and
  forwards only `{grant_id, root_path, display_label}` to the backend over the
  private utility-process channel; the renderer receives only an opaque
  `grant_id`, a label, and bounded preview metadata (`{grant_id,label,preview:
  {entry_count,truncated}}`) and never the path. A grant is a one-time token
  held in backend memory, expires after 10 minutes if uncommitted, and is
  consumed by the single `desktop_folder` connection-creation path — so no
  HTTP endpoint accepts an arbitrary absolute local path, and picker
  cancellation creates no connection and no ingestion job. The scan is bounded
  (≤100 managed entries, ≤10 directory levels, ≤1,000 visited, ≤100 MiB
  aggregate, additionally capped by the per-file upload limit); hidden
  directories, every symlink, and `.git`/`node_modules`/Borealis workspace
  directories are excluded and reported as skips; over-limit fails the whole
  preview without partial activation.
- **`webdav`** reads an application-password Basic-authenticated read-only DAV
  collection. HTTPS is required except the operator-supported
  loopback/`.local` network policy; each request DNS-pins its validated
  resolution and refuses redirects outright, so credentials never continue to
  another origin. Traversal is bounded `PROPFIND Depth:1` per directory; the
  `multistatus` body is parsed with a strict structural subset that refuses
  DTD/entity constructs and bounds byte/element counts. Content hashes are
  computed over `GET` bytes (ETag/last-modified are hints only); downloads run
  through two slots on a per-request (default 30 s) ceiling.

The application password lives only in the shared connection secret store
(keyed by the same account/connection pair as MCP custody) and never in a
ledger row, DTO, or error; the connection exposes only a
`credential_configured` boolean. Bad credentials surface as an actionable
disconnected state; reconnect updates only future transport snapshots, and
partial remote failures retain ready content with per-item status. Managed
identity is the normalized relative path: a same-path replacement reuses the
source with a new ingestion generation, a rename is a missing old path plus a
new path, and missing upstream is retained as `missing_upstream`. No
connection scan or deletion removes sources, reports, or captured evidence,
and a refresh never widens or narrows a chat's source selection.

#### The knowledge workflow surface

The typed routes above put the ledger, the transports, and the durable
`refreshAndWaitReady` service behind `requireAuth` resource routes. DTOs carry
stable `KNOWLEDGE_*` state codes only, never a folder's absolute root path or
any credential material, and every failure is a stable code with a fixed
generic message.

| Endpoint                                      | Contract                                                                                                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /api/knowledge-connections`             | Creates a `desktop_folder` connection strictly from a consumed grant (a WebDAV form may not name a local path) or a `webdav` connection whose password goes straight to shared custody. Returns `201` with the metadata DTO. |
| `GET /api/knowledge-connections`              | Endpoint-bound keyset catalog `{items,next_cursor}`, default 25, max 100.                                                                                     |
| `PATCH /api/knowledge-connections/:id`        | Version-checked (`expected_revision`) name edit, `watch_enabled` toggle, and optional WebDAV credential replacement (`credentials: {password}` or `null`).     |
| `DELETE /api/knowledge-connections/:id`       | Requests cancellation of the connection's active refresh, removes the mapping/custody record/watch state, and returns `{"ok":true}`. Sources, library membership, and every artifact are retained. |
| `POST /api/knowledge-connections/:id/previews`| Starts the durable bounded scan; returns `202 {preview, run_id}` while the pending row is polled below.                                                       |
| `GET /api/knowledge-previews/:id`             | The exact-account diff with per-entry selection tokens (`{preview, entries}`). Uncommitted previews expire after 10 minutes.                                  |
| `POST /api/knowledge-previews/:id/apply`      | Commits `selections[{entry_id, selection_token}]` against the exact preview revision; stale tokens/revision → `409 KNOWLEDGE_PREVIEW_STALE`, expiry → `410 KNOWLEDGE_PREVIEW_EXPIRED`. Registers one durable `apply` refresh and returns its ID alongside `{preview, items}`. |
| `POST /api/knowledge-connections/:id/refreshes` | Manual refresh (`202 {refresh}`); exactly one active refresh per connection (`409 KNOWLEDGE_REFRESH_ACTIVE`).                                                  |
| `GET /api/knowledge-connections/:id/refreshes`| Bounded newest-first refresh history (the newest 100 runs per connection).                                                                                     |
| `GET /api/knowledge-refreshes/:id`            | Exact-target `{refresh, counts, items}` status with bounded per-item source/generation outcomes.                                                              |
| `DELETE /api/knowledge-refreshes/:id`         | Durable cancellation request; idempotent — a repeat on a settled refresh reports its state rather than an error.                                               |

Preview and refresh scans run on per-app background drives cut off at server
shutdown, never as open-ended HTTP requests. The `status_code` values
`KNOWLEDGE_UPSTREAM_UNAUTHORIZED` and `KNOWLEDGE_CREDENTIALS_MISSING` record an
actionable disconnected state, and archive restore records
`KNOWLEDGE_RESTORE_RECONNECT_REQUIRED` (WebDAV) or
`KNOWLEDGE_FOLDER_RESELECT_REQUIRED` (desktop folder) after a cross-machine
restore — the Web UI renders exactly those reconnect/reselect states.

Desktop watch is durable ledger state (`watch_enabled`, off by default), but
the periodic scan pump runs only inside the trusted desktop composition: 2
seconds of debounce, a 30-second minimum scan interval, and a 5-minute full
reconciliation pass, with every timer cleared on shutdown. Browser mode
persists the setting and starts no scan; the Web UI labels watch as a
desktop-app capability.

The macOS app creates its single local account and passes a fresh session from
Electron main through the trusted preload exactly once. That bootstrap is not an
HTTP endpoint and does not change the public registration/login contract. The
desktop token lives in Chromium session storage rather than persistent local
storage; reopening Borealis mints a new seven-day session for the same local
account, so the passwordless desktop profile intentionally has no sign-out
action.

## Minimal authenticated flow

The examples deliberately use placeholders. Keep tokens out of shell history,
logs, screenshots, and committed files.

```bash
export BOREALIS_API='http://127.0.0.1:3000'
export BOREALIS_TOKEN='<token returned by login or registration>'

# Create a chat with deliberately no stored sources selected.
curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer $BOREALIS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"title":"Finance review","source_mode":"selected","source_ids":[]}' \
  "$BOREALIS_API/api/chats"

# Upload a source. Save the returned source id, then poll GET /api/sources until
# its status is ready (or error).
curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer $BOREALIS_TOKEN" \
  -F 'file=@data/sample/transactions.csv' \
  "$BOREALIS_API/api/sources/upload"

# Attach one or more ready source UUIDs to the chat.
curl --fail-with-body --silent --show-error \
  -X PUT \
  -H "Authorization: Bearer $BOREALIS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"source_mode":"selected","source_ids":["<source-uuid>"]}' \
  "$BOREALIS_API/api/chats/<chat-uuid>/sources"

# Stream an agent turn. `curl -N` disables response buffering.
curl --fail-with-body --silent --show-error -N \
  -H "Authorization: Bearer $BOREALIS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"content":"Analyze this dataset and create a report."}' \
  "$BOREALIS_API/api/chats/<chat-uuid>/messages"
```

## Authentication

`POST /api/register` and `POST /api/login` accept
`{"email":"...","password":"..."}` and return
`{"token":"...","user":{"id":"<user-uuid>","email":"..."}}`. Email is trimmed
and lowercased, with a 254-character maximum. Passwords require at least six
characters and at most 72 UTF-8 bytes; the JSON body limit is 2 KiB. Registration
returns `409` for an existing email; incorrect login credentials return `401`.

JWTs expire after seven days. Protected routes also verify that the account still
exists before body parsing. A token for a removed account returns `401` with
`SESSION_ACCOUNT_UNAVAILABLE`; the browser clears the stale session and returns
to sign-in, including from `/login#/settings`. `GET /api/me` validates the token and returns its
claims (`userId`, `email`, `iat`, and `exp`), not the registration response's
`user` object. There is no token-refresh or server logout endpoint.

## Source scope and turn snapshots

A chat has exactly one of these states:

- `{"source_mode":"all"}` dynamically includes every ready source currently
  owned by the account.
- `{"source_mode":"selected","source_ids":[...]}` is a stable allowlist.
- `{"source_mode":"selected","source_ids":[]}` deliberately grants no stored
  source access and never widens to `all`.

Source-scope requests are an exact union: do not send `source_ids` with `all`.
`selected` requires an array of at most 100 owned UUIDs; duplicates are
normalized and removed. Attaching an indexing or errored source is allowed,
but its content is unavailable to stored-data tools until ready. Unknown or
unowned attachment IDs return `400` without identifying which ID failed.

Scope resolution is capped at 100 sources, including unavailable attachments.
If an `all` chat grows beyond that limit, reading it or accepting another turn
returns `409`; use `PUT /api/chats/:id/sources` to choose a smaller selection.

Only ready sources grant stored-data access in a turn. The accepted model, source
mode, and concrete ready source IDs are committed with the user message and run
in one SQLite transaction. Later model or source changes affect the next turn,
not an already accepted run. This is a stored-data tool boundary: prior conversation
messages can still contain information from earlier turns. `fetch_url` is a
separate capability and accepts only a public HTTP(S) URL explicitly written in
the current user message, even when the stored-source selection is empty.

## Chat history and runs

`GET /api/chats/:id?limit=50` returns the newest page in chronological order and
adds:

```json
{
  "active_run": { "id": "<run-uuid>", "status": "running" },
  "messages_page": {
    "has_more": true,
    "next_before_message_id": 123
  }
}
```

Pass that cursor as `before_message_id` to load older messages. `limit` is 1–100.
`active_run` is `null` when no run is active and lets clients rehydrate a
`running` or `cancelling` run after navigation or reload. Omitting `limit` returns
the configured bounded first-page size (80 messages by default, capped at 100).
The response also includes the chat summary, `sources`, and `messages` with
`id`, `role`, `content`, `meta`, and `created_at`. When no older page remains,
`next_before_message_id` is `null`.

History also has an aggregate serialized-character budget, so a page can contain
fewer messages than requested. Oversized message content is marked with
`meta.content_truncated`; oversized metadata is replaced with
`{"metadata_truncated":true}`. History is never returned as an unbounded response.

`POST /api/chats/:id/messages` accepts `{"content":"..."}` and returns
`text/event-stream`. Content is trimmed and must be nonempty, with a default
maximum of 32,000 Unicode characters. Every frame is JSON in an SSE `data:` field
(there are no SSE `event:` or `id:` fields). While a run is active the server
also writes an SSE comment keepalive (`: ping`) every 20 seconds; comment blocks
are not events and clients must continue to ignore them. Event types are:

| Type          | Stable fields                            | Meaning                                                                               |
| ------------- | ---------------------------------------- | ------------------------------------------------------------------------------------- |
| `run-started` | `run_id`                                 | Durable run identity; retain it for cancellation.                                     |
| `user-saved`  | `message_id`                             | The user message and immutable turn snapshot committed.                               |
| `step-start`  | `name`, `summary`                        | A sanitized operation summary; never raw arguments.                                   |
| `step-end`    | `name`, `summary`, `status`              | Sanitized completion state (`ok` or `error`).                                         |
| `delta`       | `text`                                   | Complete final answer, emitted after persistence, not token by token.                 |
| `message`     | `message_id`, `content`, `meta`, `roles` | Persisted assistant message and bounded display artifacts; `roles` is currently `[]`. |
| `error`       | `message`                                | Bounded failure message; cancellation is not an error event.                          |
| `done`        | —                                        | Legacy success marker, emitted only after the durable run completes.                  |
| `run-ended`   | `run_id`, `status`                       | Authoritative terminal state: `completed`, `cancelled`, or `failed`.                  |

On success, the final sequence is `delta`, `message`, `done`, `run-ended`.
Provider reasoning, raw tool arguments/results, and provider exceptions are
never sent as event payloads. Tool progress uses server-defined summaries;
individual tool errors can be followed by further tool calls or a final answer.
For OpenAI-compatible streams, tool calls are assembled by bounded numeric
index. Function names accept both provider conventions — cumulative names and
separate valid fragments — while arguments remain bounded append-only stream
data; incomplete calls fail before tool execution.

Assistant `meta` contains `charts` (chart UUIDs), `report` (a report UUID or
`null`), `model`, `source_mode`, `source_ids`, `citations`, `evidence`, and
`query_results`. Evidence contains bounded
`{source_id,chunk_id,source,excerpt,score}` records. `citations` maps each
bracketed citation marker the answer actually used onto the run's own evidence:
`{n,source_id,chunk_id,source}` with 1-based `n` into the `evidence` array,
deduped and capped at 8. Markers that do not resolve to evidence are never
recorded and stay plain text in the UI. Query display snapshots contain
`{id,sql,columns,rows,row_count,truncated}`; they are bounded display
artifacts, not complete query exports. User message metadata records the
accepted model and source snapshot, plus an optional
`agent: {id,name,version}` revision snapshot when the chat is bound to an
agent.

Only one run may be `running` or `cancelling` per chat; another message returns
`409`. Disconnecting from SSE does not cancel the accepted run. There is no SSE
replay or separate run-read endpoint: reload `GET /api/chats/:id` to obtain the
latest messages and `active_run`, and poll it while a detached run is active.
After receiving `run-started`, cancel with:

```bash
curl --fail-with-body --silent --show-error \
  -X DELETE \
  -H "Authorization: Bearer $BOREALIS_TOKEN" \
  "$BOREALIS_API/api/chats/<chat-uuid>/runs/<run-uuid>"
```

Cancellation is idempotent for an owned run. The response is
`{"ok":true,"run_id":"<run-uuid>","status":"cancelling"}` or reports the
already-terminal `completed`, `cancelled`, or `failed` state; `404` means the run
does not exist in that owned chat. A run that reaches `cancelled` emits
`run-ended` without a success `done` or an assistant message. After a crash,
startup marks unfinished
running work `failed` and preserves requested cancellations as `cancelled`.
Orderly shutdown cancels active work. Neither path presents unfinished work as
completed.

## Resources

### Health and models

`GET /health` returns `{"status":"ok"}`. `GET /api/health` returns
`{status,checked_at,services}`, where overall `status` is `operational` or
`degraded`, and `checked_at` is an ISO timestamp. Each service has `id`, `name`,
`description`, `status` (`operational` or `unavailable`), and `latency_ms`.
Reported latency is bounded to 0–2,000 ms.
The stable IDs are `api`, `database`, `data_service`, `model_gateway`, and the
optional `model_runtime`. `model_gateway` is the direct configured provider,
not a proxy process. `data_service` additionally covers startup dataset-registry
rehydration: it reports `unavailable` — never falsely operational — while a
restoration is in flight, and recovers as soon as it settles. Both healthy and
degraded readiness responses use `200`.
The model probe checks catalog reachability, not whether a chat or embedding
request will succeed; readiness does not run inference or render a report.

`GET /api/status` returns
`{locality,endpoint_reachable,lm_studio_reachable,chat_model,embed_model,contained,checked_at,latency_ms}`.
`locality` is `local`, `private`, or `remote`; `lm_studio_reachable` is `null`
when no separate LM Studio health endpoint is configured. Latency is bounded to
0–2,000 ms and served from a 20-second single-flight cache. `contained` is
`null` while the managed engine is `off`; otherwise it is
`{state,model,endpoint_host,endpoint_managed_by_env}`. The snapshot is
informational chrome state, not an authorization surface.

`GET /api/models` includes `display_name` (the resolved provider model ID) on each option, while `id` preserves stable aliases for selection. `available_models` includes the complete advertised catalog for the Settings embedding selector; `/v1/models` does not standardize model capabilities, so embedding choices require qualification before migration. Settings uses dropdowns, refreshes discovery after saving a provider connection, and shows only models advertised by that provider. Unavailable discovery does not insert a synthetic current-model option. Changing the provider origin clears the workspace default chat model unless the patch explicitly supplies one; environment-managed defaults still take precedence. Account model preferences are separate. The UI requires an available selection for a new chat. Existing chat models remain unchanged.

`GET /api/models` returns, for example:

```json
{
  "models": [{ "id": "qwen-chat", "display_name": "qwen/qwen3.6-35b-a3b" }],
  "available_models": [
    { "id": "nomic-embed", "display_name": "text-embedding-nomic-embed-text-v1.5" },
    { "id": "qwen-chat", "display_name": "qwen/qwen3.6-35b-a3b" }
  ],
  "default_model": "qwen-chat",
  "account_default_model": null,
  "discovery": "live"
}
```

`account_default_model` is the requesting account's personal default chat model
(see Preferences below) or `null`. `POST /api/chats` stamps that value when it
is non-null, otherwise the workspace `default_model`; an explicit `model` in
the create body takes precedence. An unset default is an empty string, and a
create without any model returns `409 CHAT_MODEL_REQUIRED`. Catalog responses
expose defaults only when advertised by the current provider.

Entries contain `id`, `display_name`, and optional `owned_by`, and are deduplicated
and sorted. The chat `models` list excludes the configured embedding identity. Known physical model IDs map
back to the stable aliases in [llmAliases.ts](../server/src/llmAliases.ts);
unknown IDs are preserved. Successful discovery is cached for 15 seconds;
`?refresh=1` bypasses that cache (`refresh=0` is also accepted). Discovery failure
returns `200` with empty `models` and `available_models` lists and `discovery: "unavailable"`, keeping the
configured `default_model`. Settings changes invalidate the runtime's catalog
cache. Discovery is informational; saving a per-chat model does not require it
to appear in the current catalog.

### Chats

| Endpoint                            | Request and response                                                                                                                           |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/chats`                    | Paginated `{items,next_cursor}` of `{id,title,model,source_mode,agent,created_at,updated_at}`, ordered by latest activity, then ID.            |
| `POST /api/chats`                   | Optional `title`, `model`, source-scope union, and `job` block (chat creation from a job — see "Jobs"); returns the chat summary, plus the `job` projection when created from a job. Uses the account's default chat model when set, else the workspace default. |
| `GET /api/chats/:id`                | Summary, sources, bounded history page, and active run; accepts `limit` and `before_message_id`.                                               |
| `PATCH /api/chats/:id`              | Exactly one of `{"title":"..."}` or `{"model":"..."}`; returns the updated summary.                                                            |
| `PUT /api/chats/:id/sources`        | Source-scope union; returns `{source_mode,sources}`.                                                                                           |
| `DELETE /api/chats/:id`             | Returns `{"ok":true}`; `409` while the chat has an active run.                                                                                 |
| `POST /api/chats/:id/messages`      | `{"content":"..."}`; SSE contract above.                                                                                                       |
| `DELETE /api/chats/:id/runs/:runId` | Cancellation contract above.                                                                                                                   |

Titles are trimmed and must contain 1–80 Unicode characters. An omitted title
starts as `New chat` and uses the first message's first 80 characters as a fallback.
After the first successful browser/API chat answer, Borealis asks the selected model
for a concise title (up to 60 characters). This optional request uses at most 2,000
characters of the first message, no tools, no retries, and a ten-second deadline.
Provider failure or invalid output keeps the fallback. Explicit titles and manual
renames are never overwritten; existing conversations are not renamed retroactively. Models are trimmed to a required 1–256 characters
and cannot equal the configured embedding model in either alias or physical
form. Renaming advances chat activity; changing its model or source scope does
not.

Omitting source scope on API chat creation preserves the legacy `all` default.
The web UI explicitly creates `selected` chats with `source_ids: []`. To avoid
unexpected stored-source access, API clients should also send their intended
scope explicitly.

### Account Preferences

- `GET /api/preferences` → `{default_chat_model: string|null}` (requireAuth)
- `PATCH /api/preferences` → body `{default_chat_model: string|null}`; returns
  the stored value. Shape-validated only (trimmed, 1–200 characters, or
  `null`): the id is not checked against the live catalog. API chat creation
  stamps any non-null stored value even when it is stale or absent from current
  discovery; the provider may then reject it at run time. Clear the preference
  to `null` to restore the workspace default. The model of an existing chat
  never changes implicitly. An explicit composer choice is applied with the
  per-chat model patch before the first turn, so effective first-turn
  precedence is: explicit chat model > account default > workspace default.

### Provider Settings

The Settings UI separates connection credentials (**Provider**), workspace chat
model selection (**Chat models**), embedding qualification and index migration
(**Embeddings**), and contained runtime controls (**Local engine**). Drafts survive
panel navigation; ordinary saves and discards apply only to the current panel.
Embedding identity changes use qualification and migration, never ordinary save.


- `GET /api/settings`
- `PATCH /api/settings`
- `POST /api/settings/test`
- `POST /api/models/qualify`
- `GET /api/models/embedding-migration`
- `POST /api/models/embedding-migration/start`
- `POST /api/models/embedding-migration/retry`
- `POST /api/models/embedding-migration/cancel`
- `POST /api/models/embedding-migration/apply`

`GET /api/settings` returns the effective OpenAI-compatible provider
configuration:

```json
{
  "llm_base_url": "http://127.0.0.1:1234",
  "llm_api_key_configured": false,
  "lm_studio_base_url": null,
  "default_chat_model": "qwen-chat",
  "default_embed_model": "nomic-embed",
  "embedding_dimension": 768,
  "managed_by_env": {
    "llm_base_url": false,
    "llm_api_key": false,
    "lm_studio_base_url": false,
    "default_chat_model": false,
    "default_embed_model": false,
    "embedding_dimension": false
  }
}
```

Settings are shared by the running Borealis instance, not scoped to the signed-in
account. Any authenticated account can read or update them. The stored API key
is never returned. `PATCH /api/settings` accepts any subset of
Changing the provider origin clears the workspace chat default unless the same
API request explicitly supplies a replacement; environment overrides still win.
Settings → Provider clears the previous chat draft after saving a new origin.
Choose an advertised model afterward. Existing chat models and the embedding
index identity remain unchanged. `default_chat_model: ""` explicitly unsets it.

`llm_base_url`, `llm_api_key`, `lm_studio_base_url`, `default_chat_model`,
`default_embed_model`, and `embedding_dimension` (integer 1–16,384). A saved
credential is persisted with its bound endpoint origin; the two are an
inseparable pair. Omitting `llm_api_key` preserves the pair only when the
target origin is equivalent to the bound origin; an origin change with an
omitted key clears the credential durably. Supplying `llm_base_url` and
`llm_api_key` together binds the new pair atomically. Sending `null` clears
both. `lm_studio_base_url: null` clears the optional health endpoint. The
response has the same redacted shape as `GET`; no response, error, or log ever
exposes the stored key or its binding origin. Version-3 settings persist the
key/origin pair beside the embedding dimension. Version-1 and version-2 files
are read compatibly: their endpoint, health-endpoint, model, and (from version
2) dimension fields are preserved while an unbound legacy key is dropped and
reported unconfigured until it is re-entered. On disk the pair is
`llm_api_key` plus `llm_api_key_origin`, written only together; the binding
origin is an internal persistence field and never appears in any API payload.
A malformed or mismatched version-3 pair never becomes an effective credential.
The settings file stores
the key as plaintext and is replaced atomically with mode `0600`, with the
final rename as its single durable commit point.

Both endpoint fields accept bare HTTP(S) origins only: no credentials, path
(including `/v1`), query, or fragment. Borealis appends `/v1` itself. HTTP is
allowed for loopback origins and `.local` hostnames; other endpoints require HTTPS. An LM Studio
health origin equivalent to the primary origin is omitted from the effective
configuration to avoid a duplicate probe.

Environment-managed fields return `409` if included in a patch, connection-test
draft, or qualification draft, even with the same value. An `LLM_API_KEY` (or
`LITELLM_API_KEY`) set without an environment base URL is bound to the first
effective endpoint of that process and additionally marks `llm_base_url`
environment-managed, so the Settings API cannot retarget the endpoint away
from the environment key; a direct settings-file edit plus restart remains an
explicit operator rebind. Model IDs are trimmed, contain 1–256 characters, and
must identify distinct chat and embedding models, including through aliases.

Canonical environment overrides are `LLM_BASE_URL`, `LLM_API_KEY`,
`LLM_CHAT_MODEL`, `LLM_EMBED_MODEL`, and `EMBEDDING_DIM`, plus
`LM_STUDIO_BASE_URL` for the optional health endpoint. Historical `LITELLM_*`
names remain supported as lower-precedence compatibility aliases. They
configure the direct OpenAI-compatible client and do not imply an intermediary
sidecar.

`POST /api/settings/test` accepts the same optional draft body, tests it without
persisting, and performs a body-free `GET /v1/models`. Success returns
`{"ok":true,"latency_ms":42}`; connection or upstream failure returns
`503 {"ok":false}` without URL, credential, response body, or exception details.
The probe has a five-second timeout and does not follow redirects or validate
model availability through inference. An omitted test body uses saved effective
settings. A URL-only cross-origin draft is probed without the saved origin's
`Authorization` header; a draft that supplies both endpoint and key sends only
the draft key, and neither the credential nor its binding is persisted by the
preview. When a remote provider is selected, chat prompts/history, retrieval
queries, and selected source/tool context leave the machine under that provider's
data policy. Source text also goes to the provider for embeddings during
ingestion, before any chat attachment is required. Parsing, analytical SQL,
storage, and rendering remain local.

`POST /api/models/qualify` accepts a complete or partial Settings draft plus the
optional `expected_dimension`; when omitted, a validated embedding response determines
the dimension automatically. An environment-managed dimension remains an exact
constraint. If both `embedding_dimension` and `expected_dimension` are supplied,
they must agree. It performs two independent, fixed synthetic checks with no
workspace content: the chat model must emit bounded streaming SSE that the
production tool-call accumulator resolves to one 1–256-character call ID, the
exact synthetic tool name, and bounded valid JSON arguments. A nonstreaming
lookalike response does not qualify. The embedding model must return one vector
with 1–16,384 dimensions (matching an explicit expected dimension when supplied) whose coordinate values and accumulated
squared norm remain finite and positive after float32 rounding. This rejects
coordinate and norm underflow/overflow before Lance cosine search. The draft is
not saved.
A remote draft additionally requires `remote_egress_ack_origin` equal to the
canonical draft provider origin; this one-request acknowledgment is not stored
as account consent. The result is:

```json
{
  "chat": {
    "qualified": true,
    "reason_code": "qualified",
    "latency_ms": 42
  },
  "embedding": {
    "qualified": true,
    "reason_code": "qualified",
    "dimension": 768,
    "latency_ms": 18
  }
}
```

Chat reason codes are `qualified`, `unreachable`, `timeout`, `response-truncated`, `tool-call-missing`, and
`tool-call-invalid`; embedding codes are `qualified`, `unreachable`, `timeout`,
`embedding-invalid`, and `dimension-mismatch`. Embeddings run first, followed by chat, to avoid simultaneous cold model loads.
Each request has a 30-second deadline (at most 60 seconds total); the chat request allows up to 1,024 generated tokens and its SSE response is capped at 512 KiB, the
embedding response at 2 MiB, and synthetic tool arguments at 256 characters.
Tool-name fragments may be incremental or cumulative, matching the real
streaming path, but call count, ID, name, and argument budgets remain fixed.
Provider bodies, model text/reasoning, URLs, keys, exceptions, and raw tool
arguments are discarded. Qualification proves only this draft at this moment;
it is neither authorization nor a durable compatibility promise.

Saving through `PATCH` updates later model operations without restarting the
process. It does not rewrite models already saved on existing chats; a changed
chat default applies to new chats. Direct edits to `settings.json` require a
restart for the running model client to reload them, but they cannot bypass
vector identity validation. Each Lance directory has a private mode-`0600`
`.borealis-embedding-index.json` marker containing the resolved outbound model
ID and dimension and an independent private binding receipt recording the first
publication. Startup rejects a different physical model even when its dimension
matches. A missing marker can be recreated only from the exact binding receipt;
an invalid marker, invalid receipt, disagreement, or different expected identity
fails closed and cannot reopen adoption. Logical aliases resolving to the
recorded model are equivalent.
New or empty indexes bind automatically. A populated pre-marker index is adopted
only through the one-release legacy policy: no embedding environment override
and an identity supplied by loaded persisted Settings, or the pinned legacy
defaults when Settings is absent. Other legacy states fail closed. Once the live
fixed-schema vector index exists, a generic patch that
changes the embedding model or dimension always returns `409` with code
`EMBEDDING_REINDEX_REQUIRED`, including when the ledger has zero ready sources.
Use the managed migration rather than creating mixed embedding identities; a
zero-source migration builds and verifies an empty target index before the same
journaled live swap. `POST /api/models/embedding-migration/apply` returns
`202` with `apply_pending`; poll status until `idle` or a failure. The server
waits up to 60 seconds for active chats, holds new turn/source admission, then
closes and reopens only the vector index. SQLite and the HTTP server stay open.
`ACTIVE_TURNS_BUSY` returns the migration to `ready_to_apply` for another attempt.
`restart_required` remains in the response for compatibility and is false.
Installation failures restore the previous index/settings pair; startup journal
recovery remains available after a process crash.

`POST /api/models/embedding-migration/start` accepts
`{target_embed_model,target_dimension}`. It applies the normal account consent
gate, previews those fields against the persisted provider, credential, and chat
model settings, qualifies both roles again, and returns `202` only when the pair
qualifies. Admission rereads Settings and rejects the start unless the exact
qualified baseline provider/credential/chat/embedding identity and target
model/dimension still match. It never combines the embedding target with
unsaved endpoint, credential, or chat-model draft fields; the Settings UI
requires those compatible non-target changes to be saved or discarded first.
One process-wide migration can exist. It requires no active ingestion, consent
for every affected account bound to the exact migration provider origin when the
provider is remote — a bounded fail-fast manifest check at start/retry admission
and a check of the accounts represented by each batch immediately before its
embedding transport, recording only the stable aggregate failure code —
non-environment-managed embedding fields, a changed target identity, and
sufficient disk space. With
zero ready sources it constructs a verified empty target index rather than
bypassing the migration. Source and connector mutations remain blocked from
snapshot through completion; ordinary chat keeps using the unchanged live
model/index while the separate index builds.

The status endpoints return only:

```json
{
  "phase": "building",
  "target_model": "nomic-embed-v2",
  "target_dimension": 1024,
  "source_count": 12,
  "chunk_count": 4200,
  "indexed_count": 1536,
  "error_code": null,
  "restart_required": false,
  "can_cancel": true,
  "can_retry": false,
  "can_apply": false
}
```

The status `GET` returns `200`; `retry`, `cancel`, and `apply` accept no body and
return the updated status with `202`.

Public phases are `idle`, `snapshotting`, `building`, `ready_to_apply`,
`apply_pending`, and `failed`. Retry is available only for a failed operation;
cancel removes only the positively owned staging directory and is unavailable
after the swap starts. Apply is accepted only from `ready_to_apply` and moves to
`apply_pending`, where new chat turns are gated. Borealis drains active turns
and executes the journaled swap live, pairs the new model/dimension settings
with the staged index, reopens vector storage, verifies its dimension and exact
row count, and runs a scoped retrieval smoke when the snapshot is nonempty.
SQLite and the HTTP server remain open; no restart is required for normal apply.
Startup crash recovery rolls forward or restores the old matched pair; every
recovery phase revalidates the persisted
provider identity and the resolved-model/dimension marker on every live,
staged, or backup index, and an embedding-model or dimension environment
override prevents acceptance of the installed target. No live index contains
mixed embedding identities. The previous index remains an exact migration
backup until the new runtime passes verification. Reverting after apply is
another managed migration, not a cancellation or manual vector-directory
deletion.

### Sources

| Endpoint                         | Request and response                                                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/sources`               | Paginated compact metadata rows with an optional `tabular` summary; no full dataset preview.                              |
| `POST /api/sources/status`       | Exact status for 1–50 unique owned UUIDs; returns compact `items` plus `missing_ids`.                                     |
| `POST /api/sources/upload`       | One multipart file, conventionally named `file`, without text fields; returns the reserved source and `processing: true`. |
| `POST /api/sources/:id/reingest` | No body; returns the source and `processing: true` after reserving a new ingestion generation.                            |
| `DELETE /api/sources/:id`        | Removes the owned source from the ledger and queues scoped artifact cleanup; returns `{"ok":true}`.                       |
| `GET /api/sources/:id/passages/:chunkId` | Owned current-chunk read: `{source,chunk{seq,content,locators},neighbors{before,after}}` with bounded neighboring text. |
| `GET /api/sources/:id/passages/:chunkId/neighboring-context` | Just the neighboring text at a bounded `context_chars` width (default 400, max 4,000). |

The passage routes back the source-search hit and the source passage panel.
They answer honestly about generation truth: `404` for a foreign or absent
source, and `410 PASSAGE_UNAVAILABLE` when the chunk was pruned or belongs to
a superseded generation — a passage is never silently re-resolved against the
newest content. Neighboring chunks come from the same source and generation
only (never across a generation boundary).

List entries contain `id`, `name`, `kind` (`document` or `tabular`),
`display_name`, `mime`, `size_bytes`, `status`, `created_at`, and `meta`.
`name` is the normalized dataset/source name, while `display_name` is the
upload's sanitized filename or the connector's display name. Optional `tabular` contains
`{table,original_name,rows}`. Source listing remains available if the data worker
cannot supply summaries. Upload/reingest responses also contain fields
such as `account_id`, `connector`, `url`, and `ready_generation`; no API
response exposes a local `file_path` — clients use the UUID, and durable
storage paths never leave the server.

Supported upload extensions are `.txt`, `.md`, `.markdown`, `.text`, `.log`,
`.pdf`, `.docx`, `.csv`, `.tsv`, `.xlsx`, `.parquet`, `.jsonl`, and `.json`.
The stored extension selects the parser; MIME metadata does not override it.
Legacy `.doc` and `.xls` files, including renamed OLE binary Office files, are
rejected with `422`; use `.docx` and `.xlsx` instead. XLSX ingestion is offline,
reads only the first worksheet, and checks archive expansion before parsing.
PDF ingestion extracts existing text first and classifies each page by bounded
text density. On macOS only, pages without meaningful embedded text are passed
in page order to a fixed local `/usr/bin/osascript` JXA helper backed by
PDFKit/Vision. Text pages are never re-OCRed, mixed PDFs remain usable if OCR is
unavailable, and there is no network fallback. Recognized text is labeled
`[Page n — OCR]`, then enters the same normalization, extraction, chunk, consent,
and embedding boundaries as other PDF text.

Uploads stream to disk under an account/source UUID directory, with the byte
limit enforced even if the multipart stream is truncated. The initial response
means ingestion is queued, not complete. Refresh the paginated head and poll the
known transitional UUID through `POST /api/sources/status` while a source is
`index`; stop on `ready`, `error`, or `missing_ids`. Transient processing failures
are retried automatically, for at most three total attempts. Reingestion uses
the saved file or connector cache; use connector sync to download a fresh URL
version.

On `error`, `meta` contains safe `error`, `error_code`, `error_detail`, and
`error_stage` fields. The list entry also includes
`ingestion: {attempts,updated_at}` (attempts are bounded to 0–100; the timestamp
can be `null`). Other source states return `meta: {}` in the list response.
Public failure codes are:

| Code                             | Stage       | Meaning                                                                |
| -------------------------------- | ----------- | ---------------------------------------------------------------------- |
| `NO_READABLE_TEXT`               | `reading`   | No extractable text or table rows.                                     |
| `OCR_UNAVAILABLE`                | `reading`   | A fully image-only PDF needs local macOS Vision OCR on this system.    |
| `OCR_FAILED`                     | `reading`   | Local OCR failed or exceeded a recognition-processing boundary.        |
| `UNSUPPORTED_FORMAT`             | `reading`   | The stored format cannot be processed.                                 |
| `DATASET_PARSE_FAILED`           | `parsing`   | Invalid tabular data.                                                  |
| `DATA_SERVICE_UNAVAILABLE`       | `parsing`   | Local data processing could not complete.                              |
| `REMOTE_EGRESS_CONSENT_REQUIRED` | `embedding` | The worker reached an unacknowledged remote provider before transport. |
| `EMBEDDING_UNAVAILABLE`          | `embedding` | The configured embedding service was unavailable.                      |
| `EMBEDDING_INVALID_RESPONSE`     | `embedding` | Invalid embedding output or incompatible vector dimension.             |
| `SOURCE_UNAVAILABLE`             | `storage`   | The stored input file could not be accessed.                           |
| `INGEST_FAILED`                  | `storage`   | Other processing failure, including unrecognized stored error codes.   |

Reingestion or deletion returns `409` when that exact source is in an active
run, or its connector is syncing/indexing. Unfinished cleanup is retained
durably for repair; `ok: true` confirms logical deletion, not secure erasure of
every backing file.

### URL connectors

- `GET /api/connectors` (paginated `{items,next_cursor}`)
- `POST /api/connectors/status` (1–50 exact UUIDs; `{items,missing_ids}`)
- `POST /api/connectors`
- `POST /api/connectors/:id/sync`
- `PUT /api/connectors/:id/schedule`
- `GET /api/connectors/:id/syncs`
- `DELETE /api/connectors/:id`

Creation accepts exactly:

```json
{
  "display_name": "Daily ledger",
  "target_table": "daily_ledger",
  "type": "url_csv",
  "config": { "url": "https://data.example/ledger.csv" }
}
```

`display_name` is trimmed to 1–120 Unicode characters. `type` is `url_csv` or
`url_json`; `target_table` accepts `^[A-Za-z][A-Za-z0-9_]{0,62}$`, is normalized
to lowercase, and must be unique within the account. `config.url` is an HTTP(S)
URL of at most 2,000 characters, without embedded credentials; fragments are
discarded. A collision with an existing source/table returns `409`.

The connector list uses the common cursor contract rather than truncating older
rows. List items and creation responses
contain `id`, `account_id`, `name`, `type`,
`config`, `target_table`, `last_sync`, `sync_status`, `sync_error`,
`created_at`, and `schedule`. Note that the input field is `display_name`, but
the response field is `name`. Sync success returns
`{"synced":true,"processing":true}`. Refresh the connector head and poll the
known transitional UUID through `/api/connectors/status` (plus its source):
`syncing` means download/preparation, `indexing` means ingestion is still
pending, `idle` means the generation was promoted, and `error` reports a
bounded failure. `last_sync` advances only after promotion.

`schedule` is the connector's derived refresh schedule — the connector's single
`connector_sync` automation: `{automation_id,schedule_minutes,state,next_run_at,last_run_at}`
or `null`. `PUT /api/connectors/:id/schedule` with
`{"schedule_minutes":15..10080|null}` creates, updates, or removes that
automation (idempotent on `null`) behind the remote-egress consent gate;
ambiguous legacy setups with multiple `connector_sync` automations on one
connector return `409` instead of guessing. The Automations surface remains
authoritative for the underlying rows. Deleting a connector deletes its
schedule automations and history with it.

`GET /api/connectors/:id/syncs?limit<=50` returns that connector's bounded,
content-free sync history, newest first (default 20):
`{id,trigger,outcome,detail,started_at,finished_at}` with `trigger` in
`create|manual|scheduled`, `outcome` in `succeeded|failed|skipped`, and
`detail` carrying only safe runner reason strings.

Connector creation durably reserves the connector before attempting its first
download. A `422` creation response still contains that connector's ID and
`sync_error`; do not assume the creation rolled back. A transient preparation
failure may continue retrying in the background, so inspect `sync_status` before
retrying. Explicit sync failures return `422 {"error":"Connector sync failed."}`.
Sync or deletion returns `409` while a sync is active or its source is in an
active chat run. Deleting a connector removes its linked sources; deleting the
connector's last source also removes the connector.

Downloads use DNS pinning, bounded redirects/time/bytes, and immutable cache
versions. Private, loopback, link-local, and otherwise unsafe destinations are
rejected on the initial URL and every redirect. A refresh stages and extracts the
candidate before activation; failed refreshes preserve the previous good
generation when one exists. The source is excluded from new turn snapshots
while it is `index`.

Connector-cache cleanup is exact-location and durable. Only filesystem `ENOENT`
proves that an immutable version is already absent; permission, I/O, symlink,
type, or real-path failures retain the cleanup job for retry. A stale URL dataset
reserves that exact location in `dataset_cache_cleanup_jobs` before DuckDB
deactivation, and the job resolves only after deletion or proven exact absence.
The containing UUID cache directory is removed when empty; already-absent and
still-nonempty are the only tolerated directory-removal outcomes. Cleanup logs
contain aggregate counts, never connector IDs, paths, or raw filesystem errors.

### Connections (Connected agents — implemented in this wave)

The connection ledger (schema v17), server-side secret custody, the management
endpoints below, the real Streamable HTTP and stdio transports, and the OAuth
sign-in lifecycle (`server/src/mcp/oauth.ts` plus the backend-owned loopback
callback listener in `server/src/mcp/oauthCallback.ts`) are implemented and
green-tested in this wave of `docs/MCP_CONNECTIONS.md` (`test`/`discover` run
real bounded initialize/list-tools probes; `authorize`/`authorization` run the
real authorization-code flow with PKCE against the committed issuer fixture).
All OAuth calls use the pinned SDK's supported client auth layer
(`@modelcontextprotocol/sdk` 1.30.0 `client/auth.js` primitives; negotiated MCP
protocol version `2025-11-25`). The stage-4 backend is now shipped on top of
this foundation: agent connected-tool bindings, the frozen per-turn snapshot
in `chat_runs.agent_mcp_tools` (schema v21), MCP tool dispatch inside durable
chat turns, and the versioned job-setup contracts documented below and under
"Agent tools". The stage-5 surface is shipped as well: the Settings →
Connections panel, the agent-editor Connected and Job tabs, the
chat-creation-from-job confirmation, and the packaged-desktop custody variant
where Electron main owns the `safeStorage`-sealed key and verifies one-time
system-browser open intents (the loopback callback listener stays
backend-owned on both platforms). This section documents the shipped contract;
journey A in the product acceptance harness exercises this integration.

Transport behavior: HTTP connections accept a full endpoint path, require HTTPS
except explicitly configured loopback/`.local` development targets, pin the
validated DNS answer for each socket, and never follow redirects — credential
headers are attached only to the exact validated endpoint origin and therefore
can never ride a redirect. stdio connections spawn the configured absolute
executable directly without a shell with an explicit environment (credential
environment entries come only from secret custody); protocol stdout goes only to
the SDK parser, stderr is drained and discarded, and every child is owned:
disconnect, cancellation, and application shutdown end the child with bounded
TERM→KILL escalation and a pid-gone proof. One client is opened per probe
operation; no long-lived pooled child exists, and the application runtime's
shutdown drains any still-live connection session alongside the other owned
drains. A `401` from the endpoint is the actionable
`409 CONNECTION_AUTH_REQUIRED` disconnected state, never a raw provider error.
When an HTTP connection holds sign-in material, each probe attaches a
fresh-or-refreshed `Authorization: Bearer` token bound to the exact authorized
target: refresh is serialized per connection (one rotation in flight), the
stored material must name the connection's current endpoint (a config edit can
never inherit the old endpoint's grant), the refresh token rotates per the
issuer's policy, expired token material is cleared rather than persisted, and a
failed renewal is the actionable `409 CONNECTION_AUTH_REFRESH_FAILED`
disconnected state. OAuth custody material (the reserved `MCP_OAUTH_*`
environment namespace inside the same encrypted record) is never passed into a
stdio child environment.

Sign-in is authorization-code flow with PKCE (S256), one-use state, a
five-minute session window, and RFC 8707 resource binding to the exact MCP
endpoint. `authorize` performs RFC 9728/8414 discovery (a protected-resource
document names the issuer; otherwise the endpoint origin is probed as a
co-located issuer), honors a configured client id/secret from custody first,
and otherwise uses RFC 7591 dynamic registration when advertised. Issuer
metadata is fetched through the same connection-boundary resolver as the
transport (DNS-pinned, no redirects, byte- and time-bounded). The browser is
sent to the returned `authorize_url` only after the sign-in click; the issuer
redirects to a backend-owned loopback listener (`127.0.0.1`, OS-assigned port,
`GET /callback` only, static notices, no reflected data, no session
credentials, replay-refusing) that performs the code+PKCE exchange and stores
tokens in custody. Durable observable sign-in states recorded on the
connection's bounded status are: session expired (`disconnected`,
`CONNECTION_AUTH_SESSION_EXPIRED`), user denial (`disconnected`,
`CONNECTION_AUTH_DENIED`), callback replay (`disconnected`,
`CONNECTION_AUTH_REPLAY_DETECTED`), exchange failure (`disconnected`,
`CONNECTION_AUTH_FAILED`), successful sign-in (`untested`, null — run `test`
or `discover` to confirm the endpoint), and failed renewal/provider logout
(`disconnected`, `CONNECTION_AUTH_REFRESH_FAILED`, with dead token material
cleared and the client registration retained for reconnect).

| Endpoint | Contract |
| --- | --- |
| `GET /api/connections` | Keyset `{items,next_cursor}` catalog of the account's connections, newest first. |
| `POST /api/connections` | `{name,kind,config,enabled?,credentials?}`; validates and stores configuration and credentials only — it never discovers or executes tools. Name 1–80 characters, unique per account; maximum 20 connections per account; returns `201` with the redacted detail. |
| `GET /api/connections/:id` | Redacted detail including the current discovery's `tools`; never includes credential material. |
| `PATCH /api/connections/:id` | Requires `expected_revision` (a stale value returns `409 CONNECTION_REVISION_CONFLICT`). Optional `name`, `config`, `enabled`, and `credentials`: an object fully replaces stored credentials, `null` removes them, omission leaves them untouched. A name or config edit increments `revision` and resets the bounded status to `untested`; an `enabled` toggle never changes the revision. |
| `DELETE /api/connections/:id` | Disconnects (removes the credential record), deletes the connection, cascades its tool snapshots, and runs the agent-binding cascade hook so agent bindings become visibly unavailable. |
| `POST /api/connections/:id/test` | One bounded initialize/list-tools probe; no content-bearing tool call. Returns the refreshed detail with `status: "ready"` on success. |
| `POST /api/connections/:id/discover` | Same bounded probe, then publishes the validated tool snapshot and returns the detail with the new `discovery_revision` and `tools`. |
| `POST /api/connections/:id/authorize` | Starts one expiring (`expires_at`, five minutes) one-use PKCE sign-in session and returns `{authorize_url,expires_at}` for the validated sign-in action. `mcp_http` connections with OAuth-capable issuers only; others get the actionable `501 CONNECTION_AUTH_UNSUPPORTED`, and an unreachable issuer metadata endpoint is `502 CONNECTION_AUTH_DISCOVERY_FAILED` — never a fake success. A pending session is replaced (silently) by a newer `authorize`. |
| `DELETE /api/connections/:id/authorization` | Revokes local credentials (removes the custody record, cancels any pending sign-in session), marks the connection `disconnected`, and returns the detail; provider-side revocation of the stored access/refresh tokens at the issuer's RFC 7009 endpoint is best effort. |

All routes authenticate in `onRequest` before body parsing and are strictly
account-scoped (a foreign or unknown ID is `404`). `kind` is `mcp_http` or
`mcp_stdio`; the implemented M14 WebDAV adapter registers through the same
kind-adapter seam with its own migration. `config` is validated against a strict
kind-specific shape and holds only non-secret material: `mcp_http` accepts exactly
`{url}` (a full endpoint path is allowed; HTTPS is required except for explicitly
configured loopback/`.local` targets; URL credentials, query, and fragment are
rejected), and `mcp_stdio` accepts `{command,args?,cwd?}` — an absolute installed
executable, at most 32 arguments of 200 characters, and an optional absolute working
directory, spawned without a shell and never through a package runner. Test and
discover operations are hard-bounded at 15 seconds.

Stable `CONNECTION_*` codes carry fixed generic public messages:
`CONNECTION_NOT_FOUND` `404`, `CONNECTION_CONFIG_INVALID` `400`,
`CONNECTION_NAME_TAKEN` `409`, `CONNECTION_REVISION_CONFLICT` `409`,
`CONNECTION_LIMIT_REACHED` `409`, `CONNECTION_DISABLED` `409`,
`CONNECTION_INVALID_STATE` `409`, `CONNECTION_AUTH_REQUIRED` `409`,
`CONNECTION_AUTH_UNSUPPORTED` `501`, `CONNECTION_AUTH_DISCOVERY_FAILED` `502`,
`CONNECTION_AUTH_REFRESH_FAILED` `409`, `CONNECTION_CUSTODY_UNAVAILABLE` `503`,
`CONNECTION_TRANSPORT_UNAVAILABLE` `503`, `CONNECTION_HANDSHAKE_FAILED` `502`,
`CONNECTION_DISCOVERY_OVER_LIMIT` `502`, `CONNECTION_DISCOVERY_INVALID` `502`,
`CONNECTION_TIMEOUT` `504`. Provider error bodies, endpoint failures, and credential
material never reach the client. The durable-only sign-in status codes
(`CONNECTION_AUTH_SESSION_EXPIRED`, `CONNECTION_AUTH_DENIED`,
`CONNECTION_AUTH_REPLAY_DETECTED`, `CONNECTION_AUTH_FAILED`) surface as
`status_code` evidence on the detail DTO.

Discovery snapshots are budgeted at 200 tools, 16 KiB per descriptor, and 512 KiB per
catalog; an over-budget or malformed catalog is an explicit
`CONNECTION_DISCOVERY_OVER_LIMIT`/`CONNECTION_DISCOVERY_INVALID` failure that keeps the
previously published snapshot intact. Tool identities are stable per connection across
rediscoveries, and `connections.discovery_revision` advances only on a published
snapshot.

Credential material — including every OAuth token, client id/secret, issuer,
resource, and callback binding produced by sign-in — is separated from every
ledger row and DTO: it crosses only from a request body into secret custody or
from custody into a transport, and tokens never enter agent revisions or run
metadata. Browser development
stores AES-256-GCM records under `<data dir>/secrets/<account>/<connection>.json`
(mode `0600`, atomic rename, no symlink following, each record cryptographically bound
to its account/connection scope) sealed by an operator-managed private key at
`<data dir>/connections.key` (mode `0600`, generated once); the
`CONNECTION_SECRETS_DIR` and `CONNECTIONS_KEY_FILE` overrides relocate them. Packaged
desktop keeps the identical encrypted record layout but replaces the key provider: the
main process owns a `safeStorage`-sealed data key and answers only schema-checked
`read`/`ensure` custody requests over the utility-process port, and opens a sign-in
link only after verifying the one-time open intent minted for that exact URL. Missing
or unreadable custody never crashes a request and never yields plaintext: reads report
`credential_state: "unavailable"`, and a test/discover attempt records a `disconnected`
status with `CONNECTION_CUSTODY_UNAVAILABLE` until credentials are replaced or removed.
These durable paths are machine-bound and never archived: workspace archives
intentionally exclude the `secrets/` namespace and `connections.key`, and a
restore re-enters every previously attested connection state through an
explicit actionable transition (see
[Storage and workspace archives](#storage-and-workspace-archives)).

#### Connected tools in durable chat turns (stage 4, schema v21)

Agent revisions may select connected tools through a dedicated `mcp_tools`
collection that is separate from `tools` (which keeps its exact built-in-only
meaning for old clients). Each binding is
`{connection_id, tool_id, discovery_revision, allow_write?}` — at most 16 per
agent — and is validated inside the agent create/patch transaction: the
connection must exist for the account and be enabled, the tool must be present
in the connection's current published discovery snapshot, its captured input
schema must pass the strict schema-support gate (unsupported shapes are
refused at selection and never advertised as callable), and a tool the
conservative descriptor classifier flags as write-oriented requires the
explicit per-binding `allow_write: true` acknowledgement. Read-oriented
default-deny is this wave's policy, and a server's `readOnlyHint` annotation
is never trusted as proof either way.

Turn acceptance captures the frozen per-run mapping in the same SQLite
transaction as the message and run row (`chat_runs.agent_mcp_tools`, a
JSON array capped by the store at 400,000 characters with a wider durable
schema CHECK): `{alias, connection_id, tool_id, discovery_revision, name,
description, input_schema, authorization_reference}`. The alias is the
deterministic opaque model-facing name `mcp_<32 hex>` derived from the
(connection, tool) pair — stable across selections and orderings, unique
within a revision, and the only form the provider and SSE stream ever see.
`authorization_reference` is a non-secret custody identity: `absent`,
`oauth:<digest>` over the stable sign-in entries (volatile token and expiry
entries are excluded, so a serialized refresh keeps the same authorized grant
identity), or `secret:<digest>` over the static credential set. Tokens,
endpoints, and credential values never enter the column, message metadata, or
SSE; acceptance fails closed when a binding's live custody state cannot be
captured as a usable reference.

Dispatch is enforced per call, not per turn: before each execution the server
re-checks that the connection still exists and is enabled and that live
custody still yields the captured reference, so revocation, credential
replacement, or disabling blocks the NEXT call while the turn itself
continues. A refused or failed call reaches the model only as
`{"error":"CONNECTION_*"}` (stable code) and the UI only as one of the fixed
sanitized step summaries. Arguments are validated against the frozen captured
schema — a discovery refresh mid-run changes neither the frozen descriptor
nor what validates the model's arguments — and the call runs with the 30-second
tool deadline bounded inside the run budget, with 32 KiB argument and 64 KiB
result ceilings enforced as explicit failures rather than truncation.
Non-text content blocks are reported explicitly and never auto-fetched. The
model receives only the server-normalized `{ok,text,unsupported_content?}`
result marked as untrusted external content. Completed runs are durable
history: a restart never replays an external tool call, and startup recovery
only fails interrupted runs.

#### Jobs: versioned job setup and chat creation from a job

The same agent configuration carries an optional `job_setup` block:
`{starter_prompts: string[] (≤5, 2,000 characters each), output_template:
{kind:"instruction", instruction: ≤8,000 characters} | null, library_ids:
string[] (≤10 owned UUIDs)}`. `output_template` also accepts
`{kind:"template_id", template_id: UUID}` for a built-in or account-owned M13
document template. Selection is validated in the agent save transaction. On
message acceptance, the server resolves the template’s title, subtitle, headings,
and instruction text into the frozen agent prompt; no charts, data tables,
evidence envelope, or source bindings are copied. The rendered structure must
fit the 8,000-character template budget and the combined instructions/skills/
template prompt must fit 32,000 characters. Missing, deleted, or foreign templates
fail with an actionable agent-configuration error before a message/run is written.
Existing instruction variants remain supported and are captured the same way.
Job edits affect the next accepted turn only; no template is read during a run.
Template selection does not create or publish a document automatically.

| Endpoint       | Contract                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------ |
| `GET /api/jobs` | The two bundled editable starter jobs (finance analysis, diligence memo) as seedable server-served definitions: name, description, icon, color, instructions, built-in `tools`, and `job_setup`. They carry no implicit attached data (`library_ids: []`) and require no remote service (no `mcp_tools`). A user edits one by seeding it through `POST /api/agents` — afterwards it is an ordinary versioned agent. |

`POST /api/chats` accepts an optional `job` block,
`{suggested_library_ids: string[] (≤10, owned)}` (or `job: {}`). The server
validates the libraries (unknown or foreign ids return `400`), expands them
into the explicit READY source ids in stable selected-scope order through the
normal selected-scope contract, and returns the created chat plus a `job`
projection `{starter_prompts, output_template, suggested_library_ids,
suggested_source_ids}` — prompts and template come from the bound agent's
`job_setup` and are only returned to the client. The server never sends a
message because of a job; job-based creation creates no run or message. The
new chat stays `selected` with no attached sources until the user confirms
the expanded list (an explicit `source_mode`/`source_ids` in the same request
is the confirmed scope and is honored). Expansion never falls back to `all`
and never truncates: more than 100 distinct ready sources fails with
`409 JOB_SCOPE_LIMIT` and creates no chat.

### Reports and charts

| Endpoint                    | Response                                                                                                                                                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/reports`          | Paginated `{items,next_cursor}` of `{id,title,subtitle,chat_id,chat_title,created_at,updated_at,version,supersedes}`, newest first; no filesystem paths or payloads.                                                            |
| `GET /api/reports/:id`      | `{id,title,subtitle,created_at,updated_at,has_html,has_pdf,version,supersedes}`; owner detail adds `payload` when available. Shared detail adds `shared_by_account:true` and never includes `payload`. |
| `PATCH /api/reports/:id`    | Body `{title}` (1–200 chars); returns the renamed report DTO.                                                                                                                                                                   |
| `GET /api/reports/:id/html` | Self-contained `text/html`, readable by the owner and current share recipients through the owner's storage scope. |
| `GET /api/reports/:id/pdf`  | `application/pdf` attachment with a `%PDF-` signature, readable by the owner and current share recipients through the owner's storage scope. |
| `DELETE /api/reports/:id`   | `{"ok":true}`, or `503 {"error":"report cleanup deferred"}` if physical cleanup must retry.                                                                                                                                     |
| `GET /api/charts`           | Array of `{id,run_id,chat_id,title,kind,created_at}` for published charts, newest first, bounded to 200; no spec echo or PNG bytes.                                                                                             |
| `GET /api/charts/:id`       | `{id,spec,echarts,png_base64}`.                                                                                                                                                                                                 |
| `POST /api/charts/:id/png`  | No body; JSON `{png_base64}`, not raw PNG bytes.                                                                                                                                                                                |

Reports carry per-chat lineage: the first published report for a chat is
`version 1`; each later report the agent creates in the same chat takes the
next version and names the report it `supersedes`. Versions count published
reports only — pending artifacts from failed or discarded runs never join the
chain — and superseded reports are never deleted automatically. The stored
payload is the normalized report document (sections, resolved chart specs,
tables); it is omitted when its serialized JSON exceeds 400,000 characters and
is never included in list responses.

The agent's `render_chart` and `create_report` tools create artifacts; there are
no public creation endpoints. Charts/reports remain private to their pending
run until the assistant message and successful run completion commit together.
Unowned, missing, or pending artifacts return `404`. Missing HTML/PDF exports
and PNG export requests without a stored PNG also return `404`; the chart JSON
itself can contain `png_base64: null`. Report deletion hides it before
filesystem cleanup; a deferred cleanup response does not make it visible again.
Each published chart retains the run and chat that actually staged it; report
assembly accepts only charts owned by that same run, so artifact lineage cannot
be reassigned by a model-supplied or stale provenance field.

Report HTML is self-contained and served with a restrictive CSP. PDF rendering
accepts only the structured report payload generated by Borealis and uses a
data-only resource loader; it cannot read local files or fetch network resources.
Chart responses reuse the PNG generated with the canonical chart spec rather
than rendering a second time. Browser development uses isolated Playwright
Chromium. The packaged app sends the same bounded document to a hidden Electron
window; Playwright's browser download is not present in the application bundle.

The canonical chart spec has `type`, `title`, `subtitle`, `categories`, `series`,
`items`, `x_label`, and `y_label`. Supported types are `line`, `bar`, `area`,
`scatter`, `pie`, and `donut`. Cartesian charts use string categories and series
`{name,data,color}` with matching lengths. Pie/donut charts use
`{name,value,color}` items with nonnegative values and a positive total. Stored
colors are canonical six-digit hex values; missing or invalid input colors use
the Borealis palette. Numeric values are finite and bounded.
[charts.ts](../server/src/data/charts.ts) is the shared contract for stored
charts, the UI, report HTML, and both static renderers.

### Saved analyses (shipped in the M12 wave)

Owner-scoped saved queries with typed parameters, durable runs, immutable
result snapshots, bounded comparison, and stored-snapshot export. All routes
authenticate in `onRequest` before parsing, use keyset pagination with
endpoint-bound cursors (`analyses`, `analysis_runs`, `analysis_results`), and
expose stable `code` values on failures.

| Endpoint | Contract |
| --- | --- |
| `GET /api/analyses` | Paginated `{items,next_cursor}` of `{id,title,description,current_revision,source_count,unavailable_source_count,created_at,updated_at}`, newest first. |
| `POST /api/analyses` | Body `{title,description?,sql,parameters?,source_ids?,comparison_key?}`; `201` with the full definition DTO. `source_ids` presence is the explicit selected set — an empty array stays selected-empty and never widens. |
| `GET /api/analyses/:id` | Definition at the current revision, parameter declarations, origin provenance ids, and source bindings (`ready_generation`, `content_identity`, `unavailable_at`). |
| `PATCH /api/analyses/:id` | Body requires `expected_revision`; the optimistic head CAS commits a new immutable revision in one transaction. `comparison_key: null` clears the key; omitting `source_ids` preserves the set. Lost races return `409 ANALYSIS_REVISION_CONFLICT`. |
| `DELETE /api/analyses/:id` | Requests durable cancellation of an active run and retries the owned deletion within a bounded drain window; `{"ok":true}` on success, `409 ANALYSIS_ACTIVE_RUN` when an executor has not yet drained. Copied report/document snapshots survive. |
| `POST /api/analyses/from-query` | Promotes only a persisted, verified full-query capture: `{capture_id,title,description?,comparison_key?}`. Sources come from the capture's exact ready provenance. Missing captures (legacy display receipts) return `404 ANALYSIS_CAPTURE_NOT_PROMOTABLE`; a deleted captured source returns `409 ANALYSIS_INPUTS_UNAVAILABLE`. |
| `GET /api/analyses/:id/runs` | Paginated run summaries, newest first. |
| `POST /api/analyses/:id/runs` | Body `{values?,operation_id?,expected_revision?}`. Acceptance freezes the revision, typed bindings, and concrete ready source generations in one transaction and returns `202 {outcome,run}` (`queued`/`replayed`/`stale-inputs`). A retried operation UUID replays the original run. `409 ANALYSIS_ACTIVE_RUN` for one-active violations, `409 ANALYSIS_RESULT_QUOTA_EXCEEDED` before execution at 1,000 retained results, `400 ANALYSIS_VALIDATION` for undeclared/missing/mistyped values, `503` when no executor is registered. Execution of a `queued` run awaits startup dataset-registry rehydration for at most the fixed 15 s bound before evaluating pinned inputs; deadline exceedance still applies honest durable `stale-inputs`. |
| `GET /api/analyses/:id/runs/:runId` | Exact run state including frozen parameter bindings and source provenance. |
| `DELETE /api/analyses/:id/runs/:runId` | Idempotent cancellation request; terminal states are absorbing and repeated calls return the same `{ok:true,status}`. |
| `GET /api/analyses/:id/results` | Paginated immutable result summaries (never raw rows). |
| `GET /api/analyses/:id/results/:resultId` | Full stored snapshot: columns with scalar types, rows, completeness flags/reasons, parameter values, source provenance, and timestamps. |
| `DELETE /api/analyses/:id/results/:resultId` | Explicit retained-result deletion; copied document snapshots survive. |
| `GET /api/analyses/:id/compare?left=…&right=…` | Deterministic bounded comparison: parameter, source-version, and schema diffs always; with the configured 1–3-column comparison key, added/removed/changed rows and numeric deltas from stored finite values. Duplicate/missing key cells or a changed stored column type return `mode:"side-by-side"` with an explicit `reason_code`; without a key the payload is side-by-side only. Truncated inputs are labeled previews and never claim exhaustive totals. |
| `GET /api/analyses/:id/results/:resultId/export?format=csv\|json\|manifest` | Stored-snapshot-only download with an explicit `Content-Disposition` filename (partial CSV exports get a `-partial` suffix and a leading `#` comment line). CSV escapes fields and prefixes formula-leading strings with `'`; JSON preserves scalar types; the manifest is provenance-only. No query executes on this path. |
| `GET /api/analyses/:id/results/:resultId/chart` | Canonical chart-spec copy bound to the result id, computed from the stored snapshot through the canonical chart contract (`bar` chart: first textual column as categories, numeric columns as bounded series). Not a stored chat-run artifact; `400 ANALYSIS_RESULT_NOT_CHARTABLE` when the snapshot has no plottable columns. |

Definitions bound: title 200, description 2,000, SQL 20,000 characters; at most
20 scalar parameters (`string`, finite `number`, safe `integer`, `boolean`, real
ISO `date`; string values ≤ 2,000 characters) with positional `?` binding
executed by the DuckDB prepared-statement path; at most 100 explicitly selected
source ids; optional 1–3-column comparison key. Persisted results are capped at
500 rows, 64 columns, 20,000 cells, 2,000 characters per string cell, and 1 MiB
UTF-8 payload — whichever binds first — with truthful truncation flags; a
zero-row result is a success, and an exact row count is claimed only when the
worker established the total.


### Documents, rewrites, publication, exports, and templates (M13)

Owner-scoped editable documents with immutable, append-only revisions
(schema v20/v22/v23). All routes require authentication; every identifier is a
UUID and every catalog uses keyset pagination. Responses never include
filesystem paths.

| Endpoint                                                | Contract                                                                                                                                                                                                                                     |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/documents`                                    | Paginated `{items,next_cursor}` of `{id,title,current_revision,current_revision_id,head_author_kind,origin,latest_publication_version,revision_count,created_at,updated_at}`, newest first.                                                   |
| `POST /api/documents`                                   | Exactly one creation shape: `{title?}` (blank draft), `{title?, template_id}` (instantiate a template — never auto-binds sources or data), `{tree}` (explicit tree), or `{copy_from_report_id}` (editable copy of an owned published legacy report). `201` with `{document,revision}`. A payload-less legacy report answers `409 {"code":"DOCUMENT_UNAVAILABLE"}`; missing/foreign/pending reports answer `404`. |
| `GET /api/documents/:id`                                | Document metadata and head pointer as in the list row, plus `publication_status` — the latest attempt `{operation_id,revision_id,revision,status,updated_at,error_code}` with `status` `rendering\|ready\|completed\|failed`, or `null`. No artifact paths. |
| `DELETE /api/documents/:id`                             | `{"ok":true}`; reserves and eagerly completes durable artifact cleanup, `503 {"error":"document cleanup deferred"}` keeps the intent durable. Revisions cascade; legacy reports, chats, and sources are untouched.                            |
| `GET /api/documents/:id/revisions`                      | Paginated revision summaries `{id,revision,title,author_kind,base_revision_id,payload_chars,published_version,created_at}`, newest first.                                                                                                     |
| `POST /api/documents/:id/revisions`                     | Body `{base_revision_id,tree}`. `201` with `{document,revision}`. A stale base answers `409 {"code":"DOCUMENT_REVISION_CONFLICT","current_head":{revision_id,revision,title,author_kind,updated_at}}` and writes nothing; the server never merges. Oversize/invalid trees answer `400` with `DOCUMENT_OVERSIZE`/`DOCUMENT_INVALID` and persist nothing. |
| `GET /api/documents/:id/revisions/:revisionId`          | `{id,document_id,revision,title,author_kind,base_revision_id,payload,payload_chars,created_at}` — the immutable full snapshot.                                                                                                                |
| `GET /api/documents/:id/diff?base=…&target=…`           | Deterministic bounded diff of two revisions of the same document (structure by stable section UUID: added/removed/moved/modified; line-level unified text diff per modified section; chart/table/evidence summaries). Bounds surface through `truncated` flags. Identical revisions produce empty diffs; the same pair always yields byte-identical output. |
| `POST /api/documents/:id/rewrites` | Body `{base_revision_id, section_id, range_start?, range_end?, selection_sha256, instruction}` — `instruction` ≤2,000 characters, `selection_sha256` the lowercase hex SHA-256 of the selected text in the exact base revision (whole section when the range is omitted; `range_start`/`range_end` are UTF-16 half-open bounds). The remote-egress consent gate answers `403 REMOTE_EGRESS_CONSENT_REQUIRED` before any persistence. `202` with the queued operation. Server-side verification rejects a hash mismatch `409 DOCUMENT_REWRITE_SELECTION_MISMATCH`, an invalid or surrogate-split range `400 DOCUMENT_REWRITE_SELECTION_INVALID`, and a selection over 8,000 characters `400 DOCUMENT_REWRITE_SELECTION_OVERSIZE` (a whole section over the bound requires a smaller selection), persisting nothing. One active rewrite per document: `409 DOCUMENT_REWRITE_ACTIVE`. 100 retained proposals per document: `409 DOCUMENT_REWRITE_QUOTA_REACHED` until one is explicitly deleted. |
| `GET /api/documents/:id/rewrites` | Paginated operations `{id,document_id,base_revision_id,section_id,range_start,range_end,selection_sha256,selection_chars,instruction,status,replacement,evidence_refs,model,error_code,error_reason,cancel_requested,applied_revision_id,created_at,started_at,finished_at,updated_at}`, newest first. `status` is `queued\|running\|completed\|failed\|cancelled\|stale`. |
| `GET /api/documents/:id/rewrites/:rewriteId` | One operation as above. Stale and failed rows stay inspectable forever. |
| `DELETE /api/documents/:id/rewrites/:rewriteId` | Active operations cancel durably: `{"ok":true,"action":"cancelled"\|"cancelling","rewrite":{…}}` (`cancelling` finalizes `cancelled` when the running model call observes the flag). Terminal proposals are explicitly deleted: `{"ok":true,"action":"deleted"}`; deletion is what frees a quota slot. |
| `POST /api/documents/:id/rewrites/:rewriteId/accept` | Revision-CAS acceptance. `201` with `{document,revision,rewrite}` — one new draft revision (`author_kind:"model"`) created only while the proposal's base revision is still the head and the stored selection still matches byte-for-byte. A changed head/selection marks the proposal durably `stale` and answers `409 {"code":"DOCUMENT_REWRITE_STALE","current_head":{…}}`; a `stale` proposal can never be applied. Re-acceptance answers `409 DOCUMENT_REWRITE_ALREADY_APPLIED` (application is one-shot). Non-completed rows answer `409 DOCUMENT_REWRITE_STATE`. |
| `GET /api/documents/:id/publications`                   | Paginated owner publication history `{id,document_id,revision_id,revision,version,title,supersedes,created_at}`, newest version first — completed publications only; the in-flight/failed attempt state rides `publication_status` on the document detail. No artifact paths. |
| `POST /api/documents/:id/revisions/:revisionId/publish` | Body `{operation_id, expected_revision_id?, allow_non_head_revision?}`. Compiles the frozen revision into all four export formats through the bounded renderer pipeline into the exact account/document/publication directory, verifies every magic byte, and transactionally assigns the next per-document version only after all required artifacts exist. `operation_id` (UUID) is idempotent: a retry of a completed operation returns `200 {"status":"published","replayed":true,publication}` — never a second publication; a new completion answers `201`. The default action publishes the head and requires the head to be unchanged (`409 DOCUMENT_REVISION_CONFLICT` on a stale `expected_revision_id`, `409 DOCUMENT_HEAD_MOVED` if the head moved between render start and completion). Publishing a non-head revision requires `allow_non_head_revision:true` (`409 DOCUMENT_REVISION_SELECTION` without it). One active render/publication per document: `409 DOCUMENT_PUBLICATION_ACTIVE`; an in-flight same-operation replay answers `202 {"status":"rendering",publication_status}`. Missing/foreign document or revision answers `404`. A per-format failure answers `502` with `PUBLICATION_HTML_FAILED\|PUBLICATION_PDF_FAILED\|PUBLICATION_MARKDOWN_FAILED\|PUBLICATION_DOCX_FAILED\|PUBLICATION_RENDER_FAILED`, records a durable retryable failure, and leaves the draft, head, and previous publication untouched. Startup recovery turns interrupted renders into durable `SERVER_RESTARTED` failures and cleans their exact partial directories; it never auto-publishes. |
| `GET /api/documents/:id/publications/:publicationId/export?format=html\|pdf\|markdown\|docx` | Serves the exact frozen artifact bytes of that publication version, owner-only (`404` for foreign accounts, missing publications, or vanished artifacts). `html` is the self-contained static document (inline styles, embedded chart PNGs, report CSP, no external references); `pdf` the static PDF; `markdown` a ZIP bundle (`document.md` with relative chart assets, `manifest.json` provenance, `assets/chart-N.png` — no remote references, no absolute paths); `docx` native OOXML (headings, paragraphs, tables, embedded PNGs, evidence appendix — no macros or linked media). Every format compiles from the same frozen revision and carries the deterministic evidence appendix and validity state. |

Document trees carry `title` (≤200), `subtitle` (≤500), `verified`, at most
20 sections with stable document-local UUIDs (`heading` ≤200,
`markdown` ≤50,000 and 200,000 total characters — the evidence appendix is
charged against the same budget at save time), at most 20 canonical charts,
8 tables (60 rows, 32 columns, 500-character cells), and the versioned
evidence contract (≤100 references, 800-character excerpts, 100,000
serialized characters; `generation`/`content_identity` are server-verified
numbers or the literal `"unknown"` — never invented). The evidence-inclusive
serialized revision is bounded at 400,000 characters; the parser transport
ceiling is 2,531,072 bytes. An oversize tree is rejected with
`DOCUMENT_OVERSIZE` — unlike optional legacy report payloads, a document
never silently drops its tree. `author_kind` is server-assigned; HTTP saves
are always `user`.

Publication compiles one frozen revision through the shared report contract —
the existing renderer bounds (20 sections, 200,000 section-Markdown characters,
20 charts, 8 tables with their row/column/cell limits) plus the shared versioned
appendix fields: an optional evidence `appendix` (≤150,000 characters, rendered
as a final bounded block) and an optional validity `status` line (≤300
characters) shown in every format and in the masthead. The evidence appendix
numbers entries deterministically by revision position and marks each one
provenance verified or unknown; unresolved citation tokens stay plain text in
every export. All four artifacts are produced from the same tree in one
compile: self-contained static HTML and static PDF through the existing
Playwright/Electron bounded renderer backends (deny-by-default network policy
unchanged), a Markdown ZIP bundle (real `.md`, relative `assets/chart-N.png`
canonical PNGs, `manifest.json` provenance; no remote references, absolute
paths, or macros), and DOCX through the pinned `docx` writer (native
paragraphs/headings/tables, embedded PNGs, citations appendix; no macros or
linked media). Markdown and DOCX outputs are bounded at 20 MiB each, and every
artifact is magic-byte validated (`%PDF-`, PNG, ZIP, and the OOXML part list)
before the publication is recorded. A 20-section revision plus its appendix
always compiles because the appendix rides its own separately bounded field
rather than a 21st section.

A rewrite is one durable model operation with exactly one bounded provider
call and no tools. Its prompt carries only the selection re-derived from the
immutable base revision and that revision's copied evidence context (≤24,000
characters), never the whole workspace; the response is replacement text only,
bounded at 20,000 characters — empty or over-bound output fails the run with
the generic `DOCUMENT_REWRITE_OUTPUT_REJECTED`. Execution re-uses the
account-authorized provider runtime: the exact consent target is re-authorized
immediately before the single transport, so a remote provider that lost
acknowledgment records `REMOTE_EGRESS_CONSENT_REQUIRED` without any transport,
and content sent to a remote provider rides the same content-free `remote_turn`
egress audit event as chat traffic. Instructions, selections, replacements,
provider reasoning, and provider exception bodies never reach logs or other
accounts. Restart or shutdown interrupts an in-flight call and settles the row
`failed` with `SERVER_RESTARTED`; the provider call is never replayed and a
fresh request is required. Cancellation is the durable DELETE-side flag
observed at the transport boundary, and the store's cancellation-wins status
CAS ensures a cancelled run never stores a proposal. Evidence references
copied from the base revision ride `evidence_refs` and flow through unchanged
when the accepted proposal creates its model-authored revision.

Templates come in two kinds. `GET /api/document-templates` lists the three
built-in structure-only templates as server constants (`Monthly financial
brief`, `Evidence memo`, `Comparison report`; `built_in: true`, no
`revision`) followed by the paginated custom catalog (`built_in: false`, with
`revision`). A snapshot copies structure only — `title`, `subtitle`, and each
section's `heading`/`markdown` — and the codec (`server/src/documentTemplates.ts`)
rejects any other key, so evidence excerpts, source identities/bindings,
numeric table results, chart values, analysis provenance, and credentials can
never enter a stored snapshot. Applying a template instantiates a fresh
unverified draft with new section UUIDs and no attachments.

| Endpoint                             | Contract                                                                                                                                  |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/document-templates`        | Built-ins first, then the caller's paginated custom templates.                                                                            |
| `POST /api/document-templates`       | Body `{name,description?,document_id}` snapshots the document's current head through the codec. `201`. Quota: 100 per account (`409 DOCUMENT_TEMPLATE_QUOTA_REACHED`); duplicate names `409 DOCUMENT_TEMPLATE_NAME_TAKEN`. |
| `GET /api/document-templates/:id`    | Built-in by its fixed UUID or an owned custom row; anything else `404`.                                                                   |
| `PATCH /api/document-templates/:id`  | Body `{expected_revision, name?, description?}`. A stale revision answers `409 {"code":"DOCUMENT_TEMPLATE_CONFLICT","current_revision":N}`. Built-ins answer `409 BUILTIN_TEMPLATE_IMMUTABLE`. |
| `DELETE /api/document-templates/:id` | Body `{expected_revision}`; same conflict/immutable codes. `{"ok":true}`.                                                                 |

### Local research (shipped in the M15 wave)

Owner-scoped durable research definitions, runs, evidence dossiers, and typed
comparison tables (schema v25), with a dedicated Research workspace. The API provides persistence, Start
admission, bounded editable plan proposals, durable execution, dossier reads,
review (including per-cell corrections with overlay provenance and rerun
selection), the changed-cell revision diff, page-local sort/filter view
options, the exact-revision CSV/JSON-manifest export, and M13 reviewed-draft
artifact creation. All routes authenticate in `onRequest`
before parsing, use keyset pagination with endpoint-bound cursors (`research`,
`research_runs`, `research_evidence`, `research_table`), default to a page of 25
(evidence max 50, the others max 100), and expose stable `code` values on
failures. Responses never include the captured provider origin.

Planner, step-summary, memo, and typed-column calls each have the same bounded
8,192-token provider allocation as ordinary agent turns. This leaves room for
reasoning-capable providers to produce their final output; internal reasoning
is still discarded. The run remains capped at 40 model requests and 15 minutes,
with the streaming transport's separate 32,000-character content/reasoning caps.
Every non-null extracted cell must carry valid evidence from its own captured
source row. An uncited value is retained as `invalid`, with an explicit
missing-evidence explanation, and the run requires review. A missing step summary
also prevents a clean completion. These conditions never become invented facts
or silently coerced values.

Execution is one owned executor registered on the application runtime (like the
saved-analysis and rewrite runners). It claims resumable runs in acceptance
order and executes exactly one run per account at a time (the rest wait in the
durable queue), one active run per definition. Each sequential step searches the
run's pinned `(source, generation)` contract through M14 `searchCapturedScope`
(keyword per planned question, then one optional semantic pass through the
account-authorized embedding boundary with a consent recheck and content-free
audit). Evidence is captured immutably during steps, always before any synthesis
call, deduplicated by `(run, source, generation, chunk, excerpt hash)` and
bounded to 100 items / 2,000 characters each / 200,000 total. Budgets — 8 steps,
32 searches, 40 model requests including synthesis, and a 15-minute wall clock —
are enforced through the store's usage CAS; exhaustion finishes honestly as
`needs_review` with explicit gap rows and preserved partial work, never as a
completed exhaustive answer. Memo synthesis produces claims/gaps whose citations
resolve only to this run's own dossier (invalid or foreign references are
dropped, a `conflicting` claim needs at least two differing excerpts, otherwise
it is honestly `unsupported`); comparison synthesis extracts each column's typed
cell values, storing an off-type value verbatim as `invalid` (never coerced). A
`completed` run means computation finished; publishing still requires the
explicit artifact action below (and only a finished run has a committed child
turn to publish through). Cancellation is the DELETE-side durable flag
observed at safe points, and shutdown interrupts in-flight transports and leaves
the run durable for the bounded at-most-one startup resume.

| Endpoint | Contract |
| --- | --- |
| `GET /api/research` | Paginated `{items,next_cursor}` of `{id,title,output_kind,current_revision,source_count,created_at,updated_at}`, newest first. |
| `POST /api/research` | Body `{title,question,output_kind,source_ids,library_ids?,chat_model,columns?,plan?}`. `201` with the definition DTO (head revision content plus per-source `availability`). A selected-empty `source_ids` is a legal draft; comparison output requires 1–20 `columns`, memo output forbids them. |
| `GET /api/research/:id` | Definition at the head revision with source availability (`ready\|unready\|missing`) and the current `active_run` summary. |
| `PATCH /api/research/:id` | Body requires `expected_revision`; the optimistic head CAS commits a new immutable revision in one transaction. A stale revision answers `409 RESEARCH_REVISION_CONFLICT`; a foreign definition is `404`. |
| `DELETE /api/research/:id` | Refuses while a run is active with `409 RESEARCH_ACTIVE_RUN` (`existing_run_id`); the route requests durable cancellation and retries the owned deletion within a bounded drain window. `{"ok":true}` on success. |
| `POST /api/research/:id/plan` | Generates one bounded, editable plan PROPOSAL through the account-authorized runtime (consent-gated, content-free audit, no reasoning exposure). Body `{expected_revision?}`; a stale `expected_revision` answers `409 RESEARCH_REVISION_CONFLICT` before any provider call, and the remote-egress gate answers `403 REMOTE_EGRESS_CONSENT_REQUIRED` first. `200` returns `{definition_id,base_revision,model,model_used,fallback,error_code,plan}` where `plan` is `{steps:[{id,objective,questions[]}]}` (≤8 steps, ≤8 questions each, ≤32 total). A provider failure or unusable output returns the deterministic four-step fallback (find → compare → gaps → synthesize) with `fallback:true` and a stable `error_code`. The proposal is returned for review only: it creates no run and approves nothing; the user persists it as a new revision through a CAS `PATCH`. |
| `POST /api/research/:id/runs` | Body `{expected_revision?,definition_revision?,rerun_of?,rerun_selection?}`. The remote-egress gate answers `403 REMOTE_EGRESS_CONSENT_REQUIRED` before persistence. When model discovery is live, the definition's chat model is checked against the provider's available models and a mismatch answers `409 RESEARCH_MODEL_UNAVAILABLE`; an unreachable provider does not refuse admission (the durable row is the contract and the runner revalidates/settles at transport). Start pins the chosen revision, the concrete ready source/generation set, the model, the provider authorization snapshot, and the budget copy atomically, dispatches the accepted `queued` row to the registered runner (fire-and-forget; a busy account defers to the claim loop), and returns `201` with the frozen run. `409 RESEARCH_SCOPE_EMPTY` for a selected-empty selection, `409 RESEARCH_INPUTS_NOT_READY` (`unready_source_ids`) for a removed/non-ready source (never silently dropped), `409 RESEARCH_ACTIVE_RUN` (`existing_run_id`) for one-active-per-definition, and `409 RESEARCH_QUEUE_FULL` past ten queued runs per account. With `rerun_of`, the new run links the prior run of the same definition and the prior run's correction overlays are copied in at accept time with `corrected_from_run_id` provenance (`DO NOTHING` — an existing overlay is never silently overwritten), so user corrections ride along visibly while rerunning only the selected `rerun_selection.row_source_ids` (≤100) / `rerun_selection.column_ids` (≤20) leaves the other cells honestly absent until re-extracted. |
| `GET /api/research/:id/runs` | Paginated run summaries, newest first. |
| `GET /api/research-runs/:id` | Frozen run (`status`, `sources`, `budgets`, `usage`, `rerun_of`, `review_revision`, timestamps), persisted `steps`, captured `claims`/`gaps`, `counts`, and `run_notes`. |
| `GET /api/research-runs/:id/evidence` | Paginated captured evidence (≤50/page): `source_id`, `generation`, `chunk_id`, sanitized `label`, M14 `locators`, bounded `excerpt`, `content_hash`, `retrieved_at`, `step_ordinal`, `query`, `irrelevant`. Source deletion never erases a captured excerpt. |
| `GET /api/research-runs/:id/table` | Bounded column schema and keyset rows (≤100/page); each row carries the machine cell and any correction overlay, plus an explicit `limit_state` (`serialized_bytes`, `limit_bytes`, `at_limit`). Bounded view options are applied server-side to the returned keyset page and disclosed by `view_state` (`sort_applied`, `filter_applied`, `basis:"row_source_id_keyset"`): `sort_column` (UUID of a pinned column) with `sort_dir=asc|desc` and `sort_view=effective|machine|correction` (nulls always last, deterministic row-id tie-break), and `filter_column`/`filter_status`/`filter_text` (≤200 chars, case-insensitive, over the effective value and explanation). A `sort_column`/`filter_column` outside the run's frozen schema is `400 RESEARCH_VALIDATION`. `against=<run_id>` additionally returns `comparison`: the deterministic changed-cell diff between the two result revisions of the same definition — `rows_added`/`rows_removed` (row identity is the source id), `changed_cells` (≤200, `truncated`-flagged) each carrying `before`/`after` `machine`/`correction`/`effective` snapshots plus `machine_changed`/`correction_changed`, and `carried_overrides` listing every correction overlay in the target revision whose `corrected_from_run_id` is the comparison source (a carried user override is disclosed, never presented as a fresh extraction). A foreign/missing target is `404 RESEARCH_RUN_NOT_FOUND`; a cross-definition target is `400 RESEARCH_VALIDATION`. |
| `DELETE /api/research-runs/:id` | Idempotent durable cancellation; a queued run settles `cancelled` immediately, a running run records `cancelling`, terminal states are absorbing, and a repeated call returns the same `{ok:true,status}`. |
| `PATCH /api/research-runs/:id/review` | Body `{expected_revision, ops[]}` (1–100 ops: `accept_claim`, `reject_claim`, `add_note`, `correct_claim`, `correct_cell`, `flag_evidence`). Per-cell correction/review is the `correct_cell` op (`column_id`, `row_source_id`, optional typed `value`/`status`/`explanation`): it writes a correction OVERLAY row with `corrected_at` provenance and never rewrites or deletes machine history; a corrected value must still type against the column (a user cannot store a coerced fact either). The run's `review_revision` CAS commits each state change plus one append-only ledger row; notes never become evidence and cell corrections never rewrite machine history. `409` for `RESEARCH_REVISION_CONFLICT`/`RESEARCH_RUN_STATE`; `200` returns `{review_revision,ops_applied,run}`. |
| `POST /api/research-runs/:id/artifacts` | Creates one M13 reviewed DRAFT (document revision 1, owner-only, outside any publication chain — no publication intent is recorded) from a `completed` or `needs_review` run. `failed`/`cancelled` (and active) runs are refused with `409 RESEARCH_RUN_STATE`: a run without a committed child turn never publishes. The projection is derived entirely from stored rows (no model, no retrieval): memo output becomes narrative sections whose `[n]` markers resolve against the revision's own evidence array; comparison output becomes one analysis-backed table envelope (`analysis_id` = definition, `result_id` = run, pinned source generations, deterministic schema fingerprint, `completeness.reasons` carrying the omission/truncation/`run_needs_review` flags). Caps: ≤100 evidence refs with ≤800-character quoted excerpts — shortened excerpts get an explicit ` [shortened]` label while stable evidence ids and content hashes are preserved; ≤60 rows, ≤32 columns (including the `Document` label column), ≤1,000 cells, and the 400,000-character document revision payload budget, applied through a deterministic shrinking ladder whose every omission/shortening is labeled (omitted rows/columns listed, cell previews ending in `…[truncated]`). Gap/conflict/invalid/not-found cells and the needs-review state are included as labeled disclosures. Body must be an empty JSON object. `201` returns `{run_id,document_id,document_revision_id,document_revision,projection}` where `projection` states the applied budget tier and exactly what was projected vs omitted (`projected`, `omitted.rows/columns/claims/gaps/evidence`, `labels`, `disclosures`). |
| `GET /api/research-runs/:id/export?format=csv\|manifest` | Exports the exact stored result revision (no retrieval, model, or source re-read) as an attachment (`Cache-Control: no-store`). `csv`: the full long-form bounded table — one line per (row, column, origin) so the machine original and the correction overlay are never merged away — with UTF-8 BOM, CRLF, `null` rendered literally, `invalid` machine values verbatim, formula-safe escaping (leading `=`, `+`, `-`, `@`, TAB, or CR prefixed with an apostrophe, matching the M12 whitespace-prefixed rule too; RFC quoting for quotes/commas/CR/LF), and an explicit `# limit_state:` comment line; the 1 MiB serialized cap is the stored table's own bound and the export never truncates. `manifest`: the JSON evidence/locator companion (`artifact:"research_run_export_manifest"`) with the run/revision identity (status, sources/generations, budgets, usage, rerun lineage), column schema, row identities, every captured evidence entry (stable id, source/generation, sanitized label, typed M14 `locators`, bounded `excerpt`, `content_hash`, retrieval identity), full cell bindings with `evidence_refs`, and correction provenance (`corrected_at`, `corrected_from_run_id`), plus limit/budget state (`table.serialized_bytes/limit_bytes/at_limit/truncated:false`, evidence counts against caps). Zero rows or zero cells is a valid successful export (comment/header-only CSV, empty arrays). Unknown/missing `format` is a schema rejection. |

Definitions bound: title 120, question 4,000, model 256, at most 100 explicitly
selected source ids and 20 provenance library ids. A run freezes 1–8 steps, 32
search operations, 40 model requests, 100 evidence items with 2,000-character
excerpts under a 200,000-character total, and a 15-minute wall clock; budgets
are copied onto every run. Claims reference only this run's own evidence (≤5
references; conflicting claims need ≥2), at most 100 claims and 50 gaps per
run. Comparison tables declare ≤20 columns (text/number/date/boolean/enum with
exact enum choices); typed cell values are never coerced — an unsupported model
value is stored `invalid` verbatim — and the serialized table is capped at 1
MiB with an explicit `at_limit` state. Restart retries an interrupted step at
most once under the same identity; budget exhaustion is a `needs_review` settle
in the stage-2 runner, never a claim of exhaustive completion. The full bounded
dossier and comparison remain available through the CSV/JSON export; the M13
document projection is the smaller surface: ≤60 rows, 32 columns (including
the row-label column), 1,000 cells, and ≤100 evidence references with
800-character quoted excerpts inside the 400,000-character revision budget,
every omission, shortening, and preview truncation labeled and stable
evidence ids/hashes preserved.

### Reviewed briefs (M16)

Reviewed briefs schedule a saved analysis over an explicit source set and
deliver a report draft into a review inbox. The durable recipe ledger, civil
calendar, run stage machine, and recipe routes feed the owned execution pipeline (input refresh → generation-ready
wait → analysis → draft creation → `awaiting_review`) plus bounded run detail
and idempotent cancellation; manual `POST /api/briefs/:id/runs` and scheduled
claims now execute through it (without a live executor the durable `queued`
row simply waits for the next startup resume). The account-scoped
review inbox, the exact-revision decision with durable publication-intent
approval over M13's `publishDocumentRevision` service, and local
notification read/dismiss surfaces are implemented. The Automations wizard,
run-history panel, Reviews page, and notification bell expose these workflows. Every read and mutation is scoped to the
authenticated account; a foreign `id` answers `404` exactly like a missing one.

A recipe binds exactly one saved analysis at its current definition revision.
Recipe source membership must equal the bound revision's selected source set
exactly — changing membership requires an explicit M12 revision followed by a
recipe update, and a later analysis edit never silently retargets a recipe.
Parameter values are typed and validated against the bound revision's
declarations at write. Source membership is capped at 100 (rejected, never
truncated), the name at 80 characters, the report title at 200, and the draft
instruction at 8,000 characters. Refresh bindings map recipe sources to a
connector or a knowledge connection of the same account; creating or editing
a recipe that carries refresh bindings requires remote-egress consent
(`403 REMOTE_EGRESS_CONSENT_REQUIRED`) because it schedules
payload-bearing refreshes. Manual execution is consent-gated at acceptance:
`POST /api/briefs/:id/runs` answers the same `403` before any run row is
created (an executed brief's draft stage makes a provider-bound narrative
model call, so every run is payload-bearing). The pipeline additionally
rechecks the exact account's consent at its provider-egress boundary, so a
revocation after acceptance (or a scheduled claim under an unacknowledged
remote provider) skips the run visibly with
`failure_code=BRIEF_EGRESS_CONSENT_REQUIRED` before the narrative call — a
skipped/blocked classification that never counts toward the five-consecutive-
failure pause. Review approval publishes through the local renderer only and
is deliberately ungated: publication sends nothing to any provider.

Schedules are civil, not cron: `daily`, `weekly` on one weekday (0 =
Sunday), or `monthly` on day 1–28, at a fixed hour/minute in one validated
IANA time zone. Every occurrence is identified by its civil date-time key
(`YYYY-MM-DDTHH:MM` in the recipe zone). A nonexistent spring-forward time
runs at the first valid local instant after the gap; a repeated autumn time
runs once at the earlier instant, and the civil key makes a restart unable to
run the second instance. All missed occurrences coalesce into one catch-up
run that advances to the next future civil occurrence; repeated restarts of
the same window create nothing new. While a run is active, later due
occurrences coalesce to at most one pending catch-up; `awaiting_review` is
terminal for scheduling and never blocks later occurrences. Five consecutive
execution failures pause the recipe with a durable reason (skipped/blocked
consent or migration outcomes and rejected drafts never count, and success
resets the counter). The app/server must be running for schedules to fire —
there is no OS scheduler. Deleting the bound analysis pauses the recipe with
`the bound analysis was deleted` instead of retargeting it; run history
survives recipe deletion through each run's immutable recipe snapshot.

| Endpoint                          | Contract                                                                                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/briefs`                 | Endpoint-bound keyset catalog (`cursor`/`limit`).                                                                                                  |
| `POST /api/briefs`                | Validated body `{name, analysis_id, parameter_values?, report_title, report_instruction, source_ids[1..100], refresh_bindings?, schedule}`. `201`. Validation failures `400`; duplicate name `400`. |
| `GET /api/briefs/:id`             | Recipe detail plus `next_occurrences`: the next three civil keys with their resolved UTC instants.                                                  |
| `PATCH /api/briefs/:id`           | Body `{expected_revision, ...editable fields}`. A stale revision answers `409 BRIEF_REVISION_CONFLICT`; nothing is written. Membership/parameter drift against the analysis head answers `400`. |
| `POST /api/briefs/:id/pause`      | Pauses scheduling; repeated calls are no-ops. Resume re-advances the civil cursor strictly after now.                                              |
| `POST /api/briefs/:id/resume`     | Resumes with `active` state and a fresh cursor.                                                                                                     |
| `DELETE /api/briefs/:id`          | Removes the recipe head and revision snapshots. Existing runs/reviews survive through their snapshots. `{"ok":true}`.                              |
| `POST /api/briefs/:id/runs`       | Run-now with body `{operation_id}` (UUID idempotency key). The remote-egress consent gate answers `403 REMOTE_EGRESS_CONSENT_REQUIRED` under an unacknowledged remote provider before persistence (no run row is created; acknowledgment unblocks without a restart). `202 {"run":{...},"replayed":bool}` with the durable `queued` run (executed by the owned pipeline through the same stages as scheduled claims); a retried key replays the original run; an active run answers `409 BRIEF_ACTIVE_RUN`. |
| `POST /api/briefs/schedule-preview` | Authenticated calculation over `{schedule}` using the create-route calendar shape (omit inactive weekday/day-of-month fields). Returns `{next_occurrences}` with the next three civil/local and UTC times from the server clock, before a recipe is saved; no ledger write or provider call. Invalid calendars or zones answer `400 CALENDAR_SCHEDULE_INVALID`. The wizard uses an abortable exact-draft preview and requires a current successful preview before save. |
| `GET /api/briefs/:id/runs`        | Keyset run history (bounded summaries: stage, deadlines, coalescing counts, artifact ids, generic failure reason).                                  |
| `GET /api/briefs/:id/runs/:runId` | Bounded stage detail for one run: durable summary plus the server-owned refresh receipts (kind, label, intended generation), the committed source-generation snapshot, the persisted comparison summary (≤32 KiB by write-time bound), and the linked analysis/baseline/document artifact ids. |
| `DELETE /api/briefs/:id/runs/:runId` | Requests durable cancellation (`cancel_requested=1`). Repeated calls — including after terminalization — are idempotent and return the current run. The runner observes it at stage boundaries and finalizes `cancelled`; artifacts committed up to that point are preserved. |
| `PATCH /api/briefs/:id/notifications` | Body `{enabled}` toggles the recipe's local-notification preference (schema v27). Head-only: no revision bump, no reschedule. While disabled, every future notification kind for the recipe's runs is suppressed; the five-failure pause transition itself still happens. |

Review inbox and decision routes (stage 3). All pages are endpoint-bound
keyset (`cursor`/`limit`, default 20, maximum 50; a cursor minted for another
endpoint answers `400 INVALID_CATALOG_CURSOR`).

| Endpoint                                | Contract                                                                                                                                          |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/brief-reviews`                | Account-scoped inbox of pending (`awaiting_review`), publishing, and decided (`approved`/`rejected`) runs. Each item carries the comparison summary, freshness receipts, recipe revision, retained-recipe state (deleted recipes read `recipe_state: null` through the run's immutable snapshot), evidence references (`analysis_run_id`, `baseline_run_id`), the rendered-draft pointer (`document_id` + `document_revision_id` + live `document_head_revision_id` and `head_moved`), the decision ledger tail (`review`), and the failed-publication indicator (`publication_error_code` + a content-free `publication_failure.message`). |
| `POST /api/brief-reviews/:id/decision`  | Body `{decision: "approve"|"reject", document_revision_id, note?}` with the exact draft revision being reviewed (note ≤1,000 characters). Approval first durably records the immutable decision event, the exact reviewed revision, and the stable publication operation UUID (derived from run + revision) under an in-transaction head-revision CAS, then enters `publishing` and calls M13's `publishDocumentRevision` with that same UUID; the route answers `202 {"status":"publishing"}` while rendering and the run reaches `approved` only after the publication commits (status polls on `GET /api/briefs/:id/runs/:runId` or this inbox). Approval retries reconcile the SAME intent and operation UUID — never a second publication; a completed approval replays `200 {"status":"approved","replayed":true}`. A render failure returns the run to `awaiting_review` with the bounded indicator; the retry re-checks the head, and an edited draft answers `409 BRIEF_REVIEW_REVISION_CONFLICT` until a fresh decision names the current revision. An edit landing mid-render likewise fails the attempt honestly (`DOCUMENT_HEAD_MOVED`) without ever altering the immutable revision being published. A concurrent edit before the decision answers the same `409` — unseen content is never approved. Rejection is terminal (run + draft preserved for inspection, publish blocked `409`); rejecting or re-deciding a different revision against an accepted/committed approval answers `409 BRIEF_RUN_STATE` — an accepted approval is never silently revoked. Cross-account or unknown run `404 BRIEF_RUN_NOT_FOUND`. |
| `GET /api/notifications`                | Account-scoped local-event inbox (kinds `first_draft`, `meaningful_change`, `attention`, `paused`) with durable `state` (`unread`/`read`/`dismissed`). Visibility semantics: every row stays durable and readable newest-first — `dismissed` means removed from the tray, not deleted; rows were deduplicated per (run, kind) at write, so repeats never double-notify; per-recipe disable suppresses new rows only. Nothing is ever delivered outbound. |
| `PATCH /api/notifications/:id`          | Body `{state: "read"|"dismissed"}` only — the durable visibility transition. Event content (kind/detail) cannot be modified through this route; the request schema rejects any other field. Unknown or foreign id `404`. |

Run stages are `queued → refreshing → waiting_ready → analyzing → drafting →
awaiting_review → publishing`, with terminal `failed`, `cancelled`, `skipped`,
`approved`, and `rejected`. Stage transitions are short conditional
(conditional-and-set) writes guarded by a per-attempt operation id, so a
stale worker can never advance a newer attempt; the 15-minute refresh-stage
deadline and the 30-minute total-to-review deadline are persisted with the
run (human review time excluded) and survive restart. Failure reasons are
content-free and capped at 500 characters.

Pipeline execution (stage 2) is owned by `server/src/briefRunner.ts`, resumed
at startup and driven by an unref'd tick alongside the automation/analysis
intervals: at most one brief executes per account and two globally, with
detached executions so a long run never blocks other scheduled work. Refresh
uses only the existing services: connector-bound inputs sync through the
consent-gated `connector_sync` machinery (consent rechecked immediately before
the transport; revoked consent, migration admission, and busy inputs surface
as visible `skipped`/`blocked` outcomes with a stable code and never count
toward the pause), and knowledge-bound inputs refresh through
`refreshAndWaitReady` with the exact managed-item allowlist and the live
expected connection revision. Every bound source commits a refresh receipt
carrying its intended generation; static inputs are labeled
`uses imported version`. The wait stage accepts only ready generations equal
to the receipt's intended one — a generation that raced ahead is a durable
`BRIEF_STALE_INPUTS` failure, never a silent switch to whatever is current —
and the run then persists its exact source-generation snapshot. Analysis runs
through the ordinary M12 execution service pinned to the recipe's definition
revision, typed parameters, and that snapshot (acceptance-time mismatch is a
durable `stale-inputs`), keyed by an operation id derived from the run so a
crash-and-resume replays the original analysis run instead of double-running.
The comparison baseline (newest earlier run of the same recipe with the same
definition revision, parameter bindings, and source set whose analysis
succeeded) is selected and persisted before execution; a rejected draft never
erases a successful result or moves the next baseline, and a definition or
parameter change begins a new series whose first run is labeled as such.
Comparison uses only the stored M12 results and their completeness flags;
unsupported or incomplete comparisons are labeled and raise an `attention`
event rather than ever claiming no-change. Drafting creates an M13 document
(revision 1) with labeled current/baseline preview tables
inside M13 ceilings (8 tables / 60 rows / 32 columns / 1,000 preview cells
across the copied previews, 400,000-character revision payload) carrying
server-verified analysis provenance envelopes, truthful omitted-row/column
notes, the comparison and freshness labels, and exactly one bounded model
narrative call (consent-gated, audited, never reasoning-bearing;
citation-style markers are stripped so a recipe can never manufacture a
citation). The draft is created before the atomic `awaiting_review`
transition, which only lands with both document references persisted; an
interrupted draft whose references never persisted cannot be proven complete
and fails visibly for a fresh explicit retry rather than risking a second
draft. Drafts stay outside the published report version chain and owner
shares, and the authoritative run↔document link is `brief_runs.document_id`
(the draft origin carries the verified analysis-result id).
Notifications are the step-8 kinds `first_draft`, `meaningful_change` (keyed
comparison changed-row signal only), `attention`, and `paused`, deduplicated
per run and kind, silent for a complete supported no-change draft, and
suppressible per recipe via `PATCH /api/briefs/:id/notifications`. Approval
never enables any outbound delivery.

Publication execution (stage 3) is owned by `server/src/briefReviewService.ts`.
The decision transaction commits the intent before any render, so the durable
`publishing` row plus its stable operation UUID is the contract; the detached
publication call finalizes `approved` (after reading the committed publication
back through the store) or returns the run to `awaiting_review` with the
schema-v28 `publication_error_code` indicator. A restart where the render died
reconciles from the same durable intent — completed → `approved`, failed or
absent → review with the indicator, ready → idempotent replay — and an
approval retry on an unchanged head re-arms the same intent rather than
minting another. `publishing` runs are never claimed by the execution
pipeline's executor (the review service owns them), and an `awaiting_review`
run never occupies the recipe's single active slot, so pending reviews never
block later scheduling.

## Agent tools

These operations run inside an accepted chat turn, not as independently callable
HTTP endpoints:

| Tool            | Boundary                                                                                                       |
| --------------- | -------------------------------------------------------------------------------------------------------------- |
| `retrieve`      | Searches only the run's ready source UUIDs; query up to 4,000 characters and 1–12 passages (default 6).        |
| `list_sources`  | Lists the accepted attachments and ready tables, with bounded descriptive metadata.                            |
| `query_data`    | One read-only `SELECT`, `WITH`, or `VALUES` statement against the immutable table allowlist; bounded startup registry-rehydration wait (≤15 s) first. |
| `describe_data` | Bounded statistics for a selected, ready table.                                                                |
| `render_chart`  | Validates the canonical spec and stages a chart for this run.                                                  |
| `create_report` | Stages at most one report per run, using only charts owned by the same run.                                    |
| `fetch_url`     | Fetches a public URL explicitly present in the current user message, independently of stored-source selection. |

In addition to the built-ins, an agent's frozen connected-tool selections are
advertised to the model under their opaque `mcp_*` aliases with the captured
schemas and execute inside the same loop through the connection service —
per-call enable/revocation/credential-identity re-checks, frozen-schema
argument validation, a 30-second deadline inside the run budget, 32 KiB
argument and 64 KiB result ceilings, and stable `CONNECTION_*` error codes
with fixed sanitized SSE summaries. See "Connected tools in durable chat
turns" above for the full contract.

Agent web fetches discard fragments, reject URL credentials and non-default
ports, pin DNS to public addresses, and revalidate every redirect. An HTTPS URL
cannot redirect to HTTP; private, loopback, link-local, and otherwise unsafe
destinations are denied.

Tabular sources retain the full registered dataset for SQL, while ingestion
embeds a bounded preview of up to 40 rows. Retrieval is not an exhaustive search
of every dataset cell. Document extraction is also bounded; large documents can
be only partially indexed. External source content is treated as untrusted data,
not instructions or authorization to expand tool scope.

## Storage and workspace archives

SQLite is authoritative for relational state and passage text. LanceDB stores
only vectors keyed by stable chunk UUID, account, source, and ingestion
generation. Retrieval applies its account/source allowlist before vector search,
then joins results back to SQLite under the same scope and drops missing rows.
DuckDB is reserved for bounded analytical queries over user tables.

The supported archive/restore surface is an offline operator CLI, not an HTTP
route: a workspace contains every account plus instance credentials and cannot
be safely delegated to an ordinary authenticated account. Invoke it from the
repository root as `pnpm workspace:archive -- <command> ...`. All workspace,
archive, target, backup, and named-addition paths must be explicit absolute
paths; the CLI never infers a home directory or broad deletion target.

| Command         | Required options and behavior                                                                                                                                                                                        |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create`        | `--workspace <dir> --output <file.borealis-workspace>`; creates a new mode-`0600` archive atomically via a sibling `.part`. Repeat `--include name=/absolute/path` for an intentionally relocated file or directory. |
| `inspect`       | `--archive <file>`; authenticates/decompresses the stream and verifies its strict manifest, member set, sizes, and hashes without extracting it.                                                                     |
| `restore`       | `--archive <file> --target <dir> [--dimension 768]`; restores through a private sibling stage, rebases supported durable paths, verifies stores, and atomically installs the target.                                 |
| `verify`        | `--workspace <dir> [--dimension 768]`; opens SQLite/LanceDB and bounded ready tabular datasets offline without starting HTTP, models, ingestion, or egress.                                                          |
| `remove-backup` | `--target <dir> --backup <generated-sibling> [--dimension 768]`; verifies the live target, backup, provenance marker, and exact inode before removing the old backup.                                                |

Version-2 `settings.json` supplies the verifier's embedding dimension. For a
legacy workspace that does not persist it, or when the live index uses an
environment-managed dimension that differs from the stored value, pass the
exact live dimension to `restore`, `verify`, and `remove-backup`. An explicit
`--dimension` wins; the CLI does not read `EMBEDDING_DIM` implicitly.

`create`, `restore`, `verify`, and `remove-backup` acquire the same exact
instance lock as server startup, and therefore refuse a live workspace or
target. Its fixed path is a persistent owned mode-`0700` namespace containing
never-reused mode-`0600` owner records. A record is fully written and fsynced
before atomic publication; release and stale recovery quarantine and validate
only that unique record, never a shared or reusable pathname. Malformed,
symlinked, or foreign entries fail closed. Configuration import and normal
Electron startup do not create durable workspace paths; the backend creates or
canonicalizes directories and creates, reads, or repairs the file-backed JWT
secret only after lock acquisition. A rejected second process therefore leaves
the live workspace unchanged. `inspect` reads only the archive and
needs no workspace lock. Restore never recursively overwrites its target. If a target
exists, it is renamed to a recoverable sibling
`.<target>.backup.<uuid>` with a private provenance marker; another restore is
refused until that backup is explicitly removed. A crash at a rename boundary
either rolls back or is recovered from the exact marker on the next restore.
Backup removal first renames the verified inode to a private tombstone, rechecks
its identity, and only then deletes it. The tombstone name is deterministically
derived as `.<target>.backup-remove.<uuid>` and the provenance marker remains
authoritative until both recursive removal and marker unlink complete. Repeating
the command resumes that exact partial deletion or marker-only cleanup; a new
entry at the former backup pathname is left untouched.

Archive version 1 uses a deterministic manifest containing relative path, kind,
size, mode class, and SHA-256 for every member. It captures the entire stopped
workspace — including SQLite WAL state, LanceDB, uploads, reports, the
`reports/documents/` publication artifact namespace, knowledge refresh staging
under `uploads/`, settings, signing secret, contained configuration, default
model directory, migration state, and other future files in that root — rather
than enumerating a stale allowlist. The only workspace-root exclusions are the
machine-bound connection custody paths `secrets/` and `connections.key`, which
are never captured regardless of content: keys, OAuth sessions, and WebDAV
credentials do not port between machines, and the encrypted records are
useless without their machine-bound key.

Named additions use two restore modes. These exact reserved names restore at
the target root and must have the listed kind:

| Reserved `--include` name                       | Required kind | Portable restore path                                                                                              |
| ----------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------ |
| `borealis.sqlite`                               | File          | `borealis.sqlite`; adjacent `-wal`, `-shm`, and `-journal` files are captured automatically                        |
| `lancedb`                                       | Directory     | `lancedb/`; an adjacent `.<source-name>-migrations/` directory is captured automatically as `.lancedb-migrations/` |
| `uploads`, `reports`, `models`                  | Directory     | The same directory name at the target root                                                                         |
| `settings.json`, `contained.json`, `jwt.secret` | File          | The same file name at the target root                                                                              |

Every other addition name restores below `relocated/<name>/`. The archive
rejects a reserved addition of the wrong kind, overlapping addition roots,
mixed canonical/relocated SQLite files, canonical migration-staging collisions,
an active external LanceDB migration whose staging directory cannot be
captured, and the reserved custody names `secrets` and `connections.key` —
machine-bound credential custody can never be archived under any name. The
manifest records the source workspace/addition roots, lexical aliases, and
portable archive path so restore can rebase source paths, pending cleanup
locations, report paths, document-publication artifact paths and pending
publication-intent/cleanup directories, knowledge refresh staging candidates,
contained binary/model paths, and migration state to the new target. Because
custody never ports, the same restore transaction also transitions every
previously `ready` MCP connection to `disconnected` with status code
`CONNECTION_RESTORE_RECONNECT_REQUIRED` and every previously `ready` knowledge
connection to `disconnected` with `KNOWLEDGE_RESTORE_RECONNECT_REQUIRED` (Web
DAV; re-enter credentials) or `KNOWLEDGE_FOLDER_RESELECT_REQUIRED` (desktop
folders; memory-only grants require re-selection), and clears
`credential_configured` for every WebDAV connection; untested and already
disconnected rows keep their state, and configurations, tool snapshots, items,
previews, refresh history, and saved outputs restore unchanged. Directories
restore as `0700`; ordinary and secret files restore as `0600`, and
owner-executable files as `0700`. The archive output may not be inside any
source.

Encryption and authentication are on by default: the streaming payload uses
gzip followed by AES-256-GCM with a per-archive key derived by scrypt. Supply the
passphrase through the interactive TTY, `BOREALIS_ARCHIVE_PASSPHRASE`, or
`--passphrase-fd <0..1024>`; it is never accepted as an argv value, printed, or
logged. It must encode to 12–4,096 bytes without NUL. Creation confirms an
interactive passphrase. There is no recovery if it is lost. Plaintext creation
and reading each require `--unsafe-plaintext`. Unknown future container versions
are rejected.

Before and during extraction, Borealis rejects absolute, `..`, NUL, duplicate,
case-colliding, symlink, hard-link, device, socket, oversized, excessively
compressed, or out-of-order members. Version 1 allows at most 250,000 members,
50 GiB per file, 500 GiB of declared/extracted data, an 8 MiB manifest, a 550
GiB container, a 10,000:1 expansion ratio, and one hour for the complete
read/decrypt/decompress/extract pipeline. Decompressed tar bytes are capped
first at the manifest boundary and then at the manifest-derived bodies,
headers, padding, required PAX path records, and terminator; trailing or
concatenated compressed streams are rejected. Restore preflights declared data
plus 64 MiB of free-space reserve and fsyncs the staged tree before publication.
Offline store verification is separately bounded to
10,000,000 chunks/vectors, 10,000 ready datasets, 250 MiB per tabular file, 60
seconds per dataset, and ten minutes total. It requires the existing Lance table
rather than manufacturing an empty one and validates an embedding-identity
marker and independent first-binding receipt. A valid receipt-only publication
crash is accepted read-only when its dimension matches the existing schema;
offline verification never manufactures the missing marker. Normal startup
then requires the exact configured model identity and may republish only the
matching marker. Corrupt files, marker/receipt disagreement, or dimension drift
fail closed, as does an existing index with neither identity file.

Protect archives as private data because they can contain source content,
reports, provider credentials, model weights, and the JWT signing secret.
Securely preserve and reapply operator environment overrides separately,
especially an explicit `JWT_SECRET`, `EMBEDDING_DIM`, and provider/model
settings; they are not necessarily stored in the workspace. Restored stores
must use compatible operator configuration. When a reserved addition relocates
an overridden core path into the portable target root, point
`BOREALIS_DATA_DIR` at the new target and remove or update the old
`SQLITE_PATH`, `LANCEDB_DIR`, `UPLOAD_DIR`, `REPORT_DIR`, `CONTAINED_DIR`,
`SETTINGS_FILE`, legacy `SETTINGS_PATH`, or `JWT_SECRET_FILE` override before
starting the restored workspace.

## Limits and status codes

Configurable defaults are shown in [server/.env.example](../server/.env.example):

| Setting                 | Default                       | Maximum                                               |
| ----------------------- | ----------------------------- | ----------------------------------------------------- |
| `MAX_UPLOAD_BYTES`      | 25 MiB                        | 250 MiB                                               |
| `MAX_MESSAGE_CHARS`     | 32,000 Unicode characters     | 100,000                                               |
| `MAX_HISTORY_MESSAGES`  | 80                            | 500 for model history; HTTP pages are capped at 100   |
| `MAX_HISTORY_CHARS`     | 120,000 serialized characters | 500,000; must be at least `MAX_MESSAGE_CHARS + 36000` |
| `MAX_EXTRACTED_CHARS`   | 2,000,000 characters          | 10,000,000                                            |
| `MAX_INGEST_CHUNKS`     | 2,500 chunks per generation   | 10,000                                                |
| `OCR_MAX_PAGES`         | 12 empty PDF pages            | 100                                                   |
| `OCR_MAX_RASTER_PIXELS` | 4,000,000 pixels per page     | 16,000,000                                            |
| `OCR_PAGE_TIMEOUT_MS`   | 10,000 ms                     | 60,000                                                |
| `OCR_TOTAL_TIMEOUT_MS`  | 60,000 ms                     | 300,000                                               |
| `OCR_MAX_OBSERVATIONS`  | 1,000 per page                | 5,000                                                 |
| `OCR_MAX_PAGE_CHARS`    | 20,000 per page               | 100,000                                               |

All configured budgets must be positive integers. Protected authentication runs
before parsing. The global request-body fail-safe is 8 KiB. Explicit parser
limits are:

| Request contract                                                                      | Parser ceiling |
| ------------------------------------------------------------------------------------- | -------------: |
| Bodyless mutations and connector schedule changes                                     |          1 KiB |
| Public registration and login                                                         |          2 KiB |
| Account model preference                                                              |    3,424 bytes |
| Compact mutations, including chat patch and migration start                           |          8 KiB |
| Connector creation                                                                    |   29,962 bytes |
| Chat creation/source scope, catalog-status/knowledge-refresh UUID lists, and contained download request | 32 KiB |
| Library source search (1,000-character query plus ≤100 filter UUIDs)                |         48 KiB |
| Knowledge connection create/edit (name, DAV URL/username, bounded password, grant id) |   82,960 bytes |
| Knowledge preview apply manifest (≤1,000 entry/token pairs)                          |    604,096 bytes |
| Agent and automation long-text mutations                                              |        128 KiB |
| Saved-analysis query-capture promotion                                                |     38,128 bytes |
| Saved-analysis run acceptance (20 typed values plus the operation UUID)               |    484,864 bytes |
| Saved-analysis definition create/edit                                                 |  1,344,256 bytes |
| Research definition create/edit (question, ≤100 source ids, 20 columns, bounded plan) |  1,057,504 bytes |
| Research review batch (≤100 bounded operations)                                       |  3,148,096 bytes |
| Settings patch/test and model-qualification draft                                     |  157,696 bytes |
| Contained-engine configuration                                                        |        256 KiB |
| Document draft/revision save tree                                                     |    2,531,072 bytes |

The non-round ceilings above derive from the schemas' maximum decoded lengths
and worst-case JSON escape expansion. Message JSON uses
`MAX_MESSAGE_CHARS * 12 + 4,096` bytes so escape-heavy input can still reach the
decoded character validator. Uploads allow a 64 KiB multipart envelope above
the file limit. History metadata is capped at 32,000 characters per message.

The following fixed boundaries apply to internal operations. A tool result can
be truncated even though the source itself is ready; consumers should honor
`truncated`, `columns_truncated`, and returned-row counts rather than assuming a
complete result.

| Boundary                   | Limit                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Connector download         | 50 MiB, 60 seconds, three redirects; oversized downloads fail.                                                                                                                                                                                                                                                                                                                                                                                   |
| Contained-model download   | 64 GiB per file by default (`CONTAINED_MAX_DOWNLOAD_BYTES` accepts a positive safe integer); SHA-256 verification precedes atomic publication, and redirects are refused.                                                                                                                                                                                                                                                                        |
| Agent web fetch            | 1,000,000 response bytes, 15 seconds, three redirects; tool text is capped at 12,000 characters.                                                                                                                                                                                                                                                                                                                                                 |
| Embedding migration        | At most 100,000 ready sources and 1,000,000 ready chunks; snapshot/build pages are 256 rows and embedding batches are 16. Disk preflight reserves 128 MiB plus `dimension * 8 + 1,024` bytes per remaining chunk.                                                                                                                                                                                                                                |
| DuckDB query               | One 30-second end-to-end deadline covers scoped-catalog acquisition, trusted-file loading, statement preflight, execution, and bounded result materialization; cancellation interrupts the worker connection. Results allow 500 rows, 100 columns, 50,000 cells, 1,000,000 returned characters, and 10,000 characters per cell. Agent SQL is capped at 20,000 characters (worker ceiling: 100,000).                                              |
| Dataset extraction         | Worker ceiling of 2,000 rows, 500 columns, 50,000 cells, 1,000,000 characters, and 10,000 characters per cell; the facade requests at most 100 rows and ingestion uses 40.                                                                                                                                                                                                                                                                       |
| Dataset description        | Up to 100,000 profiled rows, 100 columns, and 128,000 returned characters; top values are computed for at most 20 columns.                                                                                                                                                                                                                                                                                                                       |
| Registered dataset/catalog | 500 columns per table; 100 allowed tables per scope; eight cached scopes per account; four DuckDB threads, 512 MiB memory, 512 MiB temporary data per scope; 256,000 characters per catalog response.                                                                                                                                                                                                                                            |
| Agent execution            | Sixteen tool rounds plus one reserved final synthesis call, eight tool calls per round, 48 calls per run, 120 seconds per model request, and 120 seconds per tool. Each model request asks for at most 8,192 output tokens; streamed content and reasoning are each capped at 32,000 characters. Tool arguments are capped at 20,000 characters per call and 80,000 per model round; serialized tool responses added to the model conversation are capped at 12,000 characters each. |
| Evidence display           | Eight passages, 800 characters per excerpt, and 6,000 aggregate characters.                                                                                                                                                                                                                                                                                                                                                                      |
| Query display snapshots    | Three queries per assistant message; 32 columns and 100 rows per query, 500 cells and 30,000 serialized characters across snapshots.                                                                                                                                                                                                                                                                                                             |
| Saved analyses             | Definition: title 200, description 2,000, SQL 20,000 characters, 20 parameters, 100 selected sources, 1–3-column comparison key. Persisted results: 500 rows, 64 columns, 20,000 cells, 2,000 characters per string cell, and 1 MiB UTF-8 payload, whichever binds first; at most 1,000 retained results per analysis. Full-query captures: at most 3 per turn, 20,000 SQL characters, 100 provenance sources. Comparison: 200 rows per diff category and per side-by-side preview block. |
| Chart spec                 | 500 categories, 20 series, 100 pie items, 500 characters per label; finite numbers with magnitude at most `1e15`.                                                                                                                                                                                                                                                                                                                                |
| Report                     | One per run; 20 sections (50,000 characters each), 20 charts, eight tables (32 columns and 60 rows each). The agent additionally caps section text at 200,000 characters and tables at 1,000 cells/100,000 characters in aggregate; stored normalized payload JSON is capped at 400,000 characters.                                                                                                                                              |
| Static rendering           | PNG data URLs up to 8 MiB; Electron additionally validates a 16 MiB HTML IPC payload ceiling and a 90-second render-request deadline.                                                                                                                                                                                                                                                                                                            |

File-processing ceilings also include the first 500 PDF pages. OCR considers
only the configured number of empty pages and additionally caps raster pixels,
observations, per-page text, per-page time, total time, and helper output; its
fixed language is `en-US`. DOCX archives allow at most 2,048 members, 100 MiB
total expansion, 50 MiB per member, and a 200:1 compression ratio. XLSX archives
allow at most 10,000 members, 100 MiB total expansion, 50 MiB per member, and
1,000,000 bytes per cell. Encrypted, ZIP64, and multi-disk XLSX files are
rejected. The first-sheet parser permits up to 200,000 logical rows, 10,000
columns, 2,000,000 cells, and 100 MiB of CSV output, but the registered dataset
still has the stricter 500-column limit.

| HTTP status | Typical meaning                                                                                                        |
| ----------- | ---------------------------------------------------------------------------------------------------------------------- |
| `400`       | Malformed input, invalid settings/scope, or unavailable attachment IDs.                                                |
| `401`       | Missing/invalid JWT or incorrect login credentials.                                                                    |
| `403`       | Remote-provider payload route blocked until `REMOTE_EGRESS_CONSENT_REQUIRED` is acknowledged.                          |
| `404`       | Unknown/unowned resource, pending artifact, or unavailable export.                                                     |
| `409`       | Active chat run/sync, source mutation conflict, scope overflow, duplicate email/table, environment-managed setting, or saved-analysis active run/revision conflict/result quota. |
| `413`       | Request body or upload exceeds its size boundary.                                                                      |
| `415`       | Unsupported HTTP content type.                                                                                         |
| `422`       | Unsupported upload type or connector preparation/sync failure.                                                         |
| `500`       | Unexpected server failure with a bounded public error.                                                                 |
| `503`       | Failed Settings connection probe or deferred report cleanup.                                                           |
| `507`       | Insufficient disk space for a managed embedding migration.                                                             |

Asynchronous ingestion failures appear in source status/metadata after the
initial successful upload. Once SSE starts, agent failures use its `error` and
`run-ended` events instead of changing the HTTP status. Treat public messages as
stable categories, not as a substitute for the correlated server logs.

Agent activity is collapsed by default, with separate completed and failed counts. Tool failures use fixed, actionable summaries; raw provider/SQL exceptions remain private. At the tool or conversation budget boundary, the agent uses a reserved tools-disabled call to summarize successful results and identify incomplete deliverables. Verbose context is reduced to bounded captured artifacts when needed for that final call. A later model-request failure or empty response also uses this bounded synthesis path; if the final request fails too, successful artifacts remain attached to an explicitly incomplete answer.

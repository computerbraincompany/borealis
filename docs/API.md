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
errors. A degraded dependency does not change the liveness endpoint, which avoids
restarting a healthy API process because an upstream service is temporarily
unavailable.

Authenticated clients can also use `GET /api/status` for the ambient workspace
snapshot the application chrome displays. It classifies the configured model
endpoint as `local` (loopback, this machine), `private` (private-network
cluster), or `remote` (public provider), reports model endpoint and optional
LM Studio reachability with bounded latency, and names the configured chat and
embed model IDs. Its 20-second single-flight cache reuses the same body-free
catalog probe as `/api/health`. The response never contains the endpoint URL,
credentials, provider errors, or model lists; reachability loss is a status
field, not an HTTP error.

The direct/manual remote-provider payload routes are fail-closed. While a
remote (public) provider is configured and the account has not acknowledged
remote egress, chat messages, source upload, source reingest, connector
create/manual sync, and connector schedule changes refuse with `403
{"error":"...","code":"REMOTE_EGRESS_CONSENT_REQUIRED"}` before any payload is
processed. `GET /api/consent/remote-egress` returns
`{required,acknowledged_at,endpoint_host}`; `POST /api/consent/remote-egress`
records the per-account acknowledgment and unblocks the gated routes
immediately. The acknowledgment is not bound to a host and remains stored when
the provider changes. `endpoint_host` names the currently configured remote
host only, is a response field only, and never appears in logs. Loopback and
private-network providers never gate.

Durable ingestion repeats the check in the worker immediately before the first
embedding transport. One immutable provider/model snapshot is then used for all
batches in that job. If a job queued under a local provider resumes after an
unacknowledged remote switch, no provider request is made and the source records
the stable asynchronous failure `REMOTE_EGRESS_CONSENT_REQUIRED`; a concurrent
Settings edit cannot redirect an already authorized job between batches.

`connector_sync` automations are consent-gated end to end, matching the
human connector surfaces: `POST /api/automations` with
`kind: "connector_sync"` and any `PATCH /api/automations/:id` on a
`connector_sync` row refuse with the same `403
REMOTE_EGRESS_CONSENT_REQUIRED` envelope while a remote provider is
configured and unacknowledged, and a scheduled connector execution rechecks
consent before every run — without consent it records a `skipped` run
(`remote egress consent is required`) and makes no provider request.
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
provider switching. All routes require authentication.

| Endpoint                                    | Response                                                                                                                   |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/contained`                        | `{config,engine,downloads}` — current configuration, engine state, and in-process download states.                         |
| `PUT /api/contained/config`                 | Body `{enabled,binary_path?,model_path?,extra_args?}`; returns the normalized config, and paths are required when enabled. |
| `POST /api/contained/downloads`             | Body `{url,filename,sha256}`; `202` with the download state.                                                               |
| `DELETE /api/contained/downloads/:filename` | `{"ok":true}`; cancels a tracked download and removes its `.part` artifact; an untracked filename returns `404`.           |
| `POST /api/contained/engine/start`          | `202` with the engine state; health is polled in the background.                                                           |
| `POST /api/contained/engine/stop`           | Engine state after an orderly SIGTERM (bounded SIGKILL).                                                                   |

Configuration is stored at `<BOREALIS_DATA_DIR>/contained.json`. Writes replace
the file atomically within the same directory with mode `0600` — a pre-existing
widened mode is repaired, and a failed write leaves the previous configuration
intact with no temporary artifacts.
Disabling needs only `{enabled:false}` and normalizes the path/argument fields
to empty values. Enabling requires absolute `binary_path` and `model_path`
values (no `~` or NUL); existence is checked when the engine starts.
`extra_args` accepts at most 32 strings of 1–200 characters.
`config` is `null` before one is saved. `engine` contains
`{state,model,endpoint_host,endpoint_managed_by_env,pid,started_at,error}`, with
state in `off|starting|healthy|crashed|stopped`; download rows contain
`{filename,url_host,state,bytes_received,total_bytes,error}`, with state in
`downloading|verifying|complete|failed|canceled`.

Download contract: `filename` is 1–180 characters of `[A-Za-z0-9._-]`, cannot
contain `..`, and contains no path separators. `sha256` is mandatory and
verified before the file is atomically renamed into place — a mismatch deletes
the artifact and records a failed state. Downloads live under `CONTAINED_DIR`
(default `<BOREALIS_DATA_DIR>/models`), resume from an existing `.part` byte
range, and default to a 64 GiB ceiling configurable with the positive safe
integer `CONTAINED_MAX_DOWNLOAD_BYTES`. The URL may contain a path but must use
HTTPS or loopback HTTP and cannot contain credentials, a query, or a fragment.
Redirects are refused. Download snapshots are process-local bookkeeping;
canceling never deletes an already verified final model file.

Engine contract: Borealis spawns the configured binary as
`<binary> -m <model_path> --host 127.0.0.1 --port <os-assigned>
[extra_args...]` (the llama.cpp `llama-server` shape), polls body-free
`GET /v1/models` until healthy within a 180-second budget, and reports
`off/starting/healthy/crashed/stopped`. When healthy, and only when the
provider endpoint is not environment-managed, the engine's loopback origin is
applied through the live settings store and the prior origin is restored on
stop; an environment-managed endpoint is reported via
`endpoint_managed_by_env` instead of being overridden. Engine process output
is never read or logged, and orderly shutdown stops the engine before the
embedded stores close.

Engine start checks the configured paths deterministically (binary before
model, so an absent binary always wins the diagnostic) and subscribes to the
spawned child's `error` event, so a non-executable or raced-away binary enters
the bounded `crashed` state instead of surfacing as an unhandled process
error.

`GET /api/status` carries the ambient `contained` section
(`{state,model,endpoint_host,endpoint_managed_by_env}` or `null`) so the
workspace chrome can say "On this Mac · contained".

### Agents

| Endpoint                 | Response                                                                                                                            |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/agents`        | Paginated `{items,next_cursor}` of `{id,name,current_version,instructions,instructions_chars,created_at,updated_at}`, newest first. |
| `POST /api/agents`       | Body `{name,instructions}` (name 1–80 chars unique per account; instructions 1–8,000 chars); returns `201`.                         |
| `GET /api/agents/:id`    | `{...summary,revisions}` with every immutable revision, newest first.                                                               |
| `PATCH /api/agents/:id`  | Body `{name?}`, `{instructions?}`, or both; new instructions become the next immutable revision.                                    |
| `DELETE /api/agents/:id` | `{"ok":true}`; bound chats keep running and become unbound (`agent_id` is `SET NULL`).                                              |

A chat may bind one agent when it is created: `POST /api/chats` accepts an
optional `agent_id` (must reference an owned agent; unknown or foreign ids
return `400`). The binding is write-once — it cannot be changed or removed
while the chat exists, and chat DTOs carry `agent: {id,name} | null`. At turn
acceptance the server resolves the agent's _current_ revision inside the
accept transaction and stores its instructions on the durable run
(`chat_runs.agent_instructions`); later agent edits or deletion never change a
running or completed turn. During the run, the instructions are appended to
the system prompt in a bounded `Workspace agent instructions` section that
states the platform's operating rules stay fixed workspace policy. Agents
never change the tool set, retrieval scope, or any authorization: everything
the runner may do is server policy exactly as for unbound chats. Instructions
are never logged.

### Libraries

| Endpoint                         | Response                                                                                             |
| -------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `GET /api/libraries`             | Paginated `{items,next_cursor}` of `{id,name,member_count,created_at,updated_at}`, newest first.     |
| `POST /api/libraries`            | Body `{name}` (1–120 chars, unique per account); returns `201` with the library.                     |
| `GET /api/libraries/:id`         | `{id,name,created_at,updated_at,members}`; members use the full source resource DTO described below. |
| `PATCH /api/libraries/:id`       | Body `{name}`; returns the renamed library.                                                          |
| `PUT /api/libraries/:id/sources` | Body `{source_ids}` (≤100, distinct, all owned by the account); replaces membership exactly.         |
| `DELETE /api/libraries/:id`      | `{"ok":true}`; membership rows cascade. Sources and their data are never touched.                    |

Libraries reference sources; they never copy or move them. There is no server
side chat–library binding: attaching a library expands its ready members into
a chat's explicit `selected` scope through the normal chat-creation contract,
so the three-meaning source-scope semantics are unchanged. Member rows include
the source's `account_id`, connector, stored `file_path`, URL, metadata, and
ready generation, as upload/reingest responses do; local paths are not API
URLs. Replacing membership returns `{"ok":true}` and rejects an unknown or
foreign source with `404` without changing the existing membership.

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

JWTs expire after seven days. `GET /api/me` validates the token and returns its
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
not a proxy process. Both healthy and degraded readiness responses use `200`.
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

`GET /api/models` includes `display_name` (the resolved provider model ID) on each option, while `id` preserves stable aliases for selection. `available_models` includes the complete advertised catalog for the Settings embedding selector; `/v1/models` does not standardize model capabilities, so embedding choices require qualification before migration. Settings uses dropdowns, refreshes discovery after saving a provider connection, and retains an unadvertised current value when discovery is unavailable.

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
is non-null, otherwise the workspace `default_model`. The web composer applies
an explicit selection as a per-chat patch before accepting the first turn.

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
| `POST /api/chats`                   | Optional `title` and source-scope union; returns the chat summary. Uses the account's default chat model when set, else the workspace default. |
| `GET /api/chats/:id`                | Summary, sources, bounded history page, and active run; accepts `limit` and `before_message_id`.                                               |
| `PATCH /api/chats/:id`              | Exactly one of `{"title":"..."}` or `{"model":"..."}`; returns the updated summary.                                                            |
| `PUT /api/chats/:id/sources`        | Source-scope union; returns `{source_mode,sources}`.                                                                                           |
| `DELETE /api/chats/:id`             | Returns `{"ok":true}`; `409` while the chat has an active run.                                                                                 |
| `POST /api/chats/:id/messages`      | `{"content":"..."}`; SSE contract above.                                                                                                       |
| `DELETE /api/chats/:id/runs/:runId` | Cancellation contract above.                                                                                                                   |

Titles are trimmed and must contain 1–80 Unicode characters. An omitted title
starts as `New chat` and becomes the first message's first 80 characters;
explicit titles are retained. Models are trimmed to a required 1–256 characters
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
`llm_base_url`, `llm_api_key`, `lm_studio_base_url`, `default_chat_model`,
`default_embed_model`, and `embedding_dimension` (integer 1–16,384). Omitting
`llm_api_key` preserves it; sending `null` clears it. `lm_studio_base_url: null`
clears the optional health endpoint. The response has the same redacted shape as
`GET`. Version-2 settings persist the embedding dimension; version-1 files are
read compatibly with the safe default. The settings file stores the API key as
plaintext and is replaced atomically with mode `0600`.

Both endpoint fields accept bare HTTP(S) origins only: no credentials, path
(including `/v1`), query, or fragment. Borealis appends `/v1` itself. HTTP is
allowed for loopback origins and `.local` hostnames; other endpoints require HTTPS. An LM Studio
health origin equivalent to the primary origin is omitted from the effective
configuration to avoid a duplicate probe.

Environment-managed fields return `409` if included in a patch, connection-test
draft, or qualification draft, even with the same value. Model IDs are trimmed,
contain 1–256 characters, and must identify distinct chat and embedding models,
including through aliases.

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
settings. When a remote provider is selected, chat prompts/history, retrieval
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
journaled apply-and-restart swap.

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
for every affected account when the provider is remote, non-environment-managed
embedding fields, a changed target identity, and sufficient disk space. With
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
`apply_pending`, where new chat turns are gated. Restart Borealis to execute the
journaled startup swap, pair the new model/dimension settings with the staged
index, reopen storage, verify its dimension and exact row count, and run a scoped
retrieval smoke when the snapshot is nonempty. Crash recovery rolls forward or
restores the old matched pair; every recovery phase revalidates the persisted
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

List entries contain `id`, `name`, `kind` (`document` or `tabular`),
`display_name`, `mime`, `size_bytes`, `status`, `created_at`, and `meta`.
`name` is the normalized dataset/source name, while `display_name` is the
upload's sanitized filename or the connector's display name. Optional `tabular` contains
`{table,original_name,rows}`. Source listing remains available if the data worker
cannot supply summaries. Upload/reingest responses also contain fields
such as `account_id`, `connector`, `file_path`, `url`, and `ready_generation`;
clients should use the UUID rather than treating local paths as API URLs.

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

### Reports and charts

| Endpoint                    | Response                                                                                                                                                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/reports`          | Paginated `{items,next_cursor}` of `{id,title,subtitle,chat_id,chat_title,created_at,updated_at,version,supersedes}`, newest first; no filesystem paths or payloads.                                                            |
| `GET /api/reports/:id`      | `{id,title,subtitle,created_at,updated_at,has_html,has_pdf,version,supersedes}`; owner detail adds `payload` when available. Shared detail currently adds both `shared_by_account:true` and `payload` — the known defect above. |
| `PATCH /api/reports/:id`    | Body `{title}` (1–200 chars); returns the renamed report DTO.                                                                                                                                                                   |
| `GET /api/reports/:id/html` | Owner-only today: self-contained `text/html`; shared recipients currently receive `404`.                                                                                                                                        |
| `GET /api/reports/:id/pdf`  | Owner-only today: `application/pdf` attachment with a `%PDF-` signature; shared recipients currently receive `404`.                                                                                                             |
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

## Agent tools

These operations run inside an accepted chat turn, not as independently callable
HTTP endpoints:

| Tool            | Boundary                                                                                                       |
| --------------- | -------------------------------------------------------------------------------------------------------------- |
| `retrieve`      | Searches only the run's ready source UUIDs; query up to 4,000 characters and 1–12 passages (default 6).        |
| `list_sources`  | Lists the accepted attachments and ready tables, with bounded descriptive metadata.                            |
| `query_data`    | One read-only `SELECT`, `WITH`, or `VALUES` statement against the immutable table allowlist.                   |
| `describe_data` | Bounded statistics for a selected, ready table.                                                                |
| `render_chart`  | Validates the canonical spec and stages a chart for this run.                                                  |
| `create_report` | Stages at most one report per run, using only charts owned by the same run.                                    |
| `fetch_url`     | Fetches a public URL explicitly present in the current user message, independently of stored-source selection. |

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
workspace — including SQLite WAL state, LanceDB, uploads, reports, settings,
signing secret, contained configuration, default model directory, migration
state, and other future files in that root — rather than enumerating a stale
allowlist.

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
and an active external LanceDB migration whose staging directory cannot be
captured. The manifest records the source workspace/addition roots, lexical
aliases, and portable archive path so restore can rebase source paths, pending
cleanup locations, report paths, contained binary/model paths, and migration
state to the new target. Directories restore as `0700`; ordinary and secret
files restore as `0600`, and owner-executable files as `0700`. The archive
output may not be inside any source.

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
| Chat creation/source scope, catalog-status UUID lists, and contained download request |         32 KiB |
| Agent and automation long-text mutations                                              |        128 KiB |
| Settings patch/test and model-qualification draft                                     |  157,696 bytes |
| Contained-engine configuration                                                        |        256 KiB |

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
| Agent execution            | Eight model iterations, eight tool calls per round, 24 calls per run, 120 seconds per model request, and 120 seconds per tool. Each model request asks for at most 2,400 output tokens; streamed content and reasoning are each capped at 32,000 characters. Tool arguments are capped at 20,000 characters per call and 80,000 per model round; serialized tool responses added to the model conversation are capped at 12,000 characters each. |
| Evidence display           | Eight passages, 800 characters per excerpt, and 6,000 aggregate characters.                                                                                                                                                                                                                                                                                                                                                                      |
| Query display snapshots    | Three queries per assistant message; 32 columns and 100 rows per query, 500 cells and 30,000 serialized characters across snapshots.                                                                                                                                                                                                                                                                                                             |
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
| `409`       | Active chat run/sync, source mutation conflict, scope overflow, duplicate email/table, or environment-managed setting. |
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

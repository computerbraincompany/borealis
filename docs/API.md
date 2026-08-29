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

Remote-provider egress is fail-closed. While a remote (public) provider is
configured and the account has not acknowledged remote egress, the
payload-bearing routes — chat messages, source upload, source reingest, and
connector create/sync — refuse with `403
{"error":"...","code":"REMOTE_EGRESS_CONSENT_REQUIRED"}` before any payload is
processed. `GET /api/consent/remote-egress` returns
`{required,acknowledged_at,endpoint_host}`; `POST` records the per-account
acknowledgment and unblocks the gated routes immediately. `endpoint_host` is
present only while a remote provider is configured, is a response field only,
and never appears in logs. Loopback and private-network providers never gate.

### Workspace: audit, shares, and automations

Small-team surfaces on one Borealis instance. All routes require
authentication and stay account-scoped.

| Endpoint                              | Response                                                                                          |
| ------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `GET /api/audit/egress?limit<=200`    | Content-free egress events: `{id,kind,endpoint_host,created_at}`, newest first.                    |
| `GET /api/accounts`                   | `[{id,email}]` — the workspace accounts available for snapshot sharing.                            |
| `POST /api/reports/:id/shares`        | Body `{recipient_account_id}`; `201` with `{recipient_account_id,shared_at}`.                      |
| `GET /api/reports/:id/shares`         | Shares of one owned report, recipient emails included.                                             |
| `DELETE /api/reports/:id/shares/:recipient` | `{"ok":true}` — owner-only revocation.                                                       |
| `GET /api/reports/shared`             | Reports shared with the caller: read-only snapshots with `owner_email`.                            |
| `GET /api/automations`                | Account automations with schedule, state, and failure counters.                                    |
| `POST /api/automations`               | `{name,kind,target_id,schedule_minutes,prompt?}` (15–10,080 minutes; prompt required for `agent_turn`). |
| `PATCH /api/automations/:id`          | `{name?,state?,schedule_minutes?}`.                                                                |
| `DELETE /api/automations/:id`         | `{"ok":true}`; run history cascades.                                                               |
| `GET /api/automations/:id/runs`       | Bounded run history `{outcome,detail,started_at,finished_at}`.                                     |

Sharing contract: shares exist only between accounts of this instance, are
created for published reports, and grant exactly read-only detail/HTML/PDF
access — rename, delete, payload, and further sharing stay with the owner.
Revocation is immediate. Automation runs are content-free; details use generic
phrases, and five consecutive failures pause the automation. Agent-turn
automations go through the same acceptance path as a human turn — the consent
gate, one-run-per-chat, and durable run records all apply — and a busy chat or
missing consent records a `skipped` run. Audit events never contain prompts,
source text, SQL, or model output, and are best-effort: a failed audit write
never fails the request that produced it.

### Contained models

Contained mode lets Borealis own a local model engine end to end: verified
weight downloads, a managed loopback `llama-server` process, and first-class
provider switching. All routes require authentication.

| Endpoint                                | Response                                                                                                    |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `GET /api/contained`                    | `{config,engine,downloads}` — current configuration, engine state, and download states.                      |
| `PUT /api/contained/config`             | Body `{enabled,binary_path,model_path,extra_args?}`; absolute paths, mode-`0600` `contained.json`.           |
| `POST /api/contained/downloads`         | Body `{url,filename,sha256}`; `202` with the download state.                                                 |
| `DELETE /api/contained/downloads/:name` | `{"ok":true}`; cancels and removes the `.part` artifact.                                                     |
| `POST /api/contained/engine/start`      | `202` with the engine state; health is polled in the background.                                              |
| `POST /api/contained/engine/stop`       | Engine state after an orderly SIGTERM (bounded SIGKILL).                                                     |

Download contract: `filename` is 1–180 characters of `[A-Za-z0-9._-]` (no
separators), `sha256` is mandatory and verified before the file is atomically
renamed into place — a mismatch deletes the artifact and records a failed
state. Downloads resume from the existing `.part` byte range, are bounded in
size, and accept only HTTPS or loopback HTTP origins without credentials,
query, or fragments. Redirects are refused.

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

`GET /api/status` carries the ambient `contained` section
(`{state,model,endpoint_host,endpoint_managed_by_env}` or `null`) so the
workspace chrome can say "On this Mac · contained".

### Agents

| Endpoint               | Response                                                                                                        |
| ---------------------- | --------------------------------------------------------------------------------------------------------------- |
| `GET /api/agents`      | Array of `{id,name,current_version,instructions,instructions_chars,created_at,updated_at}`, newest first.       |
| `POST /api/agents`     | Body `{name,instructions}` (name 1–80 chars unique per account; instructions 1–8,000 chars); returns `201`.     |
| `GET /api/agents/:id`  | `{...summary,revisions}` with every immutable revision, newest first.                                            |
| `PATCH /api/agents/:id`| Body `{name?}`, `{instructions?}`, or both; new instructions become the next immutable revision.                 |
| `DELETE /api/agents/:id`| `{"ok":true}`; bound chats keep running and become unbound (`agent_id` is `SET NULL`).                         |

A chat may bind one agent when it is created: `POST /api/chats` accepts an
optional `agent_id` (must reference an owned agent; unknown or foreign ids
return `400`). The binding is write-once — it cannot be changed or removed
while the chat exists, and chat DTOs carry `agent: {id,name} | null`. At turn
acceptance the server resolves the agent's *current* revision inside the
accept transaction and stores its instructions on the durable run
(`chat_runs.agent_instructions`); later agent edits or deletion never change a
running or completed turn. During the run, the instructions are appended to
the system prompt in a bounded `Workspace agent instructions` section that
states the platform's operating rules stay fixed workspace policy. Agents
never change the tool set, retrieval scope, or any authorization: everything
the runner may do is server policy exactly as for unbound chats. Instructions
are never logged.

### Libraries

| Endpoint                        | Response                                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `GET /api/libraries`            | Array of `{id,name,member_count,created_at,updated_at}`, newest first.                                       |
| `POST /api/libraries`           | Body `{name}` (1–120 chars, unique per account); returns `201` with the library.                              |
| `GET /api/libraries/:id`        | `{id,name,created_at,updated_at,members}` with the members in the sources-list DTO.                          |
| `PATCH /api/libraries/:id`      | Body `{name}`; returns the renamed library.                                                                   |
| `PUT /api/libraries/:id/sources`| Body `{source_ids}` (≤100, distinct, all owned by the account); replaces membership exactly.                  |
| `DELETE /api/libraries/:id`     | `{"ok":true}`; membership rows cascade. Sources and their data are never touched.                            |

Libraries reference sources; they never copy or move them. There is no server
side chat–library binding: attaching a library expands its ready members into
a chat's explicit `selected` scope through the normal chat-creation contract,
so the three-meaning source-scope semantics are unchanged.

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
in one SQLite transaction. Later model or source changes affect the next turn, not an
already accepted run. This is a stored-data tool boundary: prior conversation
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
(there are no SSE `event:` or `id:` fields). Event types are:

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

Assistant `meta` contains `charts` (chart UUIDs), `report` (a report UUID or
`null`), `model`, `source_mode`, `source_ids`, `citations`, `evidence`, and
`query_results`. Evidence contains bounded
`{source_id,chunk_id,source,excerpt,score}` records. `citations` maps each
bracketed citation marker the answer actually used onto the run's own evidence:
`{n,source_id,chunk_id,source}` with 1-based `n` into the `evidence` array,
deduped and capped at 8. Markers that do not resolve to evidence are never
recorded and stay plain text in the UI. Query display snapshots contain
`{id,sql,columns,rows,row_count,truncated}`; they are bounded display
artifacts, not complete query exports. User message metadata records only the
accepted model and source snapshot.

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
`{locality,endpoint_reachable,lm_studio_reachable,chat_model,embed_model,checked_at,latency_ms}`.
`locality` is `local`, `private`, or `remote`; `lm_studio_reachable` is `null`
when no separate LM Studio health endpoint is configured. Latency is bounded to
0–2,000 ms and served from a 20-second single-flight cache. The snapshot is
informational chrome state, not an authorization surface.

`GET /api/models` returns, for example:

```json
{
  "models": [{ "id": "qwen-chat" }],
  "default_model": "qwen-chat",
  "discovery": "live"
}
```

Entries contain only `id` and optional `owned_by`, are deduplicated and sorted,
and exclude the configured embedding identity. Known physical model IDs map
back to the stable aliases in [llmAliases.ts](../server/src/llmAliases.ts);
unknown IDs are preserved. Successful discovery is cached for 15 seconds;
`?refresh=1` bypasses that cache (`refresh=0` is also accepted). Discovery failure
returns `200` with `models: []` and `discovery: "unavailable"`, keeping the
configured `default_model`. Settings changes invalidate the runtime's catalog
cache. Discovery is informational; saving a per-chat model does not require it
to appear in the current catalog.

### Chats

| Endpoint                            | Request and response                                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `GET /api/chats`                    | Array of `{id,title,model,source_mode,created_at,updated_at}`, ordered by latest activity, then ID.     |
| `POST /api/chats`                   | Optional `title` and source-scope union; returns the chat summary. Uses the current default chat model. |
| `GET /api/chats/:id`                | Summary, sources, bounded history page, and active run; accepts `limit` and `before_message_id`.        |
| `PATCH /api/chats/:id`              | Exactly one of `{"title":"..."}` or `{"model":"..."}`; returns the updated summary.                     |
| `PUT /api/chats/:id/sources`        | Source-scope union; returns `{source_mode,sources}`.                                                    |
| `DELETE /api/chats/:id`             | Returns `{"ok":true}`; `409` while the chat has an active run.                                          |
| `POST /api/chats/:id/messages`      | `{"content":"..."}`; SSE contract above.                                                                |
| `DELETE /api/chats/:id/runs/:runId` | Cancellation contract above.                                                                            |

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

### Provider Settings

- `GET /api/settings`
- `PATCH /api/settings`
- `POST /api/settings/test`

`GET /api/settings` returns the effective OpenAI-compatible provider
configuration:

```json
{
  "llm_base_url": "http://127.0.0.1:1234",
  "llm_api_key_configured": false,
  "lm_studio_base_url": null,
  "default_chat_model": "qwen-chat",
  "default_embed_model": "nomic-embed",
  "managed_by_env": {
    "llm_base_url": false,
    "llm_api_key": false,
    "lm_studio_base_url": false,
    "default_chat_model": false,
    "default_embed_model": false
  }
}
```

Settings are shared by the running Borealis instance, not scoped to the signed-in
account. Any authenticated account can read or update them. The stored API key
is never returned. `PATCH /api/settings` accepts any subset of
`llm_base_url`, `llm_api_key`, `lm_studio_base_url`, `default_chat_model`, and
`default_embed_model`. Omitting `llm_api_key` preserves it; sending `null` clears
it. `lm_studio_base_url: null` clears the optional health endpoint. The response
has the same redacted shape as `GET`. The settings file stores the API key as
plaintext and is replaced atomically with mode `0600`.

Both endpoint fields accept bare HTTP(S) origins only: no credentials, path
(including `/v1`), query, or fragment. Borealis appends `/v1` itself. HTTP is
allowed only for loopback origins; other endpoints require HTTPS. An LM Studio
health origin equivalent to the primary origin is omitted from the effective
configuration to avoid a duplicate probe.

Environment-managed fields return `409` if included in a patch or test draft,
even with the same value. Model IDs are trimmed, contain 1–256 characters, and
must identify distinct chat and embedding models, including through aliases.

Canonical environment overrides are `LLM_BASE_URL`, `LLM_API_KEY`,
`LLM_CHAT_MODEL`, and `LLM_EMBED_MODEL`, plus `LM_STUDIO_BASE_URL` for the optional
health endpoint. Historical `LITELLM_*` names remain supported as lower-precedence
compatibility aliases. They configure the direct
OpenAI-compatible client and do not imply an intermediary sidecar.

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

Saving through `PATCH` updates later model operations without restarting the
process. It does not rewrite models already saved on existing chats; a changed
chat default applies to new chats. Direct edits to `settings.json` require a
restart for the running model client to reload them.

Changing the embedding model does not regenerate existing vectors. Reingest all
sources after a deliberate model change with the same vector dimension. The
LanceDB table dimension is fixed when created; changing `EMBEDDING_DIM` does not
resize it, and an existing table with a different dimension is rejected on open.
Use a new complete application-data directory and fresh ingestion, or an explicit
coordinated migration of SQLite and LanceDB. Do not replace only the vector index
while retaining an unmatched ledger.

### Sources

| Endpoint                         | Request and response                                                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/sources`               | Array of compact metadata with an optional `tabular` summary; no full dataset preview.                                    |
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
PDF ingestion extracts existing text; it does not perform OCR.

Uploads stream to disk under an account/source UUID directory, with the byte
limit enforced even if the multipart stream is truncated. The initial response
means ingestion is queued, not complete. Poll `GET /api/sources` while a source
is `index`; stop on `ready` or `error`. Transient processing failures are retried
automatically. Reingestion uses the saved file or connector cache; use connector
sync to download a fresh URL version.

On `error`, `meta` contains safe `error`, `error_code`, `error_detail`, and
`error_stage` fields. The list entry also includes
`ingestion: {attempts,updated_at}` (attempts are bounded to 0–100; the timestamp
can be `null`). Other source states return `meta: {}` in the list response.
Public failure codes are:

| Code                         | Stage       | Meaning                                                              |
| ---------------------------- | ----------- | -------------------------------------------------------------------- |
| `NO_READABLE_TEXT`           | `reading`   | No extractable text or table rows.                                   |
| `UNSUPPORTED_FORMAT`         | `reading`   | The stored format cannot be processed.                               |
| `DATASET_PARSE_FAILED`       | `parsing`   | Invalid tabular data.                                                |
| `DATA_SERVICE_UNAVAILABLE`   | `parsing`   | Local data processing could not complete.                            |
| `EMBEDDING_UNAVAILABLE`      | `embedding` | The configured embedding service was unavailable.                    |
| `EMBEDDING_INVALID_RESPONSE` | `embedding` | Invalid embedding output or incompatible vector dimension.           |
| `SOURCE_UNAVAILABLE`         | `storage`   | The stored input file could not be accessed.                         |
| `INGEST_FAILED`              | `storage`   | Other processing failure, including unrecognized stored error codes. |

Reingestion or deletion returns `409` when that exact source is in an active
run, or its connector is syncing/indexing. Unfinished cleanup is retained
durably for repair; `ok: true` confirms logical deletion, not secure erasure of
every backing file.

### URL connectors

- `GET /api/connectors`
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

List and creation responses contain `id`, `account_id`, `name`, `type`,
`config`, `target_table`, `last_sync`, `sync_status`, `sync_error`,
`created_at`, and `schedule`. Note that the input field is `display_name`, but
the response field is `name`. Sync success returns
`{"synced":true,"processing":true}`. Poll the connector and its source:
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
content-free sync history, newest first:
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

### Reports and charts

| Endpoint                    | Response                                                                                                    |
| --------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `GET /api/reports`          | Array of `{id,title,subtitle,chat_id,chat_title,created_at,updated_at,version,supersedes}`, newest first; no filesystem paths or payloads. |
| `GET /api/reports/:id`      | `{id,title,subtitle,created_at,updated_at,has_html,has_pdf,version,supersedes}` plus the stored normalized `payload` when one was captured. |
| `PATCH /api/reports/:id`    | Body `{title}` (1–200 chars); returns the renamed report DTO.                                               |
| `GET /api/reports/:id/html` | Self-contained `text/html`.                                                                                 |
| `GET /api/reports/:id/pdf`  | `application/pdf` attachment with a `%PDF-` signature.                                                      |
| `DELETE /api/reports/:id`   | `{"ok":true}`, or `503 {"error":"report cleanup deferred"}` if physical cleanup must retry.                 |
| `GET /api/charts`           | Array of `{id,run_id,chat_id,title,kind,created_at}` for published charts, newest first, bounded to 200; no spec echo or PNG bytes. |
| `GET /api/charts/:id`       | `{id,spec,echarts,png_base64}`.                                                                             |
| `POST /api/charts/:id/png`  | No body; JSON `{png_base64}`, not raw PNG bytes.                                                            |

Reports carry per-chat lineage: the first published report for a chat is
`version 1`; each later report the agent creates in the same chat takes the
next version and names the report it `supersedes`. Versions count published
reports only — pending artifacts from failed or discarded runs never join the
chain — and superseded reports are never deleted automatically. The stored
payload is the normalized report document (sections, resolved chart specs,
tables); it is omitted when it exceeded the capture bound and is never included
in list responses.

The agent's `render_chart` and `create_report` tools create artifacts; there are
no public creation endpoints. Charts/reports remain private to their pending
run until the assistant message and successful run completion commit together.
Unowned, missing, or pending artifacts return `404`. Missing HTML/PDF exports
and PNG export requests without a stored PNG also return `404`; the chart JSON
itself can contain `png_base64: null`. Report deletion hides it before
filesystem cleanup; a deferred cleanup response does not make it visible again.

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
`{name,value,color}` items with nonnegative values and a positive total. Colors
are canonical six-digit hex values; numeric values are finite and bounded.
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

Tabular sources retain the full registered dataset for SQL, while ingestion
embeds a bounded preview of up to 40 rows. Retrieval is not an exhaustive search
of every dataset cell. Document extraction is also bounded; large documents can
be only partially indexed. External source content is treated as untrusted data,
not instructions or authorization to expand tool scope.

## Storage and backup boundary

SQLite is authoritative for relational state and passage text. LanceDB stores
only vectors keyed by stable chunk UUID, account, source, and ingestion
generation. Retrieval applies its account/source allowlist before vector search,
then joins results back to SQLite under the same scope and drops missing rows.
DuckDB is reserved for bounded analytical queries over user tables.

Stop Borealis before backup or restore. The SQLite file and LanceDB directory
are one logical store and must be copied and restored together. Prefer copying
the complete application-data directory, including SQLite WAL files, uploads,
reports, `settings.json`, and `jwt.secret`. The desktop paths are
`borealis.sqlite` and `lancedb/` beneath
`~/Library/Application Support/Borealis/`; browser development uses the same
names under `.borealis/` unless configured otherwise. Protect backups as private
data because they can contain source content, provider credentials, and the JWT
signing secret.

Securely preserve and reapply operator environment overrides separately,
especially `JWT_SECRET`, `EMBEDDING_DIM`, and provider/model settings. They are
not necessarily stored in the application-data directory, and restored data
must use compatible signing and embedding configuration.

## Limits and status codes

Configurable defaults are shown in [server/.env.example](../server/.env.example):

| Setting                | Default                       | Maximum                                               |
| ---------------------- | ----------------------------- | ----------------------------------------------------- |
| `MAX_UPLOAD_BYTES`     | 25 MiB                        | 250 MiB                                               |
| `MAX_MESSAGE_CHARS`    | 32,000 Unicode characters     | 100,000                                               |
| `MAX_HISTORY_MESSAGES` | 80                            | 500 for model history; HTTP pages are capped at 100   |
| `MAX_HISTORY_CHARS`    | 120,000 serialized characters | 500,000; must be at least `MAX_MESSAGE_CHARS + 36000` |
| `MAX_EXTRACTED_CHARS`  | 2,000,000 characters          | 10,000,000                                            |
| `MAX_INGEST_CHUNKS`    | 2,500 chunks per generation   | 10,000                                                |

All configured budgets must be positive integers. HTTP bodies have additional
route limits: 2 KiB for auth, 4 KiB for chat patches, 8 KiB for connector
creation, and 16 KiB for chat creation/source scope and Settings requests.
Message transport permits JSON escaping within the decoded character limit;
uploads allow a 64 KiB multipart envelope above the file limit. History metadata
is capped at 32,000 characters per message.

The following fixed boundaries apply to internal operations. A tool result can
be truncated even though the source itself is ready; consumers should honor
`truncated`, `columns_truncated`, and returned-row counts rather than assuming a
complete result.

| Boundary                   | Limit                                                                                                                                                                                                                                                                               |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connector download         | 50 MiB, 60 seconds, three redirects; oversized downloads fail.                                                                                                                                                                                                                      |
| Agent web fetch            | 1,000,000 response bytes, 15 seconds, three redirects; tool text is capped at 12,000 characters.                                                                                                                                                                                    |
| DuckDB query               | 30-second SQL execution deadline; 500 rows, 100 columns, 50,000 cells, 1,000,000 returned characters, and 10,000 characters per cell. Agent SQL is capped at 20,000 characters (worker ceiling: 100,000).                                                                           |
| Dataset extraction         | Worker ceiling of 2,000 rows, 500 columns, 50,000 cells, 1,000,000 characters, and 10,000 characters per cell; the facade requests at most 100 rows and ingestion uses 40.                                                                                                          |
| Dataset description        | Up to 100,000 profiled rows, 100 columns, and 128,000 returned characters; top values are computed for at most 20 columns.                                                                                                                                                          |
| Registered dataset/catalog | 500 columns per table; 100 allowed tables per scope; eight cached scopes per account; 256,000 characters per catalog response.                                                                                                                                                      |
| Agent execution            | Eight model iterations, eight tool calls per round, 24 calls per run, and 120 seconds per tool. Tool arguments are capped at 20,000 characters per call and 80,000 per model round; serialized tool responses added to the model conversation are capped at 12,000 characters each. |
| Evidence display           | Eight passages, 800 characters per excerpt, and 6,000 aggregate characters.                                                                                                                                                                                                         |
| Query display snapshots    | Three queries per assistant message; 32 columns and 100 rows per query, 500 cells and 30,000 serialized characters across snapshots.                                                                                                                                                |
| Chart spec                 | 500 categories, 20 series, 100 pie items, 500 characters per label; finite numbers with magnitude at most `1e15`.                                                                                                                                                                   |
| Report                     | One per run; 20 sections (50,000 characters each), 20 charts, eight tables (32 columns and 60 rows each). The agent additionally caps section text at 200,000 characters and tables at 1,000 cells/100,000 characters in aggregate.                                                 |
| Static rendering           | PNG data URLs up to 8 MiB; Electron additionally validates a 16 MiB HTML IPC payload ceiling and a 90-second render-request deadline.                                                                                                                                               |

File-processing ceilings also include the first 500 PDF pages; DOCX archives
with at most 2,048 members, 100 MiB total expansion, 50 MiB per member, and a
200:1 compression ratio; and XLSX archives with at most 10,000 members, 100 MiB
total expansion, and 50 MiB per member. The XLSX first-sheet parser permits up to
200,000 logical rows, 10,000 columns, and 2,000,000 cells, but the registered
dataset still has the stricter 500-column limit.

| HTTP status | Typical meaning                                                                                                        |
| ----------- | ---------------------------------------------------------------------------------------------------------------------- |
| `400`       | Malformed input, invalid settings/scope, or unavailable attachment IDs.                                                |
| `401`       | Missing/invalid JWT or incorrect login credentials.                                                                    |
| `404`       | Unknown/unowned resource, pending artifact, or unavailable export.                                                     |
| `409`       | Active chat run/sync, source mutation conflict, scope overflow, duplicate email/table, or environment-managed setting. |
| `413`       | Request body or upload exceeds its size boundary.                                                                      |
| `415`       | Unsupported HTTP content type.                                                                                         |
| `422`       | Unsupported upload type or connector preparation/sync failure.                                                         |
| `500`       | Unexpected server failure with a bounded public error.                                                                 |
| `503`       | Failed Settings connection probe or deferred report cleanup.                                                           |

Asynchronous ingestion failures appear in source status/metadata after the
initial successful upload. Once SSE starts, agent failures use its `error` and
`run-ended` events instead of changing the HTTP status. Treat public messages as
stable categories, not as a substitute for the correlated server logs.

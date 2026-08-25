# Borealis API

The Fastify API listens on `http://127.0.0.1:3000` by default. Registration and
login are public; every other `/api/*` endpoint requires a JWT in
`Authorization: Bearer <token>`. The Python service on port 8000 is an internal
service and is not part of this public contract.

Responses include `X-Request-ID`. Clients may send a request ID containing only
letters, digits, `.`, `_`, or `-` (maximum 128 characters); invalid values are
replaced. Errors use a bounded public envelope such as `{"error":"..."}` and do
not include provider responses, SQL, local paths, or exception text.

Browser origins are not reflected. Configure an exact comma-separated
`CORS_ORIGINS` allowlist when the frontend is not served from the default
loopback Vite origins.

An authenticated OpenAPI snapshot is available at `GET /api/openapi.json`.

The public `GET /health` endpoint is a fast process-liveness probe. Authenticated
clients can use `GET /api/health` for dependency readiness. It reports bounded
status and latency for the Borealis API, PostgreSQL, the Python data service,
LiteLLM, and LM Studio without returning service URLs, credentials, model IDs,
or raw upstream errors. A degraded dependency does not change the liveness
endpoint, which avoids restarting a healthy API process because an upstream
service is temporarily unavailable.

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

Register with `POST /api/register` or log in with `POST /api/login`; both accept
`{"email":"...","password":"..."}` and return `{token,user}`. A JWT expires
after seven days. `GET /api/me` validates the current token.

## Source scope and turn snapshots

A chat has exactly one of these states:

- `{"source_mode":"all"}` dynamically includes every ready source currently
  owned by the account.
- `{"source_mode":"selected","source_ids":[...]}` is a stable allowlist.
- `{"source_mode":"selected","source_ids":[]}` deliberately grants no stored
  source access and never widens to `all`.

Only ready sources are included in a turn. The accepted model, source mode, and
concrete ready source IDs are committed with the user message and run in one
repeatable-read transaction. Later model or source changes affect the next turn,
not an already accepted run.

## Chat history and runs

`GET /api/chats/:id?limit=50` returns the newest page in chronological order and
adds:

```json
{
  "active_run": { "id": "<run-uuid>", "status": "running" },
  "messages_page": {
    "has_more": true,
    "next_before_message_id": "123"
  }
}
```

Pass that cursor as `before_message_id` to load older messages. `limit` is 1–100.
`active_run` is `null` when no run is active and lets clients rehydrate a
`running` or `cancelling` run after navigation or reload. Omitting `limit` returns
the configured bounded first-page size (80 messages by default); history is never
returned as an unbounded response.

`POST /api/chats/:id/messages` accepts `{"content":"..."}` and returns
`text/event-stream`. Every frame is JSON in an SSE `data:` field. Event types are:

| Type | Stable fields | Meaning |
| --- | --- | --- |
| `run-started` | `run_id` | Durable run identity; retain it for cancellation. |
| `user-saved` | `message_id` | The user message and immutable turn snapshot committed. |
| `step-start` | `name`, `summary` | A sanitized operation summary; never raw arguments. |
| `step-end` | `name`, `summary`, `status` | Sanitized completion state (`ok` or `error`). |
| `delta` | `text` | Final answer text. Provider reasoning is never emitted. |
| `message` | `content`, `meta` | Persisted assistant message and bounded display artifacts. |
| `error` | `message` | Public cancellation or failure message. |
| `done` | — | Legacy success marker, emitted only after the durable run completes. |
| `run-ended` | `run_id`, `status` | Authoritative terminal state: `completed`, `cancelled`, or `failed`. |

Only one run may be active per chat. After receiving `run-started`, cancel with:

```bash
curl --fail-with-body --silent --show-error \
  -X DELETE \
  -H "Authorization: Bearer $BOREALIS_TOKEN" \
  "$BOREALIS_API/api/chats/<chat-uuid>/runs/<run-uuid>"
```

Cancellation is idempotent for an owned run. The response reports `cancelling`
or the already-terminal `completed`, `cancelled`, or `failed` state; `404` means
the run does not exist in that owned chat. A server restart marks interrupted
runs failed; it never presents them as completed.

## Resources

### Models and chats

- `GET /api/health`
- `GET /api/models[?refresh=1]`
- `GET /api/chats`
- `POST /api/chats`
- `GET /api/chats/:id[?limit=N&before_message_id=ID]`
- `PATCH /api/chats/:id` with exactly one of `model` or `title`
- `PUT /api/chats/:id/sources`
- `DELETE /api/chats/:id`
- `POST /api/chats/:id/messages` (SSE)
- `DELETE /api/chats/:id/runs/:runId`

### Sources

- `GET /api/sources` returns compact source metadata plus a bounded tabular
  summary when available. It never returns a full dataset preview.
- `POST /api/sources/upload` accepts exactly one multipart field named `file`.
- `POST /api/sources/:id/reingest` queues a new durable ingestion generation.
- `DELETE /api/sources/:id` deletes that owned source and its scoped artifacts.

Uploads are streamed to disk under an account/source UUID directory. The server
enforces its byte limit even when the multipart stream is truncated. Ingestion is
asynchronous: poll only sources whose status is `index`; stop on `ready` or
`error` and surface the bounded `meta.error` message. Legacy `.doc` and `.xls`
files are rejected explicitly; use `.docx` and `.xlsx` instead.

### URL connectors

- `GET /api/connectors`
- `POST /api/connectors`
- `POST /api/connectors/:id/sync`
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

`type` is `url_csv` or `url_json`; `target_table` must match
`^[a-z][a-z0-9_]{0,62}$` and be unique within the account. Connector states are
`syncing`, `indexing`, `idle`, or `error`. Downloads are bounded and atomically
promoted only after DuckDB accepts the staged file, so a bad refresh preserves
the last known-good data. Private, loopback, link-local, and otherwise unsafe
destinations are rejected on the initial URL and every redirect.

### Reports and charts

- `GET /api/reports`
- `GET /api/reports/:id`
- `GET /api/reports/:id/html`
- `GET /api/reports/:id/pdf`
- `DELETE /api/reports/:id`
- `GET /api/charts/:id`
- `POST /api/charts/:id/png`

Report HTML is self-contained and served with a restrictive CSP. PDF rendering
accepts only the structured report payload generated by Borealis and uses a
data-only resource loader; it cannot read local files or fetch network resources.
Chart responses reuse the PNG generated with the canonical chart spec rather
than rendering a second time.

## Limits and status codes

Configurable Node defaults for uploads, messages, history, extracted text, and
ingestion chunks live in `server/.env.example`. Fixed service boundaries include:

- connector downloads: 50 MiB, 60 seconds, and three redirects;
- agent web fetches: 1,000,000 response bytes, 15 seconds, and three redirects;
- DuckDB queries: 30 seconds, 500 rows, 100 columns, 50,000 cells, and 1,000,000
  returned characters;
- dataset extracts: 2,000 rows, 500 columns, 50,000 cells, and 1,000,000 returned
  characters;
- agent tools: 120 seconds each, at most eight calls per round and 24 per run;
- reports: at most 20 sections, 20 charts, and eight tables, with a 128 MiB
  internal-service request-body ceiling.

Common responses are `400` malformed input, `401` missing/invalid JWT, `404`
unknown or unowned resource, `409` conflicting chat run or table name, `413`
configured size limit exceeded, `422` accepted input that could not be parsed or
processed, and `500` an unexpected server failure. Treat public messages as
stable categories, not as a substitute for the correlated server logs.

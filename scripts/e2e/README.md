# E2E protocol fixtures and synthetic corpora

Standalone loopback fixtures and deterministic corpora required by
[docs/END_TO_END_ACCEPTANCE.md](../../docs/END_TO_END_ACCEPTANCE.md)
("Test environment and repeatability"). They exist so the product acceptance
harness (`pnpm test:e2e:product*`, wired separately) can exercise actual
transports — SSE, MCP stdio and Streamable HTTP, OAuth, WebDAV — without a
live model or external network.

## Conventions

- Node 22 (`node scripts/e2e/fixtures/<name>.mjs`), no new npm dependencies.
  The MCP fixtures import the pinned `@modelcontextprotocol/sdk` from the
  workspace `server` package (bare import, falling back to the physical
  `server/node_modules` path after `pnpm install` at the repository root).
- Loopback only: every listener binds `127.0.0.1` on an OS-assigned port.
- Ready signal: HTTP fixtures print exactly one content-free JSON line to
  stdout, e.g. `{"protocol":"borealis-e2e-fixture","fixture":"webdav","origin":"http://127.0.0.1:PORT",...}`.
  The stdio MCP fixture prints no ready line — stdout there is MCP JSON-RPC
  bytes only, and the `initialize` response is the ready signal.
- Nothing is ever logged except content-free summaries: no bodies, tokens,
  credentials, or header values. Request bodies are bounded; oversized
  sockets are destroyed.
- `SIGTERM`/`SIGINT` (and stdin close for the stdio fixture) shut down
  cleanly with exit code `0`. Fixtures never spawn children.
- Self-test: `node scripts/e2e/fixtures/selftest.mjs` (optionally one group:
  `provider|mcp-stdio|mcp-http|issuer|webdav|corpus|finance`). Starts everything,
  drives each failure mode, exits `0` on success, and proves every spawned
  PID is gone afterwards.

## Fixtures

### `fixtures/openai-provider.mjs` — OpenAI-compatible chat + embeddings (journeys A–F)

| env | meaning |
| --- | --- |
| `E2E_OPENAI_CHAT_MODEL` / `E2E_OPENAI_EMBED_MODEL` | advertised model ids (defaults `fixture-chat-v1` / `fixture-embed-v1`) |
| `E2E_OPENAI_EMBED_DIM` | embedding dimension (default 64) |
| `E2E_OPENAI_SCRIPT` | step script: inline JSON or `@file` |
| `E2E_OPENAI_ON_EXHAUSTED` | `repeat-last` (default) or `fail` (400) |

Script step types: `text`, `tool_call` (deliberately split name/argument
frames for the streamed tool-call accumulator), `malformed` (raw broken
`data:` frame), `slow` (`delay_ms`), `no_response` (SSE headers then silence —
client deadlines must end it), `http_error` (`status`).

Endpoints: `POST /v1/chat/completions` (stream-only), `POST /v1/embeddings`
(deterministic unit-norm float arrays; `encoding_format: "base64"` honoured as
float32-LE base64), `GET /v1/models`, and `GET /fixture/state` which returns
the content-free Authorization-header record (`present`/`scheme` only — never
values) plus call counters. `POST /fixture/script` installs a new step script
at runtime (`{"steps":[...],"on_exhausted"?:...}`, same step validation as the
env script) and resets the step pointer, so a journey can drive a
deterministic tool-call roundtrip against the one provider instance the
harness launched; step shape only — script content is never logged.

### `fixtures/mcp-server-stdio.mjs` — MCP over stdio (journey A)

Spawn directly: `node scripts/e2e/fixtures/mcp-server-stdio.mjs` (stdio is
the protocol; do not expect stdout JSON). Tools: `echo_query`, `finance_sum`,
`record_note` (write-flagged), `big_result` (>64 KiB), `weird_schema`
(unsupported input-schema shape), `slow_snooze` (default 31 s > the 30 s tool
deadline). Toggles: `E2E_MCP_BULK_TOOLS=195` pushes `tools/list` to 201
entries (over the 200-tool discovery cap); `E2E_MCP_SLOW_MS` overrides the
sleep so tests can exercise the sleeping path quickly. Closing stdin exits 0.

### `fixtures/mcp-server-http.mjs` — MCP over Streamable HTTP (journey A)

Ready line carries `endpoint` = `http://127.0.0.1:PORT/mcp` and
`auth_required` (`none|bearer|oauth|oauth-verify`). Stateful sessions; clients
send `Accept: application/json, text/event-stream` and echo
`mcp-protocol-version` on session requests. Toggles: `E2E_MCP_BEARER`
enforces exactly that bearer token (401 otherwise);
`E2E_MCP_OAUTH_CHALLENGE=1` makes every MCP request 401 with a
`WWW-Authenticate: Bearer resource_metadata=...` challenge pointing at
`E2E_MCP_ISSUER_ORIGIN` (plus a `/.well-known/oauth-protected-resource`
document); `E2E_MCP_OAUTH_VERIFY=1` (requires `E2E_MCP_ISSUER_ORIGIN`) is the
full journey-A path: the same PRM document and challenge advertise OAuth, but
requests carrying `Authorization: Bearer <token>` are validated against the
issuer's `POST /token/introspect` and only active access tokens serve MCP —
so sign-in, refresh rotation, expiry, and revocation are all observable
end-to-end. Same tool inventory as the stdio fixture.

### `fixtures/oauth-issuer.mjs` — authorization-code + PKCE issuer (journey A)

RFC 8414 discovery, RFC 7591 registration, `/authorize` (S256 PKCE required,
exact redirect-URI matching, `E2E_OAUTH_AUTHORIZE_MODE=deny` or `?fx_mode=deny`
for the consent-denial path), `/token` (code exchange; refresh rotation where
each refresh token is single-use), `/revoke`, and a non-standard
`POST /token/introspect` helper that reports `{active, expires_at}` so expiry
tests never parse secrets into application code. Set
`E2E_OAUTH_ACCESS_TTL_SECONDS=2` for credential-refresh journeys; codes are
single-use regardless of verification outcome.

### `fixtures/webdav.mjs` — authenticated WebDAV (journey D)

Basic-authenticated `DAV:1` collection (`OPTIONS/HEAD/GET/PROPFIND/PUT/DELETE/MKCOL`)
over one process with two loopback origins. `PROPFIND` supports `Depth: 0|1`
only. Root defaults to a seeded temp directory; point `E2E_WEBDAV_ROOT` at a
real corpus directory for refresh/watch exercises (edit files on disk to make
the connector see changes). Toggles: `E2E_WEBDAV_USER`/`E2E_WEBDAV_PASS`,
`E2E_WEBDAV_XML_MODE=malformed|hostile` (unterminated 207 vs an
ENTITY/DOCTYPE-laden 207 — the expansion defence is client-side, this only
emits the hostile shapes), `E2E_WEBDAV_DELAY_MS` for latency/timeout tests.
Any primary request under `/redirect/...` answers `301` to the second origin
without continuing credentials, so a client that must refuse cross-origin
credential replay can be observed doing it.

## Corpora

### `data/e2e/supplier-corpus/` — ten-document supplier corpus (journey E)

Regenerate with `node data/e2e/generate_supplier_corpus.mjs [--out DIR]`;
outputs are byte-identical run to run (no timestamps, no randomness).
`manifest.json` commits per-document SHA-256, typed fields, and the expected
facts: five suppliers × price/effective-date/renewal/tier/exceptions, the
acme-logistics price conflict (12000 vs 13500 USD), one missing field
(`04_blueriver_change_order.md` exceptions), the unsupported `.rtf` hiding a
Delta price of 4600 that extraction must never surface, and the image-only
PDF `10_acme_scanned_invoice.pdf` (hand-built single-page PDF: one raw
DeviceGray 240×140 raster XObject painted from a 5×7 pixel font — zero text
operators, so text extraction is empty while an OCR fallback can see the
field-free words). The self-test regenerates to a temp dir and byte-compares
against the committed files.

### `data/e2e/finance-brief-fixture/` — M16 brief aggregate (journeys B/C/F)

`brief_inputs.csv` sums to exactly `100` under the committed `sum_office.sql`
(integer-cent amounts keep the DOUBLE SUM exact); `brief_inputs_changed.csv`
raises one row to sum `125`, giving the saved-analysis rerun a known numeric
diff. `manifest.json` commits hashes, the DuckDB load recipe, and both
expected sums.

## Journey map

| Fixture / corpus | A | B | C | D | E | F |
| --- | --- | --- | --- | --- | --- | --- |
| openai-provider | ✔ (tool-call chat) | ✔ | ✔ | ✔ | ✔ | ✔ |
| mcp-server-stdio / -http | ✔ | | | | | |
| oauth-issuer | ✔ | | | | | |
| webdav | | | | ✔ | | ✔ (input refresh) |
| supplier-corpus | | | | | ✔ | |
| finance-brief-fixture | | ✔ | ✔ | | | ✔ |
| `data/sample` (existing `generate_sample.ts`) | | ✔ | | | | |

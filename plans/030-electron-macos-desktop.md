# Plan 030: Ship Borealis as a macOS Electron app

> **Completed historical plan.** The [ledger](README.md) records this plan as
> DONE. The original instructions, code excerpts, paths, and checklists below
> describe its implementation-era tree; do not execute them against the current
> checkout. For supported behavior and commands, use the [project README](../README.md),
> [API reference](../docs/API.md), and [desktop guide](../desktop/README.md).

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Hard dependency**: Plan 029 must be **DONE**. Do not package Electron
> around FastAPI, WeasyPrint, uv, or LiteLLM.
>
> **Drift check (run first, after 029)**:
> `git diff --stat 130481b..HEAD -- server/src/db.ts server/src/index.ts server/src/config.ts server/src/auth.ts server/src/retrieve.ts server/src/llm.ts server/src/systemHealth.ts server/src/ingestionFailures.ts server/src/routes/system.ts server/src/pythonClient.ts server/src/data web/src/lib/api.ts web/src/pages/SettingsView.tsx web/src/components/SystemHealthPanel.tsx docker-compose.yml scripts/dev.sh README.md AGENTS.md docs/API.md plans/029-replace-python-with-node.md`
> Confirm `python/` is gone and `server/src/data/` owns DuckDB/charts/reports.
> Reconcile Settings + `/api/health` as they exist at `130481b`. Any
> unexplained mismatch is a STOP condition.

## Status

- **Priority**: P2
- **Status**: DONE (implemented and verified 2026-08-26)
- **Effort**: XL
- **Risk**: HIGH (storage engine change + native Electron ABI)
- **Depends on**: `plans/029-replace-python-with-node.md`
- **Category**: architecture / packaging
- **Planned at**: commit `7d5576d`, 2026-08-26
- **Reconciled against**: commit `130481b`, 2026-08-26

## Locked decisions

1. **Split store (locked after database brainstorm)**: SQLite is the
   relational ledger (users, chats, runs, sources, jobs, chunk *text*).
   **LanceDB** is the embedding/KNN index (North-shaped: control plane ≠
   search). DuckDB stays the analytical engine for user tables only. No
   Docker, no pgvector, no sqlite-vec. No OpenSearch/Redis in the `.app`.
2. **Cloud-optional LLM**: Settings hold an OpenAI-compatible base URL + API
   key. Default is local LM Studio (`http://127.0.0.1:1234`). A remote
   provider is first-class. Do not bundle weights or llama.cpp in this plan.
3. **macOS first** (Apple Silicon). Windows/Linux installers are out of scope.
4. **Electron**, not Tauri. After 029 the backend is Node + native addons
   (DuckDB, better-sqlite3, LanceDB). Electron can load those; Tauri would
   re-host them as sidecars for little gain.
5. **Do not ship a second Chromium.** After 029, Playwright is the server PDF
   path. In Electron, PDF/PNG use `webContents.printToPDF` / a hidden
   `BrowserWindow` with the same deny-by-default resource rules.

## Why this is possible (and what still is not “one binary”)

After 029, the product process graph is:

```
React UI  →  Fastify (agent, ingest, DuckDB worker, Playwright)  →  Postgres/pgvector
                                                                 →  LM Studio or any /v1
```

Electron can own the first two boxes. It cannot honestly swallow the LLM:
a 27–35B local model is a separate install (LM Studio) or a network call.
That is acceptable and already how the repo is designed.

Postgres is the other box that blocks a “download the `.app`” story. This
plan removes it.

```
Borealis.app
  Electron main
    Fastify on 127.0.0.1:<ephemeral>
    better-sqlite3  →  ~/Library/Application Support/Borealis/borealis.sqlite
    LanceDB         →  ~/Library/Application Support/Borealis/lancedb/
    DuckDB worker (unchanged catalogs)
    hidden window → PDF / chart PNG
  BrowserWindow
    built web/ dist  (same React app)
  Settings
    LLM base URL + API key  (LM Studio or cloud)
```

## Current state (pre-029 tree at `7d5576d`)

These facts remain load-bearing even after 029:

- `server/src/db.ts` — `pg.Pool`, `CREATE EXTENSION vector`, HNSW cosine
  index, UUID/`JSONB`/`TIMESTAMPTZ`/`BIGSERIAL`.
- Ingest and chat runs use `FOR UPDATE` / `FOR UPDATE SKIP LOCKED` and
  repeatable-read snapshots (`sourceScope.ts`, `chatRuns.ts`,
  `ingest.ts`). Those are multi-process Postgres idioms.
- Auth is email/password JWT (`auth.ts`). Fine on a server; clumsy as the
  only desktop first-run path.
- CORS allowlist is Vite loopback origins. `file://` / `app://` will fail
  today’s `parseCorsOrigins`.
- Storage roots are repo-relative `uploads/` and `reports_storage/`.
- `retrieve.ts` is `ORDER BY embedding <=> $2::vector`.
- CI’s isolation suite requires `TEST_DATABASE_URL` ending in `_test`.
- **Already landed by `56fb6c5` / `130481b` (do not re-invent):**
  Settings is a workspace modal (`SettingsView`: System, Models,
  Appearance, Account) with `SystemHealthPanel`. `GET /api/health`
  probes Postgres, `py.health()`, LiteLLM liveliness, and
  `LM_STUDIO_BASE_URL`. Public ingest failure codes live in
  `ingestionFailures.ts`. `130481b` only restyles selection chrome
  (`bg-accent`); it does not add a second Settings surface. 029 must
  already have retargeted those probes off Python/LiteLLM before this
  plan starts.

## What Electron does *not* require us to rewrite

Reuse as-is after 029:

- Agent loop, tools, SSE, source scope, connector refresh, DuckDB catalogs.
- React pages (chat, sources, reports, **existing Settings modal**).
  Change API base, first-run auth, and Settings *fields* — do not add a
  second Settings surface.
- Chart spec / report HTML. Swap the PDF renderer host, not the document.

## Historical database options (brainstorm, 2026-08-26)

SQLite is **not** the only option. It is the best *desktop* default for this
repo, not a recreation of North’s cloud data plane.

This section records the alternatives considered before the maintainer lock at
the end of the section. It is not a list of current fallback instructions.

### What North actually documents

Public North evidence ([docs/cohere-north/00-research-method-and-evidence.md](../docs/cohere-north/00-research-method-and-evidence.md),
[14-gaps-unknowns-and-clean-room-boundary.md](../docs/cohere-north/14-gaps-unknowns-and-clean-room-boundary.md),
Azure prod diagram) establishes an enterprise Kubernetes product, not a
desktop one:

- **Azure Database for PostgreSQL** — relational control plane
- **Search DB nodes** (and docs naming Compass / OpenSearch) — retrieval
- **Redis** — cache
- **Blob / object storage** — file bytes

The OpenAPI object model is agents, conversations, files, libraries,
automations, MCP, users — **not** a schema. Clean-room rule: do not claim
North’s private tables or ranking. Design an independent store that can
grow toward that *product* surface.

At planning time Borealis had already collapsed that split into one Postgres
(metadata + pgvector) + DuckDB (user SQL) + filesystem. Electron needed to keep
the conceptual collapse without recreating OpenSearch + Redis + Postgres inside
a `.app`.

### Jobs to separate

| Job | North cloud | Borealis at planning time | Desktop target |
|---|---|---|---|
| Users, chats, runs, sources, jobs | Postgres | Postgres | Embedded OLTP |
| RAG chunks + KNN | Search / Compass | pgvector HNSW | Embedded vectors |
| Lexical / hybrid search | Search / Compass | **missing** (vector only) | FTS if cheap |
| Analytical SQL on user CSVs | connectors / interpreter | DuckDB | DuckDB (keep) |
| File bytes / reports | Blob | `uploads/` + `reports_storage/` | `userData` files |
| Cache / pub-sub | Redis | in-process Node | in-process Node |

Do **not** put app ledgers in the DuckDB catalogs the model can `SELECT`.
User SQL and account metadata must stay different trust boundaries.

### Alternatives

**SQLite + sqlite-vec + FTS5 (considered, not selected)**
One file, WAL, `better-sqlite3` is the most proven Electron native addon.
sqlite-vec covers `retrieve`. FTS5 is the cheap way to grow toward North’s
hybrid search without a second process. Dialect rewrite is real (`UUID`,
`JSONB`, `SKIP LOCKED` → immediate txn + mutex). Scale: a personal library
(10^4–10^5 chunks), not a sharded search cluster. The maintainer lock rejected
sqlite-vec in favor of a dedicated LanceDB vector index.

**PGlite (WASM Postgres; considered, not selected)**
Best *port* of the current `db.ts` / integration tests. Weakest vector
story (pgvector-wasm is not HNSW-on-Azure) and memory-capped. It was rejected;
failure of the locked LanceDB prefilter spike was a STOP condition, not a signal
to fall back to PGlite.

**Embedded native Postgres + pgvector**  
Highest fidelity to Borealis and to North’s documented Postgres
dependency. Worst desktop: 50–100MB+ binaries, `initdb`, a port, crash
recovery, notarizing someone else’s server. Reject for a “download the
`.app`” product unless sqlite-vec and PGlite both fail.

**LanceDB + SQLite (locked)**  
North-shaped: relational OLTP + a dedicated vector store. Two engines,
two on-disk trees, two Electron natives. Chosen so retrieve can grow
toward libraries/hybrid search without stuffing vectors into the ledger
or shipping OpenSearch.

**DuckDB for metadata too**  
One process, but DuckDB is a poor chat/lease OLTP store and would mix
model-reachable catalogs with the ledger. Keep DuckDB for `query_data`
only.

**libSQL / Turso**  
SQLite-compatible with a sync story. Only if multi-device sync is in
scope (it is not in this plan).

**Chroma / Qdrant / OpenSearch sidecar**  
Closest to North Search DB nodes. Wrong for a single-user `.app` (Python
or another daemon). Out of scope.

### Recommendation (updated)

Maintainer lock: **SQLite ledger + LanceDB embeddings**. Keep DuckDB for
tabular tools. Optional later: SQLite FTS5 on chunk text for hybrid
retrieve (not a Compass clone). Do not ship Postgres, sqlite-vec, or
OpenSearch. PGlite is not the fallback anymore — if LanceDB cannot
prefilter by `account_id` + `source_id` allowlist under Electron, STOP.

## Storage migration (the real work)

SQLite holds the relational model and chunk *text*. LanceDB holds vectors
only. Postgres dialect will not run unchanged. Do not store embeddings in
SQLite `chunks` / `ingestion_chunk_staging`.

| Postgres today | Desktop |
|---|---|
| `UUID` / `gen_random_uuid()` | SQLite `TEXT` + `crypto.randomUUID()` |
| `JSONB` | SQLite `TEXT` JSON + `json_extract` |
| `TIMESTAMPTZ` | ISO-8601 `TEXT` |
| `BIGSERIAL` | `INTEGER PRIMARY KEY` |
| `chunks.embedding vector(N)` + HNSW | LanceDB table keyed by `chunk_id`, filtered by `account_id` + `source_id` |
| `FOR UPDATE SKIP LOCKED` | in-memory lease mutex + SQLite `BEGIN IMMEDIATE` |
| `REPEATABLE READ` turn snapshot | one SQLite transaction for accept-message |
| `pg.Pool` | `better-sqlite3` async facade |

**Keep a `db` facade.** Routes must not import `pg`. `server/src/db/sqlite.ts`
owns SQL. `server/src/retrieve.ts` talks to LanceDB, then reads passage
text from SQLite by `chunk_id`. Temp dirs for both engines replace
`TEST_DATABASE_URL`.

**Retrieve contract:** account-scoped KNN, cosine (or documented
equivalent), `topK`, allowlisted `source_id`s only, same
`RetrievedPassage` shape. Exact HNSW recall is not required.

## Two-store consistency (load-bearing — must implement in Phase A)

Postgres today promotes in **one transaction**: lock job + source, delete
live `chunks`, insert from `ingestion_chunk_staging` (including
`embedding`), delete staging, mark ready
([ingest.ts](../server/src/ingest.ts) around the `BEGIN`/`INSERT INTO
chunks … SELECT … FROM ingestion_chunk_staging` block). LanceDB cannot
join that transaction. Do not hand-wave this. Implement the protocol
below, or STOP.

### Stable ids

Assign a **UUID `chunk_id` at staging time** (not a promote-time
`BIGSERIAL`). The same id is the LanceDB row key and the SQLite live
`chunks.id`. Incremental embed writes LanceDB as it goes, using that id.

LanceDB row shape (minimum): `chunk_id`, `account_id`, `source_id`,
`generation`, `vector`. No passage text in LanceDB (avoids a second
content store).

### Retrieve (fail-closed)

1. **Prefilter in LanceDB**, not after the fact: `account_id = $account`
   AND `source_id IN $readyAllowlist`. If the library cannot do that
   predicate at search time, STOP (Phase A0). Scanning then discarding
   other accounts is not acceptable.
2. Take `topK` (or a small over-fetch) of `chunk_id`s.
3. Load those rows from SQLite `chunks` by id, still constrained to the
   same account + allowlist.
4. **Drop any hit whose SQLite row is missing** (stale/orphan vector).
   Never invent content. Never return another account’s text.
5. Order by LanceDB score among the surviving rows.

This join is the safety net, not a substitute for prefilter.

### Promote (replaces the single Postgres commit)

Keep SQLite staging for text/`seq`/`generation` only. During embed,
upsert LanceDB rows tagged with that `generation`. Then:

1. `BEGIN IMMEDIATE` in SQLite; lock the ingest job + source (same
   supersession rules as today).
2. Confirm every staged `chunk_id` has a LanceDB row for that
   `generation`. If not, ROLLBACK and fail the job (retryable).
3. Delete live SQLite `chunks` for the source; insert staged rows
   (no embedding column); delete that generation’s staging; mark source
   ready / job done — still inside the SQLite transaction.
4. COMMIT SQLite.
5. **After commit**, delete LanceDB rows for that `source_id` whose
   `generation` is not the generation just promoted.

If step 5 crashes, live retrieve still works (join drops old/new
orphans). Boot repair (below) finishes the delete.

If the process dies **before** step 4: live SQLite is still the previous
generation; new LanceDB rows are invisible to retrieve because their
`chunk_id`s are not live. Job remains retryable. Next attempt overwrites
the same `generation` vectors or a new generation after the existing
lease/generation bump.

### Failed promote / superseded job

On terminal failure or superseded generation: delete SQLite staging for
that `(source_id, generation)` **and** delete LanceDB rows for that
`(source_id, generation)`. Do not delete the live generation.

`ConnectorRefreshActivatedError` stays: DuckDB activate can succeed
while this promotion still must retry. Retry must be idempotent on the
same `chunk_id`s.

### Source delete

1. Delete LanceDB rows with that `source_id` (all generations).
2. Delete the SQLite source (CASCADE chunks/jobs).

If crash between 1 and 2: leftover SQLite chunks have no vectors;
retrieve returns nothing for that source. Boot repair deletes LanceDB
(already gone) and is a no-op; the source row is still present until the
delete is retried. If crash after 2 only: CASCADE removed text; any
leftover vectors fail the SQLite join and are stripped on next repair.

Never delete SQLite first “to be safe” without a durable
`pending_source_delete` row — a crash would leave searchable orphans
until repair. Prefer LanceDB-first **or** write `pending_source_delete`
in the same SQLite transaction as the source delete, then purge LanceDB,
then clear the pending row.

### Boot repair (run next to `restoreDatasets`)

On every server/desktop start:

- Delete LanceDB rows whose `source_id` is not a live SQLite source.
- Delete LanceDB rows whose `generation` is neither the source’s current
  ready ingest generation nor an in-progress `ingestion_jobs.generation`.
- Delete LanceDB rows whose `chunk_id` is not in SQLite `chunks` and not
  in `ingestion_chunk_staging`.
- Complete any `pending_source_delete` rows.

Log counts only (`repaired_vectors`, `repaired_deletes`). Do not log
ids, text, or paths.

### Required Phase A tests

- LanceDB search with two accounts / two sources never returns the other
  allowlist (prefilter test, not join-only).
- Empty allowlist → no LanceDB call or zero rows.
- Kill promote after LanceDB upsert, before SQLite COMMIT: live retrieve
  still returns the **old** passages only; repair or retry leaves no
  extra live hits.
- Kill after SQLite COMMIT, before old-generation LanceDB delete: retrieve
  unchanged; boot repair removes the old generation.
- Failed/superseded job removes that generation’s vectors, not live ones.
- Source delete + crash + boot: no vectors for that `source_id`.
- Retrieve never returns a passage whose SQLite row is gone.

**Existing Docker volumes are not auto-migrated.** Desktop starts empty.

**Dev = desktop engines.** `npm run dev` uses SQLite + LanceDB too.
`docker-compose` Postgres leaves the happy path in Phase A. Do not keep a
pgvector schema alongside.

## LLM Settings (cloud-optional)

**Extend** the existing Settings modal. Do not add a route or a second
window. Persist into userData (env still wins in CI):

- Chat endpoint URL (today `LITELLM_BASE_URL` / `LLM_BASE_URL`)
- API key (never logged, never in SSE / health payloads)
- Optional distinct `LM_STUDIO_BASE_URL` only when the chat endpoint is
  not local LM Studio
- Default chat model + embed model (1–256 chars, distinct)
- Keep `encoding_format: "float"` and 029 aliases for LM Studio ids

`GET /api/health` stays. After this plan:

- `database` → SQLite `SELECT 1` (copy must not say PostgreSQL)
- `data_service` → in-process DuckDB worker (already after 029)
- `model_gateway` → configured chat endpoint
- `model_runtime` → omit or mark n/a when the user pointed chat at
  a remote cloud URL

Models section already lists discovered models; add the URL/key fields
and a “Test connection” that only uses the same body-free probes as
health. First-run: if discovery fails, the existing System panel is
enough — do not crash boot.

`JWT_SECRET` is generated once into userData. Do not require
`server/.env`.

## Electron shell

New package `desktop/` (or `app/`) using `electron-builder` for a macOS
`dmg`/`zip`, **arm64**:

**Main process**

1. Resolve `userData` (`~/Library/Application Support/Borealis/`):
   `borealis.sqlite`, `lancedb/`, `uploads/`, `reports/`, `settings.json`,
   `jwt.secret`.
2. Start Fastify **in a `utilityProcess`** (not the renderer) bound to
   `127.0.0.1` and an ephemeral port. Pass config via env.
3. `BrowserWindow.loadURL(http://127.0.0.1:<port>/)` where Fastify also
   serves `web/dist`. Avoid `file://` + CORS fights.
4. Fastify host remains loopback-only. No LAN bind.
5. On quit: abort runs, close DuckDB worker, close LanceDB, close SQLite,
   then exit.

**Renderer**

- Production build of `web/` with `/api` same-origin.
- Keep the existing Settings modal. **Auto-provision** a single local
  account on first launch and store the JWT via `safeStorage` / session
  partition. Manual register/login remains for extra profiles if cheap;
  do not require it for the happy path. Account section already has
  sign-out.

**PDF / PNG**

- Desktop build: `playwrightRender.ts` uses Electron `webContents`
  (hidden window, `session` with `webRequest.onBeforeRequest` deny-all
  except `data:image/png;base64`).
- Headless `npm run dev` / CI without Electron keeps Playwright Chromium
  from 029. Gate the backend with a `renderBackend: "playwright" | "electron"`
  setting. Same HTML/CSP contract.

**Native addons**

Rebuild for Electron’s Node ABI:

- `better-sqlite3`
- `@lancedb/lancedb` (native; `asarUnpack` if it loads a sidecar)
- `@duckdb/node-api`

If any of these cannot load under Electron on arm64 macOS, STOP. Do not
add `sqlite-vec` or npm `xlsx`.

## macOS packaging

- `electron-builder` `mac.target`: `dmg` + `zip`, `arch: [arm64]`
- Hardened runtime + notarization placeholders (`APPLE_ID` etc. — do not
  commit secrets). Unsigned local debug builds are OK.
- Entitlements: network client (LM Studio / cloud), no
  `com.apple.security.app-sandbox` in v1 (native addons + userData files
  are painful under sandbox). Call that out in README.
- Minimum macOS: 13+ unless a dependency forces higher.
- Do not ship Playwright’s browser download inside the `.app`.

## Implementation phases

### Phase A0 — LanceDB prefilter spike (no schema rewrite yet)

In a throwaway test file against `@lancedb/lancedb`:

1. Insert vectors for two `account_id`s and several `source_id`s.
2. Search with `account_id = A AND source_id IN (s1)` and prove zero rows
   from account B or source s2.
3. Confirm a missing `chunk_id` can be deleted by
   `(source_id, generation)`.

If 2 fails, STOP. Do not start the SQLite port.

### Phase A — SQLite ledger + LanceDB retrieve (no Electron yet)

Replace `pg` with a `db` driver interface. Port the relational schema
**without** embedding columns; `chunks.id` is the staging UUID. Implement
the two-store protocol, boot repair, and the Phase A tests above. Leases
become an in-process mutex + `BEGIN IMMEDIATE`. Isolation suite: temp
SQLite file + temp LanceDB dir. `scripts/dev.sh` drops Docker Postgres.

**Verify:** every test in “Required Phase A tests” plus existing ingest
supersession/retry cases. `scripts/verify.sh` green without Postgres.

### Phase B — Persist Settings + loopback static hosting

Settings **file** + PATCH (or equivalent) for the existing modal’s new
URL/key fields. Fastify serves `web/dist` and `/api`. First-run JWT
secret + local account. CORS: same-origin when serving the UI. Retarget
`GET /api/health` `database` at SQLite; keep service ids.

**Verify:** `./scripts/dev.sh` still works; Settings test-connection against a
mock `/v1/models`; health JSON still has no URLs/keys.

### Phase C — Electron main/renderer

`desktop/` boots utilityProcess Fastify + BrowserWindow. userData paths.
Quit teardown. Auto-login local account.

**Verify:** `npm --prefix desktop run dev` opens chat, register-free; upload a
sample CSV; query_data; render_chart; create_report; HTML/PDF open.

### Phase D — Electron PDF/PNG backend

Hidden-window renderer with deny-by-default requests. Keep Playwright for
non-Electron CI.

**Verify:** PDF magic `%PDF`; PNG magic; request spy records no `http:` /
`file:` loads. Report CSP unchanged.

### Phase E — macOS package

`electron-builder` arm64 dmg. Native addons unpack/load. README: install
LM Studio *or* paste a cloud base URL. Remove Docker from the desktop
happy path.

**Verify:** install the dmg on a clean arm64 Mac (or CI `macos-15`
runner), launch, complete the sample-CSV E2E. Unsigned is acceptable if
notarization credentials are absent — note it in the PR.

## Done criteria

- [x] Plan 029 is DONE (`python/` gone).
- [x] No `pg` / `DATABASE_URL` / pgvector / sqlite-vec in the desktop or
  default dev path.
- [x] Phase A0 prefilter spike passed before the schema port.
- [x] LanceDB retrieve is prefiltered by account + allowlist and never
  returns a vector whose SQLite chunk row is missing.
- [x] Promote/delete crash tests and boot repair match the two-store
  protocol (old live data preserved; orphans purged).
- [x] Chat-turn accept stays one transaction; ingest leases work without
  `SKIP LOCKED`.
- [x] Settings can target LM Studio and a remote OpenAI-compatible URL without
  editing `.env` or restarting.
- [x] First launch needs no `server/.env` tokens and no register form.
- [x] Fastify binds loopback only; UI is same-origin.
- [x] Desktop PDF/PNG have no network egress; CI Playwright path remains.
- [x] arm64 `.app`/`.dmg` builds; DuckDB + better-sqlite3 + LanceDB load
  from the packaged app.
- [x] `scripts/verify.sh` green; `plans/README.md` row updated.

### Completion record (2026-08-26)

- Final repository gate: 539 server unit tests, 63 embedded-storage integration
  tests, 120 web tests, 13 desktop tests, plus typecheck, lint, format, and builds.
- Desktop renderer smoke generated valid 28,231-byte PNG and 16,303-byte PDF
  outputs with zero network hits and two blocked unsafe requests.
- The arm64 packaged app loaded `better-sqlite3`, LanceDB, and DuckDB under
  Electron 44; ZIP integrity and the DMG checksum passed.
- Packaged E2E uploaded/restored all four finance fixtures, queried 697
  transactions through a real LM Studio model, rendered two charts, created
  self-contained HTML and a four-page PDF, reopened both report surfaces,
  retested Settings, persisted the workspace across relaunch, and released its
  loopback ports on shutdown.
- Local-test artifacts deterministically disable signing/notarization and
  currently use Electron's default icon. The separately documented release path
  consumes Developer ID and notarization credentials from its environment.

## STOP conditions

Stop and report (do not improvise) if:

- 029 is not actually done (Python/LiteLLM/WeasyPrint still required).
- Phase A0: LanceDB cannot prefilter by `account_id` and
  `source_id IN allowlist` at search time.
- Promote/delete/repair cannot keep the two stores aligned under crash
  (see protocol). Do not “fix” this by putting embeddings back in SQLite
  or by scanning all vectors and filtering in JS.
- `better-sqlite3` / `@lancedb/lancedb` / `@duckdb/node-api` cannot be
  rebuilt for Electron arm64.
- Serving the UI from Fastify would require weakening CORS to reflect
  arbitrary origins.
- Electron PDF cannot deny `file:` / `http:` resources (would regress 028
  P1-01).
- Product wants a sandboxed Mac App Store build in this pass (sandbox +
  native extensions is a different design).
- Product wants bundled model weights (different plan).
- Windows/Linux parity is required in the same pass.

## Maintenance notes

- One *pair* of engines. Do not keep “LanceDB in Electron, pgvector in
  `npm run dev`” after Phase A.
- Embedding dim is a create-time LanceDB table decision (`EMBEDDING_DIM`).
  Keep the model and dimension compatible with the stored vectors. A model
  change at the same dimension requires reingesting all sources. A new dimension
  requires a fresh complete data directory or an explicit migration; changing
  the setting prevents the existing table from reopening. Do not delete or
  replace only the vector directory while keeping an unmatched ledger.
- Back up and restore SQLite and LanceDB together with Borealis stopped. Prefer
  the complete application-data directory so SQLite WAL state, uploads,
  reports, settings, and the signing secret remain with the matching index.
  See the current [desktop guide](../desktop/README.md).
- Cloud Settings send prompts and retrieved context to that provider;
  document that next to the key field.
- Historical plans that mention Docker Postgres remain accurate for the
  trees they were executed against.

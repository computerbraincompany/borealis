# Plan 022: Let each chat select its data sources and enforce that scope end to end

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
> **Drift check (run first, after dependencies)**:
> `git diff --stat e6e9d2b..HEAD -- README.md AGENTS.md server/package.json server/vitest.integration.config.ts server/src/db.ts server/src/routes.ts server/src/sourceScope.ts server/src/turnContext.ts server/src/agent.ts server/src/tools.ts server/src/retrieve.ts server/src/pythonClient.ts server/src/tests python/app/main.py python/app/datasets.py python/tests web/src/lib/api.ts web/src/pages/ChatView.tsx web/src/components/ChatSourcePicker.tsx plans/README.md`
> The listed dependencies intentionally change many of these files. Reconcile
> the current code with both the excerpts and the "Expected prerequisite
> state" below. Any unexplained mismatch is a STOP condition.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH (a partial implementation would create a false data boundary)
- **Depends on**: `plans/013-remove-north-branding.md`, `plans/014-fix-ingest-name-and-chat-stream-ux.md`, `plans/015-agent-data-integrity.md`, `plans/017-duckdb-query-path.md`, `plans/019-chat-view-fixes.md`, `plans/020-dev-gates-and-docs.md`, `plans/021-select-chat-model.md`
- **Category**: direction / security / ux
- **Planned at**: commit `e6e9d2b`, 2026-08-23

## Why this matters

Every uploaded source currently participates in every chat owned by the same
account. The system prompt lists every table, vector retrieval searches every
chunk, and SQL/describe tools can read every registered dataset. A source
picker that only filters the browser would therefore be misleading. This plan
adds durable per-chat selection and carries one immutable source snapshot from
message acceptance through prompt construction, RAG, DuckDB, chart/report
provenance and the visible composer.

## Current state

Relevant files and exact facts at `e6e9d2b`:

- `server/src/db.ts:16-43` owns account-scoped `sources` and `chunks`; chats at
  `:56-61` have no source mode or membership table.
- `server/src/routes.ts:23-90` creates chats with only a title, returns no source
  state, and checks chat ownership before message insertion.
- `server/src/agent.ts:37-53` calls `py.listDatasets(accountId)` and formats every
  dataset into every system prompt.
- `server/src/retrieve.ts:7-14` filters vector search only by account:

```ts
const rows = await q(
  `SELECT content, source_name,
          1 - (embedding <=> $2::vector) AS score
   FROM chunks
   WHERE account_id = $1 AND embedding IS NOT NULL
   ORDER BY embedding <=> $2::vector
   LIMIT $3`,
  [accountId, `[${vec.join(",")}]`, topK]
);
```

- `server/src/tools.ts:168-186` sends only `accountId` to `retrieve`,
  `py.listDatasets`, `py.query` and `py.describe`; tool descriptions say
  "every connected" source.
- `server/src/pythonClient.ts:30-44` carries no allowed-table list.
- `python/app/main.py:42-50,104-111` accepts only account + SQL/table.
- `python/app/datasets.py:45-54` builds a connection containing every table in
  the account; `query()` and `describe()` can therefore reach all of them.
- `web/src/pages/ChatView.tsx:270-329` has a text area and send/stop button but
  no source controls. `web/src/pages/SourcesView.tsx` manages files on a
  separate page only.

The product research is explicit: `docs/cohere-north/03-chat-agents-memory-and-evaluation.md:19-32,56-80`
defines per-conversation source selection, active chips, readiness/removal and
durable `selected_source_bindings`; `docs/cohere-north/12-ui-ux-reconstruction-specification.md:92-103`
places a searchable source picker in the composer. Reproduce those behaviors
with Borealis's own design.

### Required source semantics

The implementation must distinguish `all` from an explicit empty selection:

| Stored state | Meaning |
|--------------|---------|
| `source_mode = 'all'` | Every current and future account source is attached dynamically. |
| `source_mode = 'selected'` + rows | Only those source IDs are attached. |
| `source_mode = 'selected'` + zero rows | Explicitly no stored sources. Never fall back to all. |

- Existing chats and legacy API callers that omit source state stay `all`,
  preserving current behavior without a chats x sources backfill.
- The web's New chat action explicitly creates `selected + []`, matching an
  attachment-style composer rather than silently opening all private data.
- Non-ready sources remain visibly attached but only `ready` sources enter a
  run's usable scope.
- Deleting the last selected source leaves `selected + []`; FK cascade must not
  convert it to `all`.
- `all` sees later uploads; an explicit subset does not.
- Resync/reingest retains membership because it retains the source ID.
- Selection may change between turns. The server snapshots it once when a
  message is accepted; UI changes are disabled while streaming and affect the
  next turn only.
- Earlier messages remain model context. Detachment blocks new tool reads but
  does not erase text, charts or reports already present. Strict retroactive
  revocation is a separate retention project.

### Expected prerequisite state

Plan 021 adds `chats.model`, a model PATCH, assistant model metadata and a
`ModelSelector`. Extend those shapes; do not replace them.

Plan 017 must have been executed using its corrected per-account connection
design: `_CONNECTIONS` is keyed by account and no process-global catalog mixes
account tables. If live code contains a single `_SHARED_CON`, STOP immediately;
that stale design permits cross-account table visibility and cannot be the
base for this plan.

Conventions to preserve:

- TypeScript server imports use `.js`; SQL values are parameterized.
- Route ownership uses `requireAuth` plus `account_id`, with missing and foreign
  resources both appearing as 404 where appropriate.
- Python raises `HTTPException` with explicit 4xx errors and serializes DuckDB
  access under its existing `RLock`.
- Chart spec remains the contract documented in `python/app/charts.py`; this
  plan changes access context, not chart data shape or rendering.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Postgres | `docker compose up -d postgres` | service healthy |
| Server unit | `cd server && npm run typecheck && npm test && npm run build` | exit 0, all unit tests pass |
| Server isolation integration | `cd server && env RUN_SOURCE_SCOPE_INTEGRATION=1 TEST_DATABASE_URL="<dedicated-test-db-url>" npm run test:integration` | exit 0 against a dedicated disposable database whose name ends in `_test` |
| Python | `cd python && uv run pytest` | all tests pass |
| Web | `cd web && npm run typecheck && npm run build` | exit 0; existing bundle warning allowed |

Never put an actual connection string or credential into this plan, source,
fixtures, logs or commits. The integration suite must refuse to run without an
explicit disposable `TEST_DATABASE_URL` supplied by the operator, and the
parsed database name must end in `_test`.

## Scope

**In scope**:

- `server/src/db.ts`
- `server/src/sourceScope.ts` (create)
- `server/src/turnContext.ts` (create; transactional turn acceptance)
- `server/src/routes.ts`
- `server/src/agent.ts`
- `server/src/tools.ts`
- `server/src/retrieve.ts`
- `server/src/pythonClient.ts`
- `server/src/tests/sourceScope.test.ts` (create)
- `server/src/tests/retrieve.test.ts` (create)
- `server/src/tests/tools.test.ts` (extend the plan-015 file if present)
- `server/src/tests/sourceScope.integration.ts` (create; excluded from default unit discovery)
- `server/src/tests/integrationSetup.ts` (create; test-database guard and setup)
- `server/vitest.integration.config.ts` (create)
- `server/package.json` (`test:integration` only)
- `python/app/main.py`
- `python/app/datasets.py`
- `python/tests/test_datasets.py`
- `python/tests/test_main.py`
- `web/src/lib/api.ts`
- `web/src/pages/ChatView.tsx`
- `web/src/components/ChatSourcePicker.tsx` (create)
- `README.md`, `AGENTS.md`
- `plans/README.md`

**Out of scope (do NOT touch)**:

- Uploading directly inside the picker, per-message file attachments, chat
  branching, libraries/shared-source ACLs, citations or source previews.
- Connector selection below its existing `sources` row, connector auth/scope,
  or background synchronization policy.
- Retroactive deletion of messages, charts, reports or model memory after a
  source is detached/deleted.
- `fetch_url`; it remains a distinct web capability and must be labeled as such.
- Model selection (plan 021), theme implementation (plan 023), chart-spec or
  report-layout changes.
- Authentication of the internal Python service beyond its existing local
  trust boundary.

## Git workflow

- Branch: `codex/022-scope-chat-data-sources`
- Commit per boundary: schema/API, agent/tools, DuckDB enforcement, UI, docs.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Encode same-account chat/source membership in PostgreSQL

In `server/src/db.ts`:

1. Add `source_mode TEXT NOT NULL DEFAULT 'all'` to the chat declaration and an
   idempotent `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` for existing DBs.
   Add an idempotent named check constraint allowing only `all|selected`.
2. Add unique `(id, account_id)` indexes/constraints for `chats` and `sources`.
3. Create `chat_sources`:

```sql
CREATE TABLE IF NOT EXISTS chat_sources (
  chat_id UUID NOT NULL,
  source_id UUID NOT NULL,
  account_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (chat_id, source_id),
  FOREIGN KEY (chat_id, account_id)
    REFERENCES chats(id, account_id) ON DELETE CASCADE,
  FOREIGN KEY (source_id, account_id)
    REFERENCES sources(id, account_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS chat_sources_source_idx
  ON chat_sources (source_id, chat_id);
```

The duplicated `account_id` plus composite FKs is deliberate defense in depth:
even a future buggy route cannot attach another account's source.

Do not backfill membership rows. Existing chats use `source_mode='all'`; a
boot-time backfill would reattach sources users intentionally removed.

**Verify**: start the server twice against a disposable DB -> both boots
succeed; inspect `\d chat_sources`; a direct mismatched-account insert fails at
the FK layer.

### Step 2: Build one transaction-safe source-scope service

Create `server/src/sourceScope.ts` containing:

- Types for the strict request union:
  `{ source_mode: "all" }` or
  `{ source_mode: "selected"; source_ids: string[] }`.
- Pure validation: exact keys, valid UUIDs, stable dedupe, maximum 100 selected
  IDs. Mixed/ambiguous shapes are 400.
- `replaceChatSourceScope(accountId, chatId, input)` using
  `pool.connect()`, `BEGIN`, ownership checks, delete/insert/update,
  `COMMIT`, and `ROLLBACK`/release in `finally`.
- Missing and foreign source IDs produce the same generic 400
  (`one or more sources are unavailable`) and leave prior membership intact.
- `resolveChatSourceScope(client, accountId, chatId)` returning one immutable
  object:

```ts
interface ResolvedSourceScope {
  mode: "all" | "selected";
  attached: Array<{
    id: string; name: string; display_name: string;
    kind: string; status: string;
  }>;
  readySourceIds: string[];
  readyTableNames: string[];
}
```

For `all`, resolve current account sources; for `selected`, join
`chat_sources` on both chat/account. Preserve attached non-ready rows but put
only ready tabular `name`s in `readyTableNames` and only ready IDs in
`readySourceIds`. Sort deterministically and freeze/copy arrays so tools cannot
mutate the run snapshot.

Make the resolver accept a PostgreSQL queryable/client argument instead of
opening its own pool query. Source updates may use a transaction client and
turn acceptance MUST resolve against the same repeatable-read transaction in
Step 3.

Add pure validation tests in `sourceScope.test.ts`.

**Verify**: `cd server && npm run typecheck && npm test` -> 0.

### Step 3: Extend chat create/detail/update and snapshot at message acceptance

In `server/src/routes.ts`:

- Extend `POST /api/chats` to accept optional `title` plus either
  `{ source_mode: "all" }` or
  `{ source_mode: "selected", source_ids: string[] }`. Omitted source state
  means legacy `all`; `source_ids` without `source_mode`, or with `all`, is a
  400. The web will explicitly send `selected + []`. Insert the chat and any
  selected rows atomically.
- Add `PUT /api/chats/:id/sources` using the service above. Return
  `{ source_mode, sources }` and 404 for a missing/foreign chat. Its body uses
  the same strict source-scope union, without `title`.
- Include `source_mode` and attached source summaries in chat detail. Include
  `source_mode` in chat list/create shapes so the sidebar state is coherent.
- Keep plan 021's model PATCH and model response fields intact.
- Create `server/src/turnContext.ts` with `acceptChatTurn(accountId, chatId,
  content)`. It acquires one pool client, starts `BEGIN ISOLATION LEVEL
  REPEATABLE READ` before its first read, loads the owned chat/model, resolves
  source mode + memberships through that same client, inserts the user message
  with the concrete snapshot in `meta`, commits, releases, and returns the
  immutable `{ chatId, model, sourceScope, userMessage }`. Missing/foreign chat
  is 404; every failure rolls back and releases in `finally`.
- The message route calls only this acceptance helper before `runAgent`. Do not
  accept source IDs or model IDs in the message body and do not re-resolve
  either setting after the transaction commits.
- Pass the returned immutable object into `runAgent` and save the same model,
  `source_mode`, and concrete ready `source_ids` in assistant metadata. For
  `all`, metadata contains the concrete IDs visible in that transaction.

The repeatable-read transaction is load-bearing: model, source mode,
membership rows and the user-message provenance must describe one database
snapshot that actually existed. A model/source update that commits before that
snapshot is included; one that commits after it affects the next turn only.

**Verify**: server gates pass. Live API probes prove malformed modes -> 400,
foreign/missing chat -> identical 404, foreign/missing source -> identical
generic 400, a rejected replacement preserves old rows, and a deliberately
paused concurrent source update cannot create mixed mode/membership metadata.

### Step 4: Enforce the snapshot in prompt, RAG and every data-access tool

In `server/src/agent.ts`:

- Accept `sourceScope: ResolvedSourceScope` in `runAgent`.
- Build the system catalog only from `sourceScope.readyTableNames`; include
  attached-but-unready names/status separately. For explicit none, say that no
  stored sources are attached and never fall back to account-wide metadata.
- Add ready source/table arrays to the existing per-run context that already
  carries chat/chart/report/model state.
- Preserve plan 021 model propagation and plans 014/015 agent fixes.

In `server/src/retrieve.ts`:

- Require `allowedSourceIds`.
- Return `[]` before calling `embed()` when it is empty.
- Add `source_id = ANY($n::uuid[])` in addition to `account_id` and use only
  server-derived IDs.

In `server/src/tools.ts`:

- Change descriptions from "every connected" to "selected for this chat".
- `retrieve`: pass ready IDs.
- `list_sources`: return only attached rows/status and filter Python dataset
  metadata to the ready table-name set. Return a sanitized shape, not internal
  locations/URLs.
- `query_data`: pass exactly the ready table-name set to Python.
- `describe_data`: reject a name outside that set before Python and pass the
  same set for defense in depth.
- `render_chart`: unchanged; it has no implicit data read and records its ID in
  the current run context.
- `fetch_url`: unchanged and documented as independent of stored-source scope.
- `create_report`: before DB lookup, match requested exact/prefix chart IDs only
  against `context.chartIds` created in this run. Preserve plan 015's
  unresolved-ID feedback; never resolve an unrelated account chart.

Add Vitest mocks proving empty retrieval avoids embeddings, retrieve SQL has
both predicates, prompt/list omit an unselected canary, query forwards the
exact allowlist, describe short-circuits unselected names, and report chart
resolution stays inside current-run IDs.

**Verify**: `cd server && npm run typecheck && npm test && npm run build` -> 0.

### Step 5: Make DuckDB catalogs account-and-scope isolated

This step extends the corrected plan-017 connection cache; retain its LIMIT
pushdown, non-finite normalization, identifier quoting, describe consolidation,
chart error mapping and URL-cache extension work.

In `python/app/main.py`, make `allowed_tables: list[str]` required on both
`QueryRequest` and `DescribeRequest`. In `server/src/pythonClient.ts`, require
and send the immutable table list from the run context. No model tool argument
may control it.

In `python/app/datasets.py`, replace the per-account cache with a bounded LRU of
immutable scoped catalogs:

- Key: `(account_id, tuple(sorted(set(allowed_tables))))`.
- Validate every allowed name against that account's registry; never silently
  omit or widen a missing name.
- Each connection loads only those tables from trusted registry locations,
  then executes `SET enable_external_access=false` before model SQL runs.
- An empty tuple creates an empty catalog. Constant SQL may work; registered
  tables cannot.
- Keep every registry/cache/connection operation under the existing `RLock`.
- Track file signatures. A changed/missing signature closes and rebuilds the
  scoped connection; do not try to re-enable external access.
- `register`, `resync` and `drop` close/invalidate every cached scope for the
  affected account. Registration may use a one-use trusted validation
  connection, closed in `finally`.
- Cap cached scopes at 8 per account; close the least recently used connection
  on eviction. Never evict or close another account by name collision.

Required pytest cases:

- allowed A works; unselected B in the same account fails;
- empty scope cannot access A;
- two accounts with the same table name return their own distinct canaries;
- `duckdb_tables()` contains only the allowed scope;
- external scans such as CSV/Parquet/JSON table functions fail after catalog
  creation;
- describe rejects a table outside its allowlist;
- register/resync/drop invalidates affected scopes;
- LRU eviction closes the evicted catalog;
- FastAPI `/query` and `/describe` reject missing `allowed_tables`.

**Verify**: `cd python && uv run pytest` -> all pass.

### Step 6: Add database isolation integration tests

Create `server/vitest.integration.config.ts`, an explicit
`sourceScope.integration.ts`, `server/src/tests/integrationSetup.ts`, and
`npm run test:integration`. The integration file must not match default
unit-test discovery. Before any module imports `db.ts`, the setup must:

1. Refuse unless `RUN_SOURCE_SCOPE_INTEGRATION=1`.
2. Require and parse the operator-provided `TEST_DATABASE_URL`.
3. Require its database name to end in `_test` and, when an ambient
   `DATABASE_URL` exists, refuse if the normalized URLs are equal.
4. Assign the validated value to `process.env.DATABASE_URL`; integration tests
   must dynamically import database-backed modules only after setup.

Use unique fixture IDs and cleanup in `finally`; never reset, drop or truncate
a database or shared table. Do not print either URL.

Cover:

- foreign-account source replacement is rejected without revealing existence;
- rejected replacement is atomic;
- a direct cross-account join row violates the composite FK;
- `selected + []` stays none;
- switching to all clears explicit rows;
- deleting the sole selected source cascades the join but leaves mode selected;
- all mode sees a newly inserted source, selected mode does not;
- deleting a chat cascades membership.
- deterministic concurrency: pause an uncommitted source replacement between
  its delete/insert and commit while accepting a turn on a second client. The
  accepted metadata is wholly the pre-update state; after the replacement
  commits, the next accepted turn is wholly the post-update state. Repeat with
  a concurrent model PATCH. No result may combine a mode/model from one state
  with memberships from the other, and each accepted user-message row matches
  the helper's returned snapshot.

**Verify**: the dedicated integration command in "Commands you will need"
passes against the disposable DB, then default `npm test` still runs offline.

### Step 7: Build the source picker and active chips

In `web/src/lib/api.ts`:

- Add `SourceMode`, attached-source summaries and source metadata to chat types.
- Change `chatsApi.create()` so the web explicitly posts
  `{ source_mode: "selected", source_ids: [] }`.
- Add `chatsApi.updateSources(id, union)` for the PUT route.
- Preserve model types and metadata from plan 021.

Create `web/src/components/ChatSourcePicker.tsx` using the existing Dialog
primitives. It must provide:

- A visible composer button: `All sources`, `No sources`, or `N sources`.
- Search over display name; kind/status text + icon (not color alone).
- An explicit `Use all current and future sources` choice.
- Checkboxes for selected mode, including a deliberate empty selection.
- Non-ready sources visible and attachable, with processing/error status; they
  are explained as unavailable until ready.
- Apply/Cancel so a failed PUT retains server state and shows an inline error.
- Keyboard operation, labelled controls, visible focus and no package addition.

In `ChatView.tsx`:

- Load the existing source list and the active chat's stored source state.
- Mount the picker beside plan 021's model selector in the composer.
- Render removable active chips for explicit selections. Do not render every
  source as a chip in all mode; one `All sources` chip is enough.
- Disable picker mutation and Send while saving; disable mutation while a turn
  streams. Read that state from plan 019's entry keyed by the active chat ID:
  switching away and back to a running chat must still show Stop, keep Send and
  both selectors disabled, and preserve its live output. Preserve its batching.
- If messages already exist, state inside the picker that changes apply to
  future answers and do not erase earlier content.
- When a selected source is deleted, refresh detail/source state and show
  `No sources`; never switch to all.
- Use semantic tokens only so plan 023 can validate both themes.

**Verify**: `cd web && npm run typecheck && npm run build` -> 0.

### Step 8: Document and replay the isolation scenarios

Update `README.md` and `AGENTS.md` with the all/selected/none semantics, the
turn snapshot, the enforcement matrix, and the rule that `fetch_url` is a
separate web capability. Document the required Python allowlist so future tools
do not bypass it.

E2E with two accounts and unique canary content:

1. Account A has sources A1/A2; account B has B1 with a colliding table name.
2. New web chat starts at `No sources`; retrieve/list/query/describe cannot
   surface any canary.
3. Attach A1 only. Prompt-visible catalog, retrieval, list, SQL, describe,
   chart and report flow contain A1 and never A2/B1.
4. During a long turn the picker is disabled. Change scope after completion;
   the next turn uses the new snapshot while earlier output remains.
5. Delete the sole selected source: the chat stays explicit none.
6. Choose All, upload A3, and confirm the next turn sees A3 dynamically.
7. Attempt direct SQL external-file functions through `query_data`: the scoped
   catalog rejects them.
8. Restart Python then Node and replay A1-only; registration restore must not
   widen the chat scope.

Record results without source contents, tokens, connection strings or other
sensitive values.

## Test plan

- Server unit tests: request validation, immutable resolution, prompt/RAG/tool
  filtering, empty fast path and current-run chart restriction.
- Dedicated Postgres integration suite: ownership, composite FKs, atomic
  replacement, repeatable-read turn snapshots, cascades and all-vs-selected
  lifecycle.
- Python tests: account+allowlist catalogs, external-access lockout,
  invalidation and bounded LRU behavior.
- Web typecheck/build plus keyboard/manual selection matrix.
- Two-account E2E canaries across every data-access tool and restart.

## Done criteria

- [ ] DB rejects a direct cross-account `chat_sources` row.
- [ ] Existing chats/API omission resolve to `all`; new web chats start
  `selected + []`.
- [ ] Empty selected scope performs no embedding and exposes no stored table.
- [ ] Every prompt/retrieve/list/query/describe path uses one snapshotted scope;
  no model-supplied IDs or prompt-only enforcement exists.
- [ ] Model, source mode, ready IDs and user-message metadata are accepted in
  one repeatable-read transaction; the concurrency integration test cannot
  produce a mixed snapshot.
- [ ] `grep -n "allowed_tables" python/app/main.py server/src/pythonClient.ts`
  shows required request plumbing for both query and describe.
- [ ] `rg -n "_SHARED_CON" python/app/datasets.py` returns no matches.
- [ ] Python tests prove two-account same-name isolation, subset isolation and
  external scan rejection.
- [ ] `create_report` resolves only chart IDs from the current run context.
- [ ] Server unit/integration gates, Python tests and web typecheck/build pass.
- [ ] E2E selected-source canaries never cross scope or account.
- [ ] No files outside the in-scope list are modified (`git status`).
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report back (do not improvise) if:

- Plan 017 landed with one global DuckDB catalog or any connection can
  enumerate/read tables outside `(account_id, allowed_tables)`.
- External table/file functions still work after scoped catalog creation, or
  cache invalidation would require re-enabling external access instead of
  closing/rebuilding.
- Any boundary relies only on UI filtering, prompt wording, or model-supplied
  source IDs.
- Empty selected scope falls back to all anywhere.
- Foreign and missing sources produce observably different update responses,
  or the DB permits cross-account membership.
- Source deletion converts selected-empty to all.
- Scope is re-resolved independently for each tool instead of snapshotted once
  at message acceptance.
- Chat model/source/message provenance is assembled through separate pool
  snapshots, or an in-flight chat becomes editable after navigating away and
  back.
- The ownership suite cannot run against a dedicated disposable Postgres DB.
- Plan 015's final chart resolution cannot be constrained to current-run IDs
  without losing explicit unresolved-ID feedback.
- Product policy changes to require retroactive revocation of historical
  messages/artifacts; that is a material retention-system expansion.

## Maintenance notes

- Any new data-access tool must accept `ResolvedSourceScope` from the run
  context and enforce it at its lowest data boundary.
- The scoped DuckDB cache is intentionally bounded. Track parse latency and
  memory before increasing the per-account limit.
- `all` is dynamic convenience; `selected` is a stable allowlist. Do not merge
  their empty representations in API or UI refactors.
- Historical `messages.meta.source_ids` records what a turn could read; it is
  provenance, not a live authorization grant.
- If the Python service becomes remotely reachable or multi-process, replace
  its loopback trust boundary and in-memory catalogs in a separate design.

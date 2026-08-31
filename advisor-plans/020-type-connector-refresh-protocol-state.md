# Plan 020: Type connector-refresh protocol state in a durable table

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before continuing. If a “STOP condition” occurs, stop and report — do not renumber, combine migrations, dual-write indefinitely, or improvise. When done, update this plan’s row in `advisor-plans/README.md` unless a reviewer told you they own the index.
>
> **Drift check (run first)**: `git diff --stat f1b9293..HEAD -- server/src/db/migrations.ts server/src/db/stores/connectorRefreshStore.ts server/src/db/stores/sourceIngestionTransitions.ts server/src/db/stores/ingestionStore.ts server/src/db/stores/sourceStore.ts server/src/storageRuntime.ts server/src/dataService.ts server/src/ingest.ts server/src/ingestionEngine.ts server/src/tests/vitestTestPartitions.ts server/src/tests/fixtures/sqlite/v014.sql server/src/tests/sqliteFoundation.test.ts server/src/tests/connectorRefreshStore.test.ts server/src/tests/sourceIngestionTransitions.test.ts server/src/tests/sqliteSourceStore.test.ts server/src/tests/dataService.test.ts server/src/tests/ingestionWorker.test.ts server/src/tests/ingestRestore.test.ts server/src/tests/ingestionEngine.test.ts`
> Plans 003, 006, 012, 014, 015, and 016 intentionally change several paths after the planned commit. Read their completed plans and compare their resulting live contracts before editing. The schema precondition is exact: v12 belongs to plan 006, v13 belongs to plan 012, and this plan alone adds v14. Use plan 015’s final promotion boundary and plan 016’s final bounded-reconciliation owner; do not restore their predecessor designs.
> **Read-only dependency check**: verify `server/src/tests/sqliteMigrationFixture.ts` still matches plan 003. It is not editable here.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: `advisor-plans/003-add-historical-migration-fixtures.md`, `advisor-plans/006-bind-egress-consent-to-provider-revision.md`, `advisor-plans/012-enforce-automation-target-ownership.md`, `advisor-plans/014-create-owned-application-runtime.md`, `advisor-plans/015-shorten-vector-promotion-transaction.md`, `advisor-plans/016-bound-periodic-storage-reconciliation.md`
- **Category**: migration
- **Planned at**: commit `f1b9293`, 2026-08-30

## Why this matters

Connector refresh is a cross-engine prepare → activate → promote → cleanup protocol, but its durable phase and compare-and-swap identities are currently untyped keys inside general-purpose `sources.meta`. A crash around DuckDB activation is represented only by an in-memory boolean, so startup cannot distinguish “not activated” from “activated but not promoted” without reconstructing state from loosely related fields. Schema v14 must give the protocol one constrained durable row, migrate every valid legacy combination transactionally, and let recovery reconcile the exact immutable cache location rather than guess.

## Current state

- At the planned commit, `server/src/db/migrations.ts:3` says:

  ```ts
  export const LATEST_SQLITE_SCHEMA_VERSION = 11;
  ```

  Plans 006 and 012 must make the live value exactly 13 and add contiguous v12/v13 migrations before this plan starts.

- `server/src/db/migrations.ts:492-518` applies each migration in one `BEGIN IMMEDIATE` transaction, sets `user_version`, commits, and rolls back on error. Plan 003 adds the required historical fixture contract: helper `server/src/tests/sqliteMigrationFixture.ts`, immutable deltas under `server/src/tests/fixtures/sqlite/vNNN.sql`, and assertions in `server/src/tests/sqliteFoundation.test.ts`. Add `v014.sql`; do not invent another fixture mechanism.
- `server/src/db/stores/sourceIngestionTransitions.ts:317-353` starts a refresh by mutating untyped metadata:

  ```ts
  const meta = objectMeta(source.meta);
  removeKeys(meta, [
    "error",
    "error_code",
    "error_detail",
    "error_stage",
    "connector_previous_location",
    "connector_candidate_location",
    "connector_activation_previous_location",
  ]);
  meta.connector_refresh_version = refreshVersion;
  transaction.run(`UPDATE sources SET status='index',meta=? WHERE account_id=? AND id=?`, [
    encodeJson(meta, "source meta"),
    accountId,
    source.id,
  ]);
  ```

- `sourceIngestionTransitions.ts:357-425` then writes `connector_candidate_location`, `connector_activation_previous_location`, and optionally `connector_previous_location` into the same JSON while changing the job from `preparing` to `pending`.
- `server/src/ingest.ts:216-267` claims a preparing job, reads `connector_refresh_version` from source metadata, prepares an immutable cache file, and passes candidate/previous locations into `activatePreparedConnector`.
- `server/src/ingestionEngine.ts:100-117` decodes those raw metadata keys. At `server/src/ingestionEngine.ts:202-224`, activation is guarded only by a local boolean:

  ```ts
  if (refreshVersion && candidateLocation && input.connector && input.url) {
    activationStarted = true;
    const activated = await data.activateDatasetRefresh(/* exact identity */);
    if (activated.version !== refreshVersion || activated.location !== candidateLocation) {
      throw new Error("connector refresh activation mismatch");
    }
    await store.assertLease(input.accountId, input.sourceId, input.generation, input.leaseToken);
  }

  await lifecycle.promote({ /* generation and promotedFilePath */ });
  ```

  A process crash loses `activationStarted`.

- `server/src/ingest.ts:468-535` startup repair reads `connector_previous_location` from metadata and retries cleanup. It already calls exact dataset APIs and must remain fail-closed.
- `server/src/dataService.ts:282-312` and the DuckDB worker enforce
  immutable-location activation with `expectedPreviousLocation`.
  `server/src/data/datasets.ts` exposes `currentDatasetLocation`, but the
  mandated opaque `dataService` facade does not yet expose a narrow equivalent.
  Recovery must add that facade method rather than importing the worker/data
  module directly or deriving a path from unbounded catalog listing.
- Current tests encode JSON keys directly: `server/src/tests/sourceIngestionTransitions.test.ts:140-295`, `server/src/tests/ingestionWorker.test.ts:108-176`, `server/src/tests/ingestRestore.test.ts`, and `server/src/tests/ingestionEngine.test.ts`. Replace those expectations with typed state and crash-boundary tests; do not delete their behavioral coverage.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Migration preflight | `rg -n -e "LATEST_SQLITE_SCHEMA_VERSION = 13" -e "version: 12" -e "version: 13" server/src/db/migrations.ts` | exactly the v13 latest declaration and contiguous v12/v13 registrations are present |
| Migration/store tests | `pnpm --filter borealis-server exec vitest run --config vitest.integration.config.ts src/tests/sqliteFoundation.test.ts src/tests/connectorRefreshStore.test.ts src/tests/sqliteSourceStore.test.ts` | exit 0; v13→v14, serialized legacy state, ownership/index plans, repair pages, and deletion snapshots pass |
| Protocol integration tests | `pnpm --filter borealis-server exec vitest run --config vitest.integration.config.ts src/tests/sourceIngestionTransitions.test.ts src/tests/connectorRefreshStore.test.ts` | exit 0; serialized SQLite transitions and retry-touch CAS cases pass |
| Protocol unit tests | `pnpm --filter borealis-server exec vitest run src/tests/dataService.test.ts src/tests/ingestionWorker.test.ts src/tests/ingestRestore.test.ts src/tests/ingestionEngine.test.ts` | exit 0 in the default partition; bounded current-location facade, orchestration, and crash recovery pass |
| Server checks | `pnpm --filter borealis-server typecheck && pnpm --filter borealis-server lint && pnpm --filter borealis-server format:check` | exit 0 |
| Server gate | `pnpm --filter borealis-server test && pnpm --filter borealis-server test:integration` | exit 0 |
| Policy | `pnpm policy` | exit 0 |
| Repository gate | `pnpm verify` | exit 0 and prints `ALL GATES GREEN` |

## Scope

**In scope** (the only files you should modify):

- `server/src/db/migrations.ts`
- `server/src/tests/fixtures/sqlite/v014.sql` (create)
- `server/src/tests/sqliteFoundation.test.ts`
- `server/src/db/stores/connectorRefreshStore.ts` (create)
- `server/src/db/stores/sourceIngestionTransitions.ts`
- `server/src/db/stores/ingestionStore.ts`
- `server/src/db/stores/sourceStore.ts`
- `server/src/storageRuntime.ts`
- `server/src/dataService.ts`
- `server/src/ingest.ts`
- `server/src/ingestionEngine.ts`
- `server/src/tests/connectorRefreshStore.test.ts` (create)
- `server/src/tests/sourceIngestionTransitions.test.ts`
- `server/src/tests/sqliteSourceStore.test.ts`
- `server/src/tests/dataService.test.ts`
- `server/src/tests/ingestionWorker.test.ts`
- `server/src/tests/ingestRestore.test.ts`
- `server/src/tests/ingestionEngine.test.ts`
- `server/src/tests/vitestTestPartitions.ts` (add `connectorRefreshStore.test.ts` to plan 001’s serialized integration manifest)

`server/src/tests/sqliteMigrationFixture.ts` is a read-only plan-003 helper unless v14 exposes a generic helper defect; STOP before modifying it. The v12/v13 fixture files are immutable and out of scope.

**Out of scope**:

- Renumbering, rewriting, squashing, or combining schema versions 1–13.
- Changing connector HTTP fetch/SSRF policy, URL configuration, public route shapes, schedule behavior, or DuckDB’s immutable-cache CAS.
- Changing SQLite/LanceDB generation visibility, Plan 011's proven-removal
  semantics, or vector promotion boundaries (plan 015). Snapshotting typed
  refresh locations into the existing source-deletion intent before cascade is
  required in scope; it does not redesign cleanup success.
- Storing protocol state in a JSON codec, continuing permanent dual-write to `sources.meta`, or silently discarding malformed legacy state.
- Removing startup repair or cleaning a location whose exact inactive identity has not been proven.
- Documentation; plan 023 owns schema/operator prose.

## Git workflow

- Branch: `codex/020-connector-refresh-state`
- Use conventional commits; the observed style includes `feat: set a personal default chat model in Settings and start new chats from it`.
- Suggested commit: `refactor: type connector refresh state`
- Commit the migration, store/transitions, and tests as one reviewable logical unit; never leave `LATEST_SQLITE_SCHEMA_VERSION` ahead of its fixture.
- Do not push or open a PR without explicit instruction.

## Steps

### Step 1: Enforce the serialized migration precondition

Read the completed plans 003, 006, 012, 014, 015, and 016. Confirm:

- plan 003’s helper and immutable fixture deltas are present and its tests pass;
- schema v12 is exclusively the provider-bound-consent migration from plan 006;
- schema v13 is exclusively the automation-target-ownership migration from plan 012;
- `LATEST_SQLITE_SCHEMA_VERSION` is exactly 13 and registrations are contiguous;
- plan 014 exposes one owned application runtime and one authoritative storage composition/close path.
- plan 015’s shortened vector-promotion transaction and characterization coverage are live;
- plan 016’s bounded periodic reconciliation plus full startup repair owner are live;
- plan 001’s `server/src/tests/vitestTestPartitions.ts` excludes `sqliteFoundation.test.ts` from the default unit config and places native/serialized ledger tests in the integration config.

Do not edit until all eight facts hold.

**Verify**: `rg -n "LATEST_SQLITE_SCHEMA_VERSION = 13|version: 12|version: 13" server/src/db/migrations.ts && pnpm --filter borealis-server exec vitest run --config vitest.integration.config.ts src/tests/sqliteFoundation.test.ts` → the three expected declarations are present and all migration fixtures through v13 pass in the serialized integration partition.

### Step 2: Add schema v14 and migrate valid legacy states atomically

Add a strict table named `connector_refresh_states`, with one row per connector-backed source. Use these columns and constraints (adapt only identifier-length constants to the store’s existing codec limits):

- `repair_ordinal INTEGER PRIMARY KEY AUTOINCREMENT`, plus
  `source_id TEXT NOT NULL UNIQUE`, `account_id TEXT NOT NULL`, and
  `connector_id TEXT NOT NULL`; the immutable ordinal exists only to delimit and
  keyset-page a finite startup snapshot without relying on wall-clock time;
- `generation INTEGER NOT NULL CHECK (generation >= 1)`;
- `refresh_version TEXT NOT NULL` with a bounded non-empty length check;
- `phase TEXT NOT NULL CHECK (phase IN ('preparing','prepared','activating','activated','cleanup_pending'))`;
- `candidate_location TEXT`, `activation_previous_location TEXT`, and `cleanup_previous_location TEXT`, each bounded when non-null;
- `attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0)`;
- `created_at` and `updated_at` ISO timestamps;
- a v14 unique parent index on `sources(id, connector, account_id)`, then a
  composite foreign key
  `(source_id, connector_id, account_id) → sources(id, connector, account_id)`
  plus `(connector_id, account_id) → connectors(id, account_id)`, both
  `ON DELETE CASCADE`. The three-column source reference is load-bearing: two
  connectors in one account may never be paired with each other's source by
  direct SQL;
- phase/location checks: `preparing` has no candidate; every later phase has a candidate; `cleanup_pending` requires a non-null cleanup location different from the candidate.

Add a periodic repair index on `(attempts, updated_at, source_id)` so untouched
or lower-attempt work sorts ahead of repeated failures regardless of tied or
backward timestamps. The `repair_ordinal` primary key supplies the separate
startup keyset order. Keep exact account/source/connector/generation/version
identity in every transition predicate; `phase` remains part of each transition
CAS, not the leading page-order key. Every successful phase-changing CAS resets
`attempts` to zero; a failed/no-progress exact touch increments it.

Complete Plan 016's explicit index handoff in this same serialized v14
migration. Add exactly these persistent indexes, matching the live query order
including all deterministic tie-breakers:

- `pending_source_deletes(attempts, updated_at, account_id, source_id)`;
- `pending_vector_ops(attempts, updated_at, source_id, operation, generation)`;
  and
- `dataset_cache_cleanup_jobs(attempts, updated_at, account_id, name, location)`.

Use stable index names and migration assertions/`EXPLAIN QUERY PLAN` fixtures to
prove each attempts-first periodic selector uses its matching order index
without a temporary sort. Do not change Plan 016's limits or ordering to fit an
index.

Within the same v14 migration transaction, validate and convert legacy protocol keys from `sources.meta`:

- `connector_refresh_version` with no candidate is `preparing` only when a matching connector source and `ingestion_jobs.status='preparing'` row exists.
- A version plus candidate (with nullable activation-previous and optional cleanup-previous locations) is `activating`, not `prepared`: after a legacy crash, external activation is ambiguous and startup repair must query the exact current DuckDB location.
- A ready connector source with only `connector_previous_location` becomes `cleanup_pending`; use a deterministic internal legacy refresh identity and the ready generation/candidate file path. This identity is for cleanup only and must never be passed to connector download/activation.
- No protocol keys means no state row.
- Any other key combination, wrong JSON type, missing connector/job/generation, candidate mismatch, or phase-incompatible source/job status aborts and rolls back v14. Implement a transactional SQL guard rather than ignoring rows.

After inserts succeed, use `json_remove` to remove only `connector_refresh_version`, `connector_candidate_location`, `connector_activation_previous_location`, and `connector_previous_location`. Preserve every other key, especially `error`, `error_code`, `error_detail`, `error_stage`, and display metadata.

Add the exact v14 delta to `server/src/tests/fixtures/sqlite/v014.sql` under plan 003’s fixture rules. Raise `LATEST_SQLITE_SCHEMA_VERSION` to 14 and register only `{ version: 14, sql: SCHEMA_V14 }` after v13.

**Verify**: `pnpm --filter borealis-server exec vitest run --config vitest.integration.config.ts src/tests/sqliteFoundation.test.ts` → fresh schema is v14; every historical fixture reaches v14; valid preparing/ambiguous-active/cleanup states migrate; unrelated metadata survives byte-for-byte at the decoded-object level; malformed legacy state rolls back with `user_version` still 13.

In the same fixture suite, create two connector-backed sources for one account
and use direct SQL to try pairing source A with connector B in
`connector_refresh_states`; require an immediate foreign-key rejection. Assert
the unique parent index and all four repair indexes exist, and run
`EXPLAIN QUERY PLAN` for the three exact
Plan 016 selectors plus the connector selector to prove their named indexes are
used with no temporary B-tree sort.

### Step 3: Add a typed store and transactional state transitions

Create `server/src/db/stores/connectorRefreshStore.ts`. Decode rows through the repository’s strict SQLite codecs into a discriminated union:

- `preparing`: no candidate locations;
- `prepared`: candidate plus expected activation-previous identity;
- `activating`: the external CAS may be in flight or ambiguously completed;
- `activated`: exact candidate confirmed active, promotion not yet committed;
- `cleanup_pending`: SQLite/source promotion committed, exact old location awaits cleanup.

Expose narrow operations, not generic JSON mutation: reserve preparing, record
prepared, claim activation, confirm activation, return an unactivated
`activating` row to prepared, mark cleanup pending during promotion, list a
globally ordered bounded page of repairable states, touch a still-current failed
attempt, complete exact cleanup, and fail/clear a superseded prepare. Every
update/delete is an
account/source/connector/generation/refresh-version/expected-phase
compare-and-swap and reports lost ownership instead of widening. Periodic page
reads order by `attempts, updated_at, source_id`; startup pages use immutable
`repair_ordinal`. The failure/no-progress touch CAS accepts the selected row's
old attempts/timestamp as part of its expected identity, increments attempts,
and sets a caller-supplied next timestamp. Never accept a row selected only by
source ID. Use a shared ISO-millisecond successor helper returning
`max(clockNow, selectedUpdatedAt + 1 ms)` (reject invalid/overflowing input) for
deterministic timestamps, but rely on attempts—not time alone—for periodic
fairness. Successful phase transitions reset attempts to zero while updating
time.

Compose the store exactly once in `server/src/storageRuntime.ts`; the plan-014
`ApplicationRuntime` owns that composed `StorageRuntime`. Do not edit
`applicationRuntime.ts` or create a second store there. Keep multi-row changes
with `sources`, `connectors`, and `ingestion_jobs` inside the same
`withImmediateTransaction`; pass the transaction to internal helpers rather
than nesting transactions.

Add `connectorRefreshStore.test.ts` to the serialized integration list in `server/src/tests/vitestTestPartitions.ts`; it opens native SQLite and must not drift into the parallel unit pool.

Integrate source/connector deletion before relying on `ON DELETE CASCADE`.
Change `SourceStore.reservePendingDelete` (and its callers) so the same
`BEGIN IMMEDIATE` transaction that inserts `pending_source_deletes` reads the
exact typed refresh row for that source **before** deleting the source or
connector. Build `dataset_locations` as a stable de-duplicated union of
`source.file_path`, `candidate_location`, `activation_previous_location`, and
`cleanup_previous_location`, omitting nulls. Do not read the removed protocol
keys from `sources.meta`. Both `deleteSource` and bulk `deleteConnector` must
reserve these locations for every source before the typed row cascades away;
the durable pending intent then remains the sole cleanup authority under Plan
011. Keep all path values internal/content-free and preserve the existing
idempotent already-pending behavior.

In `sqliteSourceStore.test.ts`, delete sources/connectors from every legal typed
phase. At minimum, prove a `cleanup_pending` deletion snapshots both candidate
and old cleanup location before cascade, an ambiguous `activating` deletion
snapshots candidate plus activation-previous identity, duplicates are removed,
the typed row is gone, and the pending intent survives for exact startup/
periodic cleanup. Inject a transaction failure after reservation and prove
neither source nor typed state nor intent changes. Do not assert or log raw paths
outside the test process.

**Verify**: `pnpm --filter borealis-server exec vitest run --config vitest.integration.config.ts src/tests/connectorRefreshStore.test.ts src/tests/sourceIngestionTransitions.test.ts` → all legal edges pass; illegal phase skips, stale generations, wrong accounts/connectors/versions, duplicate rows, and lost CAS fail closed.

Run the Migration/store tests command → source and connector deletion retain
every exact typed cleanup location before cascade, and direct-SQL cross-pairing
is rejected.

### Step 4: Move prepare and activation to durable phases

Refactor `sourceIngestionTransitions.ts` and `ingest.ts` so `beginConnectorRefresh` inserts `preparing` in the same transaction as job/source/connector reservation. The prepare worker reads the typed row, not source metadata. After `prepareDatasetRefresh` returns an exact version/candidate/previous identity, transition `preparing → prepared` in the same transaction that changes the job to pending.

In `ingestionEngine.ts`, load the typed refresh row for the exact lease. Before calling `activateDatasetRefresh`, CAS `prepared → activating`. After the external call returns the expected version and candidate location, CAS `activating → activated`; only an `activated` row may proceed to vector/SQLite promotion. If the call throws after activation was claimed, leave `activating` durable and surface the existing retryable/sanitized internal failure — never convert it to a generic failed generation or abort its candidate blindly.

During the existing SQLite promotion transaction, require the same `activated` identity. Move it to `cleanup_pending` when an exact, distinct previous location remains, or delete it when no cleanup is needed. Keep vector visibility governed by the existing authoritative SQLite `ready_generation` and plan-015 promotion contract.

Remove runtime reads/writes of the four protocol keys from `sources.meta`. Continue using that JSON only for bounded display/error metadata.

**Verify**:

- `pnpm --filter borealis-server exec vitest run --config vitest.integration.config.ts src/tests/sourceIngestionTransitions.test.ts` → serialized prepare/transition cases pass.
- `pnpm --filter borealis-server exec vitest run src/tests/ingestionWorker.test.ts src/tests/ingestionEngine.test.ts` → default-partition activation, stale lease, crash-after-claim, promotion, and cleanup-intent cases pass with typed rows and no protocol metadata.

### Step 5: Add bounded, fair periodic repair and a finite startup snapshot pass

Replace metadata-based connector repair in `ingest.ts` with typed-state repair
inside the plan-016 reconciliation scheduler and under the plan-014 runtime
owner. Define a named fixed `CONNECTOR_REFRESH_REPAIR_LIMIT = 20` beside plan
016's limits and add connector refresh as the fourth queue in
`runPeriodicStorageReconciliation`, after the existing 100 pending-vector, 100
pending-source-delete, and 20 dataset-cache-cleanup bounds. One periodic
invocation reads exactly one global page of at most 20 rows ordered by
`attempts, updated_at, source_id`; it must never loop to a second page in the
same tick.

Process each returned state independently and sequentially. A
protocol/data-service failure for one row must not abort its peers: retain the
row, record only a stable aggregate error code, calculate the monotonic
timestamp successor, and CAS-touch that exact
account/source/connector/generation/refresh-version/phase/old-attempts/
old-`updated_at` so attempts increments even under a fixed or backward clock.
Successful transitions reset attempts to zero and advance `updated_at` or
delete the row; any successful action that intentionally leaves the same phase
is no progress and must use the same incrementing touch operation. Thus one bad
early row moves behind untouched lower-attempt work instead of pinning the page.
A page-read/storage failure may reject the queue invocation
through plan 016's existing aggregate failure boundary, but must not produce
per-resource logs.

Before the repair code performs any `activating` decision, extend the opaque
`dataService` facade with one internal
`currentDatasetLocation(accountId, name, callerSignal?)` method returning only
`string | null`. Wrap the already-imported data-layer operation with
`inProcess`, the ordinary bounded dataset-operation timeout, and existing
content-free `DataServiceError` mapping. Do not expose it through HTTP, return a
catalog row, call `listDatasets`, or import `data/datasets.ts` from `ingest.ts`.
In `dataService.test.ts`, assert exact account/name forwarding, `null` and exact
location results, caller cancellation/timeout/error sanitization, and that the
repair path invokes this method once for an `activating` row without calling
the unbounded catalog-list operation. Never print or snapshot a returned path.

For the complete cold-start repair, invoke the typed snapshot pass from the retained startup `restoreDatasets()` path only after that path has rebuilt the ready DuckDB registry. Do not invoke it earlier from `startIngestionWorkers`, where an empty in-memory DuckDB catalog would falsely classify an ambiguous activation. Reset a module-owned `connectorRefreshStartupSettled` gate to false when ingestion workers start; set it true only in `finally` after the post-registry typed snapshot attempt settles. Until that gate is true, periodic reconciliation still runs plan 016's first three queues but skips the fourth queue without reading or changing typed refresh rows. Reset it again on stop so a sequential plan-014 runtime cannot inherit readiness. Keep the post-plan-014 startup-reconciliation promise and close-time await as the owner of this work.

Capture `MAX(repair_ordinal)` from persisted state once before listing refresh
rows; zero means the snapshot is empty. Read bounded keyset pages of at most 20
where `repair_ordinal <= capturedMax` and `repair_ordinal > priorCursor`, ordered
by `repair_ordinal`, never with offsets or a wall-clock cutoff. Advance the
cursor to the last ordinal returned regardless of each repair outcome. Because
the AUTOINCREMENT ordinal never changes or reuses an old value, every row
present in the captured startup set is attempted at most once and every row
created concurrently has a larger ordinal and waits for periodic repair. A lost
CAS means a concurrent owner changed/deleted the exact row and still counts as
that snapshot row's attempt. Stop after the first short page. Rows that fail or
transition during the pass remain durable for a later periodic retry; no result
can move backward in the startup cursor or create an infinite loop.

Apply the following phase-specific operation for either owner without guessing:

- `preparing`: validate its exact job/source/connector identity and make the prepare pump eligible.
- `prepared`: validate the candidate file and queue its exact pending generation.
- `activating`: ask DuckDB for the exact current location. If it equals the candidate, CAS to `activated`; if it equals the expected activation-previous location (including the explicit no-current-location case), CAS back to `prepared`; any third location is an invariant failure that remains durable and fail-closed.
- `activated`: resume only its exact generation’s promotion path; never call activation again.
- `cleanup_pending`: prove the source is ready at the candidate, request cleanup for exactly `cleanup_previous_location`, and delete the row only after the data service confirms cleanup. Failure leaves the row retryable.

Repair must never fetch remote data, delete the candidate, use table name alone, or activate/clean a location inferred from current metadata. Log aggregate counts and stable error codes only — no account/source IDs, URLs, table names, or paths. Preserve plan 016's single coalesced reconciliation pump and shutdown drain; the fourth queue runs inside that owned promise.

Extend plan 016's `ingestRestore.test.ts` reconciliation characterization. Defer
startup registry restoration, invoke periodic reconciliation, and prove the
first three queues run while the typed fourth queue is not read. After the
startup typed pass settles, assert a periodic invocation requests limits `100`,
`100`, `20`, and `20` for its four queues and never takes a second refresh page.
Stop/restart the owned ingestion lifecycle and prove the fourth queue is gated
again until the new runtime's restore settles. Fill one complete 20-row periodic
page with invariant failures at attempt zero, then place untouched rows behind
it with equal and future timestamps. Hold the fake clock fixed (and separately
move it backward): the first invocation independently increments all 20 failed
rows to attempt one, and the next invocation selects the untouched attempt-zero
rows first. Include valid and invalid peers within later pages to retain
per-state failure isolation. For startup, use more than two ordinal pages,
insert a new row while the pass is running, delete a high-ordinal captured row,
and include a durable third-location failure; assert every row at or below the
captured maximum repair ordinal is attempted at most once, AUTOINCREMENT does
not reuse the deleted ordinal, the pass terminates, and newly inserted/failed
rows remain for periodic retry. Use fake clocks/deferred promises, not elapsed
sleeps, and assert logs contain only aggregate codes/counts.

**Verify**: `pnpm --filter borealis-server exec vitest run src/tests/dataService.test.ts src/tests/ingestRestore.test.ts src/tests/ingestionWorker.test.ts src/tests/ingestionEngine.test.ts` → the facade contract and each crash boundary pass in the default partition; the fourth queue is globally bounded and failure-isolated; periodic and startup fairness/termination cases pass; cleanup retries; logs are aggregate/content-free.

### Step 6: Run structural and complete gates

Search production runtime code for the removed protocol keys. Matches are permitted only in v14 migration/backfill and migration tests/fixtures.

**Verify**: `rg -n "connector_(refresh_version|candidate_location|activation_previous_location|previous_location)" server/src --glob '!server/src/db/migrations.ts' --glob '!server/src/tests/**'` → no matches.

Then run all gates.

**Verify**: `pnpm policy && pnpm --filter borealis-server typecheck && pnpm --filter borealis-server lint && pnpm --filter borealis-server format:check && pnpm --filter borealis-server test && pnpm --filter borealis-server test:integration && pnpm verify` → exit 0 and final output includes `ALL GATES GREEN`.

## Test plan

- `sqliteFoundation.test.ts` via plan-003 fixtures: fresh v14, every old schema
  to v14, exact v13 predecessor, valid legacy preparing/candidate/cleanup
  mappings, immutable/non-reused repair ordinals, attempts defaults, preserved
  unrelated/error metadata, idempotence, malformed-state rollback,
  source/connector/account cross-pair rejection, and query-plan use of all four
  v14 repair indexes without temporary sorts.
- New `connectorRefreshStore.test.ts`: strict decoding, composite tenancy, legal
  phase graph, stale CAS rejection, cascades, global
  `attempts, updated_at, source_id` periodic-page ordering, immutable-ordinal
  startup paging, limit validation, old-timestamp CAS, and strictly monotonic
  retry-touch fairness under fixed/backward clocks.
- `sourceIngestionTransitions.test.ts`: state changes share transactions with source/connector/job changes and roll back together.
- `sqliteSourceStore.test.ts`: source and connector deletion snapshot every
  exact typed candidate/previous location into the durable Plan 011 intent
  before the refresh row cascades; rollback and already-pending behavior remain
  atomic/idempotent.
- `dataService.test.ts`: the narrow current-location facade forwards the exact
  account/name, returns only `string | null`, preserves cancellation and timeout
  behavior, sanitizes failures, and never widens repair into catalog listing.
- `ingestionWorker.test.ts` and `ingestionEngine.test.ts`: exact immutable cache CAS, crash before/after activation call/ack, generation lease loss, promotion requirement, and no blind abort.
- `ingestRestore.test.ts`: all five durable phases, bounded facade-only exact
  current-location reconciliation, fourth-queue limit 20, a complete failing
  page moving behind untouched work by attempts, per-row failure isolation,
  finite ordinal-keyset startup snapshot, retryable cleanup, unexpected third
  location, no remote fetch/catalog listing, and content-free aggregate logging.

## Done criteria

- [ ] Schema version is exactly 14, with v12/v13 untouched and one immutable `v014.sql` fixture.
- [ ] `connector_refresh_states` has strict phase/location/composite-ownership
      constraints, immutable AUTOINCREMENT startup ordinals, nonnegative
      attempts, and an `(attempts, updated_at, source_id)` periodic repair index.
- [ ] The three-column source/connector/account foreign key rejects a source
      paired with another connector in the same account, including direct SQL.
- [ ] The three Plan 016 attempts-first selectors use their exact v14 indexes
      with no temporary sort, completing the earlier bounded-work/index handoff.
- [ ] Every valid legacy protocol-key combination migrates transactionally; malformed combinations roll back; display/error metadata remains.
- [ ] Runtime prepare, activate, promote, cleanup, and startup repair use only the typed durable table.
- [ ] DuckDB activation and cleanup retain exact immutable-location compare-and-swap checks.
- [ ] An ambiguous activation is reconciled from exact current location; it is never guessed, reactivated blindly, or discarded.
- [ ] Production code has no source-meta protocol-key references outside the migration.
- [ ] Source and connector deletion copy every typed refresh location into the
      pending source-delete intent in the same transaction before cascade, so
      `cleanup_pending` and ambiguous activation artifacts remain recoverable.
- [ ] `connectorRefreshStore.test.ts` is explicitly in plan 001’s serialized integration manifest and not in the parallel unit partition.
- [ ] Plan 015’s shortened promotion boundary remains intact; plan 016's owned periodic pump has exactly four bounded queues (`100/100/20/20`) and drains during shutdown.
- [ ] A complete failed page increments attempts and advances behind untouched
      work even with equal/future timestamps and fixed/backward clocks; one row
      cannot abort peers or cause an infinite startup pass; startup rows are
      attempted at most once per captured ordinal pass.
- [ ] Cold-start typed repair begins only after the ready DuckDB registry restore and remains owned/awaited by the startup-reconciliation lifecycle promise.
- [ ] Periodic typed repair is skipped until that startup attempt settles, and its readiness gate resets across stop/sequential runtime start; the other three plan-016 queues remain available while gated.
- [ ] All targeted, server, policy, and repository gates pass with `ALL GATES GREEN`.
- [ ] Only in-scope files plus the optional index row are modified.
- [ ] Plan 020 is marked `DONE` unless the reviewer owns the index.

## STOP conditions

Stop and report if:

- Any dependency plan (003, 006, 012, 014, 015, or 016) is not `DONE`.
- `LATEST_SQLITE_SCHEMA_VERSION` is not exactly 13, v12 is not provider-bound consent, v13 is not automation-target ownership, or either migration/fixture has been renumbered.
- Plan 003’s helper/fixture contract or plan 014’s single runtime owner is absent.
- Plan 001’s test partitions cannot place the new native store suite in serialized integration, or plan 015/016’s final promotion/reconciliation contracts are absent.
- A legacy key combination cannot be mapped without guessing whether a location is active; preserve the database at v13 and report the exact structural combination without exposing path values.
- DuckDB cannot return an exact current location for `activating` repair or cannot enforce exact-location cleanup.
- The typed store cannot periodically page by
  `attempts, updated_at, source_id`, cannot increment a failed exact row's
  attempts, cannot keyset a finite startup snapshot by immutable/non-reused
  repair ordinal, or cannot isolate one row's failure without weakening
  ownership checks.
- Startup cannot guarantee the ready DuckDB registry is rebuilt before ambiguous typed refresh states are reconciled, or shutdown cannot await that startup pass.
- The solution requires permanent dual-write, table-name-only cleanup, a weakened CAS, a remote refetch during startup, or a change to SQLite/LanceDB visibility semantics.
- The v14 migration cannot preserve unrelated/error metadata or roll back atomically on invalid state.
- The v14 schema cannot enforce exact source/connector/account pairing, or a
  typed row can cascade before source deletion atomically preserves all of its
  cleanup locations in the existing durable intent.
- Any Plan 016 attempts-first query shape cannot use the exact v14 index without
  a full scan/temporary sort; do not silently claim backlog-independent
  selection cost.
- A required fix is outside scope or any verification fails twice after one reasonable correction.

## Maintenance notes

- Future connector-refresh phases belong in this table and its discriminated union, never in `sources.meta`.
- Treat `activating` as an explicit uncertainty state. Recovery must query the authoritative external catalog and compare exact locations before changing it.
- Keep schema migrations contiguous and immutable. Plan 003’s fixture for v14 must change in the same review as `SCHEMA_V14`, then never be edited after release.
- Plan 023 must document schema v14, typed crash recovery, and that `sources.meta` retains display/error metadata only; it must not expose filesystem locations.

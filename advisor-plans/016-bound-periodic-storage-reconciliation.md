# Plan 016: Bound periodic storage reconciliation

> **Executor instructions**: Do not start until plans 011, 014, and 015 are DONE and their cleanup, lifecycle-ownership, and promotion tests are green. Follow every step and verification gate. If a STOP condition occurs, stop and report; do not remove the full startup repair or replace durable intents with an undurable progress cursor. The connection-local finite snapshot specified below is disposable control state only. When complete, update this plan's row in `advisor-plans/README.md` unless the reviewer owns index maintenance.
>
> **Drift check (run first, after dependencies)**: `git diff --stat f1b9293..HEAD -- server/src/ingest.ts server/src/vector/lifecycle.ts server/src/db/stores/sourceStore.ts server/src/db/stores/ingestionStore.ts server/src/tests/ingestRestore.test.ts server/src/tests/ingestionVectorLifecycle.test.ts server/src/tests/sourceIngestionTransitions.test.ts server/src/tests/sqliteSourceStore.test.ts`
> Compare the timer body, vector repair API, pending-delete ordering, and shutdown pumps with the Current state excerpts. Plan 011 intentionally changes durable source-cleanup success and the `ingestRestore` mocks, plan 014 establishes owned application shutdown, and plan 015 changes vector promotion/lifecycle tests. Reconcile all three first. A different durable reconciliation protocol is a STOP condition.
> Plans 024, 031, 035, and 037 are completed baseline: preserve durable
> exact-location cache tombstones, schema-v12 catalog indexes, all live/staged/
> backup embedding-index identity checks, migration quiescence, and the exact
> server workspace lock. Their expected queue/store/lifecycle changes are not a
> STOP; this plan may bound work but may not merge or bypass those authorities.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: MED
- **Depends on**: `advisor-plans/011-preserve-source-cleanup-intents.md`, `advisor-plans/014-create-owned-application-runtime.md`, `advisor-plans/015-shorten-vector-promotion-transaction.md`
- **Preserve completed baseline**: Plans 024, 031, 035, and 037
- **Category**: perf
- **Planned at**: commit `f1b9293`, 2026-08-30

## Why this matters

Every 60 seconds the ingestion scheduler performs two whole-workspace
reconciliations: it loads the complete SQLite vector-repair state and scans
every LanceDB row, then loads every account/tabular source and asks DuckDB for
every account's catalog. Pending source deletion also begins with an unbounded
distinct-account scan and can process 1,000 rows per account in one pass. That
makes background work proportional to total retained data and accounts on every
tick, even when no durable work is pending, and competes with ingestion,
retrieval, chat persistence, and analytics. Keep a deliberately thorough,
finite startup snapshot repair, but make recurring external work and returned
pages consume only bounded durable queues. Plan 020's serialized v15 migration
adds the matching attempts-first indexes that also bound final queue-selection
scan/sort cost; until then this plan must not claim a backlog-independent SQLite
query latency.

## Current state

- `server/src/ingest.ts:373-386` runs full repair and dataset restoration every minute:

  ```ts
  let reconciling = false;
  reconciliationTimer = setInterval(() => {
    if (reconciling) return;
    reconciling = true;
    void runWithRequestContext("storage-reconciliation.periodic", async () => {
      await storageRuntime().vectorLifecycle.repair({
        completePendingSourceDeletes: repairPendingSourceDeletes,
      });
      await restoreDatasets(1);
      await processDatasetCacheCleanup();
    })
      .catch(() =>
        appLog.warn(
          { error_code: "STORAGE_RECONCILIATION_FAILED" },
          "storage reconciliation failed",
        ),
      )
      .finally(() => {
        reconciling = false;
      });
  }, 60_000);
  ```

- `server/src/vector/lifecycle.ts:157-170` mixes bounded queue drainage with whole-store state reads in one generic `repair` method:

  ```ts
  async repair(options: { completePendingSourceDeletes?: () => Promise<number> } = {}): Promise<VectorRepairSummary> {
    const pending = await this.drainPendingVectorOperations();
    // ...pending source deletion callback...
    const state = await this.store.vectorRepairState();
    const vectorRows = await this.vectors.scanRows();
  ```

  `vectorRepairState()` loads every source, job, and valid chunk ID; `scanRows()` loads every vector identity before the method classifies orphan sources, generations, and chunk IDs (`server/src/vector/lifecycle.ts:169-219`). This deep sweep is appropriate at startup, not as minute-cadence steady-state work.

- `server/src/ingest.ts:337-348` finds every account with a pending deletion and then takes up to 1,000 intents from each account:

  ```ts
  const accounts = await runtime.ledger.all<{ account_id: string }>(
    "SELECT DISTINCT account_id FROM pending_source_deletes ORDER BY account_id"
  );
  let completed = 0;
  for (const row of accounts) {
    const intents = await runtime.sources.listPendingSourceDeletes(row.account_id, 1_000);
    const outcome = await completeSourceDeleteIntents(intents);
  ```

  The account-scoped store query orders by `created_at, source_id` (`server/src/db/stores/sourceStore.ts:517-524`). It remains useful for resource operations, but cannot impose one global per-tick bound.

  It is also not a complete startup pass: more than 1,000 unfinished deletions
  for one account leave the remainder unattempted until a later timer. Startup
  needs a finite exact snapshot that can page every row present at capture time
  once without allowing failures or concurrent inserts to pin/extend the pass.

- `restoreDatasets` ignores its `_attempts` argument and starts with a complete user/source join (`server/src/ingest.ts:410-418`):

  ```ts
  export async function restoreDatasets(_attempts = 8): Promise<RestoreSummary> {
    const runtime = storageRuntime();
    const rows = await runtime.ledger.all<RegistryRow>(
      `SELECT u.id AS account_id, s.id AS source_id, s.name, s.file_path, s.display_name,
              s.url, s.connector, s.mime, s.status, s.meta
         FROM users u
         LEFT JOIN sources s ON s.account_id=u.id AND s.kind='tabular'
         ORDER BY u.id,s.name`
    );
  ```

  It later calls `dataService.listDatasets` once for every account. The startup call in `server/src/serverApp.ts:165-167` must remain; the unused numeric argument is not a batch limit.

- Durable steady-state work already has bounded APIs. `IngestionVectorLifecycle.drainPendingVectorOperations(limit = 100)` reads at most the requested operation count (`server/src/vector/lifecycle.ts:141-155`). `SqliteIngestionStore.listDatasetCleanupJobs` defaults to 20 and rejects limits above 100 (`server/src/db/stores/ingestionStore.ts:541-572`). These are the safe periodic primitives.

- Dependency plan 011 preserves a source intent unless exact external cleanup is proven and retains today's batch-all-or-nothing coordinator behavior. Passing a mixed 100-intent page to `completeSourceDeleteIntents` would let one permanent failure retain all 99 otherwise-good markers. Periodic processing therefore must isolate each intent while retaining a hard total page bound.

- `stopIngestionWorkers` clears the timers but awaits only the ingestion and connector-prepare pumps (`server/src/ingest.ts:390-397`):

  ```ts
  if (reconciliationTimer) clearInterval(reconciliationTimer);
  reconciliationTimer = undefined;
  workersStarted = false;
  await Promise.allSettled(
    [ingestionPump, connectorPreparePump].filter(Boolean) as Promise<void>[],
  );
  cachedEngine = undefined;
  ```

  The local `reconciling` flag does not expose the active promise, so storage
  shutdown can race a periodic repair. The 15-second lease-recovery callback is
  also untracked. In addition, `wakeIngestionWorkers`,
  `wakeConnectorPrepareWorkers`, and both pump `finally` handlers ignore
  `workersStarted`; they can create a new pump after stop has snapshotted the
  old promises.

- All three durable retry queues currently order primarily by wall-clock
  `updated_at`: pending source deletion in the proposed cross-account method,
  pending vector operations in `ingestionStore.ts:810-825`, and dataset cleanup
  in `ingestionStore.ts:541-562`. Millisecond timestamps can tie or move
  backward, so merely rewriting `updated_at` does not prove that a repeatedly
  failing low-sort row leaves a bounded first page. Their existing non-negative
  `attempts` columns provide the deterministic fairness key: untouched work
  must sort before retried work.

- None of those three attempts-first orderings has a matching index at the
  planned commit. `LIMIT` bounds returned rows and downstream side effects, but
  SQLite may still scan/sort the complete retry table. Schema numbering is
  already serialized through v12/v13/v14 and Plan 020 owns v15, so this plan names
  that interim limitation and Plan 020 adds the exact three indexes rather than
  creating an unversioned runtime index.

- The repository contract requires full startup removal of stale generations, orphan vectors, and unfinished source deletions. It also requires SQLite chunk text, LanceDB-only vectors, SQLite-authoritative `ready_generation`, and LanceDB-prefiltered retrieval. This plan preserves all of those boundaries and does not move ledger state into DuckDB.

## Commands you will need

| Purpose                               | Command                                                                                                                                                                                                           | Expected on success                                                      |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Periodic reconciliation tests         | `pnpm --filter borealis-server exec vitest run src/tests/ingestRestore.test.ts`                                                                                                                                   | bounded/coalesced periodic and shutdown-drain tests pass                 |
| Native lifecycle/store tests          | `pnpm --filter borealis-server exec vitest run --config vitest.integration.config.ts src/tests/ingestionVectorLifecycle.test.ts src/tests/sourceIngestionTransitions.test.ts src/tests/sqliteSourceStore.test.ts` | startup sweep and all three retry-queue ordering tests pass serially     |
| Cleanup dependency regression         | `pnpm --filter borealis-server exec vitest run src/tests/sourceCleanup.test.ts src/tests/sourceManagementRoutes.test.ts src/tests/ingestionWorker.test.ts src/tests/ingestRestore.test.ts`                        | false/unproven artifact removal retains only the affected durable intent |
| Cleanup artifact-ownership regression | `pnpm --filter borealis-server exec vitest run src/tests/storageArtifacts.test.ts src/tests/reportCleanup.test.ts`                                                                                                | existing exact-path and cleanup tests pass                               |
| Actual-storage runtime regression     | `pnpm --filter borealis-server exec vitest run --config vitest.integration.config.ts src/tests/applicationRuntime.test.ts`                                                                                        | restart/ownership cases prove ingestion shutdown precedes storage close  |
| Mocked runtime lifecycle regression   | `pnpm --filter borealis-server exec vitest run src/tests/serverApp.test.ts src/tests/automations.test.ts`                                                                                                         | server and route lifecycle cases pass                                    |
| Promotion lifecycle regression        | `pnpm --filter borealis-server exec vitest run --config vitest.integration.config.ts src/tests/ingestionVectorLifecycle.test.ts`                                                                                  | promotion remains fail-closed and does not hold SQLite across vector I/O |
| Promotion SQLite regression           | `pnpm --filter borealis-server exec vitest run --config vitest.integration.config.ts src/tests/sqliteFoundation.test.ts`                                                                                          | ledger gate and transaction-concurrency cases pass                       |
| Server typecheck                      | `pnpm --filter borealis-server typecheck`                                                                                                                                                                         | exit 0, no errors                                                        |
| Server lint/format                    | `pnpm --filter borealis-server lint && pnpm --filter borealis-server format:check`                                                                                                                                | exit 0, no warnings                                                      |
| Full server suites                    | `pnpm --filter borealis-server test && pnpm --filter borealis-server test:integration`                                                                                                                            | unit and serialized integration suites pass                              |
| Final repository gate                 | `pnpm verify`                                                                                                                                                                                                     | exit 0 and prints `ALL GATES GREEN` on a provisioned supported host      |

## Scope

**In scope** (the only source/test files to modify):

- `server/src/ingest.ts`
- `server/src/vector/lifecycle.ts`
- `server/src/db/stores/sourceStore.ts`
- `server/src/db/stores/ingestionStore.ts`
- `server/src/tests/ingestRestore.test.ts`
- `server/src/tests/ingestionVectorLifecycle.test.ts`
- `server/src/tests/sourceIngestionTransitions.test.ts`
- `server/src/tests/sqliteSourceStore.test.ts`

**Out of scope** (do not touch):

- The full startup vector sweep or the startup `restoreDatasets()` call in `server/src/serverApp.ts`; both remain deliberately thorough.
- `server/src/applicationRuntime.ts` and server close orchestration from Plan 014. This plan makes `stopIngestionWorkers()` drain its owned pump; the existing owner must continue awaiting that call before storage close.
- SQLite/LanceDB promotion, pruning, or retrieval semantics from plan 015; chunk text stays only in SQLite and vectors only in LanceDB.
- A migration, new reconciliation table, persisted cursor, cron/scheduler
  cadence, or changes to vector/cache cleanup schemas. Ordering existing retry
  rows by their existing `attempts` fields is in scope. A connection-local TEMP
  table used only to freeze one finite startup-delete snapshot is not durable
  schema and is in scope; Plan 020 adds the final persistent repair indexes in
  v15.
- DuckDB catalog capacity or account/sorted-allowlist scoping, connector activation, extraction, or dataset registration behavior.
- Source cleanup ownership/path proof, Plan 011's proven-removal success semantics, or its batch coordinator contract. This plan consumes that contract one intent at a time; it does not redesign it.
- Logging resource IDs, paths, content, URLs, SQL results, or exception bodies. Reconciliation logs remain aggregate and content-free.

## Git workflow

- Branch: `codex/016-bound-periodic-storage-reconciliation`
- Suggested commits:
  1. `test(server): characterize bounded storage reconciliation`
  2. `perf(server): bound periodic storage reconciliation`
- Use conventional commits. Do not push or open a PR without explicit instruction.

## Steps

### Step 1: Name the whole-store vector sweep as startup-only

Rename `IngestionVectorLifecycle.repair` to `repairAtStartup` and update its production/test callers. Do not retain a generic `repair` alias: a generic name makes it too easy to reintroduce the full scan into a timer. Preserve the implementation and summary exactly, including:

- bounded pending-vector-operation drainage first;
- the optional pending-source-delete callback;
- complete SQLite `vectorRepairState()` and LanceDB `scanRows()` reads;
- orphan source/generation/chunk cleanup under existing source locks; and
- aggregate failure accounting.

`startIngestionWorkers()` must still await
`repairAtStartup({ completePendingSourceDeletes: repairPendingSourceDeletesAtStartup })`
before setting `workersStarted` or installing either interval. The callback is
the finite snapshot pass defined in Step 2, not the periodic one-page helper.
Preserve the existing separate startup `restoreDatasets()` task in
`serverApp.ts` without bringing `serverApp.ts` into Scope.

Update `ingestionVectorLifecycle.test.ts` to call the new name. Retain all orphan-source, invalid-generation, missing-chunk, queued-operation, and incomplete-vector assertions from the post-plan-015 file.

**Verify**: `rg -n 'vectorLifecycle\.repair\(|\.lifecycle\.repair\(' server/src --glob '*.ts'` → no output and exit 1. Run the Native lifecycle/store tests command → the full startup sweep still repairs every characterized inconsistency.

### Step 2: Add one globally bounded, retry-fair cleanup page

Add
`SourceStore.listPendingSourceDeletesAcrossAccounts(limit = DEFAULT_LIST_LIMIT)`.
It is an internal repair primitive, not an account-facing API. Validate `limit`
through the existing `listLimit` helper, select the existing
`PENDING_DELETE_COLUMNS`, decode with `decodePendingDelete`, and use one query
ordered by `attempts, updated_at, account_id, source_id LIMIT ?`. The attempts
key is load-bearing: a failed marker increments attempts, so every untouched row
at a lower attempt count sorts ahead even when timestamps tie or the wall clock
moves backward.

Keep `listPendingSourceDeletes(accountId, limit)` unchanged for tenant-scoped
resource operations. Do not expose the cross-account method through a route or
accept an account identifier from a request.

Add a second, startup-only package-internal snapshot boundary to `SourceStore`.
Before its first await/transaction, reserve a store-instance-private exact
snapshot token; a second capture on that store fails before dropping or
changing the active snapshot. Within one immediate transaction it must drop any
stale fixed-name connection-local TEMP snapshot table left with no active token,
recreate it with
`snapshot_ordinal INTEGER PRIMARY KEY AUTOINCREMENT` plus unique
`(account_id, source_id)`, and populate it once from every current
`pending_source_deletes` identity in deterministic
`created_at, account_id, source_id` order. The returned opaque snapshot handle
owns that exact TEMP table and exposes only bounded keyset pages after a prior
snapshot ordinal plus an idempotent `close()`/drop. Page by immutable snapshot
ordinal, left-join the current pending row, and return the ordinal even when a
concurrent cleanup deleted that row so the cursor always advances. Only the
single startup repair pump may own a snapshot; a second concurrent capture
fails closed. Never expose this through a route or treat TEMP state as durable
correctness state: the actual cleanup intents remain in the persistent table.
The handle's identity-checked `close()` drops only its table and releases only
its token. A capture failure attempts drop/release before rejecting; if exact
ownership cannot be proven, poison further snapshot capture for that store
rather than let a new pass overwrite unknown TEMP state.

Implement `repairPendingSourceDeletesAtStartup()` around that handle. Capture
once, loop bounded pages of 100 until the snapshot is exhausted, advance to the
last returned ordinal regardless of missing/failed rows, and invoke
`completeSourceDeleteIntents([intent])` separately for each still-current
intent. Close/drop the TEMP snapshot in `finally`. A concurrently inserted
intent is outside the frozen snapshot and waits for periodic repair; a failed
intent remains durable for periodic retry; a deleted captured row cannot stall
the cursor. This gives a finite pass that attempts every intent present at
capture time at most once without an unbounded in-memory identity list, offset
pagination, a wall-clock cutoff, or a new persisted cursor.

Apply the same retry-first deterministic order to the other two periodic
queues in `SqliteIngestionStore`:

- pending vector operations order by
  `attempts, updated_at, source_id, operation, generation`; and
- dataset-cache cleanup jobs order by
  `attempts, updated_at, account_id, name, location`.

Do not add timestamps, a cursor, or a migration; all three tables already have
non-negative attempts and stable identity columns. The rule is fairness among
bounded durable retry rows, not FIFO across different attempt counts.

These orderings deliberately precede their persistent indexes. Record the exact
v15 handoff for Plan 020: it must add indexes matching
`pending_source_deletes(attempts, updated_at, account_id, source_id)`,
`pending_vector_ops(attempts, updated_at, source_id, operation, generation)`,
and
`dataset_cache_cleanup_jobs(attempts, updated_at, account_id, name, location)`.
Until v15 lands, assert bounded returned rows/cleanup calls and fair order, but
do not describe the SQL selection itself as backlog-independent.

In `sqliteSourceStore.test.ts`, create pending intents for at least two accounts
with deterministic timestamps. Prove that:

- the global method returns no more than the requested total across all
  accounts;
- results follow the complete attempts/timestamp/identity order;
- decoding retains each intent's correct account and resource identity;
- limit 0 and a value above the existing maximum fail with
  `SOURCE_STORE_INVALID_ARGUMENT`; and
- the original account-scoped method remains tenant-isolated.

Create more than two startup snapshot pages, then insert a new pending row and
delete a captured high-ordinal row between pages. Prove every surviving row
captured initially is returned once, the deleted ordinal is advanced past, the
new row is excluded, failures remain durable, the loop terminates, and the TEMP
table is dropped on success and injected failure.

Add fixed-clock/tied-timestamp retry-fairness cases for all three queues. After
resolving an early source/vector/dataset row as failed, assert its attempts
increment and untouched rows enter the next bounded page before it even though
every `updated_at` value is identical. Use `ingestionVectorLifecycle.test.ts`
for vector operation ordering and `sourceIngestionTransitions.test.ts` for
dataset cleanup ordering; keep tests serialized through the integration
config.

**Verify**: run the Native lifecycle/store tests command → global paging,
validation, deterministic tied-clock fairness, and existing store/lifecycle
tests pass.

### Step 3: Replace periodic full scans with bounded durable work

In `server/src/ingest.ts`, define named fixed limits near the worker constants: 100 pending vector operations, 100 pending source deletions total, and 20 dataset-cache cleanup jobs. Add a testable `runPeriodicStorageReconciliation(): Promise<void>` entry point whose one invocation performs only:

1. `vectorLifecycle.drainPendingVectorOperations(100)`;
2. one `listPendingSourceDeletesAcrossAccounts(100)` page, invoking `completeSourceDeleteIntents([intent])` separately and sequentially for each returned intent; and
3. one dataset-cache cleanup page of 20.

The per-intent calls are required failure isolation, not unbounded fan-out: `completeSourceDeleteIntents` deliberately retains every marker in a failed input batch. Sum only each result's aggregate completed count for any internal summary; do not log or return resource-level outcomes. Process at most the one fetched page, even when successful cleanup removes rows and another page is immediately available.

Extend `processDatasetCacheCleanup` with a final/default limit parameter and pass it to `listDatasetCleanupJobs`; preserve the current optional account/name filters and default behavior for any non-periodic caller. Let the store retain limit validation.

The periodic path must not call `repairAtStartup`, `vectorRepairState`, `vectors.scanRows`, `restoreDatasets`, the all-users/tabular-sources query, or the distinct-account pending-delete query. Do not replace them with offset pagination: durable queue ordering provides progress, whereas offsets over rows being deleted/reordered can skip work. One tick processes at most one page from each queue; later ticks make further progress.

Keep the existing 60-second unref'd interval and stable, aggregate `STORAGE_RECONCILIATION_FAILED` warning. Do not include counts by resource, identifiers, paths, or caught exception details in logs.

**Verify**: inspect the timer and helper with `rg -n -A30 -B5 'runPeriodicStorageReconciliation|reconciliationTimer' server/src/ingest.ts` → the timer delegates to the bounded helper and contains no full-corpus call.

### Step 4: Put every background pump inside one lifecycle epoch

Replace the function-local `reconciling` boolean with a module-level
`reconciliationPump: Promise<void> | undefined`, and track the 15-second path
as `leaseRecoveryPump: Promise<void> | undefined`. Both helpers coalesce an
overlapping trigger and clear their own reference only from an identity-checked
`finally`, so an older completion cannot erase a later promise.

Introduce one monotonically increasing ingestion-worker lifecycle epoch. A
successful `startIngestionWorkers` publishes a fresh active epoch before its
initial wakes/timers. Every interval callback, pump body, inner drain loop,
repump decision, and internal wake captures that epoch and checks that it is
still active before beginning another store/data-service operation. Public
`wakeIngestionWorkers` and `wakeConnectorPrepareWorkers` are no-ops unless
workers are active. Work reserved while stopped is not lost: the next successful
start explicitly wakes both durable queues under its new epoch.

The lease-recovery promise must cover both `recoverExpiredIngestionLeases` and
`recoverPreparingConnectorLeases` plus the conditional wakes that follow. If
stop invalidates its epoch between either await, it finishes the already-started
call but performs no later recovery call or wake. Apply the same rule to
reconciliation and to the existing ingestion/prepare pumps: finish a currently
awaited operation, but do not claim/process another row or schedule a `finally`
repump after epoch invalidation.

`stopIngestionWorkers` must synchronously, before its first await:

1. mark workers stopped and invalidate the active epoch;
2. clear both unref'd timers; and
3. reset both repump flags so queued wakes cannot escape the old epoch.

Then repeatedly snapshot and `Promise.allSettled` the four owned promise slots
(`leaseRecoveryPump`, `reconciliationPump`, `ingestionPump`, and
`connectorPreparePump`) until none remains. The epoch gates make the loop
converge; the repeated identity-safe snapshot also covers a promise installed by
an already-queued microtask just before quiescence. Only after all four slots are
empty may stop clear `cachedEngine` and return to Plan 014's application owner.
A later start after stop settles gets a fresh epoch; a stale `finally` from an
old epoch cannot clear or repump the new one.

Do not add a force-close timeout here. The underlying vector, filesystem, and
dataset cleanup calls already own their processing limits; the Electron main
process remains the outer bounded termination authority.

**Verify**: `pnpm --filter borealis-server typecheck` → the epoch, four
tracked pumps, and start/stop contract compile with no unhandled promise.

### Step 5: Prove bounded work, no whole-store calls, and shutdown drainage

Extend `ingestRestore.test.ts` using its existing real temporary runtime and mocked `dataService` boundary. Import `runPeriodicStorageReconciliation` and add deterministic tests that:

1. spy on `vectorLifecycle.drainPendingVectorOperations`, `vectorLifecycle.repairAtStartup`, `vectors.scanRows`, `sources.listPendingSourceDeletesAcrossAccounts`, `ingestion.listDatasetCleanupJobs`, and `dataService.listDatasets`;
2. run one periodic reconciliation with empty queues;
3. assert the three bounded calls receive 100, 100, and 20 respectively; and
4. assert startup repair, Lance scanning, and dataset restoration/listing are never called.

Add queue-progress coverage with more pending source-delete intents than one page (the store test may establish ordering while this test stubs pages): consecutive runs must request fresh pages, never process more than 100 intents in one invocation, and must not issue a second page in the same invocation. In the same harness, place one permanently failing intent between successful intents. Prove the successful markers clear, the failed marker remains with Plan 011's retry state, and later/next-page work still progresses on subsequent invocations. Never weaken the ownership/missing-artifact proof to make the failure pass.

Exercise the startup callback separately with more than two 100-row TEMP
snapshot pages. Between pages, insert a new durable intent, delete one captured
future row, and fail one cleanup. Prove the frozen pass advances every captured
ordinal at most once, attempts every surviving captured intent, excludes the
new insert, retains the failed marker, terminates, and drops its TEMP table on
both success and a page-read/cleanup exception. A subsequent periodic page must
be able to observe the new/failed work.

For lifecycle ownership, use deferred promises and settled flags, never elapsed
time or real timer sleeps, to prove all of the following:

1. two periodic triggers in one epoch share one underlying reconciliation;
2. stop during deferred reconciliation remains unsettled until that call
   finishes, and a wake issued during stop creates no ingestion/prepare work;
3. stop while `recoverExpiredIngestionLeases` is deferred waits for the tracked
   lease-recovery pump; after release, the invalid old epoch prevents
   `recoverPreparingConnectorLeases` and both wake calls;
4. stop while one ingestion or prepare `processOne...` call is deferred lets
   that call finish but prevents the inner loop and `finally` from claiming or
   repumping another row;
5. all four pump references are empty before stop settles and no mocked store or
   data-service call begins afterward; and
6. a later explicit start uses a fresh epoch, drains work exactly once, and is
   not cleared or repumped by an old `finally`.

Expose only narrow package-internal test triggers for the lease/reconciliation
callbacks if fake timers cannot drive them deterministically. They must use the
same epoch-gated production helpers and must not be reachable through routes or
runtime dependencies.

Keep existing `restoreDatasets` tests unchanged to prove the full startup registry repair remains available and retains exact-location ownership checks.

**Verify**: run the Periodic reconciliation tests command → bounds,
no-full-scan, coalescing, tied-clock progress, four-pump epoch shutdown, and
restart assertions pass without leaked handles.

### Step 6: Run dependency, server, and repository gates

Run plans 011, 014, and 015's focused regressions, both focused commands above, server static checks, both server suites, and `pnpm verify`. Review all `repairAtStartup` references to ensure none is reachable from a timer or request path.

**Verify**: `rg -n 'setInterval|repairAtStartup|restoreDatasets' server/src/ingest.ts server/src/serverApp.ts` must show `repairAtStartup` only in the one-time worker startup section and `restoreDatasets` only at its definition/import and the retained server startup task, never in the periodic timer/helper. `git diff --check && git status --short` must show only the eight in-scope paths plus the permitted plan-index update.

## Test plan

- Integration: preserve the complete SQLite/LanceDB startup repair matrix under the explicit `repairAtStartup` name.
- Store integration: source-delete, vector-operation, and dataset-cleanup pages
  have hard limits, complete deterministic `attempts`-first ordering, and
  fixed-clock retry fairness while account-scoped source reads stay isolated.
- Startup source cleanup: one connection-local frozen identity snapshot is
  paged to exhaustion with bounded memory; concurrent insert/delete/failure
  cannot extend or pin it, while durable leftovers remain periodically
  retryable.
- Periodic runtime: each invocation drains at most 100 vector operations, 100 individually failure-isolated source-delete intents, and 20 dataset-cache cleanup jobs.
- Mixed source-cleanup page: one permanent failure retains its own marker while successful peers clear and later queued work progresses.
- Negative assertions: periodic work never calls full vector state/scan or full DuckDB registry restoration.
- Lifecycle: triggers coalesce within an epoch; shutdown invalidates wakes and
  repumps, drains lease recovery/reconciliation/ingestion/prepare until empty,
  and restart uses a fresh epoch before storage can close.
- Regression: plan 015 promotion races, full server unit/integration suites, and the repository gate remain green.

## Done criteria

- [ ] Whole-ledger/vector reconciliation has the startup-only `repairAtStartup` name and remains fully exercised.
- [ ] The 60-second path contains no full SQLite vector state, LanceDB row scan, all-account source scan, or DuckDB catalog restoration.
- [ ] One periodic invocation has hard global limits of 100 vector operations, 100 individually processed source deletions, and 20 dataset-cache cleanup jobs.
- [ ] Startup source deletion freezes one finite TEMP identity snapshot and
      attempts every surviving captured intent at most once; concurrent inserts
      wait for periodic repair, missing/failing rows cannot pin the cursor, and
      the TEMP table is always dropped.
- [ ] One failing source intent does not retain successful peer markers or prevent later pages from progressing.
- [ ] Failed source, vector, and dataset cleanup cannot starve untouched work,
      including when timestamps tie or move backward; all three queues sort by
      attempts before time and stable identity.
- [ ] This plan makes returned rows and downstream work bounded and explicitly
      records that selection scans remain backlog-dependent until Plan 020 adds
      the three exact v15 repair indexes; no stronger interim latency claim is
      documented.
- [ ] Full dataset restoration still runs at startup and ordinary activation/deactivation behavior is unchanged.
- [ ] `stopIngestionWorkers` invalidates the old epoch before awaiting and
      drains lease recovery, reconciliation, ingestion, and connector prepare
      until no owned promise remains; no wake, inner loop, or `finally` starts
      post-stop work.
- [ ] Restart after a settled stop publishes a fresh epoch unaffected by stale
      completions.
- [ ] Plans 011, 014, and 015 plus focused, full server, and repository gates pass.
- [ ] No file outside Scope is modified, except the permitted plan-index update.

## STOP conditions

Stop and report back instead of improvising if:

- Plan 011, 014, or 015 is not DONE/green; source-cleanup success semantics, owned shutdown ordering, and the final promotion/prune protocol are required predecessor contracts.
- Any supported steady-state source/vector/dataset mutation relies on the minute-cadence whole-store scan as its only correctness mechanism; identify that missing durable operation rather than silently removing recovery.
- The complete orphan-vector/generation/chunk sweep or unfinished-delete recovery would no longer run during startup.
- Any of the three retry queues lacks a monotonic attempts transition on failure,
  so `attempts`-first ordering cannot move failed work behind untouched rows; do
  not rely on wall-clock `updated_at` alone.
- Isolating a failed source intent would require passing a mixed page to the batch-all-or-nothing cleanup coordinator or weakening Plan 011's durable-marker semantics; stop and revise the boundary instead.
- Periodic correctness requires a persisted cursor/new schema, or startup
  completeness cannot be obtained from the one connection-local frozen TEMP
  snapshot described here. Do not substitute an offset or moving wall-clock
  query; any durable-schema alternative needs an explicitly migrated plan.
- Shutdown would close SQLite, LanceDB, or DuckDB before any of the four owned
  pump slots is empty, or a wake/inner loop/`finally` can begin work after epoch
  invalidation.
- A test would require logging or asserting resource identifiers, paths, content, URLs, SQL results, or provider errors outside the test process.
- A verification fails twice after one reasonable correction, or a required file is outside Scope.

## Maintenance notes

- Every new periodic reconciliation task needs both a hard per-invocation bound
  and an attempts-first durable ordering/progress mechanism that does not assume
  wall-clock monotonicity. Do not add a whole-workspace query to this timer.
- Preserve per-intent failure isolation when calling a batch-all-or-nothing coordinator. If cleanup later gains safe per-intent outcomes, update this loop and its mixed-success regression together.
- Keep startup repair comprehensive. Periodic bounded queues optimize steady state; they are not a substitute for cold-start two-store validation.
- The startup-delete snapshot is disposable control state, not the recovery
  record. Keep cleanup authority in `pending_source_deletes`, advance snapshot
  ordinals even across missing/failing rows, and drop the TEMP table in
  `finally`.
- Plan 020 must retain the exact attempts-first query shapes and create their
  matching v15 indexes before documentation claims backlog-independent periodic
  selection cost.
- If a new runtime mutation can leave recoverable cross-store work, record its durable intent at the authoritative SQLite commit boundary and drain it here in a bounded page.
- `restoreDatasets` is recovery, not a general catalog refresh primitive. Normal connector/upload activation must continue updating DuckDB through its exact-location workflow.
- Keep aggregate reconciliation logging content-free. Every newly added timer,
  wake path, or pump must capture the active epoch and join the drain-until-empty
  set in `stopIngestionWorkers`.

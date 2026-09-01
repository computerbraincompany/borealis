# Plan 014: Create an owned application runtime

> **Executor instructions**: Do not start until plans 004, 007, 008, 009, and
> 013 are DONE. Follow each step and verification gate. If a STOP condition
> occurs, stop and report; do not improvise a second service locator. When
> complete, update this plan's row in `advisor-plans/README.md` unless the
> reviewer owns index maintenance.
>
> **Drift check (run first, after dependencies)**:
> `git diff --stat f1b9293..HEAD -- server/src/applicationRuntime.ts server/src/automationRuntime.ts server/src/db.ts server/src/serverApp.ts server/src/routes.ts server/src/routes/automations.ts server/src/contained/runtime.ts server/src/contained/downloadManager.ts server/src/tests/agentVerticalIntegration.test.ts server/src/tests/applicationRuntime.test.ts server/src/tests/connectorRoutes.test.ts server/src/tests/modelRoutes.test.ts server/src/tests/preferencesRoutes.test.ts server/src/tests/serverApp.test.ts server/src/tests/sourceManagementRoutes.test.ts server/src/tests/automations.test.ts server/src/tests/vitestTestPartitions.ts`
> Plans 004, 007, 008, 009, and 013 intentionally change integration coverage,
> route composition, contained-download lifecycle, static-shell CSP, lifecycle
> tests, and runner shutdown. Reconcile those contracts first. If plan 007's
> desktop-operator route option, plan 008's synchronous download quiesce/drain,
> plan 009's direct/fallback shell CSP, plan 013's awaitable stop contract, or
> plan 001's test-partition manifest contract is absent, STOP.
> Plans 024–026 and 031–037 subsequently added durable connector cleanup,
> authoritative automation outcomes, early authentication/body limits, paged
> catalogs, Electron/runtime hardening, lazy offline chunks, model
> qualification, embedding migration, OCR child work, and the exact workspace
> lock/archive boundary. Compose those live owners into the application runtime;
> do not recreate globals, bypass their quiescence, or treat their expected
> route/startup/shutdown changes as STOP drift.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: MED
- **Depends on**: `advisor-plans/004-add-vertical-agent-integration-test.md`, `advisor-plans/007-restrict-contained-engine-control.md`, `advisor-plans/008-harden-contained-download-transport.md`, `advisor-plans/009-eliminate-unsolicited-ui-egress.md`, `advisor-plans/013-drain-automation-scheduler-on-shutdown.md`
- **Preserve completed baseline**: Plans 024–026 and 031–037
- **Category**: tech-debt
- **Planned at**: commit `f1b9293`, 2026-08-30

## Why this matters

Storage has a resettable singleton, while automation has a separate permanent
singleton created from whichever ledger happens to be active first. Closing and
restarting a server in the same process therefore reuses a runner/store bound to
the closed first ledger. Worse, two overlapping factories can currently reuse
the same settings/storage singleton and each believe it owns closure. A
per-start application runtime should hold an exact process-wide ownership lease,
own the storage instance, automation runner, settings lifecycle, contained
engine, and download drain, and inject scheduler state into routes. One owner can
then start, quiesce, drain, and dispose those resources exactly once.

## Current state

- `server/src/storageRuntime.ts:38-40` keeps process-global storage state, but `closeStorageRuntime` clears it before closing (`server/src/storageRuntime.ts:116-123`):

  ```ts
  let active: StorageRuntime | undefined;
  let initializing: Promise<StorageRuntime> | undefined;
  // ...
  export async function closeStorageRuntime(): Promise<void> {
    if (initializing) await initializing.catch(() => {});
    const runtime = active;
    if (!runtime) return;
    active = undefined;
    await runtime.vectors.close();
    await runtime.ledger.close();
  }
  ```

- `server/src/automationRuntime.ts:12-30` has a second cache with no reset and constructs two store facade objects over the first active ledger:

  ```ts
  let runtime:
    | {
        store: AutomationStore;
        runner: ReturnType<typeof createAutomationRunner>;
      }
    | undefined;

  function automationRuntime() {
    runtime ??= {
      store: new AutomationStore(storageRuntime().ledger),
      runner: createAutomationRunner({
        store: new AutomationStore(storageRuntime().ledger),
        syncConnector: (accountId, connectorId) =>
          syncConnector(accountId, undefined, connectorId),
      }),
    };
    return runtime;
  }
  ```

  After `closeStorageRuntime()` and a later in-process initialization, `automationRunner()` still references the closed original ledger.

- `server/src/db.ts:5-20` is a thin lifecycle wrapper around global storage. It also owns stopping the contained engine before storage close:

  ```ts
  export async function initDb(): Promise<void> {
    await initializeStorageRuntime({
      sqlitePath: config.sqlitePath,
      lanceDirectory: config.lanceDir,
      embeddingDimension: config.embeddingDim,
    });
  }

  export async function closeDb(): Promise<void> {
    await engineManager.stop().catch(() => undefined);
    await closeStorageRuntime();
  }
  ```

- `server/src/serverApp.ts:143-195` separately tracks settings, database, workers, and scheduler booleans, retrieves the global runner repeatedly, and manually duplicates normal-close/startup-failure cleanup. Plan 013 will make runner stop awaitable, but it intentionally does not change ownership.

- `server/src/routes/automations.ts:151-155` reads scheduler status through the hidden global accessor:

  ```ts
  app.get(
    "/api/automations/_scheduler",
    { preHandler: requireAuth },
    async (_req, reply) => {
      return reply.send({ running: automationRunner().isRunning() });
    },
  );
  ```

  `server/src/routes.ts:24-58` composes route plugins without dependencies, so the route cannot identify the runner belonging to the server instance.

- `server/src/tests/serverApp.test.ts:8-38` mocks global lifecycle functions. Add owner-oriented lifecycle assertions there. Dependency plan 004 supplies the vertical agent integration characterization that must pass unchanged after composition moves.

- Dependency plan 007 establishes an explicit desktop-operator route option in `server/src/routes.ts` and `server/src/serverApp.ts`; the new scheduler dependency must compose with, not replace or widen, that option. Dependency plan 009 attaches the production-shell CSP to both direct and fallback HTML responses in `serverApp.ts`; lifecycle refactoring must preserve those exact response headers and regression tests.

- After plan 001, real SQLite/Lance tests are registered centrally in `server/src/tests/vitestTestPartitions.ts` and run only through `vitest.integration.config.ts`. The new actual-storage runtime test belongs in that integration partition exactly once; mocked server/automation lifecycle tests remain in the default unit partition.

- `storageRuntime()` is imported broadly by route and domain modules. Replacing all store access with constructor injection is not required for this plan; the high-leverage boundary is one explicit owner for initialization, runner construction, and disposal.
- Dependency plan 008 gives the process-wide `downloadManager` synchronous
  admission closure plus awaitable `quiesceAndDrain()` and a sequential
  `beginLifecycle()`. Without composing those methods here, a 24-hour request,
  response reader, writer, or file handle can outlive server close and the
  desktop host's `stopped` acknowledgement.
- `initializeRuntimeSettings()` and `initializeStorageRuntime()` intentionally
  reuse compatible active singletons. Therefore checking ownership only after
  either `await` is too late: two concurrent `createApplicationRuntime()` calls
  could both build runners over one ledger, and either close could tear down the
  other. The application owner needs a private synchronous lease around the
  complete construction-through-close lifetime.

## Commands you will need

| Purpose                       | Command                                                                                                                          | Expected on success                                                        |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Actual-storage runtime test   | `pnpm --filter borealis-server exec vitest run --config vitest.integration.config.ts src/tests/applicationRuntime.test.ts`       | all restart/ownership cases pass                                           |
| Mocked lifecycle tests        | `pnpm --filter borealis-server exec vitest run src/tests/serverApp.test.ts src/tests/automations.test.ts`                        | all server/route lifecycle cases pass                                      |
| Partition contract test       | `pnpm --filter borealis-server exec vitest run src/tests/vitestPartitions.test.ts`                                               | runtime test is integration-only and every tracked test is classified once |
| Download lifecycle regression | `pnpm --filter borealis-server exec vitest run src/tests/contained.test.ts`                                                      | plan 008's atomic reservation and quiesce/drain contract passes unchanged  |
| Vertical agent regression     | `pnpm --filter borealis-server exec vitest run --config vitest.integration.config.ts src/tests/agentVerticalIntegration.test.ts` | the dependency's complete chat-turn test passes unchanged                  |
| Server typecheck              | `pnpm --filter borealis-server typecheck`                                                                                        | exit 0, no errors                                                          |
| Server lint/format            | `pnpm --filter borealis-server lint && pnpm --filter borealis-server format:check`                                               | exit 0, no warnings                                                        |
| Server integration            | `pnpm --filter borealis-server test:integration`                                                                                 | all integration tests pass                                                 |
| Full repository gate          | `pnpm verify`                                                                                                                    | exit 0 and prints `ALL GATES GREEN` on a provisioned supported host        |

## Scope

**In scope** (the only source/test files to modify, create, or delete):

- `server/src/applicationRuntime.ts` (create)
- `server/src/automationRuntime.ts` (delete)
- `server/src/db.ts` (delete after its responsibilities move)
- `server/src/serverApp.ts`
- `server/src/routes.ts`
- `server/src/routes/automations.ts`
- `server/src/tests/applicationRuntime.test.ts` (create)
- `server/src/tests/agentVerticalIntegration.test.ts`
- `server/src/tests/connectorRoutes.test.ts`
- `server/src/tests/modelRoutes.test.ts`
- `server/src/tests/preferencesRoutes.test.ts`
- `server/src/tests/serverApp.test.ts`
- `server/src/tests/sourceManagementRoutes.test.ts`
- `server/src/tests/automations.test.ts`
- `server/src/tests/vitestTestPartitions.ts`

**Out of scope** (do not touch):

- Replacing every `storageRuntime()` call across route/domain modules. That is a much larger dependency-injection migration and is not necessary to fix stale automation ownership.
- `server/src/storageRuntime.ts` instance composition, SQLite/LanceDB division, or any store facade API.
- Automation execution/business semantics, ingestion worker implementation, DuckDB catalog policy, report rendering, or Electron main-process shutdown timeout.
- Plan 007's desktop-operator authorization boundary, plan 008's download-manager
  implementation, and plan 009's static-shell CSP content/application points.
  Consume their public/internal lifecycle contracts without redesigning them.
- Adding a second global `setApplicationRuntime`/`applicationRuntime()` accessor. The runner must be passed from the owner into the route tree.
- Changing server public APIs except that the existing scheduler-status route now observes its injected runner.

## Git workflow

- Branch: `codex/014-create-owned-application-runtime`
- Suggested commits:
  1. `test(server): characterize application runtime ownership`
  2. `refactor(server): own application runtime lifecycle`
- Use conventional commits. Do not push or open a PR without explicit instruction.

## Steps

### Step 1: Define the application runtime ownership contract

Create `server/src/applicationRuntime.ts`. Export an `ApplicationRuntime`
interface and `createApplicationRuntime` factory with a testable options seam.
The owned object must expose:

- the exact `StorageRuntime` returned by `initializeStorageRuntime`;
- exactly one `AutomationRunner`, built with `storage.automations` (do not instantiate a duplicate `AutomationStore`);
- `startAutomationScheduler(): void`;
- `stopAutomationScheduler(): Promise<void>` using plan 013's immediate-quiesce/drain contract;
- `quiesceDownloads(): Promise<void>` delegating to plan 008's manager-wide
  immediate-admission-close/drain contract; and
- idempotent
  `close({ externalStorageConsumersDrained: boolean }): Promise<void>`. The
  required proof is internal lifecycle state supplied only by server
  orchestration; it is not an HTTP/request option.

Before the factory reaches its first `await`, reserve a module-private exact
owner token and set a private phase (`constructing`, later `active` or
`closing`). If any token already owns any phase, reject the second factory with
a stable internal lifecycle error before invoking settings initialization,
storage initialization, download lifecycle, runner construction, or any cleanup
seam. This lease is an ownership lock only: do not export it, expose an accessor,
or store services on it. Every phase transition and release compares exact
token identity. Release only in that attempt's construction-failure unwind or
its `close()` finalizer; never clear another token.

After acquiring the lease, call plan 008's `downloadManager.beginLifecycle()`
before resource construction. Production defaults then initialize runtime
settings and execute Plan 035's exact startup sequence: construct the owned
embedding-migration coordinator, recover any journaled swap before storage
opens, initialize SQLite/Lance from the effective resolved embedding model and
dimension with marker/receipt validation, then finalize or roll back the swap
through the existing fail-closed paths. Only then construct the runner with the
existing `syncConnector(accountId, undefined, connectorId)` adapter. Never
replace that sequence with the old raw `config.embeddingDim` open. The options
seam may accept explicit storage paths, sync adapter, download/migration
lifecycle, and settings/storage/engine lifecycle functions for tests, but must
not be exposed through HTTP.

`close(proof)` must synchronously enter `closing`, capture/cache its one close
promise, quiesce/drain the owned runner and download manager, stop the contained
engine, close the embedding-migration coordinator and paired storage runtime,
and close runtime settings. The download and migration drains must settle before
engine/settings/storage closure completes.
Attempt every later cleanup phase that is independent and safe even when an
earlier phase rejects; collect only stable/content-free failures and reject with
the first or an aggregate afterward. Never close settings/storage while a
scheduler, engine health/apply, or other consumer that can touch them is not
proven drained; record those prerequisite closures as deliberately skipped and
therefore still owned. Track which exact resources this attempt acquired and
mark each released only after its drain/stop/close reports success.

Treat cleanup as an explicit dependency graph. Scheduler, download, migration,
and engine drains are independent owned phases and use all-settled/attempt-all
semantics. Settings and storage may close only when all four owned phases
succeeded **and**
the caller supplied `externalStorageConsumersDrained: true`. If that proof is
false, still attempt every independent owned drain, deliberately skip
settings/storage, reject close, and poison/retain the lease. A failed storage
close does not prevent an otherwise-safe settings close after every consumer
and engine is proven stopped, but either failure prevents lease release. Cache
this result so repeated close calls cannot retry skipped work under a stale
proof or close a later owner.

If construction fails after beginning the download lifecycle or opening
settings/storage, use the same attempt-all unwind for only what this exact token
acquired, then rethrow the construction error together with any safe cleanup
failure. Retain the resolved/rejected close promise on the returned runtime so
repeated or stale calls perform no new work and cannot close a later runtime.
Release the exact lease only when **every acquired resource is positively proven
drained/stopped/closed**. Merely reaching a `finally` or observing rejected
cleanup promises is not proof. If any scheduler, download, migration, engine,
storage, or settings ownership remains uncertain, transition the exact lease to terminal
`poisoned`, retain it for the process lifetime, reject close/unwind, and make all
future factories fail before side effects. This deliberately sacrifices
same-process restart rather than overlap a possibly live child, handle, or
ledger.

Invocation of `initializeRuntimeSettings()` or `initializeStorageRuntime()` is
an acquisition boundary. If either rejects without a typed result proving that
it acquired nothing or fully unwound every opened resource, treat ownership as
uncertain and poison the lease after attempting only independently safe drains.
In particular, never infer from an opaque storage-initialization rejection that
SQLite/LanceDB were not opened: the current initializer can reject after native
open work and hide cleanup failures. Do not release the lease in that case.

The application continues to support only one active or constructing runtime
per process; do not add multi-runtime concurrency. Sequential restart begins a
new download lifecycle only after the prior exact owner has fully drained and
released its lease.

**Verify**: `pnpm --filter borealis-server typecheck` → the new module compiles before callers are switched.

### Step 2: Characterize same-process restart and idempotent ownership

Create `server/src/tests/applicationRuntime.test.ts` using two distinct temporary
SQLite/Lance directories and injected connector-sync, download-lifecycle,
settings, and engine seams. Test:

1. hold runtime A's construction after its synchronous lease; an overlapping B
   factory rejects before calling **any** B initialize/begin/close seam;
2. after A becomes active, another overlapping create still rejects, A remains
   usable, and the rejected attempt stops/closes nothing belonging to A;
3. runtime A's runner and `storage.automations` share A's exact ledger;
4. starting then stopping uses plan 013's runner contract;
5. with an active deferred download,
   `close({ externalStorageConsumersDrained: true })` closes admission immediately but
   remains unsettled; settings/storage/lease release remain untouched until the
   download run/writer/handle drain settles;
6. calling `close({ externalStorageConsumersDrained: true })` twice joins one
   close, closes A once, and clears active
   storage only after all drains;
7. runtime B can then open at a different path, begin a fresh download
   lifecycle, and create/read automation state without touching A's closed
   ledger;
8. closing already-closed A again cannot stop a B download, close B, or release
   B's exact lease; and
9. an injected runner-construction failure after settings/storage return
   successfully drains only its begun download lifecycle, closes only those
   positively acquired resources, releases its token, and permits a later clean
   factory;
10. inject a rejection independently from scheduler drain, download drain,
    embedding-migration drain, engine stop, storage close, and settings close.
    Prove that independent later
    phases are still attempted while prerequisite-owned
    settings/storage closure is skipped when unsafe; close/unwind rejects without
    a graceful stopped signal, the lease remains `poisoned`, and every later
    factory rejects before initialization; and
11. distinguish a construction failure whose complete unwind succeeds (lease
    releases) from one whose unwind cannot prove closure (lease poisons); and
12. make `initializeStorageRuntime` reject after invocation without a typed
    no-acquisition/full-unwind proof; assert independent download/settings
    cleanup is attempted only where safe, the lease poisons, and a later factory
    fails before side effects. Cover the analogous opaque settings-init seam or
    document its typed positive proof; and
13. exercise Plan 035's pending-swap recovery/finalization/rollback order and
    prove no store opens before migration recovery, no later runtime inherits
    the prior coordinator, and marker/receipt/model/dimension validation is not
    bypassed.

The overlap and stale-owner identity cases are load-bearing. If current
`closeStorageRuntime()` cannot guarantee them once the exact lease serializes
construction/close, STOP and report rather than weakening the tests or modifying
it outside Scope; the plan must be revised to include an identity-checked storage
close.

Register `src/tests/applicationRuntime.test.ts` exactly once in the integration-only inventory in `server/src/tests/vitestTestPartitions.ts`; do not add it to the default unit list. Preserve the manifest's sorting and exhaustive-inventory rules from plan 001.

**Verify**: `pnpm --filter borealis-server exec vitest run --config vitest.integration.config.ts src/tests/applicationRuntime.test.ts` → all ownership/restart cases pass without leaked handles. Run `pnpm --filter borealis-server exec vitest run src/tests/vitestPartitions.test.ts` → the file is classified exactly once and only as integration.

### Step 3: Inject the owned runner into route composition

Export the final `RoutesOptions` type from `server/src/routes.ts` and extend the
post-plan-007 typed route options with the scheduler status dependency (prefer
the narrow `Pick<AutomationRunner, "isRunning">` capability). Preserve plan
007's desktop-operator capability and fail-closed production wiring; do not
replace the whole options object or make that authorization option optional
merely to ease tests. `startBorealisServer` will pass both the owned runner and
the existing operator capability. Direct route/unit composition may pass an
explicit stopped test runner/status function; do not fall back to a module-
global accessor. Plan 022's source-only exporter compiles an explicit object
with `satisfies RoutesOptions`, so keep this type free of runtime-owner
construction.

Preserve Plan 026's `onRequest` authentication and route-owned body limits,
Plan 031's paged catalog registrations, and Plans 034/035's qualification and
embedding-migration route factories. If route composition needs dependencies
for source-only tests, expose only narrow typed Settings, qualification, and
migration-status capabilities through `RoutesOptions`; production passes the
owned runtime's exact instances, and no default may construct another provider,
coordinator, store, or worker during route registration.

Update every in-scope direct `routes(...)` registration, including Plan 004's
vertical integration test, to supply both explicit capabilities. The vertical
test remains browser mode with a stopped scheduler stub; its end-to-end turn
assertions and real production layers remain unchanged.

Update `/api/automations/_scheduler` to read only the injected object. Add/adjust `automations.test.ts` to prove a supplied running/stopped value is reflected and that no storage initialization implicitly constructs another runner.

Delete `server/src/automationRuntime.ts` once `rg` shows no imports remain.

**Verify**: `rg -n 'automationRuntime|automationRunner\(\)|automationStore\(\)' server/src --glob '*.ts'` → no module-global accessor imports/calls remain; then run the automation test file.

### Step 4: Make server startup own one runtime instance

Refactor `startBorealisServer` to create one local `ApplicationRuntime` after
desktop binding/static-directory validation and before building resource routes.
Acquire Plan 037's exact cross-process workspace lock before runtime
construction and retain it outside the in-process runtime lease; release it only
after every runtime/external consumer is positively closed, or after a complete
construction unwind. Never release it on a poisoned or uncertain close. The two
locks solve different scopes and neither replaces the other.
Pass it into `buildBorealisApp`/`routes` alongside plan 007's desktop-operator
route option, recover state and start workers against its activated storage, and
call `runtime.startAutomationScheduler()` exactly once. A rejected overlapping
factory is a startup failure for only that attempted server and must not invoke
cleanup against the already-running owner. Preserve plan 009's single
production-shell CSP on both direct static HTML and SPA fallback paths;
ownership refactoring must not move, omit, or weaken either attachment.
It must also keep Plan 033's copied hashed lazy/chart assets and manifest check
served from that exact origin.

On normal close, invoke both `runtime.stopAutomationScheduler()` and
`runtime.quiesceDownloads()` synchronously before the close path's first await,
then close HTTP and abort active chat runs. Start every independent external
drain and record its positive result as detailed below; do not express teardown
as a straight-line await chain. On startup failure after runtime ownership
begins, perform the same synchronous admission closure and attempt-all
quiesce/cancel/drain before the proof-bearing runtime close. No
`RunningBorealisServer.close()` resolution or desktop `stopped` acknowledgement
may precede the download drain. Preserve idempotent server close.

Move the contained-engine stop and settings/storage close responsibilities out of `db.ts` into the owner and delete `server/src/db.ts` after no imports remain. Remove the parallel `databaseStarted`, `settingsStarted`, and `automationSchedulerStarted` ownership flags where the runtime/close promise now makes them redundant; keep only flags for external worker phases that actually started.

Implement that prose with proof-carrying orchestration rather than a
short-circuiting promise chain. After synchronously closing scheduler/download
admission, use `Promise.allSettled`/`try`-`finally` to record positive drain
results for HTTP plus active chat runs, ingestion workers (including any exact
Plan 036 OCR helper child), startup dataset reconciliation, and the
DuckDB/dataset worker. Attempt every independent stop
even when a peer rejects. Always invoke
`runtime.close({ externalStorageConsumersDrained })` after those attempts, with
the flag true only if **every** external storage consumer positively stopped.
The runtime still attempts its owned scheduler/download/engine drains when the
flag is false, but it must leave settings/storage open and poison ownership.
Aggregate stable content-free failures, reject server close/startup unwind, and
withhold graceful `stopped` acknowledgement on any failed/unproven phase. Never
swallow a worker failure and then close storage beneath it.

`buildBorealisApp` may keep the runner option optional only for isolated static-host tests, in which case the scheduler route must receive an explicit stopped capability. Production `startBorealisServer` must always pass the owned runtime.

**Verify**: `pnpm --filter borealis-server exec vitest run src/tests/serverApp.test.ts` → binding guards, desktop-operator routing, direct/fallback static-shell CSP, normal close, overlapping-create isolation, download drainage, and all partial-startup cleanup cases pass.

### Step 5: Add a full sequential server-start regression

In `serverApp.test.ts`, extend the lifecycle mocks/factory so two sequential `startBorealisServer({ host: "127.0.0.1", port: 0 })` calls can be started and closed in one process. Return a fresh runtime/runner for each start and assert:

- runtime A is the only object passed to app A's scheduler route and close path;
- A synchronously quiesces scheduler/download admission, drains both, and closes
  before runtime B is created;
- B starts its own runner and closes it once;
- no method on A is invoked during B's lifecycle;
- a mocked download held active during A close keeps close unresolved and keeps
  settings/storage closure plus the stopped acknowledgement uncalled until its
  exact drain releases;
- an OCR-backed ingestion held in the local helper keeps close unresolved until
  the exact helper exits or is killed by its owned abort path;
- a migration build/apply held active keeps close unresolved, retains the
  workspace lock, and prevents storage/settings closure until the coordinator
  drains;
- partial startup failure closes only the runtime created for that attempt.

Add separate ingestion-drain and DuckDB/dataset-worker-drain rejection cases.
In each case prove all other safe stops and
`runtime.close({ externalStorageConsumersDrained: false })` are attempted,
settings/storage closure and lease release never occur, close rejects, and no
graceful stopped acknowledgement is emitted.

Keep the actual-storage restart proof in `applicationRuntime.test.ts`; this test covers orchestration identity.

**Verify**: run both the Actual-storage runtime test and Mocked lifecycle tests commands → all pass in their intended partitions.

### Step 6: Run vertical, integration, and repository gates

Run dependency plan 008's contained-download tests, plan 004's exact vertical
test, all server checks, server integration suite, and `pnpm verify`. Search for
the deleted wrappers and duplicate store construction.

**Verify**: `rg -n 'new AutomationStore\(storageRuntime\(\)\.ledger\)|from "\./db\.js"|from "\./automationRuntime\.js"|from "\.\./automationRuntime\.js"' server/src --glob '*.ts'` → no output and exit 1. `git diff --check && git status --short` must show only the in-scope paths (including creates/deletes) plus the permitted plan-index update.

## Test plan

- New actual-storage test for synchronous lease acquisition, rejected
  overlapping construction with zero side effects, close-twice, restart at a
  different path, construction-failure lease release, stale-ledger isolation,
  and old-owner cannot close/release new-owner.
- Failure-injection matrix proves cleanup attempts every safe later phase,
  releases only after positive closure, and permanently poisons construction
  when any exact resource remains uncertain.
- Deferred-download test proves shutdown closes admission and cannot close
  settings/storage or acknowledge stopped until setup/request/writer/handle/run
  ownership has drained; sequential restart begins a fresh manager lifecycle.
- Partition regression proves that actual-storage test is included only by `test:integration`; server/automation mocks continue running in the default suite.
- Route test for injected scheduler status with no hidden runtime construction.
- Server orchestration test for two sequential starts and cleanup of only the local runtime.
- Startup/shutdown regression for the cross-process workspace lock, managed
  embedding migration recovery/coordinator ownership, lazy static runtime, and
  an OCR-backed ingestion drain.
- Preserve plan 013's active tick drain and partial-listen-failure tests.
- Preserve plan 008's atomic filename reservation and manager quiesce/drain tests.
- Preserve plan 007's desktop-operator route tests and plan 009's direct/fallback CSP/static-host tests.
- Run plan 004's vertical accepted-turn → agent → persistence characterization unchanged.
- Run server integration plus complete repository gate because lifecycle imports reach desktop host and native storage closure.

## Done criteria

- [ ] Each `startBorealisServer` call creates exactly one owned `ApplicationRuntime` and runner over that runtime's `storage.automations`.
- [ ] A private exact-owner lease is reserved before the factory's first await;
      overlapping construction rejects with zero initialization/cleanup side
      effects and cannot disrupt the active runtime.
- [ ] `automationRuntime.ts` and `db.ts` are deleted with no remaining imports.
- [ ] Scheduler status is injected through route composition; no application-runtime global is introduced.
- [ ] Normal close and startup failure synchronously close scheduler/download
      admission and drain both before closing engine, settings, or stores.
- [ ] No contained request/reader/writer/handle/run outlives close or the desktop
      stopped acknowledgement.
- [ ] Runtime close is idempotent, and a stale owner cannot close or release a
      later runtime.
- [ ] Plan 035's migration coordinator/recovery and model/dimension identity are
      owned and drained exactly once; Plan 037's workspace lock encloses the
      whole runtime and is released last only after proven closure.
- [ ] Plan 036 OCR children remain owned by ingestion cancellation/drain, and
      Plan 033 lazy/chart assets remain served offline from the exact origin.
- [ ] Cleanup attempts all safe phases and releases the lease only after every
      acquired resource proves closure; any uncertain failure retains a poisoned
      lease and prevents same-process restart/graceful-stopped success.
- [ ] Opaque settings/storage initialization rejection is treated as uncertain
      acquisition and poisons ownership unless a typed no-acquisition or full-
      unwind proof exists.
- [ ] Ingestion, startup-reconciliation, chat/HTTP, or DuckDB drain failure still
      attempts independent owned cleanup but passes a false external-consumer
      proof, leaves settings/storage owned and open, rejects close, and withholds
      graceful stopped acknowledgment.
- [ ] Two sequential in-process server lifecycles use distinct runtime/runner objects.
- [ ] `applicationRuntime.test.ts` appears exactly once in the integration partition and never in the default test suite.
- [ ] Plan 007 desktop-operator authorization, plan 008 download ownership/drain,
      and plan 009 static-shell CSP behavior pass unchanged.
- [ ] Plan 004 vertical test, plans 008/013 drain tests, server unit/integration
      tests, and `pnpm verify` pass.
- [ ] No file outside Scope is modified, except the permitted plan-index update.

## STOP conditions

Stop and report back instead of improvising if:

- Any dependency is not DONE/green: plan 004's vertical test, plan 007's
  desktop-operator route contract, plan 008's atomic reservation plus manager
  quiesce/drain contract, plan 009's direct/fallback shell CSP, or plan 013's
  awaitable runner stop/drain contract.
- `server/src/tests/vitestTestPartitions.ts` no longer has plan 001's exhaustive integration-only classification mechanism, or registering the actual-storage test would make it run in both suites.
- Preventing runtime A from closing runtime B requires changing `server/src/storageRuntime.ts`; report this identity gap so Scope can be explicitly revised.
- A supported use case requires two concurrently active storage runtimes in one process. This plan supports sequential restart only.
- An exclusive owner token cannot be reserved synchronously before settings,
  storage, or download-lifecycle work, or a rejected factory would need to clean
  up resources belonging to another owner.
- Cleanup rejection cannot preserve exact acquired/released facts, attempt all
  later safe phases, and retain a process-lifetime poisoned lease when ownership
  is uncertain.
- Server shutdown cannot positively prove every external storage consumer
  drained, pass that proof into the runtime, and withhold storage closure plus
  graceful stop when ingestion/reconciliation/DuckDB/chat teardown rejects.
- Plan 008's process-wide manager cannot reject admission synchronously and join
  every active download before settings/storage close or stopped acknowledgement.
- Route injection would require a new mutable global or Fastify decoration shared across unrelated app instances.
- Cleanup ordering would close SQLite/LanceDB before scheduler, active chat runs, ingestion, or DuckDB work finishes.
- The change expands into injecting storage through every route/domain module or changing public API behavior.
- A verification fails twice after one reasonable correction, or a required file is outside Scope.

## Maintenance notes

- New process-lifetime services should be constructed by `ApplicationRuntime` or explicitly owned by the server close path; do not add another lazy module singleton.
- The module-private ownership token is a lock, not a service locator. Keep it
  unexported, exact-identity checked, and held from pre-await construction through
  the last close finalizer.
- A failed cleanup is not lease release. Poison and retain the token unless all
  exact resources positively reported closed; desktop graceful-stop signaling
  must remain withheld on rejection.
- The route tree should receive narrow capabilities, not a mutable bag of global services.
- When later adding route dependencies, extend the plan-007 options type without weakening its desktop-only authorization boundary; keep plan 009's shell CSP independent from service lifecycle ownership.
- Reviewers should pay special attention to identity on repeated close and partial construction, not only the happy-path startup.
- Treat download quiescence as part of application ownership. New background
  work needs the same synchronous admission-close plus awaitable drain contract
  before process shutdown is acknowledged.
- Full storage dependency injection remains intentionally deferred. If pursued later, use this owner as the composition root and keep plan 004's vertical test as the safety net.

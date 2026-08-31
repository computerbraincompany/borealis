# Plan 013: Drain the automation scheduler before storage shutdown

> **Executor instructions**: Do not start until plan 006 is DONE. Follow the plan in order and run every verification gate. If a STOP condition occurs, stop and report; do not improvise. When complete, update this plan's row in `advisor-plans/README.md` unless a reviewer owns index maintenance.
>
> **Drift check (run first)**: `git diff --stat f1b9293..HEAD -- server/src/automationRunner.ts server/src/serverApp.ts server/src/tests/automations.test.ts server/src/tests/serverApp.test.ts`
> Compare live scheduler and shutdown ordering with the Current state excerpts. A changed lifecycle API is a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: `advisor-plans/006-bind-egress-consent-to-provider-revision.md`
- **Category**: bug
- **Planned at**: commit `f1b9293`, 2026-08-30

## Why this matters

Stopping the scheduler currently clears only its interval. An already-running tick can continue reading/writing SQLite, syncing a connector, or finishing an agent turn after server shutdown closes its stores. The startup error path is worse: once the runner starts, a later listen/bootstrap failure never stops it at all. Making stop quiesce immediately and return a drain promise, then ordering cancellation/drain before database close, removes both races while retaining the deliberately unref'd scheduler.

## Current state

- `server/src/automationRunner.ts:29-34` tracks only a timer and boolean:

  ```ts
  const store = dependencies.store;
  const now = dependencies.now ?? (() => new Date());
  let timer: NodeJS.Timeout | undefined;
  let ticking = false;
  ```

- `tick` skips a concurrent call but does not expose the active promise (`server/src/automationRunner.ts:123-147`):

  ```ts
  async function tick(): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
      const claims = await store.claimDue(now());
      // ...execute claims serially...
    } catch {
      // The tick is best-effort; the next interval retries.
    } finally {
      ticking = false;
    }
  }
  ```

- `stop` clears only future interval callbacks (`server/src/automationRunner.ts:149-160`):

  ```ts
  function stop(): void {
    if (timer) clearInterval(timer);
    timer = undefined;
  }

  return { start, stop, tick, isRunning: () => timer !== undefined };
  ```

- Normal server close stops automation only after HTTP and ingestion shutdown and does not await it (`server/src/serverApp.ts:169-184`):

  ```ts
  await closeHttpAfterDrainingRuns(activeApp);
  await stopIngestionWorkers().catch(() => {});
  if (automationSchedulerStarted) {
    automationRunner().stop();
    automationSchedulerStarted = false;
  }
  // ...
  await closeDb();
  ```

- The startup catch at `server/src/serverApp.ts:189-195` closes the app, workers, dataset worker, DB, and settings but never checks `automationSchedulerStarted`. `automationRunner().start()` happens before desktop bootstrap and `app.listen` at `server/src/serverApp.ts:158-161`, so either later operation can strand the timer or an active tick.

- Agent automations register an `AbortController` through `beginRun` at
  `server/src/automationRunner.ts:100`; `closeHttpAfterDrainingRuns` already
  calls `shutdownActiveRuns` repeatedly at `server/src/serverApp.ts:113-130`.
  A single final cancellation snapshot is insufficient: a claim already inside
  `acceptChatTurn` can call `beginRun` after that snapshot and then wait on a
  long model run. Shutdown must quiesce new claim dispatch first and continue
  cancelling while both HTTP requests and the scheduler drain, leaving no
  controller-registration gap before storage close.

- `server/src/tests/automations.test.ts:253-300` is the existing runner construction/execution exemplar. `server/src/tests/serverApp.test.ts:8-38` uses hoisted lifecycle mocks and is the correct place to prove close/failure ordering.

- Dependency plan 006 adds last-mile provider-revision consent plumbing to automation execution. Preserve its postcondition and test coverage when changing tick/stop state; shutdown must not bypass or reorder the consent decision.

- `AGENTS.md:235-238` requires the automation scheduler to be unref'd and stopped during orderly shutdown. Keep both properties.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Focused lifecycle tests | `pnpm --filter borealis-server exec vitest run src/tests/automations.test.ts src/tests/serverApp.test.ts` | all scheduler/server lifecycle tests pass |
| Server typecheck | `pnpm --filter borealis-server typecheck` | exit 0, no errors |
| Server lint/format | `pnpm --filter borealis-server lint && pnpm --filter borealis-server format:check` | exit 0, no warnings |
| Full server tests | `pnpm --filter borealis-server test` | all tests pass |
| Final repository gate | `pnpm verify` | exit 0 and prints `ALL GATES GREEN` on a provisioned supported host |

## Scope

**In scope** (the only source/test files to modify):

- `server/src/automationRunner.ts`
- `server/src/serverApp.ts`
- `server/src/tests/automations.test.ts`
- `server/src/tests/serverApp.test.ts`

**Out of scope** (do not touch):

- `server/src/automationRuntime.ts`; plan 014 replaces its ownership model after this drain contract exists.
- Automation target schema/ownership (plan 012), execution semantics, schedule interval, claim limit, outcome wording, consent, or five-failure pause policy.
- Adding unbounded force-kill behavior inside the runner. The Electron main process already supplies the outer bounded backend kill timeout.
- Ingestion/dataset reconciliation ownership beyond preserving the existing shutdown calls.
- Changing the complete-answer-after-persistence or active chat-run cancellation contracts.

## Git workflow

- Branch: `codex/013-drain-automation-scheduler-on-shutdown`
- Suggested commits:
  1. `test(server): cover automation scheduler shutdown races`
  2. `fix(server): drain automation scheduler on shutdown`
- Use conventional commits. Do not push or open a PR without explicit instruction.

## Steps

### Step 1: Give the runner a quiescing, awaitable stop contract

Replace the `ticking` boolean with an explicitly tracked active tick promise and a stopped/quiescing flag. Preserve these semantics:

- a newly created runner may be driven manually with `tick()` in tests;
- `start()` is idempotent, clears the stopped state, installs one unref'd interval, and does not run an immediate tick;
- concurrent tick requests execute at most one claim batch (returning the active promise is acceptable and makes drain observable);
- `stop()` synchronously marks the runner stopped and clears the interval before its first await, then returns `Promise<void>` that settles only after the active tick settles;
- a tick requested after stop and before a later explicit `start()` is a no-op;
- a claim batch already returned by `claimDue` is checked before each executor
  dispatch. Once stop marks the runner quiescing, finish only the claim whose
  executor was already entered; do not begin any remaining connector or agent
  claim and do not synthesize run history for those unstarted claims. Their
  schedule advancement from the atomic claim remains the existing durable
  claim behavior;
- expected executor/store failures retain today's best-effort swallowing and generic durable outcome behavior.

Use identity checks in the active promise's `finally` so an old tick cannot clear a newer reference after restart. `isRunning()` continues to mean an interval is installed, not that a tick is active.

**Verify**: `pnpm --filter borealis-server typecheck` → all callers now handle the Promise-returning stop API and exit 0.

### Step 2: Add deterministic runner drain tests

In `server/src/tests/automations.test.ts`, create a small fake `AutomationStore`
seam whose `claimDue` waits on a deferred promise and then returns at least two
claims. Start a tick, wait until `claimDue` is entered, call `stop()`, and
assert:

- `isRunning()` is false immediately;
- the stop promise remains unsettled while the claim is held;
- another `tick()` does not call `claimDue` again;
- releasing the deferred claim lets both tick and stop settle without invoking
  either returned claim;
- a subsequent `start()` permits scheduled/manual work again without creating two intervals.

Add a second boundary case: allow the first claim executor to enter and defer
it, stop the runner, then release it. Assert the second claim in the same batch
is never dispatched. This distinguishes an already-running executor from
merely claimed work and prevents a connector claim followed by an agent claim
from registering new activity during drain.

Do not use real sleeps. Use deferred promises, `setImmediate`, and fake timers only where interval state itself is under test.

**Verify**: `pnpm --filter borealis-server exec vitest run src/tests/automations.test.ts` → all runner behavior and new drain tests pass without timer leakage.

### Step 3: Quiesce first, then cancel continuously while ingress drains

In the returned server's normal `close` path, call
`automationRunner().stop()` immediately when close begins and retain its
promise. This must stop new claim dispatch before HTTP draining starts. Replace
the HTTP-only cancellation helper with one that observes both the HTTP-close
promise and retained scheduler-drain promise. Until both are settled, it must
repeatedly call `shutdownActiveRuns()` and yield with the existing short bounded
poll; make one final cancellation pass after both are observed settled. This
closes the race where `acceptChatTurn` finishes and `beginRun` registers after an
earlier snapshot.

Then:

1. close HTTP and drain the scheduler while repeated `shutdownActiveRuns`
   snapshots abort request- or scheduler-owned agent runs;
2. await both retained ingress promises and the final cancellation pass;
3. stop ingestion/reconciliation and the dataset worker in the existing safe order;
4. close the paired SQLite/LanceDB runtime;
5. close runtime settings in `finally`.

Continue catching cleanup failures so one failed shutdown component does not skip later resource closure. Keep `close()` idempotent through its existing cached promise.

For connector sync claims, there is no chat controller to abort; the scheduler drain must await their existing bounded connector network/data-service operations before database close.

**Verify**: add a `serverApp.test.ts` normal-close test with an automation-stop
deferred promise. `stop` must be invoked as close begins, active-run shutdown
must be invoked more than once while the drain is held, and `closeDb` must
remain uncalled until the deferred scheduler drain resolves and the final
cancellation snapshot runs. Then run the focused test command.

### Step 4: Stop and drain after partial startup failure

Update the `catch` path in `startBorealisServer` to handle
`automationSchedulerStarted`. Quiesce the runner first, then use the same
continuous cancellation/drain helper for the partially built HTTP app and
scheduler. An interval-fired agent turn may cross `acceptChatTurn`/`beginRun`
after cleanup begins, so a one-shot `shutdownActiveRuns` call is forbidden.
Only after both ingress sources settle and the final snapshot runs may the path
stop workers/dataset and close DB/settings.

In `serverApp.test.ts`, mock `automationRuntime` with a stable runner object and add a deterministic post-start failure case. A reliable pattern is to bind a temporary `node:net` server, pass its occupied loopback port to `startBorealisServer`, and assert listen rejects after the scheduler has started. Make mocked `stop()` deferred and prove `closeDb` is not called until it resolves. Close the temporary listener in `finally`.

Also mock runtime-settings initialization/closure if needed so this lifecycle test does not read or mutate operator settings.

Add a deterministic registration-gap regression using deferred boundaries:
start cleanup while a scheduler agent claim is paused immediately before
`beginRun`; let the first cancellation snapshot complete; then allow
`beginRun` to register the controller and hold `runAgent`. Prove a later
snapshot aborts that controller, the scheduler drain settles, and only then can
`closeDb` run. Do not use elapsed-time assertions.

**Verify**: `pnpm --filter borealis-server exec vitest run src/tests/serverApp.test.ts` → normal close and occupied-port startup cleanup both pass with deterministic ordering.

### Step 5: Run all server and repository gates

Run the commands in the table and inspect for unhandled promises or leaked timers. The interval must remain `unref()`'d.

**Verify**: `git diff --check && git status --short` → no whitespace errors; only the four in-scope files plus the permitted `advisor-plans/README.md` status update are modified.

## Test plan

- Unit: stop quiesces immediately, waits for an active tick, prevents dispatch
  of a returned-but-unstarted batch and later claims behind an active executor,
  and can be followed by explicit restart.
- Server normal close: scheduler stop begins before active-run drain, repeated
  cancellation catches a controller registered after the first snapshot, and
  DB close waits for scheduler drain plus the final snapshot.
- Server partial startup failure after runner start: runner is stopped/drained and DB/settings still close.
- Preserve existing automation outcome, pause, connector history, and agent busy/cancellation tests.
- Avoid wall-clock sleeps and never depend on the one-minute production interval.

## Done criteria

- [ ] `AutomationRunner.stop()` returns a promise for the current tick and clears the unref'd timer synchronously.
- [ ] No new claim starts after stop unless `start()` is explicitly called again.
- [ ] Claims returned before stop but not yet dispatched never enter an
      executor, and claims later in an active batch do not start after stop.
- [ ] Normal server close quiesces, continuously cancels active chat runs while
      HTTP and scheduler ingress drain, performs a final snapshot, then closes
      storage.
- [ ] A startup failure after scheduler start performs the same scheduler cleanup before storage close.
- [ ] `RunningBorealisServer.close()` remains idempotent.
- [ ] Focused, full server, and repository gates pass with no leaked handles.
- [ ] No file outside Scope is modified, except the permitted plan-index update.

## STOP conditions

Stop and report back instead of improvising if:

- Plan 006 is not DONE/green, or its provider-revision consent contract would be bypassed/reordered by the scheduler state change.
- The runner has gained a canonical cancellation/drain API that supersedes this design.
- An automation executor performs an unbounded operation with no existing cancellation or timeout, so `stop()` can never settle under supported conditions.
- Avoiding shutdown deadlock would require closing SQLite/LanceDB before the active tick finishes.
- `claimDue` cannot safely leave a returned-but-unstarted claim without changing
  its durable scheduling semantics; report that contract rather than executing
  it after quiescence.
- There is no way to observe both HTTP and scheduler settlement while retaining
  repeated active-run cancellation through the last possible `beginRun`
  registration boundary.
- The startup failure test cannot be made deterministic without modifying production solely for test injection; report the seam needed.
- The change would alter interval cadence, claim ordering, durable outcomes, or agent/connector business behavior.
- A verification fails twice after one reasonable correction, or a required file is outside Scope.

## Maintenance notes

- Any new scheduler executor must either be abortable through an owned controller or have a bounded operation before joining the drain promise.
- `isRunning()` is an interval/liveness surface only. If operators later need active-work status, add a separate explicit field.
- Plan 014 will remove the module-cached runner. Preserve this stop/drain contract when moving it into the owned application runtime.
- Reviewers should inspect shutdown ordering, not only whether `await stop()`
  appears: quiesce must happen before cancellation; cancellation must repeat
  through the last possible controller registration; and storage close must
  happen after both drains and the final snapshot.

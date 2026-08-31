# Plan 015: Move vector verification outside the promotion write transaction

> **Executor instructions**: Do not start until plan 004 is DONE and its vertical agent test is green. Follow every step and verification gate. If a STOP condition occurs, stop and report; do not weaken the two-store protocol. When complete, update this plan's row in `advisor-plans/README.md` unless the reviewer owns index maintenance.
>
> **Drift check (run first, after dependency)**: `git diff --stat f1b9293..HEAD -- server/src/db/stores/ingestionStore.ts server/src/tests/ingestionVectorLifecycle.test.ts`
> Compare `promoteGeneration`, its input type, and the lifecycle tests with Current state. Any changed promotion protocol is a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: `advisor-plans/004-add-vertical-agent-integration-test.md`
- **Category**: perf
- **Planned at**: commit `f1b9293`, 2026-08-30

## Why this matters

Promotion opens SQLite's only in-process writer gate and a `BEGIN IMMEDIATE` transaction, then waits on a LanceDB vector lookup for as many as 10,000 chunks. During that external await, every ledger operation sharing the path queues behind the gate, so one slow vector verification can stall chats, ingestion heartbeats, source mutations, and automation history. A short snapshot transaction, external verification, and short compare-and-promote transaction removes the multiplicative lock hold while preserving fail-closed generation visibility.

## Current state

- `server/src/db/stores/ingestionStore.ts:660-675` performs the external callback inside an immediate transaction:

  ```ts
  async promoteGeneration(input: PromoteGenerationInput): Promise<{ readonly chunkCount: number }> {
    const generation = positiveGeneration(input.generation);
    const sizeBytes = nonNegativeInteger(input.sizeBytes, "sizeBytes");
    return this.ledger.withImmediateTransaction(async (tx) => {
      this.assertLeaseTx(tx, input.accountId, input.sourceId, generation, input.leaseToken);
      const source = sourceRowInTransaction(tx, input.accountId, input.sourceId);
      if (!source) throw new IngestionStoreError("INGESTION_SUPERSEDED", "source ingestion superseded");
      const staged = tx.all<StagingRow>(
        `SELECT chunk_id, source_id, account_id, generation, seq, source_name, content, meta
         FROM ingestion_chunk_staging WHERE source_id=? AND generation=? ORDER BY seq`,
        [input.sourceId, generation]
      );
      if (!staged.length) throw new IngestionStoreError("INGESTION_EMPTY", "ingestion has no staged chunks");
      if (!(await input.verifyVectors(Object.freeze(staged.map((row) => row.chunk_id))))) {
        throw new IngestionStoreError("VECTOR_INCOMPLETE", "ingestion vectors are incomplete");
      }
  ```

- The same transaction then deletes live chunks, copies staging, updates `sources.ready_generation`, finishes the leased job, and enqueues vector pruning (`server/src/db/stores/ingestionStore.ts:676-734`). Those relational changes must remain atomic.

- `server/src/db/sqlite.ts:145-201` holds a per-path `SerialGate` around the entire async callback. It executes `BEGIN IMMEDIATE` before awaiting `work(transaction)` and commits only afterward. The existing concurrency characterization at `server/src/tests/sqliteFoundation.test.ts:363-378` proves a second ledger read waits behind such a held callback.

- `PromoteGenerationInput.verifyVectors` is explicitly asynchronous (`server/src/db/stores/ingestionStore.ts:79-87`). `IngestionVectorLifecycle.promote` supplies LanceDB `hasAll` at `server/src/vector/lifecycle.ts:102-120`:

  ```ts
  const result = await this.store.promoteGeneration({
    ...input,
    verifyVectors: (chunkIds) => this.vectors.hasAll(chunkIds, input.sourceId, input.generation),
  });
  ```

- The lifecycle serializes normal same-process work per source, but `promoteGeneration` must still defend against lease recovery, direct store calls, and future multi-process/concurrent mutation while verification is outside SQLite.

- `server/src/tests/ingestionVectorLifecycle.test.ts:233-310` is the crash/incomplete-vector exemplar: it proves SQLite commits before prune, startup repair removes old vectors, and a missing staged vector leaves the old ready generation and staging intact.

- `AGENTS.md:156-165` fixes the protocol: chunk UUIDs span both engines, SQLite `ready_generation` is authoritative, new vectors become retrievable only after SQLite promotion commits, and startup repair handles stale/orphan work. Do not replace this with embeddings in SQLite or text in LanceDB.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Focused lifecycle tests | `pnpm --filter borealis-server exec vitest run --config vitest.integration.config.ts src/tests/ingestionVectorLifecycle.test.ts` | all two-store lifecycle tests pass |
| SQLite concurrency tests | `pnpm --filter borealis-server exec vitest run --config vitest.integration.config.ts src/tests/sqliteFoundation.test.ts` | all ledger gate/transaction tests pass |
| Dependency regression | `pnpm --filter borealis-server exec vitest run --config vitest.integration.config.ts src/tests/agentVerticalIntegration.test.ts` | exit 0; the complete agent turn passes with two scripted provider calls |
| Server typecheck | `pnpm --filter borealis-server typecheck` | exit 0, no errors |
| Server lint/format | `pnpm --filter borealis-server lint && pnpm --filter borealis-server format:check` | exit 0, no warnings |
| Full server tests | `pnpm --filter borealis-server test` | all tests pass |
| Final repository gate | `pnpm verify` | exit 0 and prints `ALL GATES GREEN` on a provisioned supported host |

## Scope

**In scope** (the only source/test files to modify):

- `server/src/db/stores/ingestionStore.ts`
- `server/src/tests/ingestionVectorLifecycle.test.ts`

**Out of scope** (do not touch):

- `server/src/db/sqlite.ts`; async transactions remain supported for other atomic protocols.
- `server/src/vector/lifecycle.ts` and `server/src/vector/lance.ts`; the callback contract and prefiltered vector store remain unchanged.
- Chunking, embedding batch size, ingestion worker concurrency, lease duration, or retry policy.
- Moving text to LanceDB, vectors to SQLite, or changing retrieval's LanceDB prefilter then SQLite join.
- Periodic full-store repair; plan 016 addresses reconciliation after this transaction change lands.

## Git workflow

- Branch: `codex/015-shorten-vector-promotion-transaction`
- Suggested commits:
  1. `test(server): expose vector promotion lock hold`
  2. `perf(server): verify vectors outside promotion transaction`
- Use conventional commits. Do not push or open a PR without explicit instruction.

## Steps

### Step 1: Capture a short, consistent promotion snapshot

Refactor `promoteGeneration` into three phases without changing its public input/output:

1. a synchronous-callback `withImmediateTransaction` that asserts the exact account/source/generation/lease, proves the source exists, loads all ordered staging rows, rejects empty staging, and returns an immutable snapshot;
2. `await input.verifyVectors(...)` outside every SQLite transaction;
3. a synchronous-callback `withImmediateTransaction` that reasserts and atomically promotes only the exact verified snapshot.

The first phase may briefly use `BEGIN IMMEDIATE` to obtain a coherent job/source/staging view, but it must contain no network, LanceDB, filesystem, worker, timer, or arbitrary async await. Keep vector verification called exactly once with the ordered frozen chunk-ID list.

**Verify**: inspect `promoteGeneration` with `rg -n -A25 -B5 'verifyVectors' server/src/db/stores/ingestionStore.ts` → the `await input.verifyVectors` line is lexically outside both `withImmediateTransaction` callbacks.

### Step 2: Compare the complete staged identity before committing

In the final transaction, repeat lease/source validation and reload ordered staging rows. Compare them with the verified snapshot before changing live state. Equality must cover row count and every field that determines vector/text correspondence: `chunk_id`, `source_id`, `account_id`, `generation`, `seq`, `source_name`, `content`, and encoded `meta`. Chunk IDs alone are insufficient because `stageChunks` can update content/meta while retaining an existing sequence's UUID.

If the lease/source or staging snapshot changed, throw `IngestionStoreError("INGESTION_SUPERSEDED", ...)`. If external verification returns false, continue returning `VECTOR_INCOMPLETE`. Use the source row reloaded inside the final transaction when cleaning metadata so a concurrent source metadata update is not overwritten by the first snapshot.

Once equality is proven, keep today's relational promotion statements together in the final immediate transaction: replace live chunks, remove staging, set source ready state/generation/path/size/meta, update connector state, complete the exact leased job, and enqueue `prune_except_generation`. Return the final verified row count.

**Verify**: `pnpm --filter borealis-server exec vitest run --config vitest.integration.config.ts src/tests/ingestionVectorLifecycle.test.ts` → all existing crash, incomplete-vector, retrieval, and repair cases pass.

### Step 3: Prove unrelated ledger work is not held behind Lance verification

Add a deterministic regression to `server/src/tests/ingestionVectorLifecycle.test.ts` using its existing real SQLite/Lance stores and staging helpers. Supply a `verifyVectors` callback that signals entry, waits on a deferred promise, then checks the real vector index. While it is waiting, issue an unrelated ledger write (or open a second ledger on the same exact path and write) and assert that operation settles before releasing verification. Under the old implementation, the shared `SerialGate` would keep it pending.

Do not measure milliseconds. Use deferred promises, a settled flag, and `setImmediate`/explicit completion. Close any second ledger in `finally` and register it with test cleanup.

After release, assert promotion succeeds, new SQLite text is ready, and vector pruning semantics remain unchanged.

**Verify**: run the focused lifecycle test command → the lock-release regression passes deterministically.

### Step 4: Prove a changed snapshot cannot be promoted

Add a second race regression. Begin promotion with verification held, then call the store staging API directly with the same still-valid lease but changed content/meta for an existing sequence (which may retain the chunk UUID). This re-stage must complete while verification is waiting. Release verification with true and assert final promotion rejects with `INGESTION_SUPERSEDED`.

Assert the prior ready generation/text remains queryable, the changed staging row remains staged for retry/failure handling, and `sources.ready_generation`/job completion did not advance. This test is what permits moving the I/O outside the lock safely.

**Verify**: run the focused lifecycle test command → the changed-content/same-ID race fails closed and all existing tests pass.

### Step 5: Run server and repository gates

Run SQLite concurrency, dependency vertical, all server checks, and `pnpm verify`. Review the final transaction for any `await` or callback not known to be synchronous.

**Verify**: `git diff --check && git status --short` → no whitespace errors; only the two in-scope files plus the permitted `advisor-plans/README.md` status update are modified.

## Test plan

- Preserve every existing two-store crash point and `VECTOR_INCOMPLETE` assertion.
- New deterministic concurrency test proves unrelated ledger work completes while Lance verification is held.
- New changed-snapshot test covers content/meta changes with stable chunk IDs, lease recheck, and no partial relational promotion.
- Assert verification receives exact ordered IDs once.
- Run SQLite gate tests to ensure transaction reentrancy/serialization behavior itself is unchanged.
- Run plan 004's vertical chat test and the full server suite because ingestion feeds retrieval/agent behavior.

## Done criteria

- [ ] No external/vector await occurs inside either promotion SQLite transaction.
- [ ] The final transaction revalidates lease, source, and every staged row field against the verified snapshot.
- [ ] Unrelated ledger work completes while vector verification is deliberately held.
- [ ] A changed same-ID staging row causes `INGESTION_SUPERSEDED` with old ready state preserved.
- [ ] Missing vectors still cause `VECTOR_INCOMPLETE`; SQLite remains authoritative and pruning remains post-commit.
- [ ] Focused, SQLite, vertical, full server, and repository gates pass.
- [ ] No file outside Scope is modified, except the permitted plan-index update.

## STOP conditions

Stop and report back instead of improvising if:

- Plan 004 is not DONE/green or promotion behavior has materially changed since `f1b9293`.
- Correct revalidation would require comparing only chunk IDs while content/meta can change under the same IDs.
- The vector API cannot verify an immutable ordered snapshot without scanning/filtering a broad LanceDB set in JavaScript.
- Moving verification out would make vectors visible to retrieval before SQLite `ready_generation` commits.
- A test can pass only by weakening lease checks, deleting staged retry state, or extending the SQLite transaction across external I/O again.
- A verification fails twice after one reasonable correction, or a required file is outside Scope.

## Maintenance notes

- Treat every callback accepted inside `withImmediateTransaction` as part of the global per-path critical section. External I/O belongs before/after it with a compare-and-commit guard.
- If staging gains new vector-relevant columns, add them to snapshot equality in the same migration/change.
- Plan 016 depends on this plan and will make periodic repair bounded; keep the full startup repair and durable vector-operation queue intact.
- Reviewers should inspect the race test closely: stable UUIDs with changed content are the subtle case that an ID-only comparison misses.

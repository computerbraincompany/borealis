# Plan 029: Cover DuckDB query preflight with deadlines and cancellation

## Status

- **State**: DONE (2026-09-01)
- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none; land before plan 004
- **Category**: correctness / performance
- **Planned at**: `14ab08f`, 2026-08-31

## Why this matters

Statement extraction and native preparation occur while holding a scoped lease
and I/O mutex but before Borealis installs its query timer and connection
interrupt. Cancellation and the advertised deadline therefore cover execution
only, not the full worker-boundary query.

## Target contract

- One deadline begins before scoped-catalog acquisition and trusted-file loading,
  then covers single-statement validation, native preparation, schema discovery,
  execution, and bounded result materialization.
- The deadline and abort signal propagate through the facade and worker;
  cancellation interrupts the active native connection.
- Cancellation and timeout produce stable 499/504 worker errors and always
  release the prepared statement, mutex, scope lease, readers, and timer.
- SQL length/type/table allowlists and all row/column/cell/character limits stay
  unchanged.

## Scope

- `server/src/data/datasetsWorker.ts`
- dataset worker/unit/integration tests and API timeout documentation

## Implementation steps

1. Move `assertReadOnlySql` and the complete query pipeline inside one
   `runWithDeadline` invocation under the existing per-scope I/O mutex. Avoid
   `extractStatements()`: the pinned binding does not interrupt extraction, so
   enforce the one-statement grammar lexically and use interruptible native
   `prepare()` as the authoritative statement-type check.
2. Preserve prepared-statement destruction in `finally`, including timeout and
   cancellation paths.
3. Add a test-only native preparation workload that is rejected outside
   `NODE_ENV=test`; do not expose test controls over HTTP.
4. Test in-flight native preparation, caller cancellation, timeout, mutex/lease
   release, and a succeeding follow-up query.
5. Retain malicious SQL, external-access, selected-empty, and output-budget
   regressions.

## Verification

- Focused dataset tests, server checks/integration, and `pnpm verify`.

## Done criteria

- [x] The deadline covers the complete accepted query operation.
- [x] Cancellation can interrupt native preflight work.
- [x] A timed-out query cannot block the next operation or shutdown.

## Completion record

- One propagated deadline now covers lexical single-statement validation,
  catalog acquisition, trusted-file loading, native preparation, SQL execution,
  and bounded result materialization; abort interrupts the active connection.
- The pinned `extractStatements()` promise does not honor
  `connection.interrupt()`, so the accepted-query path no longer calls it. A
  quote/comment/dollar-string-aware scanner, including DuckDB escape strings and
  CR/LF line endings, rejects extra statements before `connection.prepare()`
  performs the authoritative SELECT type and binding check.
- Dataset-worker tests drive a genuine long-running native prepare and prove
  stable timeout/cancellation cleanup, mutex and lease release, immediate scope
  reuse, and a succeeding follow-up query. Prepared statements are destroyed in
  `finally`, including after the test workload completes normally. A separate
  post-build/pre-install deadline seam proves that an uncached catalog remains
  locally owned and is closed unless it is transferred into the scope registry.

## STOP conditions

- DuckDB cannot safely interrupt extraction/preparation in the pinned API;
  characterize that boundary and isolate preflight in a terminable worker epoch
  rather than claiming a false deadline.

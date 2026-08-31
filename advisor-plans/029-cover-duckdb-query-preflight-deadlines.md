# Plan 029: Cover DuckDB query preflight with deadlines and cancellation

## Status

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

- One deadline begins before statement extraction and ends after bounded result
  materialization.
- The connection interrupt is installed for extraction, preparation, schema
  discovery, and execution.
- Cancellation and timeout produce stable 499/504 worker errors and always
  release the prepared statement, mutex, scope lease, readers, and timer.
- SQL length/type/table allowlists and all row/column/cell/character limits stay
  unchanged.

## Scope

- `server/src/data/datasetsWorker.ts`
- dataset worker/unit/integration tests and API timeout documentation

## Implementation steps

1. Move `assertReadOnlySql` and the complete query pipeline inside one
   `runWithDeadline` invocation under the existing per-scope I/O mutex.
2. Preserve prepared-statement destruction in `finally`, including timeout and
   cancellation paths.
3. Add a test-only injected delay seam that is rejected outside `NODE_ENV=test`
   or factor a pure dependency seam; do not expose delay controls over HTTP.
4. Test delayed extraction, delayed preparation, caller cancellation, timeout,
   mutex/lease release, and a succeeding follow-up query.
5. Retain malicious SQL, external-access, selected-empty, and output-budget
   regressions.

## Verification

- Focused dataset tests, server checks/integration, and `pnpm verify`.

## Done criteria

- [ ] The deadline covers the complete accepted query operation.
- [ ] Cancellation can interrupt native preflight work.
- [ ] A timed-out query cannot block the next operation or shutdown.

## STOP conditions

- DuckDB cannot safely interrupt extraction/preparation in the pinned API;
  characterize that boundary and isolate preflight in a terminable worker epoch
  rather than claiming a false deadline.

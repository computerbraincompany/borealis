# Plan 024: Preserve connector-cache cleanup until deletion is proven

> Execute against the live tree, keep cleanup exact-location and idempotent, and
> stop if success would require treating an unclassified filesystem error as
> absence. Update the plan index when complete.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none; land before plans 016 and 020
- **Category**: correctness / storage
- **Planned at**: `14ab08f`, 2026-08-31

## Why this matters

Connector cache cleanup currently loses durable retry authority in two ways.
`cleanupConnectorVersion` swallows arbitrary `lstat` and directory-removal
errors, and stale-registry repair deactivates a URL dataset before reserving its
fallible cache deletion. Either path can leave immutable connector data behind
after Borealis reports or records cleanup as complete.

## Target contract

- Only `ENOENT` proves an exact cache file or manifest is absent.
- An exact file disappearing between `lstat` and `unlink` is idempotent success;
  permission, I/O, symlink, type, and real-path failures remain failures.
- Removing the now-empty UUID-scoped cache directory may ignore only `ENOENT`
  and `ENOTEMPTY`; other errors propagate.
- Stale URL locations are inserted into `dataset_cache_cleanup_jobs` before
  DuckDB deactivation. The durable worker owns both deactivation and deletion.
- A job is resolved only after deletion or proven exact absence. Failures retain
  the row and increment attempts without logging paths, IDs, or errors.

## Scope

- `server/src/data/connectorFetch.ts`
- `server/src/ingest.ts`
- focused connector-fetch, restoration, source-cleanup, and ingestion tests
- current API/storage documentation that describes cleanup guarantees

Do not widen recursive deletion, weaken cache ownership validation, or change
the connector prepare/activate CAS protocol.

## Implementation steps

1. Refactor `cleanupConnectorVersion` to classify each filesystem operation by
   exact error code and reuse one proven candidate/manifest pass.
2. Add focused tests for `ENOENT`, non-`ENOENT` `lstat`, unlink races, symlinks,
   and directory `ENOTEMPTY` versus permission failure.
3. In stale dataset restoration, reserve the exact URL location durably before
   deactivation and run it through `processDatasetCacheCleanup`; retain direct
   deactivation for non-connector files.
4. Add a restart regression: deactivation succeeds, deletion fails once, the
   job survives, and a later repair deletes and resolves it.
5. Reconcile plans 011, 016, and 020 so later cleanup work retains this contract.

## Verification

- Focused connector fetch, restore, cleanup, and ingestion tests.
- Server typecheck, lint, format, unit/integration tests, then `pnpm verify`.
- `git diff --check`; no sensitive dynamic values in logs or public responses.

## Done criteria

- [ ] Fulfilled cleanup means deletion or proven `ENOENT`, never merely no throw.
- [ ] Stale URL cleanup has durable identity before DuckDB forgets it.
- [ ] Crash/retry and non-`ENOENT` regressions pass.
- [ ] Documentation and the advisor index reflect completion.

## STOP conditions

- Exact cache ownership cannot be proven without broad path inference.
- Cleanup would need to key on table name rather than exact location.
- A change conflicts with an already-landed typed connector protocol; reconcile
  that protocol rather than adding a second cleanup state machine.

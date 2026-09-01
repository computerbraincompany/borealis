# Plan 024: Preserve connector-cache cleanup until deletion is proven

> Execute against the live tree, keep cleanup exact-location and idempotent, and
> stop if success would require treating an unclassified filesystem error as
> absence. Update the plan index when complete.

## Status

- **State**: DONE (2026-09-01)
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
- A pending cleanup row is a durable exact-location tombstone. Connector
  candidate adoption and final source promotion reject the same
  `(account, name, location)`, while the data worker serializes preparation,
  activation, and inactive cleanup for that location.
- A job is resolved only after deletion or proven exact absence. Failures retain
  the row and increment attempts without logging paths, IDs, or errors.
  Successful resolution atomically removes the row and only an exactly matching
  prior-location marker.

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

- [x] Fulfilled cleanup means deletion or proven `ENOENT`, never merely no throw.
- [x] Stale URL cleanup has durable identity before DuckDB forgets it.
- [x] Crash/retry and non-`ENOENT` regressions pass.
- [x] Documentation and the advisor index reflect completion.

## Completion record

- `cleanupConnectorVersion` now treats only exact `ENOENT` as absence and
  preserves all other filesystem failures for retry.
- Stale connector locations enter `dataset_cache_cleanup_jobs` before DuckDB
  deactivation; focused connector-fetch, restore, and ingestion lifecycle tests
  cover unlink races, symlinks, restart retry, and directory error classes.
- Reconciliation revalidates current `file_path` and prepared-candidate
  ownership in the same SQLite transaction that reserves cleanup. The cleanup
  row then remains a durable tombstone: candidate activation and generation
  promotion cannot reuse its exact location, and DuckDB refuses cleanup while
  the location is active, preparing, or activating. Same-file refresh fallback,
  raced promotion, failed deletion, later refresh, and restart regressions keep
  the last-good cache available without losing retry authority.
- Cleanup also enumerates and removes only the exact version's
  `.staged-<uuid>` candidate and manifest remnants. Candidate publication and
  manifest-claim finalizers propagate non-`ENOENT` failures, so a crash before
  or after either hard-link boundary leaves the durable tombstone available for
  an exact retry rather than reporting false completion.

## STOP conditions

- Exact cache ownership cannot be proven without broad path inference.
- Cleanup would need to key on table name rather than exact location.
- A change conflicts with an already-landed typed connector protocol; reconcile
  that protocol rather than adding a second cleanup state machine.

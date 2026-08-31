# Plan 028: Preserve published chart provenance

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: MED
- **Depends on**: none; land before plan 022
- **Category**: correctness
- **Planned at**: `14ab08f`, 2026-08-31

## Why this matters

Normal publication clears a chart's `run_id`, while chart listing derives the
source chat only through that run. Every generated chart therefore loses the
lineage needed by the gallery's source-chat link.

## Target contract

- Publishing a selected chart retains its owning `run_id`.
- Pending cleanup continues to select only `status='pending'`; retained lineage
  must never make a published chart eligible for run cleanup.
- Deleting a chat cascades its run and the existing foreign key sets chart
  `run_id` to null while retaining the published chart.
- Registry responses expose owned `run_id` and `chat_id` while never returning
  spec or PNG bytes.

## Scope

- chart publication/listing in `server/src/db/stores/runStore.ts`
- run-store, chart-route, and Reports UI tests
- chart registry API documentation

Prefer retaining the existing foreign key over a new schema migration. Add a
direct `chat_id` column only if tests prove retained `run_id` violates a current
cleanup or deletion invariant.

## Implementation steps

1. Stop nulling `run_id` for selected published charts.
2. Add a pending-to-published integration test that lists the chart and follows
   its chat lineage.
3. Delete the source chat and prove the chart remains published with null
   lineage and no cross-account exposure.
4. Replace route fixtures that normalize already-null published charts with a
   real completion path.

## Verification

- Focused run-store/chart-route/web tests, server and web checks, `pnpm verify`.

## Done criteria

- [ ] Normal generated charts expose a working source-chat link.
- [ ] Chat deletion safely severs, rather than deletes or leaks, provenance.
- [ ] Cleanup and tenant-boundary tests remain green.

## STOP conditions

- Retaining the run makes published artifacts reachable by a pending cleanup
  query; repair that predicate first or use an explicit chat lineage migration.

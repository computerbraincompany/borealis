# Plan 035: Manage embedding-model reindexing as a durable workspace operation

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: plan 034
- **Category**: product / storage migration
- **Planned at**: `14ab08f`, 2026-08-31

## Why this matters

Changing the embedding model currently leaves old vectors in place, while a
dimension change prevents LanceDB from reopening. Operators must manually
reingest every source or create a new data directory. Borealis needs a managed
operation that never exposes a corpus containing mixed embedding identities.

## Target contract

- Generic Settings PATCH may not change model or dimension while ready sources
  exist; it returns `409 EMBEDDING_REINDEX_REQUIRED` with no IDs or paths.
- Settings gains a persisted `embedding_dimension`; `EMBEDDING_DIM` remains the
  higher-precedence operator override and disables dimension migration.
- A qualified target model/dimension starts one process-wide migration. A
  mode-0600 atomic state file and a migration-private SQLite manifest below an
  exact UUID staging directory record phase, provider revision, source/generation
  snapshot, bounded chunk cursor, counts, and hashes without passage text.
- The worker reads existing SQLite chunk text in bounded pages, embeds with the
  target model, and builds a separate LanceDB index. It never mutates the live
  index or SQLite ready generations while building.
- Source/connector mutations are gated during snapshot/build; chat may use the
  unchanged old model/index until final quiescence. Apply gates new turns,
  drains active model/ingestion work, revalidates the exact snapshot, and stops
  before switching if any source generation drifted.
- Startup owns an explicit journaled swap: verify staged dimension/counts,
  rename live index to an exact backup, install staged index, atomically update
  model/dimension settings, open storage, then mark complete. Every crash phase
  deterministically rolls forward or restores the paired old index/settings.
- Old index backup remains until the new runtime opens and a scoped retrieval
  smoke passes. Cancellation before apply deletes only the verified staging
  UUID directory; after apply it requires a reverse managed migration.
- Status/retry/cancel APIs and Settings UI expose only phase and aggregate
  counts. Provider failures and content are never persisted or logged.

## Scope

- settings/runtime configuration and a new embedding migration coordinator
- bounded SQLite chunk snapshot reader, LanceDB staging lifecycle, startup apply
- model/source/connector/chat gates, routes/UI/tests/docs/desktop lifecycle
- no application-ledger schema migration; plans 006/012/020 retain v12–v14

## Implementation steps

1. Version the atomic settings file to persist embedding dimension while reading
   v1 compatibly; retain environment precedence and mode repair.
2. Implement the bounded, no-text migration state/manifest codecs with exact
   directory ownership and startup recovery tests for every write/rename phase.
3. Add a snapshot API that records account/source/ready-generation/chunk UUIDs
   in the private manifest transactionally, then streams joined chunk text only
   to the embedding worker in bounded batches.
4. Build and verify a target-dimension Lance index using the normal account,
   source, generation, and stable chunk UUID metadata.
5. Add the admission gates, quiescence checks, journaled startup swap/rollback,
   backup retirement, status/retry/cancel routes, and Settings workflow.
6. Reject provider revision drift, environment-managed dimension changes,
   concurrent migration, source mutation during build, incomplete vectors,
   wrong dimension, unsafe paths, and insufficient disk space.
7. Add end-to-end fixtures for same-dimension model change, dimension change,
   restart/resume, every crash phase, cancellation, failure/retry, and retrieval
   equivalence after apply.

## Verification

- Focused settings/migration/ingestion/retrieval tests; real SQLite/Lance
  integration with two dimensions; desktop restart/apply smoke; full server/web/
  desktop gates and `pnpm verify`.

## Done criteria

- [ ] No retrievable state mixes embedding identities.
- [ ] Same- and different-dimension migrations are resumable and recoverable.
- [ ] Live SQLite text and live Lance vectors remain a matched pair on every
  tested crash boundary.
- [ ] UI and docs replace manual reingest instructions with the managed flow.

## STOP conditions

- Applying the new index cannot be made crash-recoverable without a broad or
  ambiguous filesystem rename.
- Any migration manifest stores passage text, credentials, or provider output.
- Runtime consumers cannot be proven quiescent before swap; do not hot-swap a
  live Lance handle.

# Plan 035: Manage embedding-model reindexing as a durable workspace operation

## Status

- **State**: DONE (2026-09-01)
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

- Once the live fixed-schema index exists, generic Settings PATCH may never
  change its model or dimension, including with zero ready sources; it returns
  `409 EMBEDDING_REINDEX_REQUIRED` with no IDs or paths.
- Settings gains a persisted `embedding_dimension`; `LLM_EMBED_MODEL` and
  `EMBEDDING_DIM` remain higher-precedence operator overrides and disable the
  corresponding migration.
- A qualified target model/dimension starts one process-wide migration. A
  mode-0600 atomic workspace state file records its phase and target, while a
  migration-private SQLite manifest below an exact UUID staging directory
  records the provider revision, source/generation snapshot, bounded chunk
  cursor, counts, and hashes without passage text.
- Start resolves the target only against persisted provider, credential, and
  chat-model settings. Unsaved endpoint, credential, or chat-model drafts must
  be saved or discarded first; they cannot be combined with a migration target
  qualified under another provider revision. Admission rereads Settings and
  rejects any drift from the exact qualified baseline and target snapshot before
  writing migration state.
- The worker reads existing SQLite chunk text in bounded pages, embeds with the
  target model, and builds a separate LanceDB index. It never mutates the live
  index or SQLite ready generations while building.
- A zero-source workspace follows the same migration: build and verify an empty
  target index, then use the same journaled apply-and-restart swap. It is not a
  generic Settings exception.
- Source/connector mutations are gated during snapshot/build; chat may use the
  unchanged old model/index until final quiescence. Apply gates new turns,
  drains active model/ingestion work, revalidates the exact snapshot, and stops
  before switching if any source generation drifted.
- Startup owns an explicit journaled swap: verify staged dimension/counts,
  rename live index to an exact backup, install staged index, atomically update
  model/dimension settings, open storage, then mark complete. Every crash phase
  revalidates provider identity and embedding environment precedence before
  accepting an installed target, then deterministically rolls forward or
  restores the paired old index/settings.
- Old index backup remains until the new runtime opens, dimension/row counts
  match, and a scoped retrieval smoke passes for a nonempty snapshot.
  Cancellation before apply deletes only the verified staging UUID directory;
  after apply it requires a reverse managed migration.
- Status/retry/cancel APIs and Settings UI expose only content-free target
  identity, phase, aggregate counts, stable failure code, and available actions.
  Provider failures and content are never persisted or logged.
- Every Lance directory carries an atomically published mode-`0600` marker for
  the resolved outbound embedding-model ID and dimension plus an independent
  receipt written first. Startup and every staged/live/backup recovery phase
  validate that identity before opening, relabeling, or retiring an index; only
  the exact receipt may repair a missing marker. A populated pre-marker live
  index has one explicit trust-on-first-upgrade path only for durable non-
  environment-managed Settings (or the pinned legacy defaults); invalid or
  environment-managed identities fail closed.

## Scope

- settings/runtime configuration and a new embedding migration coordinator
- bounded SQLite chunk snapshot reader, LanceDB staging lifecycle, startup apply
- model/source/connector/chat gates, routes/UI/tests/docs/desktop lifecycle
- no application-ledger schema migration; completed plan 031 retains v12 and
  plans 006/012/020 retain v13–v15

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
6. Reject provider revision drift, environment-managed embedding model or
   dimension, concurrent migration, source mutation during build, incomplete
   vectors, wrong dimension, unsafe paths, and insufficient disk space.
7. Add end-to-end fixtures for same-dimension model change, dimension change,
   restart/resume, every crash phase, cancellation, failure/retry, and retrieval
   equivalence after apply.

## Verification

- Focused settings/migration/ingestion/retrieval tests; real SQLite/Lance
  integration with two dimensions; production `initDb` restart/apply
  integration; full server/web/desktop gates and `pnpm verify`.

## Done criteria

- [x] No retrievable state mixes embedding identities.
- [x] Same- and different-dimension migrations are resumable and recoverable.
- [x] Live SQLite text and live Lance vectors remain a matched pair on every
      tested crash boundary.
- [x] UI and docs replace manual reingest instructions with the managed flow.

## Completion record

- Settings v2 persists dimension and generic patches fail closed for every
  embedding-identity change once the fixed-schema index exists. Zero-source
  workspaces use the same verified empty-index migration and journaled swap. A
  mode-`0600`, no-text state/manifest drives bounded snapshot, separate-index
  build, qualification, consent, retry, and cancel.
- Migration start requalifies the target against persisted provider,
  credential, and chat-model settings and admission rechecks the exact
  baseline/target snapshot; route/UI tests gate mixed unsaved endpoint,
  credential, and chat-model drafts so qualification and the durable provider
  revision describe the same operation.
- Startup owns the journaled live/backup/staged rename sequence, paired settings
  update, provider/environment revalidation, reopen, exact row/dimension
  verification, nonempty retrieval smoke, rollback/roll-forward recovery, and
  admission gates. Coordinator, route, settings, ingestion, retrieval, and
  Settings UI tests cover zero-source and populated snapshots, both dimensions,
  drift, every swap phase, and content-free aggregate status.
- Resolved-model/dimension markers move with live, staged, and backup indexes.
  Every first publication writes an independent binding receipt first. A
  missing marker is repaired only from the exact matching receipt; a different
  expected identity, corrupt file, marker/receipt mismatch, or dimension drift
  fails closed and never reopens the one-release legacy-adoption path. Offline
  archive verification accepts a valid dimension-matching receipt-only crash
  state read-only, rejects an existing index with neither identity file, and
  exact-model startup republishes the marker. Populated staged indexes with
  neither authority fail closed during both build resume and startup apply; a
  real `initDb` restart integration proves an `apply_pending` 3-to-5-dimension
  migration reopens the scoped pair, retrieves the expected chunk, publishes
  the new identity, and removes staging/state.
  Same-dimension Settings drift and a crash after restoring the old backup but
  before restoring Settings are rejected or completed as an old-pair rollback;
  the old backup is required through post-open smoke. Retry recreates the exact
  UUID staging directory only when state proves the initial snapshot was never
  published.
- Embedding batches are normalized at the usable float32 cosine-norm boundary
  before staging or migration publication, so stored and query vectors cannot
  underflow or overflow LanceDB's distance calculation.

## STOP conditions

- Applying the new index cannot be made crash-recoverable without a broad or
  ambiguous filesystem rename.
- Any migration manifest stores passage text, credentials, or provider output.
- Runtime consumers cannot be proven quiescent before swap; do not hot-swap a
  live Lance handle.

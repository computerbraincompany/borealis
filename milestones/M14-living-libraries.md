# M14 — Living libraries and inspectable source search

## Status and execution contract

- **Status:** TODO — selected for the implementation handoff on 2026-09-06.
- **Priority / effort:** P1 / L.
- **Baseline:** `e2e6a78`, 2026-09-06. This is a specification, not shipped functionality.
- **Dependencies:** M04/M09; complete the reserved schema v14–v16 remediation
  before allocating a new migration. Allocate the next free version at or above
  v17 with the coordinating agent. M12/M13 are not prerequisites for importing
  and searching; coordinate their evidence representation before adding fields.
- **Product outcome:** a selected folder or authenticated WebDAV collection
  becomes a refreshable library; users inspect the actual indexed passages and
  see what changed without reconstructing uploads or widening chat scope.

Read `AGENTS.md`, `docs/VISION.md`, `docs/API.md`, `desktop/README.md`, and this
specification. Run `git diff --stat e2e6a78..HEAD -- server/src desktop/src web/src`
and reconcile relevant drift before implementing. Expected earlier milestones
are not a reason to stop: update this specification with the reconciled contract.
Keep implementation and verification evidence current as slices land. Do not
mark DONE until all acceptance scenarios and gates below pass.

## Verified baseline and entry points

- `server/src/db/stores/libraryStore.ts` currently declares
  `export const MAX_LIBRARY_MEMBERS = 100;`. Libraries reference source IDs;
  they do not copy documents or change a chat after attachment.
- `server/src/routes/libraries.ts` implements `PUT /api/libraries/:id/sources`
  by calling `replaceMembers(accountId, libraryId, source_ids)`. Preserve this
  explicit scope model; imports add ready members, never a dynamic chat binding.
- `server/src/routes/connectors.ts` implements URL connector prepare/sync,
  consent checks, source mutation admission, and derived schedules. It does not
  provide authenticated corpus crawling or filesystem selection.
- `server/src/ingestSupport.ts`, `extractPdfText`, currently returns
  `pageTexts.join("\n\n").slice(0, config.maxExtractedChars)`. Structured page
  locations are lost. `server/src/ingestionEngine.ts` currently stages
  `contents.map((content) => ({ content, meta: chunkMeta }))`; extend this path
  with location-bearing extraction without removing bounded partial extraction.
- `server/src/db/stores/ingestionStore.ts` already supports chunk `meta` and
  authoritative ready generations. `server/src/vector/retrieve.ts` obtains
  `readyGenerationScopes`, performs scoped KNN, then joins text through SQLite.
  Reuse it; never search every vector and filter in JavaScript.
- `server/src/retrieve.ts` returns early on selected-empty:
  `if (!query.trim() || !allowedSourceIds.length) return [];`.
- `server/src/citations.ts` persists citation source/chunk IDs, not page anchors.
  Existing chat marker numbering remains defined by its own eight-entry evidence
  array; search results must not invent chat citation numbers.
- `desktop/src/preload.cts` exposes only `consumeBootstrap`. Folder selection
  requires an explicit, narrow addition to this contract and desktop tests.
- UI entry points are `web/src/pages/LibrariesView.tsx`, `SourcesView.tsx`,
  `ConnectorsView.tsx`, `web/src/lib/api.ts`, and `web/src/App.tsx`.

## Chosen functional contract

### Import, identity, and refresh

Support desktop native directory selection plus browser directory-file upload
with relative-path preview. Browser imports are copied snapshots; show that
automatic local watching is available only in desktop. No HTTP endpoint accepts
an arbitrary absolute local path. The native picker returns an opaque selection
grant bound to the authenticated account; main sends the canonical root to the
backend through its private utility-process channel. The renderer sees a label,
grant ID, and preview metadata. Grants expire after 10 minutes unless committed;
picker cancellation creates no connection or ingestion jobs.
Keep the one-shot bootstrap operation unchanged. Validate the requesting main
window and trusted frame before showing the picker, and bind the backend grant
to that authenticated account. Amend the documented preload invariant narrowly
when implementing this chosen-folder capability; do not expose directory listing,
file reads, arbitrary paths or general IPC to renderer code.

Browser directory imports use the existing per-file `/api/sources/upload` flow,
then `POST /api/libraries/:id/directory-imports` commits a bounded manifest of
owned source IDs and normalized relative paths with an operation UUID and exact
library revision. Apply the same 100-item, traversal and aggregate byte limits
before uploading, and validate the manifest again on the server. Commit only
ready, owned sources through normal membership rules; retries are idempotent
and stale membership revisions return 409. This creates no refreshable folder
connection. Failed/cancelled imports leave uploaded sources visible in Sources
with an explicit removal action; never delete them implicitly during cleanup.

Preview supported files, relative paths, sizes, duplicate/unchanged/changed/new
and missing counts, unsupported entries, and capacity errors before import.
Default limits: 100 managed entries per connection/library, 10 directory levels,
1,000 visited entries, and 100 MiB aggregate per refresh, additionally capped by
existing per-file upload/extraction limits. Hidden directories and symlinks are
excluded by default and reported as skipped; exclude `.git`, `node_modules`, and
Borealis workspace directories. Exceeding a scan bound fails the preview without
partial activation. Users can select a subset after a complete bounded preview.

A managed item has stable identity `(account_id, connection_id, normalized
relative_path)` and stable `source_id`. Compute a content hash before deciding
unchanged; mtime/size and WebDAV ETag are hints only. Modified bytes create a new
ingestion generation for the same source, with old ready data retained until
successful promotion. Same-path content replacement does not allocate a second
source. A rename is deliberately shown as missing old path plus new path; do not
guess identity from equal content. Duplicates across different paths are shown
and may both be imported when explicitly selected.

Missing upstream files are marked `missing_upstream` and retained in the library
by default, with their last ready content and a visible stale label. Offer an
explicit remove-from-library action and a separate normal source deletion action.
Neither a scan nor deletion of a knowledge connection deletes sources, reports,
saved results, or captured research evidence. Never keep arbitrary orphan chunks
to preserve evidence: artifact owners snapshot the cited excerpt and locator
before source generations are pruned. Historical snapshots remain labeled with
their captured generation; live navigation to removed content shows unavailable.

Manual refresh previews the diff and commits selected changes. Desktop watch is
opt-in, off by default, debounce 2 seconds with a 30-second minimum scan interval
and 5-minute full reconciliation while the app runs; persist the setting and
reconcile on restart. No daemon runs after Borealis quits. Watch processes new and
changed in-scope files but retains missing files, obeys all limits, and pauses on
capacity/authorization failures with a visible explanation. One active refresh
per connection; repeated events coalesce. Network collection refresh is manual
initially; M16 consumes its explicit refresh-and-wait service.

Expose a shared `refreshAndWaitReady` service (proposed in
`server/src/knowledgeRefresh.ts`) accepting account ID, concrete connection IDs,
expected connection revisions, an exact managed-item/source allowlist per
connection, cancellation signal and caller deadline. Return
per-connection/per-item outcomes and the exact promoted source/generation pairs;
never turn partial success into a fully ready snapshot. M16's default refreshes
only already selected managed items. Newly discovered files require an explicit
workflow inclusion policy and normal preview/selection validation; a scheduled
refresh alone does not expand an analysis or chat source scope. Missing/stale
selected inputs are explicit outcomes for the caller's freshness policy.

### One useful authenticated integration

Implement a **read-only WebDAV collection** using application-password sign-in,
bounded `PROPFIND Depth: 1` traversal and `GET` into ordinary account/source upload
storage. This is indexed knowledge ingestion, distinct from an MCP tool call.
Store connection metadata and credentials server-side; public DTOs contain only
configured/status booleans. Use the shared connection-secret interface specified
in [MCP_CONNECTIONS.md](../docs/MCP_CONNECTIONS.md); implementing that facility
is a dependency for this transport, not a choice of a second secret store.
Preserve its desktop OS-key/browser private-key custody and archive semantics:
nonportable grants require reconnect after restore while stored artifacts remain
available. Include connection records in offline archive verification.
Do not overload the current URL connector schema with untyped payloads.

The connection form takes a collection URL, username, application password and
target library. Test access, show the bounded preview, then import. Remote hosts
require HTTPS; a loopback fixture and explicit private installations may use the
existing operator-supported local network policy. Preserve hostname/address
validation and DNS pinning; redirects cannot carry credentials to another origin.
Use an XML parser with entity/DTD expansion disabled, bounded response bytes and
element count. Each request has a 30-second ceiling; a refresh has a 10-minute
deadline, two download slots, durable cancellation, and retry-safe item commits.
Invalid auth displays reconnect; partial remote failures retain ready content and
report bounded per-item status. Reconnect updates only future transport snapshots.

### Inspectable search and evidence

Add library-scoped search with **Keyword** (default, no model request) and
**Semantic** (explicit, existing embedding/consent rules) modes. Filters support
source IDs and type; validate selected IDs against library membership and account.
Search acceptance captures a concrete ready source/generation set. Empty scope
returns an empty page, never all account content. Query limit is 1,000 characters;
at most 50 hits, 2,000 excerpt characters per hit, and 100,000 total returned text
characters. Keyword search uses scoped SQLite FTS5 over chunk text with a bounded,
escaped literal-query grammar; semantic search uses existing scoped Lance KNN.
FTS additions/deletions must follow SQLite promotion/cleanup transactions. Search
results are a bounded ranked set, not an unbounded catalog scan.

Expose an internal `searchCapturedScope` operation for M15 that accepts exact
account/source/generation identities captured at research acceptance. Validate
them at the scoped search and SQLite join; unavailable generations return
`source_changed`, never results from a newer generation. Ordinary library search
captures the current ready generations at its own acceptance instead.

Each hit returns source ID, generation, chunk ID, sanitized label, excerpt,
score/rank and typed locator. PDF locators have real 1-based page numbers and
text offsets within that page; text/Markdown/DOCX use extracted-text offsets and
heading when available; tabular evidence names sheet/table and row range only
when extraction actually knows them. Unknown locations are explicitly absent.
Do not fabricate DOCX page numbers or infer anchors from the model's answer.

Add a source passage panel with highlighted excerpt and bounded neighboring text.
PDF page inspection means extracted page text with the actual page label; a
raster preview is optional and cannot be required for this milestone. Extractor
output becomes structured segments; retain a text compatibility adapter for
existing callers. Old ingested sources show unlocated passages until explicit
reingestion, without an implicit workspace migration or mass embedding request.
Snapshots in M13/M15 use this same versioned locator/excerpt representation.

### Proposed API and persistence

Add typed stores/routes rather than filesystem operations in UI handlers:

| Endpoint | Contract |
| --- | --- |
| `POST /api/knowledge-connections` | Create `desktop_folder` from grant or `webdav` from validated form; return metadata, no credentials |
| `GET /api/knowledge-connections` | Endpoint-bound keyset catalog, default 25/max 100 |
| `PATCH /api/knowledge-connections/:id` | Version-checked name, watch setting, or credential replacement |
| `DELETE /api/knowledge-connections/:id` | Cancel work, remove mapping/secret/watch; retain sources/library |
| `POST /api/knowledge-connections/:id/previews` | Durable bounded scan; return preview/run ID |
| `GET /api/knowledge-previews/:id` | Exact-account diff and selection entries |
| `POST /api/knowledge-previews/:id/apply` | Commit selected entry IDs against exact preview revision; stale manifests return 409 |
| `GET /api/knowledge-refreshes/:id` | Exact-target status, bounded counts, errors, source-generation outcomes |
| `DELETE /api/knowledge-refreshes/:id` | Durable cancellation request |
| `POST /api/libraries/:id/directory-imports` | Idempotent copied-directory manifest commit against exact library revision |
| `POST /api/libraries/:id/search` | Explicit query/mode/filter; return captured generation scope and ranked hits |
| `GET /api/sources/:id/passages/:chunkId` | Owned current chunk with bounded neighboring text and locator; 404/410 when unavailable |

Proposed tables: `knowledge_connections`, `knowledge_items`,
`knowledge_refreshes`, `knowledge_refresh_items`, and `knowledge_previews`, all
account-scoped with connection/library ownership constraints. Store preview
selection/hash and item lifecycle explicitly; never store secrets in public JSON.
Expire uncommitted previews after 10 minutes and bound retained refresh history
to the newest 100 runs per connection. Durable committed work survives restart;
retry only incomplete items, using generation CAS to avoid duplicate promotion.
New SQLite FTS indexes contain text only, never vectors. Reconcile migration and
archive inventories centrally after v14–v16 land. Schemas and body ceilings must
be declared in routes, including multipart/browser selection manifests.

## Implementation slices and verification

Use `codex/` branches only if a new branch is needed; coordinate shared migrations
and API declarations with the root executor. Independent subagents can own
search/extraction, folder/WebDAV ingestion, and UI/tests after agreeing DTOs.

1. **Introduce metadata and lifecycle:** add proposed
   `server/src/db/stores/knowledgeStore.ts`, `server/src/knowledgeRefresh.ts`,
   routes and storage-runtime wiring. Implement preview/commit/cancel/recovery and
   stable identity before wiring UI. Verify with
   `pnpm --filter borealis-server test -- src/tests/knowledgeStore.test.ts src/tests/knowledgeRefresh.test.ts`
   (new test files; all pass) and server `typecheck` (exit 0).
2. **Import chosen content:** add proposed `server/src/knowledge/webdav.ts`,
   `server/src/knowledge/folder.ts`, narrow desktop picker/grant channel and browser
   directory upload, then reuse ingestion admission and promotion. Extend
   `desktop/src/main.ts`, `preload.cts` and backend protocol deliberately. Verify
   `pnpm --filter borealis-server test -- src/tests/knowledgeImport.test.ts`
   (new file; all pass) and `pnpm --filter borealis-desktop verify` (exit 0).
3. **Preserve locations and search:** extend `ingestSupport.ts`,
   `ingestionEngine.ts`, `db/stores/ingestionStore.ts`, `vector/retrieve.ts`;
   add proposed `server/src/sourceSearch.ts` and `routes/sourceSearch.ts`. Verify
   `pnpm --filter borealis-server test -- src/tests/sourceSearch.test.ts src/tests/sourceLocations.test.ts src/tests/ocrIngestionRetrieval.test.ts src/tests/retrieve.test.ts`
   (first two new; all pass).
4. **Expose the workflow:** add typed clients in `web/src/lib/api.ts`, import
   preview, refresh history, watch controls, search results and passage inspection
   under Libraries/Sources/Connections. Follow existing request-generation and
   busy-dialog patterns; show stale/missing status separately from canonical source
   ingestion tone. Verify `pnpm --filter borealis-web test -- src/pages/LibrariesView.test.tsx src/pages/SourcesView.test.tsx src/pages/ConnectorsView.test.tsx`
   and web `build` (tests pass; bundle budget passes).
5. **Run acceptance and document:** add proposed
   `server/src/tests/livingLibraries.integration.test.ts` to the explicit
   `server/vitest.integration.config.ts` inclusion list; add executable
   `scripts/e2e-living-libraries.mjs` for real browser/desktop acceptance using an
   isolated workspace and local authenticated WebDAV fixture. The script must
   fail on violated assertions, save content-free results/screenshots, and clean
   up owned processes only. Verify server `test:integration`,
   `node scripts/e2e-living-libraries.mjs`, and the final gates below (all exit 0).

## Required acceptance and regressions

- Import a chosen nested folder with a text PDF, OCR fixture, Markdown and CSV.
  Preview unsupported files; cancel leaves no sources. Import reaches ready and
  shows exactly selected members. Browser copied-directory behavior is labeled.
- Import from the authenticated WebDAV fixture through the real sign-in/preview
  path; bad credentials fail, reconnect succeeds, and downloaded files become
  searchable. This is a complete integration, not a mocked tool registration.
- Modify one file, leave one unchanged, add one, rename one, remove one. Preview
  matches the changes; apply reuses the modified source ID, avoids unchanged
  embedding calls, and retains missing content with a stale label. Failed refresh
  and restart leave earlier ready data readable. Watch repeats this while running;
  disabling watch stops new background work.
- Keyword and semantic queries find fixture evidence; explicit-empty and foreign
  source filters never widen results. Search captures ready generations. Page
  labels remain correct for embedded-text and OCR pages, and legacy chunks render
  an honest location-unavailable state.
- Attach library to a chat, then import another document: the existing selected
  chat scope remains unchanged. Previously saved evidence remains inspectable
  after refresh or upstream deletion, with original generation and stale state.
- Exercise limits, stale previews, concurrent refresh, cancellation, account
  isolation, offline archive/restore and source deletion during search. No stale
  UI completion repopulates a closed panel or deleted connection.

## Documentation and completion

Update `docs/API.md`, `README.md`, `desktop/README.md`,
`docs/MCP_CONNECTIONS.md` where the shared credential contract changes it,
`docs/PRODUCT_REVIEW.md`, relevant
archive guidance, `AGENTS.md` architectural invariants and `milestones/README.md`.
Keep `docs/VISION.md` as destination; describe only implemented baseline changes.
Record exact commands, environment, result and evidence artifact paths here.

Completion requires `pnpm verify`, `pnpm --filter borealis-desktop verify`,
`pnpm package:unsigned`, `pnpm --filter borealis-desktop package:native:smoke`,
`pnpm --filter borealis-desktop package:entitlements:smoke`, and the executable
E2E flow above to exit 0. Verify a real configured local model for semantic
search in addition to deterministic fixtures. Do not claim a live-provider or
native-picker check passed when it was skipped. Resolve routine failures and
contract drift; report an external blocker only when it cannot be resolved
within the authorized scope, keeping the milestone unfinished with the exact
remaining acceptance check. No migration renumbering, arbitrary path reader,
silent destructive sync, or inferred source-scope expansion is an acceptable
shortcut.

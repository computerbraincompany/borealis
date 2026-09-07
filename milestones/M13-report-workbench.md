# M13 — Editable report and document workbench

## Status and execution contract

- **Status:** IMPLEMENTED — browser, live-model and repository acceptance pass;
  final native packaged UI acceptance awaits Keychain approval for the rebuilt app.
  [EXECUTION.md](EXECUTION.md) records current gates and retained evidence.
  Baseline descriptions and dated execution records below are historical
  context; they do not supersede the current API or acceptance status.
- **Priority / effort / risk:** P1 / L (multiple days) / high: artifact identity,
  editing, model proposals, publication, and rendering must agree.
- **Baseline:** `e2e6a78`, inspected 2026-09-06.
- **Depends on:** prerequisite closure in the [development handoff](../docs/DEVELOPMENT_HANDOFF.md).
  Manual editing can be built independently of M12; attaching/refreshed numeric
  tables requires [M12](M12-saved-analyses.md). Allocate product migrations only
  after reserved remediation v14–v16 actually land, at the next free version
  >=17, coordinating with other milestone owners. Never rewrite applied history
  or add empty migrations to skip prerequisites.
- **Result:** open an existing report as an editable document, correct prose,
  request a rewrite of a selected section or passage, review the diff, publish
  an immutable version with evidence, and export it in HTML/PDF/Markdown/DOCX.

Read this spec and `AGENTS.md` first. Run
`git diff --stat e2e6a78..HEAD -- server/src web/src desktop/src desktop/scripts`.
Reconcile current code and completed prerequisites with these excerpts before
implementing. Investigate and fix drift or failed validation; neither is a
reason to silently reduce scope or call the milestone complete.

## Why this matters

`docs/VISION.md` makes durable artifacts the product and names documents with
versions. Borealis currently generates reports, but a user must return to chat
to change content. A document editor lets users preserve valuable analysis,
correct the narrative without recalculating numbers, and review model-proposed
changes before publishing them. It provides the draft substrate needed by M16's
reviewed recurring briefs.

## Current implementation

- `server/src/data/reports.ts:47` defines `NormalizedReport` as `title`,
  `subtitle`, `generated_at`, `sections`, `charts`, and `tables` with optional
  `account_id`. A `ReportSection` has only `heading` and `markdown`; sections do
  not have stable identities. `normalizeReport` at line 94 rejects unknown keys
  using `exactKeys`; an evidence appendix is **not** a current payload field.
- Existing renderer bounds include 20 sections, 50,000 characters per section,
  20 canonical charts, eight tables, 32 columns, 60 rows per table, and 500
  characters per table string cell. `server/src/tools.ts` further bounds total
  section text to 200,000 characters and table data to 100,000 characters/1,000
  cells. Preserve these effective limits when compiling documents to reports.
- `server/src/db/stores/runStore.ts:330` uses
  `MAX_REPORT_PAYLOAD_CHARS = 400_000`. The stored normalized payload is optional;
  oversize payloads are dropped without failing report generation.
- `runStore.ts:822` selects the newest **published** report in the chat to assign
  `version` and `supersedes`; failed-run pending artifacts never join that chain.
  This is a per-chat chain, not a stable document identity or editable history.
- `server/src/routes/reports.ts:88` returns normalized `payload` only to the
  owner. Shared recipients receive read-only detail and HTML/PDF; the PATCH
  endpoint changes title only. Rename does not rewrite exported content.
- `web/src/pages/ReportsView.tsx` provides a gallery, preview, rename, download,
  delete, and same-instance share controls. Its request generation and busy
  dialog patterns are exemplars for the new editor.
- `server/src/citations.ts` builds citation metadata from the current run's
  sanitized evidence. `server/src/tools.ts` retains at most eight passages,
  800-character excerpts, 6,000 total evidence characters. A report payload does
  not currently carry a complete document-level evidence contract.
- `server/src/data/playwrightRender.ts`, `desktop/src/electronRenderer.ts`, and
  `server/src/data/charts.ts` implement bounded static rendering and canonical
  charts. Use the same boundary for all formats rather than introducing browser
  navigation to report HTML.

## Product contract — new behavior to implement

### Stable documents, immutable revisions, and publication

Create owner-scoped `documents`, `document_revisions`, and
`document_publications` in SQLite, with stable document UUIDs distinct from
legacy report IDs. A document has a title, current head revision, origin links
(optional report/chat/run/analysis result), timestamps, and owner. A revision
contains an immutable normalized document tree with stable section/block UUIDs,
frozen chart/table values, evidence snapshot, and author kind (`user`, `model`,
`automation`). Keep full snapshots at these bounded sizes; do not build a complex
collaborative editing/operational-transform system in this milestone.

The editor creates revisions with `base_revision_id` compare-and-swap. A stale
write returns 409 with current head metadata; it must preserve the local draft
and offer a diff/reload or explicit reapply. Never silently merge model output
onto new text. Document title updates also use revision checking so title and
exported title agree. No published revision is overwritten by rename or editing.
Save explicit revisions; debounce may save drafts only with exact-target and
base-revision protection. Do not create a revision for every keystroke.

“Create editable copy” of an **owned** legacy report snapshots its stored payload
and available verified origin metadata into document revision 1. Copying does
not change the report ID, its per-chat version chain, or existing share links.
Reports missing normalized payload show a clear unavailable-editable-copy state;
the user may create a new blank document and copy text explicitly. Never scrape
rendered HTML or grant a share recipient access to the owner's stored payload to
pretend legacy editability exists. Source/report/chat deletion after copying
must not destroy a document's frozen contents or copied evidence.

A saved document revision is a draft until the owner explicitly publishes it.
Publication renders artifacts to exact account/document/publication UUID-scoped
paths, validates them, and transactionally assigns the next per-document
publication version only after all required artifacts exist. Use publication
intent/cleanup records with crash recovery, following `reportCleanup.ts` and
`storageArtifacts.ts`. A failed render leaves a retryable draft and cannot change
the latest published version. A retry operation UUID is idempotent. Bound one
active render/publication per document. Publishing a stale non-head revision
requires an explicit selection in version history; the default action must
reject a changed head rather than publish unseen content.

Existing completed chat turns continue publishing legacy reports exactly as
today. M13's new draft/publication semantics apply to documents, not retroactively
to legacy reports. New document versions are owner-only in this milestone;
existing same-instance report sharing remains unchanged. A future sharing
extension must use explicit frozen-publication grants, not expose drafts.

### Section editing and model-assisted proposals

Provide a simple section editor: add/remove/reorder sections, change headings,
edit Markdown, and include frozen canonical charts and result tables. Use stable
IDs rather than array offsets as mutation targets. Preserve unchanged content
exactly. Manual text changes must not issue SQL or model calls. The editor shows
an explicit unsaved state, save/publish progress, recoverable conflicts, version
history, and side-by-side textual/table diffs.

“Rewrite selection” accepts an exact document/base revision, section UUID, and
optional UTF-16 text range plus hash of the selected text; whole-section rewrite
is supported. Reject invalid ranges (including split surrogate pairs) and
mismatching hashes. Bound instructions to 2,000 characters, selection to 8,000,
context text to 24,000, and proposed replacement to 20,000 characters, also
respecting any lower provider/agent prompt budget. For a section larger than the
selection bound, require a smaller selection. Do not send the whole workspace.

Use the existing model-provider configuration, account consent gate, provider
snapshot, cancellation, and bounded streaming tool-call validation. A rewrite
is a durable model operation with exact document/base/selection target and no
arbitrary tools. Add a distinct lifecycle service; do not create fake chat runs
or bypass their one-active-run contract. The prompt can use only the revision's
selected text and copied evidence/data context. New research/retrieval is an
explicit separate action with an explicit selected source scope; M15 provides
that later. No implicit all-source retrieval or MCP execution occurs in rewrite.

Model output becomes a proposal containing the original base target, replacement
text, stable evidence references, model identity, and generic status. It does
not mutate the document until the user accepts. Show a diff with accept/reject;
acceptance creates a new revision only if the head and selection still match.
A stale proposal remains inspectable but cannot replace newer content. Cancellation
and restart leave no half-applied rewrite. One active rewrite per document;
proposals are owner-scoped and bounded to 100 retained proposals per document,
with explicit deletion once the quota is reached.

### Evidence, data refresh, templates, and export

Introduce a versioned document evidence contract separate from raw model text:
up to 100 references, each with stable document-local UUID, source ID and source
name, generation/content identity when verified, optional page/locator when known,
and excerpt <=800 characters; aggregate serialized evidence <=100,000 characters.
Analysis-backed tables also copy analysis revision/result ID, typed parameters,
selected source generations, column/schema metadata, and completeness flags.
Only server-verified origin records can populate these fields. Source names and
locators remain data; do not interpret their text as commands or paths.

Create evidence from the actual originating run's sanitized array or the saved
analysis result. When origin evidence is unavailable, mark the document
unverified/manual; never invent page numbers, citations, exact source versions,
or retrieval scores. Historical missing generation metadata is `unknown`, not
silently upgraded to the source's current generation. The current eight-passage
run cap remains unchanged; a larger document envelope is for reviewed additions
from multiple runs, not permission to widen an individual agent call's evidence.

Maintain stable references internally and assign deterministic display numbers
per revision. Unresolved citation tokens remain plain text/unverified in the UI;
never match them against arbitrary workspace chunks. Show the evidence appendix
and validity state in the editor and each exported publication. Manual claims
are allowed and clearly distinguished from cited claims; model-generated invalid
references cannot become verified citations. Deleting a source marks live access
unavailable while its already copied bounded excerpt remains in the revision.
Do not leak document evidence through existing recipient report-detail routes.

Attaching an M12 result copies its values and provenance. “Refresh table” accepts
an explicit newer result ID, displays the deterministic changed values/schema/
source summary, and requires acceptance into a new revision. It does not rerun
SQL, replace old document revisions, or silently rewrite surrounding prose. An
optional follow-up rewrite remains a separately reviewed proposal. M16 may
compose these services to make a new draft.

Provide three built-in templates: monthly financial brief, evidence memo, and
comparison report. Also allow saving a document's structure as an owner-scoped
reusable template. Template snapshots copy headings, bounded instructions,
formatting, and empty placeholders; **exclude** source excerpts, numeric results,
credentials, and selected source bindings by default. Applying a template makes
a draft with an explicit source/data attachment step. Bound custom templates to
100 per account, using the document size limits. No template executes tools or
schedules work simply by being created.

Publish self-contained HTML and static PDF through the existing bounded renderer;
add Markdown export as a ZIP bundle with a real `.md` file, relative canonical
chart PNG assets, and provenance manifest; add DOCX with native paragraphs,
headings, tables, citations/appendix, and embedded canonical chart PNGs. Exports
are derived from the **same frozen revision**. The Markdown bundle contains no
remote image dependencies, absolute private filesystem paths, or executable
macros; DOCX has no macros, linked remote images, or external document fetching.
Use a maintained Node DOCX writer, added through the root pnpm workspace and
mirrored into desktop runtime dependencies where required. Do not shell out to
an uninstalled office suite to generate DOCX.

The document tree must compile to existing renderer bounds: 20 sections,
200,000 total Markdown characters, 20 charts, eight tables with their current
row/column/cell limits, and a total stored revision <=400,000 characters including
evidence. Reserve space for the evidence appendix within compiled section/text
limits (or render it through an explicit separately bounded shared appendix
contract); a 20-section draft cannot fail only at export because an unchecked
21st section was appended. Reject oversize edits before saving; unlike optional legacy report
payloads, an editable document cannot silently drop its tree. Exports also obey
existing lower render-payload/time/output limits, with new Markdown/DOCX output
ceilings of 20 MiB each. Report every format failure explicitly and leave the
publication retryable. Preserve the deny-by-default render network policy,
canonical chart contract, 12-character chart-ID fallback for model-generated
legacy reports, and current legacy report normalization.

## Proposed API and service interfaces

These are new owner-authenticated resource routes, with exact schema/body limits
and keyset catalogs; do not document them as shipped before their tests pass.

| Route | Contract |
| --- | --- |
| `GET/POST /api/documents` | Owner catalog; blank/template/owned-report copy creation |
| `GET/DELETE /api/documents/:id` | Document metadata/current head; deletion with durable artifact cleanup |
| `GET/POST /api/documents/:id/revisions` | History; save tree against `base_revision_id` |
| `GET /api/documents/:id/revisions/:revisionId` | Immutable owner revision |
| `GET /api/documents/:id/diff?base=…&target=…` | Deterministic bounded revision diff |
| `GET/POST /api/documents/:id/rewrites` | List/accept bounded model operation against exact revision/selection |
| `GET/DELETE /api/documents/:id/rewrites/:rewriteId` | Operation/proposal state; cancel/delete retained proposal |
| `POST /api/documents/:id/rewrites/:rewriteId/accept` | Revision-checked proposal acceptance; new draft revision |
| `POST /api/documents/:id/revisions/:revisionId/publish` | Operation UUID + expected head; render and publish, 202/status resource |
| `GET /api/documents/:id/publications` | Owner publication history and render status |
| `GET /api/documents/:id/publications/:publicationId/export?format=html\|pdf\|markdown\|docx` | Exact frozen version export |
| `GET/POST /api/document-templates` | Template catalog/create |
| `GET/PATCH/DELETE /api/document-templates/:id` | Owner template detail/revision-checked edit/delete |

Expose internal `createDocumentDraft`, `appendDocumentRevision`, and
`publishDocumentRevision` services with authenticated owner, immutable payload,
operation UUID, expected revision, and optional origin recipe-run ID. M16 calls
these services; it must not write document tables directly. Recipe output is a
saved draft with no publication until its separate review-inbox approval.
Approving that inbox calls publication idempotently for the exact reviewed
revision; later edits invalidate the approval target. M13 itself provides manual
publish controls; it does not create the M16 inbox or automatically approve work.

## Implementation sequence and files

Work in the current authorized branch or a `codex/` branch if isolation is
needed. Commit passing logical units, without pushing unless asked. Delegate
renderer/export tests and UI against a frozen API independently if useful; one
agent owns migrations and shared document types, and the integrating agent owns
publication/rewrite races and end-to-end evidence.

1. **Add document persistence and revision semantics.** Create
   `server/src/documentTypes.ts`, `server/src/db/stores/documentStore.ts`, and
   `server/src/tests/documentStore.test.ts`. Integrate the next legal migration,
   storage runtime, archive verification, keyset pagination, quotas, compare-and-
   swap, provenance copies, and legacy-copy behavior. Keep `runStore.ts` legacy
   publication logic intact. **Gate:**
   `pnpm --filter borealis-server typecheck` and
   `pnpm --filter borealis-server test` exit 0. Add ledger tests to the explicit
   include list in `server/vitest.integration.config.ts`; run
   `pnpm --filter borealis-server test:integration` successfully.
2. **Build editing, diff, and templates.** Add
   `server/src/routes/documents.ts`, `server/src/documentService.ts`,
   `web/src/pages/DocumentWorkbench.tsx`, API types, new lazy routing, and tests;
   add editable-copy action in `ReportsView.tsx`. Use existing UI primitives and
   request generation patterns. Include evidence inspector and frozen analysis
   attachment/refresh once M12 is available. **Gate:** server tests plus
   `pnpm --filter borealis-web typecheck`, `pnpm --filter borealis-web test`, and
   `pnpm --filter borealis-web build` all exit 0.
3. **Add rewrite proposals.** Add `server/src/documentRewriteRunner.ts` and
   lifecycle integration in server startup/shutdown, bounded status routes,
   selected-range controls, and accept/reject diff. Test model/provider snapshot,
   cancellation, restart, malformed responses, stale selection, and stale head.
   Reuse server-defined sanitized status summaries; never stream raw provider
   reasoning or exceptions. **Gate:** server and web test suites exit 0; a
   deterministic local fixture provider produces an accepted proposal and a
   rejected stale proposal through actual HTTP routes.
4. **Implement publication and all export formats.** Add
   `server/src/data/documents.ts` to compile the frozen tree and evidence into
   each format, extend existing renderer contracts only with shared versioned
   types, and integrate exact UUID-scoped artifact cleanup. Add
   `server/src/tests/documents.test.ts` and publication route/lifecycle tests;
   extend desktop render tests and packaging inputs if necessary.
   **Gate:** `pnpm verify` prints `ALL GATES GREEN`;
   `pnpm --filter borealis-desktop verify` exits 0 and renders valid PNG/PDF.
5. **Complete E2E proof and docs.** Update `README.md`, `docs/API.md`,
   `docs/VISION.md` current-artifact sections, `AGENTS.md` publication/evidence
   semantics, `desktop/README.md` when packaging changes, and the milestone
   ledger/execution record. Run the shared
   [end-to-end acceptance](../docs/END_TO_END_ACCEPTANCE.md) plus the scenarios
   below. **Gate:** all commands and scenarios pass; commit evidence and docs
   with implementation, then mark the ledger DONE.

Supporting bootstrap, route schemas/OpenAPI, worker lifecycle, archive metadata,
artifact helpers, dependency declarations, and tests are in scope where required
by this behavior. No general canvas/spreadsheet, real-time coediting, external
publishing, automatic email, or rich third-party template marketplace is needed.
Do not replace the legacy report identity chain to avoid implementing a document
identity properly.

## End-to-end acceptance and done criteria

Use an isolated browser workspace and Apple Silicon desktop profile. Upload the
personal-finance CSV fixtures and create a real report with a query table and
chart. Create an editable copy; correct one sentence without any model/SQL call;
verify the legacy artifact is byte-for-byte unchanged. Request a selected-passage
rewrite against a real local model, inspect the actual diff, reject once, retry,
and accept. Confirm unrelated sections and numeric values remain unchanged.
Concurrently change the section/head and prove an old proposal cannot overwrite
it. Restart and recover the saved document/rewrite states truthfully.

Attach an M12 result, create a newer analysis result from controlled changed
input, review a table refresh, and accept it into a new draft without silently
changing the prose. Publish two document versions and verify revision-specific
numbers, text, evidence appendix, chart values, and immutable older exports.
A failed or cancelled render must leave the prior publication current. Retry
with the same operation UUID and verify one publication. Save a template and
instantiate it without carrying private evidence or obsolete source bindings.

Download HTML, PDF, Markdown ZIP, and DOCX from the actual browser and packaged
app. Parse archives/documents to assert exact fixture text and table values,
relative image assets, and evidence entries; check PDF/PNG signatures and ZIP
members. Open rendered HTML and PDF visually, inspect every page for clipped
content, and inspect DOCX in a local viewer capable of rendering it. Render the
Markdown bundle in a viewer with relative assets and check its citations and
chart images. Record content assertions and visual evidence, not just nonempty
files. Do not claim DOCX visual validation if no viewer/renderer was available.

Unit/integration tests must cover missing legacy payload; copied unknown
provenance; unresolved citation tokens; stable numbering after reorder; deleted
source/report origins; same-instance recipient denied editable-copy/payload;
conflicting saves and out-of-order UI responses; exact Unicode selection;
malformed/oversize model output; explicit quotas; template data exclusion;
truncation labels in attached tables; cross-account IDs; output bound/render
failure; cleanup after crash; and package runtime resolution of new dependencies.
Use `server/src/tests/reports.test.ts`, `reportChartRoutes.test.ts`,
`runStore.test.ts`, and `web/src/pages/ReportsView.test.tsx` as testing patterns.

Run `pnpm verify`, `pnpm --filter borealis-desktop verify`,
`pnpm package:unsigned`, `pnpm --filter borealis-desktop package:native:smoke`,
and `pnpm --filter borealis-desktop package:entitlements:smoke`; all must exit 0.
Use an absolute isolated `--user-data-dir` and keep the real user workspace
untouched. Record date, commit, commands, actual browser/packaged workflows,
artifact assertions, and local model identity without credentials or raw private
content. A mock model supplements but does not replace the live-model acceptance.

DONE means every named edit/rewrite/evidence/template/publication/export flow,
all required tests, docs, and end-to-end evidence are complete. Continue fixing
failures rather than leaving implementation TODOs. When a required external
runtime/viewer is genuinely unavailable, report the exact unresolved acceptance
step and keep the milestone incomplete; do not report a clean completion.

## Execution record 2026-09-06 (stage 4 — publication and all four export formats)

Branch `codex/m13-document-workbench`, base `353ed2e` (main at dispatch; main
subsequently advanced ~20 commits with other stages — the report compares the
five stage-4 commits against that merge base; merging is the coordinator's
step). No new schema version was needed: the stage-1 v20
publications/intents/cleanup tables and triggers carried the whole protocol
(v25 remains the next free product slot, unused).

Implemented for real:

- `server/src/data/documents.ts` — one compile of a frozen revision through
  the existing bounded renderer pipeline produces all four artifacts with
  magic-byte validation before any write: self-contained static HTML (embedded
  canonical PNGs, no external refs), static PDF (existing Playwright/Electron
  dispatch — the deny-by-default desktop render contract is untouched), a
  deterministic Markdown ZIP (real `document.md` with relative
  `assets/chart-N.png` references, `manifest.json` provenance, hand-rolled
  deterministic ZIP writer with a strict reader/CRC validator; no remote refs,
  absolute paths, or macros), and DOCX through the pinned `docx@9.7.1`
  workspace dependency (native headings/paragraphs/tables, embedded PNGs,
  citations appendix; no macros or linked media). Typed per-format failures
  (`PUBLICATION_{HTML|PDF|MARKDOWN|DOCX}_FAILED`) leave the publication
  retryable. Markdown/DOCX ceilings: 20 MiB each.
- `server/src/data/reports.ts` — the shared report contract gained the shared
  versioned fields only: optional `appendix` (≤150,000 chars, final bounded
  block) and `status` (≤300 chars, masthead pill). Legacy payloads normalize
  byte-identically; the 20-section + appendix compile can never fail at
  export because the appendix rides its own field, not a 21st section.
  `documentTypes.ts` adds deterministic validity/appendix builders marking
  each reference provenance verified or unknown.
- Publication flow: `documentService.publishDocumentRevision` drives the
  durable intent protocol (operation-UUID idempotency, expected-head guard,
  explicit non-head selection bit, one active render per document in-process
  plus the store's partial unique index), writes to the exact
  account/document/publication-UUID directory, records `ready` only with both
  required paths, and assigns the next version transactionally only after all
  four verified artifacts exist; failures mark the intent durably failed and
  remove the exact partial directory. Startup wires
  `repairDocumentPublications()` (interrupted renders → durable
  `SERVER_RESTARTED` failures + exact-directory cleanup, never auto-publish)
  and `repairDocumentArtifactCleanup()` into `startBorealisServer`. Routes:
  real `POST .../publish` (201/200 replayed/202 rendering; 409
  `DOCUMENT_REVISION_CONFLICT`/`DOCUMENT_HEAD_MOVED`/`DOCUMENT_REVISION_SELECTION`/
  `DOCUMENT_PUBLICATION_ACTIVE`; 502 per-format failure), owner-only
  `GET .../publications/:publicationId/export?format=html|pdf|markdown|docx`
  serving exact frozen bytes behind an anchored path resolver, and
  `publication_status` on the document detail. Deletion cleanup proves the v20
  trigger end-to-end.
- Web: workbench publish button (saved-head only, expected head sent,
  operation UUID reused across retries of one attempt), per-history-row publish
  with the explicit selection bit, active/head-moved conflict surfaces,
  publication history with four-format authenticated downloads and the
  sandboxed report-preview preview path, plus provenance-verified/unknown
  badges matching the server contract.
- Tests: `documents.test.ts` (integration partition, 10 tests — four-format
  compile matrix with verified/unknown evidence and unresolved tokens,
  20-section + 40-reference appendix compile, injected bad-magic refusals, one
  real-Playwright default-renderer contract proof, operation replay, head-move
  rejection at completion, explicit non-head publish, crash-mid-render startup
  recovery, one-active render, per-format failure + exact-directory cleanup +
  retry, owner-only exports, deletion-cleanup repair). Route matrix (19 tests
  in `documentsRoutes.test.ts`, deterministic via a test-only renderer seam
  mirroring `__renderIsolatedHtmlPdfForTests`). Workbench tests (+6 in the
  373-test web suite) cover publish busy rules, dirty guard, conflict surfaces,
  non-head selection, retry-UUID reuse, exports, and preview.

Exact commands and outcomes (repo root, Node 22.22.3, pnpm 10.x):

- `pnpm --filter borealis-server typecheck|lint|format:check|build` → exit 0.
- `pnpm --filter borealis-server test` → 1119/1119 (86 files). (The first
  full-unit run before the route-test seam flaked 1/1119 under turbo parallel
  load — real Chromium launches contending; the seam made the route tests
  browser-free and every subsequent full run is green.)
- `pnpm --filter borealis-server test:integration` → 331/331 (25 files,
  serialized).
- `pnpm --filter borealis-web typecheck|test|lint|format:check|build` → exit 0
  (47 files / 373 tests; budgets: initial 232955/245760, largest lazy
  121426/133120 gzip bytes).
- `pnpm --filter borealis-desktop verify` → exit 0: native isolation smokes
  under Node and the Electron utility process, and the hidden-renderer smoke
  `{"ok":true,"png_bytes":28231,"pdf_bytes":16303,"network_hits":0,`
  `"blocked_unsafe_requests":2}` — document exports reuse the same compiled-HTML
  contract, so the desktop render path stayed green without contract changes.
- `pnpm policy` → exit 0.
- `pnpm verify` → `ALL GATES GREEN` (16/16 tasks), run twice after the final
  commit set.

What remains before this milestone can be marked DONE (stage 5): the shared
end-to-end acceptance run in an isolated browser workspace and packaged Apple
Silicon profile (journey C: fixtures → report → editable copy → live-model
selected-passage rewrite with reject/retry/accept → M12 table refresh →
publish two versions with immutable older exports → real browser and packaged
downloads of all four formats with content assertions and visual inspection,
including a DOCX viewer); `pnpm package:unsigned` plus
`package:native:smoke` and `package:entitlements:smoke` proof that `docx`
resolves in the packaged runtime; the live-model acceptance record; and the
stage-5 ledger/`END_TO_END_ACCEPTANCE`/AGENTS/VISION alignment. Spec status is
deliberately left TODO.

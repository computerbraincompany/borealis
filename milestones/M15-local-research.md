# M15 — Durable local research and comparison tables

## Status and execution contract

- **Status:** TODO — selected for implementation handoff on 2026-09-06.
- **Priority / effort:** P1 / L.
- **Baseline:** `e2e6a78`, 2026-09-06; proposed behavior below is not shipped.
- **Dependencies:** M14 source search/locators; M13 editable artifact revisions
  and evidence snapshots. Reuse M12 typed result conventions where applicable.
  Schema v14–v16 remediation must land first; coordinate the next free product
  migration at or above v17, never assuming a milestone number is a schema number.
- **Outcome:** users state a question, review an editable plan, gather a local
  evidence dossier, resolve gaps/conflicts, and produce a cited memo or a typed
  comparison table that can be corrected and rerun without losing history.

Read `AGENTS.md`, `docs/VISION.md`, `docs/API.md` and the M13/M14 specifications.
Run `git diff --stat e2e6a78..HEAD -- server/src web/src` and reconcile changed
entry points before coding. This specification supplies the defaults for routine
product decisions. Update it as interfaces are implemented; complete all slices,
documentation and end-to-end proof before marking DONE.

## Verified current state

- `server/src/tools.ts` exposes the built-in `retrieve`, `list_sources`,
  `query_data`, `describe_data`, `render_chart`, `create_report`, and `fetch_url`
  contracts. There is no durable research plan/dossier/table domain today.
- `server/src/agent.ts` is the shared bounded streaming agent loop. Reuse its
  provider call accumulator and cancellation semantics; do not create a second
  permissive provider transport or reveal reasoning in a research activity panel.
- `server/src/retrieve.ts` currently has the explicit guard
  `if (!query.trim() || !allowedSourceIds.length) return [];`.
  `server/src/vector/retrieve.ts` captures ready generation scopes, then passes
  `accountId`, `sourceIds`, `sourceGenerations`, `vector`, and `limit` to Lance.
  Research must keep that same explicit source boundary.
- `server/src/db/stores/runStore.ts` currently declares
  `ChatRunStatus = "running" | "cancelling" | "completed" | "failed" | "cancelled"`.
  It owns chat lifecycle and chart/report publication. A research job needs its
  own durable identity, while child turns retain one active run per chat.
- `server/src/citations.ts`, `buildCitations`, resolves only the run's own
  sanitized evidence array and caps chat citations at eight. A dossier may have
  more entries, but must not alter existing chat numbering or cite uncaptured text.
- `server/src/routes/reports.ts`, `server/src/data/reports.ts` and
  `web/src/pages/ReportsView.tsx` are existing report integration points. M13 will
  add editable versioned output; use that final contract, not a second editor.
- `web/src/App.tsx`, `web/src/lib/api.ts` and `web/src/pages/ChatView.tsx` are
  entry points for a lazy Research page and a chat-to-research action.

## Research workflow and durable contracts

### Definition and reviewed plan

A research definition contains title (1–120 characters), question (1–4,000),
explicit source IDs (1–100 ready sources), optional library provenance,
explicit chat model, output kind `memo | comparison`, and a versioned plan.
Library selection expands to concrete source IDs when saving/starting; additions
to the library never implicitly join a run. Selected-empty remains valid for
editing a draft but Start is disabled with an explanation. Starting with unready
or removed selected sources returns a precise readiness conflict; do not silently
drop them. Users may explicitly revise the selection and start a new revision.

Use a Research page: question/scope → plan → running progress → dossier/table →
reviewed artifact. A model can propose at most eight ordered steps, each with a
user-facing objective and search questions. Users edit/reorder/remove steps before
Start. Plan generation is itself bounded/cancellable and creates no execution
approval implicitly. The default plan follows find relevant evidence, compare
claims, identify gaps and conflicts, synthesize output. Display task summaries,
counts and states; no provider reasoning or raw transport payloads.

The first implementation executes sequentially. Bound each research run to eight
steps, 32 search operations, 40 model requests including planning/synthesis,
100 captured evidence items, 2,000 characters per evidence excerpt, 200,000 total
evidence characters, and 15 minutes wall time. Each model/tool call also retains
existing lower-level time/output limits and consent checks. Step prompts select
bounded relevant evidence, never concatenate the whole dossier into every call.
Budget exhaustion finishes as `needs_review` with explicit gaps and preserved
partial work, never as a successful exhaustive answer. These are independent
research orchestration limits; do not increase the ordinary sixteen-round chat
loop to accommodate them.

### Dossier and supported conclusions

Capture immutable evidence at retrieval time: stable evidence ID, source ID,
generation, chunk ID, sanitized source label, locator, exact bounded excerpt,
content hash, retrieved time and query/step ID. Use M14's locator type. Generation
refresh or source deletion cannot replace the text supporting a historical claim.
Source navigation may become unavailable; the captured quote remains readable.
Acceptance pins source membership and generation identities. Search each step
against that generation contract; if a required generation is no longer available
before its evidence was captured, stop that step with `source_changed` and retain
partial work for review. Do not silently continue against a newer generation.
An explicit rerun captures current generations and links the prior run.

Claims reference only evidence IDs actually captured in this run. Classify a
claim as supported, conflicting or unsupported; record gaps separately. Conflicts
link at least two differing excerpts and explain the difference, without choosing
a winner by fabricated confidence. No evidence is represented as "not found in
selected evidence", not proof that a fact does not exist. Users can accept/reject
claims, add notes, correct synthesized prose, and flag evidence irrelevant. Preserve
original machine output and user revisions with timestamps; notes are not silently
promoted into source evidence. Restrict each claim to five evidence references and
2,000 text characters; at most 100 claims and 50 explicit gaps per run.

### Typed document comparison

For output kind `comparison`, user defines up to 20 columns: stable column ID,
label (1–80), question (1–500), type `text | number | date | boolean | enum`,
optional unit, and enum choices (max 20). Rows correspond to selected documents
(max 100), keyed by source ID and captured generation. A cell holds typed
`value | null`, status `supported | conflicting | not_found | invalid`, up to five
evidence IDs, and a bounded explanation. Text cell maximum is 2,000 characters;
the complete serialized table is capped at 1 MiB with an explicit limit state.
Numbers must be finite, dates ISO calendar dates, and enum values exact allowed
members. Unsupported model types become `invalid`, never string-coerced facts.

The table supports sort/filter, evidence-on-click, per-cell correction/review,
and rerun selected columns or rows. Correction stores an overlay with provenance;
rerun creates a new result revision and carries user overrides visibly, never
silently overwrites them. Show original/extracted/corrected values and changed
cells between run revisions. Export CSV with formula-safe text escaping and a
companion JSON evidence/locator manifest. Use the M13 workbench to produce a
memo/HTML/PDF including citations and gap/conflict disclosures. A failed or
cancelled run cannot publish a report through an uncommitted child turn.

Project research output into M13's smaller document limits: at most 60 rows,
32 columns and 1,000 cells within its 400,000-character total revision budget, and at
most 100 evidence entries with 800-character quoted excerpts. Preserve stable
evidence identities/hashes and label shortened excerpts and table previews.
The full bounded dossier and comparison remain available through this milestone's
CSV/JSON export; document creation must not silently truncate or mutate them.

### Lifecycle, API and storage

Add `research_definitions`, `research_definition_revisions`, `research_runs`,
`research_steps`, `research_evidence`, `research_claims`,
`research_table_cells`, and `research_reviews` as typed account-scoped ledger
entities (table names proposed). Store explicit JSON schemas only for bounded
structured values, not opaque provider dumps. A run captures definition revision,
model/provider authorization snapshot, concrete source generations and budgets.
Default concurrency: one active run per definition, one executing research run
per account, with at most ten queued per account. Additional start requests for
the same active definition return 409 and its existing run identity.

States: `queued → running → needs_review | completed | failed | cancelled`;
`cancelling` may represent an accepted cancellation request. `completed` requires
all required steps and final schema validation, and means computation finished;
publication still requires an explicit reviewed-artifact action. Users can open
partial `needs_review` output, but the UI must never label it complete research.
Persist step outcomes before advancing. Restart marks an interrupted step pending
and retries at most once using the same step identity; evidence inserts deduplicate
by run/source/generation/chunk/excerpt hash. If a lost response would risk duplicate
publication, reconcile persisted artifact references before retrying. Shutdown,
cancel and model/provider change admission follow existing durable run conventions.

| Endpoint | Proposed operation |
| --- | --- |
| `GET/POST /api/research` | Keyset catalog (25 default/100 max), create draft |
| `GET/PATCH/DELETE /api/research/:id` | Owned detail; revision-CAS edits; delete after cancelling own active work |
| `POST /api/research/:id/plan` | Generate bounded editable plan proposal; never start execution |
| `POST /api/research/:id/runs` | Start exact definition revision; optional prior-run/row/column rerun selection |
| `GET /api/research/:id/runs` | Keyset run history |
| `GET /api/research-runs/:id` | State, steps, counts and paged dossier/result references |
| `GET /api/research-runs/:id/evidence` | Keyset captured evidence, 25 default/50 max |
| `GET /api/research-runs/:id/table` | Bounded column schema and keyset rows, 25 default/100 max |
| `DELETE /api/research-runs/:id` | Durable cancellation request; repeat is idempotent |
| `PATCH /api/research-runs/:id/review` | Revision-CAS claim/cell/note review operations, at most 100 per request |
| `POST /api/research-runs/:id/artifacts` | Create M13 reviewed draft/version using captured evidence and overlays |
| `GET /api/research-runs/:id/export` | CSV or JSON manifest of exact result revision |

Use exact-target status polling, visibility/backoff, abortable navigation and
generation-checked UI mutations. Accept no account IDs, arbitrary source paths,
unbounded model prompts or unvalidated evidence IDs from the client. Review and
publication buttons distinguish computation completeness from human acceptance.

## Scope boundaries

This milestone searches the selected local corpus. Existing explicit-URL
`fetch_url` behavior remains available in ordinary chat; research neither performs
web discovery nor follows links found inside documents. Browsing, broad memory,
arbitrary code execution, multi-agent runtime orchestration, email delivery and
automatic external publishing are outside this milestone. The implementation
agent may use development subagents for independent code/tests; this does not
require shipping runtime subagents. Product "research" is judged by reviewable
evidence and repeatability, not by a cosmetic thinking display.

## Implementation and test sequence

Use small logical commits; coordinate migrations, common API types and M13/M14
changes with the root executor. Safe parallel development ownership: durable
store/runner, research UI, and fixture/E2E verification after DTO agreement.

1. **Persist the domain:** add proposed
   `server/src/db/stores/researchStore.ts`, `server/src/researchSchemas.ts`,
   `server/src/routes/research.ts`; wire `storageRuntime.ts`, `routes.ts`,
   migration/archive inventories. Model route fixtures after
   `server/src/tests/libraryRoutes.test.ts` and durable transitions after
   `server/src/tests/runStore.test.ts`. Verify
   `pnpm --filter borealis-server test -- src/tests/researchStore.test.ts src/tests/researchRoutes.test.ts`
   (new files; all pass) and server `typecheck` (exit 0).
2. **Execute bounded plans:** add proposed `server/src/researchRunner.ts`,
   integrate lifecycle startup/shutdown, consent/model transport and M14 search.
   Persist evidence before model synthesis. Verify
   `pnpm --filter borealis-server test -- src/tests/researchRunner.test.ts src/tests/researchEvidence.test.ts`
   (new files; all pass), covering deterministic seeded provider transcripts,
   changed generations, budget exhaustion, cancel, restart and duplicate steps.
3. **Implement typed comparison and output:** add proposed
   `server/src/researchComparison.ts` and adapters to the final M13 artifact
   service. Validate cell schema, revision overlays, evidence binding, exports
   and publication. Verify
   `pnpm --filter borealis-server test -- src/tests/researchComparison.test.ts src/tests/researchArtifacts.test.ts`
   (new files; all pass), plus existing citation/report tests through server `test`.
4. **Build the review workflow:** add lazy `web/src/pages/ResearchView.tsx`,
   proposed `web/src/components/research/` components and typed API clients;
   link from selected-source chat and navigation. Keep within existing route
   bundle budgets and own page scroll. Verify
   `pnpm --filter borealis-web test -- src/pages/ResearchView.test.tsx`
   (new file; all pass), web `typecheck`, and web `build` (exit 0/budget passes).
5. **Prove the complete job:** add proposed
   `server/src/tests/research.integration.test.ts` to
   `server/vitest.integration.config.ts`; add executable
   `scripts/e2e-local-research.mjs` using an isolated workspace, real UI and a
   deterministic synthetic corpus. Run server `test:integration` and
   `node scripts/e2e-local-research.mjs` (exit 0). Include a separate live local
   model run through the same UX; record model identity and actual outcomes,
   without recording sensitive corpus or provider output in logs.

## End-to-end acceptance

Use three synthetic supplier proposals for focused integration cases, with
differing dates, amounts and terms, including a contradiction and one missing
fact. The final product E2E scenario requires the ten-document corpus and five
typed fields in [END_TO_END_ACCEPTANCE.md](../docs/END_TO_END_ACCEPTANCE.md).
Import through M14 in both cases.

- Create a research question and explicit scope; generate/edit/reorder a plan,
  start, navigate away and reload. Durable progress and original selection remain.
- Open each quoted passage at its real location; a cited memo includes supported
  claims plus the deliberate conflict and missing fact. Invalid citation IDs are
  rejected and never resolve to another run's evidence.
- Build a table with price (`number` plus currency unit), effective date (`date`),
  renewal (`boolean`), tier (`enum`) and exceptions (`text`). The fixture's absent
  cell is null/not-found; conflicting values show both excerpts. User correction
  persists across reload, is labeled as a correction and appears in export.
- Refresh one supplier document, rerun only its row, inspect changed values and
  retained overrides, and open the earlier revision with its original evidence.
  Removing a source preserves already captured excerpts but prevents a new run
  from silently replacing/removing that source from its requested selection.
- Cancel mid-step, restart the backend mid-run, simulate a transport error and
  exhaust a budget. Persisted partial work remains available with accurate status;
  no duplicate published artifacts appear. Restart uses the bounded retry policy.
- Create the reviewed M13 report version and export HTML/PDF and table CSV/JSON.
  Verify PDF magic bytes, self-contained HTML, exact fixture numbers, source
  locators and lineage. Unreviewed/conflicting cells are visibly disclosed.
- Test account isolation, empty scope, readiness conflict, stale edit CAS,
  closed-dialog completion, all field/output limits and archive/restore.

## Documentation, gates and completion

Update `docs/API.md`, `README.md`, `docs/PRODUCT_REVIEW.md`,
`milestones/README.md`, the M13/M14 interface records and `AGENTS.md` where new
domain/lifecycle invariants belong. Add a user-facing local research walkthrough
under `docs/` with the synthetic example, supported types, limits, review and
rerun semantics. Record final evidence and exact verification commands here;
do not rewrite historical test records as current results.

Run `pnpm verify`, `pnpm --filter borealis-desktop verify`,
`pnpm package:unsigned`, `pnpm --filter borealis-desktop package:native:smoke`,
`pnpm --filter borealis-desktop package:entitlements:smoke` and the E2E script:
all must exit 0. Run the packaged desktop's core research/review/export flow as
well as browser acceptance, since root verification alone does not prove that
workflow. DONE requires every contract above implemented and all acceptance
results recorded, including the live local model exercise. Repair routine drift
or failures and continue; an unavailable external dependency must be reported
as a concrete unfinished acceptance check, never converted into a pass. Do not
remove tests, fabricate source evidence, widen scope or publish partial output as
complete to make the goal appear finished.

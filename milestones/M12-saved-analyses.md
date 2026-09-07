# M12 — Saved analyses and reusable tables

## Status and execution contract

- **Status:** IMPLEMENTED — browser, live-model and repository acceptance pass;
  final native packaged UI acceptance is running on the rebuilt app.
  [EXECUTION.md](EXECUTION.md) records current gates and retained evidence.
  Baseline descriptions and dated execution records below are historical
  context; they do not supersede the current API or acceptance status.
- **Priority / effort / risk:** P1 / L (multiple days, including integration) /
  high: durable dataset identity and worker execution change.
- **Baseline:** `e2e6a78`, inspected 2026-09-06.
- **Depends on:** prerequisite closure in the [development handoff](../docs/DEVELOPMENT_HANDOFF.md).
  MCP is not a dependency. Remediation migrations v14–v16 must actually land
  before allocating new product migrations, beginning at the next free version
  >=17. Never edit applied migration history, insert placeholders, or renumber
  the reserved sequence. Coordinate allocation with the other milestone owners.
- **Result:** a user saves an executable analysis outside chat, changes typed
  parameters, reruns against an explicit source set, compares immutable results,
  and exports a bounded table with its provenance.

Read this entire spec, `AGENTS.md`, and the handoff before editing. Start with
`git diff --stat e2e6a78..HEAD -- server/src web/src server/vitest.integration.config.ts`.
Reconcile drift against the excerpts below; adapt this spec to completed work,
without duplicating implementations. Drift and failing tests are reasons to
investigate and repair, not to declare completion or abandon the goal.

## Why build this

`docs/VISION.md` names documents, tables, charts, and reports with versions as
artifacts. Today a useful query is buried in chat metadata and has no durable
executable identity. Saving it makes monthly analysis repeatable and supplies a
stable input for the report workbench and reviewed recurring briefs.

## Current implementation, not the proposed API

- `server/src/tools.ts:239` defines `QueryResultArtifact` with `id`, `sql`,
  `columns`, `rows`, `row_count`, and `truncated`.
- `server/src/tools.ts` sets `MAX_QUERY_SQL_LENGTH = 1_500`;
  `captureQueryResult` executes `const sql = rawSql.slice(0, MAX_QUERY_SQL_LENGTH)`
  at line 361. It also limits a message to three query receipts, 100 rows per
  receipt, 32 columns, 500 cells total, and 30,000 serialized characters total.
  **These are display receipts, not replayable query definitions.** A long SQL
  string is cut; a single `truncated` flag also covers table truncation.
- The `query_data` tool at `server/src/tools.ts:501` allows SQL up to 20,000
  characters and calls
  `dataService.query(accountId, sql, context.readyTableNames, context.abortSignal)`.
- `server/src/dataService.ts:415` exposes `query(accountId, sql, allowedTables,
  caller?)`; `server/src/data/datasets.ts:344` forwards the worker RPC. The
  actual catalog, SQL validation, query deadline, and cancellation boundary is
  `server/src/data/datasetsWorker.ts`. Its current query result ceilings are
  500 rows, 100 columns, 50,000 cells, and 1,000,000 returned characters; the new
  saved-result bounds below may lower these, never raise them.
- `server/src/db/stores/runStore.ts` owns accepted runs and persisted completion;
  `server/src/db/stores/sourceStore.ts` owns sources; `server/src/sourceScope.ts`
  resolves chat source state. Match their account-scoped transactions and
  immutable accepted-run patterns.
- `web/src/components/ChatMessage.tsx` renders query receipts;
  `web/src/pages/ReportsView.tsx` is a paginated artifact gallery with exact
  request generations. `web/src/lib/api.ts` owns browser contracts.

Keep existing clients and bounded message receipts working. Do not expand SSE
or chat history to carry full executable definitions, raw worker results, or
SQL provenance internals.

## Product contract — new behavior to implement

### Definitions, parameters, and execution

Introduce owner-scoped `analyses`, immutable `analysis_revisions`, durable
`analysis_runs`, immutable `analysis_results`, and explicit source bindings in
SQLite. Use stable UUIDs; reference sources by ID, never infer identity from a
mutable table name. A definition contains a title (200 characters), description
(2,000), full SQL (20,000), an ordered parameter declaration list, explicit
selected source IDs (maximum 100, selected-empty remains empty), and an optional
row comparison key. It can link its origin chat/run/query receipt for provenance,
without requiring that chat to remain alive.

Use optimistic revision numbers for definition edits. Freeze the accepted
revision, parameter values, concrete ready sources, ready generations, dataset
schema fingerprint, and source content digest/version identity at run acceptance.
Changing the definition or deleting the originating chat must not change an
accepted run. Source deletion must mark the binding unavailable, not retarget it.
Future files and newly added library members do not join a saved definition
implicitly; a user can explicitly update its selected source set.

Parameters are scalar values bound by the DuckDB prepared statement API:
`string`, finite `number`, safe `integer`, `boolean`, and ISO `date`. Maximum 20
parameters; names match `[A-Za-z][A-Za-z0-9_]{0,63}`; string values <=2,000
characters; ISO dates must be real calendar dates. Declarations specify required
or nullable and optional typed default. Reject undeclared, duplicate, missing,
or mistyped values. Use positional `?` placeholders with explicit declaration
order; inspect placeholder arity using the same prepared statement path that
executes SQL. Parameters never stand for identifiers or SQL fragments. Preserve
single read-only SELECT/WITH/VALUES validation, existing query deadlines and
catalog limits; add binding to the worker RPC, not JavaScript string replacement.

Users may create a definition in the analysis editor or promote a current query
receipt. Add a separately persisted, owner-scoped full-query capture tied to the
accepted chat run/tool invocation and committed only with successful run
completion. At most three promotable captures per turn, full SQL <=20,000 each,
with exact ready source/generation provenance. Keep only its opaque ID and a
`can_save_analysis` affordance in public receipt metadata. Legacy receipts
without verified complete capture must not be replayed from sliced SQL: offer
an editor requiring complete SQL and explicit source selection. An already
verified complete legacy SQL may be used only after explicit validation; a
`truncated: false` display flag alone is not an authoritative capture contract.

Run through a new lifecycle service using the same bounded data-service/worker
boundary. One active run per analysis; reject a concurrent run with 409. A
client operation UUID deduplicates retried acceptance for the same owner and
analysis. Source readiness must be checked before acceptance and again while
acquiring immutable dataset leases. The internal execution service also accepts
an optional expected source-generation/content snapshot; compare it at this same
admission/lease boundary and reject any mismatch. M16 supplies the snapshot from
its completed refresh phase so a later refresh cannot silently substitute inputs. Establish leases/pinning for the exact
accepted dataset locations so a concurrent connector refresh cannot substitute
new bytes or delete files the run is using. If a coherent snapshot cannot be
acquired, fail with an explicit stale/unavailable-input error; never silently
rerun against latest. Restart marks interrupted runs failed with a retry action;
it must not publish partial results or rerun a job automatically.

M12 retains result snapshots, not every historical dataset indefinitely.
“Rerun” resolves the definition's explicit IDs to their current ready versions
and records new provenance. An old result remains inspectable after source
refresh/deletion, but replay of unavailable historical bytes is not promised.

### Results, comparison, and export

Store columns, scalar cell types, bounded rows, returned-row count, completeness
flags/reasons, query revision, parameter values, source provenance, and timestamps
in the immutable result. Preserve the worker's limits. Add a persisted-result
ceiling of 500 rows, 64 columns, 20,000 cells, 2,000 characters per string cell,
and 1 MiB UTF-8 serialized payload, whichever binds first or any lower worker
limit. Enforce before persistence, preserve explicit truncation information,
and reject invalid nonfinite/object cells. Do not label row_count as an exact
total when the worker cannot establish it. A zero-row result is a success.

A successful run publishes exactly one result transactionally; failed/cancelled
runs remain visible with a generic bounded reason and never displace the last
successful result. Retain previous results until explicit user deletion; default
to no automatic history pruning. Paginate runs/results with endpoint-bound
keyset cursors and enforce a per-analysis cap of 1,000 retained results, returning
a clear quota error before execution when full. Deleting an analysis deletes its
definition/run/result history after cancelling/draining active work, but must
leave copied report/document snapshots intact. No shared analysis mutation or
cross-account listing is in scope.

Compare any two results. Always show parameter, source-version, and schema
changes. With a configured non-null unique key (one to three columns), report
added/removed/changed rows and numeric deltas. Duplicate/missing keys or changed
column types produce an explicit unsupported-comparison reason and side-by-side
tables. Without a key, show side-by-side tables; do not invent row identity.
Truncated results may be compared as previews only and may not claim exhaustive
added/removed totals. Exact numeric diffs use stored finite values, not a model.

Export the stored bounded table as CSV and JSON with a separate JSON provenance
manifest. CSV must escape fields and protect spreadsheet-formula-leading strings;
JSON preserves scalar types. Use explicit download names and label partial
exports. Export never issues a fresh unbounded query. Chart creation uses
`server/src/data/charts.ts` and copies a canonical spec bound to a result ID;
reports receive the result snapshot and provenance rather than a moving pointer.

### Proposed API and UI

All paths below are **new**, implemented with `onRequest` authentication and
schema-derived body limits before parsing; `docs/API.md` describes them as
current only after implementation.

| Route | Contract |
| --- | --- |
| `GET/POST /api/analyses` | Owner catalog/create definition; endpoint-bound pagination |
| `GET/PATCH/DELETE /api/analyses/:id` | Detail; revision-checked edit; owned deletion |
| `POST /api/analyses/from-query` | Promote verified full-query capture with selected definition title |
| `GET/POST /api/analyses/:id/runs` | History; accept revision + typed values + operation UUID, return 202/run ID |
| `GET/DELETE /api/analyses/:id/runs/:runId` | Exact run state; request cancellation |
| `GET /api/analyses/:id/results` | Immutable result catalog |
| `GET/DELETE /api/analyses/:id/results/:resultId` | Owned detail/deletion; referenced document copies survive |
| `GET /api/analyses/:id/compare?left=…&right=…` | Bounded deterministic comparison |
| `GET /api/analyses/:id/results/:resultId/export?format=csv\|json\|manifest` | Stored snapshot download |

Add a lazy Analyses route, editor with schema/table inspection and typed parameter
inputs, source picker, run/cancel status, result table, history, comparison, and
export. Reuse existing UI primitives and empty/loading/error patterns. Keep the
root page scrollable, charts lazy, new chats selected-empty, and exact-target
request generation/abort rules. Busy create/rename dialogs must not hide errors
by closing. No general spreadsheet editor, DDL, arbitrary script runtime,
implicit source discovery, or unconstrained export belongs in M12.

## Implementation sequence and owned files

Use a `codex/` branch if a new branch is needed; commit coherent passing units.
Do not push unless separately requested. Subagents may independently implement
store tests, the UI against the frozen API, or the fixture harness; designate one
owner of migrations, worker RPC, and shared types. The integrating agent owns
cross-layer tests and documentation.

1. **Capture and freeze contracts.** Add proposed
   `server/src/analysisTypes.ts`, `server/src/db/stores/analysisStore.ts`, and
   `server/src/tests/analysisStore.test.ts`; extend `server/src/db/types.ts`,
   `server/src/db/migrations.ts`, and `server/src/storageRuntime.ts` once the
   reserved sequence is complete. Add full-query capture in `tools.ts` and
   `runStore.ts` without growing receipt text. Test upgrade from the current
   ledger, capture promotion, revision races, deletion, and publication rollback.
   **Gate:** `pnpm --filter borealis-server typecheck` and
   `pnpm --filter borealis-server test` both exit 0.
2. **Implement actual replay.** Extend `dataService.ts`, `data/datasets.ts`, and
   `data/datasetsWorker.ts` for typed binding and immutable input leases; add
   `server/src/analysisRunner.ts`, register startup/shutdown in the existing
   application composition, and release locks/readers/timers on every exit.
   Test real DuckDB bind types, SQL rejection, timeout during scope acquisition,
   cancellation, concurrent refresh, restart, and exact-source failures.
   **Gate:** `pnpm --filter borealis-server test` and
   `pnpm --filter borealis-server test:integration` exit 0. Add new real-ledger
   integration files to `server/vitest.integration.config.ts` (it is an explicit
   include list); merely naming a file “integration” does not enroll it.
3. **Deliver the resource and workbench.** Add
   `server/src/routes/analyses.ts`, `web/src/pages/AnalysesView.tsx`, their tests,
   and API types in `web/src/lib/api.ts`; register lazy routing using the live
   app/router composition. Update `ChatMessage.tsx` for promotion. Include the
   comparison/export backend in this slice. Test stale navigation and definition
   conflicts, duplicate-key previews, no-capture legacy receipts, and quota states.
   **Gate:** `pnpm --filter borealis-web test`,
   `pnpm --filter borealis-web typecheck`, and
   `pnpm --filter borealis-web build` exit 0; server suite remains green.
4. **Prove the complete job and document it.** Add deterministic HTTP/browser
   coverage and a recorded local-model run as described below. Update
   `README.md`, `docs/API.md`, `docs/VISION.md` shipped-capability section,
   `AGENTS.md` storage/data-flow invariants,
   the milestone ledger, and this spec's execution record. Include analysis
   tables in offline workspace archive validation/restoration checks.
   **Gate:** root `pnpm verify` prints `ALL GATES GREEN`; desktop and E2E gates
   below pass. Do not mark DONE after only a mocked UI test.

Related source, app bootstrap, worker lifecycle, archive validation, route schema,
OpenAPI registration, and test configuration edits are in scope when necessary
for the named behavior. Preserve report publication/share contracts, existing
DuckDB limits, source scoping, and model-provider consent. M13 owns document
editing; M16 owns scheduling. Any new external dependency must be workspace-wide
and duplicated/pinned into desktop runtime where the packaging contract requires.

## End-to-end acceptance and completion

Use `data/sample/accounts.csv`, `transactions.csv`, `budget.csv`, and
`networth.csv` in an isolated browser workspace and desktop profile. Read actual
headers before writing fixture SQL; do not alter fixtures to force success.
Create an explicitly scoped chat, run a real query, save its full executable
capture, name an analysis, add a month/date parameter, and rerun it outside chat.
Independently compute expected fixture aggregates and compare numeric values,
column types, source identities, and parameter provenance. Restart the backend;
verify definition and results survive. Change a controlled input via the supported
refresh/replacement path, explicitly update scope if its source ID changes, run
again, and inspect truthful differences while the old result stays unchanged.
Export CSV, JSON, and manifest; parse and compare them to the stored result.
Generate a chart/report from that same result and verify its numbers.

Add automated tests for a >1,500-character valid SQL statement being saved from
its full capture without executing truncated text; failed query capture is not
promotable; selected-empty never widens; another account cannot access an ID;
stale schema and deleted inputs do not retarget; parameter strings containing
SQL syntax remain data; cancellation/refresh races leave no published partial
result; truncated output is visibly partial in comparisons and exports. Follow
`server/src/tests/runStore.test.ts` and `web/src/pages/ReportsView.test.tsx` for
store/async UI patterns. Keep independent expected-value assertions, not tests
that just repeat the implementation.

Before DONE, run `pnpm verify`, `pnpm --filter borealis-desktop verify`,
`pnpm package:unsigned`, `pnpm --filter borealis-desktop package:native:smoke`,
and `pnpm --filter borealis-desktop package:entitlements:smoke` on supported
Apple Silicon macOS. Exercise the packaged app using an isolated absolute
`--user-data-dir`. Root verify does not replace browser interaction, GUI render,
packaging, or live-model proof. Record exact commands, date, commit, profile type,
fixture assertions, and pass/fail in this document; never record credentials,
private source text, or provider raw output. A deterministic fixture model proves
protocol behavior; separately identify genuine local-model evidence. If a required
external runtime is unavailable, keep the item incomplete with the concrete
blocker and completed evidence; do not substitute a mock and claim E2E success.

DONE requires all definition/replay/comparison/export flows, tests, docs, and
browser/packaged E2E evidence above, plus no unresolved implementation TODOs.
Continue repairing failures until those criteria hold. Update API/storage docs
in the same change as contracts; preserve historical verification dates and add
new evidence instead of rewriting old records.

## Execution record 2026-09-06 (stage 4 — browser E2E journey B)

Branch `codex/m12-saved-analyses`, base `846d4ba` (`origin/main` `fc87913` is an
ancestor of the base; no rebase was needed — main did not move during the
work, and the harness quiesce gate is intact and still used by the journey).
Platform: Apple Silicon macOS, Node 22.22.3, pnpm 10.x, Playwright Chromium.

Implemented for real: `scripts/e2e/journeys/B.mjs` (`IMPLEMENTED=true`), driven
by the production build (`pnpm --filter borealis-server build`,
`pnpm --filter borealis-web build`) against the scripted provider fixture and
a real Chromium session. Backward-compatible fixture/harness extensions:
`POST /fixture/script` runtime step-script install on
`scripts/e2e/fixtures/openai-provider.mjs` (+ self-test, + README),
`provider.setScript`, `server.restart({token})` (quiesce → orderly stop →
re-boot on the same isolated data directory and loopback port so the session
origin/JWT survive), `session.apiFetch` JSON mutations,
`session.apiFetchText` (raw bytes, disposition, byte-level BOM),
`session.allowStatuses([...])` exact-code negative-path admits, and the
committed expected-value helper
`scripts/e2e/fixtures/lib/finance-expected.mjs` (new self-test group
`finance`). `data/generate_sample.ts` gained an `E2E_SAMPLE_DIR` redirect so
the journey regenerates the four CSVs into the run workspace (bytes
byte-compared in-journey against the committed fixtures; `pnpm policy` re-verifies
determinism).

Exact commands and outcomes:

- `node scripts/e2e/fixtures/selftest.mjs` → PASS (79 checks; includes the
  new provider runtime-script checks and the `finance` aggregate group).
- `node scripts/e2e/run-product.mjs --journey=smoke --skip-build` → pass.
- `node scripts/e2e/run-product.mjs --journey=B --skip-build` → pass ×3
  consecutive: `duration_ms` 11395 / 11201 / 11771; every summary
  `passed:true`, `lock_released:true`, `pids_gone:true`, cleanup
  `problems:[]`; 12 content-free screenshots per run
  (`shot-001.png`…`shot-012.png`) plus `provider-delta.txt` counters only.
- `node scripts/e2e/run-product.mjs --journey=all --skip-build` →
  B `pass`; A/C/D/E/F `not_implemented`; `passed:false` with cleanup clean —
  i.e. `all` fails only on the still-unimplemented stubs.
- `pnpm --filter borealis-server typecheck|lint|format:check|test|test:integration`
  → all exit 0 (integration 272/272).
- `pnpm --filter borealis-web typecheck|test|lint|format:check|build` → all
  exit 0 (bundle budgets pass: initial 232058/245760, largest lazy
  121426/133120 gzip bytes).
- `pnpm policy` → exit 0.

Fixture identifiers and independently computed committed expectations
(`fixtures/lib/finance-expected.mjs`, seed-42 generator output; runtime CSV
recomputation is asserted against both the committed constants and the stored
product results — never model prose): 697 transactions; year income
`149669.89`, expense `74398.64`; 142 distinct (month, category) groups;
June = 14 groups with Groceries 6 rows / `-518.65`, Salary `12400`,
Travel `-8324.35`, Interest raw `29.39397901842078`, Rent 23 rows; May = 12
groups with Groceries 7 rows / `-468.01`; deterministic marker row
(`2025-06-15,E2E Marker,Groceries,-50,Credit card,expense`) moves June
Groceries to 7 rows / `-568.65` only.

Journey B coverage as executed through the real UI/API-with-browser-session:
four-CSV upload/ingest via the chat picker into an explicitly `selected` chat
scope; real scripted `query_data` DuckDB roundtrip (exact provider-call arity
asserted: 2 loop calls + 1 non-streaming title probe that the stream-only
fixture rejects and the title flow absorbs); rendered receipt whose display
SQL is the sliced 1 500-character preview (padded capture SQL ≈1.6 KiB >
1 500, full text executed from the capture, 142 rows); UI promotion of the
verified capture (`capture_id`/`can_save_analysis`); edit adding the typed
`month` string parameter + `[month, category]` comparison key (revision CAS);
UI reruns for June and May outside chat with per-cell numeric equality against
the helper (cent-granular tolerance); keyed comparison UI+API (June↔May:
14 removed / 12 added / 0 changed, parameter diff; exhaustive); CSV/JSON/
manifest export bytes parsed and compared to the stored snapshot including
formula-leading `'` guarding (`'=2025-06|Borealis-E2E`) and RFC-style quote/
comma escaping; provenance fields (typed parameter values, source
id@generation, content identities, schema fingerprint); browser reload
mid-flow; full backend restart (quiesce-gated SIGTERM + same-origin re-boot)
with definitions/results surviving; cancellation of an active recursive-CTE
run (`cancelled`, zero published partials); selected-empty never widens
(table-referencing SQL fails `ANALYSIS_QUERY_*`, table-free SQL succeeds);
foreign-account 404s from a second account session; stale-CAS edit `409
ANALYSIS_REVISION_CONFLICT` with no write; duplicate submission replays by
operation id (single durable run); controlled input replacement (explicit
scope shrink → source delete marks binding unavailable without retargeting
(`ANALYSIS_INPUTS_UNAVAILABLE`, never published) → re-upload of changed
bytes under the same table name → explicit scope re-select → rerun whose
keyed diff shows exactly the Groceries change with Δ `-50`/`+1` from stored
finite values and source-version add/remove, while the old result refetches
byte-identical).

Two product observations from the runs (fail-closed behavior, reported not
hidden): (1) startup dataset-registry restoration
(`restoreDatasets`) settles asynchronously behind the listen line while
`/api/health` already reports `data_service` operational, so a saved-analysis
run accepted inside that warm-up window finalizes `stale-inputs`; the journey
gates on the `/api/sources` catalog re-hydrating tabular summaries before
rerunning post-restart (a readiness signal for the server to expose
explicitly, or lazy registry hydration, would close this). (2) The first
chat turn issues exactly three provider POSTs (two agent-loop calls plus the
non-streaming chat-title probe), which stream-only providers must reject
gracefully.

Still open for DONE (not claimed here): genuine local-model acceptance with a
tool-capable chat/embedding pair (`pnpm test:e2e:product:live` contract and
the scoped finance run), the packaged-app (`pnpm package:unsigned` + isolated
absolute `--user-data-dir`) browser/packaged desktop proof, and the complete
root `pnpm verify`/`pnpm --filter borealis-desktop verify` gate chain on the
final integrated state. Root verify was not run in this environment; the
server/web sub-gates above were run individually and all exit 0. Status stays
TODO: the deterministic fixture model proves protocol behavior; it is not
genuine local-model evidence.

## Execution record 2026-09-07 (final acceptance — DONE)

All commands run on Apple Silicon macOS (darwin 26.6.2, arm64), Node 22.22.3,
pnpm 10.x, on final commit `59d1a64` (supersedes the stage-4 "Status stays
TODO" paragraph above).

Required gates, all exit 0 on the identical tree:

- `pnpm verify` → `ALL GATES GREEN` (16/16 tasks).
- `pnpm --filter borealis-desktop verify` → green incl. the Electron
  hidden-renderer PNG/PDF smoke (`ok:true`, network_hits 0,
  blocked_unsafe_requests 2).
- `pnpm package:unsigned` → 5/5 tasks; fresh `mac-arm64/Borealis.app` + DMG/ZIP.
- `pnpm --filter borealis-desktop package:native:smoke` → fuses/ASAR/integrity
  + Electron-ABI native load in Node and the utility process.
- `pnpm --filter borealis-desktop package:entitlements:smoke` → retained
  `allow-jit` + `disable-library-validation` pair proven; both negative
  removals fail as required.

Browser acceptance (`node scripts/e2e/run-product.mjs --journey=B
--skip-build`): pass, plus the integrated `--journey=all` run with A–F all
`pass` and `passed:true`; cleanup `lock_released/pids_gone`, `problems:[]`.
Coverage gained since stage 4: the canonical chart copy of the SAME stored
result (journey B P9b) — categories from the fixtures, series exactly
`[tx_count, net_amount]`, every numeric cell verified against the committed
expected values (M12 "chart from that same result and verify its numbers").

Packaged-app exercise (isolated absolute `--user-data-dir` under the
disposable run tree, real unsigned bundle):
`node scripts/e2e/run-product-desktop.mjs --journey=B` — journey B end to
end against the REAL packaged app: origin derived from the app's own
`Borealis server listening` log line; accounts via the PUBLIC register route
+ real login form (the desktop one-shot preload bootstrap is unavailable to
Playwright); the scripted provider wired through authenticated
`PATCH /api/settings` (loopback, so no egress gate; embedding identity never
sent because Settings must reject it — the fixture answers as the app's
default `text-embedding-nomic-embed-text-v1.5` @ 768); restart = quiesce on
`/api/health`, SIGTERM owned pid (escalation disclosed, `escalated:false` in
the passing runs), relaunch on the same profile with a new port, durable
`jwt.secret` proven (pre-restart JWT authenticates), session re-established
through the real login form. Greens: agent ×3 + coordinator re-runs ×2 + the
final-chain run, all `passed:true` with `restart_disclosures` recorded and
clean lock/pid cleanup. The lifecycle default run (launch, single-instance,
orderly quit via `--borealis-packaged-shutdown-smoke`) also passes on the
final package.

Genuine local-model evidence (`pnpm test:e2e:product:live`, models
`qwen/qwen3.6-35b-a3b` + `text-embedding-nomic-embed-text-v1.5` @ 768):
`passed:true`, exit 0 — provider reachable, tool-capability qualification
(1 attempt), 4-source ingest, a real `query_data` tool round (3 query
receipts), the parameterized saved-analysis rerun with per-cell numeric
expectations (14/14), CSV BOM/formula-guard + manifest identity byte checks,
workspace removed / lock released / pids gone. Disclosed boundary: the live
research exercise runs through the API path, not the research UI; the
packaged-app brief/research UIs are not separately exercised (the identical
web surface is bundled in the package, proven via journey B's UI flow).

Fixture identifiers and expectations are unchanged from the stage-4 record
(seed-42, June 14 groups, Groceries `-518.65` → `-568.65` after the marker
replacement, etc.). No credentials, private source text, or provider raw
output are recorded here.

# M16 — Reviewed recurring briefs

> Executor: implement the complete fixed recipe below, including durable state,
> real UI, recovery, tests, and documentation. This is a selected development
> handoff, not a claim that the feature exists. Read
> [DEVELOPMENT_HANDOFF](../docs/DEVELOPMENT_HANDOFF.md) first. Reconcile expected
> prerequisite changes against live code before starting; do not discard the
> feature or weaken its acceptance criteria because the baseline has moved.

## Status and dependencies

- **Status:** TODO; selected for implementation on 2026-09-06.
- **Baseline:** `e2e6a78`, 2026-09-06.
- **Priority / effort / functional risk:** P2 / XL / high (recovery and calendar semantics).
- **Depends on:** [M12 saved analyses](M12-saved-analyses.md),
  [M13 report workbench](M13-report-workbench.md), and
  [M14 living libraries](M14-living-libraries.md).
- **Prerequisite gate:** complete the handoff's existing remediation sequence
  before extending these contracts. Schema v14, v15, and v16 are reserved for
  provider-bound consent, automation target ownership, and typed connector
  refresh/repair. Allocate this feature's migrations from the actual next free
  version at or above v17 after those migrations land; milestone M16 does not
  mean database schema v16.

## Outcome

A user schedules a weekly finance brief over explicitly selected inputs and a
saved analysis. Borealis refreshes those inputs, waits for the exact refreshed
generations to become ready, reruns the saved analysis, compares compatible
successful results, and prepares a report draft in a review inbox. The user can
inspect the changes and evidence, edit through the report workbench, approve,
or reject. New `reviewed_brief` runs never publish before explicit review or
send a message externally. Existing `agent_turn` automations keep their normal
completed-chat report publication behavior.

This completes a proven manual workflow. A generic workflow graph, arbitrary
scripts, external delivery, event-triggered automations, system wake agents,
and team approval chains are outside this milestone.

## Current implementation and drift check

Run from the repository root:

```bash
git diff --stat e2e6a78..HEAD -- server/src/automationStore.ts server/src/automationRunner.ts server/src/automationRuntime.ts server/src/routes/automations.ts server/src/db server/src/storageRuntime.ts server/src/index.ts server/src/desktopHost.ts web/src/pages/AutomationsView.tsx web/src/lib/api.ts web/src/App.tsx desktop/src server/src/tests web/src/pages docs milestones
```

The current `server/src/automationStore.ts:18` contract is:

```ts
export type AutomationKind = "connector_sync" | "agent_turn";
export type AutomationState = "active" | "paused";
export type AutomationRunOutcome = "succeeded" | "failed" | "skipped";
```

Its `Automation` interface stores `schedule_minutes` and `next_run_at`.
`claimDue` claims at most 20 due rows, advances their next-run timestamps, and
returns work without a durable stage cursor. Existing work executes connector
sync or an accepted chat turn independently. There is no recipe, report
approval state, calendar schedule, or review inbox.

`server/src/automationRunner.ts:194` starts a 60-second unref'd interval:

```ts
function start(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), dependencies.tickIntervalMs ?? TICK_INTERVAL_MS);
  timer.unref();
}
```

The server must therefore remain running for current schedules to execute.
`server/src/routes/automations.ts` owns authenticated catalog, create, patch,
delete, and bounded run-history endpoints. `web/src/pages/AutomationsView.tsx`
owns interval creation, state changes, and history; its asynchronous target and
request-generation protections are the pattern for new UI. Tests in
`server/src/tests/automations.test.ts` cover ownership, scheduling, cancellation,
and egress. `web/src/pages/AutomationsView.test.tsx` provides UI test patterns.

The following is the **target contract**, not an account of current behavior.

## Fixed recipe contract

1. **Configure:** choose one saved analysis, bounded parameter values, a report
   title/instruction, an explicit ordered set of source IDs, and any refresh
   bindings for those sources. Bind analysis definition revision, parameter
   values, and exact source membership in a versioned recipe. Recipe membership
   must equal the bound M12 definition revision's selected source set; changing
   membership requires an explicit M12 revision followed by a recipe update.
   A library picker
   expands members at save time only. Later library members and new files in a
   mapped folder require an explicit recipe edit; they cannot join a run.
2. **Claim:** atomically persist a run and its recipe revision for the scheduled
   occurrence. One active run per recipe; a unique occurrence key prevents
   duplicate claims. A manual Run now uses an explicit idempotency key and the
   same pipeline. Subsequent recipe edits apply only to later runs.
3. **Refresh:** invoke existing connector and M14 managed-folder refresh
   services only for selected inputs. If a connector/folder operation refreshes
   other members as an implementation consequence, only recipe members enter
   analysis. Static uploads are explicitly labeled “uses imported version.”
   Missing local permissions, disconnected volumes, deleted inputs, revoked
   consent, and refresh errors stop the recipe with a visible reason.
4. **Wait:** store each refresh operation identity and intended generation.
   Wait until every required generation is ready, then persist the run's exact
   source-generation snapshot. “Download accepted” is not “ready.” An unchanged
   file may retain its ready generation only with a successful no-change
   refresh receipt. A failed refresh never falls back silently to old data.
   Reuse M12's generation validation and query leases; a superseded generation
   must not be replaced mid-analysis by whatever is current.
5. **Analyze and compare:** call the ordinary M12 execution service with the
   fixed recipe revision, parameter values, and source snapshot. Select and
   persist the last successful compatible analysis run from this recipe as the
   comparison baseline before running the new analysis. Compatibility follows M12
   definition/parameter/source-set rules; differing ready generations are the
   intended comparison. No baseline means a clearly labeled first run. A
   changed definition or parameters begins a new comparison series. Approval
   is separate from analytical success: rejecting prose does not erase a
   successful result or silently change the next numerical baseline.
6. **Draft:** create an M13 durable report draft bound to the current analysis
   run, baseline, comparison, source generations, and recipe run. Use bounded
   existing model execution and report services. Store generated evidence and
   chart references through their existing contracts. Copy explicitly labeled
   current/baseline result previews and provenance into the document within
   M13's eight-table, 60-row, 32-column, 1,000-total-cell, per-cell and text
   budgets and 400,000-character total revision ceiling. Retain the full bounded
   results in M12; copied previews must show omitted rows/columns and comparison
   completeness. Preserve the displayed comparison and previews if the analysis
   is later deleted; do not promise the deleted full result remains available.
   Never manufacture citations or present truncated result comparisons as
   complete. Drafts stay
   outside the published report version chain and owner shares.
7. **Review:** atomically transition the run to `awaiting_review` only when the
   draft and all references exist. The inbox shows current/baseline values,
   freshness, evidence, recipe revision, and a rendered draft. Users may open
   the M13 editor, approve the exact draft revision, or reject with an optional
   bounded note. Approval first persists an intent for the exact reviewed
   document revision using head-revision CAS and a stable publication operation
   UUID, then enters `publishing`. Call M13's `publishDocumentRevision` service,
   which renders asynchronously and commits a publication only when all artifacts
   exist. Return 202/status while rendering; transition to `approved` only after
   that publication commits. Approval retries reconcile the same intent and
   operation UUID rather than creating another publication. A render failure
   returns the review to `awaiting_review` with a failed-publication indicator
   and bounded error;
   recheck the current head before retrying, requiring review again if edited.
   A concurrent edit before approval causes a revision conflict requiring
   refresh, never approval of unseen content. An edit after accepted approval
   cannot alter the immutable revision being published. Rejection preserves the
   run and draft for inspection and cannot publish. A rejection while publication
   is already accepted returns a conflict; it cannot revoke a committed or
   in-flight approval silently.
8. **Notify:** persist a local in-app notification only for a first draft,
   meaningful result change, failure needing attention, or automatic pause.
   Every ready draft remains discoverable in the inbox. A no-change draft
   produces no repeated notification. Never infer change from different model
   wording: use M12's deterministic comparison and explicit incompleteness
   status. Unsupported or incomplete comparisons are labeled and raise an
   attention event; never treat them as proven no-change. Users can disable
   local notifications per recipe. Read/dismiss is
   durable and deduplicated by run/event kind. Approval does not enable sharing,
   email, Slack, webhooks, or any other outbound delivery.

## Bounds and scheduling decisions

- Preserve existing interval kinds and their 15–10,080 minute bounds. Add a
  typed `reviewed_brief` configuration, without reinterpreting old rows.
- New recipes support daily, weekly (one chosen weekday), and monthly (day
  1–28) schedules at a specified hour/minute and validated IANA time zone.
  Store civil schedule, time zone, next UTC occurrence, and revision. Browser
  locale is merely a default displayed for confirmation, never a scheduling
  authority after save. Avoid unrestricted cron/RRULE input.
- For a nonexistent spring-forward time, run at the first valid local instant
  after that gap. For a repeated autumn time, run once at the earlier instant.
  Persist occurrence identity so restart cannot run the second instance.
  Show the next three local and UTC run times in the editor before save.
- The app/server must be running. State this next to the schedule controls.
  On reopen, coalesce all missed occurrences into one catch-up run, display the
  missed interval/count, and advance to the next future civil occurrence.
  Do not replay every missed day or depend on a background service. Repeated
  restart of the same catch-up occurrence must not create additional runs.
- While a run executes, coalesce later due occurrences to at most one pending
  catch-up. Awaiting human review is terminal for execution and does not block
  subsequent occurrences; pending reviews are paginated, never auto-approved.
- Per recipe: at most 100 explicit sources, one saved analysis, one report
  draft per run; name ≤80 characters, draft instruction ≤8,000 characters,
  review note ≤1,000 characters. M12 parameter/result and M13 artifact bounds
  still apply. Reject overflow rather than truncate source membership.
- Claim batches remain at most 20. Run at most one brief per account and two
  globally; do not monopolize existing interval work. Use fair scheduling and
  avoid holding SQLite transactions while awaiting I/O. Input refresh stage
  deadline is 15 minutes; total execution deadline through `awaiting_review` is
  30 minutes, persisted across restart. Human review time is excluded. Later
  publication uses M13's own render deadline and concurrency lease, without
  holding a recipe execution slot while awaiting review. Existing shorter
  worker, model, and render deadlines remain
  in force. History/error summaries stay generic and ≤500 characters.
- Five consecutive execution failures pause the recipe, preserving existing
  automation convention. Consent/migration/busy prerequisites are visible
  skipped or blocked outcomes, not successful drafts. Success resets failures;
  a rejected draft is not an execution failure.
- Review and notification lists use endpoint-bound keyset pagination (default
  20, maximum 50). UI polling is exact-ID, visibility-aware, abortable, and backs
  off on repeated failures. No unbounded catalog poll or history materialization.

## Durable design and API

Extend `automationStore.ts`, `automationRunner.ts`, and `automationRuntime.ts`
with focused services such as `briefRecipeStore.ts`, `briefRunner.ts`, and
`calendarSchedule.ts`. Use SQLite for recipe revisions, occurrence claims,
stage state, generation receipts, analysis/report references, review decisions,
and local notifications. Compose stores in `storageRuntime.ts` and migrations
under `server/src/db/`. Use existing source and artifact services rather than
duplicating extraction, SQL, report normalization, or renderer code.

Persist execution stages `queued`, `refreshing`, `waiting_ready`, `analyzing`,
`drafting`, `awaiting_review`, and `publishing`, with explicit terminal `failed`, `cancelled`,
`skipped`, `approved`, and `rejected` outcomes. Stage attempts have stable
operation IDs and conditional transition writes. Restart resumes the same run
from committed receipts; it never creates a second result, draft, publication,
or notification. If an interrupted operation cannot be proven complete or
resumed safely, fail visibly and allow a fresh explicit retry. Do not claim
exactly-once provider invocation; require at-most-one committed artifact for
each logical stage. Shutdown cancels active work and preserves recoverable
state before stores close.

Extend automation create/detail/update with validated typed recipe/schedule
objects and optimistic `revision` updates. Add the following public routes;
register schemas in the existing OpenAPI graph and types in `web/src/lib/api.ts`:

| Route | Behavior |
|---|---|
| `POST /api/automations/:id/runs` | Accept Run now with idempotency key; return durable run identity (202) |
| `GET /api/automations/:id/runs/:runId` | Bounded stage detail, linked evidence/artifacts and failure reason |
| `DELETE /api/automations/:id/runs/:runId` | Request cancellation; repeated calls are idempotent |
| `GET /api/brief-reviews` | Paginated pending/reviewed inbox scoped to account |
| `POST /api/brief-reviews/:id/decision` | Exact draft revision plus approve/reject and optional note; approval persists intent and returns 202/status until publication commits |
| `GET /api/notifications` | Paginated local events with read state |
| `PATCH /api/notifications/:id` | Mark read/dismissed; cannot modify event content |

Deleting/pausing a recipe stops future scheduling and requests cancellation of
its active execution; existing saved results and published reports survive.
Deleting required source/analysis targets pauses affected recipes with a clear
reason rather than retargeting them. Keep rejected and pending drafts through
M13's documented lifecycle; explicitly decide pending review handling in the
delete dialog (default preserve for review). Recipe run history must remain
readable through the retained review's snapshot if the live recipe is deleted.

## Implementation slices and verification

Use Node 22 (`.nvmrc`: 22.22.3), Corepack, and pnpm 10 from the repository root.
Install once with `pnpm install`; browser verification needs
`pnpm --filter borealis-server exec playwright install chromium`.

1. **Store and calendar:** add migrations, typed contracts, revisions,
   occurrence identity, calendar calculator, and recovery records. Write
   `server/src/tests/briefRecipes.test.ts` and `calendarSchedule.test.ts`.
   Verify `pnpm --filter borealis-server test src/tests/briefRecipes.test.ts src/tests/calendarSchedule.test.ts`
   and `pnpm --filter borealis-server typecheck` → exit 0.
2. **Recipe execution:** implement the stage machine using real M12/M14
   services, M13 draft creation, existing consent/ownership checks, deadlines,
   cancellation, and restart. Write `server/src/tests/briefRunner.test.ts` and
   real-store `briefWorkflow.integration.test.ts`; explicitly add the latter
   to the include list in `server/vitest.integration.config.ts`.
   Verify `pnpm --filter borealis-server test src/tests/briefRunner.test.ts src/tests/automations.test.ts`
   and `pnpm --filter borealis-server test:integration` → exit 0.
3. **API and review:** add routes, atomic approval/rejection, notification
   deduplication, and deletion behavior. Write
   `server/src/tests/briefRoutes.test.ts` using existing Fastify route-test
   patterns. Verify `pnpm --filter borealis-server test src/tests/briefRoutes.test.ts`
   and `pnpm --filter borealis-server typecheck` → exit 0.
4. **User workflow:** extend `AutomationsView.tsx` with recipe and calendar
   creation, schedule preview, Run now, bounded stages, and local status.
   Add lazy `web/src/pages/BriefReviewsView.tsx` with review actions, link it in
   `web/src/App.tsx` and actual shell navigation, and reuse M13 editor/preview.
   Add `BriefReviewsView.test.tsx`; extend `AutomationsView.test.tsx` for new
   workflow and stale responses. Verify `pnpm --filter borealis-web test src/pages/AutomationsView.test.tsx src/pages/BriefReviewsView.test.tsx`
   and `pnpm --filter borealis-web build` → exit 0, bundle budgets satisfied.
5. **End-to-end and docs:** run the acceptance journey below through actual
   browser and isolated Electron UI; record commands, fixture assertions,
   screenshots, and results in [EXECUTION](EXECUTION.md), following the shared
   [END_TO_END_ACCEPTANCE](../docs/END_TO_END_ACCEPTANCE.md) contract.
   Update API, README, desktop schedule help, product review, this milestone,
   and the milestone ledger in the same implementation slice. Run `pnpm verify`
   → `ALL GATES GREEN`; run `pnpm --filter borealis-desktop verify` → exit 0.
   Packaging changes additionally require `pnpm package:unsigned`,
   `pnpm --filter borealis-desktop package:native:smoke`, and
   `pnpm --filter borealis-desktop package:entitlements:smoke` → all exit 0.

## Required tests and end-to-end acceptance

- Unit tests cover spring gap, autumn overlap, monthly boundaries, IANA zone
  rejection, a schedule edit during execution, missed runs on reopen, repeated
  reopen, catch-up coalescing, and injected-clock deterministic occurrence keys.
- Store/runner tests crash after every committed stage and before/after draft
  and approval publication. Assert one claim/result/draft/publication/event,
  stable snapshots and deadline, cancellation release, fair scheduling, five
  failures pause, manual run deduplication, and no mutation by an old revision.
- Exercise refresh success/no-change/failure, generation supersession,
  deleted/foreign inputs, denied folder access, unavailable volume, busy chat,
  missing/changed consent, migration admission, and bounded overflow. No failed
  input creates a report describing the input as fresh. No unrelated source or
  newly added library member participates.
- Test approval/rejection retry, edit-versus-approve conflict, render failure and
  retry, approved status only after publication commit, reject-during-publication
  conflict, and approval after the earlier execution deadline. Test deleted recipe,
  preserved historical baseline, truncated comparison, missing baseline,
  changed definition/parameters, notification deduplication and no-change
  silence. UI tests cover error states, focus, keyboard review, loading,
  dismissal, request-generation races and scroll ownership without `act` warnings.
- In an isolated workspace create an M14 library with a small tabular fixture;
  save an M12 analysis returning `metric_label = 'total'` and numeric `value = 100`.
  Configure `metric_label` as its comparison key; `value` holds the changing sum.
  Configure a weekly recipe
  through the UI, run it, inspect the first draft and evidence, and approve it.
  Change the same fixture so its sum becomes 125; refresh via the recipe and
  assert current 125, previous 100, delta 25, and 25% change in the draft/review.
  Approve; reload the app and confirm published HTML/PDF and immutable previous
  version. Repeat unchanged: inbox may contain a draft but no change alert.
- Make the refresh input unavailable; run again and confirm visible failure,
  no new successful analysis/report publication, and intact older artifacts.
  Restart mid-run, exercise the recovery path, and reject another generated
  draft. Restore the input and demonstrate a recovered successful run.
  Close/reopen the desktop using an isolated user-data directory across an
  injected due occurrence; assert one explained catch-up run. Calendar tests
  may use an injected clock; production must not expose test-clock controls.
- Deterministic provider fixtures prove numerical/UI behavior, but also perform
  one live configured-model draft through the same UI and verify supported
  values, citations, and readable rendered output. Record model and result, not
  credentials or private content. A missing endpoint is a blocked live test,
  not permission to mark the milestone complete.

## Completion and maintenance

All slices, required cases, real UI journeys, repository/desktop checks, and
documentation updates must pass before marking DONE. Do not substitute a
mocked screenshot, an API-only demo, or an unexecuted test checklist. Commit
logical slices using the repository's existing `feat:`, `test:`, and `docs:`
style; do not push unless separately instructed.

Resolve routine implementation details and prerequisite drift autonomously.
Escalate only a concrete requirement conflict or unavailable external resource
that cannot be addressed locally, documenting completed work and the exact
remaining acceptance criterion. Do not remove the refresh-ready gate, widen
  source scope, silently reuse stale data, publish a reviewed brief before review, or consume
reserved migration versions to make progress. Keep schedule/DST semantics,
comparison rules, review lifecycle, and running-app requirements in API and
user docs whenever those behaviors change.

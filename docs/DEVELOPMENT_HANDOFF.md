# Development handoff — the complete functional wave

**Completed:** 2026-09-07. **Selected:** 2026-09-06. **Original baseline:**
`e2e6a78`. All six functional slices, prerequisite migrations and required
acceptance are complete on runtime `1e56b21d66d119bfb4535e58a5b3535b0586b3c3`,
including all 17 final packaged native checkpoints. This remains the scope and
maintenance contract for preserving the result. Consult
[EXECUTION.md](../milestones/EXECUTION.md) for final evidence and the separate
SIP-disabled hosted macOS CI infrastructure follow-up; do not restart the wave
from its old baseline. The required strict entitlement command passed locally.

## Start here and read in order

1. Root [AGENTS.md](../AGENTS.md): runtime, store, source scope, agent, rendering,
   package and documentation invariants. Read any more-specific contributor
   instructions in areas you edit.
2. [README](../README.md), [vision](VISION.md), [API](API.md), and
   [desktop guide](../desktop/README.md): what runs today and how to validate it.
3. [Milestone ledger](../milestones/README.md): completed M01–M11, the selected
   implementation wave, dependencies, and status. [Product review](PRODUCT_REVIEW.md)
   is the dated rationale, not today’s feature inventory.
4. The prerequisite gate below and its linked advisor plans, then all six specs:

| Spec | Deliverable | Required predecessor |
| ---- | ----------- | -------------------- |
| [Connected agents](MCP_CONNECTIONS.md) | Both MCP transports, OAuth, selected tool execution, connection management and job setup | Schema/runtime prerequisite gate |
| [M12](../milestones/M12-saved-analyses.md) | Saved parameterized analyses and versioned tabular results | Schema/runtime prerequisite gate; independent of MCP |
| [M13](../milestones/M13-report-workbench.md) | Editable documents/reports, targeted rewrites, templates and versioned evidence-bearing exports | M12 for analysis refresh; basic editing can start independently |
| [M14](../milestones/M14-living-libraries.md) | Selected folders, incremental/watch refresh, WebDAV indexing, keyword/semantic search and source inspection | Prerequisite gate; connection secret custody from connected agents for WebDAV |
| [M15](../milestones/M15-local-research.md) | Durable local research dossiers and reviewed comparison tables | M13/M14 plus reusable M12 result/provenance patterns |
| [M16](../milestones/M16-reviewed-briefs.md) | Calendar recipes that refresh, analyze, compare, draft and await review | M12/M13/M14 and the drained scheduler baseline |

5. [End-to-end acceptance](END_TO_END_ACCEPTANCE.md) and
   [execution evidence](../milestones/EXECUTION.md): what must be demonstrated
   before completion. [Copyable goal](IMPLEMENTATION_GOAL.md) is the concise
   task instruction; these specs are its concrete acceptance boundary.

This is implementation work, not another advisory audit. The improve skill's
advisor-only workflow must not cause the implementing agent to stop at plans.
Use coding/design/browser skills appropriate to the execution environment.

## Scope decisions already made

Implement all features listed in the six specifications, including their UI,
routes, durable storage, cancellation/reload behavior, exports, documentation,
and end-to-end acceptance. Recommendations such as general computer control,
arbitrary external writes, a connector marketplace, implicit memory, additional
desktop platforms, web-wide research, and a general spreadsheet/workflow editor
remain out of scope. Curated bundled engines/weights and guided onboarding are
an adoption follow-up, not part of this wave's completion condition.

The first indexed authenticated service is **read-only WebDAV**, using
application-password credentials and a real local authenticated fixture. This
provides a useful standard service without making a commercial cloud account a
prerequisite. MCP tool access and indexed source refresh remain distinct.

Preserve the functional boundaries: saved results are snapshots, reruns use
explicit ready inputs, report edits produce new revisions, research cells retain
human corrections, and scheduled briefs await review before their draft is
promoted. Existing ordinary chat-run report publication remains supported.
Nothing in this goal authorizes delivering messages or files to external people.

<a id="resolve-the-reserved-schema-sequence-first"></a>

## Applied prerequisite schema sequence

The original baseline ended at schema **13**. Real migrations **14** (provider-
bound consent, advisor 006), **15** (automation ownership, advisor 012), and
**16** (typed connector repair, advisor 020) now precede product schemas
**17–28**. No new work may reuse these numbers, modify applied history, skip a
version, or insert no-op placeholders.

The prerequisite closure below is implemented; retain its tests and invariants.
The table records why those changes preceded product integration. Other advisor
TODOs remain a separate backlog, not an implied requirement to reimplement the
wave or expand its acceptance scope.

| Order | Required advisor plan | Purpose for the product wave |
| ----- | --------------------- | ---------------------------- |
| 1 | [001](../advisor-plans/001-partition-server-test-suites.md) | Establish reliable unit/integration partitioning |
| 2 | [003](../advisor-plans/003-add-historical-migration-fixtures.md) | Preserve executable v1–v13 upgrade history |
| 3 | [004](../advisor-plans/004-add-vertical-agent-integration-test.md) | Verify a real composed agent turn |
| 4 | [005](../advisor-plans/005-bind-provider-credentials-to-origin.md) | Canonical credential/target identity |
| 5 | [006](../advisor-plans/006-bind-egress-consent-to-provider-revision.md) | Real schema v14 and outbound runtime snapshots |
| 6 | [007](../advisor-plans/007-restrict-contained-engine-control.md) | Desktop-operator authority and child lifecycle boundary |
| 7 | [008](../advisor-plans/008-harden-contained-download-transport.md) | Owned bounded download/process lifecycle |
| 8 | [009](../advisor-plans/009-eliminate-unsolicited-ui-egress.md) | Preserve an offline UI and controlled navigation boundary |
| 9 | [011](../advisor-plans/011-preserve-source-cleanup-intents.md) | Durable source cleanup required by folder refresh |
| 10 | [012](../advisor-plans/012-enforce-automation-target-ownership.md) | Real schema v15 and owned automation targets |
| 11 | [013](../advisor-plans/013-drain-automation-scheduler-on-shutdown.md) | Drain recurring work before closing storage |
| 12 | [014](../advisor-plans/014-create-owned-application-runtime.md) | One runtime owns stores, workers, connections and scheduler |
| 13 | [015](../advisor-plans/015-shorten-vector-promotion-transaction.md) | Promotion protocol ready for incremental corpus refresh |
| 14 | [016](../advisor-plans/016-bound-periodic-storage-reconciliation.md) | Bounded repair scheduling |
| 15 | [020](../advisor-plans/020-type-connector-refresh-protocol-state.md) | Real schema v16 and durable refresh/repair state |

Completed dependency 031 and completed plans 024–037 remain preserved baseline;
do not reimplement them from old excerpts. In particular, embedding apply is
**live**, with startup recovery after interruption, despite the original plan
035's restart-only wording. Plan 010's shared-reader bug was already fixed by
M07; it is not part of this dependency closure. Other unselected advisor plans
remain separate unless a concrete dependency is discovered and documented.

This order is a safe serialization, not a requirement to idle independent
workers. There is one owner for `migrations.ts`, historical schema fixtures,
shared route registration, dependency manifests/lockfile, and the integration
branch. Allocate the next free version only in actual integration order after
the current applied head. Record versions in [EXECUTION.md](../milestones/EXECUTION.md)
and update historical migration/backup tests with each addition.

## Working contract for the implementing agent

Start with `git status --short`, `git rev-parse --short HEAD`, `node --version`,
`pnpm --version`, and `git diff --stat e2e6a78..HEAD`. Read changed code before
using any baseline excerpt. Use Node 22.22.3 (or supported newer 22.x) and pnpm
10.x; install only from the workspace root. Do not overwrite unrelated user work.

Build a persistent checklist from the specs in `milestones/EXECUTION.md`. Mark
items IN PROGRESS, then DONE only with implementation commit and test evidence.
Plan/checklist updates alone are not implementation progress. Reconcile normal
drift autonomously; retain intended outcomes and tests. When a planned API name
changes, update its callers and specs together instead of maintaining two
competing contracts.

Use subagents for bounded independent work: service/store modules, fixtures,
specific UI surfaces, documentation checks, and fresh-context review. Give each
agent its spec, owned files or isolated worktree, dependency contracts, required
tests, and current base commit. Do not assign multiple agents the same shared
file or ask them to allocate migrations independently. Review their diffs and
run integrated tests yourself; their completion messages are not proof.

Prefer a topological product sequence: connected-agent infrastructure and M12
after the gate; then M13/M14; then M15/M16. Interface/test design may proceed
earlier. Frontend skeletons, fake data, disabled buttons, or passing unit tests
with mocked storage do not satisfy a feature whose spec requires real operation.

Use small conventional commits on a `codex/` branch if a new branch is needed.
Commit completed coherent slices and their docs. Do not push, merge, publish a
site, distribute a signed release, or send external messages unless separately
requested. Read-only local protocol fixtures and isolated unsigned packaging
are within the requested validation scope.

## Narrowly scoped architecture additions

The preload exposes one-shot bootstrap, a **typed native folder chooser returning
an opaque backend grant**, and validated OAuth system-browser opening, with
trusted-main-frame validation and exact main/backend capability handoffs.
No renderer-supplied recursive path, general read/write-file method, arbitrary
IPC dispatch, or shell execution is allowed. The single-use bootstrap semantics
remain unchanged. Keep AGENTS and desktop API declarations aligned with these
exact capabilities.

OAuth system-browser opening and OS key custody are similarly owned by main
with narrow validated messages. Notifications are optional, local, user-enabled,
and content-minimal by default. These additions must pass the packaged desktop
checks without disabling fuses, sandboxing, ASAR integrity, or navigation rules.

New source text, evidence, query results and artifacts stay under the established
account/workspace contracts. New record types must participate in deletion,
archive/restore and schema verification. Never store application tables in
DuckDB or passage text in LanceDB. Never expand selected-empty or an accepted
turn's source scope. A folder/library refresh updates available sources, not
the source selection of existing chats.

## Documentation and completion rules

Update these in the same slice as behavior changes: README, API reference,
AGENTS, desktop guide, environment example when knobs change, relevant specs,
agent rollout, milestone status, prerequisite advisor statuses, and execution
evidence. Keep the vision's current inventory factual without turning its
aspirations into shipped claims. Keep dated research and completed historical
plans explicitly historical. Record compatibility changes, budgets, new states,
public error codes and user-visible recovery instructions.

Maintain the acceptance harness and execute
[END_TO_END_ACCEPTANCE.md](END_TO_END_ACCEPTANCE.md). Fix relevant failures;
do not weaken tests, remove scenarios, widen budgets, or silently drop scope to
claim success. A successful mock-provider fixture is required but does not
replace the separate live-model and packaged UI checks.

Only finish successfully after all six specs, their prerequisite closure,
documentation updates and required checks are complete and recorded. Do not
stop after planning, an MVP subset, the first milestone, or a successful build.
Continue across context compactions using the persistent ledger. If progress is
truly blocked by unavailable hardware, permission, credentials, or an external
service, exhaust useful independent work, record exact evidence and the smallest
required user action, and report **blocked, not complete**. Never fabricate a
test result, bypass a permission boundary, or loop indefinitely to satisfy the
wording “only finish when complete.”

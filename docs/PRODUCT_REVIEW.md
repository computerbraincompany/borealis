# Functional product review — September 2026

Reviewed 2026-09-05/06 against Borealis commit `e2e6a78`. This is a code-grounded
product assessment and a dated competitive comparison. The
[milestone ledger](../milestones/README.md#selected-functional-wave) owns
the sequence; this document supplies the rationale. The September 6 follow-up
selected all six functional slices for the coding-agent handoff. Their precise
scope and acceptance criteria now live in [DEVELOPMENT_HANDOFF.md](DEVELOPMENT_HANDOFF.md),
the connected-agent spec and milestones M12–M16. These are selected TODOs,
not shipped features; additional ideas below remain deferred unless included
in those specifications.

## Recommendation

Make Borealis the place where an analyst can **collect changing data, produce
an inspectable analysis, revise the result, and repeat the job next month**.
The current app has broad coverage of the vision's first layer. Its largest
functional gap is continuity between those capabilities: query results remain
inside chat, reports can be renamed but not edited, libraries require manual
collection, and scheduled refreshes and analyses are separate jobs.

Complete the pending MCP execution path already described in the agent rollout.
For new product scope, start with **saved analyses**, followed by a **report
revision workbench**. These exploit Borealis's existing DuckDB, evidence, chart,
and report infrastructure and directly serve the analyst and diligence users
named in the vision. They do not require MCP to be useful.

## Where the app actually stands

| Capability | Implemented baseline | Functional distance remaining |
| ---------- | -------------------- | ----------------------------- |
| Grounded chat | Explicit source selection, retrieval, SQL, charts, numbered evidence, durable runs and cancellation | Standalone corpus search, page/section inspection, research plans and evidence dossiers |
| Tabular work | DuckDB over uploaded tables; saved bounded query previews and CSV export in chat | Independently saved queries, parameters, result versions, repeatable comparisons and reviewed extraction tables |
| Artifacts | Report HTML/PDF, per-chat report versions/supersession, optional stored payload, chart registry | Narrative editing, targeted rewrites, reusable templates, data refresh and evidence-preserving exports |
| Knowledge | Uploads, account libraries, public CSV/JSON connectors with schedules/history | Selected-folder intake, incremental document refresh and authenticated knowledge services |
| Agents | Identity, versioned instructions, Markdown skills and built-in tool selection | MCP runtime/OAuth, reusable job/source/output setup and interactive agent test cases |
| Automation | Interval connector sync and agent turns into an existing chat | Calendar scheduling, refresh-then-analyze recipes, change comparison, review inbox and notifications |
| Local operation | Electron, linked OpenAI-compatible compute, managed operator-supplied local engine, verified downloads | Curated engine/model installation and a guided first successful analysis |

Source basis: [tool definitions and result snapshots](../server/src/tools.ts)
(`QueryResultArtifact`, `captureQueryResult`, `executeTool`),
[report routes](../server/src/routes/reports.ts),
[chart routes](../server/src/routes/charts.ts),
[connector schemas](../server/src/routes/schemas.ts),
[automation types](../server/src/automationStore.ts), and the
[agent rollout](AGENT_EDITOR_ROLLOUT.md). The inventory describes implemented
contracts, not a fresh end-to-end certification of every feature.

## What to learn from North and Perplexity

“Perplexity Local” is interpreted here as **Portable Computer**, the local
runtime referenced by the Borealis vision. Perplexity also has Computer and
Personal Computer offerings; access to local files in those products is not
by itself evidence that their inference runs locally.

| Reference | Evidence checked in this review | Lesson for Borealis |
| --------- | ------------------------------- | ------------------- |
| Cohere North | Its current public page emphasizes grounded discovery and document/table/chart creation. [North](https://cohere.com/north) | Complete the transition from answers to editable, reusable work products. |
| North Agent Studio | Publicly describes custom agents spanning data/tools and MCP integration. [Agent Studio](https://cohere.com/north/agent-studio) | Connections should support a repeatable specialist job, with visible inputs and outputs. |
| North Automations | Publicly describes multi-step workflows, testing, versioning, and human approval steps. [Automations](https://cohere.com/north/automations) | First build one useful refresh → analyze → draft → review recipe. |
| Perplexity Portable Computer | The launch describes on-device orchestration, scheduling, durable task state and local search, with authorized cloud escalation; its first release targets Linux on DGX Spark. [Launch](https://www.perplexity.ai/en-GB/hub/blog/introducing-portable-computer-for-local-first-ai) | Local files and continuing tasks should feel native to the product. Borealis's Mac UI and replaceable linked compute remain a useful architectural choice. |

These are vendor-described capabilities, not hands-on parity or quality tests.
The detailed North Document Mode, Tables, and Deep Research pages could not be
reopened through the research tool during this pass. Their editing, cell-review,
and research-flow details remain **2026-08-22 archived evidence**, not newly
verified release claims. See the dated
[artifact/research archive](cohere-north/06-documents-tables-research-and-artifacts.md).
Do not carry its Alpha labels or detailed contracts forward as current facts.

The strategic inference is that Borealis should specialize in repeatable work
over private documents and tabular data. This review does not establish that
competitors lack those capabilities or that Borealis already outperforms them.

## Recommended functional slices

Effort is coarse: **M** is a small focused slice; **L** is multiple development
days and likely several reviewable slices; **XL** needs a design pass and staged
milestones. These are relative scope estimates, not delivery dates. Confidence
describes the evidence for the gap, not validated market demand. Risks below
describe functional design trade-offs rather than a new cross-cutting audit.

### 1. Connected agents and reusable job setup

**Status:** MCP runtime/editor and OAuth are already pending; job presets are
proposed. **Effort:** L–XL. **Confidence:** high. **Functional risk:** high,
because connection behavior and external tool results vary substantially.

The v13 editor captures identity, skills, and seven built-in tools; it does not
yet connect them to additional systems. Finish the complete execution path in
[AGENT_EDITOR_ROLLOUT.md](AGENT_EDITOR_ROLLOUT.md): discovery, tool selection,
execution, sign-in/refresh, and lifecycle handling. Prove one useful knowledge
integration rather than making catalog size the release criterion.

Then add job presets such as “monthly operating review” and “diligence memo”:
starter questions, an output template, and suggested libraries. A test chat
should make effective inputs and capabilities visible. Suggested sources must
be explicitly selected at chat creation; future library members cannot
silently enter an existing selected chat.

**Evidence:** [agent schema](../server/src/routes/agents.ts), lines 21–33;
[editor tool selection](../web/src/components/AgentEditor.tsx), lines 300–329;
the existing rollout's pending second stage. MCP is not itself a source-ingestion
adapter: indexing connected documents still needs identity and refresh semantics.

**Acceptance example:** configure a specialist against one working connection,
select two tools, run a question that uses one, reopen the task, and inspect its
result. A subsequent configuration edit affects the next accepted turn only.

### 2. Saved analyses and reusable tables

**Status:** selected TODO — [M12](../milestones/M12-saved-analyses.md). **Effort:** L.
**Confidence:** high. **Functional risk:** medium, mainly stale inputs and the
distinction between a stored preview and a complete result.

Add “Save analysis” to a query result. Give it its own identity, title, SQL,
typed parameters, input provenance, result snapshot, and linked charts. Reopen
it outside chat, change a date range, explicitly choose current inputs, and
rerun to create a new result version. Start with deterministic parameterized
SQL and a simple table view; reuse the existing CSV export.

**Evidence:** [query snapshot capture](../server/src/tools.ts), lines 419–428,
uses run-local `query-N` identities; [CSV export](../web/src/components/DataResultCard.tsx),
lines 44–70, exports stored rows. [M02](../milestones/M02-artifacts.md) explicitly
deferred additional artifact kinds and regeneration.

Do not promise exact historical recomputation: old source generations need not
remain available. Preserve the original output and mark unavailable inputs.
SQL and evidence in current chat metadata are capped, so incomplete legacy
receipts cannot automatically become executable saved analyses. A full-result
export needs a separately specified bounded artifact, not a larger chat preview.

**Acceptance example:** save monthly spending by category, reload it from the
catalog, change the month, rerun against selected ready tables, and compare two
versions without altering the first. Make units, source freshness, and result
truncation visible. Values must match direct DuckDB results on the fixtures.

### 3. Editable reports and document workbench

**Status:** selected TODO — [M13](../milestones/M13-report-workbench.md).
**Effort:** L, expanding to XL for general rich documents.
**Confidence:** high. **Functional risk:** medium: preserve human edits and
avoid implying that changing prose also recomputed its numbers.

Start with a section editor beside chat: edit narrative, request a rewrite of
one section, inspect the proposed change, and save a new version. Preserve
chart references and add an explicit evidence appendix bound to that revision.
The current normalized report has sections, charts, and tables; capturing and
exporting structured supporting evidence is new scope. Add report templates and explicit
“refresh analysis” using saved analyses from slice 2. Manual revision can ship
independently of that refresh path.

**Evidence:** [report detail](../server/src/routes/reports.ts), lines 65–89,
already exposes the optional owner-only payload. The mutation at lines 93–107
only renames the report. [M02 non-goals](../milestones/M02-artifacts.md#non-goals)
leave content regeneration and documents for a later milestone.

Keep published versions intact; an edit creates a new revision. Define explicit
document identity before extending the existing per-chat supersession chain.
Legacy or oversized reports may lack a payload and need a visible read-only
state. Add Markdown and then DOCX export after revision semantics work; maintain
HTML/PDF as the initial formats. This is the smallest useful step toward North's
archived Document Mode, without building a full office suite.

**Acceptance example:** correct an executive summary, accept one suggested
rewrite, export the new version, and open the prior version unchanged. The
export includes the evidence associated with that revision and makes newly
computed values distinguishable from retained values.

### 4. Living libraries and inspectable source search

**Status:** selected TODO — [M14](../milestones/M14-living-libraries.md).
**Effort:** L per intake/search slice. **Confidence:** high.
**Functional risk:** medium: stable file identity, deleted/renamed files,
freshness, and source selection must have understandable behavior.

Let a desktop user select a folder, preview supported files, import them into
a library, and review changes on refresh. Start with manual incremental refresh,
then add a watch mode. Add corpus search and source detail: find an exact term
or semantic match, inspect its passage and available page/section location,
preview table columns, and see when the source was last refreshed. Page anchors
require extraction metadata; do not invent locations from excerpt text.

**Evidence:** [connector schema](../server/src/routes/schemas.ts), lines 150–163,
permits only `url_csv` and `url_json`; [M09](../milestones/M09-connector-platform.md)
deliberately kept that narrow catalog. [Retrieval](../server/src/retrieve.ts)
is a scoped vector query, while [citation metadata](../server/src/citations.ts),
lines 3–8, records source/chunk identity without page anchors.

After a selected-folder path is useful, choose one authenticated document
service from actual user demand. Preserve a separate distinction between live
MCP tool access and durable indexed sources. New library members do not expand
an existing selected chat; show an explicit scope-update action.

**Acceptance example:** import a small folder, edit one document, refresh only
changed inputs, inspect the new content in search, and retain the frozen
evidence in an earlier answer. Show what happens to renamed, removed, unreadable,
and unsupported files.

### 5. Local research dossiers and comparison tables

**Status:** selected TODO — [M15](../milestones/M15-local-research.md).
**Effort:** XL, beginning with a bounded local-corpus slice.
**Confidence:** high for the gap, medium for priority relative to daily analysis.
**Functional risk:** medium/high: longer runs are useful only if their coverage
and unsupported conclusions can be inspected.

Offer an editable research brief and question plan over an explicit corpus.
Track questions, collected evidence, disagreements, and unanswered questions in
a durable dossier; produce a cited memo from that dossier. A useful next slice
is typed extraction across documents: one row per vendor/contract, user-defined
columns, evidence for each extracted value, “not found” states, corrections,
and reviewed cells that survive reruns. This approaches the job served by
North's archived Tables mode without making a general spreadsheet clone.

**Evidence:** [agent loop](../server/src/agent.ts) and
[seven tools](../server/src/tools.ts) implement ordinary bounded turns, not a
research task model. The current evidence budget is eight passages with bounded
excerpts (`tools.ts:248–251`); a dossier needs its own storage/budget contract.
`fetch_url` (`tools.ts:591–598`) uses only URLs explicitly supplied in the turn.

Begin with a sequential local research workflow. Multiple agents are an
implementation option, not the feature. Web search and URL discovery should be
a separate explicit capability; do not quietly turn the existing URL fetch
into open-ended browsing. Source inspection and document revisions provide the
foundation; neither MCP nor public-web access is required for the first slice.

**Acceptance example:** compare ten synthetic supplier documents across five
fields, inspect supporting passages, identify missing or contradictory facts,
correct one cell, and regenerate the memo while preserving that correction.
Reopen a running task after UI reload and continue inspecting its progress.

### 6. Reviewed recurring briefs

**Status:** selected TODO — [M16](../milestones/M16-reviewed-briefs.md),
after artifact and freshness contracts. **Effort:** L–XL.
**Confidence:** high. **Functional risk:** medium: schedule time zones, missed
runs, input readiness, and the comparison baseline need explicit decisions.

Build one fixed workflow: refresh selected inputs → wait for ready data → run
a saved analysis → compare with the last successful version → draft a brief →
review. Add calendar/time-zone schedules, an in-app review inbox, and optional
notifications for meaningful changes or failures. Later, source-change triggers
can make the same recipe useful without a fixed interval.

**Evidence:** [automation types](../server/src/automationStore.ts), lines 18–20,
only permit connector sync and agent turns with active/paused state.
[The runner](../server/src/automationRunner.ts) executes those independently.
[M07 non-goals](../milestones/M07-team-platform.md#non-goals) defer multi-step
flows, other triggers, and notifications. Current output is reviewable in chat;
there is no separate human-approval state before artifacts appear in the workspace.

Do not introduce a generic graph editor yet. Define whether a failed refresh
blocks the brief or permits an explicitly labeled older snapshot. Users should
be able to see the input generations and previous successful baseline before
accepting a draft. Desktop schedules must explain behavior while the app is
closed; an always-on service would be a separate deployment decision.

**Acceptance example:** schedule a weekly finance brief, change a fixture,
produce a draft highlighting changed values, then approve it. A failed refresh
must be visible and must not masquerade as a fresh analysis.

## Sequencing and what to defer

Preserve the pending MCP rollout; it is already recorded product work. For new
scope, saved analyses and a small revision editor give the fastest path from
today's infrastructure to a repeatable analyst workflow. Folder intake and
source inspection can proceed independently. Research builds on inspectable
sources and artifacts. Recurring briefs consume the proven manual workflow.

Curated local-engine/model setup is a worthwhile adoption track: the current
contained path still requires operator-supplied pieces. First add a guided
working model pair and an optional sample-data analysis using existing Settings
qualification and fixtures. Make bundled-engine/model support its own scoped
decision; single-engine lifecycle management does not yet constitute a turnkey
chat-plus-embedding installation. Do not let this expand into a model manager
at the expense of the data workflow.

Defer broad connector marketplaces, implicit cross-chat memory, a generic
workflow graph, arbitrary computer/code actions, multiplayer document editing,
and additional desktop targets. None is required to prove the private analyst
workflow. Memory should first be explicit job configuration and saved work;
sharing should first carry a reviewable artifact.

## Documentation reconciliation and review limits

This pass corrected current guides and milestone prose that still described
live embedding apply as restart-only, contained configuration as direct
overwrite, the local-engine panel as missing, shared report reads as broken,
and common consent wording as unimplemented. It also clarified report versions
versus chart provenance and reviewable automation output versus an approval gate.
The completed embedding migration plan keeps its historical design with a
dated supersession note. Detailed historical research remains historical.

The functional roadmap does not replace or certify the engineering-remediation
ledger. In particular, provider-bound acknowledgment and reserved migrations
v14–v16 remain pending, and the original M03/M06/M07 completion does not imply
every later remediation plan is complete. Implementation plans require fresh
drift checks, scoped acceptance tests, and the repository's `pnpm verify` gate
plus the desktop/live-model checks applicable to their scope.

Reviewed: current feature routes, tool and artifact contracts, agent rollout,
milestone status, relevant tests, setup/vision/API/desktop guides, and selected
official competitor pages. Not performed: a new security/performance audit,
full remediation-plan reconciliation, live competitor testing, user research,
or a fresh packaged/live-model acceptance run. Documentation checks do not
establish that every documentation claim or runtime behavior has been verified.

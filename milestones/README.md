# Milestone ledger

**Ledger reviewed:** 2026-09-06 against `e2e6a78`, including the rich agent
editor, live embedding migration apply, and the functional product review.

The M05 extension now ships in `0987170`: identity, Markdown skills, atomic
configuration revisions, and built-in tool allowlists. MCP/OAuth is still pending.
The [agent rollout plan](../docs/AGENT_EDITOR_ROLLOUT.md) records this authorized
extension and its verification separately from M05’s original completion.

This directory holds **active** implementation milestones. Each milestone is a
self-contained specification (`Mnn-<slug>.md`) with tasks and done criteria;
implementation lands in reviewable slices committed against that spec.

`milestones/` is the active ledger. The numbered specifications under
[plans/](../plans/README.md) are the completed historical archive — do not
confuse the two. When a milestone here finishes, its spec stays as the record
and its status below flips to DONE.

The separate [advisor remediation ledger](../advisor-plans/README.md) tracks
audited engineering fixes. It does not replace this product milestone ledger or
turn the vision into a backlog.

**Coding-agent entry point:** [development handoff](../docs/DEVELOPMENT_HANDOFF.md),
[acceptance matrix](../docs/END_TO_END_ACCEPTANCE.md), and
[execution evidence](EXECUTION.md). The September 6 user request selected the
complete functional wave below for implementation; this commit supplies the
specifications, not the implementation. The
[copyable goal](../docs/IMPLEMENTATION_GOAL.md) delegates that complete scope.

Milestones implement [docs/VISION.md](../docs/VISION.md). That document is the
destination, not a backlog; each milestone below is one concrete step of one
horizon, scoped so it can be verified without the next one.

## Completed product baseline

| Milestone                         | Horizon | Title                                                                                 | Status  |
| --------------------------------- | ------- | ------------------------------------------------------------------------------------- | ------- |
| [M01](M01-ambient-locality.md)    | 1       | Ambient locality — health, model presence, and egress state in the chrome             | DONE    |
| [M02](M02-artifacts.md)           | 2       | Artifacts — report versions and lineage, stored payloads, and chart registry          | DONE    |
| [M03](M03-egress-consent.md)      | 1+2     | Egress consent cards — fail-closed gate and consent UI for direct payload routes      | DONE    |
| [M04](M04-libraries.md)           | 2       | Libraries — governed collections above a pile of uploads                              | DONE    |
| [M05](M05-named-agents.md)        | 2       | Named agents — versioned instructions with write-once chat bindings                   | DONE    |
| [M06](M06-contained-models.md)    | 1       | Contained-model lifecycle on macOS as a first-class mode                              | DONE    |
| [M07](M07-team-platform.md)       | 3       | Small-team platform — sharing snapshots, audit plane, automations                     | DONE    |
| [M08](M08-citations.md)           | 2       | Citations — numbered, clickable evidence that survives diligence review               | DONE    |
| [M09](M09-connector-platform.md)  | 2       | Connector platform surface — schedules on the connector, sync history, clean teardown | DONE    |
| [M10](M10-composer-instrument.md) | 1       | The composer as one instrument — libraries in the scope picker, answer typography     | DONE    |
| [M11](M11-personal-defaults.md)   | 2       | Personal defaults — the account's own default chat model                              | DONE    |

M03, M06, and M07 are now DONE. M03 closed its remaining disclosure-
consistency work on 2026-09-01: the consent card, sidebar strip, and Settings
privacy text render one shared payload-class constant
(`web/src/lib/egressDisclosure.ts`). M07 closed its remaining authorization
and wording defects on 2026-09-01: share recipients get read-only
detail/HTML/PDF with the stored payload kept owner-only, `connector_sync`
automations gate creation/update and recheck consent on every scheduled
execution, and Settings describes egress events as best-effort activity
receipts. M06 closed its remaining Settings-panel and hardening work on
2026-09-01: the Settings → Local engine panel ships with `containedApi`,
`contained.json` uses same-directory atomic replacement preserving mode
`0600`, and spawn failures enter the bounded engine state machine with
deterministic path diagnostics. The other written milestones are complete.
M12–M16 now specify the selected new product scope. The pending connected-agent
work remains the M05 extension with its own complete implementation spec.
These selections do not reopen completed M01–M11 or claim any new feature ships.
Remediation may close the existing milestone that owns the contract.
The operator-selected product slices in advisor plans 034–037 now ship as
bounded extensions of existing contracts: synthetic model-pair qualification,
managed embedding-index migration, local macOS PDF OCR, and offline portable
workspace archives. Their implementation record remains in the advisor ledger;
future expansion of those surfaces still requires an explicit milestone.

Completed sequencing notes:

- M01 is deliberately small and unblocks the chrome work in M03.
- M02 (artifact substrate) comes before M04/M05 because libraries and agents
  attach to and produce artifacts; "earn platform features" ordering.
- M06's contained-model backend was independent of M02–M05. Settings controls,
  atomic config replacement, and engine-start hardening completed the milestone
  on 2026-09-01. Curated engine/model installation is a separate future scope.
- Horizon 0 (honor what already works) has no milestone: it is the continuous
  obligation that `pnpm verify` and the personal-finance end-to-end fixture
  keep passing. M01–M11 established the product baseline, and completed advisor
  plans 024–037 hardened or extended it without replacing that obligation.
- M07 completed the first Horizon 3 substrate: same-instance report shares,
  content-free activity receipts, and interval automations. An explicit review
  inbox and workflows that refresh inputs before analysis remain future scope.
  The remaining sandbox
  clause — _optional contained or cluster-local sandboxes for code that earns
  the privilege_ — is deliberately **deferred**, not forgotten: Borealis has
  no arbitrary-code-execution surface today, and adding one without an
  OS-grade isolation story would violate the fail-closed invariants
  (AGENTS.md: "No user SQL that re-enables network. No renderer that navigates
  to user content."). It returns to the ledger only with a concrete sandbox
  design (hard process boundary, no network, no filesystem, bounded
  CPU/time/memory) that survives review. _Other desktops_ stays conditional
  on the same strictness bar.

## Selected functional wave

The selected direction is **repeatable, evidence-backed work over a living
corpus**. All six slices are now specified for implementation. The MCP rollout
remains pending and saved analyses is M12. This is a dependency order, not a
delivery calendar. Detailed rationale and dated competitive evidence live in the
[September product review](../docs/PRODUCT_REVIEW.md).

| Order | Functional slice | First useful outcome | Status / dependency |
| ----- | ---------------- | -------------------- | ------------------- |
| 1 | [Connected agents](../docs/MCP_CONNECTIONS.md), M05 extension | HTTP/stdio MCP, OAuth, selected tools and reusable job setup | TODO; schema/runtime prerequisite gate |
| 2 | [M12 saved analyses](M12-saved-analyses.md) | Parameterized SQL, preserved results, comparison and export outside chat | TODO; prerequisite gate; independent of MCP |
| 3 | [M13 report/document workbench](M13-report-workbench.md) | Edit/rewrite, review changes and export a new evidence-bearing version | TODO; M12 for data refresh |
| 4 | [M14 living libraries/search](M14-living-libraries.md) | Selected folders, watch/refresh, indexed WebDAV, source search/inspection | TODO; prerequisite gate and connection secret custody |
| 5 | [M15 local research](M15-local-research.md) | Question plan, dossier, cited memo and reviewed comparison table | TODO; M13/M14 and M12 provenance patterns |
| 6 | [M16 reviewed briefs](M16-reviewed-briefs.md) | Refresh, wait, analyze, compare, draft and review on a calendar schedule | TODO; M12/M13/M14 and drained scheduler |

MCP is an integration mechanism; each connection still needs a useful end-to-end
job. It does not by itself create indexed sources, a research mode, or a
workflow engine. Ship one knowledge integration before expanding a catalog.
Keep the already recorded MCP runtime/OAuth scope intact; staging individual
connectors is not permission to ship an incomplete execution path.

Saved analyses and report revisions are separate slices of an eventual artifact
workbench. Start with the deterministic data workflow and a simple section
editor, then add richer document export and reviewable extraction tables. A
general spreadsheet editor, a visual automation graph, broad implicit memory,
and general computer control are later options, not the next milestones.

The cross-cutting remediation ledger remains separate. Schema v13 ships;
v14–v16 stay reserved for the existing remediation work. The
[handoff prerequisite gate](../docs/DEVELOPMENT_HANDOFF.md#resolve-the-reserved-schema-sequence-first)
lists the exact dependency closure required before product migrations v17+.
No skipped versions, placeholders, renumbering, or assumed remediation completion.

Suggested release proof: use the personal-finance fixtures to save a monthly
analysis, revise its report, refresh the inputs, and produce a second version
whose changed numbers and evidence can be inspected. Add a second proof using
a small document corpus and a cited comparison table. Measure whether users can
repeat those jobs without reconstructing chat history, not how many new pages
or integrations were added. These scenarios are required by the acceptance
matrix; they were not executed in this documentation review.

## Verification record

- 2026-09-06: documentation/product review against `e2e6a78`; reconciled
  completed M03/M06/M07 prose, shared-report route descriptions, and live
  embedding-apply guidance. The follow-up selected all six functional slices;
  complete implementation specs, prerequisite closure, a copyable coding goal
  and an end-to-end acceptance/evidence ledger are now present. No new runtime
  functionality or milestone completion is claimed by this documentation pass.

- 2026-09-01: M07 closed — full server suite green (869 tests) after the
  shared-report authorization fix (recipient detail/HTML/PDF, payload
  owner-only) and the `connector_sync` consent gates; AGENTS.md drift
  paragraph removed. M06 closed — contained config store/engine suites green,
  Settings → Models panel shipped, and the live check passed on an isolated
  `BOREALIS_DATA_DIR`: fixture download with SHA-256 verification into the
  data directory (mode `0600`), stub engine start reached `healthy` with
  `/api/status` reporting the contained section and the provider origin
  auto-applied to the engine's loopback address, and stop restored the prior
  origin (`http://127.0.0.1:1234`) with no stub-engine process left behind.
- 2026-09-01: M03 closed — the consent card, sidebar strip, and Settings
  privacy text now render one shared payload-class constant
  (`web/src/lib/egressDisclosure.ts`); WorkspaceStatus, SettingsView, and
  useEgressConsentGate suites green; README and docs/VISION.md aligned.
- 2026-09-01: advisor plan wave 024–037 passed root `pnpm verify`, desktop
  `verify`, `package:unsigned`, packaged fuse/ASAR inspection, the packaged
  native/raster-OCR smoke, and the retained-entitlement matrix on Apple Silicon
  macOS. The content-free live pair qualifier also passed against loopback LM
  Studio with local Qwen 3.8 chat and 768-dimensional Nomic embeddings.
- 2026-08-29: complete `pnpm verify` green after M08–M11; the personal-finance
  end-to-end use case was re-run live against loopback LM Studio
  (`nvidia/nemotron-3-nano` chat, `text-embedding-nomic-embed-text-v1.5`
  embeddings, isolated `BOREALIS_DATA_DIR`): four CSV fixtures uploaded and
  ingested, a retrieval turn returned numbered evidence with resolved
  citations (`[1]`–`[5]` mapped to the four sources), the per-chat model
  switch route was exercised, and the analysis turn produced a chart and a
  self-contained report (1.0 MB HTML, `%PDF-` signature). Note: LM Studio's
  current runtime serves `qwen/qwen3.6-35b-a3b` without native tool calls;
  the README now documents the symptom and the requirement.

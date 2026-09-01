# Milestone ledger

**Ledger reviewed:** 2026-09-01 after advisor plan wave 024–037.

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

Milestones implement [docs/VISION.md](../docs/VISION.md). That document is the
destination, not a backlog; each milestone below is one concrete step of one
horizon, scoped so it can be verified without the next one.

## Roadmap

| Milestone                         | Horizon | Title                                                                                 | Status  |
| --------------------------------- | ------- | ------------------------------------------------------------------------------------- | ------- |
| [M01](M01-ambient-locality.md)    | 1       | Ambient locality — health, model presence, and egress state in the chrome             | DONE    |
| [M02](M02-artifacts.md)           | 2       | Artifacts — report versions and lineage, stored payloads, and chart registry          | DONE    |
| [M03](M03-egress-consent.md)      | 1+2     | Egress consent cards — fail-closed gate and consent UI for direct payload routes      | DONE    |
| [M04](M04-libraries.md)           | 2       | Libraries — governed collections above a pile of uploads                              | DONE    |
| [M05](M05-named-agents.md)        | 2       | Named agents — versioned instructions with write-once chat bindings                   | DONE    |
| [M06](M06-contained-models.md)    | 1       | Contained-model lifecycle on macOS as a first-class mode                              | PARTIAL |
| [M07](M07-team-platform.md)       | 3       | Small-team platform — sharing snapshots, audit plane, automations                     | PARTIAL |
| [M08](M08-citations.md)           | 2       | Citations — numbered, clickable evidence that survives diligence review               | DONE    |
| [M09](M09-connector-platform.md)  | 2       | Connector platform surface — schedules on the connector, sync history, clean teardown | DONE    |
| [M10](M10-composer-instrument.md) | 1       | The composer as one instrument — libraries in the scope picker, answer typography     | DONE    |
| [M11](M11-personal-defaults.md)   | 2       | Personal defaults — the account's own default chat model                              | DONE    |

M06 and M07 have shipped cores but remain partial: M06 needs its Settings
management panel and atomic config replacement plus engine-start hardening;
M07 needs shared-report authorization, connector-sync consent remediation, and
precise audit wording. M03 closed its remaining disclosure-consistency work on
2026-09-01: the consent card, sidebar strip, and Settings privacy text now
render one shared payload-class constant
(`web/src/lib/egressDisclosure.ts`). The other written milestones are
complete. New product scope receives M12
rather than turning the vision or historical plan archive into an implicit
backlog; remediation may close the existing milestone that owns the contract.
The operator-selected product slices in advisor plans 034–037 now ship as
bounded extensions of existing contracts: synthetic model-pair qualification,
managed embedding-index migration, local macOS PDF OCR, and offline portable
workspace archives. Their implementation record remains in the advisor ledger;
future expansion of those surfaces still requires an explicit milestone.

Completed sequencing notes:

- M01 is deliberately small and unblocks the chrome work in M03.
- M02 (artifact substrate) comes before M04/M05 because libraries and agents
  attach to and produce artifacts; "earn platform features" ordering.
- M06's shipped contained-model backend was heavy and independent of M02–M05;
  its missing Settings controls, atomic config replacement, and engine-start
  hardening remain recorded in that milestone.
- Horizon 0 (honor what already works) has no milestone: it is the continuous
  obligation that `pnpm verify` and the personal-finance end-to-end fixture
  keep passing. M01–M11 established the product baseline, and completed advisor
  plans 024–037 hardened or extended it without replacing that obligation.
- M07 delivered the first Horizon 3 substrate (same-instance report shares,
  content-free activity receipts, and interval automations), but its current
  authorization gaps keep the milestone partial. The remaining sandbox
  clause — _optional contained or cluster-local sandboxes for code that earns
  the privilege_ — is deliberately **deferred**, not forgotten: Borealis has
  no arbitrary-code-execution surface today, and adding one without an
  OS-grade isolation story would violate the fail-closed invariants
  (AGENTS.md: "No user SQL that re-enables network. No renderer that navigates
  to user content."). It returns to the ledger only with a concrete sandbox
  design (hard process boundary, no network, no filesystem, bounded
  CPU/time/memory) that survives review. _Other desktops_ stays conditional
  on the same strictness bar.

## Verification record

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

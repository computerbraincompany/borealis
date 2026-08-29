# Milestone ledger

This directory holds **active** implementation milestones. Each milestone is a
self-contained specification (`Mnn-<slug>.md`) with tasks and done criteria;
implementation lands in reviewable slices committed against that spec.

`milestones/` is the active ledger. The numbered specifications under
[plans/](../plans/README.md) are the completed historical archive — do not
confuse the two. When a milestone here finishes, its spec stays as the record
and its status below flips to DONE.

Milestones implement [docs/VISION.md](../docs/VISION.md). That document is the
destination, not a backlog; each milestone below is one concrete step of one
horizon, scoped so it can be verified without the next one.

## Roadmap

| Milestone | Horizon | Title | Status |
|---|---|---|---|
| [M01](M01-ambient-locality.md) | 1 | Ambient locality — health, model presence, and egress state in the chrome | DONE |
| [M02](M02-artifacts.md) | 2 | Artifacts — reports, charts, and query receipts with versions and lineage | DONE |
| [M03](M03-egress-consent.md) | 1+2 | Egress consent cards — fail-closed gate and consent UI before data leaves the Mac | DONE |
| [M04](M04-libraries.md) | 2 | Libraries — governed collections above a pile of uploads | DONE |
| [M05](M05-named-agents.md) | 2 | Named agents — versioned instructions, tools, and source bindings | DONE |
| [M06](M06-contained-models.md) | 1 | Contained-model lifecycle on macOS as a first-class mode | DONE |
| [M07](M07-team-platform.md) | 3 | Small-team platform — sharing snapshots, audit plane, automations | PLANNED |

Unwritten specs are placeholders; a milestone gets its numbered file when its
turn comes. Sequencing notes:

- M01 is deliberately small and unblocks the chrome work in M03.
- M02 (artifact substrate) comes before M04/M05 because libraries and agents
  attach to and produce artifacts; "earn platform features" ordering.
- M06 (contained models) is heavy and independent; it may be pulled forward or
  deferred without invalidating M02–M05.
- Horizon 0 (honor what already works) has no milestone: it is the continuous
  obligation that `pnpm verify` and the personal-finance end-to-end fixture
  keep passing. It is already satisfied by plans 001–030.

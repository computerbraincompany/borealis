# Functional-wave execution and evidence

**Created:** 2026-09-06 against `e2e6a78`. The documentation handoff is complete
only as a specification; **all implementation and acceptance rows below begin
TODO / NOT RUN**. This ledger is owned by the coordinating coding agent.
Read [the handoff](../docs/DEVELOPMENT_HANDOFF.md) before executing.

## Implementation status

| Work | State | Implementation commit | Verification evidence |
| ---- | ----- | --------------------- | --------------------- |
| Prerequisite closure 001,003–009,011–016,020 | TODO | — | Reconcile individual plans; do not infer completion from old statuses |
| Connected agents: MCP, OAuth, job setup | TODO | — | — |
| M12 saved analyses | TODO | — | — |
| M13 report/document workbench | TODO | — | — |
| M14 living libraries/search/WebDAV | TODO | — | — |
| M15 local research/comparison tables | TODO | — | — |
| M16 reviewed recurring briefs | TODO | — | — |
| Common product E2E harness | TODO | — | — |
| Current docs and archive/restore integration | TODO | — | — |

Use TODO, IN PROGRESS, DONE, or BLOCKED with specific evidence. Expand each row
into its milestone's checkbox list as work begins. Already implemented portions
of an advisor plan may be verified rather than rewritten, but its remaining
required contract must still be satisfied.

## Migration allocation

| Version | Owner | State |
| ------- | ----- | ----- |
| v1–v13 | Existing applied history, including rich agent editor | Implemented baseline; upgrade tests required |
| v14 | Advisor 006 provider-bound consent | Reserved, not implemented at handoff |
| v15 | Advisor 012 automation ownership | Reserved, not implemented at handoff |
| v16 | Advisor 020 typed connector repair | Reserved, not implemented at handoff |
| v17+ | Allocate in actual serialized integration order | Unallocated; no placeholders or jumps |

## Integrated acceptance

| Check | State | Final source commit | Command / artifact / notes |
| ----- | ----- | ------------------- | -------------------------- |
| A connected specialist | NOT RUN | — | Browser + packaged HTTP/stdio/OAuth |
| B saved finance analysis | NOT RUN | — | Real DuckDB numerical comparison |
| C report revision and exports | NOT RUN | — | Visual document/PDF check |
| D living corpus and search | NOT RUN | — | Native folder + authenticated WebDAV |
| E research/comparison | NOT RUN | — | Evidence, corrections and recovery |
| F reviewed recurring brief | NOT RUN | — | Calendar/DST/freshness/approval |
| Upgrade and stopped archive/restore | NOT RUN | — | All new durable objects |
| Root `pnpm verify` | NOT RUN | — | — |
| Desktop verify | NOT RUN | — | — |
| Fresh unsigned packaging | NOT RUN | — | — |
| Packaged native and entitlement smokes | NOT RUN | — | — |
| Final browser product E2E | NOT RUN | — | New script required |
| Final packaged desktop product E2E | NOT RUN | — | New script required |
| Final live-model product E2E | NOT RUN | — | Tool-capable local model pair required |
| Fresh-context integrated review | NOT RUN | — | Reviewer, findings and resolutions |

Use PASS, FAIL, NOT RUN or BLOCKED for checks. No synthetic credential, private
prompt, raw tool result, real document, or provider exception belongs here.
Store only content-free summaries and synthetic fixture artifact references.

## Decisions and unresolved blockers

Record new integration decisions here with affected spec links. Do not silently
remove a requirement, relax an invariant, or label a blocker as completion.
No external blocker has been evaluated by this documentation-only handoff.

## Documentation handoff checks

2026-09-06: `pnpm policy` and `git diff --check` passed. A local Markdown link
check resolved 218 file/heading references across all 24 changed documents.
Cross-spec review reconciled source snapshots, shared connection secrets,
document bounds and asynchronous review/publication. These are documentation
checks only; they do not change any implementation or product acceptance status.

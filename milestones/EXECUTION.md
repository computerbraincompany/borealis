# Functional-wave execution and evidence

**Created:** 2026-09-06 against `e2e6a78`. The documentation handoff is complete
only as a specification; **all implementation and acceptance rows below begin
TODO / NOT RUN**. This ledger is owned by the coordinating coding agent.
Read [the handoff](../docs/DEVELOPMENT_HANDOFF.md) before executing.

## Implementation status

| Work | State | Implementation commit | Verification evidence |
| ---- | ----- | --------------------- | --------------------- |
| Prerequisite closure 001,003–009,011–016,020 | IN PROGRESS | 001 `50d70b7`, 003 `795ebad`, 011 `042bec1`, 004 `9c14f40`, 009 `f3dc381`, 015 `5640f66`, 005 `c150ac7`, 006 `418f7a9` (v14), 012 `642032d` (v15), 013 `1a6be8e`, 007 `394ba6b` | 11 of 13 merged 2026-09-06 after per-diff review; merged-main gates green after each batch (922 unit + 97 integration post-007; web 316; policy/desktop-verify pass at baseline). 012/013/007 passed full root `pnpm verify` in worktrees before merge; 007's single serverApp.test.ts hoist-mock conflict resolved by the coordinator during rebase (both sides kept). 008 + web 007b contained-projection adaptation executing; then 014 → 016 → 020(v16). Protocol: one subagent per plan in `../north-clone-wt/<plan>`, plan-scoped ownership; coordinator reviews diffs, rebases in-worktree + ff-merges, runs integrated gates. Load flake: re-run 5 s-budget subprocess tests before treating as failure. |
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
| v14 | Advisor 006 provider-bound consent | Implemented `418f7a9` 2026-09-06 (`users.remote_egress_ack_origin`, fixture v014, upgrade tests green) |
| v15 | Advisor 012 automation ownership | Implemented `642032d` 2026-09-06 (owned `connector_id`/`chat_id` + generated `target_id`, FK cascades, partial unique schedule, fixture v015) |
| v16 | Advisor 020 typed connector repair | Reserved; implemented when plan 020 lands |
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

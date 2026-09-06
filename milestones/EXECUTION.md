# Functional-wave execution and evidence

**Created:** 2026-09-06 against `e2e6a78`. The documentation handoff is complete
only as a specification; **all implementation and acceptance rows below begin
TODO / NOT RUN**. This ledger is owned by the coordinating coding agent.
Read [the handoff](../docs/DEVELOPMENT_HANDOFF.md) before executing.

## Implementation status

| Work | State | Implementation commit | Verification evidence |
| ---- | ----- | --------------------- | --------------------- |
| Prerequisite closure 001,003–009,011–016,020 | DONE | 001 `50d70b7`, 003 `795ebad`, 011 `042bec1`, 004 `9c14f40`, 009 `f3dc381`, 015 `5640f66`, 005 `c150ac7`, 006 `418f7a9` (v14), 012 `642032d` (v15), 013 `1a6be8e`, 007 `394ba6b` (+ web 007b `41a10e3` adaptation), 008 `fb99667`, 014 `8e92643`, 016 `e310a80`, 020 (v16) | ALL 15 slices merged 2026-09-06 after per-diff review; every slice executed by a bounded subagent in an isolated worktree with plan-scoped file ownership, reviewed diff-by-diff by the coordinator, rebased and fast-forward merged by the single migrations owner. Merged-main gates green after each batch; 012/013/007/008/014/016/020 passed full root `pnpm verify` in worktrees before merge (014 also `borealis-desktop verify`). Prerequisite gate CLOSED 2026-09-06; Phase B allocates v17+ in actual integration order. Phase B v17+ pre-allocations will be recorded here at merge time (plan: v17 connections/MCP infra, v18 M12 — actual integration order rules). Protocol: one subagent per plan in `../north-clone-wt/<plan>`, plan-scoped ownership; coordinator reviews diffs, rebases in-worktree + ff-merges, runs integrated gates. Load flake: re-run 5 s-budget subprocess tests before treating as failure. |
| Connected agents: MCP, OAuth, job setup | IN PROGRESS | v17+store/secrets/routes `8d7a48d` | Stage 1 merged 2026-09-06: schema v17 (connections + tool snapshots, byte-exact v017.sql), account-scoped store (revision CAS, ≤20 quota, discovery budgets), AES-GCM secret custody (0600 atomic records, key file, injectable desktop keychain seam), connection routes with seam transports (real 501/503 codes, no fake success). Stage 2 (real SDK transports vs committed fixtures) executing; stages 3–6 pending (OAuth, agent-turn, UI, desktop/docs). |
| M12 saved analyses | IN PROGRESS | v18 stage 1 `57802f5` | Stage 1 merged 2026-09-06 (coordinator-rebased onto v17; v001–v018 contiguous, upgrade loop asserts analyses tables from every historical start): definitions/revisions/runs/results stores, one-active-run + operation-UUID idempotent acceptance, frozen run provenance immune to source deletion, full-query capture committed only with successful completion (`can_save_analysis` affordance, never SQL in receipts). Stage 2 (worker typed binding + input leases + analysisRunner) executing. |
| M13 report/document workbench | TODO | — | — |
| M14 living libraries/search/WebDAV | TODO | — | — |
| M15 local research/comparison tables | TODO | — | — |
| M16 reviewed recurring briefs | TODO | — | — |
| Common product E2E harness | IN PROGRESS | fixtures `2b9f01f` + `876bce0` | Protocol fixtures (scripted OpenAI provider SSE/tool-call/float-embeddings, MCP stdio+Streamable-HTTP incl. >64 KiB/invalid-schema/201-tool/bear modes, OAuth issuer PKCE+rotation+expiry, Basic-auth WebDAV PROPFIND/GET/redirect-refusal) + byte-stable ten-document supplier corpus + finance 100/125 fixtures under `scripts/e2e/fixtures/` and `data/e2e/`; `node scripts/e2e/fixtures/selftest.mjs` PASS 69 checks on main 2026-09-06, no leaked children. Harness drivers A–F + root `test:e2e:product*` commands still TODO. |
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
| v16 | Advisor 020 typed connector repair | Implemented 2026-09-06 (`connector_refresh_states` phase CAS + legacy-meta transactional backfill with rollback-on-malformed + plan-016 index handoff; fixture v016) |
| v17 | Connected agents (connections + tool snapshots) | Implemented `8d7a48d` 2026-09-06; fixture v017 |
| v18 | M12 saved analyses (+ query captures) | Implemented `57802f5` 2026-09-06; fixture v018; ledger contiguous v1–v18, all upgrade paths green |
| v19+ | Allocate in actual serialized integration order | Next: M13 documents / M14 knowledge tables as they land |

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

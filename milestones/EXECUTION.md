# Borealis v1 execution and evidence

**Updated:** 2026-09-07. V1 is the functional wave defined in
[the completion goal](../docs/IMPLEMENTATION_GOAL.md) and
[acceptance contract](../docs/END_TO_END_ACCEPTANCE.md), not a signed public release.
**The functional v1 goal is complete.** Runtime closure fixes are committed and
pushed through `1e56b21`; the final acceptance harness is `3a1695d`. All required
local repository, desktop, package, browser, native, storage, process-lifecycle
and live-model gates passed on that runtime. Native acceptance completed all
17 fresh checkpoints on the final package, including actual cancellation of a
held watched-folder embedding response through native Cmd+Q. Processes and
locks were released and the disposable workspace was removed cleanly.

Linux CI also passes. Hosted macOS CI cannot enforce the required
library-validation negative test because its runners disable SIP. A SIP-enabled
Apple Silicon runner is an infrastructure follow-up; the required local
entitlement command passed on the final package. No security gate is waived or
failed hosted run presented as a pass.

## Implementation status

| Work | State | Current implementation and verification |
| --- | --- | --- |
| Selected prerequisite remediation | DONE | Fifteen prerequisite slices landed before product migrations. Provider consent, storage, ownership, bounds and async UI invariants remain enforced. |
| Connected agents, OAuth and reusable jobs | DONE | Both transports, real OAuth, sealed credential custody, frozen per-turn tools, job confirmation. V1 closure connects catalog output templates to the actual frozen job prompt, preserving legacy instruction templates and ownership/budget validation. |
| M12 saved analyses | DONE | Parameterized queries, immutable results/provenance, independent numeric comparisons, exports and restart recovery. |
| M13 document workbench | DONE | Revision editing, reviewed rewrites, templates, publication and four exports. Browser C now exercises actual chart lineage and a payload-less legacy report without skips. Print wrapping and chart title/legend layout repaired after visual inspection. |
| M14 living libraries | DONE | Folder import/refresh/watch and WebDAV import/refresh, passage search, source generation evidence and reconnect/reselect behavior. Native folder acceptance requires the packaged OS picker. |
| M15 local research | DONE | Reviewed plans, captured evidence, typed cells, correction overlays, reruns and exports. Live acceptance now drives the research UI and checks fixture facts. Extraction explicitly requests evidence references; uncited values remain invalid. |
| M16 reviewed briefs | DONE | Durable calendar runs, review inbox, approve/reject and immutable publication. Editor now previews three server-resolved local/UTC occurrences before saving; a single manual run no longer displays a coalescence badge. |

## Acceptance evidence

All evidence uses isolated synthetic workspaces. PASS means the named check ran;
all required functional acceptance gates are complete. Logs and artifact paths
below are local retained evidence, not portable release assets. No credentials,
provider payloads or user data belong in this ledger.

| Check | Outcome | Evidence |
| --- | --- | --- |
| Full root gate | PASS | `TURBO_CONCURRENCY=2 pnpm verify`, 16/16 tasks and `ALL GATES GREEN`; server 1,317 unit + 433 integration, web 493, desktop 34. `/tmp/borealis-v1-permission-verify-final.log`. |
| Desktop verify and GUI renderer | PASS | `/tmp/borealis-v1-permission-desktop-verify.log`: 34 tests, native utility-process loads, GUI PNG/PDF smoke; zero network hits and both unsafe requests blocked. |
| Fresh unsigned package | PASS | `/tmp/borealis-v1-permission-package.log`, 5/5 tasks; `/tmp/borealis-v1-permission-packaged-native.log` and `/tmp/borealis-v1-permission-entitlements.log` pass, including both genuine negative entitlement removals. Final ASAR SHA-256 `7e80766679d6744e8e7c18abaaa10901087ec4733701e2f196267eb8e1bc5b8d`. |
| Final browser A–F | PASS | 16:55:15–16:59:01 UTC, `/tmp/borealis-v1-1e56-browser-final/summary.json`; all six journeys pass, no skipped checks, clean workspace/lock/process cleanup. |
| Hosted CI | LINUX PASS; MACOS BLOCKED | Run `34150633648` on `3a1695d`: Linux `ALL GATES GREEN`, 16/16 tasks, server 1,317 + 433, web 493, desktop 34. Hosted macOS 15 and 26 disable SIP and run successfully without the library-validation entitlement despite exact main/helper signatures. A SIP-enabled runner is required; none is registered. Strict checks remain enforced. |
| Native packaged A–F | PASS | 18:11:35–18:35:44 UTC, `/tmp/borealis-v1-native-final-evidence-5/summary.json`: all six journeys and all [17 fresh checkpoints](../scripts/e2e/NATIVE_DESKTOP.md). Actual post-expiry OAuth refresh, unreadable-file recovery, native exports and reviews passed. Native Cmd+Q cancelled the exact active scheduled watched-folder refresh with an explicitly held response, zero hold expiry and zero outstanding responses afterward; processes/locks gone, workspace removed, no cleanup problems. |
| Browser C including historical report | PASS | 14:20:41–14:21:04 UTC, `/tmp/borealis-v1-c-complete-evidence/summary.json`; actual chart copied from chat, legacy UI preview/download/copy denial, all exports. No skipped checks; clean lock/process cleanup. |
| Protocol fixture self-test | PASS | 82 checks, including exact chart UUID echo and missing/duplicate refusal. |
| Populated upgrade, managed migrations and offline archive | PASS | 16:56:00–16:56:07 UTC, `/tmp/borealis-v1-1e56-storage-final/storage-summary.json`; populated v13→v28, 36 product tables, both live managed embedding variants, encrypted archive create/inspect/restore/verify/live-lock refusal, 15 preserved artifact files and three reconnect/reselect states. Uses supported source TypeScript/CLI path with retained source/compiled fingerprints on `1e56b21`. |
| Live finance and research UI | PASS | Final runtime `1e56b21`, 16:55:16–17:05:42 UTC, `/tmp/borealis-v1-1e56-live-final/summary.json`: live Qwen 3.6 / Nomic 768-dimensional pair qualified on the first attempt; 14/14 finance rows and 12 supported typed research facts checked, missing exceptions preserved. Research ends `needs_review`; workspace/lock/process cleanup is clean. |
| Export visual inspection | PASS | Rendered both DOCX files and all PDF pages from browser C using bundled LibreOffice/Poppler. Long unbroken text now wraps, chart title/legend/axis labels are separate, tables and evidence readable. Final `1e56b21` browser-C exports rendered under `/tmp/borealis-v1-1e56-{pdf,docx}-reviewed`: all six stress-test PDF pages and three DOCX pages inspected; headings stay with content and long text wraps within margins. Final native-C PDF (2 pages) and DOCX (1 page) rendered and inspected under `/tmp/borealis-v1-native5-export-review/{pdf,docx}`; narration, table and chart remain readable without clipping, and unverified manual claims remain disclosed. |
| Focused closure regressions | PASS | Job template server21/web43, schedule preview server18/web31, report/chart/render76; meaningful ownership, immutable prompt, DST/auth, stale-preview and print geometry checks. Full gate remains authoritative. |
| Process-boundary lifecycle closure | PASS | 16:55:39–16:57:02 UTC, `/tmp/borealis-v1-1e56-lifecycle-final/summary.json`; all seven cases and thirteen checks, no skips. Real research crash/reopen, active rewrite/research/MCP/analysis/render/WebDAV/brief shutdown, exact recovery/artifact preservation, actual closed-across-due catch-up. Workspace/process/lock cleanup clean. [Repeatable command](../scripts/e2e/LIFECYCLE.md). |
| Independent integrated review | PASS | Product, export, schedule, job and research changes reviewed; final lifecycle/native harness reviewed for meaningful state, retained identities, exact artifacts, cancellation and cleanup. Native harness 10/10 and explicit held-embedding fixture 4/4 tests; provider fixture 20 and full protocol fixture 82 checks. All 130 Markdown files, 570 local links and 18 anchor links resolve. |

## Durable migration allocation

| Version | Owner | State |
| ------- | ----- | ----- |
| v1–v13 | Existing applied history, including rich agent editor | Implemented baseline; upgrade tests required |
| v14 | Advisor 006 provider-bound consent | Implemented `418f7a9` 2026-09-06 (`users.remote_egress_ack_origin`, fixture v014, upgrade tests green) |
| v15 | Advisor 012 automation ownership | Implemented `642032d` 2026-09-06 (owned `connector_id`/`chat_id` + generated `target_id`, FK cascades, partial unique schedule, fixture v015) |
| v16 | Advisor 020 typed connector repair | Implemented 2026-09-06 (`connector_refresh_states` phase CAS + legacy-meta transactional backfill with rollback-on-malformed + plan-016 index handoff; fixture v016) |
| v17 | Connected agents (connections + tool snapshots) | Implemented `8d7a48d` 2026-09-06; fixture v017 |
| v18 | M12 saved analyses (+ query captures) | Implemented `57802f5` 2026-09-06; fixture v018; ledger contiguous v1–v18, all upgrade paths green |
| v19 | M14 knowledge ledger | Implemented + merged 2026-09-06 (contiguously before v20; pending gap closed at merge) |
| v20 | M13 document ledger | Implemented + merged; ledger contiguous v1–v20 |
| v21 | MCP accepted-run binding snapshot (`chat_runs.agent_mcp_tools`) | Implemented + merged 2026-09-06 |
| v22 | M13 document templates (coordinator re-keyed from the executor's self-claimed v21) | Implemented + merged 2026-09-06; ledger contiguous v1–v22 |
| v23 | M13 document_rewrites | Implemented + merged 2026-09-06 |
| v24 | M14 search/locators (FTS5 + segment meta) | Implemented + merged 2026-09-06; ledger contiguous v1–v24, all tripwires at 24 |
| v25 | M15 research ledger | Implemented + merged 2026-09-06 |
| v26 | M16 brief ledger + calendar | Implemented + merged 2026-09-06; ledger contiguous v1–v26 |
| v27 | M16 brief_recipes.notifications_enabled (allocated to the stage-2 slice) | Implemented + merged 2026-09-06 |
| v28 | M16 brief_runs.publication_error_code indicator (stage 3) | Implemented + merged 2026-09-06; ledger contiguous v1–v28 |
| v29+ | Allocate at dispatch only | No placeholders or jumps; contiguity revalidated at every merge |


## Completion and follow-up

Machine-readable retained results are in [the v1 evidence summary](evidence/v1-2026-09-07.json).
No functional v1 implementation or required acceptance work remains.

Hosted macOS CI remains an infrastructure follow-up: ordinary hosted macOS 15
and 26 cannot enforce the unchanged strict entitlement negative control. The
[functional goal](../docs/IMPLEMENTATION_GOAL.md) and
[acceptance contract](../docs/END_TO_END_ACCEPTANCE.md) require that command on
the supported local Mac, where the final package passed; they do not require
provisioning a CI runner. Earlier blocker summaries incorrectly added that
condition. Keep the failed hosted result visible and use a SIP-enabled runner
when restoring the CI packaging pipeline.

Earlier native attempts remain historical evidence. Attempt three passed on an
intermediate package that preceded the permission fix. Attempt four passed A–F
but correctly failed the quit check because the eight-second delayed embedding
completed before Cmd+Q. Attempt five repeated the entire native gate on the
final package with an explicit held response: timeout is a failure, never a
success. It passed with the same scheduled refresh cancelled, no expired hold,
and complete cleanup. No required scenario was replaced by an attestation or
mock; native checkpoints used actual OS interaction and independent durable
state/export checks.

The [initial execution record](EXECUTION-2026-09-07-initial.md) preserves earlier
slice commits and integrity incidents as history. Its obsolete blockers and
subset completion labels are not current status. No applied migration is changed
by the closure fixes.

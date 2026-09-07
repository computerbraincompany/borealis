# Borealis v1 execution and evidence

**Updated:** 2026-09-07. V1 is the functional wave defined in
[the completion goal](../docs/IMPLEMENTATION_GOAL.md) and
[acceptance contract](../docs/END_TO_END_ACCEPTANCE.md), not a signed public release.
Runtime closure fixes are committed and pushed in `9fd2944` and `ec63c5e`.
The final repository, desktop, package, browser, storage and process-lifecycle
gates pass. The lifecycle audit found and repaired three real shutdown defects:
late-idle HTTP sockets, unjoined knowledge cancellation finalizers, and SDK abort
errors incorrectly failing resumable brief narration. Final native acceptance
awaits macOS Keychain approval for the rebuilt package; no final A–F checkpoint
has run yet. The superseded package's native A–C pass is retained only as
intermediate evidence, not final acceptance.

## Implementation status

| Work | State | Current implementation and verification |
| --- | --- | --- |
| Selected prerequisite remediation | DONE | Fifteen prerequisite slices landed before product migrations. Provider consent, storage, ownership, bounds and async UI invariants remain enforced. |
| Connected agents, OAuth and reusable jobs | Implemented; final acceptance running | Both transports, real OAuth, sealed credential custody, frozen per-turn tools, job confirmation. V1 closure connects catalog output templates to the actual frozen job prompt, preserving legacy instruction templates and ownership/budget validation. |
| M12 saved analyses | Implemented; final acceptance running | Parameterized queries, immutable results/provenance, independent numeric comparisons, exports and restart recovery. |
| M13 document workbench | Implemented; final acceptance running | Revision editing, reviewed rewrites, templates, publication and four exports. Browser C now exercises actual chart lineage and a payload-less legacy report without skips. Print wrapping and chart title/legend layout repaired after visual inspection. |
| M14 living libraries | Implemented; final acceptance running | Folder import/refresh/watch and WebDAV import/refresh, passage search, source generation evidence and reconnect/reselect behavior. Native folder acceptance requires the packaged OS picker. |
| M15 local research | Implemented; final acceptance running | Reviewed plans, captured evidence, typed cells, correction overlays, reruns and exports. Live acceptance now drives the research UI and checks fixture facts. Extraction explicitly requests evidence references; uncited values remain invalid. |
| M16 reviewed briefs | Implemented; final acceptance running | Durable calendar runs, review inbox, approve/reject and immutable publication. Editor now previews three server-resolved local/UTC occurrences before saving; a single manual run no longer displays a coalescence badge. |

## Acceptance evidence

All evidence uses isolated synthetic workspaces. PASS means the named check ran;
NOT RUN means the current source still awaits that gate. Logs and artifact paths
below are local retained evidence, not portable release assets. No credentials,
provider payloads or user data belong in this ledger.

| Check | Outcome | Evidence |
| --- | --- | --- |
| Full root gate | PASS | `pnpm verify`, 16/16 tasks and `ALL GATES GREEN`; server 1,314 unit + 414 integration, web 485, desktop 29. `/tmp/borealis-v1-final-verify-lifecycle.log`. |
| Desktop verify and GUI renderer | PASS | `/tmp/borealis-v1-final-desktop-verify-lifecycle.log`: tests, native utility-process loads, GUI PNG/PDF smoke; zero network hits and both unsafe requests blocked. |
| Fresh unsigned package | PASS | `/tmp/borealis-v1-final-package-lifecycle.log`, 5/5 tasks; `/tmp/borealis-v1-final-packaged-native-lifecycle.log` and `/tmp/borealis-v1-final-entitlements-lifecycle.log` pass, including both negative entitlement removals. Final ASAR SHA-256 `77cc92964d4882213f36093644a2b7ae9eed79ab8909282abdd73da983633605`. |
| Final browser A–F | PASS | 15:43:53–15:47:27 UTC, `/tmp/borealis-v1-ec63-browser-final/summary.json`; all six journeys pass, no skipped checks, clean workspace/lock/process cleanup. |
| Native packaged A–F | BLOCKED | Normal hardened startup in `/tmp/borealis-v1-native-final-3` is waiting in macOS Keychain before renderer bootstrap. [Native driver contract](../scripts/e2e/NATIVE_DESKTOP.md); the complete reviewed harness also requires actual scheduled folder refresh plus in-flight embedding before Cmd+Q, the same refresh cancelled, and process/lock cleanup. No final native pass claimed. |
| Browser C including historical report | PASS | 14:20:41–14:21:04 UTC, `/tmp/borealis-v1-c-complete-evidence/summary.json`; actual chart copied from chat, legacy UI preview/download/copy denial, all exports. No skipped checks; clean lock/process cleanup. |
| Protocol fixture self-test | PASS | 82 checks, including exact chart UUID echo and missing/duplicate refusal. |
| Populated upgrade, managed migrations and offline archive | PASS | 15:47:16–15:47:23 UTC, `/tmp/borealis-v1-ec63-storage-final/storage-summary.json`; populated v13→v28, 36 product tables, both live managed embedding variants, encrypted archive create/inspect/restore/verify/live-lock refusal, exact artifact preservation and reconnect/reselect states. |
| Live finance and research UI | FINAL RUN IN PROGRESS | Latest completed run 15:32:29–15:47:58 UTC, `/tmp/borealis-v1-shutdown-live-final/summary.json`: 14/14 finance rows, 12/12 supported typed facts, missing exceptions preserved; final research status needs_review and clean cleanup. It began before the final brief-abort fix. Exact-final-commit rerun retains evidence in `/tmp/borealis-v1-ec63-live-final`. |
| Export visual inspection | PASS | Rendered both DOCX files and all PDF pages from browser C using bundled LibreOffice/Poppler. Long unbroken text now wraps, chart title/legend/axis labels are separate, tables and evidence readable. Final browser-C PDF rerender `/tmp/borealis-v1-pdf-reviewed-T` confirms headings stay with content on all six stress-test pages. |
| Focused closure regressions | PASS | Job template server21/web43, schedule preview server18/web31, report/chart/render76; meaningful ownership, immutable prompt, DST/auth, stale-preview and print geometry checks. Full gate remains authoritative. |
| Process-boundary lifecycle closure | PASS | 15:37:31–15:39:02 UTC, `/tmp/borealis-v1-lifecycle-final-evidence-v3/summary.json`; all seven cases and thirteen checks, no skips. Real research crash/reopen, active rewrite/research/MCP/analysis/render/WebDAV/brief shutdown, exact recovery/artifact preservation, actual closed-across-due catch-up. Workspace/process/lock cleanup clean. [Repeatable command](../scripts/e2e/LIFECYCLE.md). |
| Independent integrated review | PASS | Product, export, schedule, job and research changes reviewed; final lifecycle/native harness reviewed for meaningful state, retained identities, exact artifacts, cancellation and cleanup. Native harness 8/8 tests; provider fixture 20 and full protocol fixture 82 checks. All 130 Markdown files, 565 local links and 17 anchor links resolve. |

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


## Remaining work

Machine-readable retained results are in [the v1 evidence summary](evidence/v1-2026-09-07.json).

Approve the macOS Keychain prompt for the rebuilt Borealis app, then resume the
same final native runner. The app is paused before its window opens; Computer
Use cannot inspect or operate the protected SecurityAgent surface. No custody
or permission boundary was bypassed. Finish all native A–F checkpoints and
actual watched-folder quit, record the final live-model result, then reconcile
completion labels and commit/push the remaining documentation.

The earlier Keychain approval allowed the superseded package to pass native
A–C. That app quit normally before D–F when the process audit identified the
shutdown defects. Its `/tmp/borealis-v1-native-final-evidence-2/summary.json`
records clean process/profile/workspace-lock cleanup. It does not certify the
new package. No required scenario may be replaced by an attestation or mock;
each native checkpoint needs actual OS interaction plus independent durable
state/export checks.

The [initial execution record](EXECUTION-2026-09-07-initial.md) preserves earlier
slice commits and integrity incidents as history. Its obsolete blockers and
subset completion labels are not current status. No applied migration is changed
by the closure fixes.

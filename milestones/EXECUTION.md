# Borealis v1 execution and evidence

**Updated:** 2026-09-07. V1 is the functional wave defined in
[the completion goal](../docs/IMPLEMENTATION_GOAL.md) and
[acceptance contract](../docs/END_TO_END_ACCEPTANCE.md), not a signed public release.
Runtime closure fixes are committed in `9fd2944`; all independent gates pass; native UI acceptance awaits macOS Keychain approval. Do not
infer completion from the earlier all-green subset.

## Implementation status

| Work | State | Current implementation and verification |
| --- | --- | --- |
| Selected prerequisite remediation | DONE | Fifteen prerequisite slices landed before product migrations. Provider consent, storage, ownership, bounds and async UI invariants remain enforced. |
| Connected agents, OAuth and reusable jobs | Implemented; final acceptance running | Both transports, real OAuth, sealed credential custody, frozen per-turn tools, job confirmation. V1 closure connects catalog output templates to the actual frozen job prompt, preserving legacy instruction templates and ownership/budget validation. |
| M12 saved analyses | Implemented; final acceptance running | Parameterized queries, immutable results/provenance, independent numeric comparisons, exports and restart recovery. |
| M13 document workbench | Implemented; final acceptance running | Revision editing, reviewed rewrites, templates, publication and four exports. Browser C now exercises actual chart lineage and a payload-less legacy report without skips. Print wrapping and chart title/legend layout repaired after visual inspection. |
| M14 living libraries | Implemented; final acceptance running | Folder and WebDAV import/refresh/watch, passage search, source generation evidence and reconnect/reselect behavior. Native folder acceptance requires the packaged OS picker. |
| M15 local research | Implemented; final acceptance running | Reviewed plans, captured evidence, typed cells, correction overlays, reruns and exports. Live acceptance now drives the research UI and checks fixture facts. Extraction explicitly requests evidence references; uncited values remain invalid. |
| M16 reviewed briefs | Implemented; final acceptance running | Durable calendar runs, review inbox, approve/reject and immutable publication. Editor now previews three server-resolved local/UTC occurrences before saving; a single manual run no longer displays a coalescence badge. |

## Acceptance evidence

All evidence uses isolated synthetic workspaces. PASS means the named check ran;
NOT RUN means the current source still awaits that gate. Logs and artifact paths
below are local retained evidence, not portable release assets. No credentials,
provider payloads or user data belong in this ledger.

| Check | Outcome | Evidence |
| --- | --- | --- |
| Full root gate | PASS | `pnpm verify`, 16/16 tasks and `ALL GATES GREEN`; server 1,307 unit + 413 integration, web 485, desktop 29. `/tmp/borealis-v1-final-verify-5.log`. Earlier attempts exposed updated-prompt assertions and one load-sensitive archive timeout; focused archive38 and MCP8 reruns pass. |
| Desktop verify and GUI renderer | PASS | `/tmp/borealis-v1-desktop-verify.log`: tests, native utility-process loads, GUI PNG/PDF smoke; zero network hits and both unsafe requests blocked. |
| Fresh unsigned package | PASS | `/tmp/borealis-v1-final-package.log`, 5/5 tasks; `/tmp/borealis-v1-packaged-native.log` and `/tmp/borealis-v1-packaged-entitlements.log` pass, including both negative entitlement removals. Native package ASAR SHA-256 `12678bd58a9bba68b9bedb595f2e2495455ed94a0303e1287083b29a69d888d9`. |
| Final browser A–F | PASS | 14:39:49–14:43:15 UTC, `/tmp/borealis-v1-browser-complete-20260907/summary.json`; all six journeys pass, no skipped checks, clean workspace/lock/process cleanup. E requires partial disclosure for the deliberately uncited invalid cell; F verifies all three preview pairs before save. |
| Native packaged A–F | BLOCKED pending Keychain approval | External OS driver, normal hardened startup, exact profile/PID/ASAR and immutable-state proofs; [driver contract](../scripts/e2e/NATIVE_DESKTOP.md). The former Chromium-on-packaged-backend B check is complementary and is not native UI evidence. Current process blocked in macOS Keychain before renderer bootstrap; user approval requested. No checkpoint has been marked passed. |
| Browser C including historical report | PASS | 14:20:41–14:21:04 UTC, `/tmp/borealis-v1-c-complete-evidence/summary.json`; actual chart copied from chat, legacy UI preview/download/copy denial, all exports. No skipped checks; clean lock/process cleanup. |
| Protocol fixture self-test | PASS | 82 checks, including exact chart UUID echo and missing/duplicate refusal. |
| Populated upgrade, managed migrations and offline archive | PASS | 14:12:08–14:12:15 UTC, `/tmp/borealis-v1-storage-evidence/storage-summary.json`; [repeatable command](../scripts/e2e/STORAGE.md). Populated v13→v28, 36 product tables, both managed embedding migration variants, encrypted CLI create/inspect/restore/verify/live-lock refusal, exact artifact preservation and reconnect/reselect states. |
| Live finance and research UI | PASS | 14:26:15–14:36:58 UTC, `/tmp/borealis-v1-live-facts-20260907/summary.json`; real Qwen3.6-35B + Nomic768 pair, 14/14 independently calculated finance rows, 12/12 typed supplier facts with same-source evidence, missing exceptions preserved. Research created/planned/started/reloaded/inspected through UI, final status completed; clean workspace/lock/process cleanup. |
| Export visual inspection | PASS | Rendered both DOCX files and all PDF pages from browser C using bundled LibreOffice/Poppler. Long unbroken text now wraps, chart title/legend/axis labels are separate, tables and evidence readable. Final browser-C PDF rerender `/tmp/borealis-v1-pdf-reviewed-T` confirms headings stay with content on all six stress-test pages. |
| Focused closure regressions | PASS | Job template server21/web43, schedule preview server18/web31, report/chart/render76; meaningful ownership, immutable prompt, DST/auth, stale-preview and print geometry checks. Full gate remains authoritative. |
| Independent integrated review | PASS | Product/export/schedule/job/research diff reviewed; 129 Markdown files have valid local targets. Native review confirmed the fixes for correction inheritance, publication/export association, scoped file reads and cleanup guards; six harness regression tests pass. |

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

Native bootstrap is blocked inside macOS Keychain access (`SecItemCopyMatching`
→ `SecKeychainItemCopyContent` → `SecurityServer::ClientSession::decrypt`),
confirmed by a read-only sample of the owned packaged main process. Computer
Use refused access to the protected SecurityAgent app. The smallest required
user action is to complete the macOS Keychain approval for Borealis; no prompt
text or secret was read and no approval boundary was bypassed. The native
runner remains pending, without a synthetic pass.

Finish the normal packaged UI journeys after Keychain approval, then update
every status with actual evidence and commit the native acceptance result.
The full repository, desktop package, live-model, storage and visual-export
gates and the final combined browser A–F run have passed. No required scenario may be
replaced with an attestation or a mock. A driver checkpoint requires both actual
OS interaction and independently checked durable state/export bytes.

The [initial execution record](EXECUTION-2026-09-07-initial.md) preserves earlier
slice commits and integrity incidents as history. Its obsolete blockers and
subset completion labels are not current status. No applied migration is changed
by the closure fixes.

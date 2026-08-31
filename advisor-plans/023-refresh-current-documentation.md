# Plan 023: Refresh current documentation after all remediation

> **Executor instructions**: This is the final documentation sweep. Follow the plan step by step, run every verification command, and confirm its expected result. Derive statements from the final source, schemas, scripts, and passing tests — completed plans are context, not proof. If a “STOP condition” occurs, stop and report; do not document intended or unverified behavior. When done, update only this plan’s status row in `advisor-plans/README.md` unless a reviewer told you they own the index.
>
> **Drift check (run first)**: `git diff --stat f1b9293..HEAD -- README.md AGENTS.md docs/API.md docs/VISION.md desktop/README.md server/.env.example milestones/README.md advisor-plans/README.md`
> Extensive expected drift comes from plans 001–022 and 024–037. Confirm every dependency is `DONE`, then compare these “Current state” excerpts with the final files. Any unfinished dependency or undocumented material behavior is a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: all behavioral plans `001`–`022` and `024`–`037`; see `advisor-plans/README.md` for the canonical dependency graph
- **Category**: docs
- **Planned at**: commit `f1b9293`, 2026-08-30

## Why this matters

The remediation series changes operator commands, three consecutive SQLite schemas, egress and contained-engine authority boundaries, shutdown/recovery behavior, parser isolation, executable API contracts, catalog shapes, model qualification and reindexing, local OCR, and workspace backup/restore. Documentation already mixes current inventory, product destination, completed milestones, historical plans, and manual verification gaps. Reconcile the seven current-reference documents only after every behavioral plan lands, so operators and future agents receive one accurate, non-secret account of what ships and what remains aspirational.

## Current state

- `README.md:12-28` correctly assigns document roles, including:

  ```md
  | [Product vision](../docs/VISION.md) | What Borealis is becoming: local data intelligence as a desktop platform |
  | [API reference](../docs/API.md) | REST endpoints, SSE events, lifecycle, errors, and resource limits |
  ```

  Preserve that separation and add the active/completed advisor remediation ledger only if it helps readers find the implementation record.

- `README.md:347-373` says `pnpm verify` runs policy/server/web/desktop gates, excludes the GUI renderer, and that CI packages the app. It also says desktop first launch is still manual and lists only `package:native:smoke`. Plans 001, 002, 004, 019, and 022 change the exact test partition, source-current desktop commands, vertical coverage, packaged lifecycle coverage, and contract check.
- `README.md:394-409` lists core invariants but omits the shipped agent/library/automation/share/contained surfaces and the remediated authority/recovery boundaries.
- `docs/API.md:50-59` currently describes consent as a timestamp that applies to the configured remote endpoint:

  ```md
  `GET /api/consent/remote-egress` returns
  `{required,acknowledged_at,endpoint_host}`; `POST` records the per-account
  acknowledgment and unblocks the gated routes immediately.
  ```

  Plan 006 keeps that public shape but binds the stored acknowledgment to one canonical provider origin and adds a final same-snapshot gate at every outbound chat/embedding boundary.
- `docs/API.md:216-227` documents public register/login and 2 KiB bodies but has no authentication 429/`Retry-After` contract. Plan 018 adds it while keeping public registration.
- `docs/API.md:718-778` is the operator-facing budget/status table. It currently documents parser limits but not the document worker boundary, and its status table has no 429 row.
- `docs/VISION.md:74-116` labels itself “What Borealis is today” but concludes:

  ```md
  The current surfaces are Chat, Sources, Connectors, Reports, and Settings.
  ```

  This omits already-shipped agents, libraries, artifacts/shares, automations, citations, personal defaults, ambient locality, and contained-model lifecycle.
- `docs/VISION.md:181-200` says “Share later” and “Automations, later”; `docs/VISION.md:235-241` says a future Borealis may download and lifecycle contained weights. These are stale shipping-inventory statements inside an otherwise forward-looking vision.
- `docs/VISION.md:358-361` explicitly says horizons are direction, not backlog. `docs/VISION.md:404-417` assigns README/API/Desktop/AGENTS/research/plans their roles. Preserve those product-document boundaries.
- `desktop/README.md:42-71` describes source/build/native/renderer checks and says first launch, account reopen, and clean shutdown require manual validation. Plan 019 adds an actual packaged lifecycle command but still does not add live-model, signing, or report-flow acceptance.
- `milestones/README.md:1-14` says milestones are the active product ledger and historical `plans/` are completed. Its M01–M11 table is entirely `DONE`; the dated 2026-08-29 verification record includes a real live-model run. Do not rewrite completed milestone specifications or claim another live-model run.
- `AGENTS.md:41-80` is the canonical command block. `AGENTS.md:190-270` holds data/security invariants, and `AGENTS.md:405-435` separates the end-to-end flow, documentation maintenance, vision, milestones, historical plans, and research archive. It must be updated because it is current contributor guidance, not a historical artifact.
- `server/.env.example:1-98` is the only supported environment reference. It currently documents bind/CORS/storage/render/provider precedence and budgets. Never read an actual `.env`, settings file, signing-secret file, or credential while doing this plan.

## Remediation evidence matrix

For each row, read the completed plan for intent, then verify the final named source/test/package surfaces before writing prose:

| Plans | Final behavior to reconcile | Primary evidence to inspect |
|---|---|---|
| 001–004 | Disjoint unit/integration suites, source-current desktop verification, immutable migration fixtures, deterministic vertical agent coverage | `server/vitest.config.ts`, `server/vitest.integration.config.ts`, `server/src/tests/vitestTestPartitions.ts`, root/server/desktop scripts, `server/src/tests/sqliteMigrationFixture.ts`, plan-004 test |
| 005–006 | Provider credential bound to canonical origin; schema v12 provider-bound consent; early gates plus final same-settings-snapshot outbound authorization | settings/runtime/LLM/egress policy, `v012.sql`, tests; never inspect real values |
| 007–009 | Desktop-operator-only contained mutations, redacted local paths, verified engine files, DNS-pinned/hash-verified downloads with reserved partial namespace and atomic filename ownership, no unsolicited UI network | auth/bootstrap/contained/source DTOs, download transport/lifecycle, web assets/security tests |
| 010–012 | Authorized shared report detail/HTML/PDF, durable source-cleanup intent, schema v13 owned automation targets/cascades | report/source/automation stores/routes, `v013.sql`, route/migration tests |
| 013–014 | Scheduler and contained-download quiesce/drain before storage close/stopped acknowledgment, plus one exact-lease application runtime through normal/failure shutdown | application runtime, server close/startup tests, automation/download runners |
| 015–016 | Short promotion transactions with snapshot recheck; bounded periodic pages/external work, a finite complete startup-delete snapshot, and owned pump drainage | ingestion store/lifecycle tests, reconciliation owner/scheduler/snapshot tests |
| 017–018 | Worker-thread PDF/DOCX event-loop isolation with timeout, V8 heap/stack ceilings, and existing parser budgets (not an RSS sandbox); public auth throttling before bcrypt with 429/`Retry-After` | extraction worker/import policy/tests; auth limiter/routes/OpenAPI tests |
| 019–022 | Real packaged lifecycle smoke through bootstrap and authenticated `/api/me`, schema-v14 typed connector refresh/recovery plus final attempts-first repair indexes, exact guarded ExcelJS boundary, generated server/web contracts and stale check | desktop package scripts/CI, `v014.sql`/refresh store/query plans, manifests/policy, contract generator/scripts |
| 024–029 | Proven connector-cache deletion, truthful automation terminal outcomes, pre-parse authentication/body budgets, lossless streamed tool names, retained chart lineage, and full DuckDB query deadlines | connector cleanup/repair, automation runner/history, auth hooks/routes, LLM stream merger, chart/run store, dataset worker and focused tests |
| 030–033 | Exact dialog request ownership, bounded keyset catalogs, hardened Electron fuses/normal packaged native acceptance, and lazy route/chart chunks with enforced budgets | React views/hooks, catalog stores/routes/generated contracts, builder/fuse/package tests, Vite manifest/budget checks |
| 034–035 | Explicit synthetic model-pair qualification and a durable, crash-recoverable whole-corpus embedding reindex/swap | qualification service/routes/UI, settings codecs, migration coordinator/private manifest, staged/live Lance indexes, startup recovery tests |
| 036–037 | Bounded local macOS PDF OCR and encrypted, integrity-verified offline workspace archives with exact instance locking and recoverable restore | extraction worker/helper/package assets, archive codec/CLI/lock/store verifier and adversarial tests |

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Dependency status | `node -e "const s=require('node:fs').readFileSync('advisor-plans/README.md','utf8');const open=s.split(/\r?\n/).filter(l=>/^\| \[\d{3}\]/.test(l)&&!/\| DONE \|$/.test(l)&&!/^\| \[023\]/.test(l));if(open.length){console.error('unfinished prerequisite plans');process.exit(1)}"` | exit 0; plans 001–022 and 024–037 are all `DONE` |
| Tracked current references | `git ls-files --error-unmatch README.md AGENTS.md docs/API.md docs/VISION.md desktop/README.md server/.env.example milestones/README.md` | exit 0 and prints all seven maintained documentation paths with exact case |
| Contract freshness | `pnpm contracts:check` | exit 0; generated web contracts are current and no files are written |
| Environment example validation | `pnpm policy && pnpm --filter borealis-server exec vitest run src/tests/config.test.ts` | exit 0; policy and live configuration parsing cover `server/.env.example` |
| Policy | `pnpm policy` | exit 0 |
| Full repository | `pnpm verify` | exit 0 and prints `ALL GATES GREEN` |
| Packaged lifecycle | `pnpm package:unsigned && pnpm --filter borealis-desktop package:lifecycle:smoke && pnpm --filter borealis-desktop package:native:smoke` | exit 0 on supported Apple Silicon macOS with a graphical session |
| Documentation diff integrity | `git diff --check HEAD -- README.md AGENTS.md docs/API.md docs/VISION.md desktop/README.md server/.env.example milestones/README.md advisor-plans/README.md` | exit 0, no whitespace errors in an allowed documentation change |
| Changed-path scope | `node -e "const{execFileSync}=require('node:child_process');const lines=s=>s.trim()?s.trim().split(/\r?\n/):[];const allowed=new Set(['README.md','AGENTS.md','docs/API.md','docs/VISION.md','desktop/README.md','server/.env.example','milestones/README.md','advisor-plans/README.md']);const changed=[...new Set([...lines(execFileSync('git',['diff','--name-only','HEAD'],{encoding:'utf8'})),...lines(execFileSync('git',['ls-files','--others','--exclude-standard'],{encoding:'utf8'}))])];const bad=changed.filter(p=>!allowed.has(p));if(bad.length){console.error(bad.join('\n'));process.exit(1)}"` | exit 0; every tracked or nonignored untracked path is in this plan's explicit scope |

## Scope

**In scope** (the only content files you should modify):

- `README.md`
- `AGENTS.md`
- `docs/API.md`
- `docs/VISION.md`
- `desktop/README.md`
- `server/.env.example`
- `milestones/README.md`
- `advisor-plans/README.md` — status cell for plan 023 only, unless the reviewer owns the index

**Out of scope**:

- Every production/test/config/package/lockfile file. This plan documents final behavior; it does not fix it.
- `plans/**`: completed historical implementation specifications.
- `milestones/M*.md`: completed milestone records.
- `docs/cohere-north/**`: dated external research/proposed designs.
- `advisor-plans/001-*.md` through `022-*.md` and `024-*.md` through
  `037-*.md`: completed implementation handoffs.
- Adding environment knobs, API fields, commands, guarantees, roadmap work, or product claims not supported by final code and passing tests.
- Live-model, signing/notarization, release-distribution, or model-quality verification.
- Reading real `.env`, `settings.json`, `jwt.secret`, provider keys, tokens, user content, or database contents.

## Git workflow

- Branch: `codex/023-refresh-current-documentation`
- Use a conventional documentation commit. An observed example is `docs: document personal default models and mark M11 done`.
- Suggested commit: `docs: reconcile current behavior after remediation`
- Keep one documentation-only commit after all gates pass. Do not push or open a PR without explicit instruction.

## Steps

### Step 1: Prove all implementation dependencies and establish facts

Run the dependency-status command. Confirm the index dependency notes still reserve schema v12 for plan 006, v13 for plan 012, and v14 for plan 020. Confirm a clean working tree before documentation edits; if the reviewer has uncommitted work, STOP rather than mixing it into the sweep.

Read all 36 completed behavioral plans, but build the final fact set from live
code/tests:

- run `git ls-files --error-unmatch README.md AGENTS.md docs/API.md docs/VISION.md desktop/README.md server/.env.example milestones/README.md` to prove the seven maintained references are tracked with exact-case paths; use a separate unfiltered `git ls-files '*.md'` inventory when checking intentionally ignored tracked research;
- read final root/Turbo/package scripts and CI before naming any command or claiming gate coverage;
- read `LATEST_SQLITE_SCHEMA_VERSION`, v12/v13/v14 deltas, and migration tests before naming schema behavior;
- read OpenAPI route schemas/generated contracts plus runtime validators before documenting requests/responses;
- read configuration parsing/precedence and `server/.env.example` before describing environment values;
- read owned runtime, scheduler, extraction/OCR, connector refresh, contained,
  report share, cleanup, model qualification/reindex, archive/lock, catalog, and
  desktop acceptance tests before describing lifecycle/recovery/security;
- never use historical plan prose as the sole evidence for a current claim.

Run `pnpm contracts:check`, `pnpm policy`, and `pnpm verify` before writing. On the supported desktop host, also run the packaged lifecycle command. Record which commands actually passed in temporary notes outside the repository; do not capture logs containing dynamic values.

**Verify**: dependency-status command, `pnpm contracts:check && pnpm policy && pnpm verify`, and the packaged lifecycle command → every applicable command exits 0; repository gate prints `ALL GATES GREEN`. If the host cannot run the desktop package command, STOP because this plan is expected to document its supported result, not an unrun assumption.

### Step 2: Update README and contributor invariants from the final tree

In `README.md`:

- keep setup concise and current; preserve public registration and the documented remote-exposure warning;
- update the shipping feature inventory to include agents, libraries, citations, shares, automations/schedules, ambient status, preferences, and contained-model lifecycle without turning README into an API dump;
- describe origin-bound provider credentials and consent in user language: remote provider changes require consent for that destination, and ingestion/chat/retrieval payloads are authorized at the final outbound boundary;
- describe desktop-operator-only contained mutation and redacted local-path responses; browser accounts remain ordinary users;
- replace stale verification coverage with exact post-001/002/004/019/022/032/033/036/037 commands and exclusions. Distinguish root `pnpm verify`, graphical renderer verification, fuse/bundle checks, packaged lifecycle/native/OCR/archive checks, fixture-based vertical coverage, live-model analysis, and signing/notarization;
- state that orderly shutdown rejects new contained downloads and joins active
  request/writer/handle work before the desktop reports stopped;
- replace manual-copy-only backup guidance with the final offline encrypted
  archive/verified restore workflow while preserving stopped-workspace and
  relocated-path requirements;
- describe model-pair qualification and managed embedding reindexing without
  implying that reachability is compatibility or that migration can bypass
  remote-egress consent.

In `AGENTS.md`, update the source-of-truth command/invariant sections, not merely prose around them:

- exact package/contract/unit/integration/desktop/lifecycle commands;
- schema v12 provider-bound consent, v13 owned automation targets, and v14 typed connector-refresh state;
- same-snapshot final egress authorization, origin-bound credentials, and no credential disclosure;
- literal desktop-operator capability plus redacted contained/source DTOs and verified download/spawn policy;
- scheduler/download drain and one exact-lease owned application-runtime
  shutdown order;
- short vector promotion transactions and bounded periodic/full startup reconciliation;
- worker-thread PDF/DOCX parsing with a timeout, existing byte/archive/output budgets, and V8 heap/stack ceilings—explicitly not an OS-level RSS/native-allocation sandbox—and the exact guarded ExcelJS boundary;
- generated API contract workflow and the rule that runtime parsers still validate untrusted JSON;
- pre-parse authentication and per-route body limits, cursor-bounded catalogs,
  exact async UI ownership, truthful terminal outcomes, stream merge behavior,
  chart lineage, and complete query deadlines;
- hardened Electron fuses and ASAR loading, lazy bundle budgets, synthetic
  model qualification, crash-safe embedding reindex, bounded local OCR, and
  exact-lock encrypted workspace archives;
- documentation roles, including `advisor-plans/` as the remediation record, while `plans/` and research stay historical.

Do not paste plan checklists into either document. State stable invariants and operator actions only.

**Verify**: `git diff --check HEAD -- README.md AGENTS.md` → exit 0; `rg -n 'schema v12|schema v13|schema v14|contracts:check|package:lifecycle:smoke|desktop.operator|desktop-operator|worker' README.md AGENTS.md` returns the applicable new invariants/commands without credential values or absolute local paths. Manually compare each changed command with the final package scripts and each changed invariant with the named source/test evidence.

### Step 3: Reconcile the API and environment references

Use the final OpenAPI document, route schemas, generated types, and route tests to update `docs/API.md`. Cover at least:

- public register/login limits plus 429 body category and integer `Retry-After`;
- provider Settings patch/test semantics after credential-origin binding, including omitted/preserved versus endpoint-change/explicit-key behavior without naming or returning a key;
- public consent response remains `{required, acknowledged_at, endpoint_host}`, while acknowledgment is valid only for the matching canonical remote origin;
- early route gates plus final account/provider-snapshot gate for chat, retrieval embeddings, ingestion embeddings, and automation/background work;
- desktop-operator-only contained mutations, safe redacted GET/PUT projections,
  digest/download policy, reserved partial namespace, atomic case-alias
  reservation, shutdown drainage, and ordinary-account 403 behavior;
- plan-010 shared report detail/HTML/PDF authorization and owner-only mutation;
- durable automation ownership/cascades, scheduler shutdown semantics where API-relevant, and bounded generic history;
- connector refresh public states/errors without exposing the internal cache paths represented by schema v14, including durable cache-deletion retry semantics;
- paginated catalog request/response/cursor contracts and the intentional
  pre-1.0 array-to-envelope break;
- model qualification and reindex status/retry/cancel contracts, including
  stable content-free result codes and `EMBEDDING_REINDEX_REQUIRED`;
- local OCR availability/details and offline archive CLI boundaries without
  exposing paths, manifest members, recognized text, secrets, or provider data;
- exact parser/resource limits, noting CPU-heavy PDF/DOCX extraction is event-loop isolated in a worker with a timeout and V8 heap/stack ceilings while Buffers/native allocations lack a hard RSS cap; XLSX remains offline/streaming/guarded;
- generated OpenAPI/client check commands where maintainers need them.

Update `server/.env.example` only from live configuration parsing. Correct precedence/security comments made stale by plans 005–037, but do not add fixed auth-throttle limits, desktop capability claims, lifecycle-smoke flags, contract-generator temporary variables, test seams, archive passphrases, or internal schema/state fields as operator environment options. Keep every credential placeholder empty/commented and never inspect a real value.

**Verify**: `pnpm contracts:check && pnpm policy && pnpm --filter borealis-server exec vitest run src/tests/config.test.ts && git diff --check HEAD -- docs/API.md server/.env.example` → exit 0; a manual endpoint/status/field comparison against generated contracts finds no documented field absent from code and no code-supported operator variable absent from the example. Inspect the `.env.example` diff manually for comment syntax, exact names accepted by the live parser, precedence comments, and blank credential placeholders.

### Step 4: Make the desktop guide match real focused/package gates

Update `desktop/README.md` from the final plan-002 and plan-019 package scripts:

- focused `test` is source-current; public `render:smoke` owns its build; aggregate `verify` builds once and runs the compiled renderer smoke;
- `package:lifecycle:smoke` launches the actual unsigned arm64 packaged binary twice against one isolated profile and proves UI load, trusted bootstrap consumption, profile reuse, and graceful owned-runtime acknowledgment;
- `package:native:smoke` remains a separate ABI/packaging check and does not launch the normal UI;
- fuse inspection and packaged native acceptance use the normal hardened app
  path and never depend on `ELECTRON_RUN_AS_NODE`, debug IPC, or relaxed ASAR
  policy;
- lazy route/chart chunks and the local OCR helper are copied into the packaged
  runtime and remain same-origin/offline;
- CI ordering and supported Apple Silicon macOS/graphical-session requirements are exact;
- neither packaged smoke validates model quality, live provider calls, signing/notarization, DMG installation, or the full finance/report flow;
- profile paths, copied runtime/native isolation, one-shot preload, renderer hardening, and signing behavior remain accurate.

Do not document the internal lifecycle test flag, its synthetic secret, temporary paths, or marker protocol as an operator interface.

**Verify**: `git diff --check HEAD -- desktop/README.md && rg -n 'package:lifecycle:smoke|package:native:smoke|render:smoke|live-model|sign' desktop/README.md` → exit 0 and the command/coverage distinctions appear. Manually compare every named script with the final root and desktop manifests plus CI ordering.

### Step 5: Separate VISION’s shipping inventory from its destination

Edit `docs/VISION.md` surgically:

- update only factual “today” inventory and stale future-tense claims for capabilities now proven shipped (agents, libraries, artifacts/shares, automations, citations, personal defaults, ambient locality, contained model download/lifecycle, model qualification/reindex, local OCR, and portable workspace archives);
- change “Share later,” “Automations, later,” and “A future Borealis may download…” wording so it no longer denies shipped substrate;
- retain forward-looking ambitions such as richer reusable intelligence, human-review workflows, optional sandboxed code only after an OS-grade design, other desktops only with equivalent sandbox/packaging, and product-quality aspirations;
- preserve principles, product thesis, model-topology distinctions, Horizon structure, and the explicit sentence that horizons are direction rather than backlog;
- keep “What Borealis is today” bounded to supported behavior; do not list remediation tasks, schema numbers, internal classes, or audit findings there.

The vision is allowed to describe a destination beyond current code. Resolve a disagreement by labeling current versus intended, not by flattening the destination into a shipping README.

**Verify**: `git diff --check HEAD -- docs/VISION.md` → exit 0; `rg -n 'The current surfaces are Chat, Sources, Connectors, Reports, and Settings|Share later|Automations, later|A future Borealis may download' docs/VISION.md` → no matches; manually confirm the “This is direction, not a backlog” boundary remains and every newly current capability has final source/test evidence.

### Step 6: Update the milestone ledger without rewriting history

In `milestones/README.md`:

- keep M01–M11 and every completed specification unchanged;
- retain the distinction between vision, product milestone ledger, completed historical `plans/`, dated research, and the advisor remediation ledger;
- do not convert plans 001–022 or 024–037 into new product milestones or imply
  an unwritten milestone exists;
- retain the 2026-08-29 live-model verification record exactly unless correcting an independently proven typo;
- obtain the execution date with `date -u +%F` after the final commands pass, and add a concise remediation verification record dated with that exact output only for commands actually run in step 1/final verification. Never copy the plan's `Planned at` date into the verification record. Name fixture/mock/package scope and explicitly exclude unrun live-provider, signing, notarization, and release-distribution checks.

If the final package lifecycle gate was not run successfully, do not add the record; STOP instead as required above.

**Verify**: `date -u +%F` prints the date used by the new record; `git diff --check HEAD -- milestones/README.md` exits 0; `git diff HEAD -- milestones/README.md` changes only ledger/document-role/verified-command prose, not milestone specifications or prior evidence, and the new record names only commands that passed during this execution.

### Step 7: Run final documentation and repository gates

Run the tracked-current-reference inventory, documentation diff-integrity,
environment-example validation, contract freshness, policy, full repository
gate, and package acceptance again after all edits. Check all seven
current-reference files and their links/paths manually against the exact
`git ls-files --error-unmatch` output; use exact case. Do not run a formatter
that rewrites these intentionally hand-maintained documents.

Run these stale-claim checks:

- `rg -n 'scripts/verify\.sh|package-lock\.json' README.md AGENTS.md docs/API.md desktop/README.md server/.env.example` → any match is only the explicit AGENTS prohibition against reintroducing the obsolete script/lockfile; no document tells the operator to use either.
- `rg -n 'The current surfaces are Chat, Sources, Connectors, Reports, and Settings|Share later|Automations, later|A future Borealis may download|These checks do not perform a complete first-launch' docs/VISION.md desktop/README.md` → no matches.
- `git ls-files --error-unmatch README.md AGENTS.md docs/API.md docs/VISION.md desktop/README.md server/.env.example milestones/README.md` → exit 0 and prints all seven current-reference paths.
- `node -e "const{execFileSync}=require('node:child_process');const lines=s=>s.trim()?s.trim().split(/\r?\n/):[];const allowed=new Set(['README.md','AGENTS.md','docs/API.md','docs/VISION.md','desktop/README.md','server/.env.example','milestones/README.md','advisor-plans/README.md']);const changed=[...new Set([...lines(execFileSync('git',['diff','--name-only','HEAD'],{encoding:'utf8'})),...lines(execFileSync('git',['ls-files','--others','--exclude-standard'],{encoding:'utf8'}))])];const bad=changed.filter(p=>!allowed.has(p));if(bad.length){console.error(bad.join('\n'));process.exit(1)}"` → exit 0; only the seven documentation files and optional plan-023 index status row are tracked or nonignored untracked.

**Verify**: the tracked-reference and changed-path commands above, `pnpm contracts:check && pnpm policy && pnpm --filter borealis-server exec vitest run src/tests/config.test.ts && pnpm verify`, the packaged lifecycle command, and `git diff --check HEAD -- README.md AGENTS.md docs/API.md docs/VISION.md desktop/README.md server/.env.example milestones/README.md advisor-plans/README.md` → every command exits 0; `pnpm verify` prints `ALL GATES GREEN`; targeted searches and manual source/schema/script comparisons find no stale claim or out-of-scope path.

## Test plan

- Dependency/status gate: every behavioral plan 001–022 and 024–037 is complete before prose changes.
- Executable contract check: API docs are compared with current schemas/generated client, not historical examples.
- Full fixture/mock gate: current commands and internal invariants are proven by `pnpm verify`.
- Packaged acceptance: desktop docs describe the actual post-plan-019 lifecycle/native commands and their exclusions.
- Tracked-file inventory and `git diff --check` cover all seven current-reference
  files; policy/config tests cover `server/.env.example`; targeted searches,
  link/path review, and source/schema/script comparison validate the prose.
- Manual evidence audit checks every remediation-matrix row against source/tests while never reading real secrets or user data.

## Done criteria

- [ ] Plans 001–022 and 024–037 are `DONE`, their final focused tests pass, and no behavior is documented solely from a plan.
- [ ] README, API, desktop guide, environment example, AGENTS, VISION, and milestone ledger agree on current commands and behavior.
- [ ] Root `AGENTS.md` includes the new operator capability, schemas v12–v14, last-mile egress, scheduler drain, owned runtime, extraction worker, reconciliation/promotion, parser, and contract invariants.
- [ ] `docs/VISION.md` clearly separates shipping inventory from destination/horizons and no longer calls shipped sharing/automation/contained capabilities future-only.
- [ ] Public registration remains documented; auth throttling/429 and remote exposure warnings are accurate.
- [ ] No unsupported environment variable, endpoint field, guarantee, live-model result, signing result, or release claim was added.
- [ ] Historical `plans/**`, milestone specs, research, and prior verification records are untouched.
- [ ] All tracked-reference, diff-integrity, contract, policy, repository, packaged lifecycle/native, stale-phrase, and manual evidence checks pass.
- [ ] The exact changed-path scope command includes tracked diffs and
      nonignored untracked files, exits 0, and reports no path beyond the seven
      current-reference docs plus the optional plan-023 index row.
- [ ] Plan 023 is marked `DONE` unless the reviewer owns the index.

## STOP conditions

Stop and report rather than guessing if:

- Any plan 001–022 or 024–037 is not `DONE`, its final tests fail, or implementation differs materially from its target contract.
- The worktree is not clean before this documentation-only branch or contains changes not attributable to this plan.
- Route schemas/generated types/runtime validation disagree about an API shape or status.
- `LATEST_SQLITE_SCHEMA_VERSION` is not exactly 14 with v12/v13/v14 owned by plans 006/012/020 respectively.
- Final source does not provide one same-snapshot outbound egress gate, one
  exact-lease owned runtime, drained scheduler and contained-download shutdown,
  the documented worker isolation/deadline/V8-ceiling/parser-budget layers,
  typed refresh state, or the packaged lifecycle command described here.
- A supported environment variable/command cannot be proven from live parser/manifest/CI code.
- The Apple Silicon graphical host cannot run the packaged lifecycle/native acceptance required for the new documentation.
- A claim would require a live provider, signing/notarization credential, release distribution, or reading a real `.env`, settings, secret, token, user file, or database.
- Correcting the discrepancy requires editing source, tests, packages, generated contracts, historical plans/specs/research, or any file outside Scope.
- The exact tracked-current-reference command fails, `git diff --check HEAD -- README.md AGENTS.md docs/API.md docs/VISION.md desktop/README.md server/.env.example milestones/README.md advisor-plans/README.md` reports an error after one reasonable documentation correction, or the changed-path scope command finds an out-of-scope file.
- Any verification fails twice after one reasonable documentation correction.

## Maintenance notes

- README/API/Desktop/AGENTS/environment example are current references and must move with behavior. VISION moves when intended product direction changes; its “today” subsection moves with shipped inventory.
- `milestones/` records product milestones, `advisor-plans/` records this remediation wave, `plans/` is completed historical implementation, and `docs/cohere-north/` is dated research. Do not collapse those roles.
- Future migrations add a contiguous immutable fixture and update `LATEST_SQLITE_SCHEMA_VERSION`; never edit released v12–v14 deltas.
- Future API changes update route schemas, run `pnpm contracts:generate`, retain runtime validation, and pass `pnpm contracts:check` before documentation.
- Verification records use the executor's actual date from `date -u +%F`, never the plan date, and name only commands actually run and their scope. Never imply fixture/mock checks validate a live model, signed release, or production provider.

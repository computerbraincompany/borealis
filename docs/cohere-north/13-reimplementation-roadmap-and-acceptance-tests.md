# Reimplementation roadmap, parity gates, and acceptance strategy

> **Historical design proposal — 2026-08-22.** These requirements describe
> a possible North-equivalent rebuild, not an accepted Borealis roadmap or its
> implemented architecture. See the [archive overview](README.md),
> [current Borealis docs](../../README.md), and
> [completed implementation plans](../../plans/README.md).

**Status:** historical proposed build sequence for a fully open-source North-equivalent; not an accepted Borealis roadmap<br>
**Principle:** each phase ends in exercised, security-tested product behavior—not UI stubs

## 1. Parity definition

“Complete reimplementation” means:

- documented user/admin/operator workflows are available or explicitly rejected with rationale;
- public object/API semantics needed for interoperability are implemented and contract-tested;
- source-grounded behavior has reproducible citations and authorization;
- all long-running/action-taking work is durable, cancellable, inspectable, and safe;
- a private/local deployment can operate without hidden external dependencies;
- the stack, models, assets, and dependencies pass license/SBOM/security review;
- UI is independently designed and accessible;
- unknown proprietary model/search behavior is replaced with measured open alternatives, not fabricated.

It does **not** require Cohere trademarks, exact visual styling, private prompts, identical model weights, undisclosed ranking algorithms, or service-name/topology cloning.

## 2. Quality gates that apply to every phase

1. Threat model and authorization matrix updated.
2. Tenant/user/resource negative tests added before feature acceptance.
3. Schema/API/event contracts versioned and documented.
4. Migrations round-trip on realistic fixtures.
5. Accessibility and failure states implemented, not deferred.
6. Open-source/model licenses and SBOM reviewed.
7. Content/secret leakage tests cover logs, traces, metrics, errors, support bundles.
8. Unit, integration, API contract, worker replay, and E2E tests pass locally.
9. Performance budget measured for representative corpus/concurrency.
10. Backup/restore or deterministic rebuild path tested for new state.

## 3. Phase 0 — clean-room and architecture foundation

### Deliverables

- Project-owned name/design system and clean-room policy.
- Source/evidence ledger and decision records.
- Organization/principal/role/relation model.
- Keycloak/OIDC, OpenFGA, break-glass admin.
- PostgreSQL migrations, transactional outbox, request/trace IDs, standard errors.
- Encrypted object storage abstraction and secret manager.
- Audit event chain and telemetry privacy schema.
- CI gates: formatting, type checks, tests, migration checks, dependency/license/SBOM, secret scanning, container scan.

### Exit tests

- Two organizations with identical object IDs cannot cross-read/list/count/search.
- OIDC account survives email rename; issuer/subject confusion is denied.
- Admin/group/role revocation is effective immediately.
- A transaction and its outbox event are atomic under crash/retry.
- Logs/traces/errors contain no seeded canary secrets/content.

## 4. Phase 1 — files, parsing, retrieval, and citations

### Deliverables

- Upload session/quarantine/hash/duplicate/version/delete.
- Initial supported formats: TXT/MD/HTML/PDF/DOCX/PPTX/CSV/XLSX; HWP/DOC/XLS after parser validation.
- Docling/Tika/LibreOffice/Tesseract worker pipeline.
- Structure-aware segments with page/sheet/cell coordinates.
- PostgreSQL FTS + pgvector baseline; optional rerank.
- Source/version/segment authorization projections.
- My Files UI and processing states.
- Retrieval/citation API and source preview panel.

### Exit tests

- Mixed-format corpus uploads and every cited answer opens the exact page/section/cell.
- Unsupported/malicious/oversize/spoofed files fail safely.
- Deleted/revoked content is blocked before asynchronous index purge.
- Parser/index crash resumes idempotently without duplicate segments.
- Retrieval never returns another user/organization's canary segment.

## 5. Phase 2 — chat and agent runtime

### Deliverables

- Conversations/messages/files/background tasks.
- SSE typed event reducer with reconnect/cancel/error parity.
- OpenAI-compatible gateway and capability-aware model profiles.
- Bounded agent/tool loop with safe execution summaries.
- Default personal agent and simple custom-agent draft.
- Composer source/capability/tool/model controls.
- Citations, history/search/rename/delete, retry/copy/feedback.
- Durable notifications for terminal background work.

### Exit tests

- Stream reconnect produces one canonical message with no duplicate delta.
- Navigation does not cancel background work; cancellation is idempotent.
- Tool rounds/time/tokens/output are bounded.
- Unsupported model capability is rejected before send or degrades explicitly.
- Raw hidden chain-of-thought is absent from UI/storage/events.

## 6. Phase 3 — agents, libraries, connectors, and MCP

### Deliverables

- Agent semantic versions/history/restore/share/star/gallery/starters.
- Library types, memberships, sync status, Reader/Editor/company/private grants.
- First connectors: local library, filesystem/S3, Web Search, GitHub read-only.
- Then Google Drive/Microsoft Graph based on customer demand.
- Connector SDK with live/indexed/hybrid declarations.
- MCP server registry, tools/resources/prompts/elicitations; Apps later in phase.
- Credential broker, egress proxy, server/tool/member policy, action classifications.
- Parameter-bound approvals and post-action read-back.

### Exit tests

- Draft changes do not affect published agent consumers.
- Agent sharing fails if library recipients lack Reader.
- Upstream/source permission revocation blocks indexed and live retrieval.
- MCP manifest drift cannot silently enable a new action tool.
- One approved external action occurs exactly once and is verified by read-back.
- MCP App cannot access parent DOM/session/credentials/network outside bridge policy.

## 7. Phase 4 — documents, charts, reports, and exports

### Deliverables

- ProseMirror canonical document model.
- Split chat/editor, selection and whole-document rewrites.
- Manual + agent version history/diff.
- Citation marks and embedded validated chart specs.
- PDF/DOCX/HTML/TXT/Markdown export.
- Immutable organization-scoped share snapshots.
- Artifact list/version/lineage/retention.

### Exit tests

- Concurrent manual/AI edit creates merge/diff, not lost update.
- Export hashes map to exact source artifact version and load no hidden remote assets.
- Malicious HTML/Markdown/source labels cannot execute script or break PDF renderer.
- Snapshot revocation and source permission policy work as designed.

## 8. Phase 5 — durable automations and human review

### Deliverables

- Temporal-backed graph interpreter.
- LLM, Agent, Conditional, For Each, Do While, Human Review nodes.
- Typed inputs/outputs, JSON Schema, retries/fallbacks/budgets.
- Node/full-graph testing with dependency cache invalidation.
- Draft/live versions, semver/history/restore, import/export.
- Discovery/Run/My builds/Monitor UX.
- Manual/cron schedules, dependency health, auto-disable/failure streak.
- Run/node/attempt/output/review APIs and notifications.

### Exit tests

- Published/in-flight/completed version immutability.
- Runner—not builder—permission governs every dependency.
- Effectful retry cannot duplicate external action.
- Loop max/parallel/token/time budgets and cancellation work under failure.
- Review is authenticated, typed, expiring, single-winner, and downstream-referenceable.
- Schedule disables on missing model/tool/input and reactivates only after validation.
- Worker crash/replay reaches one correct terminal state.

## 9. Phase 6 — evaluations, deep research, and governed memory

### Deliverables

- Evaluation tasks/cases/runs with deterministic + LLM graders.
- Release gates and version-pinned evaluation snapshots.
- Deep Research durable plan/subtasks/evidence/report pipeline.
- Editable provenance-rich user memory, TTL, pause/delete.
- Conversation History as a permissioned cited source.
- Admin feature/maturity/permission controls.

### Exit tests

- Evaluation fixture produces reproducible deterministic scores and pinned judge metadata.
- Action tools are disabled/fail safely in unattended evaluations/research.
- Every research claim resolves to stored evidence or is marked unsupported.
- Research budget/cancel/resume survives worker restarts.
- Memory never crosses user/agent/org scope and delete removes every retrieval path.

## 10. Phase 7 — tables and code sandbox

### Deliverables

- Typed grid, virtualized UI, import/export.
- AI columns, dependencies, file/tool context, per-cell runs/citations.
- Reviewed/stale cell states and bulk controls.
- Fixed/no-network Data Interpreter image.
- Broader Code Sandbox with gVisor/Kata, controlled package/network policy, file panel.

### Exit tests

- Circular table dependency rejected; deterministic order otherwise.
- Reviewed cells survive bulk rerun; dependency change marks stale.
- Cell run failure preserves prior value.
- Sandbox cannot access host, metadata, service tokens, another session, or denied network.
- Generated files are scanned and remain untrusted until explicit save/download.

## 11. Phase 8 — enterprise administration and operations

### Deliverables

- Full users/groups/roles/resource permissions.
- Guardrails/flow control/model/tool/agent/workflow policy.
- Retention/graceful deletion/legal hold/purge.
- Compliance exceptional-access workflow with dual approval and expiry.
- Product analytics separated from audit/telemetry.
- Kubernetes/Helm profiles, air-gap mirror, image signatures/SBOM.
- HA, metrics/traces/dashboards/alerts, support bundles.
- Backup/PITR/object/search/key restore and upgrade/rollback tooling.

### Exit tests

- Sealed deployment performs no external calls.
- JIT/SSO/deprovisioning/group reconciliation pass lifecycle tests.
- Purge removes all derivatives and preserves content-free evidence.
- Exceptional compliance access is dual-approved, time-bound, and audited.
- Isolated restore meets configured RPO/RTO and passes tenant/citation/workflow checks.
- Rolling upgrade and supported rollback do not corrupt durable runs or indexes.

## 12. Cross-feature E2E scenarios

### Scenario A — source-grounded agent

1. Admin enables My Files/Libraries and grants Agent Builder.
2. User uploads PDF/DOCX/XLSX; processing reaches ready.
3. User creates a library and custom agent, adds starters/tools, evaluates draft, publishes v1.0.0.
4. Recipient with Reader opens starter, asks a question, inspects claim citation/source span.
5. Owner publishes v1.1.0; old conversation remains tied to v1.0.0.
6. Source permission revoked; recipient can no longer preview/retrieve it.

### Scenario B — action workflow with HITL

1. Builder creates LLM → Human Review → Conditional → Jira/Email action.
2. Publish with typed outputs, retry/fallback, timeout, and Limited visibility.
3. Runner authenticates tools, enters inputs, acknowledges action risk.
4. Run pauses; authorized reviewer edits/approves fields once.
5. Correct branch executes exactly one action; read-back verifies external state.
6. Run details show versions, timings, retries, review evidence, citations, artifact.

### Scenario C — document/report

1. User asks for a cited analysis from files and a table.
2. Agent uses retrieval/Data Interpreter, produces chart and document artifact.
3. User manually edits and requests selection rewrite.
4. Diff/history shows both human and AI revisions.
5. PDF/DOCX exports match artifact version and carry provenance metadata.

### Scenario D — scheduled research

1. Published workflow/agent uses approved web and internal sources.
2. Schedule pins timezone/version/inputs and starts a research run.
3. Tool/model becomes unavailable; schedule disables before next run and notifies owner.
4. Dependency restored and schedule revalidated/reactivated.

## 13. Contract test suite

- Generate client/server fixtures from stored published OpenAPI.
- Snapshot operation IDs, paths, methods, media types, schemas, errors, stream event unions.
- Golden tests for import/export graph and model/tool dependency manifests.
- Model/provider compatibility matrix: streaming, tools, structured output, vision, citations, truncation.
- Connector conformance kit: auth, discover, sync, ACL, delete, live query, rate limit, expiry.
- MCP conformance kit: tools/resources/prompts/elicitations/apps, schema limits, auth, drift, approval.
- Workflow determinism/replay fixtures across engine versions.

## 14. Security test program

- multi-tenant/user/service fuzz matrix;
- IDOR and filtered-list/count leakage;
- prompt injection from files/web/MCP results;
- SSRF/DNS rebinding/redirect abuse;
- OAuth/OIDC token confusion and redirect attacks;
- malicious MCP schemas/results/apps;
- tool approval race/parameter tampering/replay;
- archive/file/parser decompression bombs and formula injection;
- sandbox escape/network/metadata/credential tests;
- HTML/PDF/DOCX renderer injection;
- cache/index/outbox/worker cross-pollution;
- backup/support/log/trace secret-content scanning;
- dependency/container/model supply-chain verification.

## 15. Performance budgets

Measure, do not copy vendor sizing:

- API p50/p95/p99 excluding model work;
- stream time-to-first-event and reconnect;
- upload-to-ready by file type/page count;
- retrieval/rerank latency and recall benchmark;
- agent tool-loop latency and concurrency fairness;
- workflow queue/node/review timing;
- table cells/minute and cancellation;
- parser/OCR pages/minute;
- model TTFT/tokens/sec/context/resource use;
- index/object/DB growth per corpus volume;
- backup/restore/reindex duration.

Publish supported profiles only after repeatable benchmarks on named hardware/models.

## 16. Completion checklist

- [ ] Every feature in docs 01–12 is implemented, deferred with owner/date, or rejected with rationale.
- [ ] Public API operation/schema inventory is mapped to implemented, compatibility-shim, or intentionally unsupported.
- [ ] Every source/connector declares auth, storage, ACL, freshness, deletion, action, and egress behavior.
- [ ] Every model profile has license/revision/capability/benchmark/hardware metadata.
- [ ] Every long-running process is durable/cancellable/inspectable/replay-safe.
- [ ] Every effectful action is policy/approval/idempotency/read-back safe.
- [ ] All artifacts/sources/definitions/runs are versioned and authorized.
- [ ] Full security, accessibility, air-gap, upgrade, and restore gates pass.
- [ ] Vendor research images/branding are absent from shipped product.

# Gaps, unknowns, non-goals, and clean-room boundary

> **Historical North research — captured 2026-08-22.** Vendor behavior,
> release labels, API inventories, and references below describe that capture,
> not the latest North release or the implemented Borealis product. See the
> [archive overview](README.md), [Borealis README](../../README.md), and
> [Borealis API reference](../API.md) for the distinction and current contracts.

**Evidence date:** 2026-08-22<br>
**Purpose:** prevent public documentation from being mistaken for a complete description of Cohere's private implementation

## 1. What public evidence establishes well

The public corpus is strong enough to specify:

- top-level product taxonomy and navigation;
- chat/agent/document/table/automation user workflows;
- feature maturity labels;
- files, libraries, connector categories, sync patterns, permission consequences, and citations;
- agent/workflow versioning, testing/evaluation, scheduling, monitoring, and human review;
- admin identity/permission/resource/policy surfaces;
- public API resources, paths, methods, schemas, errors, OAuth, and stream-related types;
- Kubernetes/Helm deployment, named components, dependencies, sizing guidance, backup, and observability;
- public UI relationships from verified screenshots.

The OpenAPI specification describes 72 paths, 107 operations, and 364 schemas but does not disclose database or internal service contracts.[11]

## 2. Product unknowns

| Unknown | Why it matters | Safe response |
|---|---|---|
| Exact onboarding/first-run sequence by role | Conversion and readiness | Design independent role-based onboarding; usability-test it. |
| General workspace/project boundary | Tenant/context architecture | Do not invent a North workspace; use explicit organization + resource/source scopes. |
| Full mobile/iOS/iPad parity | Surface breadth | Treat mobile as later separate spec; support responsive review/chat first. |
| Voice/recording/transcription internals | Privacy/storage/model choice | Omit until separately researched and threat-modeled. |
| Pricing, editions, seat/usage limits | Packaging | No public price inference; define open/community/support packaging independently. |
| Actual SLOs/support tiers | Operations | Publish only measured project SLOs. |
| Complete localization coverage | i18n effort | Build full i18n architecture; validate supported locales independently. |

## 3. Model and agent unknowns

- exact North platform/system prompts and preamble composition;
- proprietary agent planner, tool-selection heuristics, trace summarization, retry/recovery prompts;
- North-specific fine-tuning datasets and training methods;
- exact model routing/default/fallback and capability detection;
- prompt/context truncation and memory injection order;
- agent version migration/compatibility across model/tool schema changes;
- hidden evaluation judge prompt, calibration data, and reliability;
- how editable “thinking trace” maps to model/runtime state;
- exact safe handling of raw chain-of-thought.

The current guide says North-specific models are proprietary, optimized for North workloads, and not standalone products; third-party/OpenAI-compatible support can vary in citations and truncation.[12]

**Safe response:** use public model APIs and independent prompts, expose safe plan/execution summaries rather than raw hidden reasoning, pin model/tool/prompt versions, and measure behavior with open evaluation suites.

## 4. Retrieval/Compass unknowns

- parser implementation, OCR/layout/table/vision model details;
- chunk boundaries/overlap and metadata extraction;
- embedding/rerank models and query transformations by deployment;
- lexical/vector fusion/rerank scores, thresholds, dedup/diversity/freshness;
- index naming/sharding/tenant strategy and authorization projection;
- citation span alignment and grounding quality logic;
- ACL cache invalidation timing/failure modes;
- exact hybrid live/indexed result merge behavior beyond documented connector examples;
- multilingual/multimodal benchmark datasets and recall.

The docs establish Compass, OpenSearch, parser/API services, synchronization patterns, and some operational tuning; they do not establish the full ranking pipeline.[12][52][67]

**Safe response:** build a transparent pluggable hybrid retrieval pipeline and publish recall/citation/ACL benchmarks. Do not advertise “Compass equivalent” from shared component names.

## 5. Workflow-engine unknowns

- exact graph serialization and expression language;
- durable engine semantics, event history, queue partitioning, leases, and worker replay;
- ordering/fan-in behavior under branches and parallel loops;
- retryable error taxonomy and backoff/jitter;
- idempotency/compensation behavior for action tools;
- cancellation guarantees for running model/tool/sandbox calls;
- schedule overlap, missed runs, clock/timezone/DST policy;
- nested automation/subworkflow support;
- max graph/node/input/output limits;
- review reassignment/delegation/escalation and concurrent submission details;
- export/import compatibility versions and secret/reference mapping.

The UI docs establish builder/node/versioning semantics.[28][31]

The workflow docs also establish human review and runner/monitor behavior.[29][32] They do not disclose the workflow engine internals.

**Safe response:** use Temporal or another durable open engine with explicitly documented determinism, retries, cancellation, timers, signals, and idempotency.

## 6. Security and governance unknowns

- complete OpenFGA authorization model and tuple lifecycle;
- multi-tenant deployment topology vs one organization per instance;
- guardrail classifier models/rules/false-positive targets/order;
- data classification/DLP policy and prompt-injection defenses;
- exact MCP App browser isolation/CSP/bridge;
- connector credential encryption/brokering architecture;
- compliance certification scope, audit period, exclusions, and customer responsibility matrix;
- every field covered by chat column encryption and any encryption of workflows/search/object data;
- audit log immutability/integrity/retention/export details;
- exceptional compliance access approval implementation;
- deletion SLA and all derivative/backups/search/sandbox purge coverage;
- model/provider data processing/training retention guarantees per configuration.

The security overview is explicitly a rapidly evolving best-practices guide; it is not a certification report.[40]

**Safe response:** implement a stricter explicit threat model, defense-in-depth authorization/encryption, content-free audit/telemetry, transparent deletion map, and independent security review. Never repeat certification/compliance marketing without primary audit scope.

## 7. Operations unknowns

- production SLOs, load assumptions, tested maximum tenants/users/conversations/files;
- exact HA topology and disaster scenarios for each service;
- model autoscaling/batching/queue/fairness policy;
- index consistency and reindex behavior during upgrades;
- supported backup consistency point across PostgreSQL/object/OpenSearch/workflow runtime;
- full air-gap dependency/mirror/update/license workflow;
- support-bundle redaction implementation;
- telemetry cardinality/retention/content fields;
- secret/key compromise recovery and tenant-specific keying;
- cost/capacity models.

**Safe response:** publish benchmark methodology, RPO/RTO, failure-injection results, restore evidence, and exact supported profiles for the open stack.

## 8. Connector unknowns

For many sources, docs describe auth/data path/permissions but not:

- every API endpoint/scope and rate-limit strategy;
- delta token/checkpoint deletion/rename semantics;
- webhook vs poll details;
- attachment/format/size edge cases;
- permission-change latency and group expansion;
- partial sync reconciliation and conflict behavior;
- action schemas and irreversible-operation taxonomy;
- regional endpoints/data residency;
- licensing required from third-party vendors.

**Safe response:** a connector conformance kit and per-connector manifest must declare these explicitly; no connector is “supported” until auth, sync, ACL, deletion, rate-limit, expiry, and action tests pass.

## 9. UI unknowns

Public images and docs do not establish:

- complete responsive/mobile breakpoints;
- all keyboard/accessibility behavior;
- design tokens/components/animation specs;
- every loading/empty/error/permission state;
- browser support and offline/reconnect behavior;
- collaborative editing conflict resolution;
- performance with large histories, graphs, libraries, tables, and citation sets.

**Safe response:** create independent design tokens/components and exhaustive state/accessibility tests. Screenshots verify surface relationships only.

## 10. Legal and intellectual-property boundary

### Permitted clean-room targets

- user-observable behavior documented publicly;
- public API interoperability where legally appropriate;
- open standards such as HTTP, OAuth/OIDC, OpenAPI, MCP, SSE, JSON Schema;
- independently designed architecture, prompts, models, schemas, code, tests, and UI;
- factual compatibility documentation with attribution.

### Excluded

- leaked/private source code, credentials, non-public docs, reverse engineering prohibited by agreement;
- copying proprietary prompts, model weights, datasets, output corpora, icons, illustrations, copywriting, or trade dress;
- shipping the research screenshots/architecture diagrams as product assets;
- falsely presenting the project as Cohere, North, endorsed, or identical;
- fabricating private internals from Kubernetes image/service names.

Obtain counsel before using trademarks in project naming, claiming API compatibility, redistributing copied documentation/screenshots, or distributing models/assets with nontrivial licenses.

## 11. Validation experiments

### Retrieval

- Build an open synthetic/multilingual/multimodal corpus with known answers, ACLs, versions, deletes, tables, and citations.
- Benchmark lexical/vector/hybrid/rerank variants for recall, citation precision, latency, and leakage.

### Agent runtime

- Golden tool/structured-output tasks across selected open models.
- Adversarial prompt-injection/source/tool-result tests.
- Long-context/truncation/cancellation/reconnect matrix.

### Workflows

- Deterministic graph fixtures for branches, loops, retries, fallback, cancellation, HITL, schedules, crash/replay.
- Exactly-once external-action simulator with idempotency/read-back.

### Connectors

- Mock OAuth/API servers with rate limits, token expiry, deletes/renames, ACL changes, pagination, malformed payloads.
- Vendor sandboxes only after mock conformance passes.

### Security

- Tenant/user/service authorization fuzzing.
- Sandbox escape/metadata/network/credential tests.
- Support/log/trace/backup canary-secret scanning.
- Key rotation and isolated restore drills.

### UX

- Task-based tests for first chat, cited verification, agent publish/eval, library share, workflow build/run/review, document diff/export, table review/stale states.
- Keyboard/screen-reader and large-data performance tests.

## 12. Decisions that must be made independently

- one organization per deployment vs multi-organization;
- workspace/space/project isolation object;
- default no-egress/sealed posture;
- explicit vs inherited model entitlements through published agents;
- personal-file sharing semantics;
- memory transparency and archival memory inclusion;
- raw trace retention (recommended: safe summaries only);
- OpenSearch from day one vs PostgreSQL-first;
- Temporal vs project workflow engine;
- object-store selection and reciprocal-license policy;
- model suite and commercial/redistribution licenses;
- community vs enterprise packaging without closed-core dependence.

## 13. Unknown-resolution ledger format

```text
Unknown
- question
- source URLs checked
- current evidence
- why unresolved
- risk if guessed
- experiment or stakeholder needed
- independent decision
- date/owner/status
```

Never resolve an unknown by silently turning a plausible design into a statement about North.

## Sources

[11] https://private.docs.cohere.com/openapi/north.yaml
[12] https://private.docs.cohere.com/docs/get-started/north-user-guide
[28] https://private.docs.cohere.com/docs/get-started/north-automations/building-automations/configuring-automation-nodes
[29] https://private.docs.cohere.com/docs/get-started/north-automations/building-automations/human-in-the-loop-automations
[31] https://private.docs.cohere.com/docs/get-started/north-automations/building-automations/saving-publishing-monitoring-automations
[32] https://private.docs.cohere.com/docs/get-started/north-automations/consuming-automations
[40] https://private.docs.cohere.com/docs/security
[52] https://private.docs.cohere.com/docs/kubernetes-components
[67] https://private.docs.cohere.com/docs/security/data-syncing

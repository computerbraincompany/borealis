# Cohere North clean-room technical product documentation

**Research date:** 2026-08-22<br>
**Start source:** <https://private.docs.cohere.com><br>
**Goal:** provide enough evidence, product behavior, contracts, architecture context, and independent implementation design to rebuild a North-equivalent platform with a fully open-source stack.

## Executive summary

Cohere North is documented as a governed enterprise agentic platform, not simply document chat. Its main user concepts are **Chat, Agents, Automations, Sources/Libraries, Tools/MCP, Documents, Tables, Deep Research, Memory, and Notifications**, with a separate administration and operations plane. The strongest reconstructable product patterns are composer-level source/tool/model scope, inspectable citations, versioned/evaluated agents, durable background work, graph workflows with tests/versions/schedules/HITL, source-native authorization, and private Kubernetes deployment.[12][13][24]

This research captured **435 unique public first-party URLs**, fully read **421**, retained **14** explicit soft-not-found aliases, and found **0** authentication-gated pages. The current raw North OpenAPI 3.1 contract contains **72 paths, 107 operations, and 364 schemas**.[11]

The independent reference architecture uses a permissive/open stack around React/TypeScript, Fastify, PostgreSQL/pgvector, optional OpenSearch, Valkey, S3-compatible storage, Keycloak, OpenFGA, Temporal, LiteLLM, vLLM/llama.cpp, Docling, gVisor/Kata, MCP, and OpenTelemetry. Component and model licenses still require exact-version review.

## Documentation map

### Evidence and current state

| Document | Purpose |
|---|---|
| [00 — Research method and evidence](00-research-method-and-evidence.md) | Crawl methods, counts, failures, hashes, reproducibility, clean-room rules. |
| [01 — Product overview and conceptual model](01-product-overview-and-conceptual-model.md) | Product definition, maturity, roles, taxonomy, navigation, invariants. |
| [02 — Current documentation delta](02-current-documentation-delta-and-release-signals.md) | July→August crawl delta and v1.14.0 product/API/ops implications. |
| [15 — External product evidence](15-external-product-evidence-and-market-signals.md) | Launch evolution, demos, customer/case-study signals, attributed claims. |

### Functional product specification

| Document | Purpose |
|---|---|
| [03 — Chat, agents, memory, evaluation](03-chat-agents-memory-and-evaluation.md) | Composer/messages/citations/traces, agent types/versioning/sharing/evals, memory. |
| [04 — Knowledge, search, connectors, MCP](04-knowledge-search-connectors-and-mcp.md) | Files, sync paths, connector matrix, libraries, retrieval, MCP safety. |
| [05 — Automations and human review](05-automations-workflows-and-human-review.md) | Builder, nodes, graph/run semantics, testing, versions, schedules, HITL, monitoring. |
| [06 — Documents, tables, research, artifacts](06-documents-tables-research-and-artifacts.md) | Document editor/version/diff/export, table cells, deep research, interpreters/sandboxes. |
| [07 — Security and governance](07-security-identity-permissions-and-governance.md) | Identity, authorization, tools/actions, encryption, lifecycle, audit, guardrails, hardening. |
| [08 — Deployment and operations](08-deployment-architecture-and-operations.md) | Documented components/topology/sizing/storage/network/install/upgrade/HA/DR/observability. |
| [09 — Public API and object model](09-public-api-and-object-model.md) | Complete operation and schema inventory generated from current raw OpenAPI. |

### Independent rebuild blueprint

| Document | Purpose |
|---|---|
| [10 — Open-source reference architecture](10-open-source-reference-architecture.md) | OSS component map, licenses/tradeoffs, logical topology, deployment profiles, build order. |
| [11 — Proposed data/service contracts](11-proposed-data-model-and-service-contracts.md) | Clean-room tables, domains, REST/SSE/events, consistency, privacy classifications. |
| [12 — UI/UX reconstruction spec](12-ui-ux-reconstruction-specification.md) | Independent route/layout/component/state/accessibility/localization requirements. |
| [13 — Roadmap and acceptance tests](13-reimplementation-roadmap-and-acceptance-tests.md) | Phased implementation, quality gates, E2E/security/performance/parity checks. |
| [14 — Gaps and clean-room boundary](14-gaps-unknowns-and-clean-room-boundary.md) | Unknowable private internals, decisions, experiments, legal/IP boundary. |

## Visual evidence

- [`screenshots/`](screenshots/) — **18** verified public product UI references plus contact sheet and per-file source/hash metadata.
- [`architecture-diagrams/`](architecture-diagrams/) — **11** verified GCP/AWS/Azure/OCI public reference diagrams plus contact sheet and provenance.

These files are attributed research evidence. Cohere retains rights in its product images/diagrams. Do not ship them, copy their trade dress, or use them as project-owned assets.

## Research artifacts

- [`research/NORTH_PAGE_MANIFEST.json`](research/NORTH_PAGE_MANIFEST.json) — complete per-URL crawl record with discovery method, attempts, status, title, hierarchy, size, and SHA-256.
- [`research/SOURCE_CATALOG.md`](research/SOURCE_CATALOG.md) — all current in-scope URLs grouped by area.
- [`research/CRAWL_DELTA.json`](research/CRAWL_DELTA.json) — machine-readable comparison with the 2026-07-21 crawl.
- [`SOURCES_LEDGER.json`](SOURCES_LEDGER.json) — citation URL ledger used to generate each document's Sources block.

The repository intentionally avoids mirroring all 421 vendor pages verbatim. The manifest, hashes, catalog, cited synthesis, screenshots, and generated API inventory retain auditability while reducing copyright and clean-room contamination risk.

## Recommended reading order

1. Read **00**, **01**, and **14** to understand facts, boundaries, and unknowns.
2. Read **03–09** as the product/technical specification.
3. Read **10–12** as the independent implementation design.
4. Execute **13** phase by phase; do not start with UI-only parity.
5. Use **02** when upgrading this documentation against future North releases.

## Key implementation decisions

- Use the current runner's permissions for sources, models, and tools.
- Keep source/file/artifact/agent/workflow versions immutable and citation-resolvable.
- Use durable workflows for every long-running process.
- Separate read tools from effectful actions; bind approval to exact parameters and verify external state after execution.
- Expose safe execution summaries, not raw hidden chain-of-thought.
- Make egress/model/provider behavior visible and allow a sealed no-egress profile.
- Keep audit, telemetry, analytics, compliance access, and support bundles separate and content-minimized.
- Prefer a modular monolith plus workers initially; split services only for security/scaling/failure boundaries.
- Benchmark open models/retrieval instead of claiming proprietary quality parity.
- Build an independent, accessible design system.

## Source of truth and maintenance

The live vendor documentation is mutable. For future updates:

1. recrawl root, indexes, OpenAPI, and links to convergence;
2. compare URL/status/hash manifests;
3. inspect current changelog and changed pages semantically;
4. regenerate the API inventory from raw OpenAPI;
5. update claims/citations and acceptance tests;
6. re-run link, citation, JSON, image, and manifest validation.

## Sources

[11] https://private.docs.cohere.com/openapi/north.yaml
[12] https://private.docs.cohere.com/docs/get-started/north-user-guide
[13] https://private.docs.cohere.com/docs/get-started/north-chat
[24] https://private.docs.cohere.com/docs/get-started/agents/creating-custom-agents

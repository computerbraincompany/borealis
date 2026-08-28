# Product overview, taxonomy, and information architecture

> **Historical North research — captured 2026-08-22.** Vendor behavior,
> release labels, API inventories, and references below describe that capture,
> not the latest North release or the implemented Borealis product. See the
> [archive overview](README.md), [Borealis README](../../README.md), and
> [Borealis API reference](../API.md) for the distinction and current contracts.

**Status:** evidence-backed functional specification for clean-room reimplementation<br>
**Evidence date:** 2026-08-22

## 1. Product definition

Cohere documents North as an enterprise agentic AI platform that joins conversational work, connected enterprise knowledge, custom agents, graph automations, document creation, tables, and administrative governance. Its public positioning emphasizes a secure AI workspace that combines LLMs, search, and automation, with private deployment as a core differentiator.[5][7][8]

The product is not merely a document-chat UI. The documented platform spans:

- **interactive work:** Chat, citations, generated documents, tables, deep research, history, sharing, notifications, and memory;
- **reusable intelligence:** default and custom agents, an agent gallery, versioned releases, evaluations, models, instructions, tools, and starters;
- **enterprise knowledge:** personal files, libraries, synchronized data sources, connected SaaS/on-prem systems, web search, and Compass-backed retrieval;
- **automation:** graph workflows, typed inputs/outputs, LLM and agent nodes, conditions, loops, human review, test runs, publication, schedules, and monitoring;
- **governance:** identity, users/groups/roles, model/tool/agent/automation permissions, action approvals, audits, retention, analytics, guardrails, and feature rollout;
- **operations:** Kubernetes/Helm deployment, private networking, model serving, storage/search dependencies, observability, backup, upgrade, and support.

The current public user guide describes a release calendar, feature maturity labels, and an explicit capability matrix.[12]

## 2. Feature maturity baseline

| Feature area | Capability | Documented state | Reimplementation implication |
|---|---|---|---|
| Admin | White labeling | Beta | Keep branding/localization modular; do not make it an MVP blocker. |
| Admin | RBAC | GA | Treat authorization as foundational, not an add-on. |
| Admin | Product analytics | Beta | Separate opt-in product analytics from audit and operations. |
| Augmentation | Chat | GA | Core product surface. |
| Augmentation | Custom agents | GA | Versioned, governed reusable agent specs are core. |
| Augmentation | Document creation | GA | Durable editable artifacts belong beside chat. |
| Augmentation | Tables | Alpha | Build behind a feature flag and test data integrity aggressively. |
| Augmentation | Automations | Beta | Use a versioned workflow engine with strong failure/HITL semantics. |
| Augmentation | Third-party/OpenAI-compatible models | Alpha | Define capability degradation rather than pretending every model is equivalent. |
| Search | Compass search | GA | Retrieval, parsing, permissions, and citations are core platform services. |
| Modeling | North-specific models | GA | The open implementation must substitute capable OSS models and transparent profiles. |
| API | North API | Alpha | Preserve public object semantics while expecting contract evolution. |

North defines **Alpha** as early/incomplete with no SLO, **Beta** as approaching production with best-effort recovery and no backward-compatibility guarantee, and **GA** as stable/supported with compatibility and defined SLO expectations.[12]

## 3. Primary user roles

### 3.1 End user

- Starts chat with a default or selected custom agent.
- Selects models, capabilities, sources, and tools where entitled.
- Uploads files, creates libraries, connects personal accounts, checks citations, and manages history/memory.
- Creates and edits documents/tables and runs automations.
- Responds to tool-action approvals and human-review tasks.

### 3.2 Agent builder

- Creates a draft custom agent with instructions, model, tools, sources, starters, and visibility.
- Evaluates the draft, publishes a version, shares it, and restores history.
- Must not be able to grant consumers data/tool access they do not have at runtime.[23][24][25]

### 3.3 Automation builder

- Designs graph workflows, configures nodes/inputs/outputs, tests individual nodes or the graph, publishes versioned releases, imports/exports definitions, and monitors runs.
- Requires separate build, run, and monitor permissions.[27][28][31]

### 3.4 Reviewer/operator

- Receives a review URL or notification, inspects a paused automation, submits typed review fields/files/selections, and allows execution to continue.
- Reviews failed/queued/running/completed executions and operational evidence.[29][32]

### 3.5 Organization administrator

- Manages identity, users/groups/roles, permissions, tools/connectors/MCP, agents, models, automations, guardrails, audits, analytics, experience, retention, and service status from a distinct administrator panel.[46][47][48]

### 3.6 Platform operator

- Installs/upgrades North, configures networking/storage/model services, validates images and preflight requirements, monitors metrics/traces/alerts, manages backup/restore, and produces support evidence.

## 4. Canonical domain taxonomy

The following taxonomy is derived from the documented UI and API. Terms in the right-most column are recommended neutral names for the rebuild, not Cohere terminology requirements.

| Documented concept | Meaning | Recommended open-source object |
|---|---|---|
| Organization/company | Administrative and policy boundary | `Organization` |
| User/group/role/permission | Identity and authorization subjects/rules | `Principal`, `Group`, `Role`, `Permission` |
| Default agent | Per-user private ready-to-use agent; immediate settings | `PersonalAgent` |
| Custom agent | Reusable versioned agent configuration | `AgentDefinition` + `AgentVersion` |
| Conversation/chat | Interactive session and message history | `Conversation` + `Message` |
| Capability | Built-in mode such as web search, data interpreter, document/tables | `Capability` |
| Source | Searchable connected system or content origin | `Source` + `Connector` |
| My Files | User-owned uploaded file area | `File` in personal scope |
| Library | Governed reusable collection of files/folders/artifacts | `Library` + `LibraryItem` |
| Custom tool/MCP server | Governed executable or contextual integration | `ToolServer`, `Tool`, `Resource`, `Prompt` |
| Document | Durable generated/edited long-form output | `Artifact(type=document)` |
| Table | Grid artifact with data/AI operations | `Artifact(type=table)` |
| Automation | Versioned graph workflow definition | `WorkflowDefinition` + `WorkflowVersion` |
| Execution/run | Runtime instance of a published workflow | `WorkflowRun` + `NodeRun` |
| Human review task | Paused run awaiting typed user input | `ReviewTask` |
| Model | Available/approved LLM or embedding/rerank model | `ModelProfile` |
| Audit | Administrative/security event | `AuditEvent` |
| Memory | Editable user-level retained facts/preferences | `MemoryItem` |
| Notification | User-visible completion/review event | `Notification` |

## 5. Information architecture

### 5.1 End-user navigation

The reviewed documentation supports the following user-facing areas:

1. **Home** — central composer with the default agent, model/context/tool selection, and recent work.
2. **Agents** — browse/search/sort/star agents; open chat; manage owned definitions.
3. **Automations** — separate Discovery, Runs, My builds, and Monitor areas.
4. **Tables** — create and work with grid-like research/analysis artifacts when enabled.
5. **Sources** — My Files/My Drive, Libraries, and Connected sources.
6. **Recent chat history** — conversation list grouped around previously used agents.
7. **Inbox/notifications** — completion and review events for long-running work.
8. **User settings** — profile, appearance, language, notification preferences, memory, connections, and personal agent settings.

Agents are accessed from Home, the Agents page, and chat history. Custom agents can be private, shared with selected people, or available organization-wide, subject to admin enablement.[23][26]

### 5.2 Administrator navigation

A reconstruction should provide an explicit admin application or route group with:

- overview and service deployment status;
- users, groups, roles, and permissions;
- authentication and programmatic identity;
- models and model access;
- tools, connectors, MCP servers, per-tool policy, and credentials;
- agent and automation governance;
- guardrails, flow control, feature flags, experiments, and capabilities;
- audits, compliance, retention/deletion, encryption, and data controls;
- analytics and feedback configuration;
- branding, locales, banners, terms, and user experience settings;
- operational configuration, logs, and support evidence.[46]

### 5.3 Composer anatomy

The composer is the product's convergence point. It should expose:

- active agent;
- model/reasoning profile when user-selectable;
- attachments and reusable libraries;
- capabilities;
- connected sources;
- MCP/custom tools;
- an explicit send/cancel state;
- context explaining which tools are on by default;
- visible egress/action-risk labels;
- upload/indexing readiness;
- a path to inspect source/tool configuration before execution.[13][14][33]

## 6. Core state machines

### 6.1 Agent definition

```text
private draft
  ├─ edit → private draft
  ├─ evaluate → evaluation run → pass/fail evidence
  └─ publish(version type + notes) → published version
published version
  ├─ create draft from current → private draft
  ├─ restore prior version → new/restored draft or release
  ├─ change visibility → entitlement update
  └─ delete/archive → unavailable to new chats (retention policy applies)
```

The personal/default agent is an exception: it is private, cannot be shared, and applies saved setting changes immediately without draft/version history.[23]

### 6.2 Conversation

```text
created → active/streaming → idle
  ├─ background task running → notification on completion/failure
  ├─ renamed / title generated
  ├─ shared snapshot created
  └─ deleted → graceful/retention lifecycle
```

### 6.3 Source content

```text
registered → pending sync/upload → parsing/indexing → ready
                                  ├─ partially ready
                                  ├─ failed/skipped
                                  └─ deleted/revoked
ready → re-syncing → ready | partial | failed
```

### 6.4 Workflow

```text
draft autosaved → tested → published version → runnable
published version → duplicated/exported/imported → new draft
run: queued → running → waiting_review → running → completed
                         └──────────────→ timed_out/failed/cancelled
```

## 7. Global invariants for the rebuild

1. **Authorization is evaluated at execution and retrieval time.** Sharing an agent or workflow never grants hidden access to its owner's data or tools.
2. **Every generated claim can carry provenance.** A citation resolves to source, version, location/span, and access check.
3. **Actions are not equivalent to reads.** Tool manifests classify effects, and risky actions require policy or approval.
4. **Artifacts are durable and versioned.** Documents, tables, reports, and exported files are not transient chat decoration.
5. **Long-running work is explicit.** Background tasks and workflow runs have IDs, states, cancellation, timestamps, errors, and notifications.
6. **Definitions and runs are separate.** Agents/workflows are versioned definitions; conversations/executions are immutable or append-only runtime evidence.
7. **Maturity is visible.** Alpha/Beta/GA and model/tool compatibility limits appear in UI and API metadata.
8. **Audit, product analytics, and telemetry remain separate data planes.** Each has different retention, privacy, and access rules.
9. **Feature flags cannot bypass authorization.** Enablement controls availability; the permission engine controls access.
10. **No silent egress.** Web, SaaS, hosted-model, and remote MCP use is visible and policy-controlled in the open implementation.

## 8. Deliberate divergence from a visual clone

The rebuild should reproduce outcomes and interoperable contracts, not Cohere branding or screen composition. Use a project-owned design language; add stronger source/egress/action indicators; make authorization consequences explicit; keep service boundaries swappable; and avoid assuming that every North-specific model or proprietary retrieval behavior is reproducible.

## Sources

[5] https://cohere.com/north
[7] https://cohere.com/blog/north-ga
[8] https://cohere.com/blog/north-eap
[12] https://private.docs.cohere.com/docs/get-started/north-user-guide
[13] https://private.docs.cohere.com/docs/get-started/north-chat
[14] https://private.docs.cohere.com/docs/get-started/north-chat-capabilies
[23] https://private.docs.cohere.com/docs/get-started/agents
[24] https://private.docs.cohere.com/docs/get-started/agents/creating-custom-agents
[25] https://private.docs.cohere.com/docs/get-started/agents/evaluating-agents
[26] https://private.docs.cohere.com/docs/get-started/agents/agent-library
[27] https://private.docs.cohere.com/docs/get-started/north-automations
[28] https://private.docs.cohere.com/docs/get-started/north-automations/building-automations/configuring-automation-nodes
[29] https://private.docs.cohere.com/docs/get-started/north-automations/building-automations/human-in-the-loop-automations
[31] https://private.docs.cohere.com/docs/get-started/north-automations/building-automations/saving-publishing-monitoring-automations
[32] https://private.docs.cohere.com/docs/get-started/north-automations/consuming-automations
[33] https://private.docs.cohere.com/docs/get-started/tools-overview
[46] https://private.docs.cohere.com/docs/admin/overview
[47] https://private.docs.cohere.com/docs/admin/permissions
[48] https://private.docs.cohere.com/docs/admin/audits

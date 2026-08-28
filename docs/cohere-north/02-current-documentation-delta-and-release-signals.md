# Documentation delta and v1.14 release signals (2026-08-22)

> **Historical North research — captured 2026-08-22.** Vendor behavior,
> release labels, API inventories, and references below describe that capture,
> not the latest North release or the implemented Borealis product. See the
> [archive overview](README.md), [Borealis README](../../README.md), and
> [Borealis API reference](../API.md) for the distinction and current contracts.

**Comparison window:** 2026-07-21 → 2026-08-22<br>
**Published platform release at capture:** v1.14.0 (2026-08-21)<br>
**Next scheduled release shown at capture:** v1.15.0 (2026-09-18, explicitly subject to change)[12]

## 1. Measured documentation delta

The current converged crawl contains 435 unique in-scope URLs: 421 read pages, 14 explicit soft-not-found aliases, and no auth-gated page. Compared with the July manifest, 91 URLs are added, 37 removed from the current scope, 218 common URLs have different content hashes, and 2 changed read/failure status. See [`research/CRAWL_DELTA.json`](research/CRAWL_DELTA.json).

A narrower canonical-index comparison produces a different, complementary number: the current `north/llms.txt` contains 342 canonical URLs, of which **65** were absent from the July manifest.[2] The 91-URL full-crawl delta also includes aliases, index/discovery routes, and other converged in-scope records. Neither number means that the same number of product features launched during the interval.

A content-hash change does not identify the semantic edit. The table below limits conclusions to current page text and the v1.14 release note.

## 2. v1.14.0 release identity and upgrade constraint

The 2026-08-21 changelog identifies North Platform **v1.14.0**, App **v0.350.4**, and Compass **v5.7.0**.[109]

A critical operational constraint is documented: upgrades from v1.12 or earlier must pass through v1.13 because v1.13 performs an Inngest PostgreSQL schema migration that v1.14 no longer ships. Skipping it can break automations, tables, schedules, and long-running work; the migration is described as one-way with no rollback to the v1.12 Inngest schema.[109]

**Rebuild implication:** durable workflow schema changes need an explicit supported-hop matrix, preflight blockers, one-way-migration warnings, and rollback/restore testing. Never rely on users reading a release note after deployment begins.

## 3. Product changes with direct parity impact

### 3.1 Agents

The v1.14 note introduces custom-agent semantic versioning/history/restore and Alpha evaluation tasks with LLM-as-judge pass/fail checks against the current draft.[109]

Parity impact:

- immutable agent versions and draft/live separation;
- semver publish flow and notes;
- restore-to-draft semantics;
- repeatable evaluation tasks/cases/runs;
- publish-time evaluation snapshot;
- owner/admin permissions and non-interactive action safety.

### 3.2 Chat and background work

v1.14 makes pasted text of 1,000+ characters a snippet chip and runs every conversation in the background rather than only Deep Research. It also expands v2 conversation APIs for messages, attached files, background tasks/cancellation, and generated titles.[109]

Parity impact:

- foreground stream and durable background-task state are one lifecycle;
- navigation cannot cancel work accidentally;
- reconnect/cancellation/title generation are explicit contracts;
- inbox notification deep-links to the owning resource.

### 3.3 Document Mode and citations

v1.14 adds agent-driven document version comparison with inline additions/deletions and citation support for Claude through AWS Bedrock tool-result documents.[109]

Parity impact:

- document changes are versioned and diffable;
- citation capability belongs in model-provider compatibility metadata;
- every provider/model combination needs contract tests rather than a generic “supports citations” switch.

### 3.4 Notifications

The release note marks inbox notifications Alpha for Human Review and automation failures; current docs also use notifications for background chat/research completion.[18][109]

Parity impact: a durable notification service, read/unread state, user preferences, exactly-once terminal notifications, and resource deep links are core—not optional toast UI.

### 3.5 GitHub and conversation history

GitHub appears as a Beta read-only source for repositories, code, PRs, issues, commits, releases, and tags. Conversation History appears as Alpha, scoped to the user's conversations with the current agent.[74][109]

Parity impact: implement connector scope/ACL/read-only contracts and treat conversation recall as an explicitly permissioned source with citations, retention, and language limits.

### 3.6 Guardrails

The note marks Guardrails Beta for selected customers and adds organization/rule-level PII sensitivity.[109]

Parity impact: policy versions, target scope, sensitivity level, action (block/redact/warn), evaluation datasets, false-positive monitoring, and audit evidence are required. A classifier toggle alone is not a production guardrail system.

### 3.7 Tables

v1.14 adds reviewed-cell protection/staleness, cell reasoning/tool trace, and AI-assisted column prompt generation.[21][109]

Parity impact:

- cell dependency hashes and stale state;
- protected bulk operations;
- per-cell execution evidence;
- proposed prompt/config changes must be reviewable and undoable in the rebuild, even though the documented save replacement is not undoable.

### 3.8 Libraries and local-library API

Libraries move to Beta with broader sharing and a local-file API. Shared-agent recipients must independently have Reader access to every attached library; access is no longer indirectly granted through agent sharing. The old library-jobs endpoints are removed in favor of local-library creation/file upload/file-status APIs or My Files batch upload plus library attach.[34][109]

Parity impact:

- model libraries and local libraries as distinct types behind one UI;
- per-recipient grant validation;
- per-file indexing status/partial failure;
- API deprecation/removal policy and migrations;
- no hidden attachment-driven data grant.

### 3.9 MCP, OAuth, and approvals

v1.14 adds custom MCP icons, OAuth application binding for delegated North API access using scoped subject-token exchange, and human-friendly tool-approval parameter labels.[76][109]

Parity impact:

- server identity is separate from tool capability;
- delegated subject tokens are short-lived/audience/scope-bound;
- tool schema labels are presentation metadata only; canonical keys remain stable;
- approval is bound to exact parameter values/schema hash.

### 3.10 Sandbox hardening

The release changes sandbox configuration paths, removes overlay mechanisms, drops all Linux privileges including SETUID/SETGID, prevents sudo/system package installs, adds short-lived on-behalf-of model tokens, and supports private CAs/proxies.[73][109]

Parity impact:

- sandbox configuration is a versioned public contract;
- runtime images and package policy are explicit;
- no Kubernetes/service/provider credential inheritance;
- enterprise proxy/private CA support must not silently broaden egress.

### 3.11 Admin, audit API, and support

The release includes a partial React admin refresh, targeted support bundles, group preregistration, continued experiments after creator deletion, and Alpha audit APIs filterable by action/time with actor/resource/IP/session/impersonation context.[109]

Parity impact:

- owner deletion cannot orphan organization resources without a transfer/system-owner policy;
- support bundle composition is selectable but always redacted;
- audit API is paginated, permissioned, content-minimized, and tamper-evident;
- UI migration must preserve route/permission behavior during coexistence.

### 3.12 Compass/search operations

The release cites corrected asset IDs for document visuals, configurable dense embedding dimensions, configurable parse image quality, sharded storage keys for large libraries, and more detailed retrieval traces.[109]

Parity impact:

- embedding dimension belongs to an immutable index profile and requires reindex on incompatible change;
- parser image quality is versioned and storage-cost aware;
- object/index keys scale beyond flat prefixes;
- tracing may include IDs/scores but must avoid source text and high-cardinality leaks.

## 4. New or newly indexed documentation routes

Notable additions in the current manifest include:

- agent evaluations;
- code sandbox and conversation-history tools;
- GitHub, Linear, Notion, Jira/Slack legacy/migration pages;
- MCP Apps;
- local-library endpoints;
- OAuth authorization/token/revocation;
- v2 conversations/messages/files/background tasks/title;
- MCP development guides for citations, observability, and interaction;
- FIPS and image-signature verification;
- observability dashboards and alert rules;
- dated changelog entries through 2026-08-21.

This list means the pages are present in the current crawl; it does not prove every feature was absent from the product in July.

## 5. Important non-deltas

The July manifest already contained the canonical pages for Notifications, Memory, custom-agent creation/versioning, MCP elicitations/prompts/resources, North Large 01-2026, and Open Responses compatibility. Their current wording may have changed, and the v1.14 release note may explicitly announce some behavior, but page presence itself is **not** evidence that these capabilities first appeared after July 21.[18][19][24]

This distinction is why agent evaluations, MCP Apps, and Conversation History are described above as newly indexed.[25][36][74] Local-library and v2 conversation/background-task routes are likewise newly indexed in the comparison, while the pre-existing pages are described as currently documented or as v1.14 release-note claims.[11]

## 6. Removed/stale route signals

Current scope no longer includes several older aliases and external references, including NFS-drive documentation and the old library job endpoints. The v1.14 note explicitly removes External Drive/NFS and `POST /v1/libraries/jobs` plus `GET /v1/libraries/jobs/{job_id}`.[109]

**Rebuild implication:** preserve a deprecation ledger, publish replacement operations, emit machine-readable sunset metadata, and test old client behavior before removal.

## 7. Architecture clues from the release manifest

The v1.14 image list publicly names deployables for toolkit frontend/backend, admin frontend/backend, agent, MCP router, tables backend, Compass API/parser/pipelines/Atlas, guardrails service, Inngest, OpenFGA, Valkey, sandbox components, reader, Envoy/XDS, s3proxy, and support tooling.[109]

These names corroborate the deployment-component guide, but they still do not disclose private code or internal contracts. The independent stack in [`10-open-source-reference-architecture.md`](10-open-source-reference-architecture.md) substitutes open components rather than attempting binary/service-name cloning.

## Sources

[2] https://private.docs.cohere.com/north/llms.txt
[11] https://private.docs.cohere.com/openapi/north.yaml
[12] https://private.docs.cohere.com/docs/get-started/north-user-guide
[18] https://private.docs.cohere.com/docs/get-started/notifications
[19] https://private.docs.cohere.com/docs/get-started/memory
[21] https://private.docs.cohere.com/docs/get-started/north-table-mode
[24] https://private.docs.cohere.com/docs/get-started/agents/creating-custom-agents
[25] https://private.docs.cohere.com/docs/get-started/agents/evaluating-agents
[34] https://private.docs.cohere.com/docs/get-started/tools/libraries
[36] https://private.docs.cohere.com/docs/get-started/tools/mcp-servers/mcp-apps
[73] https://private.docs.cohere.com/docs/get-started/tools/code-sandbox/home
[74] https://private.docs.cohere.com/docs/get-started/tools/conversation-history/home
[76] https://private.docs.cohere.com/docs/admin/oauth-applications
[109] https://private.docs.cohere.com/changelog/20260821

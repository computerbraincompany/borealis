# Security, identity, permissions, governance, and data lifecycle

> **Historical North research — captured 2026-08-22.** Vendor behavior,
> release labels, API inventories, and references below describe that capture,
> not the latest North release or the implemented Borealis product. See the
> [archive overview](README.md), [Borealis README](../../README.md), and
> [Borealis API reference](../API.md) for the distinction and current contracts.

**Status:** threat-aware reconstruction requirements<br>
**Evidence date:** 2026-08-22

## 1. Security boundary and threat model

North's public security guide targets customer-controlled on-premises and air-gapped deployments and covers cluster access, SSO/JIT administration, database/Redis security, secrets, network segmentation, container/runtime controls, etcd, logs/SIEM, backups, and a hardening checklist.[40]

The open implementation must assume:

- malicious or compromised users inside an organization;
- source documents/web pages attempting prompt injection;
- agents attempting excessive data access or tool use;
- compromised connector/MCP servers and capability drift;
- confused-deputy authorization between builder, owner, runner, reviewer, and source principal;
- cross-tenant/user retrieval or cache leakage;
- unsafe generated code and sandbox escapes;
- secret/token leakage through prompts, logs, traces, exports, or support bundles;
- SSRF/data exfiltration through web, MCP, callbacks, HTML, and model providers;
- replay/duplicate external actions;
- poisoned model/update/container supply chain;
- operator mistakes in key rotation, backup, retention, and deletion.

## 2. Identity and authentication

North documents Basic Authentication and enterprise SSO. Basic is positioned for development/staging/CI/demos with controls for registration, UI login, and allowed email domains; it is not recommended for production human access. SSO uses OIDC and SAML through a Dex-derived federation layer, with OAuth 2.0 Authorization Code + PKCE for interactive flows, OIDC preferred, SAML for legacy compatibility, LDAP shim/hybrid patterns, and proxy mode.[45]

### 2.1 Open implementation requirements

- OIDC Authorization Code + PKCE for browser clients; short-lived secure HTTP-only session cookies.
- Disable local passwords by default in production; retain break-glass bootstrap credentials offline and rotated.
- Validate issuer, audience, nonce, state, PKCE, signature algorithms, clock skew, and redirect URI exactly.
- Map immutable external subject + issuer, never email alone, to local principal identity.
- JIT provisioning with controlled allowed domains, group hydration, and deprovisioning.
- SCIM or scheduled directory reconciliation for reliable lifecycle where possible.
- Service identities use OAuth client credentials or signed workload identity/token exchange—not shared human API keys.
- Public OAuth client registration is admin-governed; scopes and redirect URIs are explicit.[75][76]
- Privileged admin access supports JIT/time-bound roles and strong MFA at the upstream IdP.

## 3. Authorization model

North documents reusable roles and direct permissions assigned to all users, individual users, or IdP groups. System roles include Agent Builder, Agent Manager, Automations Builder, and Automations Manager. Resource-specific administration exists separately for agents, models, tools/MCP, and automations.[47]

The deployment component guide explicitly names OpenFGA as the fine-grained/relationship authorization backbone.[52]

### 3.1 Recommended policy layers

```text
allow = tenant_match
    AND feature_enabled
    AND principal_authenticated
    AND global_permission
    AND resource_relationship
    AND source_native_acl
    AND model/tool entitlement
    AND runtime policy/approval
    AND data lifecycle permits access
```

Feature flags never grant access. UI hiding is not authorization. Every list/query must filter before pagination/counting; every object/content/tool action must authorize again by canonical resource ID.

### 3.2 Documented permission inventory

The current Admin permissions page includes:[47]

- create agents;
- share agents with users, groups, or everyone;
- configure tools/settings;
- view analytics/audits;
- register/manage MCP servers;
- use/build/configure automations;
- organization admin;
- override platform instructions for agents;
- administer agent instructions/raw prompt data;
- view/approve compliance requests;
- configure guardrails, experiments, flow control, terms;
- manage OAuth applications;
- create local-file libraries.

### 3.3 Required relationship tuples

```text
organization:O#member@user:U
organization:O#admin@user:U
agent:A#owner@user:U
agent:A#viewer@group:G
workflow:W#builder@user:U
workflow:W#runner@group:G
library:L#reader@user:U
library:L#editor@group:G
tool:T#user@group:G
model:M#user@role:R
review_task:R#reviewer@user:U
```

Evaluate nested membership and revoke immediately. Cache policy decisions only with short TTL plus model/version/tuple revision; sensitive retrieval should include the decision revision in evidence.

## 4. Tool authentication and authorization

North separates tool authentication, authorization, sharing, and action approval. It documents delegated user credentials/source-native ACLs and administrator permissions for servers/tools.[33][68][69]

### 4.1 Credential architecture

- Store OAuth refresh tokens/API credentials in an external secret manager or envelope-encrypted credential store.
- Separate organization connector registration from each user's delegated connection.
- Exchange/decrypt credentials only in the connector/tool execution service.
- Never expose refresh tokens to LLMs, browsers, workflow definitions, exports, or logs.
- Scope tokens to the minimum resources/actions and support revocation/expiry/rotation.
- Bind credentials to organization, principal, connector, and allowed endpoint.

### 4.2 Runtime authorization

- Resolve the current **runner**, not the agent/workflow builder, for source/tool permissions.
- Enforce North platform permission and source-native permission.
- Recheck on every indexed retrieval or live action.
- Distinguish connector registration, connection ownership, server use, tool use, and individual action approval.
- Treat “always-on” or “allow always” as policy records with owner, scope, reason, expiry, and revocation—not global invisible bypasses.

## 5. Action approvals

North pauses destructive/effectful tool calls, displays tool and parameters, allows approve/deny/parameter modification, and then continues or cancels. Documented choices are Allow Once, Allow Always (global bypass across chats/agents), and Deny (blocks the tool for that chat).[42]

### 5.1 Stronger approval object

```text
ApprovalRequest
- id, organization_id, principal_id
- conversation/run/node/tool_call identifiers
- tool server/version, tool name/schema hash
- effect classification
- original and proposed parameter hashes
- safe human-readable diff
- status, created/expires/resolved timestamps
- decision, decision scope, resolver
```

### 5.2 Rules

- Approval is bound to exact validated parameters, tool/schema version, credential, target account, and call ID.
- Editing parameters creates a new proposal hash and reruns validation/policy.
- Allow Once applies to one call only.
- “Always” defaults to a narrow tuple (tool + target account + action + agent/workflow), expires, and requires a settings UI; avoid vendor-documented instance-wide invisibility as the default.
- Denial cancels the call; the agent receives a structured denial, not a reason containing secrets.
- Approval cannot override missing base authorization.
- External actions need idempotency keys and post-action read-back verification.
- Evaluations/tests cannot pause for approval and therefore fail safely rather than mutating.[25]

## 6. Data-access and sharing rules

- Connected Drive/SharePoint effective scope is configured agent scope intersected with the current user's upstream permission.[24]
- My Files attached directly to a shared agent are documented as becoming available to recipients; this must be made explicit or replaced with per-file grants in the rebuild.[24]
- Libraries require independent Reader access for each agent recipient.[34]
- Shared conversations/documents should be immutable, read-only snapshots with explicit scope, revocation, and citation treatment.[16][20]

**Invariant:** no sharing operation may implicitly grant model, source, library, tool, conversation, or artifact access without a previewable grant or documented service entitlement.

## 7. Encryption and key management

North documents column-level envelope encryption for sensitive chat columns in PostgreSQL using AES-256-GCM, a customer-managed 32-byte URL-safe-base64 master key, wrapped DEKs, scheduled DEK rotation (60 days by default, 1-day minimum), and master-key rewrapping using a temporary previous key. The master key is not stored in the database. The feature explicitly does not cover automations/workflows.[41]

### 7.1 Open implementation baseline

- Encrypt all sensitive domains, including conversations, agent/workflow definitions, runs, review inputs, memory, credentials, and source-derived metadata—not chat only.
- Use AEAD with organization/resource/version context as associated data.
- Keep master/KEK material in KMS/Vault/HSM where available; store only wrapped DEKs and key IDs.
- Rotate DEKs and rewrap KEKs without rewriting all content where safe.
- Back up key material separately with dual control; restore tests must prove data decryptability.
- Prevent plaintext from entering logs, traces, metrics, crash reports, queues, caches, or analytics.
- Encrypt object storage, databases, search indexes, queues, and backups; use TLS/mTLS in transit.
- Define searchable-encryption tradeoffs explicitly; do not claim database search over ciphertext if the application decrypts/scans elsewhere.

## 8. Retention, graceful delete, purge, and legal hold

North has separate administration for retention and graceful deletion and separate documentation for data deletion.[70][79][80]

Recommended lifecycle:

```text
active → soft_deleted/grace_period → purge_queued → physically_purged
              └─ legal_hold → retained until hold release
```

Deletion must cover primary records and derivatives: object versions, parse text, chunks/embeddings, lexical/vector indexes, caches, library memberships, citations, exports, sandbox files, memory, notifications, workflow/evaluation evidence, and connector checkpoints. Authorization denies access at soft-delete immediately; physical purge is asynchronous and evidenced. Backups expire through retention rather than in-place mutation unless legally required.

## 9. Audit, compliance, analytics, and telemetry

North exposes separate admin areas for audits, compliance access, analytics, service status, metrics, and traces.[46][48][53]

Maintain distinct planes:

| Plane | Purpose | Content policy |
|---|---|---|
| Security audit | Who changed/accessed what and policy decision | content-minimized, tamper-evident, longer retention |
| Compliance access | Approved exceptional access to conversations/artifacts | dual authorization, expiry, case/reason, full evidence |
| Operational telemetry | latency, queue, errors, resource health | no prompt/document content or secrets |
| Product analytics | adoption and feature usage | opt-in/configurable, pseudonymous/aggregated by default |
| Debug/support | bounded troubleshooting | explicit generation/approval, redacted, expiring |

### 9.1 Audit event

```text
AuditEvent
- event_id, timestamp, organization_id
- actor type/id, effective role/service identity
- action, resource type/id, outcome
- policy decision/revision, request_id, trace_id
- source IP/client metadata where lawful
- before/after hashes or safe field names
- approval/compliance case references
- integrity chain/signature
```

Never log raw prompts, source snippets, credentials, tool payloads, memory text, review uploads, or model hidden reasoning by default.

## 10. Guardrails and flow control

North exposes admin guardrails and flow-control management.[49][78]

Open implementation layers:

1. input size/type/content checks;
2. prompt-injection and source-trust labeling;
3. retrieval ACL and data-class policy;
4. model/tool allowlists and egress constraints;
5. structured-output schema validation;
6. action effect classification and approval;
7. DLP/redaction on outbound provider/tool calls;
8. output safety/grounding/citation policy;
9. user/org/model/tool/workflow rate and concurrency limits;
10. anomaly detection and circuit breakers.

Guardrails are versioned policy decisions with explainable outcomes. They must fail closed for access/egress/actions and degrade safely for optional content classifiers.

## 11. Sandbox and interpreter security

Data Interpreter is documented as no-network, temporary, fixed-library, user-scoped execution; Code Sandbox is broader and can persist state within a chat.[44][72][73]

- separate execution identity per session/run;
- read-only input mounts and isolated generated outputs;
- deny-all network unless explicit per-session policy;
- non-root, dropped capabilities, seccomp/AppArmor, read-only root;
- CPU/RAM/PID/disk/time quotas;
- no cloud metadata, Kubernetes API, service account token, host paths, Docker socket, or secrets;
- signed/pinned images and controlled packages;
- content scan before persistence/download;
- complete safe command/code/event trace for the user and operator.

## 12. Deployment hardening

North's security guide recommends restricting cluster admin after setup, JIT privileged access, OIDC, PostgreSQL/Redis TLS and at-rest protection, Kubernetes Secret encryption or an external secret manager, default-deny NetworkPolicies, non-root containers, PSS, resource quotas, etcd encryption/mTLS/access isolation/audit/backups, centralized logs/SIEM, regular image patching/scanning, and tested backups.[40]

The rebuild should ship these as enforceable defaults and CI/preflight checks, not prose alone.

## 13. Security acceptance gates

- Cross-organization and cross-user object/retrieval tests fail closed across every API and queue worker.
- OIDC subject/issuer mapping survives email rename and denies token confusion.
- IdP group deletion/rename cannot leave an unnoticed durable grant; reconciliation reports drift.
- Revoked source permission blocks indexed retrieval immediately.
- Agent/workflow sharing does not grant implicit data/tool/model access.
- Tool approval is parameter-bound, expiry-bound, and idempotent; post-action state is read back.
- Master-key rotation succeeds across replicas and old key removal is verified.
- Backup restore requires authorized key material and preserves tenant boundaries.
- Sandbox cannot access host, metadata, service tokens, disallowed network, or another session.
- Purge removes every derivative and produces content-free evidence.
- Support bundle and telemetry scanners find no prompts, document text, credentials, or memory.
- API errors never expose raw stack traces or secrets and always carry request/trace IDs.

## Sources

[16] https://private.docs.cohere.com/docs/get-started/sharing-collaborating-chat
[20] https://private.docs.cohere.com/docs/get-started/north-document-mode
[24] https://private.docs.cohere.com/docs/get-started/agents/creating-custom-agents
[25] https://private.docs.cohere.com/docs/get-started/agents/evaluating-agents
[33] https://private.docs.cohere.com/docs/get-started/tools-overview
[34] https://private.docs.cohere.com/docs/get-started/tools/libraries
[40] https://private.docs.cohere.com/docs/security
[41] https://private.docs.cohere.com/docs/security/data-encryption-at-rest
[42] https://private.docs.cohere.com/docs/security/tool-action-approvals
[44] https://private.docs.cohere.com/docs/security/python-interpreter-controls
[45] https://private.docs.cohere.com/docs/admin/identity/overview
[46] https://private.docs.cohere.com/docs/admin/overview
[47] https://private.docs.cohere.com/docs/admin/permissions
[48] https://private.docs.cohere.com/docs/admin/audits
[49] https://private.docs.cohere.com/docs/admin/north-guardrails
[52] https://private.docs.cohere.com/docs/kubernetes-components
[53] https://private.docs.cohere.com/docs/observability/overview
[68] https://private.docs.cohere.com/docs/security/tool-authentication
[69] https://private.docs.cohere.com/docs/security/tool-authorization
[70] https://private.docs.cohere.com/docs/security/data-deletion
[72] https://private.docs.cohere.com/docs/get-started/tools/data-interpreter/home
[73] https://private.docs.cohere.com/docs/get-started/tools/code-sandbox/home
[75] https://private.docs.cohere.com/docs/admin/identity/identity-patterns
[76] https://private.docs.cohere.com/docs/admin/oauth-applications
[78] https://private.docs.cohere.com/docs/admin/flow-control
[79] https://private.docs.cohere.com/docs/admin/configuring_data_retention_settings
[80] https://private.docs.cohere.com/docs/admin/configuring_graceful_delete_settings

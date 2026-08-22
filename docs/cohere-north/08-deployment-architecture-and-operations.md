# Documented deployment architecture and operations

**Status:** first-party evidence plus clearly separated rebuild requirements<br>
**Evidence date:** 2026-08-22

## 1. Deployment model

North is documented as a composite Helm chart coordinating application and infrastructure subcharts, with a centralized Admin component for post-install configuration and day-two operations.[50]

The platform target is conformant Kubernetes **v1.30+** across self-managed and managed environments including AKS, EKS, GKE, and OpenShift. Helm v3 is recommended and v4 is not currently supported. Installation may need cluster privileges for CRDs, ClusterRoles, workloads, service accounts, secrets, config maps, autoscalers, disruption budgets, and volumes, although core services use namespaced roles.[81]

Public reference diagrams cover PoC, Pilot, and Production on GCP/AWS/Azure plus OCI Production; local copies with provenance are in [`architecture-diagrams/`](architecture-diagrams/).[51]

## 2. Documented internal component topology

The published Kubernetes component diagram shows users entering through Envoy Gateway into separate user/admin frontends and backends. Toolkit backend/workers connect to identity, authorization, Compass API/parser, Valkey, PostgreSQL, and object storage; an Agent service connects to toolkit/search/parser/reader/sandbox components; OpenSearch backs Compass; Dex and OpenFGA use PostgreSQL.[52]

| Component | Documented role | State profile |
|---|---|---|
| `envoy-gateway` | external ingress/gateway | deployment/controller |
| `toolkit-frontend` | React/Nginx end-user UI | deployment |
| `toolkit-backend` | core North API/business logic/integrations | deployment |
| `toolkit-sync-worker` | background data synchronization | worker deployment |
| `toolkit-workflows-worker` | workflow execution/task queues | worker deployment |
| `toolkit-task-runner` | individual task execution | worker deployment |
| `north-admin-frontend` | React/Nginx admin UI | deployment |
| `north-admin-backend` | admin business logic and service integration | deployment |
| `agent` | agent/model orchestration integration | deployment |
| `compass-api` | Compass API/admin/RBAC operations | deployment |
| `compass-parser` | parse/prepare data for indexing/analysis | deployment |
| OpenSearch operator/manager/data | index/search/cluster management | controller + stateful sets |
| `dex` | OIDC federation/authentication | deployment |
| `openfga` | relationship/fine-grained authorization | deployment |
| `s3proxy` | local S3-compatible file/object proxy | deployment |
| `terrarium` | secure Python sandbox | deployment |
| `co-reader` | web scraping/content parsing | deployment |
| `reloader` | watches config and triggers reloads | deployment/controller |

**Boundary:** these are explicitly documented service names/roles. The docs do not disclose their source code, internal schemas, message contracts, or algorithms.

## 3. Data services

### 3.1 PostgreSQL

The infrastructure guide requires PostgreSQL 16+, recommends managed PostgreSQL for production, and documents separate databases: `north`, `compass`, `dex`, `openfga`, `north_admin`, `north_tables`, `north_mcp_router`, `atlas`, and `inngest`. Guidance includes at least 50 GiB storage, 16 GiB memory, 4 cores, `max_connections >= 500`, and a five-minute idle-in-transaction timeout.[84]

Independent rebuild guidance:

- keep one physical cluster possible but separate schemas/databases and least-privilege service roles;
- migrations are versioned per service;
- use PgBouncer or provider pooling;
- enforce TLS, RLS where useful, query/lock/transaction timeouts, PITR, and tested restore;
- do not fragment into many databases before operational need justifies it.

### 3.2 Valkey/Redis

North documents Valkey 8.1.1+ or Redis 7+, bundled through Bitnami Valkey, for API/intermediate caches, distributed job coordination, and queue-like semantics, with 16 GiB storage, 8 GiB memory, and AOF persistence recommended.[84]

The rebuild should treat cache as disposable and durable jobs as database/workflow-engine state. If Valkey carries coordination, use explicit leases/idempotency and avoid making AOF the only record of a run.

### 3.3 OpenSearch

North documents OpenSearch 2.19.4 through the OpenSearch Operator for Compass indexing/search/retrieval. Default guidance uses three data nodes, 200 GiB block storage and 20 GiB memory each, plus the `analysis-icu` plugin for multilingual Unicode analysis. OpenSearch hosts require `vm.max_map_count=262144`.[82][84]

### 3.4 Object storage

North uses RWO block storage by default and an S3-compatible `s3proxy` for assets, My Files, branding, support bundles, and OpenSearch snapshots; external S3-compatible storage is supported for My Files. The default aggregate cluster storage guidance is 1 TiB across OpenSearch, My Files, Valkey, and PostgreSQL.[83]

## 4. Compute/model requirements as documented

These are Cohere's sizing claims for its model stack, not requirements for an independent OSS rebuild.[82]

| Workload | Documented minimum/guidance |
|---|---|
| Generative Command | 2× A100-80GB or 2× H100 |
| Rerank | 1× A10 |
| Embed | 2× T4 |
| Vision Parser | 1× H100 or A100-80GB |
| Packed Compass embed+rerank | 1× A100/H100 |
| Production starting point | 8× H100 for all documented models |
| CPU cluster baseline | 72 vCPU, 292 GiB RAM |
| GPU node available disk | at least 256 GiB; model weights may exceed 100 GiB compressed |

The same page reports approximate Smart Parsing throughput of 300+ pages/minute per H100 vision parser and Quick Text parsing of 750+ pages/minute per one-vCPU/8-GiB ingestion worker; actual capacity depends on content and configuration.[82]

Open implementation capacity must be benchmark-driven per selected model, quantization, context length, concurrency, hardware, and document mix. Provide a CPU/local-small-model developer profile, a single-node appliance profile, and a horizontally scalable production profile rather than inheriting vendor GPU assumptions.

## 5. Storage sizing

| Node type | Minimum local/ephemeral disk | Recommended | Purpose |
|---|---:|---:|---|
| GPU generative | 256 GiB/model | 768 GiB/model | image + weight expansion and rolling versions |
| GPU retrieval | 75 GiB/model | 150 GiB/model | embedding/rerank images and weights |
| CPU North | 100 GiB | 200 GiB | application images and rolling upgrade headroom |

These values are documented North guidance.[83]

## 6. Model-serving boundary

North supports proprietary North models and alpha third-party/OpenAI-compatible model integration, while deployment documentation covers local model containers and Model Vault patterns.[12][57]

For the rebuild, standardize:

```text
ModelGateway
- OpenAI-compatible chat/responses/embeddings/rerank APIs
- capability metadata (tools, JSON schema, vision, reasoning, citations)
- provider/model version pinning
- routing, quotas, timeouts, retries, cancellation
- local/remote/egress classification
- usage and trace correlation
```

Never claim identical behavior across models. Automated compatibility tests must measure tool calls, structured output, stream events, truncation, citation support, and context limits.

## 7. Networking and egress

North docs cover ingress, TLS/DNS, proxies, and private/air-gapped environments. The security guide recommends default-deny pod/namespace policies and explicit ingress/egress rules.[40][85]

Required rebuild zones:

1. user ingress;
2. admin ingress (separate policy/hostname where possible);
3. application services;
4. databases/cache/search/object store;
5. sandbox/code-execution;
6. model serving/GPU;
7. connector/MCP egress gateway;
8. observability;
9. backup/control plane.

All outbound traffic passes through an egress policy point with DNS/IP/domain/protocol logging and approval classes. Sandbox is deny-all by default. Web/remote MCP/SaaS/model egress is separately controlled; sealed mode has no hidden external fallback.

## 8. Installation and configuration lifecycle

### 8.1 Preflight

- Kubernetes/version/conformance and storage classes;
- namespaced/cluster permissions and CRDs;
- node capacity, GPU runtime, disk, and `vm.max_map_count`;
- DNS, TLS certificate, ingress, proxy, egress allowlists;
- PostgreSQL/Valkey/OpenSearch/object credentials and connectivity;
- registry access, image signatures, trust roots, mirrors;
- model availability/licenses/weights;
- secret manager/KMS and encryption key backup;
- time synchronization and observability endpoints.

### 8.2 Install

The documented install is Helm-based and supports bundled/external dependencies.[50][86]

Open implementation requirements:

- signed chart and images with SBOM/provenance;
- declarative values schema and secrets references;
- idempotent migrations and bootstrap jobs;
- readiness checks for every dependency;
- first admin created through one-time bootstrap flow;
- no default public credentials;
- generated deployment inventory and support matrix.

### 8.3 Upgrade and rollback

North publishes separate upgrade and rollback procedures.[87][88]

Independent rules:

- compatibility matrix and supported version hops;
- pre-upgrade backup and restore drill evidence;
- migration expand/contract pattern;
- canary/rolling deployment with readiness and PDBs;
- rollback only when data migrations are backward-compatible or a tested restore is available;
- pin model/tool/workflow schema compatibility;
- post-upgrade end-to-end smoke and data-integrity tests.

### 8.4 Supply chain/FIPS

The current docs include image-signature verification and FIPS-compliant image guidance.[89][90]

The rebuild should publish cosign signatures, SLSA provenance where possible, SPDX/CycloneDX SBOMs, vulnerability policy, reproducible build metadata, license inventory, and optional FIPS profile based only on validated cryptographic modules. Never market “FIPS compliant” from a base-image label alone.

## 9. Observability

North documents service status, Prometheus-style metrics, OpenTelemetry traces, dashboards, and alert rules.[53][54][55]

Minimum signals:

| Layer | Metrics/traces |
|---|---|
| API/UI | rate, errors, latency, active streams, auth failures |
| Agent/model | TTFT, tokens/sec, context size, tool rounds, finish/error reason |
| Retrieval | parse/index queue, query/rerank latency, hit count, ACL-deny count, freshness |
| Connectors | auth health, sync lag, item counts, partial failures, rate limits |
| Workflows | queue delay, run/node state, retries, HITL wait, schedule health |
| Sandbox | session count, quota denials, timeouts, escapes/policy violations |
| Data | pool/locks/replication, Valkey memory, OpenSearch shards/heap/disk, object errors |
| Security | approval decisions, policy denies, suspicious egress, admin/compliance access |
| Backup | last success, age, size, restore-test age, key-backup verification |

Trace IDs must propagate API → queue → model/retrieval/tool/sandbox → artifact. Telemetry must exclude prompts, source content, credentials, memory, and hidden reasoning.

## 10. Backup and disaster recovery

North's backup guide covers Kubernetes ConfigMaps/Secrets, `s3proxy` volumes/remote object storage, multiple PostgreSQL databases, and OpenSearch snapshots. It identifies the chat-encryption master key as required for decrypting database backups and notes that Dex session/`inngest` temporary state need not be retained in the documented procedure.[56]

### 10.1 Open rebuild backup set

- PostgreSQL PITR/base backup + logical export where needed;
- object storage with versioning/immutability;
- search/vector snapshots or deterministic reindex contract;
- authorization policy store/revision;
- KMS/Vault key backup and trust roots under separate control;
- connector configuration/checkpoints without plaintext secrets in ordinary export;
- Helm/GitOps configuration, chart/image/model digests, schema versions;
- audit integrity anchors;
- schedules and durable workflow/background tasks.

### 10.2 Restore order

1. Recover trust/KMS and secrets safely.
2. Provision compatible infrastructure and exact application/model versions.
3. Restore PostgreSQL and authorization state.
4. Restore object storage.
5. Restore search snapshots or reindex from authoritative objects.
6. Restore durable queues/schedules/runs or reconcile them to safe terminal/retry states.
7. Validate tenant boundaries, encryption, ACLs, citations, connectors, workflows, and audit chain.
8. Re-enable ingress/egress only after smoke and security checks.

Set explicit RPO/RTO per profile and run recurring isolated restore exercises. A successful backup command is not a successful recovery plan.

## 11. High availability and scaling

- stateless frontends/backends horizontally scaled behind gateway;
- independent sync/workflow/task worker pools;
- node pools for CPU, search, sandbox, and each model class;
- queue backpressure and per-tenant fairness;
- PostgreSQL HA/PITR, Valkey HA if durable coordination depends on it, OpenSearch zone awareness, object replication;
- PDBs, topology spread, anti-affinity, HPA/KEDA where signals are meaningful;
- graceful drain/cancellation for streams, tools, model calls, and workflow nodes;
- schema/contract compatibility during rolling upgrades.

## 12. Operational acceptance tests

- Fresh install from signed artifacts reaches readiness with no manual DB edits.
- Sealed install succeeds from mirrored registries/models and performs no external network calls.
- Loss of one app/worker/search node does not corrupt conversations, runs, or indexes.
- Rolling upgrade and documented rollback/restore paths preserve data and authorization.
- PostgreSQL/object/search/key backups restore into an isolated cluster and pass end-to-end checks.
- Expired connector credentials fail clearly without leaking tokens or returning stale unauthorized data.
- Queue/model overload applies backpressure/fairness and never drops durable work silently.
- Metrics/traces/support bundles contain no user content or secrets.
- Signature/SBOM/license gates reject tampered or disallowed images.

## Sources

[12] https://private.docs.cohere.com/docs/get-started/north-user-guide
[40] https://private.docs.cohere.com/docs/security
[50] https://private.docs.cohere.com/docs/deployment-overview
[51] https://private.docs.cohere.com/docs/architecture-diagrams
[52] https://private.docs.cohere.com/docs/kubernetes-components
[53] https://private.docs.cohere.com/docs/observability/overview
[54] https://private.docs.cohere.com/docs/observability/metrics/reference
[55] https://private.docs.cohere.com/docs/observability/traces/reference
[56] https://private.docs.cohere.com/docs/backup-restore
[57] https://private.docs.cohere.com/docs/model-vault-with-north
[81] https://private.docs.cohere.com/docs/platform-requirements
[82] https://private.docs.cohere.com/docs/compute-requirements
[83] https://private.docs.cohere.com/docs/storage-requirements
[84] https://private.docs.cohere.com/docs/infrastructure-dependencies
[85] https://private.docs.cohere.com/docs/networking-requirements
[86] https://private.docs.cohere.com/docs/install/helm
[87] https://private.docs.cohere.com/docs/install/upgrade
[88] https://private.docs.cohere.com/docs/install/rollback
[89] https://private.docs.cohere.com/docs/install/verify-image-signatures
[90] https://private.docs.cohere.com/docs/fips-compliant-images

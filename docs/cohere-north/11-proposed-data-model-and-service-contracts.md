# Proposed data model, service contracts, and event model

> **Historical design proposal — 2026-08-22.** These requirements describe
> a possible North-equivalent rebuild, not an accepted Borealis roadmap or its
> implemented architecture. See the [archive overview](README.md),
> [current Borealis docs](../../README.md), and
> [completed implementation plans](../../plans/README.md).

**Status:** independent clean-room architecture proposal<br>
**Source of public object semantics:** published North OpenAPI and user/admin documentation<br>
**Not a claim about Cohere's private database or service design**

## 1. Domain boundaries

| Domain | Owns | Does not own |
|---|---|---|
| Identity | organizations, principals, memberships, sessions | resource permissions |
| Policy | roles, relations, policies, approvals, decisions | source content |
| Agents | definitions, versions, starters, evaluation definitions | conversations/runs |
| Chat | conversations, messages, stream/background tasks | source originals |
| Knowledge | files/versions, sources/connections, libraries, segments, citations | model inference |
| Tools | MCP servers/tools/resources/prompts, credentials metadata, calls | secret plaintext in DB |
| Workflows | definitions/versions/schedules, runs/nodes/reviews | rendered artifact bytes |
| Artifacts | documents/tables/reports/charts/exports/shares | source authorization truth |
| Models | profiles, providers, deployments, capabilities, usage | provider secrets in product rows |
| Operations | notifications, audit, usage, outbox, system status | user content by default |

## 2. Global conventions

- UUIDv7/ULID-style opaque IDs; never sequential public IDs.
- `organization_id` on every tenant-owned table and tenant-aware foreign keys.
- UTC timestamps with explicit display timezone.
- Soft delete plus lifecycle state only where retention/grace requires it; unique constraints account for deleted rows.
- Immutable version rows for source, agent, workflow, artifact, policy, and model configuration.
- Optimistic concurrency with `revision`/ETag for editable resources.
- Append-only events for messages, runs, approvals, audits, and usage.
- JSON only for extensible typed configuration; core query/constraint fields remain relational.
- Large/private content in encrypted object storage, referenced by opaque object IDs.
- Transactional outbox for every state change that triggers asynchronous work.
- Standard error/request/trace envelope matching the public contract where interoperating.[11]

## 3. Core tables

### 3.1 Identity

```text
organizations(id, slug, name, status, settings_revision, created_at)
principals(id, organization_id, kind[user|service], external_issuer, external_subject,
           email, display_name, status, created_at, last_login_at)
groups(id, organization_id, external_id, name, status, last_reconciled_at)
group_memberships(group_id, principal_id, source_revision, valid_from, valid_to)
sessions(id, principal_id, token_hash, expires_at, revoked_at, client_metadata)
```

Unique identity key: `(organization_id, external_issuer, external_subject)`. Email is mutable display/contact data.

### 3.2 Policy

```text
roles(id, organization_id, key, name, system, revision)
permissions(key, description, risk_class)
role_permissions(role_id, permission_key)
role_bindings(role_id, principal_type, principal_id, valid_from, valid_to)
relation_tuples(object_type, object_id, relation, subject_type, subject_id, revision)
policies(id, organization_id, type, version, document, status)
policy_decisions(id, request_id, actor_id, action, resource, policy_revision,
                 decision, reason_codes, created_at)
approval_requests(id, organization_id, actor_id, scope, proposal_hash, payload_ref,
                  status, expires_at, resolved_by, resolved_at)
```

### 3.3 Agents and evaluations

```text
agent_definitions(id, organization_id, owner_id, name, description, status,
                  draft_version_id, live_version_id, created_at, updated_at)
agent_versions(id, definition_id, semver, state[draft|published], config_json,
               config_hash, version_notes, restored_from_id, created_by,
               created_at, published_at)
agent_grants(agent_id, principal_type, principal_id, role)
evaluation_tasks(id, agent_id, name, description, judge_profile_id, status)
evaluation_cases(id, task_id, title, prompt_ref, criteria_json, ordinal)
evaluation_runs(id, agent_id, agent_version_id, draft_hash, status, runner_id,
                started_at, completed_at, usage_json)
evaluation_results(id, run_id, case_id, response_ref, criterion_results,
                   status, error)
```

`config_json` schema includes model profile, instructions, capability IDs, source/library bindings, tool IDs/policies, starters, visibility intent, and platform-preamble mode.

### 3.4 Chat

```text
conversations(id, organization_id, owner_id, agent_id, agent_version_id,
              title, title_source, type, status, retention_class,
              created_at, updated_at, deleted_at)
conversation_members(conversation_id, principal_id, role)
messages(id, conversation_id, sequence, role, status, content_ref,
         model_run_id, created_at, completed_at)
message_parts(id, message_id, ordinal, type, payload_json, object_ref)
background_tasks(id, conversation_id, message_id, type, status,
                 workflow_ref, created_at, completed_at, error_json)
conversation_files(conversation_id, file_id, file_version_id, attached_by, created_at)
```

Constraint: `(conversation_id, sequence)` unique. Message finalization is single-winner; retries create a new branch/run rather than mutating completed content.

### 3.5 Knowledge

```text
files(id, organization_id, owner_id, source_connection_id, upstream_id,
      display_name, media_type, size, current_version_id, status, deleted_at)
file_versions(id, file_id, ordinal, object_id, sha256, source_modified_at,
              parser_profile_id, parse_status, index_status, created_at)
segments(id, file_version_id, ordinal, locator_json, text_object_id,
         text_hash, language, modality, metadata_json)
sources(id, organization_id, type, name, state, maturity, config_json)
source_connections(id, source_id, principal_id, credential_ref, auth_state,
                   selected_scope_json, last_sync_at, status)
sync_jobs(id, connection_id, status, checkpoint_ref, counts_json,
          started_at, completed_at, error_json)
libraries(id, organization_id, owner_id, source_type, connection_id, name,
          description, status, visibility, last_sync_at)
library_items(library_id, item_type, item_id, upstream_id, status, ordinal)
library_grants(library_id, principal_type, principal_id, role)
citations(id, message_id, artifact_version_id, response_locator,
          source_version_id, segment_id, source_locator, snippet_ref,
          retrieval_event_id, access_decision_id)
```

### 3.6 Tools/MCP

```text
tool_servers(id, organization_id, key, name, transport, endpoint,
             auth_method, egress_class, manifest_hash, status, owner_id)
tools(id, server_id, name, description, input_schema, output_schema,
      effect_class, approval_policy, enabled, schema_hash)
tool_resources(id, server_id, uri, name, media_type, metadata_json)
tool_prompts(id, server_id, name, arguments_schema, content_template_ref)
credential_bindings(id, organization_id, principal_id, server_id,
                    secret_ref, scopes_json, expires_at, status)
tool_calls(id, organization_id, actor_id, conversation_id, run_id, node_run_id,
           tool_id, schema_hash, arguments_ref, proposal_hash, status,
           approval_id, idempotency_key, result_ref, started_at, completed_at)
```

No secret plaintext, OAuth refresh token, or provider key is stored in these rows.

### 3.7 Workflows

```text
workflow_definitions(id, organization_id, owner_id, name, description,
                     status, draft_version_id, live_version_id)
workflow_versions(id, definition_id, semver, state, graph_schema_version,
                  graph_ref, graph_hash, dependency_manifest,
                  input_schema, output_template, created_by, published_at)
workflow_grants(workflow_id, principal_type, principal_id, role)
schedules(id, workflow_id, version_policy, owner_id, timezone, cron,
          input_ref, state, failure_streak, next_fire_at, disabled_reason)
workflow_runs(id, workflow_id, workflow_version_id, trigger, runner_id,
              status, input_ref, output_artifact_id, usage_json,
              queued_at, started_at, completed_at, cancellation_requested_at)
node_runs(id, run_id, node_key, iteration_path, status, attempt_count,
          input_ref, output_ref, started_at, completed_at, error_json)
node_attempts(id, node_run_id, attempt, idempotency_key, dependencies_json,
              result_ref, usage_json, status, started_at, completed_at)
review_tasks(id, node_run_id, reviewer_instructions_ref, fields_schema,
             status, expires_at, response_ref, resolved_by, resolved_at)
```

### 3.8 Artifacts

```text
artifacts(id, organization_id, owner_id, type, title, status,
          conversation_id, workflow_run_id, current_version_id)
artifact_versions(id, artifact_id, ordinal, content_type, object_id, sha256,
                  author_type, author_id, model_run_id, base_version_id,
                  change_summary, created_at)
artifact_shares(id, artifact_version_id, principal_type, principal_id,
                token_hash, expires_at, revoked_at, policy_json)
exports(id, artifact_version_id, format, status, object_id, sha256,
        renderer_version, created_at, completed_at, error_json)
tables(id, artifact_id, schema_revision)
table_columns(id, table_id, ordinal, name, type, config_json, config_hash)
table_rows(id, table_id, ordinal, revision)
table_cells(row_id, column_id, value_ref, status, dependency_hash,
            generated_by_run_id, reviewed_by, reviewed_at, stale_reason)
```

### 3.9 Models and operations

```text
model_providers(id, organization_id, type, endpoint, secret_ref, status)
model_profiles(id, organization_id, provider_id, model_name, revision,
               capabilities_json, limits_json, license_json, egress_class, status)
model_deployments(id, profile_id, endpoint_ref, digest, status, health_json)
usage_records(id, organization_id, principal_id, model_profile_id,
              conversation_id, run_id, input_tokens, output_tokens, latency_ms,
              created_at)
notifications(id, principal_id, type, resource_ref, status, created_at, read_at)
audit_events(id, organization_id, sequence, actor_ref, action, resource_ref,
             outcome, policy_decision_id, request_id, trace_id, prev_hash,
             event_hash, created_at)
outbox_events(id, aggregate_type, aggregate_id, event_type, payload_ref,
              status, attempts, available_at, created_at)
```

## 4. External REST contract

The published North API currently exposes agents, conversations/messages/files/background tasks, files, libraries/local libraries, automations/executions/reviews, models, users/auth/OAuth, permissions/audits, MCP administration, Chat, and Responses. The exact 107-operation inventory is in [`09-public-api-and-object-model.md`](09-public-api-and-object-model.md).[11]

### 4.1 REST conventions

- Base version in path; resource nouns plural.
- Cursor pagination (`after`, `limit`) and deterministic `order`.
- ETag/`If-Match` for updates and publish/restore operations.
- `Idempotency-Key` for create, execute, upload session, tool action, and review submission.
- `X-Request-ID` accepted/generated and W3C `traceparent` propagated.
- Standard non-2xx error envelope.
- `202 Accepted` + job/task location for asynchronous mutations.
- Explicit content-disposition/media type/hash for downloads.
- Bulk operations return per-item success/failure/skipped outcomes.

### 4.2 Standard error

```json
{
  "error_type": "invalid_request_error",
  "error_code": "STABLE_MACHINE_CODE",
  "message": "Safe explanation for the user",
  "request_id": "req_...",
  "trace_id": "...",
  "status_code": 400,
  "is_retryable": false,
  "details": {"field_errors": []}
}
```

## 5. SSE event contract

```text
id: monotonically unique event ID
retry: optional reconnect hint

event: response.created
data: {response_id, conversation_id, message_id, background_task_id?}

event: output_text.delta
data: {message_id, part_id, index, delta}

event: citation.added
data: {message_id, citation}

event: execution.summary
data: {run_id, step_id, status, safe_summary}

event: tool_call.created
... arguments_delta | waiting_approval | completed | failed

event: artifact.created
data: {artifact_id, version_id, type, title}

event: usage.updated
data: {input_tokens, output_tokens}

event: response.completed | response.failed | response.cancelled
data: {response_id, message_id, finish_reason?, error?}
```

Reducer invariants:

- duplicate event IDs are ignored;
- deltas apply only to matching open part;
- one terminal event per response;
- terminal state is persisted before/atomically with terminal emission;
- reconnect can resume from `Last-Event-ID` or retrieve canonical message/task state;
- errors use the same core fields as REST;
- no raw hidden chain-of-thought event.

## 6. Internal commands/events

### 6.1 Command envelope

```json
{
  "command_id": "...",
  "organization_id": "...",
  "actor": {"type": "user", "id": "..."},
  "type": "workflow.run.requested",
  "aggregate": {"type": "workflow", "id": "...", "revision": 7},
  "payload_ref": "obj_...",
  "idempotency_key": "...",
  "request_id": "...",
  "traceparent": "...",
  "created_at": "..."
}
```

### 6.2 Domain events

- `file.uploaded`, `file.parsed`, `file.indexed`, `file.failed`, `file.deleted`;
- `connection.authorized`, `connection.expired`, `sync.started/completed/partial/failed`;
- `agent.draft_saved`, `agent.version_published`, `agent.grant_changed`;
- `conversation.message_submitted/completed`, `background_task.terminal`;
- `workflow.version_published`, `run.state_changed`, `node.attempt_completed`;
- `review.opened/completed/expired`;
- `approval.requested/resolved`;
- `artifact.version_created`, `export.completed`;
- `policy.changed`, `credential.revoked`, `model.status_changed`.

Outbox publish is at-least-once; consumers are idempotent using event/aggregate revision. Events contain references/hashes, not sensitive content.

## 7. Service APIs

### Retrieval

```text
retrieve(query, principal, scope, filters, budget) -> hits + retrieval_event_id
resolve_citation(citation_id, principal) -> authorized preview/download locator
index(file_version_id) -> job
remove_source_version(version_id) -> job
```

### Model gateway

```text
chat_stream(model_profile, messages, tools, response_format, budgets)
embed(profile, texts)
rerank(profile, query, documents)
health/profile_capabilities
```

### Tool gateway

```text
list_entitled_servers_tools(principal, context)
invoke(tool_id, validated_arguments, actor, context, idempotency_key)
resume_after_approval(call_id, approval_id)
refresh_manifest(server_id)
```

### Artifact

```text
create_document(base, lineage)
propose_rewrite(version, selection, instruction)
apply_rewrite(base_hash, patch)
render_export(version, format)
```

## 8. Consistency and transactions

- Publish agent/workflow: version row + live pointer + outbox in one transaction.
- Message submit: message row + background/agent workflow start intent + outbox in one transaction.
- Tool action: proposal + approval link before invocation; terminal result + event atomically projected.
- Review: compare-and-swap open → completed; one winner.
- File deletion: access tombstone synchronously; derivative purge asynchronously.
- Authorization grant change: tuple/model revision updated before related caches are invalidated.

No distributed two-phase commit. Use durable workflows, idempotency, reconciliation, and compensating actions.

## 9. Migration and compatibility

- Every JSON graph/config/event has `schema_version`.
- API versions evolve independently from storage schema.
- Readers support current + bounded previous versions; writers emit current.
- Imported workflow/agent bundles pass explicit migrations and dependency mapping.
- Model/tool/source capability drift never mutates immutable published versions.
- Backfills are resumable, checkpointed, rate-limited, and tenant-aware.

## 10. Privacy classifications

| Class | Examples | Storage/logging |
|---|---|---|
| Secret | OAuth refresh token, provider key, encryption key | secret manager only; never event/log/model |
| Restricted content | prompts, messages, files, memory, review input | encrypted object/column; strict access; no general telemetry |
| Sensitive metadata | filenames, source URIs, user email, tool args | encrypted/limited; redacted logs |
| Operational metadata | IDs, state, duration, token count | telemetry/audit with tenant/access controls |
| Public configuration | capability description, schema | ordinary DB/cache |

## 11. Test invariants

- Every tenant table/query has organization scoping tests.
- Every async consumer is replay-safe and idempotent.
- Published versions and completed runs are immutable.
- Citation/source/artifact version references remain resolvable or fail with explicit lifecycle state.
- No secret/restricted content appears in outbox headers, search attributes, metrics, logs, or traces.
- Approval/review CAS prevents duplicate side effects/submissions.
- Stream replay/reconnect yields the same canonical completed message.
- Deletion tombstone blocks access before derivative purge completes.
- Migration from every supported schema version passes round-trip fixtures.

## Sources

[11] https://private.docs.cohere.com/openapi/north.yaml

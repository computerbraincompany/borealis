# Automations, workflow execution, testing, and human review

**Status:** reconstruction-ready workflow specification<br>
**Evidence date:** 2026-08-22

## 1. Product surfaces

The Automations application separates four concerns:

| Tab | Purpose |
|---|---|
| Discovery | Find runnable owned/shared/public workflows and inspect requirements. |
| Runs | Active, scheduled, and completed runs for the current user. |
| My builds | Draft/published automation definitions owned by the builder. |
| Monitor | Builder/operator view across runs, including status, runner, duration, and token totals. |

The documented runner panel shows name, description, owner, tools, required connections, required/defaulted inputs, ordered tasks, previous runs, and live version metadata before execution.[32]

## 2. Definition model

```text
WorkflowDefinition
- id, organization_id, owner_id
- name, description, visibility
- draft_version_id, live_version_id
- created_at, updated_at, archived_at

WorkflowVersion
- id, workflow_definition_id
- semver, version_type, version_notes
- graph_schema_version
- graph_spec, input_schema, output_template
- dependency_manifest
- display_properties
- created_by, created_at, published_at

WorkflowNode
- stable node key, type, name, position
- config, advanced_config
- input bindings, output schema
- source/tool/model/agent dependencies

WorkflowEdge
- source node/port, target node/port
- branch key, display metadata
```

A draft autosaves but is not runnable by other users until publication. First and later releases use semantic Major/Minor/Patch versions and notes. History presents live, past, and draft states; restoring a prior version replaces the current draft and requires republishing before it becomes live.[31]

## 3. Builder UX

### 3.1 Canvas and control panel

- Add the first node centrally; later nodes from a persistent add control.
- Drag/connect nodes and ports; validate acyclicity except for explicit Loop containers.
- `@` opens a typed variable picker for workflow inputs, connected upstream outputs, files, and libraries.
- Nodes may reference multiple upstream nodes only when connected directly or transitively.
- Auto-layout can rearrange the graph and is undoable.
- The final output is a deterministic Markdown template that can reference inputs and node outputs; formatting does not invoke an LLM.[28]

The public image set includes an LLM node with **Configure**, **Advanced**, and **Testing** tabs; see [`screenshots/automation-builder-node.png`](screenshots/automation-builder-node.png).[6]

### 3.2 Definition validation

Publishing and testing are blocked when:

- no node exists;
- nodes are not connected into one valid flow;
- workflow name is missing;
- prompts/models/system settings are incomplete;
- node configuration is invalid;
- files/libraries are deleted or inaccessible;
- model/tool/agent dependencies cannot be resolved;
- source/tool permissions are inconsistent.

The vendor docs describe an optional AI assistant that can attempt fixes, but manual correction remains available.[31]

**Open implementation rule:** an AI assistant may propose a patch to the graph; the builder must review a structured diff before it is applied.

## 4. Node types

North currently documents component nodes (**LLM**, **Agent**) and behavior nodes (**Conditional**, **Human review**, **Loop**).[28]

### 4.1 LLM node

| Section | Fields/behavior |
|---|---|
| Configure | Instructions; My Files/libraries; tools; model; unstructured or structured output. |
| Advanced | Max output tokens; temperature; retries; default value on failure. |
| Testing | Prompt/input validation, output, timing, tokens, streamed output when enabled. |
| Security | Tools run with the workflow runner's permissions. |

After retry exhaustion, a configured default value can satisfy every declared output and permit downstream nodes to continue. Without it, the node/run fails. Admin settings cap retries.[28]

### 4.2 Agent node

- Select exactly one personal/shared/company agent.
- Add step-specific instructions.
- Choose unstructured or structured output.
- Configure max tokens, retries, and failure defaults.
- Inherited model/tools are read-only in the workflow builder; temperature is not editable there.
- Agent attachments are inherited and view-only.[28]

A published workflow must pin an immutable agent version, or explicitly choose a controlled “follow live” policy with revalidation. Silent drift to a new agent release is unsafe.

### 4.3 Structured outputs

LLM and Agent nodes support plain text or structured fields. The visual schema editor documents field name, description, Text/Number/Boolean type, required flag, regex pattern, format such as Date/UUID, and allowed values; raw JSON Schema editing is also supported.[28]

Required engine behavior:

- compile schema at publish time;
- validate every attempt;
- distinguish model/schema failure from infrastructure/tool failure;
- repair only within bounded attempts;
- keep raw model output for authorized debugging but never substitute it for a failed validated output;
- ensure fallback/default values also validate.

### 4.4 Conditional node

- Up to six configured branches plus an Else path.
- Multiple conditions joined with And/Or.
- Inputs come from workflow inputs or connected upstream outputs.
- Text comparisons are case-sensitive in the documented behavior.
- Type-specific operators cover equality/inequality, contains/prefix/suffix/regex/empty, numeric ordering, date ordering, and select membership.[28]

Only the first matching branch should run; Else runs when none match. Record the evaluated expression and branch decision without logging sensitive values into general audit.

### 4.5 Loop node

| Loop | Behavior |
|---|---|
| For Each | Iterate over an input/upstream/custom list; expose current item, iteration number, and last-iteration output; optionally parallelize independent iterations. |
| Do While | Execute body then re-evaluate a typed condition; expose iteration and last output. |

A loop exposes one chosen interior node's last value downstream. Do While defaults to an admin-configured maximum of 100 iterations when unset and accepts a documented range of 2–1000; exceeding the limit fails the test/run.[28]

Open implementation controls must add maximum parallelism, per-iteration timeout, aggregate token/cost budget, maximum list size, cancellation fan-out, output-size limit, and deterministic iteration ordering.

### 4.6 Human review node

- Reviewer instructions.
- Ordered required/optional fields.
- Text, Files (documents/images, optional multiple), and Single Select fields.
- In-app and/or tool-call notification configuration.
- Review timeout with admin maximum.
- Testing tab and Action required state.[29]

## 5. Tool, source, and sandbox use

LLM nodes use the same Capability/Source/Custom grouping as Chat. Builders may attach an entire MCP server or a subset of tools. Tool maturity labels are visible. Action-taking tools can be used, but require explicit warning/approval semantics.[28][32]

Code sandbox sessions launched by automation nodes are separate from any sandbox attached to the conversation that triggered the workflow; state/files do not carry across that boundary.[28]

**Execution rule:** credentials and permissions belong to the runner or schedule owner, not the builder. Resolve every model, agent, library, source, and tool before run start and again before effectful invocation.

## 6. Runtime data model

```text
WorkflowRun
- id, workflow_definition_id, workflow_version_id
- trigger: manual | scheduled | api | nested
- runner_id / service_principal_id
- status: queued | running | waiting_review | succeeded | failed | cancelled
- input_snapshot, output_artifact_id
- started_at, completed_at, duration
- input_tokens, output_tokens
- cancellation_requested_at

NodeRun
- id, workflow_run_id, node_key, iteration_path
- status, attempt_count
- resolved model/agent/tool/source versions
- input refs, validated output ref
- started_at, completed_at, error
- succeeded_after_retry

NodeAttempt
- attempt number, idempotency key
- model/tool requests and safe summaries
- usage, latency, error class, retry decision
```

## 7. Execution semantics

1. Load an immutable published workflow version.
2. Resolve dependencies and runner permissions.
3. Validate/coerce required and optional/default inputs.
4. Create run and planned node instances.
5. Enqueue ready nodes in dependency order.
6. Execute with bounded retry by error class; never retry unsafe side effects without idempotency support.
7. Validate outputs; store immutable node evidence.
8. Evaluate branches/loops and enqueue newly ready nodes.
9. Pause on Human review and emit notifications.
10. Render the final output template and create referenced files/artifacts.
11. Atomically finalize run state and metrics.
12. Make cancellation idempotent and propagate to queued/running child work.

## 8. Testing semantics

North documents node-level tests that cache upstream outputs for the current builder session. Downstream tests reuse those outputs; leaving the builder clears them; modifying an upstream dependency invalidates affected cache and causes re-execution; builders can clear cached output manually. Full-graph tests use the main Test control. Results include pass/fail, duration, and tokens, with optional streaming.[30]

Implement test caching with this key:

```text
hash(
  workflow_draft_revision,
  node_key,
  transitive_upstream_configuration_hash,
  test_inputs_hash,
  dependency_manifest_hash,
  runner_permission_snapshot
)
```

Never reuse cached output after relevant source, tool, model, agent, prompt, input, or permission changes.

## 9. Human review lifecycle

```text
NodeRun running
  → ReviewTask open
  → WorkflowRun waiting_review
       ├─ submit valid fields once → ReviewTask completed → run resumes
       ├─ timeout → ReviewTask expired → run fails
       ├─ cancel run → ReviewTask cancelled
       └─ access revoked → submission denied; task remains/gets reassigned by policy
```

Each execution creates a unique review page URL. The documented access rule requires both the URL and View permission on the automation; in-app notification goes to the runner, while tool-call notifications may distribute the review URL.[29]

### 9.1 Stronger open implementation

- Use high-entropy, expiring opaque IDs, not bearer access by URL alone.
- Recheck organization, View, and review-submit permissions at load and submit.
- Allow explicit reviewer principals/groups and optional separation-of-duties policies.
- Lock a task with optimistic concurrency; one terminal submission wins.
- Virus-scan/file-type/size-check review uploads.
- Make approval/rejection values typed and reusable by downstream conditional nodes.
- Record reviewer, timestamp, supplied field hashes, and exact workflow/node version.
- Never allow the workflow builder to self-approve through a tool call unless policy explicitly authorizes a service principal.

## 10. Discovery, execution, and schedules

The runner sees required connections and authenticates before use. Launch surfaces action-taking connectors with a warning. A run blocks when the runner lacks the underlying model. Runs are cancellable and inspectable by task inputs/outputs; completion/failure/HITL can notify the user.[32]

Scheduling supports presets and manual cron. Required inputs must be filled before scheduling. The documented product automatically disables schedules when required inputs change, a model/provider disappears, a required tool becomes inaccessible, or recent scheduled runs repeatedly fail; the default consecutive-failure threshold is five. Reactivation follows remediation.[32]

Schedule records must pin timezone, daylight-saving policy, exact workflow version policy, owner/service identity, credential health, input snapshot, overlap policy, missed-run policy, maximum duration, and failure streak.

## 11. Versioning, visibility, import/export

Visibility is Private, Limited, or Public/organization-discoverable. My builds states are Draft, Up-to-date, or Modified. Import/export includes schema version, export timestamp, metadata, publication state, graph, inputs, output template, and dependency manifest; it excludes IDs, creator, execution history, schedules, and timestamps from the source instance.[31]

Before import:

- validate JSON schema and supported version;
- block prototype pollution/path traversal/oversized graphs;
- require explicit mapping for unavailable models/tools/providers/agents;
- strip credentials, tokens, object URLs, and organization-specific secrets;
- create a new local identity and unpublished draft;
- produce a dependency and permission diff before publication.

## 12. Monitoring and observability

The documented monitor list includes automation, state, started timestamp, runner, duration, aggregate input tokens, and aggregate output tokens.[31]

Add:

- queue delay, node critical path, retries/fallbacks, review wait time;
- per-node model/tool latency and usage;
- cancellation propagation time;
- failure class and retryability;
- schedule health and consecutive failures;
- stuck-run detection;
- content-free trace links and downloadable authorized evidence.

## 13. Public API coverage

The published API lists/gets/executes automations and lists/gets/cancels executions. It can retrieve a node, fetch output files, retrieve a human-review task, and submit review input.[11]

Minimum idempotency requirements:

- execution create accepts an idempotency key;
- cancel is safe on every terminal state;
- review submission returns conflict after terminal completion;
- file downloads are authorization-checked and immutable per run;
- execution list is cursor-paginated and filterable by workflow, runner, trigger, status, and time.

## 14. Acceptance tests

- Draft edits never change an in-flight or already completed run.
- Publishing rejects disconnected nodes and inaccessible dependencies.
- Runner—not builder—permissions govern every tool/source/model invocation.
- Retrying an effectful tool does not duplicate the external action.
- Changing an upstream node invalidates every affected node-test cache.
- Loop limits, token budgets, and cancellation stop all child work.
- Review submission is authenticated, single-winner, typed, and timeout-safe.
- A schedule disables on missing dependencies and reactivates only after validation.
- Import strips credentials and produces an unpublished draft.
- Run output remains tied to exact workflow, agent, model, tool, source, and policy versions.

## Sources

[6] https://cohere.com/north/agent-studio
[11] https://private.docs.cohere.com/openapi/north.yaml
[28] https://private.docs.cohere.com/docs/get-started/north-automations/building-automations/configuring-automation-nodes
[29] https://private.docs.cohere.com/docs/get-started/north-automations/building-automations/human-in-the-loop-automations
[30] https://private.docs.cohere.com/docs/get-started/north-automations/building-automations/testing-automations
[31] https://private.docs.cohere.com/docs/get-started/north-automations/building-automations/saving-publishing-monitoring-automations
[32] https://private.docs.cohere.com/docs/get-started/north-automations/consuming-automations

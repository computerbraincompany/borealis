# Chat, agents, memory, citations, and evaluation

**Status:** reconstruction-ready functional requirements<br>
**Evidence date:** 2026-08-22

## 1. Chat surface

North's documented chat is multimodal and source-grounded. Users can summarize, draft/refine content, conduct web/enterprise research, chat with documents, analyze data, and work with images when an entitled vision model is available.[13]

### 1.1 Entry points

- Home's central chat bar.
- New Chat in the sidebar.
- New chat from an active conversation.
- New chat beside an agent in history.
- Conversation starters displayed for a selected custom agent.
- Agent cards in the agent library.

### 1.2 Composer controls

| Control | Required behavior |
|---|---|
| Text input | Multiline input; paste; keyboard submission; cancel while streaming. |
| Plus/attachment | Upload or select files; show indexing/readiness and removal. |
| `@` mention | Search previously uploaded files or add from My Files; preserve a structured file reference, not just display text. |
| Large paste | Collapse 1,000+ pasted characters into an editable/removable snippet chip. |
| Model selector | Available for the default agent; expose model and optional reasoning state; custom-agent model comes from agent configuration. |
| Tools menu | Three groups: Capabilities, Sources, Custom/MCP; allow per-conversation selection and visible removal. |
| Active chips | Show selected files/sources/tools and hover/expanded previews. |
| Send/cancel | Transition from idle to submitting/streaming/background; cancellation must be idempotent. |

The documented interface previews attached/selected sources, renders files under 2 MB in-app when supported, falls back to download for large/unsupported files, remembers sidebar state, and exposes language, settings, feedback, terms, developer, and admin destinations according to role.[13]

### 1.3 Message actions

- retry/regenerate;
- positive and negative feedback;
- copy;
- open a generated document/canvas;
- inspect citations and execution/tool trace;
- download supported rendered visualizations as standalone HTML or PDF.[13]

### 1.4 Background execution and notifications

Long prompts and deep-research work may continue after navigation. A background task needs a stable identifier, owning conversation, status, cancellation route, started/completed timestamps, error, and completion notification. The inbox separates read/unread notifications and user preferences control delivery.[13][18]

Recommended state model:

```text
message accepted
  ├─ foreground stream → completed | failed | cancelled
  └─ background task → queued → running → completed | failed | cancelled
                                      └─ emit notification + deep link
```

## 2. Conversation model

Minimum durable fields:

```text
Conversation
- id, organization_id, owner_id
- agent_definition_id, agent_version_id
- title, title_source, type
- selected_model_profile_id
- selected_capability_ids
- selected_source_bindings
- selected_tool_bindings
- created_at, updated_at, last_activity_at
- status, retention_class, deleted_at

Message
- id, conversation_id, role, sequence
- content parts (text, image, file reference, tool call/result, artifact reference)
- model/run metadata
- citations[]
- execution_trace_summary[]
- usage, finish_reason, error
- created_at
```

Conversations support list/search, rename/title generation, retrieve, delete, message retrieval, file listing, and background tasks in the published API.[11]

## 3. Citation experience and data contract

North documents citations from uploaded files, connected company sources, web results, and MCP/custom tools.[15]

### 3.1 Chat behavior

- Claims with evidence are underlined.
- Hovering a source highlights the corresponding response span.
- Clicking a claim opens a source side panel scoped to that claim.
- A Citations pill under the answer shows a count and source-site icons.
- “Show all” displays every source associated with the response.
- The side panel can be collapsed without losing conversation position.[15]

### 3.2 Document behavior

- Citation pills appear at paragraph ends.
- Hover preview supports multiple sources with next/previous navigation.
- Response text highlights move as the selected source changes.
- The UI remembers which source in a pill was last viewed.
- Clicking a title/pill opens the source where supported.
- File previews and Data Interpreter outputs use source-appropriate viewers; Document Mode does not expose the same expansion control.[15]

### 3.3 Required citation object

```text
Citation
- id
- message_id / artifact_version_id
- response_start, response_end
- source_type
- source_id, source_version_id
- source_title, source_uri
- source_start, source_end or page/section/cell coordinates
- snippet
- retrieval_event_id
- tool_call_id (optional)
- access_snapshot_id
- created_at
```

A citation must be rejected if its response span or source locator is invalid. Authorization is rechecked before preview/open; a shared answer cannot become a data-exfiltration path. Frozen evidence snapshots should be explicit artifacts rather than silently bypassing live permissions.

## 4. Execution trace

The public UI describes an expandable “thinking trace” with planning summaries, tool calls/inputs, search/tool results, nested source lists, and possibly multiple planning/tool rounds. It also documents editing a trace step and regenerating the response.[15]

**Clean-room safety decision:** do not expose hidden chain-of-thought or raw confidential prompts. Implement an **execution trace** containing safe, generated summaries of plans, validated tool calls, resource references, result summaries, timings, citations, retries, and policy decisions. If users edit a step, treat it as a new explicit instruction or plan node and create a new run lineage; never mutate an immutable historical trace.

## 5. Agent types

### 5.1 Default/personal agent

- one private default agent per user;
- used by the central Home composer;
- has access to the user's connected data sources subject to permissions;
- can change model and personal instructions;
- is not shareable;
- changes apply immediately;
- no draft/version history and no evaluation support.[23][25]

### 5.2 Custom agent

- requires create-agent permission;
- name, description, model, model capability tags, Markdown instructions;
- optional override/disregard of platform instructions only when admin-enabled;
- up to four conversation starters;
- built-in capabilities, selected sources/libraries, and custom/MCP tools;
- visibility: private, selected users, or organization-wide when authorized;
- live one-off preview;
- autosaved draft, semantic published versions, notes, history, restore, share, and evaluations.[24]

## 6. Agent builder UX

Recommended route composition:

```text
/agents                       gallery: discover / starred / mine / shared
/agents/new                   create draft
/agents/:id/build             configuration + live preview
/agents/:id/evaluate          tasks + runs
/agents/:id/history           draft + published versions
/agents/:id/share             visibility and principals
```

### 6.1 Build sections

1. **Basics:** name, description, avatar/color owned by the rebuild, conversation starters.
2. **Model:** approved model profile; capability/compatibility badges; reasoning/vision constraints.
3. **Instructions:** Markdown editor, template variables, platform-policy inheritance, token/size validation.
4. **Capabilities:** data interpreter, web search, document, table, deep research, conversation history, or other enabled platform capabilities.
5. **Sources:** personal files/libraries and connector resource selection.
6. **Tools:** entitled MCP/tool selection; per-tool read/action classification.
7. **Access:** visibility, principals/groups, owner, organization publication policy.
8. **Preview:** isolated one-off chat; clear data/action warnings.
9. **Evaluate:** repeatable evaluation tasks and run results.

The public screenshots show a creation form organized around Basics, Tools, and Access, plus agent chat paired with document/table/report outputs; see [`screenshots/README.md`](screenshots/README.md).[6]

## 7. Agent versioning

```text
AgentDefinition
- stable identity, owner, organization, status
- live_version_id, draft_version_id

AgentVersion
- semver, version_type, version_notes
- immutable configuration snapshot
- evaluation_snapshot_id
- created_by, created_at, published_at
- restored_from_version_id
```

Rules:

- First publication creates `v1.0.0`.
- Subsequent publish chooses Major/Minor/Patch and records notes.
- Draft changes do not affect consumers until publish.
- History opens past versions read-only; restore replaces the current draft, not the live version.
- Restored configuration becomes live only after publication.
- Discarding/restoring a draft must require explicit confirmation.
- Sharing remains unavailable until first publication.[24]

## 8. Evaluation system

Agent evaluations are documented as Alpha. They run repeatable pass/fail tasks against the **current draft**, while the Build preview remains a one-off conversation. Evaluation state is preserved with a published version, but duplicating an agent does not duplicate evaluation history.[25]

### 8.1 Objects

```text
EvaluationTask
- id, agent_definition_id, name, description
- judge_model_profile_id
- grading_method = llm_as_judge
- score_type = pass_fail

EvaluationCase
- id, task_id, title, prompt
- success_criteria[]

EvaluationRun
- id, task/version/draft snapshot
- status: queued | running | completed | failed | cancelled | error
- runner, timestamps, duration, token usage

EvaluationCaseResult
- response snapshot
- criterion outcomes[]
- judge reasoning summary
- agent usage, judge usage, status/error
```

### 8.2 Rules

- Only owner or organization admin can author/run evaluations.
- Feature flag, create-agent permission, ownership/admin role, and a saved draft are prerequisites.
- A case passes only when all criteria pass.
- Runs are cancellable and re-runnable against the current draft.
- Normal chat history does not include hidden evaluation conversations.
- An action-taking tool that waits for interactive approval produces an evaluation Error because the run cannot pause for that approval.[25]

### 8.3 Open implementation improvements

- Add deterministic graders (JSON schema, regex, exact/set match, Python assertions, retrieval/citation coverage) alongside LLM judges.
- Pin judge model/version/prompt and store a reproducible evaluation snapshot.
- Treat judge reasoning as an explanation, not ground truth.
- Add aggregate pass rate, variance, cost/latency, baseline comparison, and release gate policy.
- Sandbox tool use and disable external mutations by default.

## 9. Data-access semantics for shared agents

North documents three materially different behaviors:

1. **Google Drive/SharePoint:** effective scope is the intersection of the agent's configured source scope and the current user's native permissions; sharing the agent does not broaden data access.[24]
2. **My Files attached to an agent:** attached files become accessible to everyone who can access the shared agent; they do not retain per-recipient source ACLs in that mode.[24]
3. **Configured model:** consumers may use the agent owner's configured model entitlement for that agent; an explicit user model override is checked against the user's own entitlement. Revoking the owner's model access disables the shared agent for everyone.[24]

**Recommended independent policy:** avoid implicit owner-entitlement inheritance. Evaluate data, model, and tool entitlement for the current runner. If organization policy intentionally grants a model through a published agent, represent that as an explicit service entitlement on the published version. Attached personal files should require an explicit share/grant operation with recipient preview.

## 10. Memory

Memory is documented as Alpha and opt-in. North exposes three editable personal categories—Work context, Preferences, and Top of mind—each capped at 6,000 characters, plus per-agent archival memory that is not user-viewable/editable. Automatic extraction typically runs every 24 hours; edits are inputs to future synthesis and can be condensed or overwritten. Disabling offers Pause (retain but stop use/update) or Delete (permanent reset).[19]

### 10.1 Required open implementation controls

- disabled by default at organization and user levels;
- fully inspectable memory records with source conversation, extraction time, model, confidence, and expiry;
- user edit/delete and organization retention/deletion integration;
- strict organization/user/agent scope keys;
- no cross-user memory;
- pause means no read and no write;
- delete propagates to derived indexes and backups according to documented retention policy;
- archival memory should also be user-inspectable in an open implementation, or omitted until it can be governed transparently.

## 11. Acceptance tests

- A custom agent draft can be previewed but cannot be used by another user before first publication.
- Publishing v1.0.0 freezes configuration; later draft edits do not change active conversations.
- Restore replaces only the draft until republished.
- Drive/SharePoint retrieval is denied when the runner lacks the native source grant.
- Citation click rechecks authorization and resolves the exact source span.
- A message stream can become a background task and notifies exactly once on terminal state.
- Evaluation actions requiring approval fail safely without mutating the external system.
- Deleting all personal memory prevents future prompts from retrieving the deleted text.
- Raw hidden reasoning is never persisted or displayed; safe execution summaries are reproducible from events.

## Sources

[6] https://cohere.com/north/agent-studio
[11] https://private.docs.cohere.com/openapi/north.yaml
[13] https://private.docs.cohere.com/docs/get-started/north-chat
[15] https://private.docs.cohere.com/docs/get-started/using-citations
[18] https://private.docs.cohere.com/docs/get-started/notifications
[19] https://private.docs.cohere.com/docs/get-started/memory
[23] https://private.docs.cohere.com/docs/get-started/agents
[24] https://private.docs.cohere.com/docs/get-started/agents/creating-custom-agents
[25] https://private.docs.cohere.com/docs/get-started/agents/evaluating-agents

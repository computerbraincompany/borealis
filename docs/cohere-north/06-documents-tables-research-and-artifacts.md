# Documents, tables, research, code execution, and artifacts

> **Historical North research — captured 2026-08-22.** Vendor behavior,
> release labels, API inventories, and references below describe that capture,
> not the latest North release or the implemented Borealis product. See the
> [archive overview](README.md), [Borealis README](../../README.md), and
> [Borealis API reference](../API.md) for the distinction and current contracts.

**Status:** reconstruction-ready artifact/capability specification<br>
**Evidence date:** 2026-08-22

## 1. Unifying artifact model

North presents Document Mode, Tables, charts/visualizations, Deep Research reports, automation outputs, and sandbox-generated files as distinct experiences. An open implementation should share one durable artifact substrate:

```text
Artifact
- id, organization_id, owner_id
- type: document | table | chart | report | file | html
- title, status, visibility
- conversation_id / workflow_run_id
- current_version_id
- created_at, updated_at, deleted_at

ArtifactVersion
- id, artifact_id, ordinal
- content object/ref, media type, content hash
- created_by: user | agent | workflow | import
- model/run/tool/source lineage
- citations[], change summary
- created_at
```

This prevents generated output from becoming untracked chat decoration and gives documents, tables, and exports consistent retention, authorization, provenance, and versioning.

## 2. Document Mode

North documents a collaborative long-form editor activated as a Chat capability. Enabling it permits the agent to use a dedicated document-writer tool when a request calls for substantial content; it does not force every prompt into the editor. The mode retains uploaded files, web search, Data Interpreter, connected sources, MCP tools, and citations.[20]

### 2.1 Layout and interaction

- Conversation/chat pane and document editor visible together.
- Generation locks direct editing until the draft completes.
- Manual text editing after generation.
- Highlighted-selection AI rewrite with a targeted instruction.
- Whole-document instructions from chat.
- Suggested quick edits for format, length, tone, and translation.
- Embedded charts/visualizations created through Data Interpreter.
- Citation pills, source previews, and evidence linkage.
- Version dropdown, read-only history, and change comparison.
- Export and sharing controls.[20]

Public product images show agent chat beside outreach, due-diligence, and analysis documents; see [`screenshots/outreach-agent-document.png`](screenshots/outreach-agent-document.png) and [`screenshots/due-diligence-agent-report.png`](screenshots/due-diligence-agent-report.png).[6]

### 2.2 Version semantics

North creates a new document version for agent changes through chat or quick actions. Manual edits followed by Save do not create a new version in the documented behavior. Returning to an old version and editing creates a new current version; diff mode shows additions and deletions and is read-only.[20]

**Recommended divergence:** version both manual and agent edits. Coalesce keystrokes into explicit save/checkpoint revisions, record the author type, and allow a policy-controlled autosave timeline. Never make human edits less traceable than AI edits.

### 2.3 Rewrite protocol

```text
RewriteRequest
- artifact_version_id
- selection anchors or whole_document
- user instruction / quick action
- active agent/model/tool/source scope
- expected base hash

RewriteResult
- proposed operations or replacement
- citations and run lineage
- base hash, result hash
```

Use optimistic concurrency. If the base changed during generation, show a merge/diff instead of overwriting. For selected rewrites, preserve stable editor positions through structured document nodes, not brittle character offsets alone.

### 2.4 Export/share

The documented export formats are PDF, DOCX, HTML, TXT, Markdown, and Google Drive when connected. Sharing produces a read-only snapshot of the document and the conversation that led to it.[20]

Open implementation requirements:

- sanitize HTML and embedded content;
- deterministic server-side export with version/source metadata;
- no remote asset loads in sealed/private mode;
- explicit snapshot scope, expiry, revocation, and access policy;
- authorize every included citation/source or freeze approved evidence intentionally;
- retain export hash and generating artifact version.

## 3. Tables

Tables are documented as Alpha spreadsheet-like structured data where AI can populate columns using prompts that reference other columns, files, and tools. AI can run per cell, range, row selection, or column. Reviewed cells resist bulk overwrite and become outdated when referenced cells or prompt/tool/file configuration changes.[21]

### 3.1 Column types

- single-line text;
- long text;
- single select;
- multi-select;
- URL;
- file;
- number;
- date;
- checkbox.

AI cannot be enabled on the primary column or file columns. A configured AI column has prompt/instructions, cross-column references, file context, tools, model profile, and output type.[21]

### 3.2 Cell state machine

```text
empty/manual
  → queued → running → generated
                    ├─ failed
                    └─ cancelled

generated → reviewed
reviewed + dependency/config change → reviewed_stale
reviewed_stale → rerun → generated | mark_reviewed_again
```

Bulk runs must skip reviewed cells by default. An individual reviewed-cell rerun requires confirmation. Stop Queued Cells cancels only queued work; running work needs a separately defined cancellation policy.[21]

### 3.3 Dependency model

```text
TableColumn
- id, table_id, ordinal, name, type
- is_primary, ai_enabled
- prompt_template, output_schema
- model_profile_id, tool_bindings, file_bindings
- config_hash

TableCell
- row_id, column_id
- value, status, reviewed_at/by
- generated_by_run_id
- dependency_hash, stale_reason
- citations[]
```

`dependency_hash` should include referenced cell versions, prompt/model/tool/source configuration, and attached file versions. A mismatch marks the cell stale without deleting the reviewed output.

### 3.4 Execution requirements

- Work queue per cell with bounded organization/user/table concurrency.
- Deterministic dependency order; reject circular column references.
- Snapshot row inputs before execution.
- Validate typed output; preserve prior value until success.
- Per-cell trace, tool calls, citations, tokens, latency, and error.
- Bulk run preview with estimated cell count and policy/cost budget.
- Idempotent rerun and cancellation.
- CSV/XLSX import/export with formula-injection protection.

Public images show a trend-forecasting answer table and Revenue Analysis Agent beside a structured table; see [`screenshots/trend-forecasting-table.png`](screenshots/trend-forecasting-table.png) and [`screenshots/revenue-agent-table.png`](screenshots/revenue-agent-table.png).[5][6]

## 4. Deep Research

Deep Research is documented as Alpha and admin/permission gated. It decomposes complex work into subtasks, delegates to subagents, performs multiple query rounds, returns a citation-backed structured report, supports many enterprise/web/custom sources, exports PDF/DOCX/TXT/Markdown, notifies on completion, and may queue under load.[22]

### 4.1 Research-run model

```text
ResearchRun
- id, conversation_id, requester_id
- question, source policy, model/tool policy
- status: queued | planning | researching | synthesizing | completed | failed | cancelled
- plan version, subtask runs[]
- report_artifact_id
- usage/budget, timestamps, errors

ResearchEvidence
- query/subtask/tool call
- retrieved source version + locator
- claim/citation mapping
- dedup/conflict metadata
```

### 4.2 Open implementation controls

- User-visible plan and permitted source set before external research.
- Maximum subtask count, depth, source count, tokens, wall-clock time, and egress domains.
- Source deduplication and a fact-conflict ledger.
- Every load-bearing claim requires citation/evidence or an explicit unsupported marker.
- No autonomous effectful tools during research.
- Content sanitization and prompt-injection resistance for fetched pages/documents.
- Durable progress, cancellation, and resumable synthesis.
- Report generation from stored evidence, not hidden transient context.

## 5. Data Interpreter

Data Interpreter is documented as GA. It reads full CSV/XLS/XLSX cell contents from My Files and supported connected/email sources, performs calculation/filtering/charting, and generates downloadable files. The environment is temporary, session-based, network-disabled, uses a fixed library set (`pandas`, `numpy`, `openpyxl`, `matplotlib`, `seaborn`, standard library), and exposes generated code to the user.[72]

### 5.1 Distinguishing search and tabular execution

Regular document search sees spreadsheet metadata rather than row data in the documented flow; Data Interpreter processes row/cell contents. It does not handle PDF/Word/PowerPoint, which use standard document search.[66][72]

### 5.2 Execution contract

```text
DataSession
- id, principal/conversation scope
- mounted read-only inputs with version hashes
- fixed runtime image and library manifest
- no network
- CPU/memory/time/output limits

DataRun
- code, code hash, stdout/stderr
- generated files/charts
- source reads and citation locators
- status, timings, resource usage
```

Reject arbitrary package installs, network calls, native escapes, oversized outputs, formula injection, and host filesystem access. Generated code/output remains untrusted until rendered in a sandbox or downloaded with warnings.

## 6. Code Sandbox

Code Sandbox is documented as Alpha and broader than Data Interpreter: persistent Python REPL state within a conversation, interactive shell commands, package installation, files, and images. Runtime is ephemeral but session state persists. User-provided files, My Files, local-library files, and earlier MCP resources are mounted read-only; modified copies and generated files appear in a Sandbox Files panel. Optional network downloads are policy-filtered.[73]

### 6.1 UI

- **Attached by Me** and **Created by Agent** tabs.
- Name/size/updated time and search.
- Full My Files access warning when scope is broad.
- Expandable live activity showing code/commands and resources read.
- Citations for read/computed results.
- Separate sandbox sessions for automation agent nodes versus triggering conversations.[73]

### 6.2 Isolation requirements

- Dedicated sandbox runtime/pod/microVM per session or strongly isolated pool lease.
- Unprivileged UID, read-only root, seccomp/AppArmor, dropped capabilities, no Docker socket.
- Explicit network policy with deny-all default and domain/IP/protocol controls.
- Read-only input mounts and separate generated-output mount.
- CPU, RAM, PID, disk, file-count, output, and wall-clock quotas.
- Signed/pinned runtime image and allowlisted packages; installation only through controlled proxy/cache.
- Kill/reap on timeout, session expiry, cancellation, and organization policy.
- Malware/content scan before saving generated files to My Files.
- No platform/admin/service credentials in environment or metadata endpoints.

## 7. Visualization and report rendering

Chat can render HTML visualizations and export flat HTML/PDF, while Document Mode can embed Data Interpreter charts and export multiple formats.[13][20]

Use a canonical chart specification independent of any LLM or renderer:

```text
ChartSpec
- kind, title, data series, encodings
- axis/legend/format/accessibility metadata
- source data version hashes
- provenance/citations
```

Render interactively in a sandboxed frontend and statically for PDF/export. Escape every label/value, apply size/cardinality limits, disallow arbitrary JavaScript, and store chart spec + renderer version with the artifact.

## 8. Acceptance tests

- Concurrent user/AI document edits produce a merge proposal, never silent loss.
- Every export maps to a stable artifact version/hash and loads no unauthorized remote assets.
- Table dependency changes mark reviewed cells stale without replacing them.
- Bulk table execution cannot overwrite reviewed cells without explicit intent.
- Deep Research stops at configured budget and every report claim resolves to stored evidence.
- Data Interpreter has no network and cannot escape read-only inputs/runtime limits.
- Code Sandbox sessions cannot see another conversation, user, workflow run, host credential, or network outside policy.
- A chart rendered in chat and PDF uses the same validated data/spec.
- Deleting/revoking a source prevents future artifact citations from opening it unless an approved immutable evidence snapshot exists.

## Sources

[5] https://cohere.com/north
[6] https://cohere.com/north/agent-studio
[13] https://private.docs.cohere.com/docs/get-started/north-chat
[20] https://private.docs.cohere.com/docs/get-started/north-document-mode
[21] https://private.docs.cohere.com/docs/get-started/north-table-mode
[22] https://private.docs.cohere.com/docs/get-started/deep-research
[66] https://private.docs.cohere.com/docs/get-started/supported-files
[72] https://private.docs.cohere.com/docs/get-started/tools/data-interpreter/home
[73] https://private.docs.cohere.com/docs/get-started/tools/code-sandbox/home

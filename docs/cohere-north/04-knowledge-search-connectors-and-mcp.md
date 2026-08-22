# Knowledge, search, files, libraries, connectors, and MCP

**Status:** reconstruction-ready functional and service specification<br>
**Evidence date:** 2026-08-22

## 1. Knowledge-layer boundary

North distinguishes three add-on categories: **Capabilities** (built-in modes), **Sources** (enterprise data connectors), and **Custom** tools (organization-specific MCP integrations). Its documentation describes delegated access: live/API tools use the source platform's credentials and permissions, while indexed connectors preserve native permissions and validate them again at retrieval.[33]

An open implementation should preserve that user-facing distinction while implementing a common backend contract:

```text
Connector/Tool registration
  → credential binding
  → resource discovery/selection
  → optional sync + parse + index
  → permission snapshot/update
  → query/tool invocation
  → result normalization
  → citation/provenance creation
  → audit/telemetry
```

## 2. Connector and capability matrix

The current official matrix documents the following states, auth/storage patterns, and limitations.[33]

| Capability/source | Kind | State | Data path | Key requirement |
|---|---|---:|---|---|
| Code sandbox | built-in capability | Alpha | ephemeral isolated runtime + session object storage | Python/shell, generated files, package policy, strict isolation |
| Conversation History | built-in capability | Alpha | search existing conversations, no new corpus | current user + current agent scope; English-only limitation documented |
| Data Interpreter | built-in capability | GA | runtime Python, no Compass storage | CSV/Excel analysis from approved sources |
| Libraries | built-in capability | Beta | reusable collection over local/My Files/Microsoft items | sharing, sync status, agent/chat/node attachment |
| My Files | built-in capability | GA | stored and indexed in Compass | user ownership, duplicate/delete/storage limits |
| Web Search | built-in capability | GA | live public web | no authenticated pages |
| Exchange | connector | GA | indexed | OAuth/delegated email access |
| GitHub | source | Beta | live, read-only | org/repository scope + native permission |
| Gmail | connector | Alpha | live API, no default index | no attachments documented |
| Google Drive | connector | Alpha | Compass index + live fallback | file/folder selection + native ACL validation |
| Jira | first-party MCP source | Beta | live | OAuth app, Jira site/cloud selection, read/actions by tool policy |
| Jira legacy | connector | Deprecated | live | single domain, limited semantic behavior; migration path required |
| Linear | first-party MCP source | Beta | live | dynamic client registration/OAuth |
| Notion | first-party MCP source | Beta | live | dynamic client registration/OAuth |
| OneDrive | connector | GA | indexed | document/vision access + native ACL validation |
| Outlook | connector | GA | indexed | delegated mailbox access |
| Salesforce | connector | Alpha | live SOQL | accounts/contacts/opportunities/pipeline, no sync |
| SharePoint | connector | GA | Atlas/Compass index | sites/docs, document/CSV/vision, source ACLs |
| Slack | first-party MCP source | Beta | live | OAuth, North RBAC + source permissions |
| Slack legacy | connector | Deprecated | live | no file search/member listing; migration path required |
| Custom MCP | custom | varies | generally live | implementation-dependent auth and permissions |

Sharing semantics differ by data path. The data-sharing docs treat Gmail, Outlook, and Exchange agent configurations as private-only; API/MCP-backed shared agents such as Slack, Jira, and Salesforce share configuration rather than another user's data, so each runner authenticates and sees only provider-authorized content.[43] GitHub and Salesforce are documented read-only, while Jira writes depend on both admin enablement/tool policy and the runner's Jira permission.[24][33]

The rebuild should treat state as metadata (`preview/alpha/beta/ga/deprecated`), never as hard-coded presentation logic.

## 3. File ingestion

North's upload list includes CSV, TXT, Markdown, HTML/HTM, DOC/DOCX, PPTX, PDF, XLS/XLSX, and HWP. The public pages describe limits at different layers: the supported-files page cites a 100 MB aggregate MyDrive/Compass limit and 500 MB for SharePoint/OneDrive, while My Files/tool configuration documents a configurable per-file limit with a 50 MB default.[66][71][121] The rebuild must model per-file, per-user, and per-source limits separately rather than hard-code one contradictory global number. Spreadsheet row data is not searchable without Data Interpreter.[66]

### 3.1 Open ingestion pipeline

```text
UploadSession
  → object write (quarantine)
  → content hash + duplicate policy
  → malware/type/size checks
  → immutable FileVersion
  → parser/OCR/table extraction jobs
  → chunk/segment normalization
  → embedding + lexical index writes
  → ACL/provenance projection
  → ready | partial | failed | quarantined
```

### 3.2 Required file records

```text
File
- id, organization_id, owner_id
- display_name, media_type, extension, size
- source_type, source_connection_id, upstream_id
- current_version_id, created_at, deleted_at

FileVersion
- id, file_id, sha256, object_key
- parser_name/version, language, page/sheet count
- indexing_status, error_summary
- source_modified_at, ingested_at

Segment
- id, file_version_id
- page/sheet/section/cell coordinates
- text or structured representation
- dense embedding ref, sparse-vector ref, lexical fields
- content classification
```

Do not trust client MIME type or filename. Store the original object separately from parsed/indexed derivatives. Version every sync replacement so citations remain resolvable.

## 4. Sync patterns and freshness

North documents four distinct data paths.[67]

### 4.1 Atlas-managed periodic sync

Used for SharePoint, OneDrive, Outlook, Exchange, and an external-drive class. Users select files/folders/sites; folder selection is recursive; a centralized connector periodically extracts changes into Compass and tracks source permissions. Freshness is described as minutes to hours depending on volume.[67]

### 4.2 Direct Compass sync with live fallback

Google Drive begins a background sync after resource selection, supports manual refresh, and searches Compass first. When fewer than 20 indexed matches are returned, the documented behavior queries the live Drive API to fill the result set.[67]

### 4.3 Real-time API only

Gmail does not create a Compass snapshot in the documented default flow; every search hits the mailbox API live.[67]

### 4.4 User-upload path

My Files is stored inside North, processed/indexed immediately, organized by user, and remains until explicit deletion.[67]

### 4.5 Common sync state model

```text
Connection: disconnected | authenticating | connected | expired | revoked | error
Sync job: queued | discovering | fetching | parsing | indexing | reconciling_acl
          → ready | partial | failed | cancelled
Resource: selected | syncing | ready | stale | inaccessible | deleted_upstream | failed
```

Every UI/API should expose source, last successful sync, current job, selected scope, item counts, partial failures, auth health, next schedule, manual-resync permission, and freshness class (`live`, `indexed`, `hybrid`).

## 5. Libraries

Libraries are documented as Beta reusable named collections formed from local uploads, My Files, or Microsoft source content. They can be attached to agents, chats, or automation LLM nodes; the library UI has My libraries, Shared with me, and Company libraries.[34]

### 5.1 Source-specific behavior

- A Microsoft-connector library uses one connected account and may contain selected sites/folders/files.
- My Files libraries select existing personal files; removal disassociates without deleting the underlying file.
- Local-file libraries upload/copy content into library-managed membership.
- Outlook/Exchange libraries expose an admin-defined look-back/sync window.
- Chat attachment is session-scoped and does not mutate the selected agent's persistent library configuration.[34]

### 5.2 Sharing

| Access | Semantics |
|---|---|
| Private | Owner only; reverting to Private removes every other grant. |
| Limited / Reader | Named users can view/chat. |
| Limited / Editor | For local/My Files libraries, can manage metadata/file list/sharing; connector libraries remain owner-managed. |
| Company | Organization-wide read/chat; owner retains edit/delete. |

Attaching a library to an agent does not itself grant library access. Publishing/updating an agent fails if a recipient lacks at least Reader access, and existing mismatches show a warning.[34]

### 5.3 Data model

```text
Library
- id, organization_id, owner_id
- name, description, source_type, connection_id
- visibility, status, last_sync_time
- count_total/success/failed
- sync_window

LibraryMember
- library_id, file_or_upstream_resource_id
- display_name, type, position
- membership_state, last_error

LibraryGrant
- library_id, principal_type/id
- role: reader | editor
- granted_by, created_at, revoked_at
```

## 6. Retrieval service requirements

The Compass architecture docs describe a hybrid search pipeline with lexical retrieval, dense semantic vectors, sparse term-weighted vectors, and reranking. Parsed documents retain searchable text/metadata and may expose rich assets such as Markdown, extracted text, and PDF/presentation page screenshots.[117] Compass security documentation describes the service as an internal North component with bearer-authenticated index/document authorization; text/vectors live in OpenSearch and rich assets use time-limited presigned URLs.[118]

Those pages establish the public component shape, but not scoring fusion weights, candidate counts, chunking rules, production embedding/rerank model selection, or every authorization-cache detail. An independent reconstruction should preserve the documented lexical+dense+sparse+rerank stages while benchmarking its own algorithms rather than claiming exact Compass parity.

A clean-room retrieval contract should support:

1. query normalization and language detection;
2. source/library/file/agent/conversation filters;
3. mandatory principal and upstream ACL filtering;
4. lexical, dense-vector, and sparse-vector candidate retrieval;
5. optional reranking through a pluggable open model;
6. deduplication and diversity;
7. snippet/span construction;
8. freshness/version metadata;
9. citation-ready result IDs;
10. query/retrieval event evidence without leaking source text into audit logs.

```text
RetrieveRequest
- organization_id, principal_id
- query, conversation_id, agent_version_id
- source_bindings[], library_ids[], file_ids[]
- top_k, rerank_k, language, modality

RetrieveHit
- source_id, source_version_id, segment_id
- score components, rank
- snippet, locator, title, URI
- access_decision_id, freshness, content_hash
```

## 7. MCP coverage

North documents the following MCP feature support:[35][36][37]

| MCP feature | Documented state | Scope/limitation |
|---|---:|---|
| Tools | GA | Standard tool calls. |
| Embedded resources in tool results | GA | Supported. |
| Resources | Preview | Chat, agents, and automations. |
| Prompts | Preview | Clickable composer/tools cards; arguments editable before submit. |
| Elicitations | Preview | Chat-loop form mode; admin enablement. |
| Apps | Preview | Interactive `ui://` cards in chat/agents; not automations/external API. |

Documented MCP transport is HTTP (`streamable-http` and SSE); stdio servers require an HTTP proxy. Resources are discovered dynamically and injected through list/fetch tools; current limits include 1,000 listed resources per server, 50 per page, 50 MB per fetch, an approximately one-hour default lifetime for fetched temporary files, and rejection of binary image resources.[35][39] Apps render a tool-declared `ui://` HTML resource in a sandboxed null-origin iframe, are interactive only in chat/agents, do not restore client state merely by reopening a conversation, and require confirmation for external links.[36] Elicitations are flat form-mode requests for the invoking user, admin-disabled by default, with a documented default response timeout of 240 seconds.[37]

### 7.1 MCP server registry

```text
ToolServer
- id, key, organization_id, display_name
- transport, endpoint, version, owner
- auth_method, credential_binding_policy
- network/egress class, status
- discovered capabilities hash, last_refresh

Tool
- server_id, name, description
- input_schema, output_schema
- effect: read | create | update | delete | external_side_effect
- approval_policy, timeout, concurrency, enabled
```

### 7.2 Safety requirements

- Validate endpoint scheme/host against an allowlist; block SSRF and private-network surprises.
- Never place long-lived source credentials in prompts or model-visible tool arguments.
- Discover and hash manifests; require approval on capability drift.
- Classify read/action semantics per tool; do not rely on name alone.
- Validate every input/output against size/depth/type limits.
- Apply runner permissions, server permissions, tool permissions, and source-native permissions.
- Run calls with deadlines, cancellation, bounded retries, and circuit breakers.
- Store a content-minimized tool event plus request/trace IDs.
- Render MCP Apps in a sandboxed origin with restrictive CSP and explicit bridge APIs.
- Treat elicitations as typed UI requests; prevent a tool from spoofing platform login or approval dialogs.

### 7.3 MCP citation metadata

North's MCP developer contract separates model-readable tool `text` from per-result `_north_metadata`; the metadata is rendered in citation UI and is not returned to model context. Documented renderers are `document`, `thread`, `code`, `metadata_table`, and `tool_reference`, with renderer-specific required fields plus shared title/URL/author/update/page metadata. Invalid metadata is dropped rather than partially trusted.[119]

An independent gateway should validate that metadata against a strict schema, bind it to the exact tool result and call ID, authorize any URL/resource at render time, and never treat presentation metadata as model evidence unless the corresponding readable content is present.

### 7.4 Web Search

Web Search is a live model-invoked search/URL-scrape capability rather than an ingested knowledge source. The docs identify Tavily as the GA/default provider and Brave and LinkUp as Alpha alternatives, with one provider active at a time; authenticated pages are unsupported and returned text requires inline source links/citations.[120]

## 8. Connector SDK contract

Each connector should implement:

```text
metadata()                 # name, state, auth, effects, limits
begin_auth()/refresh_auth()
discover_resources(cursor, parent)
validate_selection(selection)
start_sync(selection, checkpoint)
poll_sync(job_id)
reconcile_acl(resource_ids)
query_live(query, filters, cursor)
fetch_content(resource_id, version)
delete_connection(mode)
health()
```

A connector declares whether it is `live`, `indexed`, or `hybrid`; how it preserves ACLs; how deletions propagate; whether actions are supported; and which data classes may leave the deployment.

## 9. Deletion and revocation

Deleting a file, revoking a connection, removing a library grant, or losing upstream permission must invalidate retrieval before eventual physical cleanup. Use a deny/tombstone path that is synchronous with authorization, then asynchronously purge object, parse, chunk, embedding, lexical-index, cache, and derived-artifact references according to retention/legal-hold policy. The vendor documentation separates data deletion from source sharing/syncing; the rebuild should keep these contracts explicit.[43][70]

## 10. Acceptance tests

- Upload every supported type and reject spoofed/oversize/malicious content safely.
- A citation survives a resync by binding to a version; a deleted source becomes inaccessible immediately.
- Google Drive hybrid search never returns an item the current user cannot open upstream.
- Revoking OAuth prevents live calls and indexed retrieval without waiting for the next sync.
- Library grant changes affect agent/chat retrieval immediately.
- An agent cannot be shared to a principal lacking attached library Reader access.
- Partial sync exposes successful/failed/skipped counts and retryable errors.
- MCP capability drift requires admin review before new action tools become usable.
- MCP Apps cannot access parent origin, credentials, or arbitrary network endpoints.
- Deletion removes derived embeddings and search records while preserving content-free audit evidence.

## Sources

[24] https://private.docs.cohere.com/docs/get-started/agents/creating-custom-agents
[33] https://private.docs.cohere.com/docs/get-started/tools-overview
[34] https://private.docs.cohere.com/docs/get-started/tools/libraries
[35] https://private.docs.cohere.com/docs/get-started/tools/mcp-servers/mcp-overview
[36] https://private.docs.cohere.com/docs/get-started/tools/mcp-servers/mcp-apps
[37] https://private.docs.cohere.com/docs/get-started/tools/mcp-servers/mcp-elicitation
[39] https://private.docs.cohere.com/docs/get-started/tools/mcp-servers/mcp-resources
[43] https://private.docs.cohere.com/docs/security/data-sharing
[66] https://private.docs.cohere.com/docs/get-started/supported-files
[67] https://private.docs.cohere.com/docs/security/data-syncing
[70] https://private.docs.cohere.com/docs/security/data-deletion
[71] https://private.docs.cohere.com/docs/get-started/tools/my-files/home
[117] https://private.docs.cohere.com/docs/compass/architecture
[118] https://private.docs.cohere.com/docs/compass/security
[119] https://private.docs.cohere.com/reference/mcp-development/citations
[120] https://private.docs.cohere.com/docs/get-started/tools/websearch/home
[121] https://private.docs.cohere.com/docs/admin/tools/configurations

# Cohere North public API and object model

> **Historical North research — captured 2026-08-22.** Vendor behavior,
> release labels, API inventories, and references below describe that capture,
> not the latest North release or the implemented Borealis product. See the
> [archive overview](README.md), [Borealis README](../../README.md), and
> [Borealis API reference](../API.md) for the distinction and current contracts.

**Evidence date:** 2026-08-22<br>
**Raw specification:** `https://private.docs.cohere.com/openapi/north.yaml`<br>
**SHA-256:** `c10abe6f3a7841501e6a1da3ce776a2f0954f5ded6598532c92b4c189364c1ea`<br>
**Size:** 632,713 bytes

> This is a read-only, clean-room analysis of the published OpenAPI description. It describes the externally documented contract, not Cohere's private implementation. No mutating endpoint was exercised.

## 1. Specification baseline

The published North contract is OpenAPI **3.1.0**, titled **North** at version **1.0.0**. It declares a parameterized server `https://{north-hostname}` and HTTP bearer plus HTTP basic security schemes.[11]

| Measure | Count |
|---|---:|
| Paths | 72 |
| Operations | 107 |
| Schemas | 364 |
| Deprecated Operations | 0 |

### Operations by HTTP method

| Method | Operations |
|---|---:|
| `DELETE` | 10 |
| `GET` | 50 |
| `PATCH` | 6 |
| `POST` | 32 |
| `PUT` | 9 |

Published success responses are 98× `200`, 4× `204`, 2× `201`, 2× `207`, and 1× `202`; 106 content-bearing success responses declare `application/json`. Every operation lists error statuses `400`, `401`, `403`, `404`, `422`, `429`, `500`, and `503`, although OAuth uses its OAuth-specific error envelope for part of that set.[11]

The spec has no top-level **or operation-level** OpenAPI `security` requirement, even though it declares `HTTPBearer` and `HTTPBasic` schemes. Instead, 103 of 107 operations model an explicit required `Authorization` header. The four exceptions are `GET /oauth/authorize`, `POST /v1/signup`, `POST /v1/signin`, and `POST /v1/token/exchange`; OAuth token and revoke still require authorization.[11] This is a contract-description quirk, not evidence that protected operations are anonymous.

## 2. Public domain model

The routes expose the following public aggregates and relationships:

- **Agents** own configuration and tool bindings; v2 adds job listing and explicit tool synchronization.
- **Conversations** own messages, files, and cancellable background tasks; title generation is a distinct command.
- **Files** are independently uploadable/retrievable/deletable and can be attached to local libraries or conversations.
- **Libraries** model connector-backed artifact collections; **local libraries** add direct file membership operations.
- **Automations** are executable definitions; **executions** expose run, node, output-file, cancellation, and human-review resources.
- **MCP servers** are administrator-managed resources with server-, tool-, and member-level permissions and tool-policy controls.
- **Models**, **users**, **permissions**, **groups**, and **audits** are separately queryable governance resources.
- **Chat** and **Responses** provide inference/streaming surfaces; Open Responses compatibility and North chat streaming are documented separately.[58][59]

## 3. Complete operation inventory

An operation means one HTTP method on one path. Counts therefore differ from path counts when a path supports multiple methods.

### `<untagged>` — 1 operation(s)

| Method | Path | `operationId` | Summary | Responses | Request media |
|---|---|---|---|---|---|
| `POST` | `/v1/chat` | `chat` | Chat | 200, 400, 401, 403, 404, 422, 429, 500, 503 | application/json |

### `actions` — 1 operation(s)

| Method | Path | `operationId` | Summary | Responses | Request media |
|---|---|---|---|---|---|
| `GET` | `/v1/admin/audits/actions` | `list` | List Audit Actions | 200, 400, 401, 403, 404, 422, 429, 500, 503 | — |

### `agents` — 10 operation(s)

| Method | Path | `operationId` | Summary | Responses | Request media |
|---|---|---|---|---|---|
| `GET` | `/v1/agents` | `list` | List Agents | 200, 400, 401, 403, 404, 422, 429, 500, 503 | — |
| `POST` | `/v1/agents` | `create` | Create Agent | 200, 400, 401, 403, 404, 422, 429, 500, 503 | application/json |
| `DELETE` | `/v1/agents/{agent_id}` | `delete` | Delete Agent | 200, 400, 401, 403, 404, 422, 429, 500, 503 | — |
| `GET` | `/v1/agents/{agent_id}` | `get` | Get Agent | 200, 400, 401, 403, 404, 422, 429, 500, 503 | — |
| `POST` | `/v1/agents/{agent_id}` | `update` | Update Agent | 200, 400, 401, 403, 404, 422, 429, 500, 503 | application/json |
| `GET` | `/v2/agents` | `list` | List agents | 200, 400, 401, 403, 404, 422, 429, 500, 503 | — |
| `POST` | `/v2/agents` | `create` | Create agent | 200, 400, 401, 403, 404, 422, 429, 500, 503 | application/json |
| `DELETE` | `/v2/agents/{agent_id}` | `delete` | Delete agent | 204, 400, 401, 403, 404, 422, 429, 500, 503 | — |
| `GET` | `/v2/agents/{agent_id}` | `retrieve` | Retrieve agent | 200, 400, 401, 403, 404, 422, 429, 500, 503 | — |
| `PATCH` | `/v2/agents/{agent_id}` | `update` | Update agent | 200, 400, 401, 403, 404, 422, 429, 500, 503 | application/json |

### `audits` — 1 operation(s)

| Method | Path | `operationId` | Summary | Responses | Request media |
|---|---|---|---|---|---|
| `GET` | `/v1/admin/audits` | `list` | List Audits | 200, 400, 401, 403, 404, 422, 429, 500, 503 | — |

### `auth` — 3 operation(s)

| Method | Path | `operationId` | Summary | Responses | Request media |
|---|---|---|---|---|---|
| `POST` | `/v1/signin` | `signin` | Signin | 200, 400, 401, 403, 404, 422, 429, 500, 503 | application/json |
| `POST` | `/v1/signup` | `signup` | Signup | 200, 400, 401, 403, 404, 422, 429, 500, 503 | application/json |
| `POST` | `/v1/token/exchange` | `tokenExchange` | Token Exchange | 200, 400, 401, 403, 404, 422, 429, 500, 503 | application/json |

### `automations` — 3 operation(s)

| Method | Path | `operationId` | Summary | Responses | Request media |
|---|---|---|---|---|---|
| `GET` | `/v1/automations` | `list` | List Automations | 200, 400, 401, 403, 404, 422, 429, 500, 503 | — |
| `GET` | `/v1/automations/{automation_id}` | `get` | Get Automation | 200, 400, 401, 403, 404, 422, 429, 500, 503 | — |
| `POST` | `/v1/automations/{automation_id}/execute` | `execute` | Execute Automation | 200, 400, 401, 403, 404, 422, 429, 500, 503 | application/json |

### `backgroundTasks` — 3 operation(s)

| Method | Path | `operationId` | Summary | Responses | Request media |
|---|---|---|---|---|---|
| `GET` | `/v2/conversations/{conversation_id}/background_tasks` | `list` | List conversation background tasks | 200, 400, 401, 403, 404, 422, 429, 500, 503 | — |
| `GET` | `/v2/conversations/{conversation_id}/background_tasks/{task_id}` | `retrieve` | Retrieve conversation background task | 200, 400, 401, 403, 404, 422, 429, 500, 503 | — |
| `POST` | `/v2/conversations/{conversation_id}/background_tasks/{task_id}/cancel` | `cancel` | Cancel conversation background task | 200, 400, 401, 403, 404, 422, 429, 500, 503 | — |

### `capabilities` — 2 operation(s)

| Method | Path | `operationId` | Summary | Responses | Request media |
|---|---|---|---|---|---|
| `POST` | `/v1/admin/mcp/capabilities/cache:invalidate` | `invalidateCache` | Invalidate Mcp Capabilities Cache | 200, 400, 401, 403, 404, 422, 429, 500, 503 | — |
| `POST` | `/v1/admin/mcp/servers/{server_id}:refresh-capabilities` | `refresh` | Refresh Mcp Server Capabilities | 200, 400, 401, 403, 404, 422, 429, 500, 503 | — |

### `capabilitiesByKey` — 1 operation(s)

| Method | Path | `operationId` | Summary | Responses | Request media |
|---|---|---|---|---|---|
| `POST` | `/v1/admin/mcp/servers/key/{server_key}:refresh-capabilities` | `refresh` | Refresh Mcp Server Capabilities By Key | 200, 400, 401, 403, 404, 422, 429, 500, 503 | — |

### `conversations` — 9 operation(s)

| Method | Path | `operationId` | Summary | Responses | Request media |
|---|---|---|---|---|---|
| `GET` | `/v1/conversations` | `list` | List Conversations | 200, 400, 401, 403, 404, 422, 429, 500, 503 | — |
| `DELETE` | `/v1/conversations/{conversation_id}` | `delete` | Delete Conversation | 200, 400, 401, 403, 404, 422, 429, 500, 503 | — |
| `GET` | `/v1/conversations/{conversation_id}` | `get` | Get Conversation | 200, 400, 401, 403, 404, 422, 429, 500, 503 | — |
| `GET` | `/v2/conversations` | `list` | List conversations | 200, 400, 401, 403, 404, 422, 429, 500, 503 | — |
| `POST` | `/v2/conversations` | `create` | Create conversation | 201, 400, 401, 403, 404, 422, 429, 500, 503 | application/json |
| `DELETE` | `/v2/conversations/{conversation_id}` | `delete` | Delete conversation | 204, 400, 401, 403, 404, 422, 429, 500, 503 | — |
| `GET` | `/v2/conversations/{conversation_id}` | `retrieve` | Retrieve conversation | 200, 400, 401, 403, 404, 422, 429, 500, 503 | — |
| `PATCH` | `/v2/conversations/{conversation_id}` | `update` | Update conversation | 200, 400, 401, 403, 404, 422, 429, 500, 503 | application/json |
| `POST` | `/v2/conversations/{conversation_id}/generate-title` | `generate-title` | Generate conversation title | 200, 400, 401, 403, 404, 422, 429, 500, 503 | — |

### `executions` — 7 operation(s)

| Method | Path | `operationId` | Summary | Responses | Request media |
|---|---|---|---|---|---|
| `GET` | `/v1/automations/executions` | `list` | List Executions | 200, 400, 401, 403, 404, 422, 429, 500, 503 | — |
| `GET` | `/v1/automations/executions/{execution_id}` | `get` | Get Execution | 200, 400, 401, 403, 404, 422, 429, 500, 503 | — |
| `POST` | `/v1/automations/executions/{execution_id}/cancel` | `cancel` | Cancel Execution | 200, 400, 401, 403, 404, 422, 429, 500, 503 | — |
| `GET` | `/v1/automations/executions/{execution_id}/files/{document_id}` | `get_file` | Get Output File | 200, 400, 401, 403, 404, 422, 429, 500, 503 | — |
| `GET` | `/v1/automations/executions/{execution_id}/nodes/{node_selector}` | `get_node` | Get Execution Node | 200, 400, 401, 403, 404, 422, 429, 500, 503 | — |
| `GET` | `/v1/automations/executions/{execution_id}/nodes/{node_selector}/review` | `get_review_task` | Get Human Review Task | 200, 400, 401, 403, 404, 422, 429, 500, 503 | — |
| `POST` | `/v1/automations/executions/{execution_id}/nodes/{node_selector}/review` | `submit_review` | Submit Human Review | 200, 400, 401, 403, 404, 422, 429, 500, 503 | application/json |

### `files` — 10 operation(s)

| Method | Path | `operationId` | Summary | Responses | Request media |
|---|---|---|---|---|---|
| `GET` | `/v1/files` | `list` | List files | 200, 400, 401, 403, 404, 422, 429, 500, 503 | — |
| `POST` | `/v1/files` | `create` | Upload file | 200, 400, 401, 403, 404, 422, 429, 500, 503 | multipart/form-data |
| `POST` | `/v1/files/batch` | `batch-create` | Batch upload files | 200, 400, 401, 403, 404, 422, 429, 500, 503 | multipart/form-data |
| `DELETE` | `/v1/files/{file_id}` | `delete` | Delete file | 200, 400, 401, 403, 404, 422, 429, 500, 503 | — |
| `GET` | `/v1/files/{file_id}` | `retrieve` | Retrieve file | 200, 400, 401, 403, 404, 422, 429, 500, 503 | — |
| `GET` | `/v1/files/{file_id}/content` | `content` | Retrieve file content | 200, 400, 401, 403, 404, 422, 429, 500, 503 | — |
| `GET` | `/v1/local-libraries/{library_id}/files` | `list` | List files | 200, 400, 401, 403, 404, 422, 429, 500, 503 | — |
| `POST` | `/v1/local-libraries/{library_id}/files` | `upload` | Upload files | 207, 400, 401, 403, 404, 422, 429, 500, 503 | multipart/form-data |
| `POST` | `/v1/local-libraries/{library_id}/files/bulk-delete` | `bulk-delete` | Delete files | 207, 400, 401, 403, 404, 422, 429, 500, 503 | application/json |
| `GET` | `/v2/conversations/{conversation_id}/files` | `list` | List conversation files | 200, 400, 401, 403, 404, 422, 429, 500, 503 | — |

### `groups` — 1 operation(s)

| Method | Path | `operationId` | Summary | Responses | Request media |
|---|---|---|---|---|---|
| `GET` | `/v1/admin/permissions/groups/{group_name}` | `retrieve` | Get Group Permissions | 200, 400, 401, 403, 404, 422, 429, 500, 503 | — |

### `jobs` — 2 operation(s)

| Method | Path | `operationId` | Summary | Responses | Request media |
|---|---|---|---|---|---|
| `GET` | `/v2/agents/{agent_id}/jobs` | `list` | List jobs | 200, 400, 401, 403, 404, 422, 429, 500, 503 | — |
| `GET` | `/v2/agents/{agent_id}/jobs/{job_id}` | `get` | Get job | 200, 400, 401, 403, 404, 422, 429, 500, 503 | — |

### `libraries` — 5 operation(s)

| Method | Path | `operationId` | Summary | Responses | Request media |
|---|---|---|---|---|---|
| `GET` | `/v1/libraries` | `list` | List libraries | 200, 400, 401, 403, 404, 422, 429, 500, 503 | — |
| `POST` | `/v1/libraries` | `create` | Create library | 200, 400, 401, 403, 404, 422, 429, 500, 503 | application/json |
| `DELETE` | `/v1/libraries/{library_id}` | `delete` | Delete library | 204, 400, 401, 403, 404, 422, 429, 500, 503 | — |
| `GET` | `/v1/libraries/{library_id}` | `get` | Retrieve library | 200, 400, 401, 403, 404, 422, 429, 500, 503 | — |
| `PATCH` | `/v1/libraries/{library_id}` | `update` | Update library | 200, 400, 401, 403, 404, 422, 429, 500, 503 | application/json |

### `localLibraries` — 5 operation(s)

| Method | Path | `operationId` | Summary | Responses | Request media |
|---|---|---|---|---|---|
| `GET` | `/v1/local-libraries` | `list` | List local libraries | 200, 400, 401, 403, 404, 422, 429, 500, 503 | — |
| `POST` | `/v1/local-libraries` | `create` | Create local library | 201, 400, 401, 403, 404, 422, 429, 500, 503 | application/json |
| `DELETE` | `/v1/local-libraries/{library_id}` | `delete` | Delete local library | 204, 400, 401, 403, 404, 422, 429, 500, 503 | — |
| `GET` | `/v1/local-libraries/{library_id}` | `retrieve` | Retrieve local library | 200, 400, 401, 403, 404, 422, 429, 500, 503 | — |
| `PATCH` | `/v1/local-libraries/{library_id}` | `update` | Update local library | 200, 400, 401, 403, 404, 422, 429, 500, 503 | application/json |

### `members` — 4 operation(s)

| Method | Path | `operationId` | Summary | Responses | Request media |
|---|---|---|---|---|---|
| `GET` | `/v1/admin/permissions/models/{model_id}/members` | `list` | Get Model Permission Members | 200, 400, 401, 403, 404, 422, 429, 500, 503 | — |
| `PUT` | `/v1/admin/permissions/models/{model_id}/members` | `update` | Put Model Permission Members | 200, 400, 401, 403, 404, 422, 429, 500, 503 | application/json |
| `GET` | `/v1/admin/permissions/{permission}/members` | `list` | Get Permission Members | 200, 400, 401, 403, 404, 422, 429, 500, 503 | — |
| `PUT` | `/v1/admin/permissions/{permission}/members` | `update` | Put Permission Members | 200, 400, 401, 403, 404, 422, 429, 500, 503 | application/json |

### `messages` — 2 operation(s)

| Method | Path | `operationId` | Summary | Responses | Request media |
|---|---|---|---|---|---|
| `GET` | `/v2/conversations/{conversation_id}/messages` | `list` | List conversation messages | 200, 400, 401, 403, 404, 422, 429, 500, 503 | — |
| `GET` | `/v2/conversations/{conversation_id}/messages/{message_id}` | `retrieve` | Retrieve conversation message | 200, 400, 401, 403, 404, 422, 429, 500, 503 | — |

### `models` — 2 operation(s)

| Method | Path | `operationId` | Summary | Responses | Request media |
|---|---|---|---|---|---|
| `GET` | `/v1/models` | `list` | List Models | 200, 400, 401, 403, 404, 422, 429, 500, 503 | — |
| `GET` | `/v2/models` | `list` | List models | 200, 400, 401, 403, 404, 422, 429, 500, 503 | — |

### `oauth` — 3 operation(s)

| Method | Path | `operationId` | Summary | Responses | Request media |
|---|---|---|---|---|---|
| `GET` | `/oauth/authorize` | `authorize` | Oauth Authorize | 200, 400, 401, 403, 404, 422, 429, 500, 503 | — |
| `POST` | `/oauth/revoke` | `revoke` | Oauth Revoke | 200, 400, 401, 403, 404, 422, 429, 500, 503 | application/json |
| `POST` | `/oauth/token` | `token` | Oauth Token | 200, 400, 401, 403, 404, 422, 429, 500, 503 | application/json |

### `permissions` — 1 operation(s)

| Method | Path | `operationId` | Summary | Responses | Request media |
|---|---|---|---|---|---|
| `GET` | `/v1/admin/permissions` | `list` | List Permissions | 200, 400, 401, 403, 404, 422, 429, 500, 503 | — |

### `responses` — 1 operation(s)

| Method | Path | `operationId` | Summary | Responses | Request media |
|---|---|---|---|---|---|
| `POST` | `/v1/responses` | `create` | Create Response | 200, 400, 401, 403, 404, 422, 429, 500, 503 | application/json |

### `serverPermissions` — 2 operation(s)

| Method | Path | `operationId` | Summary | Responses | Request media |
|---|---|---|---|---|---|
| `GET` | `/v1/admin/mcp/servers/{server_id}/permissions` | `retrieve` | Get Mcp Server Permissions | 200, 400, 401, 403, 404, 422, 429, 500, 503 | — |
| `PUT` | `/v1/admin/mcp/servers/{server_id}/permissions` | `update` | Put Mcp Server Permissions | 200, 400, 401, 403, 404, 422, 429, 500, 503 | application/json |

### `serverPermissionsByKey` — 2 operation(s)

| Method | Path | `operationId` | Summary | Responses | Request media |
|---|---|---|---|---|---|
| `GET` | `/v1/admin/mcp/servers/key/{server_key}/permissions` | `retrieve` | Get Mcp Server Permissions By Key | 200, 400, 401, 403, 404, 422, 429, 500, 503 | — |
| `PUT` | `/v1/admin/mcp/servers/key/{server_key}/permissions` | `update` | Put Mcp Server Permissions By Key | 200, 400, 401, 403, 404, 422, 429, 500, 503 | application/json |

### `serverToolPolicies` — 1 operation(s)

| Method | Path | `operationId` | Summary | Responses | Request media |
|---|---|---|---|---|---|
| `POST` | `/v1/admin/mcp/tool-policies:batch-get` | `batchRetrieve` | Batch Get Mcp Server Tool Policies | 200, 400, 401, 403, 404, 422, 429, 500, 503 | application/json |

### `serverToolPolicy` — 2 operation(s)

| Method | Path | `operationId` | Summary | Responses | Request media |
|---|---|---|---|---|---|
| `GET` | `/v1/admin/mcp/servers/{server_id}/tool-policy` | `retrieve` | Get Mcp Server Tool Policy | 200, 400, 401, 403, 404, 422, 429, 500, 503 | — |
| `PUT` | `/v1/admin/mcp/servers/{server_id}/tool-policy` | `update` | Put Mcp Server Tool Policy | 200, 400, 401, 403, 404, 422, 429, 500, 503 | application/json |

### `serverToolPolicyByKey` — 2 operation(s)

| Method | Path | `operationId` | Summary | Responses | Request media |
|---|---|---|---|---|---|
| `GET` | `/v1/admin/mcp/servers/key/{server_key}/tool-policy` | `retrieve` | Get Mcp Server Tool Policy By Key | 200, 400, 401, 403, 404, 422, 429, 500, 503 | — |
| `PUT` | `/v1/admin/mcp/servers/key/{server_key}/tool-policy` | `update` | Put Mcp Server Tool Policy By Key | 200, 400, 401, 403, 404, 422, 429, 500, 503 | application/json |

### `servers` — 6 operation(s)

| Method | Path | `operationId` | Summary | Responses | Request media |
|---|---|---|---|---|---|
| `GET` | `/v1/admin/mcp/servers` | `list` | List Mcp Servers | 200, 400, 401, 403, 404, 422, 429, 500, 503 | — |
| `POST` | `/v1/admin/mcp/servers` | `create` | Create Mcp Server | 200, 400, 401, 403, 404, 422, 429, 500, 503 | application/json |
| `DELETE` | `/v1/admin/mcp/servers/{server_id}` | `delete` | Delete Mcp Server | 200, 400, 401, 403, 404, 422, 429, 500, 503 | — |
| `GET` | `/v1/admin/mcp/servers/{server_id}` | `retrieve` | Get Mcp Server Details | 200, 400, 401, 403, 404, 422, 429, 500, 503 | — |
| `PATCH` | `/v1/admin/mcp/servers/{server_id}` | `update` | Patch Mcp Server | 200, 400, 401, 403, 404, 422, 429, 500, 503 | application/json |
| `POST` | `/v1/admin/mcp/servers:test-connection` | `testConnection` | Test Mcp Server Connection | 200, 400, 401, 403, 404, 422, 429, 500, 503 | application/json |

### `serversByKey` — 4 operation(s)

| Method | Path | `operationId` | Summary | Responses | Request media |
|---|---|---|---|---|---|
| `DELETE` | `/v1/admin/mcp/servers/key/{server_key}` | `delete` | Delete Mcp Server By Key | 200, 400, 401, 403, 404, 422, 429, 500, 503 | — |
| `GET` | `/v1/admin/mcp/servers/key/{server_key}` | `retrieve` | Get Mcp Server Details By Key | 200, 400, 401, 403, 404, 422, 429, 500, 503 | — |
| `PATCH` | `/v1/admin/mcp/servers/key/{server_key}` | `update` | Patch Mcp Server By Key | 200, 400, 401, 403, 404, 422, 429, 500, 503 | application/json |
| `PUT` | `/v1/admin/mcp/servers/key/{server_key}` | `upsert` | Upsert Mcp Server By Key | 200, 400, 401, 403, 404, 422, 429, 500, 503 | application/json |

### `toolPermissions` — 3 operation(s)

| Method | Path | `operationId` | Summary | Responses | Request media |
|---|---|---|---|---|---|
| `GET` | `/v1/admin/mcp/servers/{server_id}/tools/{tool_name}/permissions` | `retrieve` | Get Mcp Tool Permissions | 200, 400, 401, 403, 404, 422, 429, 500, 503 | — |
| `PUT` | `/v1/admin/mcp/servers/{server_id}/tools/{tool_name}/permissions` | `update` | Put Mcp Tool Permissions | 200, 400, 401, 403, 404, 422, 429, 500, 503 | application/json |
| `POST` | `/v1/admin/mcp/servers/{server_id}/tools/{tool_name}/permissions/reset` | `reset` | Reset Mcp Tool Permissions | 200, 400, 401, 403, 404, 422, 429, 500, 503 | — |

### `toolPermissionsByKey` — 3 operation(s)

| Method | Path | `operationId` | Summary | Responses | Request media |
|---|---|---|---|---|---|
| `GET` | `/v1/admin/mcp/servers/key/{server_key}/tools/{tool_name}/permissions` | `retrieve` | Get Mcp Tool Permissions By Key | 200, 400, 401, 403, 404, 422, 429, 500, 503 | — |
| `PUT` | `/v1/admin/mcp/servers/key/{server_key}/tools/{tool_name}/permissions` | `update` | Put Mcp Tool Permissions By Key | 200, 400, 401, 403, 404, 422, 429, 500, 503 | application/json |
| `POST` | `/v1/admin/mcp/servers/key/{server_key}/tools/{tool_name}/permissions/reset` | `reset` | Reset Mcp Tool Permissions By Key | 200, 400, 401, 403, 404, 422, 429, 500, 503 | — |

### `tools` — 1 operation(s)

| Method | Path | `operationId` | Summary | Responses | Request media |
|---|---|---|---|---|---|
| `POST` | `/v2/agents/{agent_id}/tools/{tool_id}/sync` | `sync` | Sync tool | 202, 400, 401, 403, 404, 422, 429, 500, 503 | — |

### `users` — 4 operation(s)

| Method | Path | `operationId` | Summary | Responses | Request media |
|---|---|---|---|---|---|
| `GET` | `/v1/admin/permissions/users/{user_email}` | `retrieve` | Get User Permissions | 200, 400, 401, 403, 404, 422, 429, 500, 503 | — |
| `GET` | `/v1/users/me` | `get_me` | Get Me | 200, 400, 401, 403, 404, 422, 429, 500, 503 | — |
| `DELETE` | `/v1/users/{user_id}` | `delete` | Delete User | 200, 400, 401, 403, 404, 422, 429, 500, 503 | — |
| `POST` | `/v1/users/{user_id}` | `update` | Update User | 200, 400, 401, 403, 404, 422, 429, 500, 503 | application/json |

## 4. Contract-critical schemas

`*` marks required properties in the published schema. Property lists are generated from the raw OpenAPI file.

| Schema | Properties | Description |
|---|---|---|
| `NorthErrorResponse` | `error_type`*, `error_code`*, `message`*, `request_id`*, `trace_id`, `status_code`*, `is_retryable`*, `details` | Standardized error body for every non-2xx HTTP response. HTTP counterpart to :class:`~backend.schemas.external.error.NorthChatError` (streaming). Both share the same core fields so clients use identical logic regardless of transport; this c |
| `NorthChatError` | `error_code`*, `message`, `context` | Error payload inside a ``stream-end`` SSE event (``DeltaStreamEnd.error``). Intentionally minimal: ``error_code``, ``message``, and ``context`` only. For non-2xx HTTP errors use :class:`~backend.errors.north_error.NorthErrorResponse`. |
| `NorthChatResponse` | `conversation_id`*, `finish_reason`, `messages`*, `usage`, `error` |  |
| `NorthConversation` | `id`*, `created_at`, `updated_at`, `title`, `description`, `is_title_set_by_user`, `agent_id`, `background_chat_task` |  |
| `NorthConversationWithMessages` | `id`*, `created_at`, `updated_at`, `title`, `description`, `is_title_set_by_user`, `agent_id`, `background_chat_task`, `messages`*, `files` |  |
| `ConversationSummary` | `id`*, `agent_id`, `title`, `description`, `title_source`, `type`*, `created_at`*, `updated_at`* | Metadata-only conversation shape for list, search, generate-title, get, create, and patch. |
| `ConversationBackgroundTask` | `id`*, `conversation_id`*, `agent_id`, `request_id`*, `status`*, `task_type`*, `error_message`, `created_at`*, `queued_at`, `started_at`, `ended_at` | External-safe background task shape for list and get responses. |
| `BackgroundChatTask` | `id`*, `created_at`*, `queued_at`*, `started_at`*, `ended_at`*, `conversation_id`*, `user_id`*, `agent_id`*, `request_id`*, `status`*, `task_type`, `error_message`*, `error`, `usage`, `finish_reason`, `inngest_event_id`* |  |
| `AgentV2` | `id`*, `created_at`*, `updated_at`*, `name`*, `description`, `instructions`, `temperature`, `model`*, `reasoning`, `icebreakers`, `visibility`* | Lightweight agent schema for list operations (excludes expensive tools field). |
| `AgentV2Detail` | `id`*, `created_at`*, `updated_at`*, `name`*, `description`, `instructions`, `temperature`, `model`*, `reasoning`, `icebreakers`, `visibility`*, `tools` | Full agent schema with tools for single agent retrieval. |
| `NorthAgent` | `id`*, `created_at`*, `updated_at`*, `name`*, `description`*, `preamble`*, `temperature`*, `tools`*, `icebreakers`, `model`*, `visibility`*, `use_system_default_model`, `reasoning_options` |  |
| `NorthAgentConfig` | `id`* |  |
| `NorthAutomation` | `id`*, `name`*, `description`, `created_at`*, `creator_id`, `creator_name`, `publication_status`*, `visibility`*, `input_parameters`, `tools` | An automation in your workspace. |
| `NorthExecution` | `id`*, `automation_id`*, `automation_name`*, `automation_version_id`*, `status`*, `awaiting_human_review`, `run_origin`*, `tools`, `initiator_id`, `initiator_name`, `queued_at`, `started_at`, `ended_at`, `run_time_seconds`, `wait_time_seconds`, `input_tokens`, `output_tokens`, `inputs`, `output`, `usage`, `nodes`, `output_files` | The current state of an automation run. |
| `NorthNodeExecution` | `node_id`*, `status`*, `output`, `error`, `started_at`, `ended_at`, `duration_seconds`, `usage` | Execution details for a single node within an automation run. |
| `NorthSubmitReviewResponse` | `event_id`* | Result of submitting a human review. |
| `NorthFile` | `id`*, `created_at`*, `updated_at`*, `conversation_id`*, `file_name`*, `file_size` |  |
| `NorthFileStatus` | `file_id`*, `display_name`*, `error_message`, `is_skipped` | Status of a file that failed during sync. |
| `NorthLibrary` | `id`*, `user_id`*, `name`*, `description`, `created_at`*, `type`*, `tool_id`*, `status`*, `last_sync_time`, `count_total`*, `count_success`*, `count_failed`* | Lightweight library representation used in list responses. |
| `NorthLibraryDetail` | `id`*, `user_id`*, `name`*, `description`, `created_at`*, `type`*, `tool_id`*, `status`*, `last_sync_time`, `count_total`*, `count_success`*, `count_failed`*, `artifacts`*, `recent_files_failed`* | Full library representation including artifacts and failure details. |
| `NorthLocalLibrary` | `id`*, `user_id`*, `name`*, `description`, `created_at`*, `status`*, `count_total`*, `count_success`*, `count_failed`*, `count_pending`*, `count_not_required`* | Lightweight local library representation used in list responses. |
| `NorthLocalLibraryDetail` | `id`*, `user_id`*, `name`*, `description`, `created_at`*, `status`*, `count_total`*, `count_success`*, `count_failed`*, `count_pending`*, `count_not_required`*, `recent_files_failed`* | Full local library representation including recent indexing failures. |
| `MCPServerDetailResponse` | `id`*, `key`, `url`*, `name`*, `icon`, `icon_hidden`, `required_connectors`*, `is_disconnected`*, `default_tool_inheritance_enabled`*, `auto_generate_citations`, `oauth_app_id`, `tools`, `prompts`, `supports_resources`, `creator`, `custom_headers`, `custom_header_secret_keys`, `idp_tokens`, `dynamic_headers`, `oauth_headers` |  |
| `MCPToolPolicyResponse` | `server_id`*, `policy_type`, `enabled`, `members` |  |
| `NorthUserPermissionsResponse` | `user_email`*, `permissions` | Response for directly assigned organization permissions for a user. |
| `ResponsesError` | `code`*, `message`* | An error that occurred while generating the response. |
| `ResponsesUsage` | `input_tokens`*, `output_tokens`*, `total_tokens`*, `input_tokens_details`*, `output_tokens_details`* | Token usage statistics that were recorded for the response. |

### Standard error envelope

The `NorthErrorResponse` contract standardizes non-2xx responses around `error_type`, stable `error_code`, human-readable `message`, `request_id`, optional `trace_id`, `status_code`, `is_retryable`, and structured `details`. The documented coarse error categories are intended for programmatic branching, while the error code is the stable fine-grained discriminator.[11]

**Reimplementation requirement:** use the same error envelope for REST and align streaming errors to the same core fields. Preserve request/trace correlation, make retryability explicit, never return raw exception strings, and type `details` rather than serializing nested JSON into a string.

## 5. Streaming and compatibility requirements

### 5.1 Exact published Chat stream union

The raw specification defines **16** discriminated Chat stream event variants:[11]

`citation-start`, `citation-end`, `content-start`, `content-delta`, `content-end`, `message-start`, `message-end`, `stream-start`, `stream-end`, `tool-call-start`, `tool-call-delta`, `tool-call-end`, `tool-plan-delta`, `tool-elicitation-request`, `tool-elicitation-state-change`, and `debug`.

The `debug` variant can carry prompt and raw-generation fields. **Open implementation safety rule:** never expose this event to ordinary clients or persist it in production streams; gate any equivalent behind explicit privileged diagnostics with redaction and retention controls.

The Open Responses output union contains `message`, `reasoning`, `function_call`, and `function_call_output`. The response object also represents model, prior-response linkage, tools/tool choice, truncation, parallel tool calls, sampling, reasoning, usage, output/tool limits, `store`, background mode, service tier, metadata, safety identifier, and prompt-cache key.[11]

### 5.2 Conversation/background-task enums

The current `ConversationType` enum is `agent_assistant`, `automation_assistant`, `chat`, `deep_research`, `document_editing`, `north_app_builder`, and `table_editing`. Background task types are `chat` and `deep_research`; states are `queued`, `in_progress`, `completed`, `failed`, and `cancelled`. The external task shape includes task/conversation/request identity, optional agent, timestamps, and safe failure data.[11]

### 5.3 Transport inconsistency in the published spec

The OpenAPI file does **not** document `text/event-stream`; all operation success content is `application/json`. Both `/v1/chat` and `/v1/responses` also constrain the required request field `stream` to `false`, even though descriptions and component schemas discuss streaming/SSE. Therefore the raw OpenAPI file alone is not a valid interoperable SSE transport contract.[11]

- `POST /v1/chat` is the North chat endpoint and returns the documented Chat response object.
- `POST /v1/responses` is the Open Responses-compatible surface; the compatibility guide adds semantic context beyond OpenAPI.[58]
- The separate chat-stream guide is corroborating prose for event behavior, but implementers must not assume media type, framing, resume, or ordering details that it does not define precisely.[59]
- `stream_options`, structured response formats, tool definitions/choices, usage reporting, and truncation strategy are represented in the schema family.

**Recommended independent protocol:** if the rebuild exposes streaming, specify and contract-test Server-Sent Events with a typed union, stable IDs, explicit terminal events, reconnect/resume behavior, and cancellation. Treat this as a project-owned extension until a live, authoritative North transport contract can be verified—not as proven OpenAPI parity.

## 6. API behavior that must be tested

1. Bearer/basic/OAuth authentication boundaries and operation-specific authorization.
2. Tenant/user scoping on every list, retrieve, mutation, file, and execution route.
3. Cursor/order pagination, deterministic sorting, and stable object IDs.
4. Idempotency and race handling for upload, delete, tool sync, title generation, cancellation, review submission, and MCP refresh.
5. Partial failure reporting for batch file/library jobs.
6. Content type, filename, range/download, size, malware, and authorization controls on files.
7. Structured-output validation and tool schema validation before execution.
8. Stream event ordering, cancellation, timeout, reconnect, and error envelope parity.
9. Runner-permission evaluation for automation tool calls and HITL task access.
10. Stable request/trace IDs and `is_retryable` semantics across REST and streaming.

## 7. Complete schema index

The current spec defines **364 component schemas**. This generated index is included so no published type is silently omitted. Detailed field definitions remain authoritative in the cited raw specification.[11]

| Schema | Type | Property count | Required count |
|---|---|---:|---:|
| `AccessTokenResponse` | object | 6 | 2 |
| `AdminCreateMCPServerRequest` | object | 9 | 2 |
| `AdminPatchMCPServerRequest` | object | 10 | 0 |
| `AdminPutMCPServerRequest` | object | 10 | 2 |
| `AdminPutMCPServerResponse` | object | 4 | 4 |
| `AdminPutMcpServerResponseStatus` | string | 0 | 0 |
| `AdminRefreshMCPServerResponse` | object | 3 | 3 |
| `AgentJobResponseV2` | object | 5 | 2 |
| `AgentToolSyncResponseV2` | object | 1 | 0 |
| `AgentV2` | object | 11 | 6 |
| `AgentV2Detail` | object | 12 | 6 |
| `AgentV2DetailModel` | union | 0 | 0 |
| `AgentV2DetailToolsItems` | union | 0 | 0 |
| `AgentV2Model` | union | 0 | 0 |
| `AgentVisibility` | string | 0 | 0 |
| `AgentVisibilityV2` | string | 0 | 0 |
| `AllowedToolChoice` | object | 3 | 2 |
| `AllowedToolsParam` | object | 3 | 1 |
| `Annotation` | union | 0 | 0 |
| `AssistantMessageItemParam` | object | 5 | 1 |
| `AssistantMessageItemParamContent` | union | 0 | 0 |
| `AssistantMessageItemParamContent0` | array | 0 | 0 |
| `AssistantMessageItemParamContentOneOf0Items` | union | 0 | 0 |
| `AuditActorType` | string | 0 | 0 |
| `AuditResourceType` | string | 0 | 0 |
| `BackgroundChatTask` | object | 16 | 12 |
| `BackgroundChatTaskStatus` | string | 0 | 0 |
| `BackgroundChatTaskType` | string | 0 | 0 |
| `BackgroundTaskError` | object | 3 | 1 |
| `BackgroundTaskListOrder` | string | 0 | 0 |
| `BatchUploadFileResponse` | object | 1 | 1 |
| `BatchUploadFileResponseDataItems` | union | 0 | 0 |
| `BilledUnits` | object | 4 | 0 |
| `BodyOauthRevokeOauthRevokePostTokenTypeHint` | string | 0 | 0 |
| `BodyOauthTokenOauthTokenPostGrantType` | string | 0 | 0 |
| `Body_oauth_revoke_oauth_revoke_post` | object | 4 | 1 |
| `Body_oauth_token_oauth_token_post` | object | 8 | 1 |
| `BulkDeleteLocalLibraryFilesRequest` | object | 1 | 1 |
| `BulkLocalLibraryFileOperationResponse` | object | 1 | 1 |
| `CancelConversationBackgroundTaskResponseV2` | object | 4 | 4 |
| `ConnectorTokenConfig` | object | 4 | 2 |
| `ConnectorTokenConfigTokenType` | string | 0 | 0 |
| `ConversationBackgroundTask` | object | 11 | 6 |
| `ConversationFile` | object | 6 | 5 |
| `ConversationFileListOrder` | string | 0 | 0 |
| `ConversationListOrder` | string | 0 | 0 |
| `ConversationSummary` | object | 8 | 4 |
| `ConversationTitleSource` | string | 0 | 0 |
| `ConversationType` | string | 0 | 0 |
| `CreateAgentRequestV2` | object | 9 | 1 |
| `CreateAgentRequestV2Model` | union | 0 | 0 |
| `CreateAgentRequestV2ToolsItems` | union | 0 | 0 |
| `CreateConversationRequestV2` | object | 3 | 1 |
| `DeleteFileResponse` | object | 2 | 2 |
| `DeleteMCPResponse` | object | 0 | 0 |
| `Delta` | object | 1 | 1 |
| `DeltaStreamEnd` | object | 4 | 0 |
| `DeveloperMessageItemParam` | object | 5 | 1 |
| `DeveloperMessageItemParamContent` | union | 0 | 0 |
| `DeveloperMessageItemParamContent0` | array | 0 | 0 |
| `EmptyModelParam` | object | 0 | 0 |
| `ExchangeResource` | object | 3 | 3 |
| `ExchangeResourceType` | string | 0 | 0 |
| `FeedbackType` | string | 0 | 0 |
| `FileData` | string | 0 | 0 |
| `FileObject` | object | 7 | 5 |
| `FileUploadStatus` | string | 0 | 0 |
| `FunctionCallItemParam` | object | 6 | 3 |
| `FunctionCallOutputItemParam` | object | 5 | 2 |
| `FunctionCallOutputItemParamOutput` | union | 0 | 0 |
| `FunctionCallOutputItemParamOutput1` | array | 0 | 0 |
| `FunctionCallOutputItemParamOutputOneOf1Items` | union | 0 | 0 |
| `FunctionCallOutputStatusEnum` | string | 0 | 0 |
| `FunctionCallStatus` | string | 0 | 0 |
| `FunctionToolChoice` | object | 2 | 0 |
| `GoogleDriveFileResource` | object | 4 | 2 |
| `GuardrailAction` | string | 0 | 0 |
| `Icon` | object | 3 | 1 |
| `IdpTokenConfig` | object | 2 | 1 |
| `ImageDetail` | string | 0 | 0 |
| `ImageURL` | object | 2 | 1 |
| `IncludeEnum` | string | 0 | 0 |
| `IncompleteDetails` | object | 1 | 1 |
| `Input` | string | 0 | 0 |
| `InputTextContentParam` | object | 1 | 1 |
| `InputTokensDetails` | object | 1 | 1 |
| `InvalidateMCPCapabilitiesCacheResponse` | object | 1 | 1 |
| `ItemField` | union | 0 | 0 |
| `ItemParam` | union | 0 | 0 |
| `ItemReferenceParam` | object | 2 | 1 |
| `JsonObjectResponseFormat` | object | 1 | 0 |
| `JsonSchemaResponseFormat` | object | 5 | 4 |
| `JsonSchemaResponseFormatParam` | object | 5 | 0 |
| `ListAgentJobsResponseV2` | object | 1 | 1 |
| `ListAgentsResponseV2` | object | 2 | 1 |
| `ListConversationBackgroundTasksResponseV2` | object | 2 | 1 |
| `ListConversationFilesResponseV2` | object | 2 | 1 |
| `ListConversationsResponseV2` | object | 2 | 1 |
| `ListFilesOrder` | string | 0 | 0 |
| `ListFilesResponse` | object | 2 | 1 |
| `ListLibrariesResponse` | object | 2 | 1 |
| `ListLocalLibrariesResponse` | object | 2 | 1 |
| `ListLocalLibraryFilesResponse` | object | 2 | 1 |
| `ListMessagesResponseV2` | object | 2 | 1 |
| `ListMessagesResponseV2DataItems` | union | 0 | 0 |
| `ListModelsResponseV2` | object | 2 | 1 |
| `LogProb` | object | 4 | 4 |
| `LogProbs` | object | 3 | 1 |
| `MCPHeaders` | object | 5 | 0 |
| `MCPPermissionMembersRequest` | object | 1 | 1 |
| `MCPPermissionMembersResponse` | object | 3 | 2 |
| `MCPServerCreator` | object | 3 | 1 |
| `MCPServerDetailResponse` | object | 20 | 6 |
| `MCPServerResponse` | object | 16 | 7 |
| `MCPToolPermissionMembersResponse` | object | 5 | 4 |
| `MCPToolPolicyBatchItemResponse` | object | 3 | 1 |
| `MCPToolPolicyBatchRequest` | object | 1 | 0 |
| `MCPToolPolicyBatchResponse` | object | 1 | 0 |
| `MCPToolPolicyRequest` | object | 3 | 0 |
| `MCPToolPolicyResponse` | object | 4 | 1 |
| `MaxOutputTokens` | integer | 0 | 0 |
| `MaxToolCalls` | integer | 0 | 0 |
| `MessageDelta` | object | 6 | 0 |
| `MessageDeltaContent` | union | 0 | 0 |
| `MessageListOrder` | string | 0 | 0 |
| `MessageRole` | string | 0 | 0 |
| `MessageStartDelta` | object | 1 | 1 |
| `MessageStartDeltaMessage` | object | 1 | 1 |
| `MessageStatus` | string | 0 | 0 |
| `MetadataParam` | object | 0 | 0 |
| `ModelObject` | object | 3 | 2 |
| `ModelProvider` | string | 0 | 0 |
| `ModelSummary` | object | 9 | 5 |
| `MyDriveFileResource` | object | 3 | 2 |
| `NorthAgent` | object | 13 | 10 |
| `NorthAgentConfig` | object | 1 | 1 |
| `NorthAgentCreateRequest` | object | 9 | 2 |
| `NorthAgentCreateRequestToolsItems` | union | 0 | 0 |
| `NorthAgentToolsItems` | union | 0 | 0 |
| `NorthAgentUpdateRequest` | object | 9 | 0 |
| `NorthAgentUpdateRequestToolsItems` | union | 0 | 0 |
| `NorthAssistantMessage` | object | 11 | 0 |
| `NorthAuditActionInfo` | object | 1 | 1 |
| `NorthAuditRecord` | object | 15 | 5 |
| `NorthAutomation` | object | 10 | 5 |
| `NorthAutomationListResponse` | object | 4 | 4 |
| `NorthAutomationVisibility` | string | 0 | 0 |
| `NorthAutomationsOutputFile` | object | 3 | 3 |
| `NorthAutomationsOutputFileContent` | object | 3 | 3 |
| `NorthCancelExecutionResponse` | object | 2 | 2 |
| `NorthChatError` | object | 3 | 1 |
| `NorthChatResponse` | object | 5 | 2 |
| `NorthChatResponseMessagesItems` | union | 0 | 0 |
| `NorthCitation` | object | 6 | 3 |
| `NorthCitationSourcesItems` | union | 0 | 0 |
| `NorthCitationType` | string | 0 | 0 |
| `NorthConversation` | object | 8 | 1 |
| `NorthConversationReference` | object | 1 | 1 |
| `NorthConversationWithMessages` | object | 10 | 2 |
| `NorthConversationWithMessagesMessagesItems` | union | 0 | 0 |
| `NorthConversationWithMessagesMessagesItemsDiscriminatorMappingAssistantContent` | union | 0 | 0 |
| `NorthConversationWithMessagesMessagesItemsDiscriminatorMappingAssistantContent0` | array | 0 | 0 |
| `NorthConversationWithMessagesMessagesItemsDiscriminatorMappingAssistantContentOneOf0Items` | union | 0 | 0 |
| `NorthCreateLibraryRequest` | object | 4 | 2 |
| `NorthCreateLocalLibraryRequest` | object | 2 | 1 |
| `NorthCreateUserRequest` | object | 6 | 3 |
| `NorthDocument` | object | 2 | 1 |
| `NorthDocumentContent` | object | 1 | 1 |
| `NorthDocumentEdit` | object | 5 | 0 |
| `NorthErrorResponse` | object | 8 | 6 |
| `NorthErrorType` | string | 0 | 0 |
| `NorthExecuteAutomationRequest` | object | 1 | 0 |
| `NorthExecuteAutomationRequestInputs` | union | 0 | 0 |
| `NorthExecution` | object | 22 | 6 |
| `NorthExecutionListResponse` | object | 4 | 4 |
| `NorthExecutionStatus` | string | 0 | 0 |
| `NorthFile` | object | 6 | 5 |
| `NorthFileIndexingStatus` | string | 0 | 0 |
| `NorthFileItem` | object | 2 | 2 |
| `NorthFileStatus` | object | 4 | 2 |
| `NorthFileType` | string | 0 | 0 |
| `NorthFinishReason` | string | 0 | 0 |
| `NorthFunctionToolDefinition` | object | 3 | 1 |
| `NorthGroupPermissionsResponse` | object | 3 | 2 |
| `NorthHostedToolDefinition` | object | 2 | 1 |
| `NorthHumanReviewTask` | object | 9 | 5 |
| `NorthImageDetail` | string | 0 | 0 |
| `NorthInputParameter` | object | 6 | 4 |
| `NorthInputType` | string | 0 | 0 |
| `NorthJobState` | string | 0 | 0 |
| `NorthLibrary` | object | 12 | 10 |
| `NorthLibraryArtifact` | object | 3 | 3 |
| `NorthLibraryArtifactType` | string | 0 | 0 |
| `NorthLibraryDetail` | object | 14 | 12 |
| `NorthLibraryType` | string | 0 | 0 |
| `NorthListAuditActionsResponse` | object | 2 | 1 |
| `NorthListAuditsResponse` | object | 2 | 1 |
| `NorthListPermissionsResponse` | object | 1 | 1 |
| `NorthLocalLibrary` | object | 11 | 10 |
| `NorthLocalLibraryDetail` | object | 12 | 11 |
| `NorthLocalLibraryFile` | object | 8 | 7 |
| `NorthLocalLibraryFileError` | object | 3 | 3 |
| `NorthLocalLibraryFileResult` | object | 4 | 2 |
| `NorthLocalLibraryFileResultStatus` | string | 0 | 0 |
| `NorthModel` | object | 1 | 1 |
| `NorthModelPermissionMembersResponse` | object | 7 | 5 |
| `NorthNodeExecution` | object | 8 | 2 |
| `NorthNodeStatus` | string | 0 | 0 |
| `NorthPermissionAssigneesResponse` | object | 3 | 2 |
| `NorthPermissionInfo` | object | 4 | 4 |
| `NorthPermissionMemberFailure` | object | 2 | 2 |
| `NorthPublicationStatus` | string | 0 | 0 |
| `NorthRole` | string | 0 | 0 |
| `NorthRunOrigin` | string | 0 | 0 |
| `NorthSafetyMode` | string | 0 | 0 |
| `NorthSigninRequest` | object | 2 | 2 |
| `NorthStreamOptions` | object | 1 | 0 |
| `NorthSubmitInputsRequest` | object | 1 | 1 |
| `NorthSubmitInputsRequestInputs` | union | 0 | 0 |
| `NorthSubmitReviewResponse` | object | 1 | 1 |
| `NorthSystemMessageResponseContent` | union | 0 | 0 |
| `NorthSystemMessageResponseContent0` | array | 0 | 0 |
| `NorthTextContent` | object | 2 | 1 |
| `NorthThinkingContent` | object | 2 | 1 |
| `NorthTokenExchangeRequest` | object | 6 | 1 |
| `NorthTokenExchangeRequestScope` | union | 0 | 0 |
| `NorthToolCall` | object | 9 | 1 |
| `NorthToolCallElicitation` | object | 6 | 2 |
| `NorthToolChoice` | string | 0 | 0 |
| `NorthToolFunctionMessage` | object | 2 | 0 |
| `NorthToolMessage` | object | 4 | 1 |
| `NorthToolMessageResponseContent` | union | 0 | 0 |
| `NorthToolMessageResponseContent0` | array | 0 | 0 |
| `NorthToolMessageResponseContentOneOf0Items` | union | 0 | 0 |
| `NorthUpdateLibraryRequest` | object | 4 | 0 |
| `NorthUpdateLocalLibraryRequest` | object | 2 | 0 |
| `NorthUpdateModelPermissionMembersResponse` | object | 10 | 6 |
| `NorthUpdatePermissionMembersRequest` | object | 1 | 1 |
| `NorthUpdatePermissionMembersResponse` | object | 6 | 3 |
| `NorthUpdateUserRequest` | object | 7 | 0 |
| `NorthUser` | object | 7 | 5 |
| `NorthUserMessageResponseContent` | union | 0 | 0 |
| `NorthUserMessageResponseContent0` | array | 0 | 0 |
| `NorthUserMessageResponseContentOneOf0Items` | union | 0 | 0 |
| `NorthUserPermissionsResponse` | object | 2 | 1 |
| `NorthUserToken` | object | 1 | 1 |
| `NorthVisibility` | string | 0 | 0 |
| `OAuth2ErrorResponse` | object | 2 | 1 |
| `OAuthClientCredentialsConfig` | object | 7 | 4 |
| `OauthAuthorizeGetParametersCodeChallengeMethod` | string | 0 | 0 |
| `OauthAuthorizeGetParametersResponseType` | string | 0 | 0 |
| `OneDriveResource` | object | 3 | 3 |
| `OneDriveResourceType` | string | 0 | 0 |
| `OutlookResource` | object | 3 | 3 |
| `OutlookResourceType` | string | 0 | 0 |
| `OutputTokensDetails` | object | 1 | 1 |
| `Prompt` | object | 6 | 1 |
| `PromptArgument` | object | 3 | 1 |
| `PromptCacheKey` | string | 0 | 0 |
| `ProviderInfo` | object | 2 | 2 |
| `Reasoning` | object | 2 | 2 |
| `ReasoningEffortEnum` | string | 0 | 0 |
| `ReasoningItemParam` | object | 5 | 1 |
| `ReasoningOptions` | object | 2 | 0 |
| `ReasoningParam` | object | 2 | 0 |
| `ReasoningSummaryContentParam` | object | 2 | 1 |
| `ReasoningSummaryEnum` | string | 0 | 0 |
| `ResetMCPToolPermissionMembersResponse` | object | 3 | 2 |
| `ResponsesError` | object | 2 | 2 |
| `ResponsesImageUrl` | string | 0 | 0 |
| `ResponsesTool` | union | 0 | 0 |
| `ResponsesToolParam` | union | 0 | 0 |
| `ResponsesUsage` | object | 5 | 5 |
| `SafetyIdentifier` | string | 0 | 0 |
| `ServiceTierEnum` | string | 0 | 0 |
| `SharePointResource` | object | 3 | 3 |
| `SharePointResourceType` | string | 0 | 0 |
| `SpecificToolChoiceParam` | unspecified | 0 | 0 |
| `StreamOptionsParam` | object | 1 | 0 |
| `SupportedParameter` | string | 0 | 0 |
| `SystemMessageItemParam` | object | 5 | 1 |
| `SystemMessageItemParamContent` | union | 0 | 0 |
| `SystemMessageItemParamContent0` | array | 0 | 0 |
| `TestConnectionRequest` | object | 10 | 2 |
| `TestMCPConnectionResponse` | object | 5 | 2 |
| `TextField` | object | 2 | 1 |
| `TextFieldFormat` | union | 0 | 0 |
| `TextFormatParam` | union | 0 | 0 |
| `TextParam` | object | 2 | 0 |
| `TextResponseFormat` | object | 1 | 0 |
| `ThinkingMode` | string | 0 | 0 |
| `Tokens` | object | 2 | 0 |
| `Tool` | object | 9 | 2 |
| `ToolAnnotations` | object | 5 | 0 |
| `ToolCallElicitationMode` | string | 0 | 0 |
| `ToolCallElicitationState` | string | 0 | 0 |
| `ToolCallParameterMetadata` | object | 2 | 0 |
| `ToolCallState` | string | 0 | 0 |
| `ToolChoiceParam` | union | 0 | 0 |
| `ToolChoiceValueEnum` | string | 0 | 0 |
| `ToolExecution` | object | 1 | 0 |
| `ToolExecutionTaskSupport` | string | 0 | 0 |
| `ToolPolicyType` | string | 0 | 0 |
| `TopLogProb` | object | 3 | 3 |
| `TopLogprobs` | integer | 0 | 0 |
| `TruncationEnum` | string | 0 | 0 |
| `UpdateAgentRequestV2` | object | 9 | 0 |
| `UpdateAgentRequestV2Model` | union | 0 | 0 |
| `UpdateAgentRequestV2ToolsItems` | union | 0 | 0 |
| `UpdateConversationRequestV2` | object | 2 | 0 |
| `UpdateMCPPermissionMembersResponse` | object | 6 | 3 |
| `UpdateMCPResponse` | object | 1 | 1 |
| `UpdateMCPToolPermissionMembersResponse` | object | 8 | 5 |
| `UpdateMCPToolPolicyResponse` | object | 9 | 5 |
| `UrlCitationParam` | object | 5 | 4 |
| `Usage` | object | 3 | 0 |
| `UserMessageItemParam` | object | 5 | 1 |
| `UserMessageItemParamContent` | union | 0 | 0 |
| `UserMessageItemParamContent0` | array | 0 | 0 |
| `UserMessageItemParamContentOneOf0Items` | union | 0 | 0 |
| `V1ChatPostRequestBodyContentApplicationJsonSchemaCitationOptions` | union | 0 | 0 |
| `V1ChatPostRequestBodyContentApplicationJsonSchemaDocumentsItems` | union | 0 | 0 |
| `V1ChatPostRequestBodyContentApplicationJsonSchemaMessagesItems` | union | 0 | 0 |
| `V1ChatPostRequestBodyContentApplicationJsonSchemaMessagesItemsDiscriminatorMappingAssistantContent` | union | 0 | 0 |
| `V1ChatPostRequestBodyContentApplicationJsonSchemaMessagesItemsDiscriminatorMappingAssistantContent0` | array | 0 | 0 |
| `V1ChatPostRequestBodyContentApplicationJsonSchemaMessagesItemsDiscriminatorMappingAssistantContentOneOf0Items` | union | 0 | 0 |
| `V1ChatPostRequestBodyContentApplicationJsonSchemaMessagesItemsDiscriminatorMappingSystemContent` | union | 0 | 0 |
| `V1ChatPostRequestBodyContentApplicationJsonSchemaMessagesItemsDiscriminatorMappingSystemContent0` | array | 0 | 0 |
| `V1ChatPostRequestBodyContentApplicationJsonSchemaMessagesItemsDiscriminatorMappingToolContent` | union | 0 | 0 |
| `V1ChatPostRequestBodyContentApplicationJsonSchemaMessagesItemsDiscriminatorMappingToolContent0` | array | 0 | 0 |
| `V1ChatPostRequestBodyContentApplicationJsonSchemaMessagesItemsDiscriminatorMappingToolContentOneOf0Items` | union | 0 | 0 |
| `V1ChatPostRequestBodyContentApplicationJsonSchemaMessagesItemsDiscriminatorMappingUserContent` | union | 0 | 0 |
| `V1ChatPostRequestBodyContentApplicationJsonSchemaMessagesItemsDiscriminatorMappingUserContent0` | array | 0 | 0 |
| `V1ChatPostRequestBodyContentApplicationJsonSchemaMessagesItemsDiscriminatorMappingUserContentOneOf0Items` | union | 0 | 0 |
| `V1ChatPostRequestBodyContentApplicationJsonSchemaResponseFormat` | union | 0 | 0 |
| `V1ChatPostRequestBodyContentApplicationJsonSchemaToolsItems` | union | 0 | 0 |
| `V1ChatPostRequestBodyContentApplicationJsonSchemaTruncationStrategy` | union | 0 | 0 |
| `V1ChatPostResponsesStreamMessagesItems` | union | 0 | 0 |
| `V1ResponsesPostRequestBodyContentApplicationJsonSchemaInput` | union | 0 | 0 |
| `V1ResponsesPostRequestBodyContentApplicationJsonSchemaInput1` | array | 0 | 0 |
| `V1ResponsesPostResponsesStreamDiscriminatorMappingFunctionCallOutputOutput` | union | 0 | 0 |
| `V1ResponsesPostResponsesStreamDiscriminatorMappingFunctionCallOutputOutput1` | array | 0 | 0 |
| `V1ResponsesPostResponsesStreamDiscriminatorMappingFunctionCallOutputOutputOneOf1Items` | union | 0 | 0 |
| `V1ResponsesPostResponsesStreamDiscriminatorMappingMessageContentItems` | union | 0 | 0 |
| `V1ResponsesPostResponsesStreamDiscriminatorMappingReasoningContentItems` | union | 0 | 0 |
| `V1ResponsesPostResponsesStreamDiscriminatorMappingReasoningSummaryItems` | union | 0 | 0 |
| `V1ResponsesPostResponsesStreamToolChoice` | union | 0 | 0 |
| `V2ConversationsConversationIdMessagesMessageIdGetResponsesContentApplicationJsonSchemaDiscriminatorMappingAssistantContent` | union | 0 | 0 |
| `V2ConversationsConversationIdMessagesMessageIdGetResponsesContentApplicationJsonSchemaDiscriminatorMappingAssistantContent0` | array | 0 | 0 |
| `V2ConversationsConversationIdMessagesMessageIdGetResponsesContentApplicationJsonSchemaDiscriminatorMappingAssistantContentOneOf0Items` | union | 0 | 0 |
| `V2ConversationsConversationIdMessagesMessageIdGetResponsesContentApplicationJsonSchemaDiscriminatorMappingSystemContent` | union | 0 | 0 |
| `V2ConversationsConversationIdMessagesMessageIdGetResponsesContentApplicationJsonSchemaDiscriminatorMappingSystemContent0` | array | 0 | 0 |
| `V2ConversationsConversationIdMessagesMessageIdGetResponsesContentApplicationJsonSchemaDiscriminatorMappingToolContent` | union | 0 | 0 |
| `V2ConversationsConversationIdMessagesMessageIdGetResponsesContentApplicationJsonSchemaDiscriminatorMappingToolContent0` | array | 0 | 0 |
| `V2ConversationsConversationIdMessagesMessageIdGetResponsesContentApplicationJsonSchemaDiscriminatorMappingToolContentOneOf0Items` | union | 0 | 0 |
| `V2ConversationsConversationIdMessagesMessageIdGetResponsesContentApplicationJsonSchemaDiscriminatorMappingUserContent` | union | 0 | 0 |
| `V2ConversationsConversationIdMessagesMessageIdGetResponsesContentApplicationJsonSchemaDiscriminatorMappingUserContent0` | array | 0 | 0 |
| `V2ConversationsConversationIdMessagesMessageIdGetResponsesContentApplicationJsonSchemaDiscriminatorMappingUserContentOneOf0Items` | union | 0 | 0 |
| `VerbosityEnum` | string | 0 | 0 |
| `chat_Response_stream` | object | 5 | 2 |
| `chat_Response_stream_streaming` | union | 0 | 0 |
| `responses_create_Response_stream` | object | 31 | 30 |
| `responses_create_Response_stream_streaming` | union | 0 | 0 |
| `v2_conversations_messages_retrieve_Response_200` | union | 0 | 0 |

## 8. Clean-room boundary

The OpenAPI contract supports reconstructing resources, validation, authorization checks, streaming consumers, and client SDKs. It does **not** disclose database schemas, queue technology, retrieval algorithms, model prompts, internal service boundaries, or scheduler implementation. Those must be designed independently and tested against the observable public contract.

## Sources

[11] https://private.docs.cohere.com/openapi/north.yaml
[58] https://private.docs.cohere.com/reference/open-responses-compatibility
[59] https://private.docs.cohere.com/reference/chat-stream

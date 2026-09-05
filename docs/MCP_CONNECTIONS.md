# Connected agents — implementation specification

**Status:** TODO, selected for the September 6 development handoff. This is the
remaining M05 extension, not a claim that MCP ships. **Baseline:** `e2e6a78`.
**Depends on:** the schema/runtime prerequisite gate in
[DEVELOPMENT_HANDOFF.md](DEVELOPMENT_HANDOFF.md). **Effort:** L–XL.

## Outcome and scope

A desktop operator can add a Streamable HTTP or stdio MCP connection, test it,
sign in when required, select discovered tools for an agent, and use those tools
in a normal durable chat turn. The user sees bounded activity and useful output.
Agent edits affect the next accepted turn; running turns retain their selected
configuration. A reusable job can suggest prompts, an output template, and
libraries, which the user confirms into explicit source selection.

This specification completes the pending stage of
[AGENT_EDITOR_ROLLOUT.md](AGENT_EDITOR_ROLLOUT.md). Both transports, OAuth,
connection lifecycle, cancellation, and packaged desktop execution are required.
No tool-discovery-only screen or mocked execution counts as completion.

Use the official TypeScript SDK. The [SDK guide](https://ts.sdk.modelcontextprotocol.io/)
documents clients, tool discovery/calls, stdio and Streamable HTTP, and OAuth
examples. Check the supported Node 22 SDK release and its matching docs before
pinning dependencies; do not mix v1 import examples with a v2 package. The
[transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
and [authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
specifications are dated references checked during this handoff. Record the
negotiated protocol and SDK release actually implemented in the API guide.

## Current code and files to own

`server/src/agentConfiguration.ts` currently restricts tools to:

```ts
export const AGENT_TOOLS = [
  "retrieve", "list_sources", "query_data", "describe_data",
  "render_chart", "create_report", "fetch_url",
] as const;
```

`server/src/agent.ts` filters `TOOL_DEFS` against `opts.agentTools`, and
`server/src/tools.ts:executeTool` dispatches only those built-ins. Extend these
boundaries together. Keep the old `tools: string[]` meaning built-in selection;
introduce a separate MCP binding collection so old clients remain compatible.
`server/src/db/stores/chatStore.ts:acceptChatTurn` is the atomic snapshot owner;
`server/src/turnContext.ts` exposes its accepted turn. Network discovery never
runs while a SQLite write transaction is open.

Expected new modules: `server/src/connections/{store,secrets,service}.ts`,
`server/src/mcp/{client,tools,oauth}.ts`, `server/src/routes/connections.ts`,
`web/src/components/ConnectionsPanel.tsx`, and focused tests. Integrate with
`server/src/routes.ts`, `storageRuntime.ts`, the prerequisite's owned application
runtime, `agentConfiguration.ts`, agent/chat stores, agent/tool execution,
`web/src/lib/api.ts`, `AgentEditor.tsx`, `SettingsView.tsx`, and chat creation.
Desktop integration belongs in `desktop/src/main.ts` and its owned services;
do not add generic shell/network/secret APIs to the preload.

Match account-scoped stores and `withImmediateTransaction` from `agentStore.ts`,
`onRequest: requireAuth` and schema-derived body ceilings from agent routes,
keyset catalogs, and exact request-generation/abort ownership from the existing
editor and Settings hooks. Use ESM `.js` server imports, Node 22 and pnpm 10.

## Proposed contracts — implement before documenting as current API

### Connections and secret custody

- `connections`: UUID, owner account, name (1–80 chars), kind, revision,
  validated non-secret configuration, enabled flag, bounded status, timestamps.
  Initially kinds `mcp_http` and `mcp_stdio`; reserve an adapter interface for
  M14's `webdav`. Maximum 20 connections/account. No new schema number below 17;
  integrate only after real v14–v16 and their tests have landed.
- `connection_tool_snapshots`: discovery revision and canonical tool descriptors
  with stable IDs, original names, validated input schemas, and description.
  List at most 200 tools, 16 KiB per descriptor and 512 KiB total; report an
  explicit over-limit discovery error rather than silently missing tools.
- Separate account/connection-scoped secret references from SQLite DTOs.
  Implement one reusable server-side secret-store interface for MCP and WebDAV.
  On desktop use OS-protected key custody through main; browser development
  uses an operator-managed private key file and encrypted atomic secret records.
  Never return stored credentials; mutations accept replacement or explicit
  removal. Do not put access/refresh tokens into agent revisions or run metadata.
  Missing/unavailable key custody gives an actionable disconnected state.
- Default archive behavior: workspace metadata and encrypted connection records
  are included, but machine-bound keys, OAuth sessions, and folder grants are
  not portable. Restore must show reconnect/reselect state without discarding
  indexed sources or saved outputs. Extend archive manifests and verification
  when new durable paths are introduced; never silently omit new work products.

Proposed endpoints, all authenticated and account-scoped except the narrowly
scoped one-use OAuth callback described below:

| Endpoint | Contract |
| -------- | -------- |
| `GET/POST /api/connections` | Keyset catalog/create; create stores configuration but does not discover or execute tools |
| `GET/PATCH/DELETE /api/connections/:id` | Redacted detail, revision-checked edit, disconnect and delete; bindings become visibly unavailable |
| `POST /api/connections/:id/test` | Bounded initialize/list-tools test; no content-bearing tool call |
| `POST /api/connections/:id/discover` | Publish a validated tool snapshot, returning revision and tool catalog |
| `POST /api/connections/:id/authorize` | Start one expiring OAuth session, returning a validated sign-in action |
| `DELETE /api/connections/:id/authorization` | Revoke local credentials and disconnect; provider revocation best effort |

Use explicit stable `CONNECTION_*` error codes with generic public messages.
Concurrent edits return `409` on a stale expected revision. Discovery/test times
out after 15 seconds. A UI can close while testing, but late results cannot
change another connection; saving follows the busy-dialog pattern.

### Transport and execution

HTTP connections accept a full endpoint path, unlike the model provider's bare
origin. Require HTTPS except explicitly configured loopback/`.local` development
targets. Connection targets are intentional outbound capabilities; do not reuse
`fetch_url` or widen its public-only, current-turn-URL contract. Bind credentials
to the validated target, refuse arbitrary redirects, and validate/pin resolved
addresses according to the operator-approved connection boundary.

Stdio configuration is operator-only: an absolute installed executable, explicit
argument vector (at most 32 × 200 characters), approved working directory and
explicit environment secrets. Spawn directly without a shell. Never install a
package or run `npx` from a tool descriptor. The initial test integration can be
a checked-in Node fixture, invoked with the supported absolute Node executable.
Standard-output protocol bytes go only to the SDK parser; never log stdout or
stderr. Own children, stop/cancel them on disconnect and shutdown, and prove no
orphan process survives. Stdio tools have the privileges of that configured
process; the UI must not call them sandboxed.

Use stable opaque model-facing tool aliases of at most 64 valid characters;
persist alias → connection/tool/discovery-revision mapping in the accepted run.
Allow at most 16 selected MCP tools per agent and validate input JSON against the
captured schema before dispatch. Bound each argument/result to 32 KiB/64 KiB,
respect the stricter existing agent conversation/result budget, and use a
30-second tool deadline within the parent run deadline. Reject unsupported
schema shapes at selection rather than pretending they are callable. Unsupported
media/resource-link output is reported explicitly; do not auto-fetch links.

Connection/schema revisions are frozen for a run, but revocation/disable is
checked before each call and can stop future execution. Credential refresh may
renew the same authorized target; it cannot retarget an accepted run. Do not
persist expired tokens to make snapshots replayable. Discovered schemas and
tool output are untrusted context, not instructions or permission grants.

Default to read-oriented integrations for this wave. Exclude external write
tools from selection unless a later explicit action-approval contract is added;
do not trust a server's read-only annotation as proof. Record operator-selected
allowlists and label the capability honestly. Do not advertise or enable MCP
sampling, server-driven URL opening, roots access, arbitrary elicitation, or
agent delegation capabilities in this first client.

### OAuth and job setup

Use SDK-supported authorization-code flow with PKCE, expiring one-use state,
resource/audience binding, and serialized refresh per connection. Support
configured client registration plus discovered registration when supported;
an unsupported issuer gives actionable setup instructions, not a fake success.
Open a validated authorization URL only after a sign-in click. Desktop uses the
system browser and an exact loopback callback listener owned by main, with
state/PKCE verification and a 5-minute expiry. That callback accepts no workspace
session credentials and is not a general public resource API. Cancel/deny,
callback replay, token expiry, provider logout, and refresh failure are normal
tested states. Browser-development OAuth must also complete through a bounded
loopback flow; no production login token enters renderer storage.

Add versioned agent job setup: up to 5 starter prompts (2,000 chars each), one
optional output template reference, and up to 10 suggested library IDs, with
the normal 100-source cap on expansion. New job chats remain selected-empty
until the user confirms the expanded ready-source list. Empty/missing libraries
are visible; never fall back to `all`. Before M13 templates exist, support an
explicit bounded instruction template; migrate references compatibly when the
document template catalog lands. Test chat uses real accepted turns, not an
editor-only provider call. Provide two editable starter jobs: finance analysis
and diligence memo, with no implicit attached data or required remote service.

## Implementation sequence and validation

1. Reconcile baseline and choose matching SDK release; establish connection and
   secret abstractions, schema/store/route tests, and lifecycle ownership. Add
   matching runtime dependencies to server and desktop from the workspace root,
   keeping pins in `pnpm.overrides` as required. Run server typecheck and focused
   `connectionStore.test.ts` / `connectionRoutes.test.ts` tests after adding them.
2. Implement HTTP and stdio clients and bounded discovery against real local
   protocol fixtures. Add `mcpClient.test.ts` for each transport, invalid schema,
   pagination limits, malformed results, timeout, cancellation and child exit.
   `pnpm --filter borealis-server exec vitest run src/tests/mcpClient.test.ts`
   must pass without external accounts.
3. Implement OAuth plus secret custody. Add `mcpOAuth.test.ts` and desktop
   callback/key-custody tests. Verify authorization, refresh, cancellation and
   reconnect with an actual local OAuth fixture. Run server tests and
   `pnpm --filter borealis-desktop verify` on the supported Mac.
4. Extend agent revisions and atomic turn snapshots, then definition filtering
   and dispatch together. Add `mcpAgentTurn.test.ts` in the integration partition,
   modeled after `chatStore.test.ts` and the prerequisite vertical agent test.
   Verify an allowed call works, a removed/foreign/disabled call fails, a running
   turn keeps its mapping, and restart does not replay external tool side effects.
5. Build Connections Settings, agent tool selection, job presets and test chat.
   Add `ConnectionsPanel.test.tsx` and extend `AgentEditor`/chat tests. Run web
   test/typecheck/build, including stale requests, dark/light and narrow layouts.
   Add complete browser and packaged desktop scenarios to the common E2E harness.
6. Update API/README/AGENTS/desktop setup, archive/reconnect behavior, rollout,
   dependency pins and evidence ledger. Run all final gates in
   [END_TO_END_ACCEPTANCE.md](END_TO_END_ACCEPTANCE.md).

For each stage, `pnpm --filter borealis-server typecheck`, server lint and
format checks must pass. Assign real-storage tests to the prerequisite's
integration partition; passing a command that found no tests is not acceptance.

## Completion and maintenance

- [ ] Both transports complete discovery and a real selected-tool chat call.
- [ ] OAuth succeeds, refreshes, expires, cancels, and reconnects in real fixtures.
- [ ] Agent/job revisions and running-turn behavior satisfy the snapshot contract.
- [ ] Browser and packaged desktop paths work, including secret custody and cleanup.
- [ ] WebDAV can reuse the secret-store interface without changing MCP semantics.
- [ ] Archive/restore retains work but requires reconnection for machine-bound grants.
- [ ] Root and platform gates plus the common E2E matrix pass; docs describe actual behavior.

Continue through routine drift and fix test failures. If a provider SDK cannot
support the required transport or the platform cannot supply protected custody,
investigate supported alternatives and record evidence. Do not mark complete,
ship a disabled stub as the feature, or fall back to plaintext renderer secrets.
Any newly discovered need for generic process execution, broad preload access,
or external write automation requires a separate explicit scope decision.

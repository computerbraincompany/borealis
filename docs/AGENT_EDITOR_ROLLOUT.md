# Rich agent editor rollout

**Functional-wave acceptance completed 2026-09-07.** The connected-agent and
job extensions passed final browser and packaged native validation, including
secure OAuth refresh and frozen selected-tool execution. Current proof is in
[EXECUTION.md](../milestones/EXECUTION.md); the sequencing and dated records
below explain how this completed baseline was built.

The September 5 sequencing decision placed the agent editor at v13 ahead of
the remediation migrations. Those migrations subsequently shipped at v14–v16,
followed by MCP and the functional wave at v17–v28. Applied history is unchanged.

## Shipped foundation and integration sequence

1. **Editor foundation (v13), complete in `0987170`:** shared create/edit modal; persisted description,
   icon and color; atomic prompt/capability revisions; account-owned Markdown
   skills; built-in tool selection and immutable accepted-turn snapshots.
2. **Remediation migrations, complete:** provider-bound consent landed in v14,
   automation target ownership in v15, and typed connector refresh/repair in
   v16, so the handoff's prerequisite closure preceded the product migrations
   (v17+) with no placeholder migrations and no changes to applied history.
3. **MCP runtime and editor, implemented:** the official TypeScript client
   (pinned `@modelcontextprotocol/sdk` 1.30.0, negotiated protocol
   `2025-11-25`) runs both Streamable HTTP and stdio connections; discovery
   publishes bounded tool snapshots (schema v17), credentials live only in
   isolated secret custody, OAuth sign-in/refresh is authorization-code with
   PKCE through the backend-owned loopback callback, accepted turns freeze the
   per-run binding map in `chat_runs.agent_mcp_tools` (schema v21) with
   per-call revocation/custody re-checks, and stdio children are owned through
   disconnect/cancellation/shutdown. The shipped editor surface is the
   Settings → Connections panel, the AgentEditor Connected and Job tabs, and
   the job-confirmation card on chat creation. The current contracts are
   documented in the API reference under "Connections (Connected agents)",
   "Connected tools in durable chat turns", and "Jobs: versioned job setup and
   chat creation from a job".

MCP storage owns v17 and accepted-turn snapshots own v21. Reconcile the complete
applied sequence against the ledger before introducing the next migration.

The [selected functional roadmap](../milestones/README.md#selected-functional-wave)
tracked the MCP scope together with reusable job setup; both are now
implemented. The full
[connected-agent specification](MCP_CONNECTIONS.md) and
[development handoff](DEVELOPMENT_HANDOFF.md) supply implementation and acceptance
details, including the prerequisite closure that preceded the new durable
schema work. Job setup adds up to five starter prompts, one bounded
instruction output template or an owned/built-in document-template reference,
and up to ten suggested library ids to an agent revision. The template’s bounded
structure is captured with the prompt at message acceptance; later deletion
cannot change that run, and missing references block a new turn. A chat created
from a job expands suggested libraries into the
normal explicit source selection and stays selected-empty until the user
confirms the expanded list — never a dynamic agent-to-library authorization
path and never a fallback to `all`.

## Editor contract

Old clients may still create an agent using only name and instructions. Existing
agents retain their prompt, blue bot identity, all seven built-in tools, no
skills, and no MCP access. Empty tool selections are meaningful and enforced at
both model-definition and dispatch boundaries. Connected-tool bindings live in
a separate `mcp_tools` collection (at most 16 per agent, each pinned to a
published discovery revision), so the `tools` array keeps its exact
built-in-only meaning for old clients.

Changes apply to the next accepted message. Selected skill text and the built-in
tool allowlist are captured inside the message-acceptance transaction; running
messages do not consult later agent or skill edits. Missing selected skills fail
with an actionable configuration error. System prompts are limited to 8,000
characters; up to eight skills of 8,000 characters each must fit the combined
32,000-character budget, including section labels.

The skill library is account-owned and limited to 200 entries. Markdown imports
accept instruction text and simple name/description front matter. They never
execute scripts or install packages. Skills saved to the library survive
cancellation of an agent draft.

## Verification

The editor foundation has store and API tests for account isolation, atomic
revision rollback, prompt limits, tool denial, and immutable accepted-turn
configuration. Browser checks cover creation, reopening saved identity and skills,
narrow layouts, and a live message with zero built-in tools that follows its
assigned skill. The final `pnpm verify` run passed all 16 tasks, including 897 server tests,
web tests, integration checks, builds, and native smoke tests. Temporary browser
test agents, skills, and chats were removed. Unsaved-dismissal confirmation was
also exercised. The connected-agent wave executes real durable turns against
committed local protocol fixtures rather than mocks: the committed stdio/HTTP
MCP servers and OAuth issuer under `scripts/e2e/fixtures` drive
`mcpClient`, `mcpOAuth`, `connectionStore`/`connectionSecrets`/
`connectionRoutes`, and `jobRoutes` tests, and `mcpAgentTurn` exercises
accepted-turn dispatch, revocation, and frozen-mapping behavior. The web layer
covers the Connections panel, the editor Connected/Job tabs, and chat
job-confirmation races, and the desktop package covers the custody vault,
utility-process contracts, and policies. Final packaged/browser acceptance
evidence is tracked in [END_TO_END_ACCEPTANCE.md](END_TO_END_ACCEPTANCE.md)
and the [execution ledger](../milestones/EXECUTION.md), not here.

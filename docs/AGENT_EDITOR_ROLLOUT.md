# Rich agent editor rollout

The September 5 sequencing decision moves the agent editor ahead of the
unimplemented remediation migrations. Applied migrations v1–v12 stay unchanged.
The reserved remediation work is valuable independently, but is not a runtime
prerequisite for agent identity, instruction editing, skills, or tool allowlists.

## Shipped foundation and remaining integration sequence

1. **Editor foundation (v13), complete in `0987170`:** shared create/edit modal; persisted description,
   icon and color; atomic prompt/capability revisions; account-owned Markdown
   skills; built-in tool selection and immutable accepted-turn snapshots.
2. **Remediation migrations, pending:** provider-bound consent in v14, automation
   target ownership in v15, typed connector refresh/repair in v16. Complete the
   handoff's prerequisite closure before integrating new product migrations;
   no placeholder migrations or changes to applied history.
3. **MCP runtime and editor, pending:** official TypeScript client, Streamable HTTP and
   stdio connections, discovery and explicit tool selection, isolated secret
   storage, OAuth sign-in/refresh, cancellation and process cleanup. MCP access
   remains absent until its entire execution path is implemented and verified.

MCP storage must be allocated only when its implementation is ready; do not
silently claim one of the reserved remediation versions. Reconcile the sequence
against the ledger before introducing the next migration.

The [selected functional roadmap](../milestones/README.md#selected-functional-wave)
keeps this pending MCP scope visible and includes reusable job setup. The full
[connected-agent specification](MCP_CONNECTIONS.md) and
[development handoff](DEVELOPMENT_HANDOFF.md) supply implementation and acceptance
details, including the prerequisite closure before new durable schema work.
Suggested libraries and output templates are not part of the shipped v13
editor. Suggested library members must become an explicit chat source
selection, never a dynamic agent-to-library authorization path.

## Editor contract

Old clients may still create an agent using only name and instructions. Existing
agents retain their prompt, blue bot identity, all seven built-in tools, no
skills, and no MCP access. Empty tool selections are meaningful and enforced at
both model-definition and dispatch boundaries.

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
also exercised. MCP needs local HTTP, stdio,
and OAuth fixtures plus desktop sign-in and process-lifecycle smoke checks before
it is released; a UI-only integration does not satisfy this stage.

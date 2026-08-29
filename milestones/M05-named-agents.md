# M05 — Named agents: versioned instructions, tools, and source bindings

**Horizon:** 2 ("the intelligence layer") — *Named agents — versioned
instructions, tools, and source bindings for a job: "finance analyst,"
"diligence," "ops brief." They do not grant data the runner cannot already
see.*

**Status:** PLANNED (spec to be finalized before implementation)

## Sketch

- New account-scoped `agents` entity with versioned instruction revisions
  (schema v6); a chat may bind an agent at creation.
- The runner prepends the bound agent's current instructions to the system
  prompt; the tool set and authorization stay exactly what the server policy
  already grants — an agent never widens retrieval, SQL, or egress scope.
- Source bindings are default scope suggestions at chat creation only, never
  enforcement.
- Web: an Agents surface (create/edit/revise) and an agent picker in the
  new-chat composer.

## Guardrails

- Read `server/src/agent.ts` and `server/src/tools.ts` before changing the
  loop; the agent prompt contract must remain sanitized.
- No automations, no schedules, no parallel agents in this milestone.

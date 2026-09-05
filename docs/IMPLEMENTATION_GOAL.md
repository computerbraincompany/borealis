# Goal to give the coding agent

Implement the complete Borealis functional development wave defined in
`docs/DEVELOPMENT_HANDOFF.md`. Read `AGENTS.md`, the current README/API/desktop
guides, `milestones/README.md`, `docs/MCP_CONNECTIONS.md`, milestones M12–M16,
and `docs/END_TO_END_ACCEPTANCE.md` before changing code. This is a request to
implement the full specified product, not to produce another plan or stop at a
prototype.

Complete connected agents with both MCP transports, OAuth and reusable job
setup; saved parameterized analyses and versioned results; editable reports and
documents with evidence-bearing exports; living folder/WebDAV libraries and
source search; durable local research and reviewed comparison tables; and
calendar-based recurring briefs with a real review inbox. Follow the precise
scope, defaults, limits and acceptance criteria in those specs. Resolve and
implement the handoff's prerequisite closure first where required; preserve
applied schema history and reserved migrations v14–v16. Do not reimplement
completed work or expand into explicitly deferred features.

Work autonomously through all milestones. Use subagents where independent work
benefits from them, with explicit ownership and dependency contracts. Keep one
integration/migration owner, review subagent changes yourself, and obtain a
fresh-context review of the integrated result. Reconcile routine code drift and
fix failures without repeatedly asking for approval. Preserve unrelated user
changes and every documented source-scope, storage, provider, renderer and
desktop invariant.

Keep a durable checklist and evidence in `milestones/EXECUTION.md`. Update
README, API docs, AGENTS, desktop documentation, relevant environment examples,
rollout/specs and both ledgers alongside implementation. Commit coherent,
verified slices with their documentation. Do not push or deliver anything to
external services or people unless separately authorized.

Implement and run the full acceptance harness from
`docs/END_TO_END_ACCEPTANCE.md`. Test meaningful unit and integration behavior,
real browser workflows, the freshly packaged Apple Silicon desktop app,
native folder selection, actual HTTP/stdio/OAuth/WebDAV fixtures, all exports,
upgrade/archive/restore, cancellation/reload/recovery, and the real local-model
finance/research workflows. Run `pnpm verify`, desktop verify, unsigned
packaging, packaged native and entitlement smokes, and all three product E2E
commands specified by the handoff. Fix failures and record real evidence; never
claim an unrun test passed or substitute mocks for required end-to-end checks.

Only finish successfully when every required feature, prerequisite, test,
end-to-end scenario, documentation update and commit is complete, with all
required checks passing and no unresolved implementation TODOs. Do not stop
after a plan, partial milestone, working demo, or successful build. Continue
across context resets using the execution ledger. If a genuine external blocker
prevents completion, finish all independent work, document exact evidence and
the smallest required user action, and report blocked rather than falsely
claiming completion or bypassing a permission boundary.

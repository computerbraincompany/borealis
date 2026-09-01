# Plan 004: Add a vertical agent-turn integration test

> **Executor instructions**: Follow the plan in order. The test must exercise
> production route, agent, tool, persistence, and local HTTP model-client code;
> do not replace those layers with mocks. Stop rather than weakening the test
> if a listed assumption is false. A reviewer maintains
> `advisor-plans/README.md`; do not edit it.
>
> **Drift check (run first)**:
> `git diff --stat f1b9293..HEAD -- server/src/tests/vitestTestPartitions.ts server/src/tests/agentVerticalIntegration.test.ts server/src/tests/scriptedOpenAiServer.ts server/src/routes/chats.ts server/src/agent.ts server/src/tools.ts server/src/llm.ts`
> Production files are reference-only in this plan. Plans 026, 027, 029, 034,
> and 035 intentionally changed protected-route parsing, streamed tool-call
> assembly, query deadlines, model qualification, and embedding-index startup.
> Those completed contracts are the baseline, not drift: update stale line
> references to the live code, preserve them, and STOP only for an unrelated
> material mismatch.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: LOW
- **Depends on**: `advisor-plans/001-partition-server-test-suites.md`
- **Preserve completed baseline**: Plans 026, 027, 029, 034, and 035
- **Category**: tests
- **Planned at**: commit `f1b9293`, 2026-08-30

## Why this matters

Existing route tests mock `runAgent`, turn acceptance, and durable run helpers,
while agent tests mock storage, the model boundary, the data service, and tools.
They can all pass when the real HTTP route, OpenAI-compatible streaming parser,
tool loop, immutable scope, SSE order, and SQLite terminal transaction no longer
compose. Add one deterministic loopback-provider test that crosses those seams
without a live model or external network.

## Current state

- `server/src/tests/modelRoutes.test.ts:6-16` replaces the vertical core:

  ```ts
  vi.mock("../agent.js", () => ({ runAgent: vi.fn() }));
  vi.mock("../turnContext.js", () => ({ acceptChatTurn: vi.fn() }));
  vi.mock("../chatRuns.js", () => ({
    beginRun: vi.fn(() => new AbortController()),
    completeRunWithAssistant: vi.fn(),
    finishRunDurably: vi.fn(),
    cancelRun: vi.fn(),
    isRunCancellation: vi.fn(() => false),
  }));
  ```

- `server/src/tests/agentModel.test.ts:3-10` mocks storage, LLM, data service,
  and tools before importing `runAgent`. Keep those focused tests; this plan
  fills a different seam.
- `server/src/routes/chats.ts:252-305` performs the production sequence:
  enforce egress consent, `acceptChatTurn`, `beginRun`, emit `run-started` and
  `user-saved`, call `runAgent`, persist through `completeRunWithAssistant`, then
  emit the complete `delta`, `message`, `done`, and terminal `run-ended`.
- `server/src/agent.ts:243-274` loops over real streaming model responses and
  calls `runToolRound` when `message.tool_calls` is non-empty.
- `server/src/tools.ts:475-497` implements `list_sources` from the immutable run
  scope and returns only bounded source fields. This tool avoids renderers and
  embeddings while still proving a real tool round.
- `server/src/llm.ts:217-300` consumes OpenAI-compatible SSE and reconstructs
  bounded streamed tool calls. The fake provider must use this network/client
  path rather than spying on `streamingChat`.
- The message endpoint intentionally emits the answer as one complete `delta`
  only after persistence. Do not assert token-by-token deltas.
- The agent loop is intentionally capped at eight iterations. This test uses
  exactly two provider calls: one tool-call response and one final response.
- Match the real storage lifecycle in
  `server/src/tests/egressConsent.test.ts:23-54`: unique temp directory,
  `initializeStorageRuntime`, `initializeRuntimeSettings`, Fastify close,
  `closeRuntimeSettings`, and `closeStorageRuntime`.

## Commands you will need

| Purpose           | Command                                                                                                                          | Expected on success                 |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Focused test      | `pnpm --filter borealis-server exec vitest run --config vitest.integration.config.ts src/tests/agentVerticalIntegration.test.ts` | exit 0; two scripted provider calls |
| Integration suite | `pnpm --filter borealis-server test:integration`                                                                                 | exit 0                              |
| Unit suite        | `pnpm --filter borealis-server test`                                                                                             | exit 0; vertical file is absent     |
| Typecheck         | `pnpm --filter borealis-server typecheck`                                                                                        | exit 0                              |
| Lint/format       | `pnpm --filter borealis-server lint && pnpm --filter borealis-server format:check`                                               | exit 0                              |

Do not install packages, start LM Studio, use external network, build, or format.

## Scope

**In scope**:

- `server/src/tests/scriptedOpenAiServer.ts` (create)
- `server/src/tests/agentVerticalIntegration.test.ts` (create)
- `server/src/tests/vitestTestPartitions.ts` (add the new test to the serialized
  integration manifest from Plan 001)

**Out of scope**:

- All production route, agent, tool, LLM, store, and runtime files.
- Report/chart rendering, DuckDB queries, Lance vector search, downloads, and a
  live model. They have separate integration coverage and make this seam noisy.
- Changing SSE semantics, the eight-iteration limit, or source-scope behavior.
- Adding a general mock framework or test dependency.

## Git workflow

- Branch: `codex/004-add-vertical-agent-integration-test`
- Commit: `test(server): cover a vertical agent turn`
- Do not push, open a PR, edit the plan index, or commit temporary databases.

## Steps

### Step 1: Build a deterministic loopback OpenAI fixture

Create `server/src/tests/scriptedOpenAiServer.ts` using `node:http`. Export a
helper that listens on `127.0.0.1` at an OS-assigned port, exposes its bare
origin, records sanitized parsed request bodies in memory, and closes all
connections during cleanup. Never print request bodies or headers.

For `POST /v1/chat/completions` with `stream: true`:

1. first call: emit valid `text/event-stream` chunks that construct one native
   function tool call named `list_sources` with `{}` arguments, then `[DONE]`;
2. second call: emit a short final assistant answer, then `[DONE]`.

Return 404 for every other path. Split at least one tool-call field across SSE
chunks so the real accumulator is exercised. Use only deterministic IDs and
content; do not include credential-shaped fixtures.

**Verify**:
`pnpm --filter borealis-server typecheck` → exit 0.

### Step 2: Assemble a real isolated workspace in the test

Create `server/src/tests/agentVerticalIntegration.test.ts` with no `vi.mock`
calls. In setup:

- create isolated SQLite, LanceDB (small dimension), uploads, reports, and
  settings paths;
- seed an authenticated owner and a different account;
- create one ready document source for each account through production stores;
- configure runtime settings to the fake server's loopback origin with distinct
  chat and embedding model IDs and no credential;
- register the real `routes` plugin in Fastify; and
- create an owner chat through `POST /api/chats` with an explicit selected scope
  containing only the owner's ready source.

Track every app/server/runtime and close it in `afterEach` even after failure.
Do not initialize workers or open an external socket beyond the loopback fake.

Before the first focused run, add
`src/tests/agentVerticalIntegration.test.ts` to Plan 001's shared serialized
integration manifest in `server/src/tests/vitestTestPartitions.ts`, preserving
its sorting and exhaustive-inventory rules. The integration config filters even
an explicit CLI path through that manifest; running first and registering later
would produce “No test files found” instead of exercising setup. Do not add the
helper file because it is not a test.

**Verify**:
Add one passing setup-smoke case in the final test file that posts a turn, waits
for the response to settle, and asserts HTTP success plus exactly two captured
provider calls. Then run
`pnpm --filter borealis-server exec vitest run --config vitest.integration.config.ts src/tests/agentVerticalIntegration.test.ts`
→ exit 0. Do not proceed from a red test. Step 3 extends this same passing
case with the complete cross-layer assertions; it does not replace a setup
failure with an expected failure. If the focused command cannot reach the
provider without changing production code, STOP.

### Step 3: Assert the complete turn across all layers

POST one user message to `/api/chats/:id/messages`. Parse SSE frames rather than
using substring-only assertions. Require this order:

1. `run-started`;
2. `user-saved`;
3. `step-start` for `list_sources`;
4. successful `step-end`;
5. complete `delta` and matching `message` only after the tool round;
6. `done`; and
7. `run-ended` with `completed`.

Inspect the two captured provider request bodies in memory. The second request
must contain a `tool` message whose parsed result contains the selected owner's
source and excludes the other account's source. Do not snapshot the full system
prompt or log request bodies.

Then query through production stores/ledger and assert:

- exactly one accepted user message and one assistant message were stored;
- assistant content equals the emitted complete delta;
- assistant metadata carries `source_mode: "selected"` and only the owner's
  ready source ID;
- the run is `completed`, has a finished timestamp and no error code; and
- `chat_run_sources` contains exactly the immutable selected source.

**Verify**:
`pnpm --filter borealis-server exec vitest run --config vitest.integration.config.ts src/tests/agentVerticalIntegration.test.ts`
→ exit 0, one test passes, and the fixture reports exactly two in-memory calls.

### Step 4: Prove the vertical test is only in the serialized suite

Confirm the Step 2 registration remains in the shared integration manifest
created by Plan 001 and absent from the default unit partition.

**Verify**:

- `pnpm --filter borealis-server exec vitest list --filesOnly` → the vertical test is absent.
- `pnpm --filter borealis-server exec vitest list --filesOnly --config vitest.integration.config.ts`
  → the vertical test appears once.
- `pnpm --filter borealis-server test:integration` → exit 0.
- `pnpm --filter borealis-server test` → exit 0.
- `pnpm --filter borealis-server typecheck && pnpm --filter borealis-server lint && pnpm --filter borealis-server format:check`
  → exit 0.

## Test plan

- One vertical happy-path test is deliberate: real HTTP provider parsing, one
  real tool call, scope enforcement, SSE order, and terminal persistence.
- The fixture itself must reject unexpected paths and record exactly two calls.
- Cross-account exclusion is checked in the tool result, not merely in a route
  DTO.
- Existing focused unit tests remain responsible for error, cancellation,
  budgets, citations, reports, and individual tool branches.

## Done criteria

- [ ] The new test uses no module mocks for route/agent/tool/LLM/storage code.
- [ ] All network traffic stays on an OS-assigned `127.0.0.1` port.
- [ ] A real native `list_sources` tool call is reconstructed from streamed SSE.
- [ ] SSE success arrives only after the assistant/run are durably complete.
- [ ] Immutable source scope includes owner data and excludes foreign data.
- [ ] The test runs only in the serialized integration suite.
- [ ] Both suites and all server static gates pass.
- [ ] `git status --short` contains only the three in-scope paths.

## STOP conditions

Stop and report if:

- Plan 001 is not complete or there is no shared integration manifest;
- the production OpenAI-compatible client cannot be pointed at an isolated
  loopback origin without changing production APIs;
- the test requires a live model, external internet, Playwright, or renderer;
- passing requires mocking `runAgent`, `streamingChat`, `executeTool`, turn
  acceptance, or run persistence;
- the current endpoint's SSE order or immutable-scope contract differs from the
  excerpts; or
- any verification fails twice after one reasonable correction.

## Maintenance notes

- Keep the scripted provider protocol-minimal and deterministic. It is a seam
  test, not an OpenAI emulator.
- When the production agent adds a mandatory outbound field, update the fixture
  response/parser expectations without snapshotting prompts or content.
- Later high-risk egress, cancellation, and runtime refactors should extend this
  harness only when their failure mode truly crosses the same vertical seam.

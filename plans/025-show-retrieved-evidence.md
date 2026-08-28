# Plan 025: Persist and show the source passages retrieved for each answer

> **Completed historical plan.** The [ledger](README.md) records this plan as
> DONE. The original instructions, code excerpts, paths, and checklists below
> describe its implementation-era tree; do not execute them against the current
> checkout. For supported behavior and commands, use the [project README](../README.md),
> [API reference](../docs/API.md), and [desktop guide](../desktop/README.md).

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. Honor STOP conditions. Update `plans/README.md` when done unless
> the reviewer tells you they maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 67cc7db..HEAD -- server/src/retrieve.ts server/src/tools.ts server/src/agent.ts server/src/tests/retrieve.test.ts server/src/tests/tools.test.ts server/src/tests/agentModel.test.ts web/src/lib/api.ts web/src/pages/ChatView.tsx web/src/components/ChatMessage.tsx plans/README.md`
> Plan 024 is expected to change `ChatView.tsx`; reconcile that known change.
> Any other unexplained mismatch is a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED (evidence must be bounded, truthful, and backward compatible)
- **Depends on**: `plans/024-attach-files-in-chat.md`
- **Category**: direction / trust / ux
- **Planned at**: commit `67cc7db`, 2026-08-23

## Why this matters

North makes grounded answers inspectable through citation indicators, source
counts, and source-snippet panels. Borealis retrieves relevant chunks but asks
the model to type an unvalidated `[source]` label; after the tool step collapses,
the user cannot see the actual evidence. This plan implements an honest,
model-agnostic MVP slice: persist the passages actually returned by `retrieve`
and show them as response-level retrieved evidence. Exact claim-span mapping is
deferred because arbitrary OpenAI-compatible models do not provide reliable
citation offsets.

Official behavior reference:
<https://private.docs.cohere.com/docs/get-started/using-citations> documents a
source-count pill, snippet previews, and an all-sources panel for grounded chat.

## Current state

`server/src/retrieve.ts:12-23` omits stable identifiers:

```ts
SELECT content, source_name,
       1 - (embedding <=> $2::vector) AS score
FROM chunks
...
return rows.map((r) => ({ ...r, score: Number(r.score).toFixed(4) }));
```

`server/src/tools.ts:181-187` returns transient passages and relies on prose:

```ts
return {
  passages: res.map((c) => ({ source: c.source_name, score: c.score, content: c.content })),
  instruction: "... Cite the source name after claims ...",
};
```

`server/src/agent.ts:153-164` persists charts, report, model, and source scope,
but not retrieved evidence. `web/src/lib/api.ts:121-131` mirrors that metadata.
`web/src/components/ChatMessage.tsx:90-121` renders markdown, model, charts, and
report only.

Conventions to preserve:

- Retrieval remains filtered by account plus immutable turn source IDs.
- Message `meta` is additive JSONB; old messages without new fields must render.
- Tool output sent to the model stays useful and bounded by the existing
  12,000-character prompt limit.
- Render snippets as React text, never as HTML.
- Use semantic theme tokens and accessible native/Radix disclosure behavior.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Server typecheck/tests | `cd server && npm run typecheck && npm test` | all pass |
| Server build | `cd server && npm run build` | exit 0 |
| Web typecheck/build | `cd web && npm run typecheck && npm run build` | exit 0; existing chunk warning allowed |
| Full gate | `./scripts/verify.sh` | all gates green |

Baseline at `67cc7db`: 15 server test files / 108 tests and 93 Python tests
pass; server/web production builds pass.

## Scope

**In scope**:

- `server/src/retrieve.ts`
- `server/src/tools.ts`
- `server/src/agent.ts`
- `server/src/tests/retrieve.test.ts`
- `server/src/tests/tools.test.ts`
- `server/src/tests/agentModel.test.ts`
- `web/src/lib/api.ts`
- `web/src/pages/ChatView.tsx`
- `web/src/components/ChatMessage.tsx`
- `web/src/components/RetrievedEvidence.tsx` (create if useful)
- `plans/README.md`

**Out of scope**:

- Claim-level character offsets, rewriting model output, or treating typed
  `[source]` text as validated.
- New extraction/page/sheet/row locator pipelines or forced reingestion.
- Full document/PDF preview, authenticated raw-file download, or external URL
  navigation.
- Citations for `fetch_url`, SQL cell lineage, charts, reports, or MCP tools.
- Changing embedding, ranking, top-k defaults, or source-scope enforcement.

## Git workflow

- Branch: `codex/025-show-retrieved-evidence`
- Conventional commit example: `feat: show retrieved evidence in chat`
- Do not push independently; the primary reviewer will integrate and push.

## Steps

### Step 1: Return stable retrieval evidence

Extend the retrieval query to select:

- `chunks.id::text AS chunk_id`
- `chunks.source_id::text AS source_id`
- `chunks.content`
- an account-safe display label from an account-constrained join to `sources`,
  falling back to `chunks.source_name`
- the existing score

Keep both existing predicates (`chunks.account_id` and allowed source IDs) and
the empty-allowlist early return. The sources join must not weaken either.

Return a typed/sanitized shape. IDs and label are strings; score is finite;
content stays the retrieved chunk. Do not return file paths, connector config,
URLs, or source metadata.

**Verify**: extend `retrieve.test.ts` to assert selected fields, both security
predicates, parameter positions, stable IDs/label, and empty-scope behavior.

### Step 2: Build a bounded per-turn evidence ledger

Add a typed `evidence` array to `ToolRunContext`. When `executeTool` completes a
successful `retrieve`, record only values returned by the server retrieval
function, not model-authored labels.

Create/export a pure sanitizer used by tests with these invariants:

- Deduplicate by `(source_id, chunk_id)` while preserving first-seen order.
- Keep at most 8 passages across the turn.
- Trim source labels to 200 characters and excerpts to 800 characters.
- Accept only non-empty IDs/content; omit malformed entries and non-finite
  scores.
- Store `{ source_id, chunk_id, source, excerpt, score }` only.

The retrieve tool response sent to the model can retain its current passage
content and instruction. The evidence ledger is a parallel trusted record.

**Verify**: `tools.test.ts` covers capture, dedupe, malformed entries, and all
bounds without making network calls.

### Step 3: Persist and stream the evidence

Add the sanitized ledger to both final-answer metadata construction sites in
`agent.ts`:

```ts
meta: {
  charts,
  report,
  model,
  source_mode,
  source_ids,
  evidence,
}
```

The same object must be inserted in `messages.meta` and emitted in the final
SSE `message` event. Empty evidence is `[]`. It must not be added to subsequent
LLM history; the assistant text remains the conversational history.

Extend agent tests so a retrieval turn persists/emits the bounded evidence and
the guard-exhaustion path uses the same metadata contract.

**Verify**: server typecheck/tests/build pass.

### Step 4: Render an honest response-level evidence disclosure

Add matching `RetrievedEvidence` types in `web/src/lib/api.ts` and
`ChatMessage` props. Extend `ChatView` stream state so evidence from the final
SSE event remains visible if the authoritative refresh fails and is also read
from historical message metadata after reload.

Render an accessible disclosure below assistant prose and before generated
artifacts:

- Collapsed label: `Evidence · N sources`, where N is distinct source IDs.
- Expanded content groups passages by source, preserves retrieval order, and
  shows the source label plus exact stored excerpt as plain text.
- Include a short description: these passages were retrieved for the answer;
  users should verify that each claim matches the evidence.
- Do not underline claims or label the list `Citations`; that would imply span
  validation this plan does not provide.
- Long passages wrap and the panel is keyboard accessible in both themes.

**Verify**: web typecheck/build plus a browser check of zero, one, and multiple
source cases in Light and Dark themes.

## Test plan

- `retrieve.test.ts`: stable IDs/display label and preserved account/scope SQL.
- `tools.test.ts`: sanitizer/capture bounds and dedupe.
- `agentModel.test.ts` or a focused new test: persisted and SSE metadata parity.
- Browser: historical reload, in-flight completion, failed final refresh,
  keyboard disclosure, Light/Dark.

## Done criteria

- [x] Every successful `retrieve` can contribute stable, bounded evidence.
- [x] Evidence is persisted in assistant metadata and included in final SSE.
- [x] Historical and just-streamed answers show the same disclosure.
- [x] UI calls it retrieved evidence, not claim-level citations.
- [x] No internal paths, URLs, connector config, or account-wide data leak.
- [x] Server tests/typecheck/build, web typecheck/build, and full verify pass.

## STOP conditions

Stop and report if:

- The implementation requires reingesting existing chunks.
- Stable source/chunk IDs cannot be returned without weakening scope filters.
- A proposed UI claims exact claim attribution without a validated offset
  contract.
- Verification fails twice after a reasonable correction.

## Maintenance notes

- Future page/sheet locators can extend each evidence object additively.
- If raw source preview is added, authorize it independently by account; never
  trust IDs solely because they were present in browser metadata.
- Deleted source text remains in old assistant messages just as summaries of
  deleted data already do; changing retention semantics needs its own plan.

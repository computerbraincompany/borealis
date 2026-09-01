# Plan 034: Qualify configured chat and embedding model pairs

## Status

- **State**: DONE (2026-09-01)
- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none; required by plan 035
- **Category**: product / model compatibility
- **Planned at**: `14ab08f`, 2026-08-31

## Why this matters

`GET /v1/models` proves only endpoint reachability and advertised IDs. It does
not prove that the chosen chat model emits function calls or that the embedding
model returns finite vectors with the configured dimension. Those are Borealis'
minimum executable model-pair requirements.

## Target contract

- An authenticated `POST /api/models/qualify` accepts a bounded draft provider
  origin/key plus chat model, embedding model, and expected dimension using the
  same validation and environment-override rules as Settings.
- A remote draft is never covered by consent for a different configured
  provider. Qualification requires an explicit per-request acknowledgment
  bound to the canonical draft origin; the acknowledgment is not persisted as
  workspace consent. The route emits only content-free egress audit categories.
- Chat qualification sends one fixed synthetic prompt and one fixed synthetic
  function definition through bounded streaming SSE, then uses the production
  stream accumulator and requires one 1–256-character call ID, the exact tool
  name, and bounded JSON arguments. No uploaded, account, chat, or source
  content is used.
- Embedding qualification sends one fixed synthetic string with
  `encoding_format: "float"`, then validates count, exact dimension, and a
  finite positive squared norm after float32 coordinate, square, and
  accumulation rounding—the same numeric boundary Lance cosine search uses.
- Provider response bodies, reasoning, exceptions, URLs, keys, raw arguments,
  and model output are discarded. The public result contains per-role
  `qualified`, stable reason code, dimension, and bounded latency only.
- Qualification is explicit and non-persistent until Settings is saved; the UI
  clearly distinguishes connection reachability from executable qualification.

## Scope

- a testable qualification service near `server/src/llm.ts`
- model/settings routes, schemas, egress gate/audit, web API and Settings UI
- server/web tests and model/privacy documentation

## Implementation steps

1. Extract one validated draft-effective-settings decoder shared by connection
   testing and qualification without ever echoing a key.
2. Implement bounded OpenAI-compatible synthetic chat/tool and embedding calls
   with independent abort deadlines and zero retries.
3. Define stable result codes such as unreachable, tool-call-missing,
   tool-call-invalid, embedding-invalid, and dimension-mismatch.
4. Add the authenticated route with early auth, a schema-derived body limit,
   explicit canonical-draft-origin acknowledgment for remote calls,
   content-free audit, and no provider-body propagation. Never treat a stored
   acknowledgment for a different configured origin as permission for the draft.
5. Add a Settings “Qualify pair” action and accessible result card; invalidate a
   displayed result when any draft endpoint/key/model/dimension field changes.
6. Test successful and malformed provider variants, timeout, reasoning/content
   leakage, missing or mismatched remote draft acknowledgment,
   environment-managed drafts, and UI invalidation.

## Verification

- Focused LLM/model/settings/egress/web tests, type/lint/format/build, a manual
  loopback LM Studio qualification, and `pnpm verify`.

## Done criteria

- [x] Operators can prove both roles before saving or reindexing.
- [x] Qualification uses no user content and exposes no provider payload.
- [x] Dimension mismatch is explicit and consumed by plan 035.

## Completion record

- `POST /api/models/qualify` resolves a bounded unsaved Settings draft, applies
  canonical draft-origin acknowledgment for remote calls, and returns only
  stable per-role reason/dimension/latency fields.
- Model qualification, model/settings route, egress, API-client, hook, and
  Settings UI tests cover success, malformed calls/vectors, mismatch, timeout,
  environment overrides, redaction, acknowledgment, and draft invalidation.
- Qualification and production chat share the streamed tool-call accumulator,
  including incremental/cumulative name fragments and call-ID limits.
  Qualification, ingestion, migration, upsert, and search reject float32
  coordinate or norm underflow/overflow before LanceDB can return non-finite or
  silently incorrect cosine distances.
- The one-tool probe uses the portable `tool_choice: "required"` form and a
  bounded 128-token allowance, then still requires the exact tool name and
  arguments. A 2026-09-01 live loopback LM Studio check qualified both
  `qwen3.8-27b-obliterated` and the 768-dimensional
  `text-embedding-nomic-embed-text-v1.5` role without workspace content.

## STOP conditions

- A candidate provider requires sending workspace content to prove capability.
- A qualification result is treated as authorization or as a permanent promise
  after provider settings change.

# Plan 034: Qualify configured chat and embedding model pairs

## Status

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
  function definition, then requires the exact tool name and bounded JSON
  arguments. No uploaded, account, chat, or source content is used.
- Embedding qualification sends one fixed synthetic string with
  `encoding_format: "float"`, then validates count, finite values, nonzero norm,
  and exact dimension.
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
4. Add the authenticated route with early auth, a small body limit, explicit
   canonical-draft-origin acknowledgment for remote calls, content-free audit,
   and no provider-body propagation. Never treat a stored acknowledgment for a
   different configured origin as permission for the draft.
5. Add a Settings “Qualify pair” action and accessible result card; invalidate a
   displayed result when any draft endpoint/key/model/dimension field changes.
6. Test successful and malformed provider variants, timeout, reasoning/content
   leakage, missing or mismatched remote draft acknowledgment,
   environment-managed drafts, and UI invalidation.

## Verification

- Focused LLM/model/settings/egress/web tests, type/lint/format/build, a manual
  loopback LM Studio qualification, and `pnpm verify`.

## Done criteria

- [ ] Operators can prove both roles before saving or reindexing.
- [ ] Qualification uses no user content and exposes no provider payload.
- [ ] Dimension mismatch is explicit and consumed by plan 035.

## STOP conditions

- A candidate provider requires sending workspace content to prove capability.
- A qualification result is treated as authorization or as a permanent promise
  after provider settings change.

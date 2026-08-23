# Plan 021: Discover OpenAI-compatible models and persist the selected model per chat

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first, after dependencies)**:
> `git diff --stat e6e9d2b..HEAD -- README.md server/.env.example server/src/config.ts server/src/db.ts server/src/llm.ts server/src/agent.ts server/src/routes.ts server/src/tests web/src/lib/api.ts web/src/pages/ChatView.tsx web/src/components/ChatMessage.tsx web/src/components/ModelSelector.tsx web/src/components/ui/dropdown-menu.tsx plans/README.md`
> Plans 013, 014, 015, 019 and 020 are expected to change some of these paths.
> Compare the excerpts and dependency notes below against the resulting code;
> any unexplained mismatch is a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED (provider catalogs do not standardize chat/tool capability)
- **Depends on**: `plans/013-remove-north-branding.md`, `plans/014-fix-ingest-name-and-chat-stream-ux.md`, `plans/015-agent-data-integrity.md`, `plans/019-chat-view-fixes.md`, `plans/020-dev-gates-and-docs.md`
- **Category**: direction / ux
- **Planned at**: commit `e6e9d2b`, 2026-08-23

## Why this matters

The configured OpenAI-compatible endpoint can expose several chat models, but
Borealis currently hard-codes one process-wide model. Users cannot see which
model is active, choose another model already advertised by LiteLLM or LM
Studio, or tell which model produced an older answer. This plan makes model
identity durable at the chat level and snapshots it at the start of each turn,
while deliberately keeping the embedding model and pgvector dimension under
operator configuration.

## Current state

Relevant files:

- `server/src/config.ts` — separates chat and embedding configuration.
- `server/src/llm.ts` — owns the single OpenAI SDK client and all model calls.
- `server/src/db.ts` / `server/src/routes.ts` — chat persistence and API.
- `server/src/agent.ts` — all completion calls and assistant metadata.
- `web/src/lib/api.ts` / `web/src/pages/ChatView.tsx` — chat types, API client,
  stream state and composer.
- `web/src/components/ChatMessage.tsx` — historical assistant-message display.

Current relevant code at the planned commit (the credential default is
intentionally redacted here):

`server/src/config.ts:24-29` already distinguishes chat from embeddings:

```ts
// LiteLLM / any OpenAI-compatible endpoint
llmBaseUrl: process.env.LITELLM_BASE_URL || "http://localhost:4000",
llmApiKey: process.env.LITELLM_API_KEY || "<local development placeholder>",
chatModel: process.env.LITELLM_CHAT_MODEL || "qwen-chat",
embedModel: process.env.LITELLM_EMBED_MODEL || "nomic-embed",
embeddingDim: Number(process.env.EMBEDDING_DIM || 768),
```

Do not copy any credential value from the repository into code, tests, logs or
plans. Only the environment-variable names above matter.

`server/src/llm.ts:17,29-35,44-50` hard-codes the two model roles:

```ts
const res = await client.embeddings.create({ model: config.embedModel, input: batch, encoding_format: "float" });

return client.chat.completions.create({
  model: config.chatModel,
  messages,
  ...
});
```

The streaming request also uses `model: config.chatModel`. `chatOnce` and
`streamingChat` are called from every agent-loop completion site in
`server/src/agent.ts:99-148`.

`server/src/db.ts:56-61` stores no model:

```sql
CREATE TABLE IF NOT EXISTS chats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'New chat',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

`server/src/routes.ts:24-45` lists/creates/gets only `id`, `title` and
`created_at`; the message route selects only `id` before calling `runAgent`.
`web/src/lib/api.ts:113-129` mirrors that model-less response shape.

`docs/cohere-north/03-chat-agents-memory-and-evaluation.md:19-30,56-80`
requires a composer model selector, a durable `selected_model_profile_id`, and
message model/run metadata. `docs/cohere-north/12-ui-ux-reconstruction-specification.md:92-103`
places the selector in the composer. Match those behaviors without copying the
upstream visual design.

Conventions to preserve:

- Server code is TypeScript ESM; local imports include `.js`.
- Every browser-facing route uses `requireAuth`; chat mutations also constrain
  by `account_id`.
- SQL values come through parameters, never template interpolation.
- Web code uses named functional components, Radix-backed local primitives and
  the `api<T>()` wrapper.
- Plan 014 adds reasoning metadata; plan 015 changes streaming merge behavior;
  plan 019 changes ChatView stream refresh/batching. Preserve all of them.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Server typecheck | `cd server && npm run typecheck` | exit 0 |
| Server tests | `cd server && npm test` | all tests pass |
| Server build | `cd server && npm run build` | exit 0 |
| Web typecheck | `cd web && npm run typecheck` | exit 0 |
| Web build | `cd web && npm run build` | exit 0; the existing bundle-size warning is allowed |

Baseline at `e6e9d2b`: server typecheck passes, 9/9 server tests pass, and the
web production build passes.

## Scope

**In scope**:

- `server/src/db.ts` (chat model column and parameterized one-time backfill)
- `server/src/config.ts` (boot-time chat/embedding model ID invariants)
- `server/src/llm.ts` (catalog discovery, normalization, explicit chat model)
- `server/src/agent.ts` (turn snapshot propagation and message metadata)
- `server/src/routes.ts` (catalog endpoint, model mutation, response fields)
- `server/src/tests/models.test.ts` (create)
- `server/src/tests/llm.test.ts` (create or extend the dependency plan's file)
- `web/src/lib/api.ts` (model/chat types and clients)
- `web/src/components/ModelSelector.tsx` (create)
- `web/src/components/ui/dropdown-menu.tsx` (accessible radio primitives)
- `web/src/pages/ChatView.tsx` (catalog state, selector and durable error UI)
- `web/src/components/ChatMessage.tsx` (historical model label)
- `server/.env.example` (document distinct chat/embedding model IDs)
- `README.md` (per-chat model discovery/selection semantics)
- `plans/README.md` (status row)

**Out of scope (do NOT touch)**:

- `python/litellm.yaml` or provider-native LiteLLM/LM Studio management APIs.
- `embed()` model selection, `EMBEDDING_DIM`, the pgvector column, or re-embedding.
- Model capability probing, paid test requests, reasoning-level controls, token
  limits, provider credentials, endpoint configuration UI, or model downloads.
- Silent fallback from a failed saved model to the process default.
- Account-wide or browser-global "last selected model" preferences.

## Git workflow

- Branch: `codex/021-select-chat-model`
- Commit per logical step using conventional messages such as
  `feat: persist the selected chat model`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Persist a model snapshot on every chat

First, in `server/src/config.ts`, validate the finalized model values at boot:

- Trim `chatModel` and `embedModel`; each must be 1-256 characters.
- Require them to be distinct because the configured embedding model is
  deliberately excluded from chat selection in this plan.
- Throw a concise configuration error naming only the environment variable,
  never its value, credential or endpoint. Export a pure validator so the
  blank, oversized and equal-ID cases are unit-tested without mutating module
  cache/global environment.

Create those validator cases in `server/src/tests/models.test.ts` during this
step so the schema cannot be populated from an invalid configured default.

Then, in `server/src/db.ts`:

1. Add nullable `model TEXT` to the `CREATE TABLE IF NOT EXISTS chats` shape.
2. Add `ALTER TABLE chats ADD COLUMN IF NOT EXISTS model TEXT;` after the table
   declaration so existing databases migrate.
3. After `pool.query(SCHEMA)` in `initDb()`, run a parameterized backfill:
   `UPDATE chats SET model=$1 WHERE model IS NULL`, with `config.chatModel` as
   the value. Then run `ALTER TABLE chats ALTER COLUMN model SET NOT NULL`.
   Never interpolate the environment value into `SCHEMA`.
4. Every new-chat insert must explicitly pass `config.chatModel`; changing the
   environment default later must affect new chats only, not rewrite saved
   selections.

**Verify**: `cd server && npm run typecheck && npm test` -> exit 0.

### Step 2: Add provider-agnostic model discovery

In `server/src/llm.ts`, add a pure exported normalizer and a discovery helper:

```ts
export interface ChatModelOption {
  id: string;
  owned_by?: string;
}

export function normalizeChatModels(
  input: unknown,
  configuredEmbeddingModel: string,
): ChatModelOption[] { /* validate, trim, dedupe and sort */ }
```

Required behavior:

- Use the existing `client.models.list()` call, hence the same server-owned
  OpenAI-compatible base URL and credential as completions.
- Bound the upstream request to 5 seconds and zero SDK retries for this UI
  discovery path. A catalog outage must not hold the chat page open.
- Accept only non-empty string IDs (maximum 256 characters), dedupe by exact
  ID, preserve `owned_by` only when it is a string after trimming it to at
  most 256 characters, and sort deterministically.
- Exclude only the exact `config.embedModel`, because that one is definitively
  reserved for ingestion. Do not guess capabilities from words such as
  `embed`, `vision`, or `chat`; the standard response cannot prove them.
- Cache successful results for 15 seconds and coalesce an in-flight request.
  Expose a `refresh` option that bypasses the settled cache.
- Convert failure into a safe state; log only a short server-side summary and
  never return the API key, endpoint URL, raw response or raw exception.

Add authenticated `GET /api/models` in `server/src/routes.ts`, supporting
`?refresh=1`, with this stable response:

```ts
{
  models: ChatModelOption[],
  default_model: string,
  discovery: "live" | "unavailable"
}
```

When discovery is unavailable, return HTTP 200 with `models: []`, the
configured default identity, and `discovery: "unavailable"`. This is a
degraded catalog, not permission to claim the default was advertised.

**Verify**: unit tests in `server/src/tests/models.test.ts` cover a standard
OpenAI-shaped page, malformed input, duplicate/blank IDs, deterministic order,
exact embedding-ID exclusion, bounded ownership, safe failure, 15-second cache,
in-flight coalescing and refresh bypass. Then run `cd server && npm test`.

### Step 3: Add an account-scoped chat-model mutation

In `server/src/routes.ts`:

1. Include `model` in chat list, create and detail responses.
2. Add `PATCH /api/chats/:id` accepting exactly `{ model: string }` for now.
   Trim it, require 1-256 characters, reject the exact configured embedding
   model, and reject extra/missing fields with 400.
3. Update with `WHERE id=$1 AND account_id=$2`, return 404 when the chat is not
   owned by the caller, and return the updated chat shape.
4. Do not hard-whitelist the mutation against the latest discovery list.
   Catalogs can be temporarily unavailable or incomplete; the endpoint remains
   authoritative. The web picker offers discovered models, while a saved model
   that disappears remains visible as unadvertised.

In `POST /api/chats/:id/messages`, select `{ id, model }` with the existing
account predicate before saving the user message. Pass that value to
`runAgent`; it is the immutable model snapshot for the accepted turn. A PATCH
during generation affects the next turn only.

**Verify**: `cd server && npm run typecheck && npm test` -> exit 0. With the
server running, unauthenticated `GET /api/models` returns 401; an authenticated
PATCH against another account's chat returns 404 and changes no row.

### Step 4: Pass the turn model through every completion and metadata path

In `server/src/llm.ts`, make a model ID required in the options accepted by
`chatOnce` and `streamingChat`, and use that value in the SDK request. Keep
`embed()` exactly on `config.embedModel` with `encoding_format: "float"`.

In `server/src/agent.ts`:

- Add `model: string` to `runAgent` options.
- Pass it to every completion site: planning/tool rounds, final streaming, and
  the guard-exhaustion completion.
- Preserve reasoning/tool fixes from plans 014/015.
- Add `model` to the persisted assistant `messages.meta` and final SSE
  `message.meta`, alongside `charts` and `report`.
- On provider failure, emit the error normally. Never retry under
  `config.chatModel` and never mutate the chat selection.

In `server/src/tests/llm.test.ts`, mock `client.chat.completions.create` and
assert both completion helpers send their supplied model. Mock the embeddings
method separately and assert `embed()` still sends `config.embedModel` and
`encoding_format: "float"`.

**Verify**: `cd server && npm run typecheck && npm test && npm run build` -> 0.

### Step 5: Add the visible, resilient selector and historical labels

In `web/src/lib/api.ts`:

- Add `model` to `Chat`/`ChatDetail`.
- Add `model?: string` to assistant message metadata.
- Add `ChatModelOption` and `ModelsResponse` types.
- Add `modelsApi.list(refresh?)` and `chatsApi.updateModel(id, model)`.

Create `web/src/components/ModelSelector.tsx`. Extend the local Radix dropdown
wrapper with radio group/item primitives rather than inventing keyboard
selection. The component must:

- Display the chat's saved model at all times.
- Show endpoint-advertised IDs and optional ownership as secondary text.
- Offer Retry when discovery is unavailable.
- Mark a saved value absent from a successful catalog as "not advertised by
  endpoint"; do not auto-replace it.
- Disable selection while the catalog PATCH is pending or a turn is streaming.
- Derive streaming state from plan 019's entry keyed by the active chat ID.
  Switching away and back to an in-flight chat must keep the selector and Send
  disabled; never infer run ownership from one resettable global stream object.
- Use semantic theme tokens only; plan 023 will audit both themes.

Mount it in the composer controls in `ChatView.tsx`, matching the repository's
documented composer anatomy. On selection, await the PATCH, update both
`detail` and the matching sidebar chat, and retain the prior selection with an
inline error if saving fails. Send must be disabled while the PATCH is pending.

Pass assistant `meta.model` to `ChatMessage` and render it as a subtle,
non-interactive model label. This preserves attribution when the chat later
switches models.

Move the stream error display outside the `stream.running` conditional (while
keeping plan 019's batching/refresh structure) so a provider/model error
remains visible after `finally` sets `running: false`. Clear it only when a new
send starts, the user dismisses it, or another chat loads.

**Verify**: `cd web && npm run typecheck && npm run build` -> 0.

### Step 6: Document and verify the end-to-end contract

Update `README.md` to state:

- Model choices come from the configured endpoint's standard `/v1/models`.
- The selected chat model is durable and snapshotted per turn.
- The configured embedding model is intentionally not user-selectable.
- Chat and embedding model IDs must be distinct and each 1-256 characters;
  document that invariant beside the variables in `server/.env.example`.
- A listed model may still lack chat/tool support; Borealis surfaces that
  provider error and does not silently fall back.

Live verification with at least two operator-approved, tool-capable models:

1. Open a chat: its configured default is visible.
2. Select model B, reload and switch chats: each chat retains its own choice.
3. Send a plain prompt and a prompt that invokes a tool. Endpoint logs and the
   assistant label both show model B.
4. Begin a long turn; the selector is disabled and the in-flight model remains
   unchanged. After completion, a change applies to the next turn.
5. Make discovery unavailable while leaving an already configured completion
   path usable: the saved identity remains visible with Retry.
6. Select a safely invalid/unavailable saved ID through the API: generation
   error remains visible, the selection is preserved, and no default-model
   answer appears.
7. Query the database: `SELECT count(*) FROM chats WHERE model IS NULL;` -> 0.

Do not print bearer tokens or provider credentials while recording results.

## Test plan

- `server/src/tests/models.test.ts`: model response validation, normalization,
  deduplication, sorting, exact embedding exclusion, config invariants,
  cache/coalescing/refresh behavior and degraded discovery.
- `server/src/tests/llm.test.ts`: supplied chat model reaches both SDK request
  paths; embedding still uses only the configured embedding model.
- Authenticated live API probes: catalog auth, account-owned PATCH, cross-account
  404 and persistence after restart.
- Manual web matrix: advertised, unadvertised and discovery-down selections;
  reload/chat-switch persistence; mid-stream disabling; persistent errors;
  historical message labels.
- Full verification: `cd server && npm run typecheck && npm test && npm run build`
  and `cd web && npm run typecheck && npm run build` -> all pass.

## Done criteria

- [ ] `SELECT count(*) FROM chats WHERE model IS NULL;` returns `0`.
- [ ] Authenticated `GET /api/models` returns only `models`, `default_model`
  and `discovery`; unauthenticated access returns 401.
- [ ] `rg -n 'model: config\.chatModel' server/src/llm.ts` returns no chat
  completion matches; `embed()` still contains `model: config.embedModel`.
- [ ] Every `chatOnce` and `streamingChat` call in `agent.ts` passes the
  snapshotted model (covered by typecheck and tests).
- [ ] Invalid/blank/oversized/equal chat and embedding model configuration is
  rejected at boot without logging values.
- [ ] Assistant DB/SSE metadata and rendered history show the model used.
- [ ] Discovery failure and unavailable-model generation errors remain visible
  and never cause silent fallback.
- [ ] Server typecheck/tests/build and web typecheck/build exit 0.
- [ ] No files outside the in-scope list are modified (`git status`).
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report back (do not improvise) if:

- Any dependency is not implemented or its final chat/stream shapes conflict
  with the excerpts and contracts above.
- Product acceptance requires `/v1/models` alone to prove chat/tool capability.
  Choose an explicit operator allowlist or provider adapters in a separate
  design decision; do not guess from model names or issue billable probes.
- Existing chats cannot be backfilled without overwriting a previously added
  model field or another chat creation path is discovered.
- The selector is expected to change the embedding model or dimension.
- Any implementation would expose a provider credential, endpoint URL or raw
  upstream exception to the browser.
- Plan 019 did not leave a per-chat in-flight state that survives navigation;
  do not gate this selector on a resettable global boolean.
- Fewer than two operator-approved tool-capable models exist for the live
  switching scenario; report that part as unverified instead of changing
  provider configuration.

## Maintenance notes

- OpenAI-compatible model catalogs standardize identity, not capability. A
  future model-profile layer can add tool/vision/reasoning badges, but must not
  rewrite saved logical IDs silently.
- Message-level model metadata is the historical record; the chat column is
  only the current choice for the next accepted turn.
- If a future custom agent owns its model, disable this default-agent selector
  rather than creating two competing sources of truth.
- Any future embedding-model picker requires a separate re-embedding and
  pgvector schema migration plan.

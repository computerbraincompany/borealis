# M11 — Personal defaults: the account's own default model

**Horizon:** 2 — *Personal agent — the default workspace brain: model, source
habits, and capabilities that belong to you.*

**Status:** DONE (implemented in commits `9994724` — the per-account default
resolution on the server, and `2fbbd53` — the Settings and composer surfaces;
documentation in the commit that closes this milestone)

**Verification record (2026-08-29):** server 642 unit + 70 integration tests,
web 186 tests, and the complete `pnpm verify` gate green.

## Problem

Every account in a Borealis workspace shares one workspace-level default chat
model (`settings.json`). A member whose work needs a different model must
re-pick it on every new chat. The vision's "personal agent" layer starts with
model ownership that belongs to the account, not the workspace.

## Goal

1. **Per-account default chat model** — an account can set its own default;
   new chats resolve their model as: the composer's explicit choice, else the
   account default, else the workspace default.
2. **Composer and Settings surfaces** — Settings → Account gains the personal
   default; the new-chat composer starts from it.

## Non-goals

- No per-account provider endpoint or API key: the provider configuration
  stays workspace-level (process-wide by design).
- No per-account source-scope habit: new web chats keep starting
  selected-empty — that fail-closed default is an invariant, not a preference.
- No automatic "remember last pick" write: the default changes only when the
  account explicitly saves it in Settings.
- No per-account agents, tools, or retrieval-scope changes; agents remain
  explicitly bound per chat (M05).

## Server spec (slice 1)

- Schema v11: `ALTER TABLE users ADD COLUMN default_chat_model TEXT CHECK
  (default_chat_model IS NULL OR length(default_chat_model) <= 200);`
- User store methods: `getDefaultChatModel(accountId): Promise<string|null>`
  and `setDefaultChatModel(accountId, model: string|null)` (trim to 200; empty
  string normalizes to null).
- `PATCH /api/preferences` (requireAuth, bodyLimit small): body
  `{default_chat_model: string|null}`; shape-validated only — the model id is
  NOT checked against the live catalog (the provider may be unreachable; an
  unadvertised saved id remains explicit rather than being silently rewritten).
  Returns `{default_chat_model}`. Add `GET /api/preferences` returning the same
  shape for surface hydration.
- Resolution: chat creation stamps `accountDefault ?? runtime.settings.chatModel`.
  `GET /api/models` gains `account_default_model: string|null` alongside
  `default_model`. Precedence documented in docs/API.md: per-chat PATCH (after
  create) > account default > workspace default. The configured model of an
  existing chat never changes implicitly.
- Electron bootstrap and every other account keep working unchanged (null
  default until set).

## Web spec (slice 2)

- `api.ts`: `account_default_model` on the models catalog type;
  `preferencesApi.get/set`.
- Settings → Account: "Personal default model" select fed by the model
  catalog with a "Workspace default" (null) option and a bounded save/error
  state matching the existing Account section patterns.
- New-chat composer: the model selector's initial value prefers the account
  default (`account_default_model ?? default_model`). Existing-chat behavior
  unchanged.

## Documentation tasks

- `docs/API.md`: preferences routes, models response field, resolution
  precedence.
- `README.md`: one sentence — accounts can set a personal default chat model
  in Settings; new chats start from it.
- `AGENTS.md`: invariant line — model resolution precedence and that
  selected-empty start remains the fixed fail-closed default (not a
  preference).
- `milestones/README.md`: flip M11 when done.

## Done criteria

- Server tests: migration, store round-trip, PATCH/GET preferences (auth,
  validation, null clears), chat creation stamps the account default, models
  route exposes `account_default_model`.
- Web tests: Settings account default save/clear; new-chat composer initial
  model prefers the account default.
- `pnpm verify` green.

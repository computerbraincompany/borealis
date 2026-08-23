# Plan 027: Make chat history searchable, renamable, and ordered by activity

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result. Honor STOP conditions.
> Update `plans/README.md` when done unless the reviewer maintains the index.
>
> **Drift check (run first)**:
> `git diff --stat 67cc7db..HEAD -- server/src/db.ts server/src/routes.ts server/src/turnContext.ts server/src/tests/modelRoutes.test.ts server/src/tests/dbModels.test.ts server/src/tests/sourceScope.integration.ts web/src/lib/api.ts web/src/pages/ChatView.tsx web/src/components/ChatHistory.tsx plans/README.md`
> Plans 024-026 intentionally change `ChatView.tsx` and `api.ts`. Confirm their
> upload/error/evidence/query-result contracts are present. Any other
> unexplained mismatch is a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW-MED (idempotent schema migration plus strict PATCH union)
- **Depends on**: `plans/026-inline-query-results.md`
- **Category**: direction / ux
- **Planned at**: commit `67cc7db`, 2026-08-23

## Why this matters

North exposes private saved history with keyword search, recency grouping, and
rename controls. Borealis saves chats, but orders them forever by creation
time, renders a flat unfiltered list, and only allows model changes or deletion.
An old conversation that becomes active again stays buried, and a poor
first-message title cannot be fixed. This plan completes that basic personal
chat lifecycle without adding sharing, agents, folders, or semantic memory.

Official behavior references:

- <https://private.docs.cohere.com/docs/get-started/north-chat> documents keyword
  history search, time grouping, and context-menu rename.
- <https://private.docs.cohere.com/docs/get-started/chat-history> documents
  private saved history ordered newest-first and reopen/continue behavior.

## Current state

`server/src/db.ts:57-64` has only creation time:

```sql
CREATE TABLE IF NOT EXISTS chats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'New chat',
  model TEXT,
  source_mode TEXT NOT NULL DEFAULT 'all',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

`server/src/routes.ts:45-47` orders by `created_at DESC`. The PATCH route at
`:148-172` accepts exactly `{ model }`; ownership is correctly enforced.
`server/src/turnContext.ts:69-96` saves a message and auto-titles only the first
message but does not touch chat activity time.

`web/src/pages/ChatView.tsx:511-544` maps one flat list with only open/delete.
`web/src/lib/api.ts:113-119` exposes `created_at` only.

Conventions to preserve:

- Every mutation includes `account_id`; foreign and missing chat IDs return the
  same 404.
- PATCH bodies are strict exact unions and SQL values are parameterized.
- First-message auto-title remains the default until manually renamed.
- Existing per-chat streaming/settings busy guards prevent destructive actions.
- Do not regress plans 024-026 while extracting or changing the history UI.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Server gates | `cd server && npm run typecheck && npm test && npm run build` | exit 0; all tests pass |
| Web gates | `cd web && npm run typecheck && npm run build` | exit 0; existing chunk warning allowed |
| DB integration | `cd server && RUN_SOURCE_SCOPE_INTEGRATION=1 TEST_DATABASE_URL='<scratch-postgres-url-with-database-ending-_test>' npm run test:integration` | all scoped DB tests pass; setup guard confirms the target differs from ambient `DATABASE_URL` |
| Full gate | `./scripts/verify.sh` | all gates green |

## Scope

**In scope**:

- `server/src/db.ts`
- `server/src/routes.ts`
- `server/src/turnContext.ts`
- `server/src/tests/modelRoutes.test.ts` or a focused new chat-routes test
- `server/src/tests/dbModels.test.ts`
- `server/src/tests/sourceScope.integration.ts` (extend the existing real-DB
  turn/concurrency harness for post-commit activity and title provenance)
- `web/src/lib/api.ts`
- `web/src/pages/ChatView.tsx`
- `web/src/components/ChatHistory.tsx` (create)
- `plans/README.md`

**Out of scope**:

- Server-side full-text/semantic search, pagination, folders, pinning, archive,
  sharing, export, branching, agents, or cross-chat memory.
- LLM-generated title calls; keep the existing zero-cost first-message slice.
- Changing message order, deleting/retrying messages, or cancellation.
- Renaming reports/sources/connectors.

The integration command is intentionally guarded by
`server/src/tests/integrationSetup.ts`: the database name must end in `_test`,
`RUN_SOURCE_SCOPE_INTEGRATION` must be exactly `1`, and the target must differ
from ambient `DATABASE_URL`. Create and later drop only that explicitly named
disposable database using the repository's local Postgres credentials. Never
substitute the development `borealis` database.

## Git workflow

- Branch: `codex/027-chat-history-controls`
- Conventional commit example: `feat: improve chat history navigation`
- Do not push independently; the primary reviewer will integrate and push.

## Steps

### Step 1: Add idempotent chat activity and title-provenance fields

In `db.ts`:

1. Add `updated_at TIMESTAMPTZ NOT NULL DEFAULT now()` to new chat schema.
2. Add `title_is_manual BOOLEAN NOT NULL DEFAULT false` to new chat schema. This
   is internal provenance; it does not need to be exposed in API responses.
3. Add idempotent `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` migrations for both
   columns.
4. Backfill only null `updated_at` values from `created_at`, then set it NOT NULL and
   default `now()`. Keep every migration idempotent across repeated boot.
5. Backfill only null `title_is_manual` values to `false`, then set the column
   NOT NULL and default `false`. Existing rows are treated as auto-titled; future
   explicit title mutations establish manual provenance.
6. Add a stable index supporting the account history order, e.g.
   `(account_id, updated_at DESC, id)`.

Include `updated_at` in chat create/list/detail/mutation response shapes and
order list by `updated_at DESC, id DESC` for deterministic ties.

Do **not** update the `chats` row inside the repeatable-read acceptance
transaction. The integration contract deliberately allows model/source
settings to change concurrently after the turn snapshot; acquiring a chat-row
write lock inside that transaction would block those changes, while writing
after the test barrier would create a PostgreSQL serialization failure.

After the user-message transaction commits, use the accepted message's database
`created_at` value in one separate parameterized chat update:

- `updated_at = GREATEST(updated_at, <accepted message created_at>)`, so
  out-of-order completion of two post-commit updates cannot move activity back.
- For the first message only, set the generated title with a conditional
  expression that changes it only when the current title is still `New chat`
  **and** `title_is_manual=false`. A manual or custom title must win, including
  the intentional manual title `New chat`.
- Constrain by chat ID plus account ID. Treat this as presentation bookkeeping,
  not accepted-turn provenance; a failure must not roll back the already
  committed message. Log only a stable failure label if it is best-effort.

This preserves the existing source/model concurrency choreography while making
activity eventually consistent immediately after acceptance.

**Verify**: unit tests assert migration ordering/idempotent SQL shape; server
typecheck/tests pass.

### Step 2: Extend PATCH with a strict title operation

Change `PATCH /api/chats/:id` to accept exactly one of:

```json
{ "model": "chat-model-id" }
{ "title": "Quarterly budget review" }
```

Preserve all existing model validation. For title:

- Require a string, trim it, and require 1-80 Unicode characters.
- Reject extra fields, both fields, missing fields, arrays, and non-objects 400.
- Parameterize the update and constrain by chat ID plus account ID.
- Set `title_is_manual=true` and `updated_at=now()` for every successful title
  rename, even when the chosen title is exactly `New chat`, and return the
  normal list-chat shape. Return the same 404 for missing/foreign IDs.

Prevent the first-message auto-title from overwriting a manual rename racing
with the first turn: the post-commit bookkeeping update changes the title only
while it is still exactly `New chat` and the manual marker is false. When
`POST /api/chats` receives an explicit valid title, insert that chat with
`title_is_manual=true`; a request that omits title keeps the default title and
false marker. Preserve the marker on model-only PATCH. Test this provenance
condition and the monotonic `GREATEST` timestamp.

**Verify**: route tests cover valid trim, empty/oversize/extra/both/model
regressions, account isolation, and auto-title race protection.

### Step 3: Add client-side search and relative-date groups

Add `updated_at` and `chatsApi.updateTitle` to `web/src/lib/api.ts`.

Create `ChatHistory.tsx` (or an equivalently isolated component) and replace
the inline flat list. It receives chats, active/busy state, and open/delete/
rename callbacks. Required behavior:

- A labelled search input filters title with case-insensitive substring match.
- Group filtered chats by local calendar/activity time into `Today`,
  `Yesterday`, `Previous 7 days`, and `Older`; omit empty groups.
- Keep each group in server order and show an explicit no-match state distinct
  from no conversations.
- Offer an accessible Rename action per row. Inline editing supports Enter to
  save, Escape to cancel, blur with a deliberate consistent behavior, and a
  visible pending/error state. Delete retains its busy guard.
- A successful rename updates both sidebar state and active detail title. A
  failure retains the old title and gives a retryable inline error.
- Search and editing must not trigger chat navigation accidentally.

Use semantic theme tokens and keep the existing 260px column; responsive shell
redesign is outside scope.

**Verify**: web typecheck/build plus keyboard browser checks.

### Step 4: Keep activity order coherent during normal use

`ChatView` already calls `loadChats()` after a stream finishes. Preserve that
refresh so the accepted turn's server timestamp moves the chat to the top.
Creating a chat still inserts it at the top. A rename response should update
and re-sort local state immediately or reload the authoritative list.

Verify these cases:

1. Continue an old chat -> it moves to Today/top after the turn is accepted.
2. Rename active and inactive chats -> title and order update without losing
   current detail, stream, source, model, evidence, or query-result state.
3. Search while a background chat streams -> row remains busy and hidden/
   visible solely by title filtering; stream ownership stays keyed by ID.
4. Reload -> server order/grouping matches the prior state.

**Verify**: full gate, production builds, and guarded disposable-DB integration.

## Test plan

- Route tests: strict title/model union and account-safe rename.
- DB/init test: activity/manual-title migration, backfill, defaults, and index
  statements.
- Turn/integration test: the repeatable-read snapshot still permits the
  existing concurrent model/source update; only after commit does the separate
  monotonic bookkeeping update advance activity without changing provenance.
  Cover default auto-title, explicit create title, concurrent manual rename,
  and an intentional manual rename to exactly `New chat`.
- Browser: group boundaries, no matches, Enter/Escape rename, failure recovery,
  recency reorder, active/background streaming, Light/Dark.

## Done criteria

- [x] Chats have idempotently migrated activity and manual-title provenance.
- [x] Accepted turns advance activity through post-commit monotonic bookkeeping;
      title changes advance activity and list order is stable.
- [x] Account-owned titles can be renamed with strict validation.
- [x] First-message auto-title cannot overwrite an explicit create title or a
      concurrent manual rename, including the literal title `New chat`.
- [x] History supports keyword filtering and the four date groups.
- [x] Existing stream/model/source/evidence/query behavior remains intact.
- [x] Server/web/full gates and guarded integration pass.

## STOP conditions

Stop and report if:

- Migration would rewrite non-null activity timestamps on every boot.
- Activity/rename cannot be made race-safe without moving a chat-row write into
  the repeatable-read snapshot transaction.
- UI extraction would require a routing or responsive-shell rewrite.
- A disposable test database cannot be positively identified for integration.
- Verification fails twice after a reasonable correction.

## Maintenance notes

- Client-side filtering is intentional for the MVP's unpaginated personal
  history. Add server search together with pagination when history scale proves
  it necessary.
- Use activity, not creation time, for any future archive/pin design.

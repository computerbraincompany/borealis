# M04 — Libraries: governed collections above a pile of uploads

**Horizon:** 2 ("the intelligence layer") — *Libraries — governed collections
above a pile of uploads. A library is something you attach, share inside a
trust boundary, and cite.*

**Status:** DONE (implemented in commits `4eca825` — schema v5, library store,
and routes — and `3170674` — the Libraries web surface; verification recorded
in milestones/README.md)

**Verification record (2026-08-29):** server 564 tests, web 139 tests, lint,
format, builds, and desktop native smoke green via `pnpm verify`. Live
browser-development check with a stub OpenAI-compatible embeddings provider:
uploaded `budget.csv` to ready, created library "Budget check", added the
member, and **Attach to new chat** created a chat whose composer showed
"1 source" with budget.csv attached — the explicit selected-scope expansion
working end to end.

## Problem

Sources are a flat list. The vision's intelligence layer expects a governed
collection you can name, curate, and attach — "a library is something you
attach, share inside a trust boundary, and cite." Nothing above the individual
source exists yet.

## Goal

1. **Library entity** — account-scoped named collections of sources with
   membership management; sources are referenced, never copied or moved.
2. **Attach by explicit expansion** — "Attach to new chat" resolves the
   library's ready members into the chat's selected scope at attach time. The
   load-bearing three-meaning scope contract is untouched: no dynamic scope, no
   new resolution path on the server.
3. **Library surface** — a Libraries nav surface with create, rename, member
   curation, and attach actions.

## Non-goals

- No durable `chat.library_id` binding and no dynamic per-turn library
  resolution; attaching expands members explicitly (v1). A binding that
  re-resolves on library change is a later, separately specced change to
  `sourceScope.ts`.
- No cross-account sharing, no connector members, no permissions.
- No changes to ingestion, retrieval scoping, or the 100-source scope cap
  semantics.

## Backend spec

Migration v5 (read `migrations.ts` and `sourceStore.ts` first):

- `libraries (id, account_id → users ON DELETE CASCADE, name TEXT NOT NULL,
  created_at, updated_at)` STRICT; `UNIQUE (account_id, name)`.
- `library_sources (library_id, source_id, account_id, added_at,
  PRIMARY KEY (library_id, source_id), FK (library_id, account_id) →
  libraries ON DELETE CASCADE, FK (source_id, account_id) → sources
  ON DELETE CASCADE)` STRICT.

Routes (all requireAuth, account-scoped, following the sources route shape):

- `GET /api/libraries` → `[{id,name,member_count,created_at,updated_at}]`.
- `POST /api/libraries` `{name}` (1–120 chars; trimmed; unique per account).
- `GET /api/libraries/:id` → library + `members: Source[]` (same DTO as the
  sources list).
- `PATCH /api/libraries/:id` `{name}` rename.
- `DELETE /api/libraries/:id` → `{"ok":true}`; membership rows cascade;
  sources and their data are untouched.
- `PUT /api/libraries/:id/sources` `{source_ids: string[]}` (bounded to 100,
  all owned by the account) replaces the membership set exactly.
- Errors follow the existing plain `{error}` envelope; unknown/foreign library
  or source → 404; oversize/invalid body → 400.

Tests: migration on existing data; CRUD + rename uniqueness; membership
replace semantics (exact set, dedup, foreign source rejected); delete leaves
sources intact; tenant isolation on every route.

## Web spec

- New **Libraries** nav item and `LibrariesView`: list with member counts,
  create dialog, rename, delete (membership only — copy says so), and a
  member editor (add from existing sources via multi-select; remove).
- "Attach to new chat": resolves ready members client-side and starts a new
  chat with `source_mode: "selected"` + those ids via the existing chat-creation
  contract; if the expanded scope exceeds 100 sources the action is disabled
  with an explanation rather than truncated.
- Tests: list/create/rename/delete flows; member editing; attach disabled
  over the cap.

## Documentation tasks

- `docs/API.md`: library routes and the explicit-expansion contract.
- `README.md`: Libraries surface sentence.
- `AGENTS.md`: invariants — libraries reference sources; attach is expansion
  at attach time; no server-side dynamic scope; deletion never touches sources.
- `milestones/README.md`: flip M04 when done.

## Done criteria

- `pnpm verify` green including the new tests.
- A library can be created, curated, renamed, and attached to a new chat whose
  selected scope equals the library's ready members; deleting the library
  leaves every source and its data intact.

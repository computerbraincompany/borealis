# M02 — Artifact lineage: report versions, rename, stored payloads, chart registry

**Horizon:** 2 ("the intelligence layer") — *Promote reports, charts, and query
receipts into a real artifact model with versions and lineage… Artifacts —
documents, tables, charts, and reports with versions and provenance. Chat
creates them; it does not trap them.*

**Status:** IN PROGRESS

## Problem

Reports are single immutable rows: there is no rename, no notion of a second
analysis of the same chat superseding the first, and the normalized report
payload is rebuilt from the chat transcript every time. Charts persist with run
lineage but have no account-level registry, so the durable chart corpus is
invisible outside a single chat view. The vision requires artifacts with
versions and provenance that survive their thread.

## Goal

1. **Report versions with lineage** — when the agent produces a report in a
   chat that already has reports, the new report records `version = max+1` and
   `supersedes = previous report id` for that chat. Every version stays
   listable; nothing is auto-deleted.
2. **Report rename** — owners can correct a garbled model title via
   `PATCH /api/reports/:id` without touching artifact files.
3. **Stored payload** — each report stores its normalized payload (markdown
   sections and chart IDs) at creation, exposed on the detail endpoint so
   future export/regeneration does not depend on replaying the chat.
4. **Chart registry** — `GET /api/charts` lists the account's published chart
   artifacts (bounded, newest first) so the web UI can show a durable gallery
   with links back to the originating chat.

## Non-goals

- No model-driven regeneration endpoint yet; versions arise from real agent
  runs. A future milestone may add regeneration on top of the stored payload.
- No document/table artifacts and no "Artifacts" nav rename yet — reports and
  charts gain lineage first; the surface renames when a third artifact kind
  exists.
- No sharing, no cross-account anything.
- No change to the pending→published run lifecycle or the deletion/cleanup
  protocol beyond the new columns.

## Backend spec

Migration (next schema version, STRICT, following `server/src/db/migrations.ts`
conventions; read it plus `storageRuntime.ts` and `reportCleanup.ts` first):

- `reports` gains `version INTEGER NOT NULL DEFAULT 1`,
  `supersedes TEXT REFERENCES reports(id)` (same account, enforced in code),
  and `payload TEXT CHECK (payload IS NULL OR json_valid(payload))`.
- Existing rows keep `version = 1` and null lineage/payload — no backfill.

Behavior:

- Report creation (the `create_report` tool path in `server/src/tools.ts` →
  `runStore.ts`) looks up the chat's newest published report and sets
  `version`/`supersedes` accordingly; chats with no prior report get version 1.
  The stored payload is the `normalizeReport` output, bounded by the existing
  report payload budget; oversize keeps the report and drops the payload
  (`payload IS NULL`), never fails the report.
- `PATCH /api/reports/:id` accepts `{title}` (same validation as creation),
  bumps `updated_at`, and is account-scoped like every other report route.
- `GET /api/reports` DTOs add `version` and `supersedes`;
  `GET /api/reports/:id` additionally returns the stored `payload` when present.
- `GET /api/charts` returns the account's published charts, newest first,
  bounded (200) with `{id, run_id, chat_id, title, kind, created_at}` derived
  from the canonical spec — no PNG bytes, no raw spec echo in the list. PNG
  remains `GET /api/charts/:id`.
- Sanitization unchanged: no model text in logs; DTO fields are already
  user-visible report/chart metadata.

Tests:

- Migration applies on a fresh database and on a database containing v-current
  rows (old rows keep version 1, null lineage).
- Version assignment: two reports in one chat → 1 → 2 with supersedes chain;
  cross-account and cross-chat isolation; pending (failed run) reports do not
  join the chain.
- Rename: owner rename works, foreign account 404/403 per existing convention,
  empty/oversize title rejected.
- Payload: stored on success, dropped oversize, returned on detail only.
- Chart list: published-only, bounded, account-scoped, ordered.

## Web spec

- `web/src/lib/api.ts`: report DTO gains `version`/`supersedes`; detail gains
  `payload`; add `chartsApi.list()` and `reportsApi.rename()`.
- Reports view: report cards show a version badge (`v2`) and, when present, a
  "supersedes v1" link to that report; a rename action opens a small dialog
  and optimistic-updates the card. A "Charts" section below reports lists the
  registry (thumbnail via the existing PNG route, title, kind, date, link to
  the source chat when known).
- Keep the nav label "Reports" this milestone.

## Documentation tasks

- `docs/API.md`: PATCH /api/reports/:id, GET /api/charts, version/lineage and
  payload fields, list bounds.
- `README.md`: one sentence — reports keep versions and lineage; the Reports
  surface lists chart artifacts.
- `AGENTS.md`: note the per-chat monotonic version invariant (assigned at
  creation, pending reports excluded) and that superseded reports are never
  auto-deleted.
- `milestones/README.md`: flip M02 status when done.

## Done criteria

- `pnpm verify` green, including the new migration/versioning/chart-registry
  tests and web tests.
- Two successive report-producing runs in one chat yield v1/v2 with a working
  supersedes chain in the UI.
- Rename persists across reload; chart gallery shows persisted charts from
  earlier runs.

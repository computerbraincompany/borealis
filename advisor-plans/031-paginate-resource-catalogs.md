# Plan 031: Paginate resource catalogs without hiding older records

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: MED
- **Depends on**: none; land before plan 022
- **Category**: correctness / performance / API
- **Planned at**: `14ab08f`, 2026-08-31

## Why this matters

Sources and connectors silently stop at the newest 200 rows with no continuation
mechanism. Chats, reports, agents, libraries, and automations return unbounded
arrays. The former makes old resources unmanageable; the latter makes initial
requests and React state grow with workspace age.

## Target contract

- Catalog endpoints return `{ items, next_cursor }` with a default page of 50
  and a hard maximum of 100.
- Cursors are bounded opaque base64url payloads containing only the endpoint's
  deterministic ordering tuple. Malformed, oversized, cross-endpoint, or
  wrong-version cursors return 400 and never widen tenant scope.
- Pagination is keyset-based with stable tie-breaking IDs: `created_at,id`, or
  `updated_at,id` for chats.
- No page skips or duplicates records that share timestamps. Concurrent newer
  inserts do not perturb traversal behind an existing cursor.
- Web catalogs expose explicit loading and “Load more” behavior; target pickers
  can reach older records rather than silently using only page one.

## Scope

- SQLite list methods for sources, connectors, chats, reports/shared reports,
  agents, libraries, and automations
- routes/schemas, `web/src/lib/api.ts`, hooks/views/sidebar/pickers, tests, and
  `docs/API.md`
- chart and bounded history endpoints remain under their specialized contracts

## Implementation steps

1. Add a shared versioned cursor codec with endpoint discriminator, bounded
   decoded size, strict timestamp/ID validation, and no secret or SQL text.
2. Implement keyset page queries under exact account scope, fetching `limit+1`
   to derive `next_cursor`; add matching account/order indexes only if query-plan
   tests show they are needed. Avoid a schema migration unless necessary.
3. Change route responses and document the pre-1.0 API break. Do not retain an
   undocumented array/envelope dual mode.
4. Add a generic web page type and migrate each consumer. Use explicit “Load
   more” controls or incremental sidebar loading; never auto-fetch the entire
   catalog merely to recreate the old unbounded behavior.
5. Cover equal timestamps, deletion between pages, newer insertion, malformed
   cursors, tenant isolation, empty/final pages, and target selection beyond 100.
6. Update API polling guidance so ingestion refreshes page one without dropping
   already loaded older rows.

## Verification

- Focused store/route/web tests; query plans for large fixtures; server/web
  checks and builds; full `pnpm verify`.

## Done criteria

- [ ] Every primary catalog is bounded and continuable.
- [ ] Older sources/connectors remain manageable and selectable.
- [ ] No consumer silently treats a page as the full account catalog.
- [ ] Contracts/docs/tests use one response shape.

## STOP conditions

- A cursor depends on offset, client-supplied account identity, unsigned SQL, or
  mutable non-unique ordering.
- Chat/source scope semantics would widen when a page is incomplete.

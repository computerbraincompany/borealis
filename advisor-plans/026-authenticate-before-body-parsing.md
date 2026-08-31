# Plan 026: Authenticate protected requests before body parsing

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none; land before plans 018 and 022
- **Category**: security
- **Planned at**: `14ab08f`, 2026-08-31

## Why this matters

Fastify parses request bodies before `preHandler`. Borealis uses `preHandler`
for authentication and a 20 MiB global body limit, so an unauthenticated caller
can force large JSON buffering and parsing on small protected routes before the
server returns 401.

## Target contract

- Every protected route authenticates in `onRequest`, before content parsing.
- Public registration, login, and health behavior remains explicit.
- The global JSON ceiling is a small fail-safe; every intentionally larger
  payload route declares its own derived limit.
- Agent, automation, library, report-share, contained, consent, preferences,
  settings, connector, chat, and source mutations have limits derived from
  their schema/resource contract.
- Invalid or oversized unauthenticated bodies return 401 without invoking the
  parser, validation, stores, or route handler. Authenticated oversize requests
  return the stable payload-too-large envelope.

## Scope

- `server/src/auth.ts`, route registration under `server/src/routes/`, and the
  Fastify global limit in `server/src/serverApp.ts`
- HTTP boundary/auth/route tests and API resource-budget documentation

Do not weaken JWT validation, CORS, request-ID sanitization, upload streaming,
or the desktop bootstrap boundary.

## Implementation steps

1. Move `requireAuth` registrations from `preHandler` to `onRequest`, including
   the authenticated OpenAPI route, without changing public routes.
2. Lower the global default to a conservative JSON ceiling and inventory every
   larger body route. Preserve explicit upload and message budgets.
3. Add exact small limits to remaining mutation routes based on maximum encoded
   schema size plus bounded JSON overhead.
4. Add instrumentation-free tests proving authentication runs before a custom
   parser and that stores are untouched for unauthenticated oversized bodies.
5. Test authenticated over-limit behavior for one small JSON route, messages,
   and multipart upload; retain request-ID/error redaction.

## Verification

- Focused auth/HTTP/route tests, server checks, integration tests, `pnpm policy`,
  and `pnpm verify`.

## Done criteria

- [ ] All protected routes authenticate before parsing.
- [ ] Every body-bearing route has a documented effective limit.
- [ ] Large legitimate message/upload flows remain functional.
- [ ] No public route accidentally becomes protected or vice versa.

## STOP conditions

- A Fastify lifecycle change makes `onRequest` parse bodies first; prove the
  installed version's behavior before choosing another early hook.
- A body limit is guessed rather than derived from the route contract.

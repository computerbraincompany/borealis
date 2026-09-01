# Plan 026: Authenticate protected requests before body parsing

## Status

- **State**: DONE (2026-09-01)
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
- The global request-body parser ceiling is a small fail-safe; every
  intentionally larger payload route declares its own derived limit.
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

- [x] All protected routes authenticate before parsing.
- [x] Every body-bearing route has a documented effective limit.
- [x] Large legitimate message/upload flows remain functional.
- [x] No public route accidentally becomes protected or vice versa.

## Completion record

- Protected routes use `onRequest` authentication, the global fallback is 8
  KiB, and every larger JSON/upload contract declares an explicit schema-derived
  limit, including 3,424-byte Preferences, 29,962-byte connector, 32 KiB chat
  create/scope, 8 KiB chat patch, and 157,696-byte Settings draft ceilings.
- `routeSecurityPolicy`, HTTP-boundary, server composition, upload, and message
  tests cover 401-before-parser precedence, worst-case escaped legal payloads,
  and authenticated 413 behavior; the complete server unit and integration
  suites pass.

## STOP conditions

- A Fastify lifecycle change makes `onRequest` parse bodies first; prove the
  installed version's behavior before choosing another early hook.
- A body limit is guessed rather than derived from the route contract.

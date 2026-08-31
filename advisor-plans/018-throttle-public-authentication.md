# Plan 018: Throttle public authentication before password work

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving on. If a “STOP condition” occurs, stop and report — do not improvise. When done, update this plan’s row in `advisor-plans/README.md` unless the reviewer told you they own the index.
>
> **Drift check (run first)**: `git diff --stat f1b9293..HEAD -- server/src/auth.ts server/src/authThrottle.ts server/src/tests/authThrottle.test.ts server/src/tests/authRoutes.test.ts server/src/tests/modelRoutes.test.ts`
> Plans 007 and 014 intentionally change `auth.ts`, route options, and the
> model-route test composition: compare their completed target contracts before
> editing. `AuthPayload.desktopOperator?: true`, `requireDesktopOperator`,
> claim-free register/login tokens, desktop-bootstrap-only capability minting,
> and Plan 014's explicit owned scheduler route capability are expected drift
> and must be preserved. STOP on any other material route, proxy-trust, or
> authentication change.
> **Read-only dependency check**: inspect `server/src/desktopBootstrap.ts`, `server/src/routes.ts`, `server/src/serverApp.ts`, `server/src/httpErrors.ts`, and `server/src/tests/desktopBootstrap.test.ts`; these establish capability, route, proxy, error, and regression contracts but are not editable in this plan.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: `advisor-plans/007-restrict-contained-engine-control.md`, `advisor-plans/014-create-owned-application-runtime.md`
- **Category**: security
- **Planned at**: commit `f1b9293`, 2026-08-30

## Why this matters

Both public authentication routes permit unlimited bcrypt work. An unauthenticated client can consume CPU with login attempts or registrations, and login has no account-oriented brake against repeated guessing. Add a deterministic, bounded, in-memory limiter before bcrypt while preserving public registration, JWT behavior, generic login failures, and the repository’s no-arbitrary-proxy-trust posture.

## Current state

- `server/src/auth.ts:39-65` registers users publicly and reaches bcrypt with no attempt gate:

  ```ts
  app.post(
    "/api/register",
    { bodyLimit: 2 * 1024, schema: { body: authBodySchema, security: [] } },
    async (req, reply) => {
      // body normalization and validation
      const hash = await bcrypt.hash(password, 10);
      let user;
  ```

- `server/src/auth.ts:67-88` likewise performs an unthrottled lookup and compare:

  ```ts
  app.post(
    "/api/login",
    { bodyLimit: 2 * 1024, schema: { body: authBodySchema, security: [] } },
    async (req, reply) => {
      // body normalization and validation
      const user = await storageRuntime().chats.findUserByEmail(email);
      if (!user || !(await bcrypt.compare(password, user.password_hash)))
        return reply.code(401).send({ error: "invalid credentials" });
  ```

- `server/src/serverApp.ts:90-99` constructs Fastify without proxy trust:

  ```ts
  export async function buildBorealisApp(options: BuildBorealisAppOptions = {}): Promise<FastifyInstance> {
    const app = Fastify({ logger: options.logger ?? true, bodyLimit: MAX_BODY_BYTES });
    setAppLogger(app.log);
  ```

  Therefore `request.ip` is the socket peer. Do not enable `trustProxy` or use `X-Forwarded-For` in this plan.

- `server/src/httpErrors.ts:13-55` establishes the stable request-ID boundary: every safe HTTP error uses `String(reply.getHeader("X-Request-ID") || req.id)`, and unexpected errors log only bounded names/codes. Match that response discipline.
- `server/src/tests/modelRoutes.test.ts:188-217` checks that register/login remain explicit public OpenAPI operations. There are no dedicated auth route or throttle tests at the planned commit.
- Plan 007 adds `AuthPayload.desktopOperator?: true` and a `requireDesktopOperator` prehandler. Only `createDesktopBootstrapSession` may mint the exact literal claim; tokens returned by registration/login must remain claim-free even after this plan refactors route dependencies.
- Public registration is an accepted product behavior. This plan limits abuse; it does not require invitations or disable registration on non-loopback binds.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Focused tests | `pnpm --filter borealis-server exec vitest run src/tests/authThrottle.test.ts src/tests/authRoutes.test.ts src/tests/modelRoutes.test.ts src/tests/desktopBootstrap.test.ts` | exit 0; auth, capability, and OpenAPI cases pass |
| Typecheck | `pnpm --filter borealis-server typecheck` | exit 0, no errors |
| Lint | `pnpm --filter borealis-server lint` | exit 0, no warnings |
| Format | `pnpm --filter borealis-server format:check` | exit 0 |
| Server gate | `pnpm --filter borealis-server test && pnpm --filter borealis-server test:integration` | exit 0 |
| Repository gate | `pnpm verify` | exit 0 and prints `ALL GATES GREEN` |

## Scope

**In scope** (the only files you should modify):

- `server/src/auth.ts`
- `server/src/authThrottle.ts` (create)
- `server/src/tests/authThrottle.test.ts` (create)
- `server/src/tests/authRoutes.test.ts` (create)
- `server/src/tests/modelRoutes.test.ts`

`server/src/routes.ts`, `server/src/serverApp.ts`, and `server/src/httpErrors.ts` are read-only exemplars. STOP before changing them.

**Out of scope**:

- Disabling or invitation-gating public registration.
- JWT expiry, signing, password policy, bcrypt cost, login error wording, or session behavior.
- Generic API throttling, distributed/Redis-backed limiting, CAPTCHA, account lockout, or persistence across restarts.
- Trusting proxy-supplied client-address headers or changing deployment topology.
- Adding limiter/auth diagnostics that log IPs, email addresses, submitted
  credentials, bucket keys, or request bodies. The existing Fastify access
  logger may retain its current socket-peer metadata; changing global request
  logging is outside this plan.
- Changing, moving, weakening, or re-minting plan 007’s desktop-operator capability/prehandler.
- Documentation; plan 023 owns it.

## Git workflow

- Branch: `codex/018-auth-throttling`
- Follow conventional commits; an observed example is `feat: set a personal default chat model in Settings and start new chats from it`.
- Suggested commit: `fix: throttle public authentication`
- Do not push or open a PR without explicit operator instruction.

## Steps

### Step 1: Implement a deterministic bounded limiter

Create `server/src/authThrottle.ts`. Define named, fixed policy constants and explain them in code:

- registration: at most 5 attempts per socket IP in a per-bucket fixed 15-minute window beginning with that bucket's first attempt;
- login: at most 20 gross attempts per socket IP and 10 attempts per normalized email identity in the same per-bucket fixed-window model;
- at most 10,000 live keys across all buckets.

Export `createAuthThrottle(options?)`, returning exactly `consumeRegistrationIp(ip)`, `consumeLoginIp(ip)`, `consumeLoginEmail(normalizedEmail)`, and `resetLoginEmail(normalizedEmail)`. Each consume method returns `{ allowed: true } | { allowed: false; retryAfterSeconds: number }`; callers cannot choose an arbitrary scope/key namespace. The package-internal options accept only an injectable monotonic `now` and optional 32-byte test HMAC key. Use no background timer: prune expired entries lazily. When at capacity, first prune expired entries; if no capacity remains, reject a new key fail-closed with a bounded retry time. Never evict a live bucket to admit an attacker-controlled key.

Derive normalized-email bucket keys with HMAC-SHA-256 under a fresh 32-byte random key created for each Fastify app registration. A plain SHA-256 digest is not acceptable because normalized email addresses are dictionary-recoverable. Keep the key only in that app's limiter closure: never persist, log, expose, return, or place either the key or a digest in an error. Permit a caller-supplied 32-byte key only through the package-internal constructor/dependency seam used by deterministic tests; production must always use `randomBytes(32)`. Validate that retry seconds are positive integers and never exceed the configured window.

**Verify**: `pnpm --filter borealis-server exec vitest run src/tests/authThrottle.test.ts` → exit 0 for exact threshold, independent scopes, clock advance, lazy expiry, capacity saturation, and reset behavior.

### Step 2: Gate routes before bcrypt

First confirm plan 007 is `DONE` and its auth/desktop-bootstrap tests pass. Change `authRoutes` to accept an optional dependency object used only by tests; production must construct one limiter and one fresh HMAC key per Fastify app registration, not process-global singletons. Test injection may supply a deterministic HMAC key, clock, and password/store seams, but no request, route option, environment variable, or persisted setting may select key material. Preserve `AuthPayload.desktopOperator?: true`, `verifyToken`’s exact-literal handling, and `requireDesktopOperator` without copying them into the throttle module.

For `/api/register`, consume the socket-IP registration bucket before `bcrypt.hash`. For `/api/login`, consume both the socket-IP gross bucket and normalized-email bucket before any user lookup or `bcrypt.compare`. Count every syntactically usable attempt before expensive password work; a successful login may clear only that email identity’s failure bucket. It must not clear the gross IP bucket. Invalid bodies still use the existing 400/401 responses and must never reach bcrypt.

Evaluate and consume both login buckets exactly once for every syntactically
usable login, even when the first result already denies; never short-circuit in
a way that reveals or weakens the other scope. If either denies, return the
same 429 envelope and the fixed full-window `Retry-After: 900`. Ignore both
per-bucket remaining times at the route boundary. Registration uses the same
fixed 900-second denial header. This deliberately conservative constant is
independent of bucket age, capacity path, evaluation order, or which scope
denied.

On denial, return status 429, integer `Retry-After`, and exactly the stable safe envelope:

```json
{"error":"too many authentication attempts","code":"AUTH_RATE_LIMITED","request_id":"<request-id>"}
```

Do not vary the response by whether the email exists or which bucket fired. Add documented 429 responses to both route schemas while preserving `security: []`.

The `signToken` calls in register/login must still pass only `{ userId, email }`. Do not forward the desktop capability from request state or a generic auth dependency.

**Verify**: `pnpm --filter borealis-server typecheck && pnpm --filter borealis-server lint` → exit 0; both routes compile and the limiter runs before password work.

### Step 3: Add route-level abuse and privacy tests

Create `server/src/tests/authRoutes.test.ts` with a minimal Fastify app using `installHttpBoundary`, an injected limiter clock, and injected/stubbed password/store dependencies if the route needs them. Follow the injection/setup style in `server/src/tests/modelRoutes.test.ts`; do not introduce module-cache mutation.

Cover:

- requests below each limit preserve the current register/login status and body shapes;
- the exact next request gets 429 with the generic body, request ID, and integer `Retry-After`;
- advancing the fake clock past the window permits the request;
- IP and email buckets are independent, and two IPs still share the email-identity brake;
- IP-only denial, email-only denial, and simultaneous denial all consume both
  login scopes and return the identical body plus exact `Retry-After: 900`
  regardless of bucket ages or evaluation order;
- differently cased/trimmed forms that normalize to the same synthetic email consume one identity bucket, without asserting, snapshotting, or exposing the actual HMAC digest;
- a successful login clears only its email bucket, not the gross IP bucket;
- decoded register/login tokens have no `desktopOperator` claim, while the existing desktop-bootstrap test still proves only that path receives the literal claim;
- a throttled request never calls the user store, `bcrypt.hash`, or `bcrypt.compare`;
- a spoofed `X-Forwarded-For` value cannot change the socket-IP bucket;
- capacity saturation fails closed and remains bounded;
- neither HMAC key/digest material nor submitted values appear in limiter/auth
  logger calls or responses; do not assert that the unchanged Fastify access
  logger omits its ordinary socket peer;
- OpenAPI still marks both routes public and documents 429.

Use non-sensitive synthetic identifiers and never snapshot submitted credential values.

**Verify**: `pnpm --filter borealis-server exec vitest run src/tests/authThrottle.test.ts src/tests/authRoutes.test.ts src/tests/modelRoutes.test.ts` → exit 0 with all listed cases.

### Step 4: Run all gates

Run the server’s complete unit/integration/style gates and the repository gate. Do not change the fixed limits merely to satisfy timing-sensitive tests; all timing tests must use the injected clock.

**Verify**: `pnpm --filter borealis-server typecheck && pnpm --filter borealis-server lint && pnpm --filter borealis-server format:check && pnpm --filter borealis-server test && pnpm --filter borealis-server test:integration && pnpm verify` → exit 0 and prints `ALL GATES GREEN`.

## Test plan

- Pure limiter tests in `authThrottle.test.ts`: boundaries, independent buckets, equivalent normalization, expiry, positive retry values, reset semantics, and hard storage cap, using a deterministic synthetic 32-byte HMAC key without asserting real digest material.
- Route tests in `authRoutes.test.ts`: order before bcrypt/store, stable 429 envelope/header, no account enumeration, forwarded-header rejection, and successful existing behavior.
- OpenAPI regression in `modelRoutes.test.ts`: register/login stay public and advertise 429.
- Full server and repository gates detect unintended authentication, formatting, and web regressions.

## Done criteria

- [ ] Registration and login reject abusive traffic before any bcrypt operation.
- [ ] Login has both socket-IP and normalized-email throttles; registration has a socket-IP throttle.
- [ ] Each Fastify app owns one fresh in-memory HMAC key and limiter; normalized-email buckets use HMAC-SHA-256, never plain hashes or plaintext identities.
- [ ] The limiter has deterministic expiry, a hard live-key bound, and fail-closed saturation.
- [ ] 429 replies are generic and request-ID-bearing; login always consumes both
      scopes and every denial uses integer `Retry-After: 900` without revealing
      bucket identity or age.
- [ ] `X-Forwarded-For` does not influence limiting and Fastify proxy trust is unchanged.
- [ ] Plan 007’s `requireDesktopOperator` remains the contained-mutation boundary; register/login tokens remain claim-free.
- [ ] No HMAC key, bucket digest, email, password, or submitted body is
      persisted, logged, returned, or exposed; the limiter/auth code adds no IP
      diagnostics beyond the unchanged Fastify access logger.
- [ ] Focused tests and `pnpm verify` pass with `ALL GATES GREEN`.
- [ ] `git status --short` lists only in-scope files plus the reviewer-owned index update, if requested.
- [ ] Plan 018 is marked `DONE` in `advisor-plans/README.md` unless the reviewer owns the index.

## STOP conditions

Stop and report if:

- Plan 007 is not `DONE`, its literal `desktopOperator?: true` contract is absent, or its desktop-bootstrap/contained authorization tests are not green before throttling work.
- Authentication or Fastify proxy configuration differs materially from the excerpts.
- The deployed server is now multi-process or load-balanced such that a per-process limiter would create a false security claim.
- A supported deployment requires trusted proxy addresses; that needs a separate, explicit proxy-trust design.
- Public registration policy, password/JWT semantics, or error compatibility must change to implement the limiter.
- Throttling can only occur after bcrypt/store work, or requires logging/client disclosure of bucket identities.
- The hard capacity cannot fail closed without evicting live protection.
- A required change falls outside scope or a command fails twice after one reasonable correction.

## Maintenance notes

- Revisit fixed limits from measured legitimate traffic, but preserve both the gross-IP and email-identity layers; neither is sufficient alone.
- If Borealis later runs behind a proxy, specify an exact trusted-hop allowlist before changing `request.ip`. Never accept forwarded headers by default.
- The limiter and its random HMAC key intentionally reset together on restart and fit today’s single Fastify process. A distributed deployment requires a separately reviewed shared limiter and secret-management design.
- Plan 023 must document 429 and `Retry-After`; it must continue to state that registration is public.

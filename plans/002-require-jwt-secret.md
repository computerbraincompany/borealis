# Plan 002: Refuse known/default JWT secrets at server startup

> **Completed historical plan.** The [ledger](README.md) records this plan as
> DONE. The original instructions, code excerpts, paths, and checklists below
> describe its implementation-era tree; do not execute them against the current
> checkout. For supported behavior and commands, use the [project README](../README.md),
> [API reference](../docs/API.md), and [desktop guide](../desktop/README.md).

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 86400ce..HEAD -- server/src/config.ts server/src/index.ts server/.env.example`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `86400ce`, 2026-08-22

## Why this matters

The server signs JWTs with a secret that, in any default or template-based
deployment, is a value that is public in the repository. `server/src/config.ts`
falls back to a hardcoded `"dev-secret-change-me"` when `JWT_SECRET` is unset,
and `server/.env.example` instructs users to copy a second well-known value,
`please-change-me`. Anyone who knows these strings can mint a valid
`{ userId, email }` JWT for any user id — and since registration (`POST
/api/register`) is open and `/api/*` authorization trusts the token's `userId`
unconditionally, this silently defeats the entire per-account data isolation
the app claims ("per-account data isolation" in README). A startup guard turns
a silent misconfiguration into a loud one.

## Current state

`server/src/config.ts`, lines 9–11:

```ts
export const config = {
  port: Number(process.env.PORT || 3000),
  jwtSecret: process.env.JWT_SECRET || "dev-secret-change-me",
```

`server/.env.example`, line 3:

```
JWT_SECRET=please-change-me
```

`server/src/index.ts`, lines 9–18 (boot order):

```ts
async function main() {
  await initDb();          // connects to Postgres first
  await restoreDatasets().catch((e) => console.warn("dataset restore skipped", String(e)));
  const app = Fastify({ logger: true, bodyLimit: 20 * 1024 * 1024 });
  ...
  await app.listen({ port: config.port, host: "0.0.0.0" });
```

## Commands you will need

| Purpose   | Command                                       | Expected on success                         |
|-----------|-----------------------------------------------|---------------------------------------------|
| Typecheck | `cd server && npm run typecheck`              | exit 0, no errors                           |
| Guard check 1 | `cd server && env JWT_SECRET=please-change-me npx tsx -e "import('./src/config.js')"` | exits non-zero, prints "JWT_SECRET" message |
| Guard check 2 | `cd server && env JWT_SECRET=$(openssl rand -base64 32) npx tsx -e "import('./src/config.js').then(()=>process.exit(0))"` | exit 0, no output |

## Scope

**In scope** (the only files you should modify):
- `server/src/config.ts` — add the secret guard
- `server/src/index.ts` — no changes required, but add a boot-time log line
  confirming `JWT_SECRET` is set (optional; see Step 3)
- `server/.env.example` — update the comment to instruct generating a secret
- `server/.env` — regenerate the local dev secret to a random value
  (`.env` is gitignored; it holds the actual runtime value in this repo)

**Out of scope** (do NOT touch, even though they look related):
- `python/litellm.yaml` — the `master_key`/`api_key` values there are local
  LiteLLM proxy creds, not the JWT secret; leave them.
- `docker-compose.yml` — postgres password is a documented local dev value.
- Auth logic in `server/src/auth.ts` — no behavior change; the guard only
  prevents weak secrets at startup.
- Do NOT put any real secret value into committed files. `server/.env` is
  gitignored — only that file receives a generated value.

## Git workflow

- Branch: `advisor/002-require-jwt-secret`
- Commit message style (conventional): `fix(server): reject default JWT secrets at boot`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the guard in config.ts

At the top of `server/src/config.ts` (after the `config` object literal, or
before `fs.mkdirSync`), add a check. Keep the shape:

```ts
// Running with the default or a template secret makes every JWT forgeable.
// Refuse to boot rather than silently shipping broken auth.
const JWT_SECRET = process.env.JWT_SECRET ?? "";
const WEAK_JWT_SECRETS = new Set(["", "dev-secret-change-me", "please-change-me", "change-me"]);
if (WEAK_JWT_SECRETS.has(JWT_SECRET) || JWT_SECRET.length < 32) {
  throw new Error(
    "JWT_SECRET must be set to a random value of at least 32 chars (generate with: openssl rand -base64 32). Refusing to start with a weak/default secret."
  );
}
```

Then remove the fallback in the config object: `jwtSecret: JWT_SECRET`.

Keep the rest of `config.ts` unchanged.

**Verify**:

- `cd server && npm run typecheck` → exit 0
- Weak-secret path fails loudly:
  `cd server && env JWT_SECRET=please-change-me npx tsx -e "import('./src/config.js')"` →
  prints the error and exits non-zero (allowed to fail at the DB step after if
  dotenv injects `.env` — read Step 3/4 caveat; if `.env` sets a valid random
  secret it won't throw, so also run the `env JWT_SECRET=` empty case).
- `env JWT_SECRET="" npx tsx -e "import('./src/config.js')"` → note that
  `dotenv/config` loads `.env` which may set a long secret and mask the empty
  case; test with `JWT_SECRET=please-change-me` instead (see Step 3).

### Step 2: Update .env.example

Replace line 3 `JWT_SECRET=please-change-me` with:

```
# REQUIRED: a random secret of at least 32 chars, e.g. `openssl rand -base64 32`.
# Never run with a default/placeholder value.
JWT_SECRET=
```

**Verify**: `grep -n "JWT_SECRET" server/.env.example` shows the new comment
and an empty `JWT_SECRET=` line; no placeholder value remains.

### Step 3: Regenerate the local server/.env secret

The repo's `server/.env` (gitignored) currently contains the placeholder value
the example shipped with. Generate a fresh random value and replace the
`JWT_SECRET=...` line in `server/.env` only. Keep every other line in that file
unchanged. If the file does not exist, do not create it — note that in your
report instead (`cp .env.example .env` and set the value would be the normal
setup, but you should not create files that don't exist).

Command to generate: `openssl rand -base64 32`

Then verify the server boots far enough past the guard:
`cd server && npx tsx -e "import('./src/config.js').then(()=>{console.log('config OK, jwtSecret set:', Boolean(process.env.JWT_SECRET)); process.exit(0)})"`

Expected: prints `config OK` — the guard passed. (This will not connect to
Postgres; config import alone is the test.)

### Step 4: (Optional) Boot log line

If you want the reassurance, add one line inside `main()` in `index.ts` after
`restoreDatasets`:

```ts
console.log("JWT signing enabled (JWT_SECRET set)");
```

This is optional; only add it if Step 1's guard is in place.

## Test plan

No test framework exists in this repo (no vitest/jest/pytest). The guard is
verified by its observable boot behavior:

- `env JWT_SECRET=please-change-me npx tsx -e "import('./src/config.js')"` → non-zero exit, clear message
- `env JWT_SECRET=${random} npx tsx -e "import('./src/config.js')"` → exit 0

Future regression coverage (recommended, not in scope here): when a test
baseline is added, assert `config.ts` throws for each value in the weak set.

## Done criteria

ALL must hold:

- [ ] `cd server && npm run typecheck` exits 0
- [ ] `grep -n "jwtSecret: process.env.JWT_SECRET" server/src/config.ts` returns no
      matches (the fallback is gone — the placeholder strings may only appear
      inside the `WEAK_JWT_SECRETS` denylist, which is intentional)
- [ ] `grep -n "please-change-me" server/.env.example` returns no matches
- [ ] Weak-secret boot check (Step 1) exits non-zero with the guard message
- [ ] Random-secret boot check (Step 3) exits 0
- [ ] `git status --porcelain` shows only the committed files changed;
  `server/.env` is untracked and not in the diff
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the locations in "Current state" doesn't match the excerpts.
- You find a third hardcoded secret you weren't told about — note its
  location and type only (never the value), and report it.
- The dev environment depends on booting without a real `JWT_SECRET` in a way
  that these steps break (e.g. E2E scripts that launch with the default).
- The fix appears to require touching auth logic or moving the secret into a
  committed file.

## Maintenance notes

- Anyone adding a script/CI that boots the server must export `JWT_SECRET`
  from the environment or `.env`; this guard deliberately fails closed.
- If the project later adds a `.env.example` rotation or secrets manager,
  keep the min-length/denylist guard as the backstop.
- Deferred: no token revocation or expiry tuning — out of scope for this plan.

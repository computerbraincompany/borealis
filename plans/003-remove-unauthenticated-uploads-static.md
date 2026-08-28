# Plan 003: Remove the unauthenticated /uploads static route and the vulnerable dependency

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
> **Drift check (run first)**: `git diff --stat 86400ce..HEAD -- server/src/routes.ts server/package.json`
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

The Fastify server hands every uploaded file — personal-finance CSVs, PDFs,
DOCX, and URL-connector downloads — straight to anyone who can reach the
server, at `GET /uploads/<account-prefix>/<timestamp>_<filename>`, with **no
authentication whatsoever**. The route has zero consumers: nothing in `web/`
or elsewhere fetches `/uploads/...` (verified by grep across `web/src`,
`server/src`, `python/app`). The uploaded files are exactly the private data
the app is built around ("per-account data isolation" is a headline README
feature), and the account prefix in the URL is only 8 hex chars of a random
UUID — obscurity, not access control. On top of that, the installed
`@fastify/static` 8.x has four published HIGH-severity advisories (directory
listing / traversal / auth-bypass: GHSA-pr96-94w5-mx2h, GHSA-x428-ghpx-8j92,
GHSA-8pvw-jcv7-9cmj, GHSA-83w8-p2f5-377r). Removing the static registration
deletes both the leak and the vulnerable dependency.

## Current state

`server/src/routes.ts`, lines 14–19:

```ts
export async function routes(app: FastifyInstance) {
  await app.register(import("@fastify/multipart"), { limits: { fileSize: 150 * 1024 * 1024 } });
  await app.register(import("@fastify/static"), {
    root: config.uploadDir,
    prefix: "/uploads/",
  });
```

`server/package.json`, dependencies (excerpt, lines 13–14):

```json
  "dependencies": {
    "@fastify/cors": "^10.0.0",
    "@fastify/multipart": "^9.0.0",
    "@fastify/static": "^8.0.0",
    ...
```

No code reads the served URL. `server/src/ingest.ts` reads files via
`file_path` from the DB; `web/` fetches reports through `/api/reports/...`.
Uploaded files only need to exist on disk.

## Commands you will need

| Purpose   | Command                                    | Expected on success                    |
|-----------|--------------------------------------------|----------------------------------------|
| Typecheck | `cd server && npm run typecheck`           | exit 0                                 |
| Reinstall | `cd server && npm install`                 | exit 0; updates package-lock.json only |
| Grep 1    | `cd server && grep -rn "fastify/static\|/uploads/" src/` | no output (matches gone)       |
| Grep 2    | `cd web && grep -rn "/uploads/" src/`      | no output (was already empty)          |
| Dep check | `cd server && grep -n "@fastify/static" package.json package-lock.json` | no matches |

## Scope

**In scope** (the only files you should modify):
- `server/src/routes.ts` — remove the `@fastify/static` registration block
- `server/package.json` — remove `"@fastify/static": "^8.0.0",`
- `server/package-lock.json` — updated by `npm install`

**Out of scope** (do NOT touch, even though they look related):
- `server/src/ingest.ts` upload handling and `@fastify/multipart` — keep uploads.
- The files already sitting in `uploads/` on disk — do not delete user data;
  removing the route does not require touching them.
- Do not add a replacement download endpoint in this plan. No UI needs one
  today. If one is wanted later it should be an authenticated `GET
  /api/sources/:id/file` route — note it in your PR description as a follow-up.
- `@fastify/cors` / `@fastify/multipart` — unrelated to this finding.

## Git workflow

- Branch: `advisor/003-remove-uploads-static`
- Commit message style (conventional): `fix(server): stop serving uploads without auth`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Remove the static registration

In `server/src/routes.ts`, delete the two lines (and the blank line) that form
the `@fastify/static` registration, so the file starts:

```ts
export async function routes(app: FastifyInstance) {
  await app.register(import("@fastify/multipart"), { limits: { fileSize: 150 * 1024 * 1024 } });
```

**Verify**: `cd server && grep -rn "fastify/static\|/uploads/" src/` → no output.

### Step 2: Drop the dependency

Remove the `"@fastify/static": "^8.0.0",` entry from `server/package.json`
dependencies, then run `cd server && npm install` to update the lockfile.

**Verify**:

- `cd server && grep -n "@fastify/static" package.json package-lock.json` → no matches
- `cd server && npm run typecheck` → exit 0

### Step 3: Confirm no runtime reference remains

**Verify**:

- `cd web && grep -rn "/uploads/" src/` → no output (should be pre-existing empty)
- `cd server && docker compose exec -T postgres true 2>/dev/null; echo` — not
  required; instead just confirm `server/src/index.ts` and `server/src/config.ts`
  have no mention of `static`:
  `cd server && grep -rn "static" src/ | grep -v multipart || echo "clean"`

## Test plan

No test framework exists. The behavior to verify manually when services are
running (optional, only if you have Postgres/Python running):

1. Start the server per AGENTS.md.
2. `curl -i http://localhost:3000/uploads/ 2>&1 | head -5` → 404 (or 400), not a
   directory listing; the route is gone.
3. A previously guessable file, e.g. any file under `uploads/`, now returns 404:
   `curl -I http://localhost:3000/uploads/<any>/...` → 404, where before this
   plan it returned 200 with file contents.

If services are not available, the grep checks above are the machine-checkable
gate.

## Done criteria

ALL must hold:

- [ ] `cd server && npm run typecheck` exits 0
- [ ] `grep -rn "fastify/static\|/uploads/" server/src/` returns no matches
- [ ] `grep -n "@fastify/static" server/package.json server/package-lock.json` returns no matches
- [ ] `cd web && grep -rn "/uploads/" src/` returns no matches
- [ ] `git status --porcelain` (repo root) lists only `server/src/routes.ts`,
      `server/package.json`, `server/package-lock.json`, and `plans/`
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the locations in "Current state" doesn't match the excerpts.
- You find any consumer of `/uploads/...` the grep didn't catch (e.g. in
  `docs/`, deployment configs, or a Vite public dir) — check `web/public/`
  and any nginx/caddy configs in the repo before concluding.
- `server` fails to boot or typecheck after removing the registration.
- You discover a planned feature that depends on unauthenticated static
  serving (e.g. pasted chat image links).

## Maintenance notes

- When someone later adds file download to the UI, build it as an
  authenticated route under `/api/` (like `/api/reports/:id/pdf`) and grant
  access by `account_id`. Do not resurrect a public static mount.
- The `uploads/` dir continues to be the ingest working directory; keep it
  off the web root. If nginx is ever put in front, ensure no `location
  /uploads` alias is added.
- Deferred: no migration of the 4 high-CVE `@fastify/static` advisories is
  needed once the dep is gone; if it is ever reintroduced, require `^10.1.3`.

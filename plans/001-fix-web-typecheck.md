# Plan 001: Fix the broken `npm run typecheck` in web/

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
> **Drift check (run first)**: `git diff --stat 86400ce..HEAD -- web/package.json web/tsconfig.json web/tsconfig.node.json`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `86400ce`, 2026-08-22

## Why this matters

The repo's documented verification gate for the frontend is broken:
`cd web && npm run typecheck` exits non-zero with a TypeScript project-reference
error, so nobody (human or agent) can use it to confirm the frontend is sound.
The `web` production build (`tsc -b && vite build`) still works, which hides the
problem: the two commands have drifted apart, and typecheck no longer guards
the UI code. This is finding #1 because every other plan that touches `web/src`
needs a working typecheck command as its verification gate.

## Current state

`web/package.json`, lines 6–11:

```json
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "typecheck": "tsc -b --noEmit"
  },
```

Running `cd web && npm run typecheck` fails with:

```
tsconfig.json(25,18): error TS6310: Referenced project '.../web/tsconfig.node.json' may not disable emit.
```

Root cause: `web/tsconfig.json` sets `"noEmit": true` and declares
`"references": [{ "path": "./tsconfig.node.json" }]`. `tsc -b` (build mode)
honors project references and refuses `--noEmit` on a referenced composite
project, so `tsc -b --noEmit` is an invalid combination in TypeScript 5.9.

Verified working alternatives (tested on this repo, TypeScript 5.9.3):

- `cd web && npx tsc -b` → exit 0 (this is what `npm run build` already uses)
- `cd web && npx tsc --noEmit` → exit 0 (checks `src/` via tsconfig.json, no references involved)

## Commands you will need

| Purpose   | Command                                       | Expected on success            |
|-----------|-----------------------------------------------|--------------------------------|
| Typecheck | `cd web && npm run typecheck`                 | exit 0, no output              |
| Build     | `cd web && npm run build`                     | exit 0 (writes `dist/`, gitignored) |
| Lint-free | `cd web && git status --porcelain`            | no new files tracked by git    |

## Scope

**In scope** (the only files you should modify):
- `web/package.json` — the `typecheck` script only

**Out of scope** (do NOT touch, even though they look related):
- `web/tsconfig.json` / `web/tsconfig.node.json` — the reference setup is fine;
  `tsc -b` works and `npm run build` depends on it. Do not restructure it.
- `web/package-lock.json` — do not run `npm install`; a script-string change
  does not alter dependencies.
- `server/`, `python/` — unrelated.

## Git workflow

- Branch: `advisor/001-fix-web-typecheck`
- Commit message style (conventional, matching repo history):
  `fix(web): repair broken typecheck script` — single commit.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Change the typecheck script

In `web/package.json`, replace:

```json
    "typecheck": "tsc -b --noEmit"
```

with:

```json
    "typecheck": "tsc --noEmit"
```

Leave `build` exactly as `"tsc -b && vite build"`.

**Verify**:

- `cd web && npm run typecheck` → exit 0, no output (run it twice if needed
  to be sure it isn't a stale `.tsbuildinfo`).

### Step 2: Confirm the production build still works

**Verify**: `cd web && npm run build` → exit 0. This also re-confirms the
reference project still checks `vite.config.ts`.

### Step 3: Confirm only the intended file changed

**Verify**: `cd web && git status --porcelain` → output lists only
`package.json` (and nothing else; `dist/`, `*.tsbuildinfo`, and generated
`vite.config.js/.d.ts` are gitignored).

## Test plan

No new tests — this is a tooling fix. Regression check: re-run
`cd web && npm run typecheck` and `cd web && npm run build`; both exit 0.
Also run the other documented gate to make sure nothing else regressed:
`cd server && npm run typecheck` → exit 0.

## Done criteria

ALL must hold:

- [ ] `cd web && npm run typecheck` exits 0
- [ ] `cd web && npm run build` exits 0
- [ ] `grep -n '"typecheck"' web/package.json` shows `tsc --noEmit` (not `-b --noEmit`)
- [ ] `git status --porcelain` in `web/` shows only `package.json` modified
- [ ] No files outside `web/package.json` are modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the locations in "Current state" doesn't match the excerpts
  (the codebase has drifted since this plan was written).
- `cd web && npm run build` fails after your change — the build is the load-
  bearing command and must not break.
- The fix appears to require touching `tsconfig.json` files or restructuring
  the TS project references.

## Maintenance notes

- Keep `typecheck` and `build` in sync: `typecheck` checks `src/` only,
  `build` additionally type-checks `vite.config.ts` through the node project.
  If someone later makes `vite.config.ts` typecheckable in plain `tsc --noEmit`
  (e.g. by merging tsconfigs), revisit.
- A reviewer should confirm the change is only the script string and that no
  `.tsbuildinfo` files re-entered git (they are in `.gitignore`).
- Deferred out of scope: the same `-b --noEmit` problem may exist in future
  tooling; prefer `tsc --noEmit` for check-only scripts.

# Plan 002: Make every desktop verification command source-current

> **Executor instructions**: Execute this plan in order and run every stated
> check. Stop on any listed STOP condition rather than inventing a new test
> architecture. A reviewer maintains `advisor-plans/README.md`; do not edit it.
>
> **Drift check (run first)**:
> `git diff --stat f1b9293..HEAD -- desktop/package.json desktop/README.md turbo.json`
> Compare changed files with the excerpts below. A material mismatch is a STOP
> condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `f1b9293`, 2026-08-30

## Why this matters

The focused desktop `test` and `render:smoke` scripts execute compiled files in
`desktop/dist`, but only Turborepo and the aggregate `verify` script arrange a
fresh build first. Running either advertised focused command directly can test
stale output or fail on a clean checkout. Make `test` execute TypeScript source
directly, make the public renderer smoke self-building, and retain one internal
compiled smoke entry so aggregate verification does not rebuild twice.

## Current state

- `desktop/package.json:12-27` currently contains:

  ```json
  "build": "node scripts/clean.mjs && tsc -p tsconfig.json",
  "typecheck": "tsc -p tsconfig.json --noEmit",
  "test": "node --test dist/*.test.js",
  "render:smoke": "electron scripts/render-smoke-app",
  "verify": "pnpm run typecheck && pnpm run build && pnpm test && pnpm run format:check && pnpm run native:smoke && pnpm run render:smoke"
  ```

- `desktop/scripts/render-smoke-app/package.json:3` points Electron at
  `../../dist/renderSmoke.js`, so the renderer smoke truly requires compiled
  output.
- `desktop/.gitignore:2` ignores `dist/`; a fresh checkout has no compiled test
  files.
- `turbo.json:46-58` currently supplies build ordering externally:

  ```json
  "borealis-desktop#test": {
    "dependsOn": ["build"],
    "outputs": []
  },
  "render:smoke": {
    "dependsOn": ["build"],
    "cache": false
  }
  ```

- `desktop/README.md:59-63` advertises the focused commands but says Turborepo
  builds before them. That is not true for direct `pnpm --filter ...` calls.
- `desktop/src/contracts.test.ts:1-9` is a Node test importing local ESM with a
  `.js` suffix. `tsx` is already a desktop dependency (`desktop/package.json:49`)
  and must preserve this convention.
- `desktop/src/renderSmoke.ts:53-70` validates PNG/PDF signatures and rejects
  network/file resource requests; this plan changes only how that existing
  smoke is prepared and invoked.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Clean focused tests | `pnpm --filter borealis-desktop clean && pnpm --filter borealis-desktop test` | exit 0; source tests run with no pre-existing `dist/` |
| Typecheck | `pnpm --filter borealis-desktop typecheck` | exit 0 |
| Renderer smoke | `pnpm --filter borealis-desktop render:smoke` | exit 0 in a graphical macOS session after building current source |
| Aggregate desktop gate | `pnpm --filter borealis-desktop verify` | exit 0; exactly one shell build in script output |
| Format check | `pnpm --filter borealis-desktop format:check` | exit 0 |

Do not install dependencies, package the app, or run a formatter.

## Scope

**In scope**:

- `desktop/package.json`
- `desktop/README.md`
- `turbo.json`

**Out of scope**:

- Desktop source and test behavior.
- `desktop/scripts/render-smoke-app/package.json` and
  `desktop/src/renderSmoke.ts`; their compiled-entry contract remains intact.
- Native-addon isolation, packaging, signing, runtime copying, and Electron
  security policy.
- Root package scripts.

## Git workflow

- Branch: `codex/002-make-desktop-verification-source-current`
- Commit: `chore(desktop): make verification commands source-current`
- Do not push, open a PR, edit the plan index, or commit generated `dist/` output.

## Steps

### Step 1: Run Node tests from source

Change the desktop `test` script to run `src/*.test.ts` through the already
installed `tsx` executable and Node's test mode (for example,
`tsx --test src/*.test.ts`). Do not add a dependency. Keep the existing tests'
`.js` imports; `tsx` must resolve them to the TypeScript sources.

**Verify**:
`pnpm --filter borealis-desktop clean && pnpm --filter borealis-desktop test`
→ exit 0, the three current source test files execute, and the command does not
create `desktop/dist`.

### Step 2: Split public and compiled renderer-smoke scripts

In `desktop/package.json`:

1. add an internal `render:smoke:compiled` script whose command is the current
   `electron scripts/render-smoke-app` command;
2. make public `render:smoke` run `build` and then `render:smoke:compiled`; and
3. update `verify` so its existing build is followed later by
   `render:smoke:compiled`, avoiding a second clean build.

Do not reorder the semantic checks in `verify` except for replacing the final
public smoke call with its compiled counterpart.

**Verify**:
`pnpm --filter borealis-desktop render:smoke` → exit 0 in a graphical macOS
session, with build output before the renderer starts.

Then run `pnpm --filter borealis-desktop verify` → exit 0 and only one invocation
of `node scripts/clean.mjs && tsc -p tsconfig.json` appears.

### Step 3: Remove stale Turborepo-only assumptions

In `turbo.json`, remove the desktop-specific `test` build dependency because
source tests no longer need compiled output. Remove `dependsOn: ["build"]` from
the `render:smoke` task because the public package script now owns that
precondition; retain `cache: false`.

Do not alter the generic `test`, `build`, `native:smoke`, or other task shapes.

**Verify**:
`pnpm test --filter borealis-desktop` → exit 0 and does not run the desktop
`build` task as a prerequisite.

### Step 4: Correct the operator documentation

Update `desktop/README.md`'s Verify section to say:

- focused `test` runs directly from current source and needs no build;
- public `render:smoke` performs its own clean build;
- aggregate `verify` builds once and calls the internal compiled renderer smoke;
- the renderer smoke still requires a graphical macOS session.

Do not expand this into packaging or first-launch documentation work.

**Verify**:
`pnpm --filter borealis-desktop format:check` → exit 0.

## Test plan

- The regression test is command-level because the defect is script ordering:
  run `clean && test` and require success without a `dist/` directory.
- Run public `render:smoke` from a clean tree and require it to build before
  Electron starts.
- Run `verify` and confirm it does not rebuild for the final smoke.
- Run root/Turbo's desktop-only test target to confirm removing the task edge
  does not make it stale.

## Done criteria

- [ ] Focused desktop tests pass immediately after `clean` and do not create `dist/`.
- [ ] Public `render:smoke` succeeds from a clean tree in a graphical macOS session.
- [ ] `verify` succeeds and performs one shell build.
- [ ] Turbo no longer builds desktop solely to run source tests.
- [ ] Desktop typecheck and format checks pass.
- [ ] `git status --short` lists only the three in-scope files; generated output is absent.

## STOP conditions

Stop and report if:

- `tsx --test` cannot resolve the current `.js` specifiers to source `.ts`
  modules; do not rewrite all imports or introduce a loader workaround without
  review;
- the renderer smoke's app entry no longer points into `desktop/dist`;
- a public script cannot be made source-current without changing renderer or
  native-addon behavior;
- the graphical Electron smoke is unavailable on the execution host; report the
  unrun gate explicitly rather than treating it as passed; or
- any verification fails twice after one reasonable correction.

## Maintenance notes

- Public focused commands must own their prerequisites; Turbo task edges are an
  optimization, not their correctness boundary.
- Keep `render:smoke:compiled` internal. Human-facing docs should direct users to
  `render:smoke` or `verify`.
- If desktop tests later require Electron globals, add a separate named suite;
  do not make the current Node policy/contract tests depend on compiled output.

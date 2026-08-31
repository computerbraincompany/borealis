# Plan 001: Partition the server unit and integration test suites

> **Executor instructions**: Follow this plan step by step. Run every verification
> command and confirm the expected result before moving on. If a STOP condition
> occurs, stop and report; do not improvise. A reviewer maintains
> `advisor-plans/README.md`, so do not create or edit any plan index.
>
> **Drift check (run first)**:
> `git diff --stat f1b9293..HEAD -- server/vitest.config.ts server/vitest.integration.config.ts server/src/tests/vitestTestPartitions.ts server/src/tests/vitestPartitions.test.ts`
> If an in-scope file changed since this plan was written, compare the excerpts
> below with the live code. A material mismatch is a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `f1b9293`, 2026-08-30

## Why this matters

The default server Vitest config includes every `src/tests/**/*.test.ts` file,
while the integration config names seven of those same files. The repository
gate runs both scripts, so expensive SQLite/LanceDB integration files execute
twice, and their first execution is not protected by the integration config's
single-worker serialization. A shared, executable partition removes duplicate
work without allowing a test to disappear silently.

## Current state

- `server/vitest.config.ts:3-6` currently selects the complete test tree:

  ```ts
  export default defineConfig({
    test: {
      environment: "node",
      include: ["src/tests/**/*.test.ts"],
  ```

  The following `env` block contains test-only credential fixtures. Preserve
  the block, but do not copy its values into logs, plans, or documentation.

- `server/vitest.integration.config.ts:3-16` repeats seven paths and serializes
  only that invocation:

  ```ts
  test: {
    environment: "node",
    include: [
      "src/tests/chatStore.test.ts",
      "src/tests/runStore.test.ts",
      "src/tests/sqliteFoundation.test.ts",
      "src/tests/sqliteSourceStore.test.ts",
      "src/tests/sourceIngestionTransitions.test.ts",
      "src/tests/ingestionVectorLifecycle.test.ts",
      "src/tests/lanceVectorIndex.test.ts",
    ],
    fileParallelism: false,
    maxWorkers: 1,
  ```

- `server/package.json:14-15` exposes both commands unchanged:

  ```json
  "test": "vitest run",
  "test:integration": "vitest run --config vitest.integration.config.ts"
  ```

- `package.json:19` runs both tasks in the complete gate. Keep that behavior;
  this plan changes membership, not the public command contract.
- Server code is TypeScript ESM. Local imports include `.js`. Match the small,
  direct Vitest style in `server/src/tests/sqliteFoundation.test.ts:1-38`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Partition test | `pnpm --filter borealis-server exec vitest run src/tests/vitestPartitions.test.ts` | exit 0; partition assertions pass |
| Unit suite | `pnpm --filter borealis-server test` | exit 0; none of the seven serialized files runs |
| Integration suite | `pnpm --filter borealis-server test:integration` | exit 0; all seven serialized files run once |
| Typecheck | `pnpm --filter borealis-server typecheck` | exit 0, no errors |
| Lint | `pnpm --filter borealis-server lint` | exit 0, no warnings |
| Format check | `pnpm --filter borealis-server format:check` | exit 0 |

Do not install dependencies or run a formatter. The workspace is already
installed; format any edits manually.

## Scope

**In scope** (the only files to modify):

- `server/vitest.config.ts`
- `server/vitest.integration.config.ts`
- `server/src/tests/vitestTestPartitions.ts` (create)
- `server/src/tests/vitestPartitions.test.ts` (create)

**Out of scope**:

- `server/package.json`, root `package.json`, and `turbo.json`; public commands
  and the two-task repository gate remain unchanged.
- Moving or renaming existing tests.
- Reclassifying any file beyond the seven already selected by the integration
  config.
- Test implementation or production-code changes.

## Git workflow

- Branch: `codex/001-partition-server-test-suites`
- Commit: `test(server): partition unit and integration suites`
- Do not push, open a PR, edit `advisor-plans/README.md`, or commit unrelated files.

## Steps

### Step 1: Create one shared partition manifest

Create `server/src/tests/vitestTestPartitions.ts`. Keeping the manifest below
`src/` is load-bearing: `server/tsconfig.json` sets `rootDir: "src"` and the
server lint/format commands cover `src/**/*.ts`, so a root-level helper would
escape the static gates. Export:

- one constant for the broad server test glob, and
- one frozen/`as const` array containing the seven integration paths exactly as
  listed in the current integration config.

Use forward-slash paths relative to `server/`. Do not place environment values
or Vitest runtime configuration in this file.

**Verify**:
`pnpm --filter borealis-server exec tsc --noEmit --pretty false` → exit 0 and no
module-resolution error for the new ESM module.

### Step 2: Make the two configs disjoint

In both configs, import the shared module as
`./src/tests/vitestTestPartitions.js`. In `server/vitest.config.ts`, import the
shared glob and integration list. Keep
the current `include`. Add an `exclude` that contains Vitest's normal default
exclusions plus the shared integration paths; import `configDefaults` from
`vitest/config` rather than replacing default exclusions accidentally.

In `server/vitest.integration.config.ts`, replace the inline list with the
shared integration constant. Preserve `fileParallelism: false`, `maxWorkers: 1`,
and both existing credential-fixture `env` blocks byte-for-byte.

**Verify**:
`pnpm --filter borealis-server exec vitest list` → exit 0; output does not list
`chatStore.test.ts`, `runStore.test.ts`, `sqliteFoundation.test.ts`,
`sqliteSourceStore.test.ts`, `sourceIngestionTransitions.test.ts`,
`ingestionVectorLifecycle.test.ts`, or `lanceVectorIndex.test.ts`.

Then run:
`pnpm --filter borealis-server exec vitest list --config vitest.integration.config.ts`
→ exit 0; output lists exactly those seven test files and no other test file.

### Step 3: Add an executable partition invariant

Create `server/src/tests/vitestPartitions.test.ts`. Import the manifest through
the local ESM path `./vitestTestPartitions.js`, then recursively enumerate
`server/src/tests` with `node:fs/promises` (do not add a glob dependency),
normalize paths to `/`, and assert:

1. the integration manifest has no duplicates;
2. every manifest entry exists and ends in `.test.ts`;
3. every discovered `.test.ts` file belongs to exactly one calculated set:
   integration when explicitly listed, otherwise unit;
4. the two sets have an empty intersection and their union equals all
   discovered tests; and
5. the invariant test itself is in the unit set.

This is a metadata test; do not import either Vitest config because doing so can
couple the test process to config loading.

**Verify**:
`pnpm --filter borealis-server exec vitest run src/tests/vitestPartitions.test.ts`
→ exit 0 with the new invariant passing.

### Step 4: Run both public suites and static gates

Run the unit and integration commands separately so the console output makes
suite membership reviewable, then run static checks.

**Verify**:

- `pnpm --filter borealis-server test` → exit 0; the seven integration files are
  absent from the file list.
- `pnpm --filter borealis-server test:integration` → exit 0; exactly the seven
  integration files execute.
- `pnpm --filter borealis-server typecheck && pnpm --filter borealis-server lint && pnpm --filter borealis-server format:check`
  → exit 0.

## Test plan

- New test: `server/src/tests/vitestPartitions.test.ts`.
- Cover duplicate entries, missing manifest files, overlap, complete union, and
  the test's own classification.
- The public unit and integration commands are acceptance tests for the actual
  configs; the metadata test prevents future additions from falling through a
  hand-maintained include/exclude mismatch.

## Done criteria

- [ ] The seven serialized integration files appear in only the integration run.
- [ ] Every other `server/src/tests/**/*.test.ts` file appears in only the unit run.
- [ ] Both public suite commands exit 0.
- [ ] The new partition invariant exits 0.
- [ ] Server typecheck, lint, and format checks exit 0.
- [ ] `git status --short` shows changes only to the four in-scope paths.
- [ ] No credential fixture value was copied into a new file, commit message, or report.

## STOP conditions

Stop and report if:

- any of the seven existing integration paths has been renamed, removed, or
  reclassified since `f1b9293`;
- Vitest does not merge `configDefaults.exclude` as documented or `vitest list`
  cannot prove the two real configs are disjoint;
- making the suites disjoint reveals order dependence or parallel-safety
  failures in an existing unit test; do not hide such a failure by adding it to
  the serialized list;
- the work requires changing package scripts or production code; or
- a verification command fails twice after one reasonable correction.

## Maintenance notes

- Add a test to the integration manifest only when it genuinely requires the
  serialized native-store environment. Everything else belongs to unit by
  default.
- Review future Vitest upgrades for changes to `configDefaults.exclude` and
  `vitest list` behavior.
- The shared list is intentionally the only membership authority; do not
  reintroduce a second inline copy.

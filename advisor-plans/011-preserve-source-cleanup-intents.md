# Plan 011: Preserve source cleanup intents until artifact removal is proven

> **Executor instructions**: Execute the steps in order and run every verification command. If a STOP condition occurs, stop and report; do not improvise. When complete, update this plan's row in `advisor-plans/README.md` unless a reviewer owns index maintenance.
>
> **Drift check (run first)**: `git diff --stat f1b9293..HEAD -- server/src/sourceCleanup.ts server/src/tests/sourceCleanup.test.ts server/src/tests/sourceManagementRoutes.test.ts server/src/tests/ingestionWorker.test.ts server/src/tests/ingestRestore.test.ts`
> Plans 024, 035, and 037 intentionally added exact-location connector cleanup
> tombstones, embedding-index identity/migration phases, and an exact workspace
> lock/archive boundary around the same durable tree. Preserve those authorities:
> source cleanup must not clear connector tombstones, delete staged/live/backup
> indexes by inference, or run outside the owned workspace lifecycle. Reconcile
> expected live changes first; STOP only for another cleanup-result mismatch.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Preserve completed baseline**: Plans 024, 035, and 037
- **Category**: bug
- **Planned at**: commit `f1b9293`, 2026-08-30

## Why this matters

Source deletion is deliberately two-phase: SQLite records a durable intent before vector, DuckDB, and filesystem cleanup. The coordinator currently ignores a `false` return from exact upload deletion and then clears the durable marker, permanently losing the only retry signal while an artifact may remain. Treating only a proven removal or a proven already-missing exact path as success restores the crash/retry contract without weakening fail-closed path ownership checks.

## Current state

- `server/src/sourceCleanup.ts:37-45` clears every marker when no dependency throws:

  ```ts
  try {
    for (const intent of intents)
      await dependencies.deleteVectors(intent.sourceId);
    for (const intent of intents)
      await cleanupExternalArtifacts(intent, dependencies);
    for (const intent of intents) await dependencies.clearIntent(intent);
    return Object.freeze({ completed: true, intents: intents.length });
  } catch {
    await Promise.allSettled(
      intents.map((intent) => dependencies.markFailure(intent)),
    );
    return Object.freeze({ completed: false, intents: intents.length });
  }
  ```

- Upload cleanup discards the removal result (`server/src/sourceCleanup.ts:70-73`):

  ```ts
  if (!intent.filePath) return;
  await dependencies.deactivateDatasetLocation(
    intent.accountId,
    intent.name,
    intent.filePath,
  );
  await dependencies.removeUploadArtifact(intent);
  ```

  The dependency is typed `Promise<unknown>` at `server/src/sourceCleanup.ts:9-16`, so TypeScript cannot require the coordinator to interpret success/failure.

- `server/src/storageArtifacts.ts:189-244` implements `removeSourceArtifact(...): Promise<boolean>`. It returns `false` for invalid identities, a path outside the exact UUID-scoped directory, symlink/non-file ownership failures, and a failed exact unlink. Those cases must not clear a durable intent.

- `server/src/storageArtifacts.ts:150-187` already provides the necessary distinction:

  ```ts
  /** Distinguish a missing exact upload location from an unsafe location. */
  export async function isMissingOwnedSourceArtifact(input: {
    accountId: string;
    sourceId: string;
    filePath: string;
  }): Promise<boolean> {
  ```

  It returns true only when the lexical path is the exact account/source location and the owned directory or file is genuinely absent; unsafe ownership proof returns false.

- `server/src/reportCleanup.ts:25-40` is the repository exemplar. It checks `removeReportArtifacts`, throws when ownership/removal is unproven, clears the intent only on success, and otherwise records a stable failure code.

- `server/src/tests/sourceCleanup.test.ts:30-40` covers the successful upload order, and `server/src/tests/sourceManagementRoutes.test.ts:289-314` covers a thrown filesystem failure. Neither covers a resolved `false`, which is the regression.

- `server/src/tests/sourceManagementRoutes.test.ts:49-53`, `server/src/tests/ingestionWorker.test.ts:9-12`, and `server/src/tests/ingestRestore.test.ts:24-27` mock `storageArtifacts.js`. If `sourceCleanup.ts` imports the existing missing-path classifier, those explicit module mocks must expose it.

- The invariant at `AGENTS.md:158-165` requires source deletion to keep durable pending cleanup until filesystem artifacts are removed and startup repair to finish outstanding intents.

## Commands you will need

| Purpose                  | Command                                                                                                                                                                                    | Expected on success                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| Focused tests            | `pnpm --filter borealis-server exec vitest run src/tests/sourceCleanup.test.ts src/tests/sourceManagementRoutes.test.ts src/tests/ingestionWorker.test.ts src/tests/ingestRestore.test.ts` | all four files pass                                                 |
| Artifact ownership tests | `pnpm --filter borealis-server exec vitest run src/tests/storageArtifacts.test.ts src/tests/reportCleanup.test.ts`                                                                         | existing exact-path and cleanup tests pass                          |
| Server typecheck         | `pnpm --filter borealis-server typecheck`                                                                                                                                                  | exit 0, no errors                                                   |
| Server lint/format       | `pnpm --filter borealis-server lint && pnpm --filter borealis-server format:check`                                                                                                         | exit 0, no warnings                                                 |
| Full server tests        | `pnpm --filter borealis-server test`                                                                                                                                                       | all tests pass                                                      |
| Final repository gate    | `pnpm verify`                                                                                                                                                                              | exit 0 and prints `ALL GATES GREEN` on a provisioned supported host |

## Scope

**In scope** (the only source/test files to modify):

- `server/src/sourceCleanup.ts`
- `server/src/tests/sourceCleanup.test.ts`
- `server/src/tests/sourceManagementRoutes.test.ts`
- `server/src/tests/ingestionWorker.test.ts`
- `server/src/tests/ingestRestore.test.ts`

**Out of scope** (do not touch):

- `server/src/storageArtifacts.ts`; its exact removal and missing-owned-path classifiers are already the canonical security boundary.
- `server/src/reportCleanup.ts`; it is an exemplar, not a second implementation target.
- Connector cache cleanup semantics. Connector intents use `deactivateDatasetLocation` plus `cleanupDatasetCache` and return early; do not apply upload-file rules to them.
- Source deletion API response codes or the order in which SQLite identity, vectors, DuckDB locations, and files are handled.
- Broad recursive deletion, inferred parent removal, symlink relaxation, or logging any stored path/ID.

## Git workflow

- Branch: `codex/011-preserve-source-cleanup-intents`
- Commit after verification with: `fix(server): preserve failed source cleanup intents`
- Follow conventional commit style and do not push/open a PR without operator instruction.

## Steps

### Step 1: Make upload cleanup outcomes explicit

In `server/src/sourceCleanup.ts`, change `SourceCleanupDependencies.removeUploadArtifact` to return `Promise<boolean>`. Add a dependency that classifies whether the intent's exact upload path is already missing; wire the runtime implementation to `isMissingOwnedSourceArtifact` using only `accountId`, `sourceId`, and the non-null `filePath`.

Keep this classifier injectable so `sourceCleanup.test.ts` can cover the state machine without a real filesystem. Do not duplicate or simplify the canonical ownership logic in `sourceCleanup.ts`.

**Verify**: `pnpm --filter borealis-server typecheck` → it should initially identify every mock that must adopt the explicit boolean/classifier contract; after those mocks are updated, exit 0.

### Step 2: Clear the intent only after removal or proven absence

For an upload intent with a path, preserve the existing order: deactivate the DuckDB location, then call `removeUploadArtifact`. If it returns true, continue. If it returns false, call the exact missing-owned-path dependency:

- true means the artifact was already absent at its exact owned location, so cleanup is idempotently complete;
- false means ownership/removal is not proven, so throw a private generic error and let the existing catch path mark every batch intent with `SOURCE_CLEANUP_RETRY`.

The private error text must never include the account ID, source ID, file path, or original filesystem error. An intent with `filePath === null` remains already satisfied. Do not clear any marker in a failed batch.

**Verify**: `pnpm --filter borealis-server exec vitest run src/tests/sourceCleanup.test.ts` → all coordinator tests pass.

### Step 3: Add unit regressions for both resolved-false branches

Extend `server/src/tests/sourceCleanup.test.ts` and its `deps` factory so successful removal returns true by default. Add two focused cases:

1. `removeUploadArtifact` resolves false and the missing-owned classifier resolves false: result is `{ completed: false, intents: 1 }`, `markFailure` is called, and `clearIntent` is not called.
2. `removeUploadArtifact` resolves false and the missing-owned classifier resolves true: result is completed, the marker is cleared, and failure is not recorded.

Assert call order so classification occurs only after a false removal. Retain vector-first and deactivation-before-file behavior.

**Verify**: `pnpm --filter borealis-server exec vitest run src/tests/sourceCleanup.test.ts` → the two new regressions and all existing cases pass.

### Step 4: Cover the real route's resolved-false failure

Update the explicit `storageArtifacts.js` mocks in `sourceManagementRoutes.test.ts`, `ingestionWorker.test.ts`, and `ingestRestore.test.ts` to export `isMissingOwnedSourceArtifact`. In the source-management route setup, make removal resolve true by default and missing classification resolve false by default.

Add a route regression next to `leaves a durable retry marker when cleanup fails after vector purge`: make `removeSourceArtifact` resolve false (not reject), make the missing classifier resolve false, delete the source, and assert the pending intent remains with attempts incremented and `lastError: "SOURCE_CLEANUP_RETRY"`. Assert the response does not expose a path or internal error. If useful, add the already-missing success at the unit layer only; do not duplicate all filesystem classifier tests here.

**Verify**: `pnpm --filter borealis-server exec vitest run src/tests/sourceManagementRoutes.test.ts src/tests/ingestionWorker.test.ts src/tests/ingestRestore.test.ts` → all tests pass with no missing mocked export.

### Step 5: Run ownership and repository gates

Run the artifact ownership tests, all server checks, and the final repository gate from the table. Review the diff for any weakening of `removeSourceArtifact` or `isMissingOwnedSourceArtifact`.

**Verify**: `git diff --check && git status --short` → no whitespace errors; only the five in-scope files and the permitted `advisor-plans/README.md` status update are modified.

## Test plan

- Unit-test true removal, false+exact-missing, false+unsafe/not-missing, thrown removal, and vector failure.
- Assert marker clearing and failure recording, not only the summary object.
- Keep order assertions: all vector purges precede external cleanup; upload deactivation precedes exact file removal.
- Add one real route/store regression proving a resolved false leaves the durable SQLite marker retryable.
- Run existing `storageArtifacts.test.ts` to retain missing-versus-unsafe path distinctions and `reportCleanup.test.ts` to retain the analogous durable intent pattern.

## Done criteria

- [ ] `SourceCleanupDependencies` represents upload removal as a boolean outcome.
- [ ] A true removal clears the durable intent.
- [ ] A false removal clears the intent only when `isMissingOwnedSourceArtifact` proves the exact owned path is already absent.
- [ ] A false unsafe/unremoved result records `SOURCE_CLEANUP_RETRY` and leaves the intent present.
- [ ] No cleanup error, ID, or path is added to logs or public responses.
- [ ] Focused, ownership, full server, and repository gates pass.
- [ ] No file outside Scope is modified, except the permitted plan-index update.

## STOP conditions

Stop and report back instead of improvising if:

- `removeSourceArtifact` or `isMissingOwnedSourceArtifact` no longer has the behavior described in Current state.
- The fix appears to require treating an unsafe, symlinked, outside-root, or unprovable path as already missing.
- A connector cleanup path reaches `removeUploadArtifact`; the intent classification has drifted and must be investigated separately.
- The only way to make a test pass is to clear an intent after a false/unproven removal.
- A required change falls outside Scope, or a verification fails twice after one reasonable correction.

## Maintenance notes

- Any future destructive helper returning boolean must have its result consumed; `await` alone proves only that the call did not throw.
- Keep the already-missing exception tied to the canonical exact ownership classifier, not `ENOENT` caught at an arbitrary parent path.
- Batch failure deliberately retains all remaining markers for idempotent repair. Changing to per-intent clearing would be a separate transaction/protocol design.
- Review explicit Vitest module mocks when adding a named export to `storageArtifacts.js`; partial mocks do not automatically pass through new exports.

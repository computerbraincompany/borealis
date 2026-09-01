# Plan 021: Stabilize the ExcelJS parser boundary

> **Executor instructions**: Follow this plan step by step. Run each verification command and confirm the expected result before continuing. If a “STOP condition” occurs, stop and report — do not improvise. When done, update this plan’s row in `advisor-plans/README.md` unless a reviewer told you they own the index.
>
> **Drift check (run first)**: `git diff --stat f1b9293..HEAD -- package.json pnpm-lock.yaml server/package.json desktop/package.json server/src/data/xlsx.ts server/src/data/exceljsBoundary.ts server/src/tests/xlsx.test.ts server/src/tests/exceljsBoundary.test.ts server/src/tests/xlsxSpillProbe.ts scripts/policy-check.mjs`
> Plans 032, 033, 036, and 037 intentionally changed package scripts,
> dependencies, runtime assets, policy checks, and the lockfile. Preserve the
> fuse/entitlement/package smokes, lazy bundle budget/manifest, unpacked local
> OCR helper, and workspace-archive commands while pinning only ExcelJS. These
> changes are expected baseline, not drift; STOP only on an unrelated parser or
> exact-version mismatch.
> **Read-only dependency check**: inspect `desktop/scripts/copy-runtime.mjs` and
> its lazy-entry, OCR-asset, and exact installed-version checks. It is not
> editable in this plan.

## Status

- **Priority**: P3
- **Effort**: L
- **Risk**: MED
- **Depends on**: none
- **Preserve completed baseline**: Plans 032, 033, 036, and 037
- **Category**: tech-debt
- **Planned at**: commit `f1b9293`, 2026-08-30

## Why this matters

The bounded XLSX reader deliberately uses private ExcelJS `WorkbookReader` fields to avoid unbounded temporary worksheet copies during its two-pass first-sheet parse. Both manifests permit a future minor upgrade, so a routine lock refresh can silently change those internals and either break ingestion or weaken its memory/disk guarantees. Confine the private dependency to one runtime-guarded adapter, pin the duplicated runtime version, and characterize the exact supported behavior with compatibility tests.

## Current state

- `server/src/data/xlsx.ts:5` imports ExcelJS, and `server/src/data/xlsx.ts:42-62` declares a hand-written private shape:

  ```ts
  interface WorkbookReaderInternals {
    model: { sheets?: WorkbookSheetModel[] };
    workbookRels: unknown[];
    sharedStrings: unknown[];
    properties?: unknown;
    styles: unknown;
    stream?: { destroy?: () => void };
  }
  ```

- `server/src/data/xlsx.ts:246-292` casts the reader and overwrites private fields before the metadata pass:

  ```ts
  function readerInternals(
    workbook: ExcelJS.stream.xlsx.WorkbookReader,
  ): WorkbookReaderInternals {
    return workbook as unknown as WorkbookReaderInternals;
  }

  const placeholderModel: WorkbookReaderInternals["model"] = { sheets: [] };
  const placeholderRelationships: unknown[] = [];
  internals.model = placeholderModel;
  internals.workbookRels = placeholderRelationships;
  internals.sharedStrings = [];
  ```

  The truthy placeholders intentionally make ExcelJS drain early worksheet ZIP entries instead of writing its own unbounded temporary files.

- `server/src/data/xlsx.ts:345-391` creates a second reader, reinjects `model`, `workbookRels`, `sharedStrings`, `properties`, and `styles`, then emits only the first declared worksheet. Both passes call `destroyReader` in `finally`.
- The surrounding implementation enforces 200,000 rows, 10,000 columns, 2,000,000 cells, 100 MiB total expansion, 50 MiB per ZIP member, 1 MiB per rendered cell, and a 64 KiB CSV buffer. These limits and the ZIP preflight must not move or relax.
- `server/src/tests/xlsx.test.ts:44-129` covers first-sheet output, idempotent cleanup, ZIP/member/encryption rejection, legacy `.xls`, empty workbooks, coordinate limits, and cell-byte limits. It does not characterize the private adapter shape or representative value variants.
- Both `server/package.json:30` and `desktop/package.json:41` contain `"exceljs": "^4.4.0"`; `pnpm-lock.yaml` currently resolves 4.4.0. The desktop intentionally duplicates every server runtime dependency.
- Root `package.json:20-28` pins shared duplicated versions through `pnpm.overrides`, but ExcelJS is absent. `desktop/scripts/copy-runtime.mjs:55-76` verifies that installed server/desktop runtime dependency versions match before copying.
- `scripts/policy-check.mjs:95-103` forbids SheetJS (`xlsx`) and directs maintainers to this bounded ExcelJS reader. Keep that prohibition.

## Commands you will need

| Purpose         | Command                                                                                                                       | Expected on success                                                                                  |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Lock update     | `pnpm install --lockfile-only`                                                                                                | exit 0; only the intended manifest snapshots/lock metadata change and ExcelJS resolves exactly 4.4.0 |
| Focused tests   | `pnpm --filter borealis-server exec vitest run src/tests/exceljsBoundary.test.ts src/tests/xlsx.test.ts`                      | exit 0; adapter and parser compatibility cases pass                                                  |
| Server checks   | `pnpm --filter borealis-server typecheck && pnpm --filter borealis-server lint && pnpm --filter borealis-server format:check` | exit 0                                                                                               |
| Desktop checks  | `pnpm --filter borealis-desktop verify`                                                                                       | exit 0; duplicated runtime still copies and loads                                                    |
| Policy          | `pnpm policy`                                                                                                                 | exit 0                                                                                               |
| Repository gate | `pnpm verify`                                                                                                                 | exit 0 and prints `ALL GATES GREEN`                                                                  |

## Scope

**In scope** (the only files you should modify):

- `server/src/data/xlsx.ts`
- `server/src/data/exceljsBoundary.ts` (create)
- `server/src/tests/exceljsBoundary.test.ts` (create)
- `server/src/tests/xlsxSpillProbe.ts` (create; isolated child-process probe, not a test suite)
- `server/src/tests/xlsx.test.ts`
- `server/package.json`
- `desktop/package.json`
- `package.json`
- `pnpm-lock.yaml`
- `scripts/policy-check.mjs`

`desktop/scripts/copy-runtime.mjs` is a read-only contract exemplar; STOP before changing it.

**Out of scope**:

- Replacing the streaming reader with ExcelJS’s in-memory `Workbook` API.
- Adding SheetJS/npm `xlsx`, another spreadsheet parser, macros, legacy `.xls`, or DuckDB extension installation.
- Changing first-declared-sheet semantics, CSV rendering, ZIP preflight, cleanup semantics, public error codes/messages, or any processing budget.
- Broad dependency refreshes or lockfile churn unrelated to the exact ExcelJS declaration.
- Documentation; plan 023 owns it.

## Git workflow

- Branch: `codex/021-exceljs-boundary`
- Use conventional commits; an observed example is `feat: set a personal default chat model in Settings and start new chats from it`.
- Suggested commit: `refactor: isolate ExcelJS parser internals`
- Do not push or open a PR without explicit operator instruction.

## Steps

### Step 1: Characterize the installed 4.4.0 reader before refactoring

Write focused characterization tests against the installed ExcelJS 4.4.0 `WorkbookReader`. Confirm the exact types/timing of `model`, `model.sheets`, `workbookRels`, `sharedStrings`, `properties`, `styles`, `stream.destroy`, worksheet IDs, and cleanup after the metadata pass. The test may name private fields, but it must not snapshot paths, worksheet content, whole objects, or dependency source.

Create representative real workbooks covering shared strings, numbers, booleans, dates, formula results, rich text, hyperlinks, error cells, sparse row gaps, and multiple worksheets. Record the current CSV semantics in assertions before moving code.

**Verify**: `pnpm --filter borealis-server exec vitest run src/tests/exceljsBoundary.test.ts src/tests/xlsx.test.ts` → exit 0 against exactly ExcelJS 4.4.0; the tests demonstrate the private shape and current output.

### Step 2: Isolate and guard every private operation

Create `server/src/data/exceljsBoundary.ts` as the only production module allowed to cast to private `WorkbookReader` internals or read/write `model`, `workbookRels`, `sharedStrings`, `properties`, `styles`, and the private stream. Export the narrow repository-owned `forEachFirstWorksheetRow(inputPath, onRow)` operation using ExcelJS’s public `Row` type at its callback boundary; `xlsx.ts` retains row/cell/output budgets and CSV rendering.

Keep the two-pass design:

1. metadata pass with the same truthy placeholders and options that prevent unbounded worksheet temp copies;
2. strict runtime validation of the actual post-pass private shape;
3. data pass with validated metadata reinjected;
4. only the first declared worksheet ID emitted;
5. both readers destroyed in `finally`, including callback/parser failures.

Before every mutation or use, validate object/array/function/integer shape. Convert any missing, changed, or contradictory private field into the existing safe `DataProcessingError(422, "xlsx workbook could not be parsed")`; never expose a `TypeError`, dependency stack, path, cell value, or raw ExcelJS message. Add an internal reader-factory seam so tests can provide malformed fake shapes without module mocking.

Refactor `xlsx.ts` to consume only the adapter. Remove `WorkbookReaderInternals`, `WorkbookMetadata`, `readerInternals`, `destroyReader`, and all direct private-field access from it. Do not move ZIP, row, cell, expansion, CSV-buffer, or temp-output limits into the adapter.

**Verify**: `pnpm --filter borealis-server typecheck && pnpm --filter borealis-server lint` → exit 0; private casts/fields appear only in `exceljsBoundary.ts` and its focused test.

### Step 3: Pin the duplicated runtime dependency and add a policy gate

Change both runtime manifests to `"exceljs": "4.4.0"` and add `"exceljs": "4.4.0"` to root `pnpm.overrides`. Run `pnpm install --lockfile-only`; inspect the diff and revert any unrelated resolver churn before proceeding. The server and desktop importer snapshots must both resolve the same exact package.

Extend `scripts/policy-check.mjs` to fail when:

- server or desktop declares a non-exact/different ExcelJS version;
- root override is missing/different;
- a production server module other than `data/exceljsBoundary.ts` contains the exact private-reader cast or direct internal-access patterns (for example `as unknown as WorkbookReaderInternals` or `internals.workbookRels`);
- the forbidden SheetJS package appears.

Match syntax narrowly. In particular, do not reject `xlsx.ts`’s legitimate public reader option/string `styles: "ignore"`, public `Row`/cell styles, comments, or unrelated identifiers merely because they contain a private field name. Prefer an AST check; if a regex is used, anchor it to the adapter variable/property-access and cast shapes and add positive/negative policy fixtures. Make diagnostics identify files/symbol categories only, never workbook content or paths from runtime data.

**Verify**: `pnpm install --lockfile-only && pnpm policy && rg -n 'exceljs:|exceljs@4\.4\.0' pnpm-lock.yaml` → commands exit 0; both importer entries are exact and the only resolved ExcelJS package is 4.4.0.

### Step 4: Test safe drift failure and resource invariants

In `exceljsBoundary.test.ts`, inject a fake reader for each private-shape failure: missing/wrong `model`, sheets, relationship array, shared strings, styles, stream/destroy, invalid first worksheet ID, and a field that remains the placeholder after iteration. Assert a stable 422 `DATA_PROCESSING_ERROR`, destruction exactly once, and no raw error/path/content in the message.

In `xlsx.test.ts`, retain all prior cases and add the representative cell-value fixtures from step 1, second-sheet exclusion, sparse-row behavior, and cleanup after a boundary callback failure.

Make the no-spill assertion in an isolated child process, not by scanning the
host’s shared temporary directory from parallel Vitest. Create
`server/src/tests/xlsxSpillProbe.ts` with no static import of `node:os`,
ExcelJS, `xlsx.ts`, or the boundary. The parent test creates two distinct
mode-0700 temporary directories: a fixture directory containing the generated
workbook and a separate, initially empty private temp root outside that fixture
directory. Spawn the probe through the repository's `tsx` loader with `TMPDIR`
set to the private root and `TSX_DISABLE_CACHE=1` in the child environment
before Node starts, and pass only the fixture path. The cache setting is
load-bearing: without it, tsx may create a `tsx-<uid>` loader cache below the
private temp root and invalidate the filesystem assertion. Do not inherit
another value or move the cache elsewhere. The fixture must never live below
`TMPDIR`, so the expected inventory cannot accidentally include or mask it. The
probe dynamically imports the parser after startup, converts the fixture,
inventories only paths relative to its private `TMPDIR` while the
repository-owned CSV exists, cleans it, confirms the directory returns to
empty, and emits a bounded fixed-shape JSON result. Normalize the random
`borealis-xlsx-*` suffix to a constant label before emitting; never print the
absolute temp or input path. Assert the only transient tree is
`<output>/worksheet.csv`; any tsx cache, ExcelJS worksheet spill file/directory,
or residual artifact fails. Do not share this `TMPDIR` with other tests; clean
both directories separately in the parent’s `finally`.

**Verify**: `pnpm --filter borealis-server exec vitest run src/tests/exceljsBoundary.test.ts src/tests/xlsx.test.ts` → exit 0 for every real compatibility and injected-drift case.

### Step 5: Run desktop and repository gates

Build/copy the server runtime through existing desktop verification so the exact duplicated dependency is exercised. Do not edit the copy script to suppress a mismatch.

**Verify**: `pnpm --filter borealis-server typecheck && pnpm --filter borealis-server lint && pnpm --filter borealis-server format:check && pnpm --filter borealis-server test && pnpm --filter borealis-desktop verify && pnpm policy && pnpm verify` → exit 0 and final output includes `ALL GATES GREEN`.

## Test plan

- `exceljsBoundary.test.ts`: actual 4.4.0 private shape, two-pass handoff, reader destruction, and one test for each guarded drift failure.
- `xlsx.test.ts` plus `xlsxSpillProbe.ts`: all current security budgets and value variants, first-sheet selection, bounded output, cleanup failures, and a child-process/private-`TMPDIR` proof that ExcelJS creates no worksheet spill artifacts.
- Policy tests/checks: exact/equal declarations and override; no private-field access outside the boundary; SheetJS remains forbidden.
- Desktop verification: copied runtime resolves the same pinned ExcelJS package.

## Done criteria

- [ ] All private ExcelJS reader access lives in `server/src/data/exceljsBoundary.ts` and is runtime guarded.
- [ ] `xlsx.ts` retains ZIP/row/column/cell/output budgets and consumes only the narrow adapter.
- [ ] Server, desktop, root override, and lockfile all resolve exactly ExcelJS 4.4.0 with no unrelated dependency changes.
- [ ] Private-shape drift produces only the stable 422 data-processing error and always destroys readers.
- [ ] Existing and representative compatibility/resource tests pass; first-declared-sheet semantics are unchanged.
- [ ] The no-spill test keeps its fixture outside an initially empty isolated
      `TMPDIR`, sets that environment plus `TSX_DISABLE_CACHE=1` before any
      loader/`node:os`/ExcelJS import, and never scans the shared host temp
      directory.
- [ ] The policy gate permits public `styles` options and rejects only direct private-adapter access outside the boundary.
- [ ] Desktop copy verification, policy, and `pnpm verify` pass with `ALL GATES GREEN`.
- [ ] Only in-scope files plus the optional index row are modified.
- [ ] Plan 021 is marked `DONE` unless the reviewer owns the index.

## STOP conditions

Stop and report if:

- Installed ExcelJS is not 4.4.0 or its private shape differs from the characterization described above.
- A supported public streaming API can satisfy the same bounded two-pass/first-declared-sheet behavior; present that smaller supported-API alternative before committing to private access.
- Isolation requires the in-memory Workbook API, unbounded temp files, relaxed budgets, SheetJS, or a new parser dependency.
- Exact pinning produces server/desktop divergence or unrelated lockfile changes that cannot be explained and removed.
- A private-shape failure cannot be converted to the existing safe 422 contract while guaranteeing reader cleanup.
- A required fix falls outside scope or a verification fails twice after one reasonable correction.

## Maintenance notes

- A future ExcelJS upgrade is a deliberate parser migration: change the exact pin, rerun characterization/compatibility/security tests, and review the boundary fields before updating the lock.
- Keep value rendering and resource limits owned by `xlsx.ts`; the adapter’s only job is safe access to the first worksheet stream.
- Do not weaken the policy gate because a private field appears convenient elsewhere. Extend the adapter instead.
- Plan 023 may mention the exact supported parser only if useful to operators; it must emphasize bounded offline XLSX handling rather than private implementation details.

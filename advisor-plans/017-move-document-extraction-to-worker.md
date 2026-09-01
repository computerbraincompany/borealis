# Plan 017: Move document extraction to a bounded worker

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the “STOP conditions” section occurs, stop and report — do not improvise. When done, update the status row for this plan in `advisor-plans/README.md` unless a reviewer dispatched you and told you they maintain the index.
>
> **Drift check (run first)**: `git diff --stat f1b9293..HEAD -- server/src/ingestSupport.ts server/src/data/documentExtraction.ts server/src/data/documentExtractionRunner.ts server/src/data/documentExtractionWorker.ts server/src/data/documentParsers.ts server/src/tests/fixtures/documentExtractionWorkerFixture.ts server/src/tests/ingestLifecycle.test.ts server/src/tests/ingestionEngine.test.ts server/src/tests/documentExtractionWorker.test.ts scripts/policy-check.mjs`
> Plan 036 intentionally changed PDF extraction and these tests by adding the
> bounded local Vision/PDFKit OCR path. That implementation is a required
> baseline, not drift: embedded-text classification must still run before OCR,
> only classified pages may reach the fixed local helper, and every OCR budget,
> cancellation, page marker, unavailable result, and no-network guarantee must
> survive this worker refactor. STOP if the design would move `osascript` into a
> worker without an owned kill path or would drop OCR behavior.
> **Read-only dependency check**: also inspect drift in `server/src/ingest.ts`,
> `server/src/ingestionEngine.ts`, `server/src/data/datasets.ts`, and
> `server/src/localPdfOcr.ts`; preserve Plans 004, 015, 016, 035, and 036 rather
> than treating their expected wiring as STOP drift.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: MED
- **Depends on**: `advisor-plans/004-add-vertical-agent-integration-test.md`, `advisor-plans/036-add-bounded-local-ocr.md`
- **Preserve completed baseline**: Plans 035 and 036
- **Category**: perf
- **Planned at**: commit `f1b9293`, 2026-08-30

## Why this matters

PDF parsing, DOCX inflation checks, and Mammoth extraction currently execute in the Fastify process. A hostile or merely complex document can monopolize the event loop even though byte, page, and expansion limits exist, delaying authentication, health checks, cancellation, and every other account. Move CPU-heavy document work behind a worker-thread boundary with explicit timeout, V8 heap/stack ceilings, and existing input/archive/output limits while retaining the durable ingestion protocol and public errors. This is event-loop isolation and layered resource control, not an OS-level RSS sandbox: Node `Worker` resource limits do not hard-cap Buffers or native parser allocations.

## Current state

- `server/src/ingestSupport.ts` owns format selection, parser budgets, and the heavy parser imports. At `server/src/ingestSupport.ts:1-6`:

  ```ts
  import { inflateRawSync } from "node:zlib";
  import {
    getDocument,
    GlobalWorkerOptions,
  } from "pdfjs-dist/legacy/build/pdf.mjs";
  import mammoth from "mammoth";
  import { config } from "./config.js";
  GlobalWorkerOptions.workerSrc = "";
  ```

- The same module parses buffers in-process. At `server/src/ingestSupport.ts:216-227`:

  ```ts
  export async function extractText(
    filePath: string,
    mime: string,
  ): Promise<string> {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === ".doc") {
      throw new Error(
        "legacy .doc files are not supported; upload .docx instead",
      );
    }
    if (EXT_TEXT.has(ext))
      return (await fs.readFile(filePath, "utf8")).slice(
        0,
        config.maxExtractedChars,
      );
    if (ext === ".pdf" || mime.includes("pdf"))
      return extractPdf(await fs.readFile(filePath));
    if (ext === ".docx" || mime.includes("officedocument.wordprocessingml")) {
      return extractDocx(await fs.readFile(filePath));
    }
    throw new Error("file format is not supported");
  }
  ```

- `server/src/ingest.ts:139-158` calls its concurrency loops “workers”, but they are promise pumps on the main event loop:

  ```ts
  ingestionPump = Promise.resolve().then(async () => {
    do {
      ingestionRepump = false;
      await Promise.all(
        Array.from({ length: WORKER_CONCURRENCY }, async () => {
          while (await processOneJob()) {
            // Drain every currently available durable job.
          }
        }),
      );
    } while (ingestionRepump);
  });
  ```

- `server/src/data/datasets.ts:84-104` is the repository’s real worker-thread exemplar: it defines a typed operation union plus request, cancel, and response messages. Its worker launcher selects `.ts` under source execution and `.js` after compilation, using `execArgv: ["--import", "tsx"]` only for the TypeScript path. Match its message/error/exit discipline.
- `server/src/tests/ingestLifecycle.test.ts:1-97` already covers text/PDF/DOCX behavior, legacy `.doc`, MIME confusion, ZIP expansion, and malformed archives. `server/src/tests/ingestionEngine.test.ts:34-205` is the dependency-injected ingestion/lifecycle exemplar. Plan 004 adds the vertical acceptance test that must remain green.
- Preserve the documented limits: 500 PDF pages, 2,048 DOCX members, 100 MiB total expansion, 50 MiB per member, compression ratio 200, `config.maxExtractedChars`, and `config.maxIngestChunks`.

## Commands you will need

| Purpose          | Command                                                                                                                                                        | Expected on success                 |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Targeted tests   | `pnpm --filter borealis-server exec vitest run src/tests/documentExtractionWorker.test.ts src/tests/ingestLifecycle.test.ts src/tests/ingestionEngine.test.ts` | exit 0; all named tests pass        |
| Server typecheck | `pnpm --filter borealis-server typecheck`                                                                                                                      | exit 0, no errors                   |
| Server lint      | `pnpm --filter borealis-server lint`                                                                                                                           | exit 0, no warnings                 |
| Server format    | `pnpm --filter borealis-server format:check`                                                                                                                   | exit 0                              |
| Server tests     | `pnpm --filter borealis-server test && pnpm --filter borealis-server test:integration`                                                                         | exit 0; all suites pass             |
| Policy           | `pnpm policy`                                                                                                                                                  | exit 0                              |
| Repository gate  | `pnpm verify`                                                                                                                                                  | exit 0 and prints `ALL GATES GREEN` |

## Scope

**In scope** (the only files you should modify):

- `server/src/ingestSupport.ts`
- `server/src/data/documentExtraction.ts` (create)
- `server/src/data/documentExtractionRunner.ts` (create; package-internal injectable lifecycle primitive)
- `server/src/data/documentExtractionWorker.ts` (create)
- `server/src/data/documentParsers.ts` (create; worker-only heavy parser implementation)
- `server/src/tests/ingestLifecycle.test.ts`
- `server/src/tests/ingestionEngine.test.ts`
- `server/src/tests/documentExtractionWorker.test.ts` (create)
- `server/src/tests/fixtures/documentExtractionWorkerFixture.ts` (create; test-only worker entry for malformed/slow/crash replies)
- `scripts/policy-check.mjs` (only for the structural import gate described below)

`server/src/ingest.ts`, `server/src/ingestionEngine.ts`,
`server/src/data/datasets.ts`, `server/src/localPdfOcr.ts`, and the packaged JXA
helper are read-only exemplars unless live drift proves a minimal wiring change
is unavoidable; STOP before widening scope. The parent-side facade must keep
calling the existing OCR adapter with the same already-proven path and signal.

**Out of scope**:

- The SQLite/LanceDB generation, lease, promotion, cleanup, or recovery protocol.
- Tabular parsing and the DuckDB worker.
- Upload allowlists, path-ownership proof, MIME policy, or public ingestion error shapes.
- Relaxing any parser, extraction, OCR, upload, or chunk budget.
- Moving plain-text reads to a worker; their bounded asynchronous read is not the CPU-heavy problem.
- Documentation; plan 023 owns the final documentation sweep.

## Git workflow

- Branch: `codex/017-document-extraction-worker`
- Use conventional commits; the repository’s style includes `feat: set a personal default chat model in Settings and start new chats from it`.
- Suggested commit: `refactor: move document extraction into worker threads`
- Do not push or open a PR unless the operator explicitly asks.

## Steps

### Step 1: Define the narrow worker protocol and parser-only module

Create `server/src/data/documentExtraction.ts` as the fixed production facade,
`server/src/data/documentExtractionRunner.ts` as the package-internal worker
lifecycle primitive, and `server/src/data/documentExtractionWorker.ts` as the
worker entry point. The facade’s exported extraction signature accepts only
parser kind, already-proven absolute path, maximum returned characters, and the
existing cancellation signal; it hard-codes the production worker URL, factory,
timeout, and resource limits. No route/ingestion caller may inject or override
them.

The runner accepts the same validated extraction request plus an explicit
options object containing worker factory, entry URL, deadline, and resource
limits. It exists only so `documentExtractionWorker.test.ts` can exercise
lifecycle failures with the fixture worker. Use a discriminated
request/response protocol containing only a generated request ID, parser kind
(`pdf` or `docx`), the proven path, and maximum returned characters. DOCX
returns bounded text. PDF returns bounded ordered page records containing page
number, embedded text, and the existing classifier's `needsOcr` decision; cap
record count at 500 and total returned text at `config.maxExtractedChars`.
Validate every field on both sides. Never send file bytes, source metadata,
account IDs, content, paths in errors, or parser exception text back to the
parent.

Move `pdfjs-dist`, `mammoth`, `inflateRawSync`, `GlobalWorkerOptions`, embedded
PDF extraction/classification, `extractDocx`, and DOCX preflight internals into
`documentParsers.ts`. Only `documentExtractionWorker.ts` may import that module.
Preserve every existing constant and exact fail-closed check. Keep
`recognizeLocalPdfPages` and child-process ownership in the parent-side facade:
after the worker returns, pass only `needsOcr` page numbers to that adapter,
merge successful text with the existing `[Page N — OCR]` marker, retain the
mixed/text-PDF unavailable fallback, and apply the same final text bound. Do not
invoke `/usr/bin/osascript` from the worker, where terminating the worker could
orphan its child.

Use a worker per extraction request. Resolve `documentExtractionWorker.ts` during TS tests and `documentExtractionWorker.js` in compiled runtime exactly as `server/src/data/datasets.ts` does. The fixed production facade must declare and use these exact constants, with no caller/request/environment override:

- `DOCUMENT_EXTRACTION_TIMEOUT_MS = 120_000`;
- `maxOldGenerationSizeMb: 512`;
- `maxYoungGenerationSizeMb: 64`;
- `stackSizeMb: 8`.

The 512 MiB old-generation ceiling leaves deliberate JavaScript-parser headroom above the 100 MiB total DOCX expansion budget and the configured extracted-text maximum of 10,000,000 characters; the young-generation and stack limits prevent unconstrained V8 defaults. The existing ingestion concurrency is two, so two extraction workers may coexist and operators/tests must not treat 512 MiB as a process-wide budget. Document that `resourceLimits` constrains V8-managed memory only: Buffers, native allocations, and total RSS remain governed indirectly by the existing upload/archive/output budgets and 120-second deadline, not by a hard process-memory sandbox. Keep only the package-internal runner's deadline/resource-limit options injectable so tests can use short deterministic deadlines; production callers cannot override them.

**Verify**: `pnpm --filter borealis-server typecheck` → exit 0, including the typed worker messages and compiled-path selection.

### Step 2: Make the parent lifecycle bounded and content-free

In `documentExtractionRunner.ts`, enforce the supplied deadline and cap the
accepted response to the request limit. On success, parser failure, malformed
reply, error, exit, timeout, or abort, detach listeners and terminate the
worker. Reject with a stable internal extraction error that contains neither
file path nor parser-controlled text. A late worker reply must be ignored. In
`documentExtraction.ts`, call that runner only with fixed production constants
and cap the request at `config.maxExtractedChars`; keep all options out of the
exported facade signature. One parent-owned abort/deadline must cover worker
parsing and the subsequent OCR merge, with the existing stricter OCR page and
total deadlines still enforced by `localPdfOcr.ts` and killing the exact helper
child.

Keep plain text, extension choice, and the public
`extractText(filePath, mime, signal)` signature in `ingestSupport.ts`; route
only PDF and DOCX branches through the facade. Do not change when the ingestion
engine proves ownership of `filePath`, and do not classify OCR candidates from
OCR output or after the worker boundary.

Add structural checks to `scripts/policy-check.mjs` that fail if `pdfjs-dist`, `mammoth`, or `inflateRawSync` is imported outside `server/src/data/documentParsers.ts`, if a production module other than `documentExtractionWorker.ts` imports `documentParsers.ts`, or if any production module other than the fixed `documentExtraction.ts` facade imports `documentExtractionRunner.ts`. The same check must require the exact `120_000` and `512/64/8` production constant declarations and their use in the facade's runner call, and reject an environment/request/caller-derived worker option. Tests may import the runner; ingestion/routes may import only the facade. Scan source deterministically and produce content-free diagnostics.

**Verify**: `pnpm policy && pnpm --filter borealis-server lint` → both exit 0; the heavy imports occur only in the worker-side parser path.

### Step 3: Cover isolation, limits, failure, and recovery

Create `server/src/tests/documentExtractionWorker.test.ts`, importing the package-internal runner directly and using temporary UUID-scoped fixtures plus the worker test pattern in `datasetsWorker.test.ts`. Create `server/src/tests/fixtures/documentExtractionWorkerFixture.ts` as a test-only worker that receives the normal production request but can, through constructor `workerData` chosen by the injected test factory, delay, exit, or return malformed/oversized replies. Do not add test-only operations or flags to the production facade or wire protocol. Cover:

- a real small PDF and DOCX produce the same bounded text as before;
- a text PDF bypasses OCR; mixed and raster-only PDFs send only worker-classified
  pages through the existing local OCR adapter and preserve page markers,
  `OCR_UNAVAILABLE`, no-network behavior, and final extraction limits;
- the structural policy gate retains the exact 120-second and `512/64/8` production constants while runner lifecycle tests use injected shorter values without changing the production wire protocol;
- malformed request/reply, parser failure, worker error, worker exit, and timeout return the stable internal error without content or paths;
- a deliberately CPU-busy fixture worker times out, is terminated, and a later real extraction succeeds;
- oversized worker output is rejected even if the worker violates the protocol;
- a short parent timer continues advancing while the fixture worker is CPU-busy, deterministically proving the server event loop is not doing that work;
- worker listeners/processes and OCR helper children do not remain after
  success, failure, abort, or timeout.

Retain and adapt all existing cases in `ingestLifecycle.test.ts`; extend
`ingestionEngine.test.ts` only where needed to prove the injected extraction
contract and durable failure mapping did not change. Run plan 004’s unchanged
ready-source accepted-turn vertical regression as a composition safety net; it
does not upload a document or exercise extraction, so never cite it as worker
coverage.

**Verify**: `pnpm --filter borealis-server exec vitest run src/tests/documentExtractionWorker.test.ts src/tests/ingestLifecycle.test.ts src/tests/ingestionEngine.test.ts` → exit 0 with every isolation, timeout, parser-budget, and regression case passing.

### Step 4: Run the complete gates

Run server validation first, then the repository gate. Do not weaken flaky or slow tests to make the gate pass.

**Verify**: `pnpm --filter borealis-server typecheck && pnpm --filter borealis-server lint && pnpm --filter borealis-server format:check && pnpm --filter borealis-server test && pnpm --filter borealis-server test:integration && pnpm verify` → exit 0 and final output includes `ALL GATES GREEN`.

## Test plan

- New `server/src/tests/documentExtractionWorker.test.ts`: real worker,
  compiled/source entry resolution, bounded DOCX/PDF page results,
  error/exit/timeout cleanup, subsequent recovery, event-loop responsiveness,
  and parent-side OCR merge/cancellation without helper orphaning.
- Existing `server/src/tests/ingestLifecycle.test.ts`: all supported/unsupported formats and archive limits remain behaviorally identical.
- Existing `server/src/tests/ingestionEngine.test.ts`: ingestion failure remains durable and sanitized; generation/lease behavior is unchanged.
- Existing plan-004 vertical test: the ready-source accepted-turn → agent →
  persistence path remains green as a downstream composition regression; worker
  extraction coverage comes only from this plan's ingestion/worker tests.
- Structural policy test: heavy parser dependencies cannot drift back into the server event loop.

## Done criteria

- [ ] `pdfjs-dist`, `mammoth`, and synchronous archive inflation execute only in a worker-thread module.
- [ ] PDF/DOCX work has enforced input/archive/output limits, a deadline, and explicit V8 heap/stack ceilings; every terminal path terminates its worker, with no false claim of an OS-level RSS cap.
- [ ] The production facade hard-codes a 120-second deadline and Worker `resourceLimits` of 512 MiB old generation, 64 MiB young generation, and 8 MiB stack; only the package-internal test runner accepts injected values.
- [ ] Plain text and the public `extractText`/ingestion error contract are unchanged.
- [ ] Plan 036 remains intact: embedded-text classification precedes OCR, only
      bounded candidate pages reach the fixed local helper, mixed/unavailable
      behavior and page markers match, and no network OCR path is introduced.
- [ ] Production callers can import only the fixed facade; injected worker URL/factory/deadline options exist only on the package-internal runner used by tests.
- [ ] Existing parser and ingestion tests plus the new isolation/recovery cases pass.
- [ ] `pnpm policy` and `pnpm verify` pass, with `ALL GATES GREEN`.
- [ ] `git status --short` lists only the in-scope files and the reviewer-owned `advisor-plans/README.md` status update, if requested.
- [ ] The plan 017 row in `advisor-plans/README.md` is `DONE` unless the reviewer owns the index.

## STOP conditions

Stop and report rather than improvising if:

- Plan 004 is not `DONE`, or its ready-source accepted-turn vertical regression
  is absent/failing before this work. Do not require it to cover upload or
  document extraction.
- Current parser code or limits differ materially from the excerpts above.
- Worker startup cannot support both TypeScript tests and compiled ESM without changing package/module architecture.
- The parser cannot run within defensible V8 heap/stack headroom above the current 100 MiB expansion limit.
- The implementation would pass an unproven path into the worker, expose path/content/parser errors, relax budgets, or alter public ingestion semantics.
- The implementation would run the OCR helper inside a terminable worker,
  orphan a helper child, re-OCR meaningful pages, or weaken any Plan 036
  availability, metadata, local-only, or budget contract.
- A verification command fails twice after one reasonable correction.
- Any required fix falls outside the declared scope.

## Maintenance notes

- Review resource-limit headroom whenever PDFJS, Mammoth, or the configured extraction limit changes; never infer that archive expansion alone represents peak heap.
- Keep the worker wire format small and versionless while it has one caller. If it gains operations, follow the typed request/cancel/response discipline in `datasets.ts`.
- The structural policy gate is intentional defense against performance regressions, not a general dependency ban.
- Keep OCR orchestration outside the parser worker. The worker owns CPU-heavy
  embedded parsing; the parent owns the exact local helper child and its abort
  signal so worker termination cannot detach OS work.
- Plan 023 must document that document parsing is local and event-loop isolated with a timeout, existing byte/archive/output budgets, and V8 heap/stack ceilings. It must not claim an OS-level RSS sandbox, a hard cap on native/Buffer allocation, or that all ingestion moved out of the server process.

# Plan 014: Fix the ingest name mismatch and the chat-stream UX bugs

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat cf9c3c3..HEAD -- server/src/routes.ts server/src/agent.ts server/src/llm.ts server/src/ingest.ts web/src/pages/ChatView.tsx web/src/pages/SourcesView.tsx web/src/lib/api.ts python/app/datasets.py`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: L (Steps 1-4 are each S; Step 5 is M)
- **Risk**: LOW-MEDIUM (Step 5 changes CSV parsing defaults for `;`-delimited files)
- **Depends on**: none (but see Preflight — the running python service must be current)
- **Category**: bug
- **Planned at**: commit `cf9c3c3`, 2026-08-22
- **Evidence**: diagnosed live on 2026-08-22 from a user screencap + reproduction
  against the running stack. Registering the real uploaded file
  (`uploads/6a0ed1b6/1787432988524_22-08-2026_Umsatzliste_Girokonto_DE33120300001054151210.csv`)
  returned `400 table name '22_08_2026_umsatzliste_girokonto_de33…' invalid`;
  with a letter-leading name the same file registered but DuckDB parsed
  `18.08.26` as `2018-08-26` (day/year swap) and left `Betrag (€)` as VARCHAR.

## Why this matters

One backend bug breaks the product's core use case end-to-end, and two display
bugs make every conversation look broken even when it works:

1. **Ingest fails on filenames starting with a digit.** The server sanitizes an
   upload filename into a dataset table name but allows a leading digit; python
   rejects those names. Real bank exports ("22-08-2026_Umsatzliste…") hit this
   on first upload. Everything downstream then fails visibly in chat:
   `query_data` → 422 "No files found that match the pattern" (DuckDB treats the
   unknown quoted identifier as a file glob), `describe_data` → 404, `retrieve`
   → empty. The failure reason is discarded (`sources.meta` stays `{}`), there
   is no way to retry an errored source, and the Sources page counts errored
   sources as "still processing".
2. **Raw `<think>…</think>` renders in the assistant bubble.** Qwen-style models
   emit reasoning inline in `content`; neither the stream nor `cleanFinal`
   removes it, so it is streamed raw, persisted verbatim in `messages`, and
   shown literally by react-markdown on every reload.
3. **Two identical "thinking…" bubbles render simultaneously** before the first
   streamed event arrives (overlapping fallback blocks in ChatView).
4. **(Even once 1 is fixed)** German-locale CSVs parse wrong: `DD.MM.YY` dates
   are read as `%y.%m.%d` and comma-decimal amounts stay VARCHAR, so any SQL
   aggregation over them fails or lies.

## Current state

Files and their roles (line numbers at commit `cf9c3c3`):

- `server/src/routes.ts` — upload route builds the table name (line 118) and
  inserts the source with `status='index'` (line ~129) before firing
  `ingestSource`.
- `python/app/datasets.py` — `TABLE_RE = re.compile(r"^[a-z][a-z0-9_]{0,62}$")`
  (line 29); `register()` raises `HTTPException(400, "table name … invalid")`
  (lines 70-71). `_read_sql()` (lines 32-42) emits bare `read_csv_auto(?)` with
  no delimiter/date/decimal options.
- `server/src/ingest.ts` — `ingestSource()` calls
  `py.registerDataset(accountId, name, filePath, …)` (line 89); the catch block
  (lines 116-120) logs and sets `status='error'` but writes nothing to `meta`.
- `web/src/pages/SourcesView.tsx` — `pendingCount = sources.length - readyCount`
  (line 52) drives the "{n} still processing." banner (line 60); no retry affordance.
- `web/src/lib/api.ts` — sources/chats/reports API clients.
- `server/src/llm.ts` — `streamingChat` delta loop (lines 56-63) forwards
  `delta.content` straight through; no reasoning handling.
- `server/src/agent.ts` — `cleanFinal` (lines 18-35) strips prose "Thinking:"
  prefixes but not `<think>` tags; final answers persist `cleanFinal(content)`.
- `web/src/pages/ChatView.tsx` — streaming render block (lines 230-264):
  fallback bubble #1 at lines 235-244 (else-branch of
  `stream.text || stream.steps.length`), fallback bubble #2 at lines 252-263
  guarded by `!stream.text && !stream.steps.length && stream.error === null`.
  Both guards are true simultaneously until the first event arrives → duplicate
  bubbles.
- `web/src/components/ChatMessage.tsx` — renders assistant `content` via
  ReactMarkdown (lines 80-84); pulsing dots when `streaming && !content`
  (lines 85-95).
- `server/src/tests/cleanFinal.test.ts` — existing vitest coverage for `cleanFinal`.
- `python/tests/test_datasets.py` — existing pytest coverage for the registry.

Current exact code (excerpts):

`server/src/routes.ts:117-118` (the unsanitized-prefix derivation):
```ts
    const base = path.basename(safeOriginal, path.extname(safeOriginal)).toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "dataset";
```

`server/src/ingest.ts:116-120` (error is swallowed):
```ts
  } catch (e) {
    console.error("ingest failed", e);
    await q(`UPDATE sources SET status='error' WHERE id=$1`, [sourceId]);
    throw e;
  }
```

`server/src/web` n/a — `web/src/pages/ChatView.tsx:230-245` (both placeholders
in one streaming fragment):
```tsx
            {stream.running && (
              <>
                {stream.text || stream.steps.length ? (
                  <ChatMessage role="assistant" content={stream.text} streaming charts={stream.finalCharts} report={stream.finalReport} />
                ) : (
                  <div className="flex justify-start">
                    {/* …pulsing dots + "thinking…" #1… */}
                  </div>
                )}
                <ToolActivity steps={stream.steps} className="max-w-[360px]" />
```
and `ChatView.tsx:252-263` (placeholder #2, rendered at the same time as #1):
```tsx
                {!stream.text && !stream.steps.length && stream.error === null && (
                  <div className="flex justify-start">
                    {/* …identical pulsing dots + "thinking…" #2… */}
                  </div>
                )}
```

Conventions: server is ESM — local imports need the `.js` extension. Keep the
parameterized `q` style. Python service is FastAPI + DuckDB in-memory registry;
the chart-spec contract in `python/app/charts.py` is out of scope here. Existing
test gates: `cd server && npm test` (vitest), `cd python && uv run pytest`.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Server typecheck | `cd server && npm run typecheck` | exit 0 |
| Server tests | `cd server && npm test` | all pass |
| Web typecheck/build | `cd web && npm run typecheck` | exit 0 |
| Python tests | `cd python && uv run pytest` | all pass |
| Live register probe | `curl -s -X POST localhost:8000/datasets/register -H 'Content-Type: application/json' -d '{…}'` | JSON meta, or the documented HTTPException |

## Preflight (operational, do first)

The dev python service on :8000 was last started 2026-08-22 19:56 — **before**
commits `d16a44c` (20:00) and `9055f82` (22:39). It does not have the current
code, and Step 5 cannot be verified against it. Restart it per AGENTS.md:

```bash
cd python && env DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib .venv/bin/uvicorn app.main:app --port 8000
```

Then restart the Node server so `restoreDatasets()` re-registers ready tabular
sources in the fresh python process. Do not modify code before this is done.

## Scope

**In scope**:
- `server/src/routes.ts` (upload naming; new reingest route)
- `server/src/ingest.ts` (name sanitizer helper; error persistence)
- `server/src/agent.ts` (`cleanFinal` think-tag stripping; emit reasoning events)
- `server/src/llm.ts` (stream splitter for `<think>`)
- `web/src/lib/api.ts` (reingest client)
- `web/src/pages/ChatView.tsx` (duplicate placeholder; reasoning accumulation)
- `web/src/components/ChatMessage.tsx` (collapsible thought-process rendering)
- `web/src/pages/SourcesView.tsx` (pending count; retry button; error detail)
- `python/app/datasets.py` (CSV locale options for `;`-delimited files)
- `server/src/tests/*.test.ts`, `python/tests/test_datasets.py` (tests)
- `plans/README.md` (status row)

**Out of scope (do NOT touch)**:
- `python/app/charts.py` — chart spec contract unaffected.
- The agent loop structure in `server/src/agent.ts` (MAX_ITERATIONS, tool rounds)
  — only `cleanFinal` and the event types change.
- Schema in `server/src/db.ts` — `sources.meta jsonb` already stores arbitrary
  error detail; no migration needed.
- LiteLLM config / LM Studio settings — reasoning handling must work regardless
  of whether the serving stack separates `reasoning_content`.

## Git workflow

- Branch: `advisor/014-ingest-name-and-chat-ux`
- Commits (one per step, in order):
  1. `fix: sanitize dataset table names to satisfy the python registry contract`
  2. `feat: persist ingest errors and add POST /api/sources/:id/reingest`
  3. `fix: strip <think> blocks from streams and persisted answers, surface reasoning separately`
  4. `fix: remove duplicate thinking placeholder in ChatView`
  5. `fix: parse semicolon-delimited European CSVs with correct dates/decimals`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Make upload names satisfy the registry contract

Extract a pure, exported helper in `server/src/ingest.ts`:

```ts
/** Turn an uploaded filename into a table name python's TABLE_RE accepts:
 *  lowercase letters/digits/underscores, starts with a letter, ≤63 chars
 *  including room for a `_N` dedup suffix. */
export function sanitizeDatasetName(filename: string): string {
  let base = path.basename(filename, path.extname(filename))
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (base && !/^[a-z]/.test(base)) base = `d_${base}`; // python requires ^[a-z]
  return base.slice(0, 60) || "dataset";
}
```

Use it in `server/src/routes.ts` (replace the inline `base` derivation at line
118; keep the existing dedup loop appending `_1`, `_2` — 60 chars leaves room
for `_999`). The rule lives server-side; python keeps its strict validator as
the contract boundary (do not relax `TABLE_RE`).

**Verify**: `cd server && npm run typecheck` → exit 0. Add vitest cases to
`server/src/tests/ingest.test.ts`: `"22-08-2026_Umsatzliste_Girokonto_DE33120300001054151210.csv"`
→ starts with a letter, matches `/^[a-z][a-z0-9_]{0,62}$/`; a 200-char filename
→ ≤63 chars; `"___"`/empty-ish → `"dataset"`; `"Budget 2026.xlsx"` →
`budget_2026` (letter start preserved, no prefix added). Run `npm test` → green.

### Step 2: Persist ingest errors and make them recoverable

1. In `server/src/ingest.ts` catch block, store the reason before rethrowing:

```ts
  } catch (e) {
    console.error("ingest failed", e);
    const detail = String(e?.message ?? e).slice(0, 500);
    await q(`UPDATE sources SET status='error', meta = meta || jsonb_build_object('error', $2::text) WHERE id=$1`, [sourceId, detail]);
    throw e;
  }
```

2. Add `POST /api/sources/:id/reingest` in `server/src/routes.ts`
   (`preHandler: requireAuth`): SELECT the source by id **and account_id**, 404
   otherwise; require `file_path` (400 for URL connectors without one); set
   `status='index'` (clear `meta.error`) and invoke `ingestSource` exactly the
   way the upload route does (same awaited/fire-and-forget choice as the upload
   route — read it first and mirror it).

3. Frontend: add `sourcesApi.reingest(id)` to `web/src/lib/api.ts`; in
   `SourcesView.tsx` change the pending count to count only
   `status === 'index'` (errored is not "processing"), and on errored rows show
   a Retry button that calls reingest then refreshes, plus the stored
   `meta.error` string as secondary text (truncate to one line + title attr).

**Verify**: `cd server && npm run typecheck && npm test`, `cd web &&
npm run typecheck`. Live: `curl -X POST localhost:3000/api/sources/<errored-id>/reingest`
with a bearer token → source flips to `ready` (after Step 1, the Umsatzliste CSV
registers cleanly); `sources.meta->>'error'` is gone on success.

### Step 3: Handle `<think>` blocks end-to-end

1. **Persistence/display of stored messages** — extend `cleanFinal` in
   `server/src/agent.ts` to remove paired and unterminated think tags anywhere:

```ts
  t = t.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<think>[\s\S]*$/i, "").trim();
```

   Place the strip BEFORE the existing prose-prefix logic so a message that is
   only a think block collapses to "" gracefully. Extend
   `server/src/tests/cleanFinal.test.ts`: paired tag mid-text, tag-only input,
   unterminated trailing tag, and "no tags" passthrough must all hold.

2. **Live stream** — in `server/src/llm.ts` implement a small stateful splitter
   so reasoning never reaches the UI as content:

```ts
export function createThinkSplitter(onDelta: (t: string) => void, onReasoning?: (t: string) => void) { … }
```

   Semantics: buffer incoming chunks; while outside `<think>`, emit content but
   hold back a trailing partial `<`-prefix (max 7 chars) until it resolves;
   inside `<think>`, route text to `onReasoning` until `</think>`, which may
   split across chunks. Wire it into `streamingChat`'s delta loop (llm.ts:56-63)
   with an optional `onReasoning` option; default behaviour without the option
   drops think content entirely (safe for other callers).

3. **Event plumbing** — add `| { type: "reasoning"; text: string }` to
   `AgentEvent` in `server/src/agent.ts` and emit from the streaming call.
   In `ChatView.tsx` accumulate `reasoning` on StreamState; reset it per send.
   Pass it to `ChatMessage` and render a collapsed-by-default `<details>`
   ("Thought process") above the markdown when non-empty. Persisted messages
   stay cleaned-only (Step 3.1 guarantees history is tag-free).

**Verify**: `cd server && npm run typecheck && npm test` (splitter gets its own
vitest file with chunk-boundary cases: `["<thi","nk>hidden </thin","k>visible"]`,
`["no tags"]`, `[\"<think>only\"]`). Manual E2E in Step 6 confirms the visual.

### Step 4: Delete the duplicate thinking placeholder

In `web/src/pages/ChatView.tsx` delete lines 252-263 (the second
`!stream.text && !stream.steps.length && stream.error === null` block). The
else-branch at 235-244 is the single placeholder; `ChatMessage`'s internal dots
(ChatMessage.tsx:85-95) already cover the steps-running-but-no-text-yet case.

**Verify**: `cd web && npm run typecheck` → exit 0; `grep -c "thinking…" web/src/pages/ChatView.tsx`
→ exactly 1.

### Step 5: Parse European CSVs correctly

In `python/app/datasets.py`, extend `_read_sql(path)` for `.csv` inputs: peek
at the first ~4KB; if the header/data clearly uses `;` delimiters AND date-like
fields match `\d{2}\.\d{2}\.\d{2,4}`, emit
`read_csv_auto(?, delim=';', dateformat='%d.%m.%y', decimal_separator=',')`
instead of bare `read_csv_auto(?)`. Keep the sniffing conservative — ISO-style
samples (`data/sample/*.csv`) must take the existing path unchanged. Extract the
decision into a pure function so pytest can cover it without DuckDB.

Add a pytest fixture in `python/tests/test_datasets.py` containing a small
Sparkasse-style excerpt (BOM optional, `;` separators, preamble metadata rows,
`DD.MM.YY` dates, `-1.234,56` amounts) asserting: registration succeeds, the
date column is DATE with the correct century, and the amount column casts to
DECIMAL.

**Verify**: `cd python && uv run pytest` → all pass, including pre-existing
tests. Live probe: re-register the real Umsatzliste file under a letter-leading
probe name, confirm preview shows 2026 dates and numeric `Betrag`, then DELETE
the probe dataset.

### Step 6: End-to-end verification (the incident replay)

With the full stack up (AGENTS.md), logged in as the affected user:

1. Re-upload `22-08-2026_Umsatzliste_Girokonto_DE33120300001054151210.csv`
   (or hit the new reingest endpoint on the errored source) → Sources page
   shows `ready`, no "still processing" banner.
2. Ask: "What are my biggest monthly expenses? Show a chart"
3. Confirm: exactly ONE thinking placeholder before the first event; tool feed
   shows `query_data` succeeding with real 2026 dates and aggregable amounts;
   a chart renders; the answer contains no `<think>` markup; reloading the chat
   still shows clean history.

Static gates: `cd server && npm run typecheck && npm test`; `cd web && npm run
typecheck`; `cd python && uv run pytest`.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `sanitizeDatasetName("22-08-2026_Umsatzliste….csv")` output matches `^[a-z][a-z0-9_]{0,62}$` (vitest)
- [ ] `cd server && npm run typecheck` and `npm test` exit 0
- [ ] `cd web && npm run typecheck` exits 0
- [ ] `grep -c "thinking…" web/src/pages/ChatView.tsx` → 1
- [ ] `cleanFinal("<think>x</think>A") === "A"` (vitest)
- [ ] `curl -X POST /api/sources/:id/reingest` returns 200 and flips an errored source to `ready` (live)
- [ ] `cd python && uv run pytest` passes incl. the new German-CSV fixture
- [ ] Step 6 E2E replay observed working
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Any "Current state" excerpt doesn't match live code (drift).
- You cannot restart the python service (it's operator-owned) — Steps 5-6 can't
  be verified; report instead of skipping verification silently.
- Extending `AgentEvent` breaks another consumer of the SSE stream (search for
  consumers besides `web/src/lib/api.ts` `streamAgentChat`).
- The think splitter grows beyond a simple buffer/state machine (e.g. models
  emitting nested or unclosed tags interleaved with tool calls) — describe what
  the model actually emitted.
- Step 5's sniff heuristic would change behaviour for any existing passing
  fixture/sample (`data/sample/*.csv`, world_gdp connector) — report the
  conflicting case rather than widening the heuristic.
- Existing sources rows already exceed the 63-char name limit (would collide
  with the new truncation on dedup) — check
  `SELECT name FROM sources WHERE length(name) > 63;` first.

## Maintenance notes

- The name contract now has one producer (`sanitizeDatasetName`) and one
  enforcer (python `TABLE_RE`). If python ever widens the regex, keep the
  sanitizer strict anyway — quoted identifiers with leading digits are legal
  DuckDB but the stricter form keeps SQL generated by the model simpler.
- Reasoning events are ephemeral (not persisted). If transcripts later need to
  include reasoning, that's a schema decision, not a streaming patch.
- The CSV sniff heuristic is deliberately narrow. A general "csv options"
  parameter on `/datasets/register` is the scalable escape hatch if more exotic
  exports appear; don't grow the heuristic past delimiter+locale detection.

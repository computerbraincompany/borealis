# Plan 015: Stop silently dropping data in the agent pipeline (chart ids, chunk tails, figure leaks, stream merges)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 567481d..HEAD -- server/src/tools.ts server/src/ingest.ts server/src/llm.ts server/src/agent.ts python/app/charts.py server/src/tests/ python/tests/test_charts.py`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition. **Note:** this plan assumes
> plan 014 has landed (it edits `cleanFinal` and `llm.ts`). If 014 is NOT done,
> stop and report instead of guessing at merged state.

## Status

- **Priority**: P1
- **Effort**: M (five small fixes, each independently verifiable)
- **Risk**: LOW–MED (Step 2 changes an existing test's expectation deliberately; Step 4 touches streaming)
- **Depends on**: plans/014-fix-ingest-name-and-chat-stream-ux.md (edits the same `cleanFinal` / `llm.ts` regions)
- **Category**: bug
- **Planned at**: commit `567481d`, 2026-08-23

## Why this matters

Five independent defects all share one signature: the system loses data
silently while every gate stays green.

1. The documented mitigation for garbled chart UUIDs (12-char prefix match,
   `AGENTS.md` "the model sometimes garbles long chart uuids") is unreachable —
   a strict regex filters out exactly the garbled ids it was built for, so
   reports ship with missing charts and no error anywhere.
2. ~15% of document lengths produce a final RAG chunk that duplicates the
   previous chunk's tail (worst case 1 char), wasting embeddings and crowding
   real passages out of `retrieve` top_k. The existing unit test enshrines the bug.
3. A matplotlib figure (~9.5×5.2in @140dpi, several MB) leaks every time
   `render_png` raises mid-render, growing the long-lived uvicorn process.
4. The streaming tool-call merger creates sparse arrays (a hole crashes the
   agent mid-answer) and concatenates repeated full function names into
   `"render_chartrender_chart"` with some OpenAI-compatible upstreams.
5. When a Qwen-style answer starts with a `Thinking:`-style line but has NO
   blank line after it, `cleanFinal` deletes the ENTIRE answer; the empty
   string is persisted as the assistant message.

## Current state

Files and their roles:

- `server/src/tools.ts` — `makeReportPayload` resolves chart ids for create_report.
- `server/src/ingest.ts` — `chunkText` splits documents into overlapping RAG chunks.
- `python/app/charts.py` — canonical chart spec → matplotlib PNG + ECharts option.
- `server/src/llm.ts` — `streamingChat` merges streamed tool_call deltas by index.
- `server/src/agent.ts` — `cleanFinal` strips model reasoning prefixes from final answers.

Current exact code:

`server/src/tools.ts:244-259` — strict filter runs BEFORE the fuzzy lookup,
so truncated/garbled ids never reach it:
```ts
  const ids = (args.charts || []).filter((s: any) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s)));
  // resolve inline chart ids from this conversation (spec lookup)
  for (const cid of ids) {
    try {
      const [row] = await q(`SELECT spec FROM charts WHERE id=$1 AND account_id=$2`, [cid, accountId]);
      if (row) charts.push({ id: cid, spec: row.spec });
      else {
        // model sometimes garbles/excerpts a long uuid — match by 12-char prefix
        const [fuzzy] = await q(
          `SELECT spec FROM charts WHERE account_id=$1 AND left(id::text,12)=left($2::text,12) ORDER BY created_at DESC LIMIT 1`,
          [accountId, cid]
        );
        if (fuzzy) charts.push({ id: cid, spec: fuzzy.spec });
      }
    } catch {}
  }
```

`server/src/ingest.ts:17-25` — no tail-duplicate guard:
```ts
export function chunkText(text: string, size = 900, overlap = 120): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const chunks: string[] = [];
  for (let i = 0; i < clean.length; i += size - overlap) {
    chunks.push(clean.slice(i, i + size));
  }
  return chunks;
}
```
The existing test `server/src/tests/ingest.test.ts` (case around lines 27-35)
asserts 3 chunks for a 35-char input at size 20 / overlap 5, where `out[2]`
equals `out[1].slice(-5)` — it locks in the duplicate.

`python/app/charts.py:163-167` (figure created) and `197`/`223` (closed ONLY
on success); raising points between: `float(it["value"])` at line 177 (pie
items) and `float(v)` at line 202 (series values like `"abc"`):
```python
def render_png(spec: dict[str, Any], width: int = 9.5, height: int = 5.2) -> bytes:
    spec = normalize(spec)
    ctype = spec["type"]
    fig, ax = plt.subplots(figsize=(width, height), dpi=140)
    ...
```
By contrast `echarts_option` tolerates bad series values via try/except
(lines 136-141) but its PIE branch calls `float(it["value"])` unguarded
(line 113) — validation is asymmetric between renderers.

`server/src/llm.ts:61-68` — sparse-index and name-concat hazards:
```ts
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        if (!toolCalls[idx]) toolCalls[idx] = { id: tc.id, type: tc.type || "function", function: { name: "", arguments: "" } };
        if (tc.id) toolCalls[idx].id = tc.id;
        if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
        if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
      }
```
A stream using non-contiguous indices leaves `toolCalls[1]` undefined; the
consumer `runToolRound` reads `tc.function.name` unguarded
(`server/src/agent.ts`, in `runToolRound`) → TypeError mid-answer.

`server/src/agent.ts` inside `cleanFinal` (lines ~24-26 at cf9c3c3; may have
shifted if plan 014 added think-tag stripping above it):
```ts
    const nl = t.search(/\n\s*\n/);
    t = nl >= 0 ? t.slice(nl) : "";
```

Conventions: server is ESM — local imports need the `.js` extension. Python
service: FastAPI + matplotlib Agg backend. Test gates: `cd server && npm test`,
`cd python && uv run pytest`. Exemplar vitest file:
`server/src/tests/cleanFinal.test.ts`; exemplar pytest:
`python/tests/test_charts.py`.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Server typecheck | `cd server && npm run typecheck` | exit 0 |
| Server tests | `cd server && npm test` | all pass |
| Python tests | `cd python && uv run pytest` | all pass |

## Scope

**In scope**:
- `server/src/tools.ts` (chart-id resolution only)
- `server/src/ingest.ts` (`chunkText` only)
- `python/app/charts.py` (`render_png`/`echarts_option` value handling + figure lifecycle)
- `server/src/llm.ts` (tool_call merge only)
- `server/src/agent.ts` (`cleanFinal` fallback branch only)
- `server/src/tests/*.test.ts`, `python/tests/test_charts.py` (tests)
- `plans/README.md` (status row)

**Out of scope (do NOT touch)**:
- The agent loop structure (`MAX_ITERATIONS`, `runToolRound` control flow).
- The chart-spec schema/docstring contract (fields, palette injection) — a
  separate reconciliation effort; do not add/remove spec fields here.
- `chunkText`'s size/overlap defaults or callers.
- Anything in plan 014's scope (SourcesView, routes.ts upload naming).

## Git workflow

- Branch: `advisor/015-agent-data-integrity`
- Commits, one per step, conventional style matching `git log` (e.g.
  `fix: resolve garbled chart ids via dash-insensitive prefix match`).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Make garbled chart ids resolvable and give the model feedback

In `makeReportPayload` (`server/src/tools.ts`), replace the strict-regex
filter + lookup loop with: iterate over ALL requested ids as strings; for
each, try exact id first; then normalize to hex (strip non-hex, lowercase)
and prefix-match on the DASH-STRIPPED id (comparing `left(id::text,12)`
against a hex string fails at the first `-`); collect unresolved ids instead
of swallowing errors. Target shape:

```ts
  const requested: string[] = (args.charts || []).map((s: any) => String(s));
  const unresolved: string[] = [];
  for (const raw of requested) {
    try {
      const [row] = await q(`SELECT spec FROM charts WHERE id=$1 AND account_id=$2`, [raw, accountId]);
      if (row) { charts.push({ id: raw, spec: row.spec }); continue; }
      const hex = raw.replace(/[^0-9a-f]/gi, "").toLowerCase();
      if (hex.length >= 12) {
        const [fuzzy] = await q(
          `SELECT spec FROM charts WHERE account_id=$1 AND left(replace(id::text,'-',''),12)=left($2::text,12) ORDER BY created_at DESC LIMIT 1`,
          [accountId, hex]
        );
        if (fuzzy) { charts.push({ id: hex, spec: fuzzy.spec }); continue; }
      }
      unresolved.push(raw);
    } catch { unresolved.push(raw); }
  }
```

Include the feedback in the returned payload object: add
`unresolved_chart_ids: unresolved` (omit when empty). In `executeTool`'s
`create_report` case, surface it in the tool result when present so the model
can re-emit correct ids next round.

**Verify**: `cd server && npm run typecheck` → exit 0.

### Step 2: Stop emitting duplicate tail chunks

In `chunkText`, break once the window reaches the end:

```ts
  for (let i = 0; i < clean.length; i += size - overlap) {
    chunks.push(clean.slice(i, i + size));
    if (i + size >= clean.length) break;
  }
```

Update the existing enshrined expectation in `server/src/tests/ingest.test.ts`:
for the 35-char / size 20 / overlap 5 case the correct result is now TWO
chunks (`slice(0,20)`, `slice(15,35)`); assert `out.length === 2` and that no
chunk equals a pure suffix of its predecessor. Add a case where
`len % (size - overlap)` lands inside the overlap window (e.g. 41 chars) —
still no pure-duplicate final chunk.

**Verify**: `cd server && npm test` → all pass including the rewritten case.

### Step 3: Fix the figure leak and unify numeric coercion (charts.py)

1. Add one helper near `normalize`:

```python
def _num(v: Any) -> float | None:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None
```

2. Wrap `render_png`'s body after `fig, ax = plt.subplots(...)` in
   `try: ... finally: plt.close(fig)` (both return paths collapse into the
   try block; remove the two success-path `plt.close(fig)` calls).
3. Route ALL value coercion through `_num`: pie items in BOTH renderers
   (`render_png` line ~177 and `echarts_option` line ~113 — the latter
   currently raises on garbage) become `_num(...) or 0.0`; cartesian series
   in `echarts_option` keeps `None` for gaps (already tolerant — switch its
   inline try/except to `_num`); `render_png`'s series loop maps
   `None → 0.0`. Behavior change: a spec with a bad pie value now renders
   (zero-weight slice) instead of raising in one renderer and not the other.

**Verify**: `cd python && uv run pytest` → pass, including new tests below.

### Step 4: Harden the streaming tool-call merge

In `streamingChat` (`server/src/llm.ts`):

```ts
        if (tc.function?.name) {
          const cur = toolCalls[idx].function.name;
          if (!cur) toolCalls[idx].function.name = tc.function.name;
          else if (!cur.includes(tc.function.name)) toolCalls[idx].function.name += tc.function.name;
        }
```

and after the stream loop, before assigning to `merged`:

```ts
  if (toolCalls.length) merged.choices[0].message.tool_calls = toolCalls.filter(Boolean);
```

(The `includes` check makes a repeated full name idempotent while still
concatenating genuine partial-name fragments.)

**Verify**: `cd server && npm run typecheck && npm test` → exit 0.

### Step 5: Don't delete the whole answer when the Thinking block has no blank line

In `cleanFinal` (`server/src/agent.ts`), locate (post-014) the line pair:

```ts
    const nl = t.search(/\n\s*\n/);
    t = nl >= 0 ? t.slice(nl) : "";
```

Change the fallback to drop only the labeled FIRST line:

```ts
    t = nl >= 0 ? t.slice(nl) : t.replace(/^[^\n]*\n?/, "");
```

**Verify**: `cd server && npm test` → green incl. new cases below.

## Test plan

- `server/src/tests/tools.test.ts` (new): mock `./db.js`'s `q` with `vi.mock`
  following the structure of `cleanFinal.test.ts`. Cases: well-formed id
  found exact; dash-less 32-hex id resolved via prefix (assert SQL received
  the hex); short garbage (<12 hex) → unresolved list; db throw → unresolved,
  no exception; payload contains `unresolved_chart_ids` only when non-empty.
- `server/src/tests/ingest.test.ts`: rewrite the tail case (Step 2) + add
  41-char case.
- `server/src/tests/cleanFinal.test.ts`: add `"Thinking: line\nanswer continues"` →
  keeps `answer continues`; blank-line variant unchanged.
- `python/tests/test_charts.py`: after calling `render_png` with a bad item
  value (`{"type":"pie","items":[{"name":"x","value":"abc"}]}`), assert it
  RAISES nothing and `plt.get_fignums() == []`; same for `echarts_option`
  with a bad pie value (returns option, no raise).

Verification: `cd server && npm test && cd ../python && uv run pytest` → all
pass, ≥6 new assertions across the suites.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] No `/^[0-9a-f]{8}-[0-9a-f]{4}/` pre-filter remains in `tools.ts` (`grep -n "0-9a-f]{8}" server/src/tools.ts` → no match)
- [ ] `grep -n "replace(id::text,'-','')" server/src/tools.ts` → 1 match
- [ ] `cd server && npm run typecheck && npm test` exit 0 (incl. new tools/ingest/cleanFinal tests)
- [ ] `cd python && uv run pytest` exit 0 (incl. figure-leak + bad-pie-value tests)
- [ ] `grep -c "plt.close(fig)" python/app/charts.py` → 1 (single finally)
- [ ] `cleanFinal("Thinking: x\nanswer") === "answer"` (vitest)
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Plan 014 is not yet implemented (its edits overlap `cleanFinal`/`llm.ts`;
  merging blind risks clobbering the `<think>` splitter).
- Any "Current state" excerpt doesn't match live code beyond line-number drift.
- The dash-stripped prefix query would match multiple different charts within
  an account in existing DB rows (`SELECT left(replace(id::text,'-',''),12), count(*) FROM charts GROUP BY 1 HAVING count(*) > 1;` returns rows) — report the collision counts.
- Removing the strict filter lets non-chart junk reach SQL in practice during
  your tests — describe the actual payload instead of adding new heuristics.

## Maintenance notes

- The `includes` name heuristic breaks if an upstream streams a name in
  fragments where one fragment is a substring of the running total in a
  misleading way — unlikely; revisit only on observed mangled names.
- `retrieve` quality will shift slightly (fewer duplicate chunks). If retrieval
  evals exist later, re-run them after this lands.
- Chart-id resolution stays scoped to the account; a future "charts library"
  spanning chats must widen the query deliberately, not accidentally.

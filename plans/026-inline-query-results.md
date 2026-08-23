# Plan 026: Keep query results as inspectable chat tables with CSV export

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on.
> Honor STOP conditions. Update `plans/README.md` when done unless the reviewer
> maintains the index.
>
> **Drift check (run first)**:
> `git diff --stat 67cc7db..HEAD -- server/src/tools.ts server/src/agent.ts server/src/tests/tools.test.ts server/src/tests/agentModel.test.ts web/src/lib/api.ts web/src/pages/ChatView.tsx web/src/components/ChatMessage.tsx web/src/components/DataResultCard.tsx web/src/lib/csv.ts plans/README.md`
> Plans 024-025 intentionally change several of these files. Confirm their
> final source-upload and retrieved-evidence contracts are present. Any other
> unexplained mismatch is a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW-MED (unbounded tool output would bloat every chat-detail read)
- **Depends on**: `plans/025-show-retrieved-evidence.md`
- **Category**: direction / data ux
- **Planned at**: commit `67cc7db`, 2026-08-23

## Why this matters

North's Data Interpreter exposes tabular outputs and downloadable generated
files, while Borealis collapses every `query_data` tool result in the visible
tool feed to only “N rows.” The structured columns and rows already exist, but
they are discarded after the model writes prose. This plan preserves a bounded,
immutable snapshot of successful query results in the answer so users can
inspect the numbers behind a conclusion and export the shown rows as CSV.

Official behavior references:

- <https://private.docs.cohere.com/docs/get-started/tools/data-interpreter/home>
  documents full spreadsheet reasoning, inline visual output, and downloadable
  generated files.
- <https://private.docs.cohere.com/docs/get-started/using-citations> documents
  inspectable monospace/tabular tool outputs in the response side panel.

## Current state

- `server/src/pythonClient.ts:60-65` receives
  `{ columns, rows, row_count }` from scoped DuckDB queries.
- `server/src/tools.ts:198-200` immediately returns that object to the transient
  agent loop without recording it.
- `server/src/agent.ts:220-225` emits the result in a tool event and copies a
  maximum 12,000-character JSON representation into the in-memory model prompt.
- `server/src/agent.ts:153-164` does not persist query output.
- `web/src/pages/ChatView.tsx:877-886` summarizes any result with a `rows` array
  as `${rows.length} rows`.
- `web/src/components/ChatMessage.tsx` has no structured data artifact.

Conventions to preserve:

- Query execution and source scope remain server-authoritative and unchanged.
- Message metadata must be small and backward compatible.
- Charts/reports/evidence from earlier plans retain their existing order and
  behavior.
- CSV is generated only from the already-authorized stored snapshot; download
  must not re-run SQL or accept SQL from the browser.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Server gates | `cd server && npm run typecheck && npm test && npm run build` | exit 0; all tests pass |
| Web gates | `cd web && npm run typecheck && npm run build` | exit 0; existing chunk warning allowed |
| Full gate | `./scripts/verify.sh` | all gates green |

## Scope

**In scope**:

- `server/src/tools.ts`
- `server/src/agent.ts`
- `server/src/tests/tools.test.ts`
- `server/src/tests/agentModel.test.ts`
- `web/src/lib/api.ts`
- `web/src/pages/ChatView.tsx`
- `web/src/components/ChatMessage.tsx`
- `web/src/components/DataResultCard.tsx` (create)
- `web/src/lib/csv.ts` (create if useful)
- `plans/README.md`

**Out of scope**:

- Re-running saved SQL, editable tables, pivoting, sorting/filtering servers,
  spreadsheet formulas, XLSX generation, or a Python/code sandbox.
- Full cell-level source lineage or calling these results citations.
- Persisting more than bounded preview rows, changing DuckDB's 500-row limit,
  or returning the total count of an unbounded underlying query.
- A new download endpoint; CSV is built client-side from owned chat metadata.

## Git workflow

- Branch: `codex/026-inline-query-results`
- Conventional commit example: `feat: preserve query tables in chat`
- Do not push independently; the primary reviewer will integrate and push.

## Steps

### Step 1: Sanitize successful query results into bounded artifacts

Add `queryResults` to `ToolRunContext` and export a pure capture/sanitizer from
`tools.ts`. A successful `query_data` call records one artifact after the
Python response returns; failures record none. Store at most 3 artifacts per
turn with this shape:

```ts
interface QueryResultArtifact {
  id: string;          // deterministic within the answer, e.g. query-1
  sql: string;         // maximum 2,000 characters
  columns: string[];   // maximum 50, each maximum 200 characters
  rows: unknown[][];   // maximum 100 rows, aligned to stored columns
  row_count: number;   // rows returned by the bounded Python query
  truncated: boolean;  // true when any rows/columns/cells were omitted
}
```

Cell rules:

- Preserve `null`, finite number, boolean, and string.
- Convert dates/objects/arrays to bounded JSON/string text.
- Replace non-finite numbers with `null`.
- Limit string cells to 500 characters and mark the artifact truncated.
- Rectangularize rows to the stored column count; omit malformed non-array rows.

The full Python result still returns to the model/tool feed. The artifact is a
separate display snapshot. Never include allowed table names beyond what is
already visible in the SQL or add file paths/config.

**Verify**: `tools.test.ts` covers happy path, three-artifact cap, row/column/
cell bounds, malformed rows, non-finite values, and no capture on error.

### Step 2: Persist and stream query artifacts

Add `query_results: context.queryResults` to both final-answer metadata sites
in `agent.ts`, alongside evidence, charts, report, model, and source snapshot.
Persist and emit the exact same object. Empty is `[]`.

Extend agent tests to assert historical DB metadata and final SSE metadata are
identical and that prior evidence fields remain present.

**Verify**: server typecheck/tests/build pass.

### Step 3: Render a reusable table artifact

Add the matching type to `web/src/lib/api.ts`. Extend `ChatView` stream state
with `finalQueryResults`; populate it from final SSE metadata, include it in
the retained-stream activity predicate, and pass historical/stream values into
`ChatMessage`.

Create `DataResultCard.tsx`:

- Show a compact title (`Query result 1`), returned/stored row counts, and a
  clear `preview truncated` label when applicable.
- Render a semantic HTML table in a horizontally scrollable, height-bounded
  region. Headers remain visible; null values have an accessible visual token.
- Show the saved SQL in a collapsed `<details>` block as plain text.
- Provide `Download CSV` for the stored rows.
- Multiple artifacts render in tool order below the prose/evidence and before
  charts/reports.
- Empty/malformed legacy metadata is ignored without breaking the message.

**Verify**: web typecheck/build and Light/Dark browser inspection with narrow
viewport, long values, nulls, and multiple artifacts.

### Step 4: Make CSV export safe and deterministic

Implement a small pure CSV serializer (in `web/src/lib/csv.ts` if separation
helps):

- Header then stored rows, RFC-style double-quote escaping, CRLF rows.
- Preserve numbers/booleans/null as display values.
- For string cells whose first non-whitespace character is `=`, `+`, `-`, or
  `@`, prefix an apostrophe to prevent spreadsheet formula execution. Do not
  alter numeric negative values.
- Include a UTF-8 BOM for common spreadsheet compatibility.
- Create/revoke one Blob URL and use a safe filename such as
  `borealis-query-1.csv`.

The download must contain exactly the rows shown/stored and must not make an
API call.

**Verify**: manually export commas, quotes, newlines, Unicode, null, negative
number, and formula-looking string cases; inspect the resulting CSV text.

## Test plan

- `tools.test.ts`: all server-side bounds and malformed result behavior.
- Agent test: persisted/SSE contract including earlier evidence fields.
- Browser: historical reload, streamed result, multiple tables, truncated
  badge, SQL disclosure, safe CSV, narrow layout, Light/Dark.

## Done criteria

- [ ] Successful queries create at most three bounded artifacts per answer.
- [ ] Query artifacts survive reload and failed final detail refresh.
- [ ] Users can inspect the stored rows and SQL without opening tool internals.
- [ ] CSV downloads only the authorized stored snapshot and mitigates formula
      injection.
- [ ] Existing evidence/charts/reports/model/source metadata remains intact.
- [ ] Server/web/full verification gates pass.

## STOP conditions

Stop and report if:

- The feature requires re-running SQL from the browser.
- The metadata cannot be bounded under the stated caps.
- The serializer would need a new spreadsheet dependency.
- Verification fails twice after a reasonable correction.

## Maintenance notes

- If full 500-row exports are later required, store a separate owned artifact
  and download it through an authenticated route rather than inflating every
  chat-detail response.
- Keep query result metadata additive; never reinterpret old messages.

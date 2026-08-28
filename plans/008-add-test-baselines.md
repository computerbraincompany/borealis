# Plan 008: Add test baselines — pytest for the Python service, vitest for server pure functions

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
> **Drift check (run first)**: `git diff --stat d16a44c..HEAD -- python/ server/`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `d16a44c`, 2026-08-22

## Why this matters

Borealis has zero automated tests across all three services. The DuckDB SQL
validator (`python/app/datasets.py`), the report HTML builder and its escapism
(`python/app/reports.py`), the chart spec contract (`python/app/charts.py`), and
the server's chunking + answer-cleanup (`server/src/ingest.ts`, `server/src/agent.ts`)
are the highest-value untested code: they sit between LLM-generated input and
either the SQL interpreter or a standalone HTML file. This plan adds the first
test baselines — pure-function unit tests that need no Postgres, no LLM, and no
network — so future changes to these modules have a machine-checkable gate. It is
the verification baseline the repo has been missing; it deliberately does NOT
attempt integration tests (routes + Postgres) or agent-loop tests (needs an LLM
seam refactor) — those are follow-ups.

## Current state

Files and their roles:

- `python/app/datasets.py` — DuckDB registry + SQL validator (`query()`, lines
  136-157) and result-normalization; `register()`; `describe()`.
- `python/app/charts.py` — canonical chart spec: `normalize()` (70-95),
  `echarts_option()` (101-157), `render_png_base64()` (227-228).
- `python/app/reports.py` — `_clean_markdown` + `_render_markdown` (41-68),
  `_render_tables` (71-86), `build_html` (101-202).
- `server/src/ingest.ts` — `chunkText()` (17-25), `mimeKind`-like dispatch via
  `extractText()` (55-64).
- `server/src/agent.ts` — `cleanFinal()` (18-35).
- `python/pyproject.toml` — Python deps; has NO dev-dependencies and no pytest.
- `server/package.json` — scripts: `dev`, `start`, `build`, `typecheck`; no test.
  Deps include `typescript`, `tsx`; devDeps: `@types/*`.

Current exact code you will test (excerpts):

`server/src/ingest.ts:17-25` (chunking — go/no-go for retrieval quality):
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

`server/src/agent.ts:18-35` (strips model "Thinking"/"Final Answer" prefixes):
```ts
function cleanFinal(text: string): string {
  let t = text.trim();
  const first = t.split("\n")[0] || "";
  if (/^\s*(Thinking Process|Thinking|Thought Process|Thought|Reasoning)[:\-]?\s*/i.test(first)) {
    const nl = t.search(/\n\s*\n/);
    t = nl >= 0 ? t.slice(nl) : "";
  }
  let prev: string;
  do {
    prev = t;
    const fa = t.match(/^\s*(Final Answer|Answer)[:\-]\s*/i);
    if (fa) t = t.slice(fa[0].length);
  } while (t !== prev);
  return t.trim();
}
```
Note: `cleanFinal` is NOT exported. The plan changes it to `export function
cleanFinal` (pure change, no behavior change).

`python/app/datasets.py:139-144` (SQL validator contract):
```python
    if not re.match(r"^(SELECT|WITH|VALUES|PRAGMA)\b", sql, re.IGNORECASE):
        raise HTTPException(400, "only SELECT/WITH queries are allowed")
    if re.search(r"(;\s*|\b)(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|ATTACH|COPY|CALL|INSTALL|LOAD)\b", sql, re.IGNORECASE):
        raise HTTPException(400, "DDL and mutation statements are not allowed")
```

`python/app/reports.py:67-68` and `71-86` (markdown + table rendering):
```python
def _render_section_markdown(md: str) -> str:
    return _render_markdown(_clean_markdown(md))
```
```python
def _render_tables(tables: list[dict[str, Any]]) -> str:
    out = []
    for t in tables:
        cols = t.get("columns", [])
        rows = t.get("rows", [])
        if not cols or not rows or len(cols) != len(rows[0]):
            continue
        head = "".join(f"<th>{html.escape(c)}</th>" for c in cols)
        body = ""
        for row in rows[:60]:
            body += "<tr>" + "".join(f"<td>{html.escape(str(v)) if v is not None else ''}</td>" for v in row) + "</tr>"
        out.append(
            f'<div class="data-table"><table><thead><tr>{head}</tr></thead><tbody>{body}</tbody>'
            f"<tfoot><tr><td colspan='{len(cols)}'>{len(t['rows'])} rows</td></tr></tfoot></table></div>"
        )
    return "".join(out)
```

Conventions to follow:

- Python: the service uses FastAPI + pydantic, `from __future__ import annotations`,
  type hints everywhere. Test files go in `python/tests/` as `test_*.py`; import
  modules as `from app import charts`, `from app import reports`, etc.
- `charts.py` and `reports.py` set `matplotlib.use("Agg")` at import; tests must
  not open GUI windows (they won't — Agg is headless).
- Server: ESM TypeScript. Tests use vitest. Server sources import each other with
  `.js` extensions (e.g. `./db.js`) — Vite/vitest resolves `.js` → `.ts` for
  in-project sources; if a test import of a `.js`-suffixed path fails to resolve,
  see the STOP conditions.
- IMPORTANT: `server/src/config.ts` imports `dotenv/config` and throws at import
  time when `JWT_SECRET` is unset or < 32 chars. Vitest must set a long
  `JWT_SECRET` in its `env` option BEFORE any module import, or every test file
  that touches `config.ts` will crash on load.

## Commands you will need

| Purpose   | Command                                         | Expected on success |
|-----------|-------------------------------------------------|---------------------|
| Server test deps | `cd server && npm install --save-dev vitest` (adds vitest to devDependencies) | exit 0 |
| Server tests | `cd server && npm test`                          | all pass, N tests |
| Server typecheck | `cd server && npm run typecheck`                 | exit 0, no errors |
| Python test deps | `cd python && uv add --dev pytest`               | exit 0 |
| Python tests | `cd python && uv run pytest`                     | all pass, N tests |
| Web typecheck (must stay green) | `cd web && npm run typecheck` | exit 0 |

## Scope

**In scope** (only files you may create/modify):
- `server/package.json` (add `test` script + `vitest` devDependency)
- `server/vitest.config.ts` (create)
- `server/src/agent.ts` (only the `export` keyword on `cleanFinal`)
- `server/src/tests/*.test.ts` (create; e.g. `server/src/tests/ingest.test.ts`, `server/src/tests/cleanFinal.test.ts`)
- `python/pyproject.toml` (add pytest dev-dependency via `uv add --dev pytest`)
- `python/tests/*.py` (create: `test_datasets.py`, `test_charts.py`, `test_reports.py`, `test_agent_helpers.py` as needed)
- `plans/README.md` (status row)

**Out of scope** (do NOT touch, even though they look related):
- `server/src/agent.ts` logic changes (no refactor of `runAgent`; no LLM seam —
  that is a separate plan). Only the `export` on `cleanFinal`.
- Any behavior change to the modules under test (this is a characterization
  baseline). If a test fails because of a suspected real bug in the module,
  report it and STOP rather than "fixing" the module.
- No web tests, no integration tests, no test for `server/src/routes.ts`, no
  Postgres-dependent tests.
- Do not convert `python/app` imports or touch `reports.py` `/` `datasets.py` logic.

## Git workflow

- Branch: `advisor/008-test-baselines` (repo convention from prior plans:
  `advisor/*`)
- Commit per logical unit; message style matches the repo history — imperative,
  lowercase-scoped conventional commits, e.g. existing history shows
  `fix: implement advisor plans 001-007 (security, escaping, cleanup)` and
  `fix: require JWT secret at boot`. Use e.g. `test: add python + server test baselines`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add vitest to the server and a `test` script

In `server/package.json` add under `"scripts"`:
```json
"test": "vitest run"
```
Then run `npm install --save-dev vitest` (installs vitest + updates
`package-lock.json`). Create `server/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/tests/**/*.test.ts"],
    // config.ts throws at import when JWT_SECRET is missing/short — set before modules load.
    env: { JWT_SECRET: "vitest-secret-that-is-longer-than-32-chars-123456" },
  },
});
```
Note: `config.ts` will also try `fs.mkdirSync` for uploads/reports dirs — harmless
(test run may create `uploads/` / `reports_storage/` — both are gitignored).

**Verify**: `cd server && npm install --save-dev vitest` exits 0, and
`npm test -- --version` prints a vitest version (e.g. `3.x.x`).

### Step 2: Write server tests for the pure functions

Create `server/src/tests/ingest.test.ts` covering `chunkText`:
- empty/whitespace text → `[]`
- short text → single chunk equal to cleaned input (note: input is whitespace-collapsed)
- text longer than `size` → multiple non-overlapping-ish chunks, each `<= size`
- overlap behavior: given size 10, overlap 2, chunk step is 8 — assert chunk[1] shares the last 2 chars with chunk[0]'s content where applicable

Create `server/src/tests/cleanFinal.test.ts` covering `cleanFinal` (import from
`../agent.js`):
- plain answer unaffected
- `"Final Answer: ..."` prefix stripped
- `"Thinking: ...\n\nFinal Answer: ..."` → only the answer remains
- `"Thought Process"`, `"Reasoning"`, `"Answer:"` variants stripped
- case-insensitive handling (e.g. `"final answer: x"`)
- repeated labels loop-safe (e.g. `"Answer: Answer: hi"` → `"hi"`)

In the test file, `import { cleanFinal } from "../agent.js";` — importing
`agent.ts` transitively imports `./llm.js` → `openai` package and `./db.js` →
`pg` — both import cleanly without network (no connections are opened at import).
If `cleanFinal` is not yet exported, add the keyword in `server/src/agent.ts`
(line 18: `function cleanFinal` → `export function cleanFinal`). That is the only
allowed edit to `agent.ts`.

**Verify**: `cd server && npm test` → all tests pass, and
`cd server && npm run typecheck` → exit 0.

### Step 3: Add pytest to the Python service

`cd python && uv add --dev pytest`

Add to `python/pyproject.toml` (uv add does this automatically) — confirm the
`[dependency-groups]` or `[tool.uv]` section now includes pytest. Then create
`python/tests/conftest.py`:
```python
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
```
(ensures `import app...` works when pytest runs from `python/`).

**Verify**: `cd python && uv run pytest --collect-only` lists your (not yet
written) test files without import errors. (Empty test dir is fine for now.)

### Step 4: Write Python tests — SQL validator + datasets

Create `python/tests/test_datasets.py`:

- **Validator (contract)**: call `datasets.query(account_id, sql)` with a
  registry set up so the statement never actually executes for rejected inputs.
  For the reject cases the validator raises `HTTPException(400)` before touching
  DuckDB, so you can call without registering anything:
  - rejected: `"INSERT INTO x VALUES (1)"`, `"DROP TABLE t"`, `"UPDATE t SET a=1"`,
    `"DELETE FROM t"`, `"CREATE TABLE t (a int)"`, `"ATTACH 'x'"`, `"COPY t TO 'a'"`,
    `"SELECT 1; DROP TABLE t"`, `""` (400 empty), `"SELECT 1; "` leading-space ok? (validator strips — assert `" SELECT 1"` is ACCEPTED)
  - accepted (only reach the DuckDB execution step — use a query that works on a
    fresh connection, e.g. `"SELECT 1 AS n"`): assert it returns
    `{"columns": ["n"], "rows": [[1]], "row_count": 1}`.
- **Big-number safety**: create a tiny CSV in a `tmp_path` fixture with one column
  of a value larger than `1e15` (e.g. `1234567890123456789`), `register()` it as a
  dataset, then `query(account)` → assert the boxed cell comes back as a float in
  the current implementation (characterization — the exact value may lose
  precision; the test pins current behavior). Also assert `rows < 500` truncation
  on a generated 600-row CSV (characterization of the `.head(500)` cap).
- Small helper to register from a tmp CSV:
  ```python
  def _register_csv(tmp_path, account_id, name, csv_text):
      p = tmp_path / f"{name}.csv"
      p.write_text(csv_text)
      return datasets.register(account_id, name, str(p), "path", f"{name}.csv", None)
  ```
  Use distinct `account_id` strings per test (e.g. `f"acct-{uuid}"`) so the global
  `_REGISTRY` doesn't cross-contaminate; `datasets._REGISTRY` persists across
  tests in-process.

**Verify**: `cd python && uv run pytest python/tests/test_datasets.py -v` → all
pass.

### Step 5: Write Python tests — charts and reports

Create `python/tests/test_charts.py`:
- `normalize` on a full valid spec → defaults filled (title/subtitle/categories/
  series/items/x_label/y_label present), series/items get palette colors.
- `normalize` on `{"type": "bogus"}` → raises `ChartSpecError`.
- `normalize` on non-dict → raises `ChartSpecError`.
- `echarts_option` for each of the six types: assert structure — pie/donut produce
  a `series[0].type == "pie"` with `data` length matching `items`; line/bar/area
  produce `xAxis.type == "category"` and `series[].data` length matching
  `categories`; scatter keeps type scatter.
- `render_png_base64(spec)` → non-empty string, decodes to a PNG (`b"\x89PNG"` magic).

Create `python/tests/test_reports.py`:
- `_render_tables`: malformed table (columns count != row length) → skipped (out
  is empty); well-formed table → contains `&lt;thead&gt;`-escaped header text and a
  footer with `len(t['rows'])} rows` (e.g. `<tfoot>` contains `3 rows`); a value of
  `None` renders as empty `<td>`; `rows[:60]` cap (61-row table → only 60 `<tr>`).
- `_render_markdown`/`_render_section_markdown`: `**bold**` → contains `<strong>`;
  table pipe syntax renders a `<table>` (needs the `tables` extension).
- **Escaping (pin current behavior — not a new security fix)**: raw HTML inside
  markdown today passes through `_sanitize_html`. Assert current behavior with a
  benign input only, e.g. a markdown `<a href="https://example.com">x</a>` — do
  NOT assert on script payloads (plan 009 changes that). If plan 009 lands before
  this one does, the drift check will surface the changed `reports.py` and you
  must reconcile (see dependency notes in `plans/README.md`).
- `build_html` smoke: minimal report dict → returns a string containing the
  escaped title and the word `echarts` inside a `<script>` tag (either the inlined
  asset or the CDN fallback).

**Verify**: `cd python && uv run pytest python/tests/ -v` → all pass.

### Step 6: Final gates

- `cd server && npm test` → all pass
- `cd server && npm run typecheck` → exit 0
- `cd python && uv run pytest` → all pass
- `cd web && npm run typecheck` → exit 0 (make sure you didn't break the web side)
- `git status` → only in-scope files changed (plus `package-lock.json`, `uv.lock`)

## Test plan

This plan IS the test plan — the new tests are the deliverable. The Done
criteria below restate them as gates.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `cd server && npm test` exits 0 with at least 8 tests (chunkText + cleanFinal suites)
- [ ] `cd server && npm run typecheck` exits 0
- [ ] `cd python && uv run pytest` exits 0 with at least 15 tests across the three files
- [ ] `grep -n '"test"' server/package.json` shows the `test: vitest run` script
- [ ] `cd web && npm run typecheck` exits 0
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated to DONE

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the locations in "Current state" doesn't match the excerpts (the
  codebase has drifted since this plan was written — a likely sign plan 009 or the
  connector/perf plans landed first).
- A vitest import of `../agent.js` or `../ingest.js` fails to resolve to the `.ts`
  file (Vite `.js`→`.ts` resolution failing): do NOT switch tests to import with
  `.ts` extensions or add path aliases — report it, the executor environment may
  need a different vitest config.
- Step 2 or 4 reveals a test that fails because of an actual bug in the module
  under test (e.g. `chunkText` off-by-one, validator accepting a DDL keyword you
  expect rejected). Report the failing case with the actual output; the plan
  author will decide whether it's a real bug to fix separately.
- `uv add --dev pytest` or `npm install` fails (network/sandbox).

## Maintenance notes

- These tests pin current behavior. When plan 009 (report escaping/CSP) lands, the
  `test_reports.py` escaping assertions must be updated to the stricter contract.
  When plan 010/011 touch `datasets.py`, the validator + truncation tests in
  `test_datasets.py` guard them.
- The validator tests assert both accept and reject sides of the regex contract —
  if a future change to the SQL guard (e.g. moving to a parser) alters which
  statements are allowed, this file is where the new contract gets recorded.
- `cleanFinal`'s export is the only production-code change here; a future agent
  refactor (dependency-injecting the LLM client, so `runAgent` becomes testable)
  should keep `cleanFinal` exported — the test depends on it.
- Running server tests creates `uploads/` and `reports_storage/` dirs (from
  `config.ts` mkdir on import) — gitignored, harmless.

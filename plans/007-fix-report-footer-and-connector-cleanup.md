# Plan 007: Fix report table footer row counts and connector-delete file cleanup

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 86400ce..HEAD -- python/app/reports.py server/src/routes.ts`
> If either in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW (both are localized corrections)
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `86400ce`, 2026-08-22

## Why this matters

Two small correctness bugs in peripheral paths, bundled because both are
tiny and both touch "cleanup of artifacts":

1. **Report table footers show the wrong row count.** `_render_tables` in
   the Python report builder prints a "N rows" footer, but it always reads
   `len(tables[0]['rows'])` — the first table's count — for **every** table.
   A report embedding two tables with different sizes shows the first
   table's count under the second (which also displays only the first 60
   rows, so the numbers look actively wrong: e.g. "1000 rows" under a 3-row
   view). Plausible multi-table reports are the product's core use case
   (data + analysis), so this shows up in real reports.

2. **Deleting a connector leaves source files on disk.** The connector
   DELETE handler tries to unlink the downloaded file(s), but its query
   `SELECT file_path FROM sources WHERE id=(SELECT id FROM sources WHERE
   connector=$1 LIMIT 1)` only ever returns **one** row (the LIMIT-1
   subquery selects a single id, then returns its one file_path), so
   additional source rows for the same connector — plus the shared
   `url_<account>_<table>.csv` fetch artifact written by the Python
   service's `_fetch_url` — leak into `uploads/` forever. Stale files are a
   disk/surprise-data problem, and `uploads/` is treated as private user
   space, so anything left behind lingers in backups.

## Current state

`python/app/reports.py`, `_render_tables` (lines 57–72) — the bug is the
footer (line 70):

```python
def _render_tables(tables: list[dict[str, Any]]) -> str:
    out = []
    for t in tables:
        cols = t.get("columns", [])
        rows = t.get("rows", [])
        if not cols or not rows or len(cols) != len(rows[0]):
            continue
        head = "".join(f"<th>{c}</th>" for c in cols)
        body = ""
        for row in rows[:60]:
            body += "<tr>" + "".join(f"<td>{v if v is not None else ''}</td>" for v in row) + "</tr>"
        out.append(
            f'<div class="data-table"><table><thead><tr>{head}</tr></thead><tbody>{body}</tbody>'
            f"<tfoot><tr><td colspan='{len(cols)}'>{len(tables[0]['rows'])} rows</td></tr></tfoot></table></div>"
        )
    return "".join(out)
```

`server/src/routes.ts`, connector DELETE (lines 205–221):

```ts
  app.delete("/api/connectors/:id", { preHandler: requireAuth }, async (req, reply) => {
    const account = getAccountId(req);
    const [conn] = await q(`SELECT * FROM connectors WHERE id=$1 AND account_id=$2`, [(req.params as any).id, account]);
    if (!conn) return reply.code(404).send({ error: "connector not found" });
    await q(`DELETE FROM chunks WHERE source_id IN (SELECT id FROM sources WHERE connector=$1)`, [conn.id]);
    await q(`DELETE FROM sources WHERE connector=$1`, [conn.id]);
    try {
      // remove file artifacts
      const rows = await q(`SELECT file_path FROM sources WHERE id=(SELECT id FROM sources WHERE connector=$1 LIMIT 1)`, [conn.id]).catch(() => []);
      for (const r of rows) if (r.file_path) await fs.unlink(r.file_path).catch(() => {});
    } catch {}
```

Note the bugty bug: those two `q()` calls sit **after** the `DELETE FROM
sources WHERE connector=$1` has already removed the rows — so the second query
returns nothing at all (not even the first file). The file artifacts are
effectively never cleaned up. (The `connectors` row itself was already loaded
via `SELECT *` at the top into `conn`, including `config`.)

## Commands you will need

| Purpose   | Command                                                     | Expected on success |
|-----------|-------------------------------------------------------------|---------------------|
| Py probe  | `cd python && .venv/bin/python - <<'PY' ... PY` (Step 1)   | prints `FOOTERS OK` |
| Py import | `cd python && .venv/bin/python -c "import app.reports"`    | exit 0              |
| Typecheck | `cd server && npm run typecheck`                            | exit 0              |

## Scope

**In scope** (the only files you should modify):
- `python/app/reports.py` — footer count fix
- `server/src/routes.ts` — connector DELETE file cleanup fix

**Out of scope** (do NOT touch):
- `server/src/ingest.ts`, `python/app/datasets.py` — registry/dataset logic,
  unrelated.
- The `DELETE FROM sources WHERE connector=$1` ordering — the fix must not
  reorder DB deletions; it only needs to capture paths *before* they're
  deleted.
- Do not add dependencies.

## Git workflow

- Branch: `advisor/007-fix-report-footer-and-connector-cleanup`
- Commit style (conventional): `fix(python): report table footer row count` and
  `fix(server): unlink all connector source files on delete` (two commits) —
  or a single `fix: correct report footer counts and connector file cleanup`
  if you prefer; the repo history mixes both granularity.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Python — use the current table's row count in the footer

In `python/app/reports.py` `_render_tables`, change line 70 from
`len(tables[0]['rows'])` to `len(t['rows'])`. That is the only change.

**Verify** — run this probe and expect `FOOTERS OK`:

```bash
cd python && .venv/bin/python - <<'PY'
from app.reports import build_html
out = build_html({"title": "t", "subtitle": "", "generated_at": "g",
  "sections": [],
  "charts": [],
  "tables": [
    {"columns": ["a"], "rows": [["1"], ["2"], ["3"]]},          # 3 rows
    {"columns": ["b"], "rows": [["x"], ["y"]]}                  # 2 rows
  ]})
first_tfoot = out[out.find('tfoot'):]
second_pos = out.find('tfoot', first_tfoot.find('tfoot') + 1)
# count 'rows</td>' occurrences plus verify distinct counts
import re
counts = [int(m) for m in re.findall(r"(\d+) rows</td>", out)]
assert counts == [3, 2], f"footer counts wrong: {counts}"
print("FOOTERS OK")
PY
```

### Step 2: Server — collect connector file paths BEFORE deleting sources

In `server/src/routes.ts` connector DELETE handler, capture paths first, then
unlink them all. Replace the buggy block (lines 209–215) with:

```ts
    // remove file artifacts
    const paths = await q(`SELECT file_path FROM sources WHERE connector=$1`, [conn.id]).catch(() => []);
    for (const r of paths) if (r.file_path) await fs.unlink(r.file_path).catch(() => {});
```

This keeps the same two `DELETE` statements (chunks then sources) unchanged,
and moves file unlinking to a query that runs **before** the source rows
disappear, returning **all** matching paths (no LIMIT 1).

**Verify**: `cd server && npm run typecheck` → exit 0.

Note on the shared fetch artifact: `python/app/main.py:_fetch_url` names the
URL-dataset file `url_<account>_<table>.csv` — this is *not* a `sources.file_path`
row (the source rows for URL datasets point at the same path via `dset.location`,
so it IS captured when the source row's file_path exists). If a connector's
source has NULL file_path, the fetch artifact won't be removed by this fix —
that's acceptable; the fix targets the rows that exist. Report any leftover
pattern you see rather than extending scope.

## Test plan

- Python: the Step 1 probe is the regression test (no pytest framework yet).
- Server: typecheck is the gate; deletion behavior is exercised by running the
  API route when services are up (optional manual check: create a URL
  connector, sync, note the fetched file under `uploads/`, delete the
  connector, confirm both the source rows and their files are gone).

## Done criteria

ALL must hold:

- [ ] Step 1 probe prints `FOOTERS OK` and exits 0
- [ ] `grep -n "len(t\['rows'\])\|len(t\['rows'\])" python/app/reports.py` — single
      occurrence of `len(t['rows'])`, and zero of `tables[0]['rows']`
- [ ] `cd server && npm run typecheck` exits 0
- [ ] The connector DELETE handler contains `SELECT file_path FROM sources WHERE connector=$1` and no `LIMIT 1`
- [ ] Only `python/app/reports.py` and `server/src/routes.ts` modified
      (`git status --porcelain`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at "Current state" doesn't match the live files.
- The connector handler in the live tree is structured differently than shown
  (e.g. the file cleanup was already refactored) — do not restructure it
  beyond the excerpt.
- The updated query returns a non-array or throws in a way that breaks the
  handler (`q` returns rows or empty array, never null — `.catch(() => [])`
  guards the python-down case).
- You find a second consumer of `tables[0]` that also needs fixing.

## Maintenance notes

- When pagination of report tables is added later, the footer count fix
  should show the *total* rows, not the capped 60 — keep the current
  `rows[:60]` view but the footer is total; that is intended behavior.
- The connector cleanup fix depends on the `sources` rows still being present
  when paths are queried; if source deletion is ever moved earlier, re-check
  this ordering.
- A reviewer should confirm no file was deleted that still had DB references
  (the unlink runs after the chunk/source DELETE, so nothing references them).

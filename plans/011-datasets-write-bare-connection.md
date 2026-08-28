# Plan 011: Stop DuckDB register/drop from re-reading every dataset on each write

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
> **Drift check (run first)**: `git diff --stat d16a44c..HEAD -- python/app/datasets.py`
> If the file changed since this plan was written, compare the "Current state"
> excerpts against the live code before proceeding; on a mismatch, treat it as a
> STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (touches `python/app/datasets.py` — do NOT run
  concurrently with any other plan that edits that file)
- **Category**: perf
- **Planned at**: commit `d16a44c`, 2026-08-22

## Why this matters

`datasets._connection(account_id)` builds a NEW in-memory DuckDB connection and
re-creates EVERY registered table for the account by re-reading every dataset
file from disk (`datasets.py:45-54`). That behaviour is a deliberate tradeoff for
the read path (`/query`, `/describe` — every query gets a fresh DB so there are no
thread-safety issues). But `register()` and `drop()` — the WRITE paths — call
`_connection(account_id)` too, even though they never read any of the other
tables: `register` only creates the new table, and `drop` runs `DROP TABLE IF
EXISTS` on a fresh connection (a no-op there; the in-memory table disappears when
the connection closes anyway). The result is that every upload/sync and every
delete re-parses the entire dataset catalog first: with N datasets of ~sum sizes,
the Nth upload re-reads bytes roughly proportional to N×file-size. For a handful
of multi-MB CSVs that is seconds per write, growing with every dataset. The fix is
to make the write paths use a bare connection.

## Current state

`python/app/datasets.py` — the registry and all DuckDB access. Exact excerpts:

Lines 45-54 (the per-query reload; NOT being changed — read path keeps it):
```python
def _connection(account_id: str) -> duckdb.DuckDBPyConnection:
    # In-memory, but all datasets are registered from durable files on disk each boot.
    con = duckdb.connect()
    con.execute("PRAGMA threads=4")
    for name, meta in _REGISTRY.get(account_id, {}).items():
        try:
            con.execute(f"CREATE OR REPLACE TABLE {name} AS SELECT * FROM {_read_sql(meta['safe_location'])}", [meta["safe_location"]])
        except Exception as e:  # noqa: BLE001
            print(f"[datasets] failed to reload {name}: {e}")
    return con
```

Lines 57-72 (`register` — note line 67 calls `_connection`):
```python
def register(account_id: str, name: str, location: str, kind: str, original_name: str, url: str | None = None) -> dict[str, Any]:
    with LOCK:
        _REGISTRY.setdefault(account_id, {})
        if name == "schema_version":
            raise HTTPException(400, "reserved name")
        if not TABLE_RE.match(name):
            raise HTTPException(400, f"table name {name!r} invalid; use lowercase letters, digits and underscores")
        if not Path(location).exists():
            raise HTTPException(404, f"file not found: {location}")
        try:
            con = _connection(account_id)
            con.execute(f"CREATE OR REPLACE TABLE {name} AS SELECT * FROM {_read_sql(location)}", [location])
            n_rows = con.execute(f"SELECT count(*) FROM {name}").fetchone()[0]
            columns = _columns(con, name)
            preview = _preview(con, name, 5)
            con.close()
        except Exception as e:  # noqa: BLE001
            raise HTTPException(422, f"could not parse {original_name} as tabular data: {e}") from e
```

Lines 111-118 (`drop` — note line 116 calls `_connection`):
```python
def drop(account_id: str, name: str) -> None:
    with LOCK:
        if name not in _REGISTRY.get(account_id, {}):
            raise HTTPException(404, f"dataset {name} not found")
        del _REGISTRY[account_id][name]
        con = _connection(account_id)
        con.execute(f"DROP TABLE IF EXISTS {name}")
        con.close()
```

Conventions: repo is uv-managed Python, `from __future__ import annotations`,
type hints, module-level `LOCK = threading.RLock()`. `register` and `drop` are
called by the FastAPI handlers in `main.py` and by `server's
`restoreDatasets()/ingest.ts` — their public signatures MUST NOT change.

## Commands you will need

| Purpose   | Command                                         | Expected on success |
|-----------|-------------------------------------------------|---------------------|
| Python tests | `cd python && uv run pytest python/tests/ -v` (if plan 008 landed) | all pass |
| Behavior probe | `cd python && uv run python -c "from app import datasets; print(datasets.register.__annotations__)"` | unchanged signature |
| Server typecheck (sanity) | `cd server && npm run typecheck` | exit 0 |

## Scope

**In scope**:
- `python/app/datasets.py` (register + drop only)
- `python/tests/test_datasets.py` (if plan 008 landed — add/adjust a register/drop
  test; otherwise create it)
- `plans/README.md` (status row)

**Out of scope** (do NOT touch):
- `_connection()` itself, `query()`, `describe()`, `list_datasets()`, `resync()` —
  read-path reload stays as the deliberate design.
- `main.py`, `server/*` — no contract change.
- `PRAGMA threads=4` behavior for the read path.

## Git workflow

- Branch: `advisor/011-datasets-bare-connection`
- One commit: `perf: don't re-read all datasets on register/drop`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add a bare-connection helper

Add a small helper next to `_connection` in `python/app/datasets.py`:

```python
def _bare_connection() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    con.execute("PRAGMA threads=4")
    return con
```

**Verify**: `cd python && uv run python -c "import ast; ast.parse(open('app/datasets.py').read()); print('syntax ok')"` → prints `syntax ok`.

### Step 2: Use it in `register`

In `register()` (line 67), replace:

```python
            con = _connection(account_id)
```
with:
```python
            con = _bare_connection()
```

The `CREATE OR REPLACE TABLE ... AS SELECT ...`, `count(*)`, `_columns(con,
name)`, `_preview(con, name, 5)` and `con.close()` lines stay untouched — they
operate on the new connection and never touch other datasets.

**Verify**: `grep -n "_connection(account_id)" python/app/datasets.py` → the only
matches are inside `_connection`'s callers on the READ path: `query` ,`describe`.
`register` no longer calls it.

### Step 3: Use it in `drop`

In `drop()` (line 116), replace:

```python
        con = _connection(account_id)
```
with:
```python
        con = _bare_connection()
```

The `DROP TABLE IF EXISTS` stays (harmless no-op on a fresh connection, but keeps
the code honest if the pattern changes later).

**Verify**: `grep -n "_connection(account_id)\|_bare_connection()" python/app/datasets.py` → `_bare_connection()` in register+drop+helper; `_connection(account_id)` only in query/describe.

### Step 4: Regression test

In `python/tests/test_datasets.py` (create if plan 008 never landed — mirror its
file layout: `from app import datasets`, tmp CSV fixture via
`datasets.register(account, name, str(path), "path", name, None)`):

Add a test asserting register + drop still work and — the real regression — that
register no longer re-reads other datasets. The cleanest assertion is to
monkeypatch `_bare_connection`'s cost is not directly observable, so instead
assert **behavioural equivalence**:

```python
def test_register_and_drop_lifecycle(tmp_path):
    account = "acct-regdrop"
    a = tmp_path / "a.csv"; a.write_text("x\n1\n2\n")
    b = tmp_path / "b.csv"; b.write_text("y\n3\n")
    datasets.register(account, "a", str(a), "path", "a.csv", None)
    datasets.register(account, "b", str(b), "path", "b.csv", None)
    got = datasets.query(account, "SELECT count(*) AS n FROM a")["rows"][0][0]
    assert got == 2
    datasets.drop(account, "a")
    with pytest.raises(Exception):
        datasets.query(account, "SELECT * FROM a")  # table no longer present after drop (raises HTTPException(422) via query's catch)
    b2 = datasets.query(account, "SELECT count(*) AS n FROM b")["rows"][0][0]
    assert b2 == 1
```

Plus a direct structural guard that the read-path reload is NOT invoked by the
write path — monkeypatch `_connection` to raise, then confirm register/drop still
succeed (this is the actual regression this plan fixes):

```python
def test_register_drop_do_not_touch_read_reload(tmp_path, monkeypatch):
    def _boom(account_id):
        raise AssertionError("_connection must not be called on write paths")
    monkeypatch.setattr(datasets, "_connection", _boom)
    account = "acct-regdrop2"
    a = tmp_path / "a.csv"; a.write_text("x\n1\n")
    datasets.register(account, "a", str(a), "path", "a.csv", None)
    datasets.drop(account, "a")
```

**Verify**: `cd python && uv run pytest python/tests/test_datasets.py -v` → all
pass, including the two new tests. (If plan 008 already has a
`test_register...`-style suite, add these two tests to that file instead of
duplicating.)

## Test plan

- The two tests above (lifecycle equivalence + the `_connection`-must-not-be-called
  regression guard).
- Existing datasets tests from plan 008 (validator matrix, truncation) must still
  pass unchanged.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -n "_bare_connection" python/app/datasets.py` shows the helper + usage in `register` and `drop`
- [ ] `grep -n "con = _connection(account_id)" python/app/datasets.py` shows matches ONLY in `query` and `describe` (not register/drop)
- [ ] `cd python && uv run pytest python/tests/ -v` exits 0 (including the two new tests)
- [ ] `cd server && npm run typecheck` exits 0
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated to DONE

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the "Current state" locations doesn't match the excerpts (drifted).
- A behavioural difference shows up in Step 4's lifecycle test (e.g. `drop`
  leaving the table queryable, or `register` failing) — the change should be
  behaviour-neutral on the write path; report the actual failure rather than
  "fixing" something in `query`/`describe`.
- `pytest.raises(Exception)` doesn't catch what `query` raises after `drop`
  (check: `query` wraps DuckDB errors in `HTTPException(422)`; if the raised type
  differs, adjust to `pytest.raises(Exception)` or `HTTPException` and continue —
  note it in your report).

## Maintenance notes

- This preserves the documented design (per-query reload) exactly — only the
  write path stopped paying for it. If someone later introduces a persistent
  catalog/cached connections (the audits have flagged that as a future refactor),
  `_connection`/`_bare_connection` are the seams to change.
- `resync()` calls `register()` internally — it inherits the fix automatically and
  must not be touched separately.
- Any future write-path function that needs to inspect OTHER tables of the same
  account must call `_connection(account_id)` deliberately (not
  `_bare_connection`) and should add a comment saying why.

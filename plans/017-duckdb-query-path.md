# Plan 017: Stop re-parsing every dataset on every SQL query (DuckDB service perf + robustness)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 567481d..HEAD -- python/app/datasets.py python/app/main.py python/tests/test_datasets.py python/tests/test_main.py plans/README.md`
> On any diff, compare "Current state" excerpts against live code; mismatch → STOP.
> This plan assumes plan 014 has landed (it edits `_read_sql` in datasets.py).

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED (introduces persistent per-account DuckDB connections — thread discipline and tenant isolation must both be right)
- **Depends on**: plans/014-fix-ingest-name-and-chat-stream-ux.md (both edit `datasets.py`; run sequentially)
- **Category**: perf / bug
- **Planned at**: commit `567481d`, 2026-08-23
- **Safety revision**: commit `e6e9d2b`, 2026-08-23 — replaced the proposed
  process-global catalog with per-account catalogs before execution.

## Why this matters

Every `query_data` and `describe_data` tool call creates a FRESH in-memory
DuckDB connection and re-reads/re-parses EVERY registered CSV from disk before
the actual query runs (`_connection()`). One agent answer can issue several
tool calls across ≤8 iterations — the same files get re-parsed a dozen times
per turn. Invisible with the 697-row sample; seconds of pure parse per call
once real CSVs land. Four smaller defects ride along in the same file: query
results are fully materialized into pandas before truncating to 500 rows;
`describe` issues 1–2 full scans PER COLUMN while holding the global lock;
±Infinity values crash response serialization; and a query racing an upload
can hit "dictionary changed size during iteration".

The cache MUST stay account-partitioned. Table names are unique only inside an
account; one process-global DuckDB catalog would retain tables loaded for other
accounts (and same-name tables would overwrite each other), turning this
performance change into a cross-account disclosure risk. The per-chat source
scope in plan 022 will further refine the cache key after this plan lands.

## Current state

File: `python/app/datasets.py` — in-memory DuckDB registry, one module-level
`LOCK = threading.RLock()` (line 24), registry `_REGISTRY[account_id][name] = meta`.

Current exact code:

`datasets.py:45-54` — the per-query full reload:
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
Used by `query()` (line 154) and `describe()` (line 173). A fresh connection
starts with NO tables, which is WHY every table must be re-created every call.

`datasets.py:144-165` — validator + materialize-then-truncate + row conversion:
```python
def query(account_id: str, sql: str) -> dict[str, Any]:
    sql = sql.strip()
    ...
    if not re.match(r"^(SELECT|WITH|VALUES|PRAGMA)\b", sql, re.IGNORECASE):
        raise HTTPException(400, "only SELECT/WITH queries are allowed")
    ...
    try:
        con = _connection(account_id)
        res = con.execute(sql).fetchdf().head(500)
        con.close()
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        raise HTTPException(422, f"query failed: {e}") from e
    return {
        "columns": [str(c) for c in res.columns],
        "rows": [[None if pd.isna(v) else (...) for v in row] for row in res.itertuples(index=False, name=None)],
        "row_count": int(len(res)),
    }
```
Note: `pd.isna(float('inf'))` is False, so ±inf survives conversion and
FastAPI/Starlette serialization raises on non-finite floats → the whole tool
call fails. Also `query()` iterates `_REGISTRY` inside `_connection()`
WITHOUT `LOCK`, while `register()`/`drop()` mutate it under `LOCK`; all
endpoints are plain `def`, so FastAPI runs them concurrently in its
threadpool — a real race window during upload-while-chatting.

`datasets.py:168-194` — describe loops per column under `with LOCK:`:
numeric columns cost one aggregate query each; VARCHAR columns cost TWO
(top-values GROUP BY + separate count(DISTINCT)). Identifiers are f-string
interpolated inside double quotes WITHOUT escaping embedded quotes
(`f'SELECT min("{cname}")...'`) — a CSV header containing `"` breaks out of
the identifier.

Conventions: keep the module's HTTPException style; keep pytest patterns from
`python/tests/test_datasets.py` (unique account ids against the shared
registry). `fastapi.testclient.TestClient` is available (httpx is installed).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Python tests | `cd python && uv run pytest` | all pass |

## Scope

**In scope**:
- `python/app/datasets.py` (connection lifecycle, query truncation, describe stats, identifier quoting, inf handling)
- `python/app/main.py` (`/chart` error mapping; `_fetch_url` cache-file extension)
- `python/tests/test_datasets.py`, `python/tests/test_main.py` (tests)
- `plans/README.md` (status row)

**Out of scope (do NOT touch)**:
- The SQL allowlist/denylist regexes (behavior pinned by existing tests).
- `server/src/*` — Node side is unaware of these internals.
- `/html-to-pdf` endpoint (separate dead-code decision).
- Plan 014's CSV-sniffing heuristic — build on it, don't rewrite it.

## Git workflow

- Branch: `advisor/017-duckdb-query-path`
- Commits per step, conventional style.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: One persistent connection per account + load memoization

Replace `_connection()` with lazily-created, account-keyed connections that
persist tables BETWEEN calls, plus a load signature per registry entry:

```python
_CONNECTIONS: dict[str, duckdb.DuckDBPyConnection] = {}

def _account_connection(account_id: str) -> duckdb.DuckDBPyConnection:
    con = _CONNECTIONS.get(account_id)
    if con is None:
        con = duckdb.connect()
        con.execute("PRAGMA threads=4")
        _CONNECTIONS[account_id] = con
    return con

def _ensure_loaded(account_id: str) -> None:
    """CREATE OR REPLACE only entries whose file changed since last load."""
    con = _account_connection(account_id)
    for name, meta in list(_REGISTRY.get(account_id, {}).items()):
        sig = _file_sig(meta["location"])
        if meta.get("_loaded_sig") == sig:
            continue
        try:
            con.execute(f"CREATE OR REPLACE TABLE {name} AS SELECT * FROM {_read_sql(meta['safe_location'])}", [meta["safe_location"]])
            meta["_loaded_sig"] = sig
        except Exception as e:  # noqa: BLE001
            logging.getLogger(__name__).warning("failed to load %s: %s", name, e)
            raise HTTPException(422, f"dataset {name} could not be reloaded") from e

def _file_sig(path: str) -> str:
    try:
        st = Path(path).stat()
        return f"{st.st_size}:{int(st.st_mtime)}"
    except OSError:
        return "missing"
```

Discipline (this is the MED-risk part — be exact):
- ALL access to `_CONNECTIONS` and every contained connection happens under
  `with LOCK:` — `query()`,
  `describe()`, `register()`, `drop()`, `resync()` wrap their ENTIRE
  db-touching body in the lock (RLock already exists; resync already calls
  register while holding it). DuckDB python connections are not safe across
  concurrent threads; serializing is correct for this single-user service.
- `drop()` executes its `DROP TABLE IF EXISTS` only on that account's
  connection and
  clears `meta["_loaded_sig"]` semantics by deleting the entry.
- `register()` validates parseability on that account's connection too (inside
  LOCK); on success set `meta["_loaded_sig"]`.
- When an account has no remaining registry entries, close and remove its
  connection so empty/deleted accounts do not leak handles.
- Never search, drop, replace, or reuse a table in another account's
  connection, even when the table name is identical.
- Fail closed on a changed or missing registered file. If its signature no
  longer matches and reloading fails, raise 422 for that query/describe call;
  do not continue against the stale in-memory table. A later call may retry
  after the file is restored.
- Delete the old `_connection()`; keep `_bare_connection` ONLY if still
  referenced after this (it should not be — remove it and update callers).
- Add `import logging` and replace the bare `print` in the load path.

**Verify**: `cd python && uv run pytest` → existing suite passes unchanged.

### Step 2: Truncate in DuckDB, not pandas

In `query()`: strip ONE trailing `;` if present. If the statement starts with
`PRAGMA` (case-insensitive), execute as-is (it cannot be wrapped). Otherwise
execute `SELECT * FROM ({sql}) AS _q LIMIT 500`. For BOTH branches, consume at
most 500 rows with `cursor.fetchmany(500)` and obtain column names from cursor
description. If preserving the pandas-based serializer, construct a DataFrame
only from those fetched rows; never call an unbounded `fetchdf()` first. Keep
the return shape identical: `{columns, rows, row_count}`, with `row_count <=
500` even for PRAGMA output.

**Verify**: pytest (new test below asserts row_count == 500 for a 1000-row dataset).

### Step 3: Non-finite floats become None

In the row serializer, extend the NaN check: values that are `float` and not
`math.isfinite(v)` become `None` (`import math`). Keep the existing large-int
float demotion logic otherwise untouched.

**Verify**: pytest (test below queries `SELECT 1.0/0.0`).

### Step 4: describe() in one pass + quoted identifiers

1. Add `def _qi(name: str) -> str: return '"' + str(name).replace('"', '""') + '"'`
   and use it for EVERY identifier interpolation in `describe()` (and the
   `"{table}"` occurrences) instead of raw f-string quotes.
2. Replace the numeric/date aggregate queries with a single DuckDB SUMMARIZE:
   `con.execute(f"SUMMARIZE SELECT * FROM {_qi(table)}").fetchall()` →
   columns include column_name, column_type, min, max, approx_unique, avg.
   Map those onto entries (numeric: min/max/avg/distinct←approx_unique;
   date: min/max/distinct). Keep the VARCHAR top-values GROUP BY loop (now
   using `_qi`), but DROP its separate count(DISTINCT) query in favor of
   approx_unique from SUMMARIZE.

**Verify**: pytest incl. new quote-bearing-column test below.

### Step 5: /chart returns 400 on bad specs; url_json caches get the right extension

In `python/app/main.py`:
1. Register an exception handler (or try/except in the route) mapping
   `charts.ChartSpecError` (a ValueError subclass) to
   `HTTPException(400, str(e))` for `/chart` — today a garbled model spec is
   an opaque 500.
2. In `_fetch_url`, derive the cache filename extension from the URL path /
   response content type instead of hardcoding `.csv`:

```python
_EXT_BY_CT = {"application/json": ".json", "text/csv": ".csv"}
def _cache_ext(url: str, content_type: str) -> str:
    suffix = Path(urlparse(url).path).suffix.lower()
    if suffix in {".csv", ".tsv", ".json", ".jsonl", ".xlsx", ".parquet"}:
        return suffix
    return _EXT_BY_CT.get(content_type.split(";")[0].strip(), ".csv")
```
   (`from urllib.parse import urlparse`). Use one extensionless cache stem and
   the fixed allowed suffix set above. On `force=False`, check the URL-derived
   suffix first, the legacy `.csv` path second, and then the other allowed
   suffix siblings so a previously content-type-derived `.json`/`.parquet`
   cache is reused without an HTTP request. After a successful fetch, write to
   the derived suffix and remove stale sibling suffixes for that same stem;
   never remove the old cache before the replacement write succeeds. On
   `force=True`, always fetch and then perform the same replacement/cleanup.
   Do not use a glob broader than that explicit cache stem + suffix allowlist.

**Verify**: pytest (tests below).

## Test plan

Add to `python/tests/test_datasets.py`:
- Repeated-query memoization: wrap/spy on `_read_sql`, record its call count
  after registration/first query, then query the unchanged file again; the
  count does not increase. Rewrite the file with a different size/value and
  query again; exactly one reload occurs and the new value is returned.
- Missing-file fail-closed behavior: delete a previously loaded source, then
  query/describe -> 422 and no stale rows/stats are returned.
- Account isolation: register the SAME table name with different canary values
  in two accounts and alternate queries; each account always returns its own
  value. A table registered only for account A must be unavailable to account
  B even after A queried it (422, never leaked rows).
- LIMIT pushdown: register a 1000-row CSV, `SELECT * FROM t` → row_count == 500.
- PRAGMA bounding: a PRAGMA returning more than 500 rows (for example
  `PRAGMA functions` in the pinned DuckDB version) returns exactly 500.
- Infinity: query `SELECT 1.0/0.0 AS x` → 200 with rows `[[None]]`.
- Quote-bearing header: register a CSV with column header `we"ird` → describe()
  returns stats without raising.

Add to `python/tests/test_main.py` (TestClient is fine here):
- POST `/chart` with spec `{"type":"nope"}` → 400 (not 500).
- `_cache_ext("https://x/y/data.json", "application/octet-stream")` → `.json`;
  `("https://x/y/data", "application/json")` → `.json`; unknown → `.csv`.
- Mock the HTTP client and call `_fetch_url` twice for an extensionless JSON
  URL. The first call performs one GET and writes `.json`; the second
  non-forced call returns that path with the GET count still exactly one.
- Force-refresh a cache whose derived suffix changes; the new file is present,
  stale sibling suffixes are absent, and a failed refresh leaves the prior
  cache intact.

Verification: `cd python && uv run pytest` → all pass, ≥6 new tests.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `rg -n "_SHARED_CON|def _shared_connection" python/app/datasets.py` -> no matches
- [ ] `grep -n "_CONNECTIONS" python/app/datasets.py` -> present; keys are account IDs
- [ ] `grep -n "fetchdf().head" python/app/datasets.py` → no matches
- [ ] `cd python && uv run pytest` exits 0, including account isolation,
  load-count memoization, missing-file fail-closed behavior, bounded PRAGMA,
  and two-call URL-cache reuse
- [ ] `grep -n '_loaded_sig' python/app/datasets.py` → present (memoization live)
- [ ] POST /chart bad-spec → 400 (pytest)
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Any "Current state" excerpt doesn't match live code (esp. if plan 014
  changed `_read_sql` signatures).
- You find a code path that uses a DuckDB connection OUTSIDE the lock that
  you cannot move under it — report the site instead of weakening discipline.
- A proposed implementation has one process-global catalog, or either
  same-name/unique-name account-isolation test can see another account's table.
- SUMMARIZE output columns differ from `{column_name, column_type, min, max,
  approx_unique, avg}` in the installed DuckDB version — report actual columns.
- The unchanged-file load count increases, a changed file is not reloaded, or
  a missing/failed reload serves stale rows. Those violate the cache contract;
  do not weaken the assertions to make them green.

## Maintenance notes

- Persistent connections remain partitioned by account and serialize under the
  global LOCK. Plan 022 deliberately extends the key to `(account, selected
  tables)`; preserve the account component in every future cache design.
- `_loaded_sig` keys on size+mtime; a same-size in-place rewrite within one
  mtime tick would be missed — acceptable; connector resyncs write new bytes
  (size changes) and force=True goes through register().
- Old `.csv`-named JSON caches in uploads/ linger until overwritten; harmless.

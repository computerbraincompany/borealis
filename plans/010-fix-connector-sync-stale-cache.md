# Plan 010: Fix connector "Sync now" being a no-op — force a fresh fetch on resync

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
> **Drift check (run first)**: `git diff --stat d16a44c..HEAD -- python/app/main.py python/app/datasets.py`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `d16a44c`, 2026-08-22

## Why this matters

URL connectors expose a "Sync now" affordance (`web/src/pages/ConnectorsView.tsx`
"Sync now" button → `POST /api/connectors/:id/sync` → `py.resync` →
`POST /datasets/resync`). But `_fetch_url` in `python/app/main.py` short-circuits
on a cached file: once a URL dataset has been fetched once, the file
`uploads/url_<account>_<name>.csv` exists and EVERY subsequent "sync" (and any
re-registration) reuses it without touching the network. The result: clicking
"Sync now" returns `{"synced": true}` and regenerates RAG chunks — all from the
SAME stale data. The only way to actually refresh is to delete and re-create the
connector. For an app whose pitch is live/connected data sources, this silently
breaks a first-class feature and erodes trust in the numbers the agent reports.

## Current state

Files and their roles:

- `python/app/main.py` — FastAPI handlers; `_fetch_url` (lines 178-189) is the
  URL→disk fetcher with the stale-cache early return.
- `python/app/datasets.py` — `resync()` (121-133) calls the fetcher and
  re-registers the dataset.
- `server/src/routes.ts` — `syncConnector()` (299-346); for `url_csv` it calls
  `py.resync` when the dataset already exists (line 305).

Current exact code (excerpts):

`python/app/main.py:178-189` (the offending cache):
```python
def _fetch_url(url: str, account_id: str, name: str) -> Path:
    path = STORAGE_DIR / f"url_{account_id}_{name}.csv"
    # allow csv/xlsx/json/parquet from plain URLs
    if path.exists():
        return path
    with httpx.Client(timeout=60, follow_redirects=True) as client:
        r = client.get(url)
        r.raise_for_status()
        if "text/html" in r.headers.get("content-type", "") and "<" in (r.text[:200] or ""):
            raise HTTPException(422, "URL returned HTML, not tabular data")
        path.write_bytes(r.content)
    return path
```

`python/app/datasets.py:121-133` (resync passes the lambda fetcher straight
through):
```python
def resync(account_id: str, name: str, fetcher) -> dict[str, Any]:
    """Re-fetch a URL-based dataset through a fetcher callable -> local path."""
    with LOCK:
        meta = _REGISTRY.get(account_id, {}).get(name)
        if not meta:
            raise HTTPException(404, f"dataset {name} not found")
        if meta["kind"] == "url":
            path = fetcher(meta["url"])
            meta["location"] = path
            meta["safe_location"] = str(Path(path).resolve())
        return register(account_id, name, meta["location"], meta["kind"], meta["original_name"], meta.get("url")) | {
            "table": name
        }
```

`python/app/main.py:88-90` (resync endpoint feeding the lambda):
```python
@app.post("/datasets/resync")
def resync(req: DatasetRegister) -> dict[str, Any]:
    return datasets.resync(req.account_id, req.name, fetcher=lambda url: str(_fetch_url(url, req.account_id, req.name)))
```

`server/src/routes.ts:299-346` — for `url_csv`, when the dataset already exists
it calls `py.resync(account, conn.target_table, configVal.url)` (line 305), never
`registerDataset` — so the stale cache is on the primary sync path.

## Commands you will need

| Purpose   | Command                                         | Expected on success |
|-----------|-------------------------------------------------|---------------------|
| Python behavior check | `cd python && uv run python -c "from app import main; print(main._fetch_url('https://example.com/x.csv','a','b'))"` | downloads/returns a path; with cache present, returns path without network (see Step 4) |
| Python tests | `cd python && uv run pytest python/tests/ -v` (if plan 008 landed) | all pass |
| Server typecheck | `cd server && npm run typecheck` | exit 0 |

## Scope

**In scope**:
- `python/app/main.py` — `_fetch_url` signature change (+`force: bool = False`)
  and the `/datasets/resync` handler (pass `force=True`)
- `python/tests/test_main.py` (create) — or if plan 008's test layout exists, add
  to `python/tests/`
- `plans/README.md` (status row)

**Out of scope** (do NOT touch):
- `python/app/datasets.py` `resync()` — the fetch semantics change happens in the
  fetcher (`main.py`), not here.
- `server/src/routes.ts` / `server/src/pythonClient.ts` — the server contract
  (`py.resync`) is unchanged.
- The `register` first-time path: keep its caching behavior (it avoids re-download
  on reboots/python-service restarts — that is desirable).

## Git workflow

- Branch: `advisor/010-fix-connector-sync`
- One commit: `fix: force fresh fetch when resyncing URL connectors`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add a `force` flag to `_fetch_url`

In `python/app/main.py`, change `_fetch_url` so a forced call bypasses the cache:

```python
def _fetch_url(url: str, account_id: str, name: str, force: bool = False) -> Path:
    path = STORAGE_DIR / f"url_{account_id}_{name}.csv"
    # Cached copy avoids re-download on restart; pass force=True from resync to refresh.
    if path.exists() and not force:
        return path
    with httpx.Client(timeout=60, follow_redirects=True) as client:
        r = client.get(url)
        r.raise_for_status()
        if "text/html" in r.headers.get("content-type", "") and "<" in (r.text[:200] or ""):
            raise HTTPException(422, "URL returned HTML, not tabular data")
        path.write_bytes(r.content)
    return path
```

(Note: the forced path overwrites the same file in place, so no stale-file
accumulation and no change to the existing `location` bookkeeping.)

**Verify**: `cd python && uv run python -c "from app import main; print(main._fetch_url.__code__.co_varnames)"` → contains `force`.

### Step 2: Make `/datasets/resync` force a fresh fetch

In `python/app/main.py`, the resync handler (lines 88-90): pass `force=True`:

```python
@app.post("/datasets/resync")
def resync(req: DatasetRegister) -> dict[str, Any]:
    return datasets.resync(req.account_id, req.name, fetcher=lambda url: str(_fetch_url(url, req.account_id, req.name, force=True)))
```

**Verify**: `grep -n "_fetch_url(url, req.account_id, req.name, force=True)" python/app/main.py` → matches.

### Step 3: End-to-end behavior probe (machine-checkable)

Write `python/tests/test_main.py` (create the file; if plan 008 hasn't landed,
create the `python/tests/` dir with a `conftest.py` that inserts the repo root on
`sys.path`, mirroring plan 008 Step 3):

```python
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from app import main, datasets


class _Handler(BaseHTTPRequestHandler):
    body = b"a,b\n1,2\n"

    def do_GET(self):  # noqa: N802
        self.send_response(200)
        self.send_header("Content-Type", "text/csv")
        self.send_header("Content-Length", str(len(self.body)))
        self.end_headers()
        self.wfile.write(self.body)

    def log_message(self, *args):  # silence
        pass


@pytest.fixture()
def csv_server():
    srv = HTTPServer(("127.0.0.1", 0), _Handler)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    yield srv
    srv.shutdown()


def test_resync_refetches_after_remote_change(csv_server):
    _Handler.body = b"a,b\n1,2\n"
    account = "acct-sync-test"
    name = "tickers"
    path = main._fetch_url(f"http://127.0.0.1:{csv_server.server_port}/d.csv", account, name)
    first = datasets.query(account, "SELECT count(*) AS n FROM tickers")["rows"][0][0]
    assert first == 1

    # remote data changes
    _Handler.body = b"a,b\n1,2\n3,4\n"

    # plain _fetch_url with an existing cache must NOT refetch
    cached = main._fetch_url(f"http://127.0.0.1:{csv_server.server_port}/d.csv", account, name)
    # resync path must refetch
    datasets.resync(account, name, fetcher=lambda url: str(main._fetch_url(url, account, name, force=True)))
    second = datasets.query(account, "SELECT count(*) AS n FROM tickers")["rows"][0][0]
    assert second == 2
```

Notes for the executor: the test uses the real `_REGISTRY` (global) — use a
distinct `account` name; the `cached`/`first` assertions document the old-vs-new
semantics; `datasets.register` inside `resync` requires the file to exist (it
does — the forced fetch wrote it). If plan 008 landed, drop this file's
`conftest.py` duplication (008 already created one).

**Verify**: `cd python && uv run pytest python/tests/test_main.py -v` → all pass.

### Step 4: Manual sanity (optional but cheap)

Start only the python service, register a URL connector via the Node API (or
curl `POST /api/connectors` with a `url_csv` config), call `POST
/api/connectors/<id>/sync` twice with the remote file changed between calls, and
confirm the second sync reflects the new rows (e.g. via `/api/sources` tabular
row count). Skip if the full stack isn't up; Step 3 is the authoritative gate.

## Test plan

- `python/tests/test_main.py::test_resync_refetches_after_remote_change` — the
  regression test above.
- If plan 008 landed, also add a one-line assertion to its `test_datasets.py`
  suite that `datasets.resync` with a forced fetcher updates `meta["location"]`
  — optional; the main test covers it.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -n "force" python/app/main.py` shows the flag in `_fetch_url` and `force=True` in the resync handler
- [ ] `cd python && uv run pytest python/tests/test_main.py -v` exits 0 (with the new test passing)
- [ ] `cd server && npm run typecheck` exits 0 (server untouched, but confirm you didn't disturb it)
- [ ] No files outside the in-scope list are modified (`git status`; `python/tests/conftest.py` only if 008 hasn't landed)
- [ ] `plans/README.md` status row updated to DONE

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the "Current state" locations doesn't match the excerpts (drifted).
- The Step 3 test's `datasets.resync` raises because the registry doesn't contain
  the dataset under the expected name (e.g. `register` used a different table
  name normalization) — report the actual error.
- The test hangs (the fresh fetch hits the network instead of the local fixture):
  this would mean `force=True` isn't reaching the fetcher — check the handler
  wiring, then report if still failing.
- Removing the cache short-circuit breaks a restart scenario someone demonstrably
  relies on beyond the resync path (e.g. `register` on a URL dataset after
  python-service restart) — verify the first-time `register` path still caches
  and only `resync` forces.

## Maintenance notes

- The cache key is `(account_id, name)` and does NOT include the URL — if a
  future "edit connector URL" feature lands (the connector API has no update
  today), the edit path must call the forced fetch (or key the cache by URL hash);
  `force=True` is the hook for that.
- Keep the first-time `register` path caching: it is what makes connector data
  survive python-service restarts without re-downloading.
- When plan 008 (test baselines) lands, this file's `conftest.py` should be
  deduplicated against it.

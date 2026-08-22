"""Tabular dataset registry backed by DuckDB.

Every uploaded/connected tabular file becomes a DuckDB table owned by an account.
The account namespace prevents cross-user SQL access: registrations are keyed by
(account_id, name) and the in-memory catalog is only reachable through /query
with a matching account_id. DuckDB runs embedded in-memory; datasets are
re-registered from disk on startup.
"""

from __future__ import annotations

import json
import os
import re
import threading
from pathlib import Path
from typing import Any

import duckdb
import pandas as pd
from fastapi import HTTPException

STORAGE_DIR = Path(os.environ.get("NORTH_STORAGE_DIR", "/Users/max/Developer/github/computerbraincompany/north-clone/uploads"))
LOCK = threading.RLock()

# account_id -> { table_name: {meta} }
_REGISTRY: dict[str, dict[str, dict[str, Any]]] = {}

TABLE_RE = re.compile(r"^[a-z][a-z0-9_]{0,62}$")


def _read_sql(path: str) -> str:
    ext = Path(path).suffix.lower()
    if ext in (".xlsx", ".xls"):
        return "read_xlsx(?)"
    if ext in (".parquet",):
        return "read_parquet(?)"
    if ext in (".json", ".jsonl"):
        return "read_json_auto(?)"
    if ext in (".tsv",):
        return "read_csv_auto(?, delim='\\t')"
    return "read_csv_auto(?)"


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
        meta = {
            "name": name,
            "location": location,
            "safe_location": str(Path(location).resolve()),
            "original_name": original_name,
            "kind": kind,
            "url": url,
            "rows": int(n_rows),
            "columns": columns,
            "preview": preview,
            "size_bytes": Path(location).stat().st_size,
        }
        _REGISTRY[account_id][name] = meta
        return meta


def _columns(con: duckdb.DuckDBPyConnection, table: str) -> list[dict[str, str]]:
    rows = con.execute(f"DESCRIBE {table}").fetchall()
    return [{"name": r[0], "type": r[1]} for r in rows]


def _preview(con: duckdb.DuckDBPyConnection, table: str, n: int = 5) -> list[list[Any]]:
    rows = con.execute(f"SELECT * FROM {table} LIMIT {n}").fetchall()
    return [[None if v is None else (float(v) if isinstance(v, int) and abs(v) > 1e15 else v) for v in row] for row in rows]


def list_datasets(account_id: str) -> list[dict[str, Any]]:
    with LOCK:
        meta = _REGISTRY.get(account_id, {})
        return [
            {k: v for k, v in m.items() if k != "safe_location"}
            | {"table": m["name"], "exists": Path(m["location"]).exists()}
            for m in meta.values()
        ]


def drop(account_id: str, name: str) -> None:
    with LOCK:
        if name not in _REGISTRY.get(account_id, {}):
            raise HTTPException(404, f"dataset {name} not found")
        del _REGISTRY[account_id][name]
        con = _connection(account_id)
        con.execute(f"DROP TABLE IF EXISTS {name}")
        con.close()


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


def restore_from_manifest(account_id: str, manifest: list[dict[str, Any]]) -> None:
    with LOCK:
        _REGISTRY[account_id] = {}
        for item in manifest:
            loc = item.get("location")
            if loc and Path(loc).exists():
                try:
                    register(account_id, item["name"], loc, item.get("kind", "path"), item.get("original_name", item["name"]), item.get("url"))
                except Exception:  # noqa: BLE001
                    continue


def query(account_id: str, sql: str) -> dict[str, Any]:
    sql = sql.strip()
    # Allow only read-only statements + a pragmatic whitelist of read helpers.
    if not sql:
        raise HTTPException(400, "empty SQL")
    if not re.match(r"^(SELECT|WITH|VALUES|PRAGMA)\b", sql, re.IGNORECASE):
        raise HTTPException(400, "only SELECT/WITH queries are allowed")
    if re.search(r"(;\s*|\b)(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|ATTACH|COPY|CALL|INSTALL|LOAD)\b", sql, re.IGNORECASE):
        raise HTTPException(400, "DDL and mutation statements are not allowed")
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
        "rows": [[None if pd.isna(v) else (float(v) if isinstance(v, (int, float)) and abs(v) > 1e14 else (v.item() if hasattr(v, "item") else v)) for v in row] for row in res.itertuples(index=False, name=None)],
        "row_count": int(len(res)),
    }


def describe(account_id: str, table: str) -> dict[str, Any]:
    with LOCK:
        meta = _REGISTRY.get(account_id, {}).get(table)
        if not meta:
            raise HTTPException(404, f"dataset {table} not found")
        con = _connection(account_id)
        cols = con.execute(f"DESCRIBE {table}").fetchall()
        stats: dict[str, Any] = {"table": table, "rows": meta["rows"], "columns": []}
        for col in cols:
            cname, ctype = col[0], col[1]
            entry: dict[str, Any] = {"name": cname, "type": ctype}
            try:
                if "INT" in ctype or "DECIMAL" in ctype or "FLOAT" in ctype or "DOUBLE" in ctype or "REAL" in ctype:
                    row = con.execute(f'SELECT min("{cname}"), max("{cname}"), avg("{cname}"), count(DISTINCT "{cname}") FROM "{table}"').fetchone()
                    entry.update({"min": _f(row[0]), "max": _f(row[1]), "avg": _f(row[2]), "distinct": int(row[3])})
                elif "DATE" in ctype or "TIMESTAMP" in ctype:
                    row = con.execute(f'SELECT min("{cname}"), max("{cname}"), count(DISTINCT "{cname}") FROM "{table}"').fetchone()
                    entry.update({"min": str(row[0]), "max": str(row[1]), "distinct": int(row[2])})
                elif "VARCHAR" in ctype or "BLOB" in ctype:
                    top = con.execute(f'SELECT "{cname}", count(*) AS n FROM "{table}" GROUP BY 1 ORDER BY n DESC LIMIT 6').fetchall()
                    entry["top_values"] = [{"value": str(colval), "count": int(n)} for colval, n in top]
                    entry["distinct"] = int(con.execute(f'SELECT count(DISTINCT "{cname}") FROM "{table}"').fetchone()[0])
            except Exception:  # noqa: BLE001
                pass
            stats["columns"].append(entry)
        con.close()
        return stats


def _f(v) -> float | None:
    try:
        return float(v) if v is not None else None
    except (TypeError, ValueError):
        return None

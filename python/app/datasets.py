"""Tabular dataset registry backed by DuckDB.

Every uploaded/connected tabular file becomes a DuckDB table owned by an account.
The account namespace prevents cross-user SQL access: registrations are keyed by
(account_id, name) and the in-memory catalog is only reachable through /query
with a matching account_id. DuckDB runs embedded in-memory; datasets are
re-registered from disk on startup.
"""

from __future__ import annotations

import logging
import math
import os
import re
import threading
from collections import OrderedDict
from collections.abc import Sequence
from decimal import Decimal
from pathlib import Path
from typing import Any

import duckdb
from fastapi import HTTPException

REPO_ROOT = Path(__file__).resolve().parents[2]
STORAGE_DIR = Path(
    os.environ.get("BOREALIS_STORAGE_DIR")
    or os.environ.get("NORTH_STORAGE_DIR")
    or REPO_ROOT / "uploads"
)
LOCK = threading.RLock()

# account_id -> { table_name: {meta} }
_REGISTRY: dict[str, dict[str, dict[str, Any]]] = {}
# (account_id, sorted allowed tables) -> isolated in-memory DuckDB catalog
ScopeKey = tuple[str, tuple[str, ...]]
ScopeSignatures = tuple[tuple[str, str], ...]
_CONNECTIONS: OrderedDict[ScopeKey, duckdb.DuckDBPyConnection] = OrderedDict()
_SCOPE_SIGNATURES: dict[ScopeKey, ScopeSignatures] = {}
MAX_SCOPES_PER_ACCOUNT = 8

TABLE_RE = re.compile(r"^[a-z][a-z0-9_]{0,62}$")
EUROPEAN_DATE_RE = re.compile(r"(?<!\d)\d{2}\.\d{2}\.\d{2,4}(?!\d)")
LOGGER = logging.getLogger(__name__)


def _is_european_semicolon_csv(sample: str) -> bool:
    """Conservatively detect semicolon CSVs containing European-style dates."""
    delimited_lines = [line for line in sample.lstrip("\ufeff").splitlines() if line.count(";") >= 2]
    if len(delimited_lines) < 2:
        return False
    delimiter_counts = [line.count(";") for line in delimited_lines]
    has_consistent_rows = any(delimiter_counts.count(count) >= 2 for count in set(delimiter_counts))
    return has_consistent_rows and any(EUROPEAN_DATE_RE.search(line) for line in delimited_lines)


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
    if ext == ".csv":
        sample = Path(path).read_bytes()[:4096].decode("utf-8-sig", errors="ignore")
        if _is_european_semicolon_csv(sample):
            return (
                "read_csv_auto(?, delim=';', dateformat='%d.%m.%y', decimal_separator=',', "
                "thousands='.', auto_type_candidates=['BOOLEAN','BIGINT','DECIMAL','DATE','TIMESTAMP','VARCHAR'])"
            )
    return "read_csv_auto(?)"


def _qi(name: str) -> str:
    return '"' + str(name).replace('"', '""') + '"'


def _file_sig(path: str) -> str:
    try:
        stat = Path(path).stat()
        return f"{stat.st_size}:{stat.st_mtime_ns}"
    except OSError:
        return "missing"


def _scope_key(account_id: str, allowed_tables: Sequence[str]) -> ScopeKey:
    if isinstance(allowed_tables, (str, bytes)) or not isinstance(allowed_tables, Sequence):
        raise HTTPException(400, "allowed_tables must be a list")
    if any(not isinstance(name, str) for name in allowed_tables):
        raise HTTPException(400, "allowed_tables must contain table names")
    tables = tuple(sorted(set(allowed_tables)))
    registry = _REGISTRY.get(account_id, {})
    if any(name not in registry for name in tables):
        raise HTTPException(400, "one or more allowed tables are unavailable")
    return account_id, tables


def _scope_signatures(key: ScopeKey) -> ScopeSignatures:
    account_id, tables = key
    registry = _REGISTRY.get(account_id, {})
    return tuple((name, _file_sig(registry[name]["location"])) for name in tables)


def _close_scope(key: ScopeKey) -> None:
    con = _CONNECTIONS.pop(key, None)
    _SCOPE_SIGNATURES.pop(key, None)
    if con is not None:
        con.close()


def _invalidate_account(account_id: str) -> None:
    for key in [scope_key for scope_key in _CONNECTIONS if scope_key[0] == account_id]:
        _close_scope(key)


def _evict_account_scopes(account_id: str) -> None:
    account_keys = [key for key in _CONNECTIONS if key[0] == account_id]
    while len(account_keys) > MAX_SCOPES_PER_ACCOUNT:
        _close_scope(account_keys.pop(0))


def _build_scoped_connection(key: ScopeKey, signatures: ScopeSignatures) -> duckdb.DuckDBPyConnection:
    account_id, tables = key
    registry = _REGISTRY.get(account_id, {})
    con = duckdb.connect()
    try:
        con.execute("PRAGMA threads=4")
        for name, signature in signatures:
            if signature == "missing":
                raise HTTPException(422, f"dataset {name} could not be reloaded")
            meta = registry[name]
            con.execute(
                f"CREATE TABLE {_qi(name)} AS SELECT * FROM {_read_sql(meta['safe_location'])}",
                [meta["safe_location"]],
            )
            meta["rows"] = int(con.execute(f"SELECT count(*) FROM {_qi(name)}").fetchone()[0])
            meta["columns"] = _columns(con, name)
            meta["preview"] = _preview(con, name, 5)
            meta["size_bytes"] = Path(meta["location"]).stat().st_size
        if _scope_signatures(key) != signatures:
            raise HTTPException(422, "dataset scope changed while loading")
        con.execute("SET enable_external_access=false")
        return con
    except HTTPException:
        con.close()
        raise
    except Exception as e:  # noqa: BLE001
        con.close()
        LOGGER.warning("failed to build scoped catalog for account %s: %s", account_id, e)
        raise HTTPException(422, "dataset scope could not be loaded") from e


def _scoped_connection_for_key(key: ScopeKey) -> duckdb.DuckDBPyConnection:
    signatures = _scope_signatures(key)
    con = _CONNECTIONS.get(key)
    if con is not None and _SCOPE_SIGNATURES.get(key) == signatures:
        _CONNECTIONS.move_to_end(key)
        return con
    if con is not None:
        _close_scope(key)
    con = _build_scoped_connection(key, signatures)
    _CONNECTIONS[key] = con
    _SCOPE_SIGNATURES[key] = signatures
    _CONNECTIONS.move_to_end(key)
    _evict_account_scopes(key[0])
    return con


def _scoped_connection(account_id: str, allowed_tables: Sequence[str]) -> duckdb.DuckDBPyConnection:
    return _scoped_connection_for_key(_scope_key(account_id, allowed_tables))


def register(account_id: str, name: str, location: str, kind: str, original_name: str, url: str | None = None) -> dict[str, Any]:
    with LOCK:
        _REGISTRY.setdefault(account_id, {})
        if name == "schema_version":
            raise HTTPException(400, "reserved name")
        if not TABLE_RE.match(name):
            raise HTTPException(400, f"table name {name!r} invalid; use lowercase letters, digits and underscores")
        if not Path(location).exists():
            raise HTTPException(404, f"file not found: {location}")
        safe_location = str(Path(location).resolve())
        con = duckdb.connect()
        try:
            con.execute("PRAGMA threads=4")
            con.execute(
                f"CREATE TABLE {_qi(name)} AS SELECT * FROM {_read_sql(safe_location)}",
                [safe_location],
            )
            n_rows = con.execute(f"SELECT count(*) FROM {_qi(name)}").fetchone()[0]
            columns = _columns(con, name)
            preview = _preview(con, name, 5)
        except Exception as e:  # noqa: BLE001
            raise HTTPException(422, f"could not parse {original_name} as tabular data: {e}") from e
        finally:
            con.close()
        meta = {
            "name": name,
            "location": location,
            "safe_location": safe_location,
            "original_name": original_name,
            "kind": kind,
            "url": url,
            "rows": int(n_rows),
            "columns": columns,
            "preview": preview,
            "size_bytes": Path(location).stat().st_size,
        }
        _REGISTRY[account_id][name] = meta
        _invalidate_account(account_id)
        return meta


def _columns(con: duckdb.DuckDBPyConnection, table: str) -> list[dict[str, str]]:
    rows = con.execute(f"DESCRIBE {_qi(table)}").fetchall()
    return [{"name": r[0], "type": r[1]} for r in rows]


def _preview(con: duckdb.DuckDBPyConnection, table: str, n: int = 5) -> list[list[Any]]:
    rows = con.execute(f"SELECT * FROM {_qi(table)} LIMIT {n}").fetchall()
    return [[_json_cell(v, large_number_threshold=1e15) for v in row] for row in rows]


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
        _invalidate_account(account_id)
        del _REGISTRY[account_id][name]
        if not _REGISTRY[account_id]:
            del _REGISTRY[account_id]


def resync(account_id: str, name: str, fetcher, url: str | None = None) -> dict[str, Any]:
    """Re-fetch a URL-based dataset through a fetcher callable -> local path."""
    with LOCK:
        meta = _REGISTRY.get(account_id, {}).get(name)
        if not meta:
            raise HTTPException(404, f"dataset {name} not found")
        location = meta["location"]
        remote_url = meta.get("url") or url
        kind = meta["kind"]
        if remote_url:
            location = fetcher(remote_url)
            kind = "url"
        return register(account_id, name, location, kind, meta["original_name"], remote_url) | {
            "table": name
        }


def query(account_id: str, sql: str, allowed_tables: Sequence[str]) -> dict[str, Any]:
    sql = sql.strip()
    # Allow only read-only statements + a pragmatic whitelist of read helpers.
    if not sql:
        raise HTTPException(400, "empty SQL")
    if not re.match(r"^(SELECT|WITH|VALUES|PRAGMA)\b", sql, re.IGNORECASE):
        raise HTTPException(400, "only SELECT/WITH queries are allowed")
    if re.search(r"(;\s*|\b)(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|ATTACH|COPY|CALL|INSTALL|LOAD)\b", sql, re.IGNORECASE):
        raise HTTPException(400, "DDL and mutation statements are not allowed")
    if sql.endswith(";"):
        sql = sql[:-1].rstrip()
    with LOCK:
        try:
            con = _scoped_connection(account_id, allowed_tables)
            if re.match(r"^PRAGMA\b", sql, re.IGNORECASE):
                cursor = con.execute(sql)
            else:
                cursor = con.execute(f"SELECT * FROM ({sql}) AS _q LIMIT 500")
            rows = cursor.fetchmany(500)
            columns = [str(column[0]) for column in (cursor.description or [])]
        except HTTPException:
            raise
        except Exception as e:  # noqa: BLE001
            raise HTTPException(422, f"query failed: {e}") from e
    return {
        "columns": columns,
        "rows": [[_json_cell(value) for value in row] for row in rows],
        "row_count": len(rows),
    }


def describe(account_id: str, table: str, allowed_tables: Sequence[str]) -> dict[str, Any]:
    with LOCK:
        key = _scope_key(account_id, allowed_tables)
        if table not in key[1]:
            raise HTTPException(400, f"dataset {table} is not allowed in this scope")
        meta = _REGISTRY[account_id][table]
        con = _scoped_connection_for_key(key)
        cursor = con.execute(f"SUMMARIZE SELECT * FROM {_qi(table)}")
        summary_columns = [str(column[0]) for column in cursor.description]
        summaries = [dict(zip(summary_columns, row, strict=True)) for row in cursor.fetchall()]
        stats: dict[str, Any] = {"table": table, "rows": meta["rows"], "columns": []}
        for summary in summaries:
            cname = str(summary["column_name"])
            ctype = str(summary["column_type"])
            entry: dict[str, Any] = {"name": cname, "type": ctype}
            try:
                if "INT" in ctype or "DECIMAL" in ctype or "FLOAT" in ctype or "DOUBLE" in ctype or "REAL" in ctype:
                    entry.update(
                        {
                            "min": _f(summary["min"]),
                            "max": _f(summary["max"]),
                            "avg": _f(summary["avg"]),
                            "distinct": int(summary["approx_unique"] or 0),
                        }
                    )
                elif "DATE" in ctype or "TIMESTAMP" in ctype:
                    entry.update(
                        {
                            "min": str(summary["min"]) if summary["min"] is not None else None,
                            "max": str(summary["max"]) if summary["max"] is not None else None,
                            "distinct": int(summary["approx_unique"] or 0),
                        }
                    )
                elif "VARCHAR" in ctype or "BLOB" in ctype:
                    top = con.execute(
                        f"SELECT {_qi(cname)}, count(*) AS n FROM {_qi(table)} GROUP BY 1 ORDER BY n DESC LIMIT 6"
                    ).fetchall()
                    entry["top_values"] = [{"value": str(colval), "count": int(n)} for colval, n in top]
                    entry["distinct"] = int(summary["approx_unique"] or 0)
            except Exception:  # noqa: BLE001
                pass
            stats["columns"].append(entry)
        return stats


def _json_cell(value: Any, large_number_threshold: float = 1e14) -> Any:
    if value is None:
        return None
    if hasattr(value, "item"):
        value = value.item()
    if isinstance(value, Decimal):
        value = float(value)
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, (int, float)) and abs(value) > large_number_threshold:
        return float(value)
    return value


def _f(v) -> float | None:
    try:
        value = float(v) if v is not None else None
        return value if value is None or math.isfinite(value) else None
    except (TypeError, ValueError):
        return None

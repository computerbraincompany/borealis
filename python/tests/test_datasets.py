"""Characterization tests for the DuckDB dataset registry and SQL validator.

These pin the current behaviour of the read-only SQL guard and the
result-normalization in ``datasets.query``. Use a distinct account_id per test —
the module-level ``_REGISTRY`` persists across tests in-process.
"""

from __future__ import annotations

import uuid

import pytest
from fastapi import HTTPException

from app import datasets


def _acct() -> str:
    return f"acct-{uuid.uuid4().hex[:12]}"


def _register_csv(tmp_path, account: str, name: str, csv_text: str):
    p = tmp_path / f"{name}.csv"
    p.write_text(csv_text)
    return datasets.register(account, name, str(p), "path", f"{name}.csv", None)


# ---------------------------------------------------------------------------
# SQL validator contract
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    "sql",
    [
        "INSERT INTO x VALUES (1)",
        "UPDATE t SET a=1",
        "DELETE FROM t",
        "DROP TABLE t",
        "ALTER TABLE t ADD COLUMN a int",
        "CREATE TABLE t (a int)",
        "ATTACH 'x'",
        "COPY t TO 'a'",
        "CALL some_fn()",
        "INSTALL foo",
        "LOAD foo",
        "SELECT 1; DROP TABLE t",
        "",
    ],
)
def test_query_rejects_mutations_and_ddl(sql: str):
    with pytest.raises(HTTPException) as exc:
        datasets.query(_acct(), sql)
    assert exc.value.status_code == 400


def test_query_accepts_read_statements():
    r = datasets.query(_acct(), "SELECT 1 AS n")
    assert r["columns"] == ["n"]
    assert r["rows"] == [[1]]
    assert r["row_count"] == 1


def test_query_accepts_leading_whitespace():
    r = datasets.query(_acct(), "  SELECT 2 AS n")
    assert r["rows"] == [[2]]


# ---------------------------------------------------------------------------
# Result normalization
# ---------------------------------------------------------------------------
def test_query_normalizes_large_int_cells_to_float(tmp_path):
    # int64 values above the 1e14 threshold are coerced to float (lossy) — pinned.
    account = _acct()
    _register_csv(tmp_path, account, "big", "id\n1234567890123456789\n")
    r = datasets.query(account, "SELECT id FROM big")
    cell = r["rows"][0][0]
    assert isinstance(cell, float)
    assert int(round(cell, 0)) != 1234567890123456789  # precision loss documented


def test_query_caps_results_at_500_rows(tmp_path):
    account = _acct()
    _register_csv(tmp_path, account, "many", "x\n" + "".join(f"{i}\n" for i in range(600)))
    r = datasets.query(account, "SELECT * FROM many")
    assert r["row_count"] == 500
    assert len(r["rows"]) == 500


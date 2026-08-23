"""Characterization tests for the DuckDB dataset registry and SQL validator.

These pin the current behaviour of the read-only SQL guard and the
result-normalization in ``datasets.query``. Use a distinct account_id per test —
the module-level ``_REGISTRY`` persists across tests in-process.
"""

from __future__ import annotations

import uuid
from concurrent.futures import ThreadPoolExecutor

import duckdb
import pytest
from fastapi import HTTPException

from app import datasets


def _acct() -> str:
    return f"acct-{uuid.uuid4().hex[:12]}"


def _register_csv(tmp_path, account: str, name: str, csv_text: str):
    p = tmp_path / f"{account}_{name}.csv"
    p.write_text(csv_text)
    return datasets.register(account, name, str(p), "path", f"{name}.csv", None)


def _cached_connection(account: str, tables: list[str]) -> duckdb.DuckDBPyConnection:
    key = (account, tuple(sorted(set(tables))))
    with datasets.LOCK:
        return datasets._CONNECTIONS[key]


def _assert_closed(con: duckdb.DuckDBPyConnection) -> None:
    with datasets.LOCK:
        with pytest.raises(duckdb.ConnectionException, match="already closed"):
            con.execute("SELECT 1")


def test_european_csv_detector_is_conservative():
    assert datasets._is_european_semicolon_csv("Date;Amount;Text\n18.08.26;-1.234,56;Rent\n")
    assert not datasets._is_european_semicolon_csv("date,amount\n2026-08-18,12.50\n")
    assert not datasets._is_european_semicolon_csv("note;18.08.26\n")


def test_existing_sample_csvs_keep_default_reader():
    for sample in sorted((datasets.REPO_ROOT / "data" / "sample").glob("*.csv")):
        assert datasets._read_sql(str(sample)) == "read_csv_auto(?)"


def test_registers_sparkasse_csv_with_dates_and_decimal_amounts(tmp_path):
    account = _acct()
    csv_text = (
        "\ufeffKontoinhaber:;Example User\n"
        "Erstellt am:;22.08.2026\n"
        "\n"
        "Buchungsdatum;Wertstellung;Status;Betrag (€)\n"
        '18.08.26;18.08.26;Gebucht;"-1.234,56"\n'
        '19.08.26;19.08.26;Gebucht;"42,10"\n'
    )

    meta = _register_csv(tmp_path, account, "sparkasse", csv_text)
    columns = {column["name"]: column["type"] for column in meta["columns"]}
    assert columns["Buchungsdatum"] == "DATE"
    assert columns["Betrag (€)"].startswith("DECIMAL")

    result = datasets.query(
        account,
        'SELECT min("Buchungsdatum")::VARCHAR AS first_date, sum("Betrag (€)") AS amount FROM sparkasse',
        ["sparkasse"],
    )
    assert result["rows"][0][0] == "2026-08-18"
    assert result["rows"][0][1] == pytest.approx(-1192.46)


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
        datasets.query(_acct(), sql, [])
    assert exc.value.status_code == 400


def test_query_accepts_read_statements():
    account = _acct()
    r = datasets.query(account, "SELECT 1 AS n", [])
    assert r["columns"] == ["n"]
    assert r["rows"] == [[1]]
    assert r["row_count"] == 1
    with datasets.LOCK:
        assert (account, ()) in datasets._CONNECTIONS


def test_query_accepts_leading_whitespace():
    r = datasets.query(_acct(), "  SELECT 2 AS n", [])
    assert r["rows"] == [[2]]


# ---------------------------------------------------------------------------
# Result normalization
# ---------------------------------------------------------------------------
def test_query_normalizes_large_int_cells_to_float(tmp_path):
    # int64 values above the 1e14 threshold are coerced to float (lossy) — pinned.
    account = _acct()
    _register_csv(tmp_path, account, "big", "id\n1234567890123456789\n")
    r = datasets.query(account, "SELECT id FROM big", ["big"])
    cell = r["rows"][0][0]
    assert isinstance(cell, float)
    assert int(round(cell, 0)) != 1234567890123456789  # precision loss documented


def test_query_caps_results_at_500_rows(tmp_path):
    account = _acct()
    _register_csv(tmp_path, account, "many", "x\n" + "".join(f"{i}\n" for i in range(1000)))
    r = datasets.query(account, "SELECT * FROM many", ["many"])
    assert r["row_count"] == 500
    assert len(r["rows"]) == 500


def test_query_bounds_pragma_results():
    result = datasets.query(_acct(), "PRAGMA functions", [])

    assert result["row_count"] == 500
    assert len(result["rows"]) == 500


def test_query_normalizes_infinity_to_none():
    result = datasets.query(_acct(), "SELECT 1.0 / 0.0 AS x", [])

    assert result["rows"] == [[None]]


# ---------------------------------------------------------------------------
# Persistent connection lifecycle and account isolation
# ---------------------------------------------------------------------------
def test_repeated_queries_reload_only_when_file_changes(tmp_path, monkeypatch):
    account = _acct()
    original_read_sql = datasets._read_sql
    calls: list[str] = []

    def _tracked_read_sql(path: str) -> str:
        calls.append(path)
        return original_read_sql(path)

    monkeypatch.setattr(datasets, "_read_sql", _tracked_read_sql)
    _register_csv(tmp_path, account, "memo", "value\n1\n")

    assert datasets.query(account, "SELECT value FROM memo", ["memo"])["rows"] == [[1]]
    calls_after_first_query = len(calls)
    assert calls_after_first_query == 2
    first_connection = _cached_connection(account, ["memo"])
    assert datasets.query(account, "SELECT value FROM memo", ["memo"])["rows"] == [[1]]
    assert len(calls) == calls_after_first_query

    path = tmp_path / f"{account}_memo.csv"
    path.write_text("value\n200\n300\n")
    assert datasets.query(account, "SELECT value FROM memo ORDER BY value", ["memo"])["rows"] == [[200], [300]]
    assert len(calls) == calls_after_first_query + 1
    assert _cached_connection(account, ["memo"]) is not first_connection
    _assert_closed(first_connection)


def test_missing_file_fails_closed_for_query_and_describe(tmp_path):
    account = _acct()
    _register_csv(tmp_path, account, "missing", "value\n1\n")
    assert datasets.query(account, "SELECT * FROM missing", ["missing"])["rows"] == [[1]]

    (tmp_path / f"{account}_missing.csv").unlink()

    with pytest.raises(HTTPException) as query_error:
        datasets.query(account, "SELECT * FROM missing", ["missing"])
    assert query_error.value.status_code == 422

    with pytest.raises(HTTPException) as describe_error:
        datasets.describe(account, "missing", ["missing"])
    assert describe_error.value.status_code == 422

    path = tmp_path / f"{account}_missing.csv"
    path.write_text("value\n9\n10\n")
    assert datasets.query(account, "SELECT * FROM missing ORDER BY value", ["missing"])["rows"] == [[9], [10]]
    assert datasets.describe(account, "missing", ["missing"])["rows"] == 2


def test_account_catalogs_are_isolated(tmp_path):
    account_a = _acct()
    account_b = _acct()
    _register_csv(tmp_path, account_a, "shared", "canary\nalpha\n")
    _register_csv(tmp_path, account_b, "shared", "canary\nbeta\n")
    _register_csv(tmp_path, account_a, "only_a", "secret\naccount-a-only\n")

    for _ in range(2):
        assert datasets.query(account_a, "SELECT canary FROM shared", ["shared"])["rows"] == [["alpha"]]
        assert datasets.query(account_b, "SELECT canary FROM shared", ["shared"])["rows"] == [["beta"]]

    with pytest.raises(HTTPException) as error:
        datasets.query(account_b, "SELECT * FROM only_a", ["shared"])
    assert error.value.status_code == 422


def test_concurrent_queries_keep_account_catalogs_isolated(tmp_path):
    account_a = _acct()
    account_b = _acct()
    _register_csv(tmp_path, account_a, "shared", "canary\nalpha\n")
    _register_csv(tmp_path, account_b, "shared", "canary\nbeta\n")

    def _canary(account: str) -> str:
        return datasets.query(account, "SELECT canary FROM shared", ["shared"])["rows"][0][0]

    accounts = [account_a, account_b] * 10
    with ThreadPoolExecutor(max_workers=4) as executor:
        results = list(executor.map(_canary, accounts))

    assert results == ["alpha", "beta"] * 10


def test_describe_quotes_column_identifiers(tmp_path):
    account = _acct()
    _register_csv(tmp_path, account, "quoted", '"we""ird"\n1\n2\n')

    result = datasets.describe(account, "quoted", ["quoted"])

    assert result["columns"][0]["name"] == 'we"ird'
    assert result["columns"][0]["min"] == 1.0
    assert result["columns"][0]["max"] == 2.0


# ---------------------------------------------------------------------------
# Scoped catalog enforcement and bounded cache
# ---------------------------------------------------------------------------
def test_scoped_catalog_exposes_only_allowed_tables(tmp_path):
    account = _acct()
    _register_csv(tmp_path, account, "alpha", "canary\na\n")
    _register_csv(tmp_path, account, "beta", "canary\nb\n")

    assert datasets.query(account, "SELECT canary FROM alpha", ["alpha", "alpha"])["rows"] == [["a"]]
    with pytest.raises(HTTPException) as unselected_error:
        datasets.query(account, "SELECT canary FROM beta", ["alpha"])
    assert unselected_error.value.status_code == 422

    with pytest.raises(HTTPException) as empty_error:
        datasets.query(account, "SELECT canary FROM alpha", [])
    assert empty_error.value.status_code == 422

    visible = datasets.query(
        account,
        "SELECT table_name FROM duckdb_tables() WHERE NOT internal ORDER BY table_name",
        ["beta", "alpha", "alpha"],
    )
    assert visible["rows"] == [["alpha"], ["beta"]]


def test_scope_rejects_unregistered_allowed_table(tmp_path):
    account = _acct()
    _register_csv(tmp_path, account, "alpha", "x\n1\n")

    with pytest.raises(HTTPException) as error:
        datasets.query(account, "SELECT 1", ["missing"])

    assert error.value.status_code == 400
    assert error.value.detail == "one or more allowed tables are unavailable"


def test_describe_rejects_table_outside_allowlist(tmp_path):
    account = _acct()
    _register_csv(tmp_path, account, "alpha", "x\n1\n")
    _register_csv(tmp_path, account, "beta", "x\n2\n")

    with pytest.raises(HTTPException) as error:
        datasets.describe(account, "beta", ["alpha"])

    assert error.value.status_code == 400


@pytest.mark.parametrize(
    ("reader", "filename", "content"),
    [
        ("read_csv_auto", "outside.csv", "x\n1\n"),
        ("read_json_auto", "outside.json", '[{"x":1}]'),
        ("read_parquet", "outside.parquet", "not-a-parquet-file"),
    ],
)
def test_scoped_catalog_disables_external_table_functions(tmp_path, reader: str, filename: str, content: str):
    account = _acct()
    outside = tmp_path / filename
    outside.write_text(content)
    escaped_path = str(outside).replace("'", "''")

    setting = datasets.query(account, "SELECT current_setting('enable_external_access') AS enabled", [])
    assert setting["rows"] == [[False]]

    with pytest.raises(HTTPException) as error:
        datasets.query(account, f"SELECT * FROM {reader}('{escaped_path}')", [])
    assert error.value.status_code == 422
    assert "permission error" in error.value.detail.lower()
    assert "cannot access file" in error.value.detail.lower()


def test_scoped_catalog_cannot_reenable_external_access():
    account = _acct()
    assert datasets.query(account, "SELECT 1", [])["rows"] == [[1]]

    with pytest.raises(HTTPException) as error:
        datasets.query(account, "PRAGMA enable_external_access=true", [])
    assert error.value.status_code == 422
    assert "cannot enable external access" in error.value.detail.lower()
    setting = datasets.query(account, "SELECT current_setting('enable_external_access') AS enabled", [])
    assert setting["rows"] == [[False]]


def test_register_invalidates_every_cached_account_scope(tmp_path):
    account = _acct()
    _register_csv(tmp_path, account, "alpha", "x\n1\n")
    _register_csv(tmp_path, account, "beta", "x\n2\n")
    datasets.query(account, "SELECT * FROM alpha", ["alpha"])
    datasets.query(account, "SELECT * FROM beta", ["beta"])
    alpha_connection = _cached_connection(account, ["alpha"])
    beta_connection = _cached_connection(account, ["beta"])

    _register_csv(tmp_path, account, "gamma", "x\n3\n")

    with datasets.LOCK:
        assert not any(key[0] == account for key in datasets._CONNECTIONS)
    _assert_closed(alpha_connection)
    _assert_closed(beta_connection)


def test_resync_invalidates_cached_account_scopes(tmp_path):
    account = _acct()
    initial = tmp_path / f"{account}_remote_initial.csv"
    initial.write_text("x\n1\n")
    datasets.register(account, "remote", str(initial), "url", "remote.csv", "https://example.test/data")
    assert datasets.query(account, "SELECT x FROM remote", ["remote"])["rows"] == [[1]]
    old_connection = _cached_connection(account, ["remote"])

    refreshed = tmp_path / f"{account}_remote_refreshed.csv"
    refreshed.write_text("x\n2\n3\n")
    datasets.resync(account, "remote", fetcher=lambda _url: str(refreshed))

    _assert_closed(old_connection)
    assert datasets.query(account, "SELECT x FROM remote ORDER BY x", ["remote"])["rows"] == [[2], [3]]


def test_resync_upgrades_legacy_path_metadata_when_connector_url_is_supplied(tmp_path):
    account = _acct()
    initial = tmp_path / f"{account}_legacy.csv"
    initial.write_text("x\n1\n")
    datasets.register(account, "remote", str(initial), "path", "Remote feed", None)

    refreshed = tmp_path / f"{account}_refreshed.json"
    refreshed.write_text('[{"x": 2}]')
    remote_url = "https://example.test/data.json"
    result = datasets.resync(
        account,
        "remote",
        fetcher=lambda url: str(refreshed) if url == remote_url else "",
        url=remote_url,
    )

    assert result["kind"] == "url"
    assert result["url"] == remote_url
    assert result["location"] == str(refreshed)
    assert datasets.query(account, "SELECT x FROM remote", ["remote"])["rows"] == [[2]]


def test_drop_invalidates_every_cached_account_scope(tmp_path):
    account = _acct()
    _register_csv(tmp_path, account, "alpha", "x\n1\n")
    _register_csv(tmp_path, account, "beta", "x\n2\n")
    datasets.query(account, "SELECT * FROM alpha", ["alpha"])
    datasets.query(account, "SELECT * FROM beta", ["beta"])
    alpha_connection = _cached_connection(account, ["alpha"])
    beta_connection = _cached_connection(account, ["beta"])

    datasets.drop(account, "alpha")

    _assert_closed(alpha_connection)
    _assert_closed(beta_connection)
    assert datasets.query(account, "SELECT * FROM beta", ["beta"])["rows"] == [[2]]


def test_scope_lru_evicts_only_within_account(tmp_path):
    account = _acct()
    other_account = _acct()
    for index in range(4):
        _register_csv(tmp_path, account, f"table_{index}", f"x\n{index}\n")
    _register_csv(tmp_path, other_account, "table_0", "x\n99\n")
    datasets.query(other_account, "SELECT * FROM table_0", ["table_0"])
    other_connection = _cached_connection(other_account, ["table_0"])

    scopes = [
        ["table_0"],
        ["table_1"],
        ["table_2"],
        ["table_3"],
        ["table_0", "table_1"],
        ["table_0", "table_2"],
        ["table_0", "table_3"],
        ["table_1", "table_2"],
        ["table_1", "table_3"],
    ]
    first_connection = None
    second_connection = None
    for index, scope in enumerate(scopes[: datasets.MAX_SCOPES_PER_ACCOUNT]):
        datasets.query(account, "SELECT 1", scope)
        if index == 0:
            first_connection = _cached_connection(account, scope)
        elif index == 1:
            second_connection = _cached_connection(account, scope)

    datasets.query(account, "SELECT 1", scopes[0])
    datasets.query(account, "SELECT 1", scopes[-1])

    with datasets.LOCK:
        account_keys = [key for key in datasets._CONNECTIONS if key[0] == account]
        assert len(account_keys) == datasets.MAX_SCOPES_PER_ACCOUNT
        assert (account, ("table_0",)) in datasets._CONNECTIONS
        assert (account, ("table_1",)) not in datasets._CONNECTIONS
        assert (other_account, ("table_0",)) in datasets._CONNECTIONS
    assert first_connection is not None
    assert second_connection is not None
    with datasets.LOCK:
        assert first_connection.execute("SELECT x FROM table_0").fetchall() == [(0,)]
    _assert_closed(second_connection)
    with datasets.LOCK:
        assert other_connection.execute("SELECT x FROM table_0").fetchall() == [(99,)]


# ---------------------------------------------------------------------------
# Register / drop lifecycle (write paths use one-shot validation catalogs)
# ---------------------------------------------------------------------------
def test_register_and_drop_lifecycle(tmp_path):
    account = _acct()
    a = tmp_path / "a.csv"
    a.write_text("x\n1\n2\n")
    b = tmp_path / "b.csv"
    b.write_text("y\n3\n")
    datasets.register(account, "a", str(a), "path", "a.csv", None)
    datasets.register(account, "b", str(b), "path", "b.csv", None)

    assert datasets.query(account, "SELECT count(*) AS n FROM a", ["a"])["rows"][0][0] == 2

    datasets.drop(account, "a")
    with pytest.raises(HTTPException):
        datasets.query(account, "SELECT * FROM a", [])

    assert datasets.query(account, "SELECT count(*) AS n FROM b", ["b"])["rows"][0][0] == 1
    datasets.drop(account, "b")
    with datasets.LOCK:
        assert not any(key[0] == account for key in datasets._CONNECTIONS)


def test_register_drop_do_not_use_scoped_query_catalog(tmp_path, monkeypatch):
    def _boom(account_id, allowed_tables):
        raise AssertionError("_scoped_connection must not be called on write paths")

    monkeypatch.setattr(datasets, "_scoped_connection", _boom)
    account = _acct()
    a = tmp_path / "a.csv"
    a.write_text("x\n1\n")
    datasets.register(account, "a", str(a), "path", "a.csv", None)
    datasets.drop(account, "a")

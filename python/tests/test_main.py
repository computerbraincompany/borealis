"""Regression test: connector resync must refetch, not reuse the cached file.

The cache in ``_fetch_url`` (keyed by account+name) is meant to avoid
re-downloads across restarts, but the old ``/datasets/resync`` path also hit it,
so "Sync now" silently returned stale data. Resync now passes ``force=True``.
"""

from __future__ import annotations

import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest
from fastapi.testclient import TestClient

from app import datasets, main


class _Handler(BaseHTTPRequestHandler):
    body = b"a,b\n1,2\n"
    content_type = "text/csv"
    status = 200
    get_count = 0

    def do_GET(self):  # noqa: N802
        type(self).get_count += 1
        self.send_response(type(self).status)
        self.send_header("Content-Type", type(self).content_type)
        self.send_header("Content-Length", str(len(self.body)))
        self.end_headers()
        self.wfile.write(self.body)

    def log_message(self, *args):  # silence default logging
        pass


@pytest.fixture()
def csv_server():
    _Handler.body = b"a,b\n1,2\n"
    _Handler.content_type = "text/csv"
    _Handler.status = 200
    _Handler.get_count = 0
    srv = HTTPServer(("127.0.0.1", 0), _Handler)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    yield srv
    srv.shutdown()
    srv.server_close()


def test_chart_rejects_invalid_spec_with_400():
    response = TestClient(main.app).post(
        "/chart",
        json={"account_id": "acct-chart-test", "spec": {"type": "nope"}},
    )

    assert response.status_code == 400
    assert "unsupported chart type" in response.json()["detail"]


@pytest.mark.parametrize(
    ("path", "body"),
    [
        ("/query", {"account_id": "acct-api", "sql": "SELECT 1"}),
        ("/describe", {"account_id": "acct-api", "table": "missing"}),
    ],
)
def test_data_routes_require_allowed_tables(path: str, body: dict[str, str]):
    response = TestClient(main.app).post(path, json=body)

    assert response.status_code == 422
    assert any(error["loc"][-1] == "allowed_tables" for error in response.json()["detail"])


@pytest.mark.parametrize(
    ("url", "content_type", "expected"),
    [
        ("https://x/y/data.json", "application/octet-stream", ".json"),
        ("https://x/y/data", "application/json", ".json"),
        ("https://x/y/data", "application/octet-stream", ".csv"),
    ],
)
def test_cache_ext(url: str, content_type: str, expected: str):
    assert main._cache_ext(url, content_type) == expected


def test_extensionless_json_cache_is_reused(csv_server, tmp_path, monkeypatch):
    _Handler.body = b'[{"value":1}]'
    _Handler.content_type = "application/json; charset=utf-8"
    url = f"http://127.0.0.1:{csv_server.server_port}/data"
    monkeypatch.setattr(main, "STORAGE_DIR", tmp_path)

    first = main._fetch_url(url, "acct-json-cache", "events")
    second = main._fetch_url(url, "acct-json-cache", "events")

    assert first == second
    assert first.suffix == ".json"
    assert first.read_bytes() == _Handler.body
    assert _Handler.get_count == 1


def test_url_registration_can_reuse_a_fetched_path_without_losing_provenance(tmp_path, monkeypatch):
    account = "acct-cached-url-registration"
    local_path = tmp_path / "ledger.csv"
    local_path.write_text("amount\n42\n")

    def unexpected_fetch(*_args, **_kwargs):
        raise AssertionError("an existing connector cache must not be downloaded again")

    monkeypatch.setattr(main, "_fetch_url", unexpected_fetch)
    response = TestClient(main.app).post(
        "/datasets/register",
        json={
            "account_id": account,
            "name": "ledger",
            "location": str(local_path),
            "kind": "url",
            "url": "https://example.invalid/private.csv?signature=secret",
            "original_name": "Finance ledger",
        },
    )

    try:
        assert response.status_code == 200
        result = response.json()
        assert result["kind"] == "url"
        assert result["url"] == "https://example.invalid/private.csv?signature=secret"
        assert result["original_name"] == "Finance ledger"
        assert result["location"] == str(local_path)
    finally:
        if "ledger" in datasets._REGISTRY.get(account, {}):
            datasets.drop(account, "ledger")


def test_resync_bootstraps_a_missing_registry_with_a_forced_fetch(tmp_path, monkeypatch):
    account = "acct-resync-recovery"
    refreshed = tmp_path / "events.json"
    refreshed.write_text('[{"value": 7}]')
    calls: list[tuple[str, str, str, bool]] = []

    def forced_fetch(url: str, account_id: str, name: str, force: bool = False):
        calls.append((url, account_id, name, force))
        return refreshed

    monkeypatch.setattr(main, "_fetch_url", forced_fetch)
    response = TestClient(main.app).post(
        "/datasets/resync",
        json={
            "account_id": account,
            "name": "events",
            "kind": "url",
            "url": "https://example.invalid/events.json",
            "original_name": "Events feed",
        },
    )

    try:
        assert response.status_code == 200
        assert calls == [("https://example.invalid/events.json", account, "events", True)]
        assert response.json()["kind"] == "url"
        assert response.json()["original_name"] == "Events feed"
    finally:
        if "events" in datasets._REGISTRY.get(account, {}):
            datasets.drop(account, "events")


def test_force_refresh_replaces_suffix_and_preserves_cache_on_failure(csv_server, tmp_path, monkeypatch):
    account = "acct-refresh-cache"
    name = "events"
    url = f"http://127.0.0.1:{csv_server.server_port}/data"
    monkeypatch.setattr(main, "STORAGE_DIR", tmp_path)

    _Handler.body = b'[{"value":1}]'
    _Handler.content_type = "application/json"
    json_path = main._fetch_url(url, account, name)
    assert json_path.suffix == ".json"
    stale_tsv = tmp_path / f"url_{account}_{name}.tsv"
    stale_parquet = tmp_path / f"url_{account}_{name}.parquet"
    stale_tsv.write_bytes(b"stale")
    stale_parquet.write_bytes(b"stale")

    _Handler.body = b"value\n2\n"
    _Handler.content_type = "text/csv"
    csv_path = main._fetch_url(url, account, name, force=True)
    assert csv_path.suffix == ".csv"
    assert csv_path.read_bytes() == b"value\n2\n"
    assert not json_path.exists()
    assert not stale_tsv.exists()
    assert not stale_parquet.exists()

    _Handler.status = 500
    _Handler.body = b"failed"
    with pytest.raises(main.httpx.HTTPStatusError):
        main._fetch_url(url, account, name, force=True)
    assert csv_path.read_bytes() == b"value\n2\n"
    assert not json_path.exists()


def test_resync_refetches_after_remote_change(csv_server, tmp_path, monkeypatch):
    _Handler.body = b"a,b\n1,2\n"
    account = "acct-sync-test"
    name = "tickers"
    url = f"http://127.0.0.1:{csv_server.server_port}/d.csv"
    # keep the fetcher's cache inside the test tmp dir so nothing leaks to uploads/
    monkeypatch.setattr(main, "STORAGE_DIR", tmp_path)

    path = main._fetch_url(url, account, name)
    datasets.register(account, name, str(path), "url", "tickers.csv", url)
    first = datasets.query(account, "SELECT count(*) AS n FROM tickers", ["tickers"])["rows"][0][0]
    assert first == 1

    # remote data changes
    _Handler.body = b"a,b\n1,2\n3,4\n"

    # a plain (non-forced) fetch with an existing cache must NOT refetch
    cached = main._fetch_url(url, account, name)
    assert cached.read_bytes() == b"a,b\n1,2\n"

    # the resync path (force=True) must bring in the new rows
    datasets.resync(account, name, fetcher=lambda u: str(main._fetch_url(u, account, name, force=True)))
    second = datasets.query(account, "SELECT count(*) AS n FROM tickers", ["tickers"])["rows"][0][0]
    assert second == 2

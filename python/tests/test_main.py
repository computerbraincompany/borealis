"""Regression test: connector resync must refetch, not reuse the cached file.

The cache in ``_fetch_url`` (keyed by account+name) is meant to avoid
re-downloads across restarts, but the old ``/datasets/resync`` path also hit it,
so "Sync now" silently returned stale data. Resync now passes ``force=True``.
"""

from __future__ import annotations

import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from app import datasets, main


class _Handler(BaseHTTPRequestHandler):
    body = b"a,b\n1,2\n"

    def do_GET(self):  # noqa: N802
        self.send_response(200)
        self.send_header("Content-Type", "text/csv")
        self.send_header("Content-Length", str(len(self.body)))
        self.end_headers()
        self.wfile.write(self.body)

    def log_message(self, *args):  # silence default logging
        pass


@pytest.fixture()
def csv_server():
    srv = HTTPServer(("127.0.0.1", 0), _Handler)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    yield srv
    srv.shutdown()


def test_resync_refetches_after_remote_change(csv_server, tmp_path, monkeypatch):
    _Handler.body = b"a,b\n1,2\n"
    account = "acct-sync-test"
    name = "tickers"
    url = f"http://127.0.0.1:{csv_server.server_port}/d.csv"
    # keep the fetcher's cache inside the test tmp dir so nothing leaks to uploads/
    monkeypatch.setattr(main, "STORAGE_DIR", tmp_path)

    path = main._fetch_url(url, account, name)
    datasets.register(account, name, str(path), "url", "tickers.csv", url)
    first = datasets.query(account, "SELECT count(*) AS n FROM tickers")["rows"][0][0]
    assert first == 1

    # remote data changes
    _Handler.body = b"a,b\n1,2\n3,4\n"

    # a plain (non-forced) fetch with an existing cache must NOT refetch
    cached = main._fetch_url(url, account, name)
    assert cached.read_bytes() == b"a,b\n1,2\n"

    # the resync path (force=True) must bring in the new rows
    datasets.resync(account, name, fetcher=lambda u: str(main._fetch_url(u, account, name, force=True)))
    second = datasets.query(account, "SELECT count(*) AS n FROM tickers")["rows"][0][0]
    assert second == 2
